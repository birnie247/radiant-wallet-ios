/**
 * Wallet engine: HD discovery, balance aggregation and ref-safe payments.
 *
 * Design notes that matter for correctness:
 *
 * 1. RADIANT REFS. A UTXO that carries a Glyph FT/NFT has an
 *    OP_PUSHINPUTREF-family opcode inside its output script. Spending such a
 *    UTXO as ordinary fee funding BURNS the token. Every funding path here goes
 *    through the SDK's `selectRxdFunding`, which screens candidates by both
 *    indexer-reported refs and a local opcode scan.
 *
 * 2. SIGNING ORDER. `buildTx` picks the signing key by INPUT INDEX
 *    (`privKeys[index]`), not by matching the address. The wif array therefore
 *    must stay exactly parallel to the inputs array. We build both together in
 *    one pass so they can never drift.
 *
 * 3. CHANGE. `buildTx` sends change to a single address. We point it at the
 *    first unused address of the BIP44 change chain, which the scanner already
 *    watches, so change is never stranded.
 */
import {
  ElectrumClient,
  HDWallet,
  buildTx,
  p2pkhScript,
  selectRxdFunding,
  type DerivedKey,
  type NetworkName,
  type Utxo,
} from "@radiant-core/sdk";
import { candidateServers, findServer, independentServers } from "./servers";

export const GAP_LIMIT = 20;
export const HARD_ADDRESS_CAP = 200;
export const MIN_FEE_RATE = 10_000n;
export const FAST_FEE_RATE = 50_000n;

export interface ScannedAddress {
  key: DerivedKey;
  used: boolean;
  change: number;
}

export interface OwnedUtxo extends Utxo {
  ownerAddress: string;
  ownerWif: string;
  ownerIndex: number;
  ownerChange: number;
}

export interface ScanResult {
  addresses: ScannedAddress[];
  utxos: OwnedUtxo[];
  confirmed: bigint;
  unconfirmed: bigint;
  total: bigint;
  /** UTXOs deliberately excluded from funding because they carry a token ref. */
  tokenUtxoCount: number;
  nextReceive: DerivedKey;
  nextChange: DerivedKey;
}

export interface PaymentPlan {
  hex: string;
  txid: string;
  fee: bigint;
  inputsUsed: number;
  inputValue: bigint;
  change: bigint;
}

/** Run `fn` over `items` with bounded concurrency. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export interface Connection {
  client: ElectrumClient;
  endpoint: string;
  /** True when this endpoint is one of the curated, handshake-verified nodes. */
  verified: boolean;
  /** Administrator grouping, used for independent cross-checks. */
  operator: string;
}

/**
 * Connect to the first ElectrumX server that completes a handshake.
 * Servers are WebSocket endpoints; a dead host is skipped rather than fatal.
 */
export async function connect(
  network: NetworkName,
  preferred?: string,
  onAttempt?: (url: string) => void,
): Promise<Connection> {
  const candidates = candidateServers(network, preferred);
  if (candidates.length === 0) {
    throw new Error(`No servers configured for ${network}`);
  }

  const errors: string[] = [];
  for (const url of candidates) {
    onAttempt?.(url);
    const client = new ElectrumClient({ endpoint: url, reconnect: true });
    try {
      await withTimeout(client.connect(), 12_000, `connect ${url}`);
      await withTimeout(
        client.serverVersion("rxd-android-wallet", "1.4"),
        8_000,
        `handshake ${url}`,
      );
      const entry = findServer(network, url);
      return {
        client,
        endpoint: url,
        verified: entry?.verified ?? false,
        operator: entry?.operator ?? "unknown",
      };
    } catch (err) {
      try {
        client.close();
      } catch {
        /* ignore */
      }
      errors.push(`${url}: ${(err as Error).message}`);
    }
  }
  throw new Error(`Could not reach a Radiant server.\n${errors.join("\n")}`);
}

export interface TipCheck {
  endpoint: string;
  operator: string;
  height: number;
}

/** How far apart two servers' tips may be before we call it a disagreement. */
export const MAX_TIP_DRIFT = 2;

/**
 * Ask a *different operator's* server for its chain tip.
 *
 * Security report MEDIUM-2: the app otherwise trusts a single Electrum server
 * for balances, history and confirmation counts. A lying or badly stale server
 * can therefore fake confirmations. This does not deliver SPV (no merkle/PoW
 * verification) but it does detect gross disagreement between independent
 * operators, which is the cheap 80% of the value.
 *
 * Returns null when no independent server is reachable.
 */
export async function crossCheckTip(
  network: NetworkName,
  primaryEndpoint: string,
  timeoutMs = 5_000,
): Promise<TipCheck | null> {
  // Bounded: at most two peers, each with a short timeout. This runs on the
  // refresh path, so a dead peer must never cost the user more than ~10s.
  for (const entry of independentServers(network, primaryEndpoint).slice(0, 2)) {
    const client = new ElectrumClient({ endpoint: entry.url, reconnect: false });
    try {
      await withTimeout(client.connect(), timeoutMs, `connect ${entry.url}`);
      const tip = await withTimeout(
        client.request<{ height: number }>("blockchain.headers.subscribe"),
        timeoutMs,
        `tip ${entry.url}`,
      );
      const height = Number(tip?.height);
      if (Number.isFinite(height) && height > 0) {
        return { endpoint: entry.url, operator: entry.operator, height };
      }
    } catch {
      /* try the next independent operator */
    } finally {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

/**
 * Walk one BIP44 chain until the gap limit is satisfied.
 * `change` is 0 for the receive chain, 1 for the change chain.
 */
async function scanChain(
  client: ElectrumClient,
  wallet: HDWallet,
  change: number,
  onProgress?: (scanned: number) => void,
): Promise<ScannedAddress[]> {
  const out: ScannedAddress[] = [];
  let start = 0;
  let lastUsed = -1;

  while (start < HARD_ADDRESS_CAP) {
    const batch = wallet.deriveRange(start, GAP_LIMIT, change);
    const histories = await mapLimit(batch, 6, (k) =>
      client.getHistory(k.address).catch(() => [] as unknown[]),
    );

    batch.forEach((key, i) => {
      const used = (histories[i]?.length ?? 0) > 0;
      out.push({ key, used, change });
      if (used) lastUsed = key.index;
    });

    start += GAP_LIMIT;
    onProgress?.(out.length);
    // Stop once the gap limit is satisfied past the last activity.
    if (lastUsed < 0) break;
    if (start - lastUsed > GAP_LIMIT) break;
  }

  return out;
}

export interface ScanOptions {
  onProgress?: (message: string) => void;
}

/** Full wallet scan: discover addresses, then collect their UTXOs. */
export async function scanWallet(
  client: ElectrumClient,
  wallet: HDWallet,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const { onProgress } = options;

  onProgress?.("Discovering receive addresses…");
  const receive = await scanChain(client, wallet, 0, (n) =>
    onProgress?.(`Scanning receive addresses (${n})…`),
  );

  onProgress?.("Discovering change addresses…");
  const changeChain = await scanChain(client, wallet, 1, (n) =>
    onProgress?.(`Scanning change addresses (${n})…`),
  );

  const all = [...receive, ...changeChain];
  const used = all.filter((a) => a.used);

  onProgress?.(`Reading ${used.length} active address(es)…`);
  const unspentPerAddress = await mapLimit(used, 4, (entry) =>
    client.listUnspent(entry.key.address).catch(() => [] as Utxo[]),
  );

  const utxos: OwnedUtxo[] = [];
  used.forEach((entry, i) => {
    for (const u of unspentPerAddress[i]) {
      utxos.push({
        ...u,
        ownerAddress: entry.key.address,
        ownerWif: entry.key.wif,
        ownerIndex: entry.key.index,
        ownerChange: entry.change,
      });
    }
  });

  let confirmed = 0n;
  let unconfirmed = 0n;
  let tokenUtxoCount = 0;
  for (const u of utxos) {
    if ((u.refs?.length ?? 0) > 0) tokenUtxoCount++;
    if ((u.height ?? 0) > 0) confirmed += u.value;
    else unconfirmed += u.value;
  }

  const nextReceive =
    receive.find((a) => !a.used)?.key ?? wallet.deriveKey(receive.length, 0);
  const nextChange =
    changeChain.find((a) => !a.used)?.key ??
    wallet.deriveKey(changeChain.length, 1);

  return {
    addresses: all,
    utxos,
    confirmed,
    unconfirmed,
    total: confirmed + unconfirmed,
    tokenUtxoCount,
    nextReceive,
    nextChange,
  };
}

export type AddressCheck = { ok: true } | { ok: false; error: string };

/**
 * Validate a destination address.
 *
 * Radiant is a P2PKH/P2SH chain (no SegWit/bech32). We validate by re-deriving
 * the P2PKH script — an invalid base58 payload or bad checksum throws — and
 * then sanity-check the version prefix against the selected network.
 */
export function checkAddress(
  address: string,
  network: NetworkName,
): AddressCheck {
  const value = address.trim();
  if (!value) return { ok: false, error: "Enter a destination address" };

  let script: string;
  try {
    script = p2pkhScript(value);
  } catch {
    return {
      ok: false,
      error: "Not a valid Radiant address (bad checksum or length)",
    };
  }
  if (!/^76a914[0-9a-f]{40}88ac$/.test(script)) {
    return { ok: false, error: "Unsupported address type — P2PKH only" };
  }

  const first = value[0];
  if (network === "mainnet" && !"13".includes(first)) {
    return { ok: false, error: "That looks like a testnet address" };
  }
  if (network !== "mainnet" && !"mn2".includes(first)) {
    return { ok: false, error: "That looks like a mainnet address" };
  }
  return { ok: true };
}

export interface BuildPaymentParams {
  scan: ScanResult;
  to: string;
  amount: bigint;
  feeRate?: bigint;
  network: NetworkName;
}

/**
 * Build and sign a ref-safe RXD payment.
 * Never touches the network — the caller broadcasts.
 */
export function buildPayment({
  scan,
  to,
  amount,
  feeRate = MIN_FEE_RATE,
  network,
}: BuildPaymentParams): PaymentPlan {
  if (amount <= 0n) throw new Error("Amount must be greater than zero");

  const check = checkAddress(to, network);
  if (!check.ok) throw new Error(check.error);

  const funding: Utxo[] = scan.utxos.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: u.value,
    script: u.script,
    height: u.height,
    refs: u.refs,
  }));

  // Throws InsufficientFundsError / TokenBurnGuardError from the SDK.
  const selection = selectRxdFunding(funding, amount, feeRate, {
    baseOutputCount: 1,
    withChange: true,
  });

  // Preserve selection order — it defines the signing-key order.
  const chosen = selection.inputs.map((selected) => {
    const match = scan.utxos.find(
      (u) => u.txid === selected.txid && u.vout === selected.vout,
    );
    if (!match) {
      throw new Error(
        "Internal error: selected UTXO is not owned by this wallet",
      );
    }
    return match;
  });

  const built = buildTx({
    // Change destination: an already-watched, unused change-chain address.
    address: scan.nextChange.address,
    wif: chosen.map((u) => u.ownerWif),
    inputs: chosen.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      script: u.script,
    })),
    outputs: [{ script: p2pkhScript(to.trim()), value: amount }],
    feeRate,
    addChange: true,
    network,
  });

  const inputValue = chosen.reduce((sum, u) => sum + u.value, 0n);
  const outputValue = built.outputs.reduce((sum, o) => sum + o.value, 0n);
  const fee = inputValue - outputValue;

  if (fee < 0n) throw new Error("Internal error: negative fee");

  return {
    hex: built.hex,
    txid: built.txid,
    fee,
    inputsUsed: chosen.length,
    inputValue,
    change: selection.change,
  };
}

/** Broadcast a signed transaction, returning the txid the wallet computed. */
export async function broadcast(
  client: ElectrumClient,
  plan: PaymentPlan,
): Promise<string> {
  await client.broadcastTx(plan.hex);
  return plan.txid;
}
