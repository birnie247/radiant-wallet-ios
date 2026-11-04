/**
 * Runtime check of the BROWSER code path.
 *
 * This is built with the same vite.config.ts (so the crypto/assert/ws shims and
 * the `process.browser` define all apply), then executed. If radiantjs silently
 * fell back to a broken hasher or a non-CSPRNG, the derived address or the
 * serialised transaction would differ / throw.
 *
 * Expected address for the standard BIP39 test vector at m/44'/512'/0'/0/0:
 *   18qiat9Kff5niCcincht6efD8HhFfzL1AJ
 */
import { HDWallet, p2pkhScript, radiantjs, rxdToPhotons } from "@radiant-core/sdk";
import {
  buildPayment,
  connect,
  crossCheckTip,
  scanWallet,
  MAX_TIP_DRIFT,
} from "../src/lib/wallet";
import { formatRxd, parseRxd } from "../src/lib/money";
import type { ScanResult } from "../src/lib/wallet";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  OK  " : "  FAIL"} ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
}

// 1. Deterministic derivation through the browser hasher.
const wallet = HDWallet.fromMnemonic(MNEMONIC, { network: "mainnet" });
const k0 = wallet.deriveKey(0);
check("derivation path", k0.path === "m/44'/512'/0'/0/0", k0.path);
check(
  "known test-vector address",
  k0.address === "18qiat9Kff5niCcincht6efD8HhFfzL1AJ",
  k0.address,
);

// 2. CSPRNG (Web Crypto path) — must produce a fresh 12-word mnemonic.
const generated = HDWallet.generateMnemonic();
check("generateMnemonic → 12 words", generated.split(" ").length === 12);
check("generated mnemonic is different", generated !== MNEMONIC);
const restored = HDWallet.fromMnemonic(generated, { network: "mainnet" });
const restoredAddr = restored.deriveKey(0).address;
// Mainnet P2PKH addresses are base58 "1..." and 26–35 chars (33 or 34 typical).
check(
  "generated mnemonic restores to a valid address",
  /^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(restoredAddr) &&
    p2pkhScript(restoredAddr).startsWith("76a914"),
  restoredAddr,
);

// 3. Money helpers (no float drift).
check("1 RXD = 1e8 photons", rxdToPhotons("1") === 100_000_000n);
check("parse/format round-trip", formatRxd(parseRxd("12.3456789"), 8) === "12.3456789");
check("formatRxd trims zeros", formatRxd(parseRxd("1.50000000")) === "1.5");
let rejected = false;
try {
  parseRxd("1.123456789");
} catch {
  rejected = true;
}
check("rejects >8 decimals", rejected);

// 4. Sign a transaction end-to-end (this exercises BufferWriter + assert).
const scan: ScanResult = {
  addresses: [{ key: k0, used: true, change: 0 }],
  utxos: [
    {
      txid: "a1".repeat(32),
      vout: 0,
      value: rxdToPhotons("1"),
      script: p2pkhScript(k0.address),
      height: 400_000,
      ownerAddress: k0.address,
      ownerWif: k0.wif,
      ownerIndex: 0,
      ownerChange: 0,
    },
  ],
  confirmed: rxdToPhotons("1"),
  unconfirmed: 0n,
  total: rxdToPhotons("1"),
  tokenUtxoCount: 0,
  nextReceive: k0,
  nextChange: wallet.deriveKey(0, 1),
};

const plan = buildPayment({
  scan,
  to: wallet.deriveKey(5).address,
  amount: rxdToPhotons("0.25"),
  network: "mainnet",
});
check("txid is 64 hex chars", /^[0-9a-f]{64}$/.test(plan.txid), plan.txid);
// 245-byte tx at the 10,000 photons/byte floor ≈ 2.45M photons (0.0245 RXD).
check(
  "fee is positive and proportionate",
  plan.fee > 0n && plan.fee < rxdToPhotons("0.1"),
  `${plan.fee} photons`,
);
check(
  "fee covers the byte size at the requested rate",
  plan.fee >= BigInt(Math.ceil(plan.hex.length / 2)) * 10_000n,
  `${plan.hex.length / 2} bytes`,
);

const tx = new radiantjs.Transaction(plan.hex);
check("re-decodes to 1 input / 2 outputs", tx.inputs.length === 1 && tx.outputs.length === 2);
const sigHex = tx.inputs[0].script.chunks[0]?.buf
  ? Buffer.from(tx.inputs[0].script.chunks[0].buf).toString("hex")
  : "";
check("sighash byte is 0x41 (ALL|FORKID)", sigHex.slice(-2) === "41", "0x" + sigHex.slice(-2));
const pubHex = tx.inputs[0].script.chunks[1]?.buf
  ? Buffer.from(tx.inputs[0].script.chunks[1].buf).toString("hex")
  : "";
check("signing pubkey is ours", pubHex === k0.publicKey);

// 5. Optional live integration: exercise the app's OWN networking code
//    (`connect` failover + `scanWallet` gap-limit discovery) against mainnet.
if (process.argv.includes("--live")) {
  console.log("\n[live] connecting via src/lib/wallet.connect()…");
  const started = Date.now();
  const { client, endpoint } = await connect("mainnet", undefined, (url) =>
    console.log("       trying " + url),
  );
  check("connect() reached a server", !!endpoint, endpoint);
  check("connect() latched in < 20s", Date.now() - started < 20_000, `${Date.now() - started}ms`);

  const watch = wallet.deriveKey(0);
  const balance = await client.getBalance(watch.address);
  check(
    "getBalance round-trip",
    typeof balance.confirmed === "bigint",
    `${formatRxd(balance.confirmed)} RXD`,
  );

  const tip = await client.request<{ height: number }>("blockchain.headers.subscribe");
  check("chain tip is a real height", (tip?.height ?? 0) > 0, `height ${tip?.height}`);

  const scan = await scanWallet(client, wallet);
  check(
    "scanWallet() completed gap-limit discovery",
    scan.addresses.length >= 40 && typeof scan.total === "bigint",
    `${scan.addresses.length} addresses, ${scan.utxos.length} utxos`,
  );

  // MEDIUM-2: independent tip cross-check.
  const primaryTip = await client.request<{ height: number }>(
    "blockchain.headers.subscribe",
  );
  const other = await crossCheckTip("mainnet", endpoint);
  if (other) {
    const drift = Math.abs((primaryTip?.height ?? 0) - other.height);
    check(
      "independent operator agrees on the chain tip",
      drift <= MAX_TIP_DRIFT,
      `${endpoint.replace("wss://", "")}=${primaryTip?.height} vs ${other.operator}=${other.height} (drift ${drift})`,
    );
  } else {
    console.log("       (no independent server reachable — cross-check skipped)");
  }

  client.close();
}

// 6. History: direction, confirmation math and fee, against synthetic txs.
//    A stub client serves pre-built real transactions, so this exercises the
//    actual parser + prevout resolution without touching the network.
{
  const { loadHistory, headerTime } = await import("../src/lib/history");
  const { p2pkhScript: p2pkh, buildTx } = await import("@radiant-core/sdk");

  // A second, foreign wallet to act as the counterparty.
  const foreign = HDWallet.fromMnemonic(
    "legal winner thank year wave sausage worth useful legal winner thank yellow",
    { network: "mainnet" },
  );
  const foreignKey = foreign.deriveKey(0);

  const ours = wallet.deriveKey(0);
  const change = wallet.deriveKey(0, 1);

  // tx1: foreign -> us, 1 RXD.  (a receive)
  const funding = buildTx({
    address: foreignKey.address,
    wif: foreignKey.wif,
    inputs: [
      {
        txid: "ab".repeat(32),
        vout: 0,
        value: rxdToPhotons("2"),
        script: p2pkh(foreignKey.address),
      },
    ],
    outputs: [{ script: p2pkh(ours.address), value: rxdToPhotons("1") }],
    feeRate: 10_000n,
    network: "mainnet",
  });

  // tx2: us -> foreign, 0.5 RXD.  (a send; change returns to us)
  const spend = buildTx({
    address: change.address,
    wif: ours.wif,
    inputs: [
      {
        txid: funding.txid,
        vout: 0,
        value: rxdToPhotons("1"),
        script: p2pkh(ours.address),
      },
    ],
    outputs: [{ script: p2pkh(foreignKey.address), value: rxdToPhotons("0.5") }],
    feeRate: 10_000n,
    network: "mainnet",
  });

  const tip = 105;
  // 80-byte header with timestamp 1700000000 at byte offset 68.
  const ts = 1_700_000_000;
  const tsLe = Buffer.alloc(4);
  tsLe.writeUInt32LE(ts, 0);
  const header =
    "00".repeat(68) + tsLe.toString("hex") + "ffff7f20" + "00000000";

  check("headerTime parses block time", headerTime(header) === ts, String(ts));

  const stub = {
    getHistory: async (addr: string) =>
      addr === ours.address
        ? [
            { tx_hash: funding.txid, height: 100 },
            { tx_hash: spend.txid, height: 101 },
          ]
        : [],
    getTransaction: async (txid: string) => {
      if (txid === funding.txid) return funding.hex;
      if (txid === spend.txid) return spend.hex;
      throw new Error("unknown tx " + txid);
    },
    request: async (method: string, ...params: unknown[]) => {
      if (method === "blockchain.headers.subscribe") return { height: tip };
      if (method === "blockchain.block.header") return header;
      throw new Error("unexpected method " + method + " " + params.length);
    },
  } as never;

  const result = await loadHistory(
    stub,
    [
      { key: ours, used: true, change: 0 },
      { key: change, used: true, change: 1 },
    ],
    { limit: 10 },
  );

  check("history returns both txs", result.entries.length === 2, `${result.entries.length}`);
  check("tip height propagated", result.tipHeight === tip, String(result.tipHeight));

  const incoming = result.entries.find((e) => e.txid === funding.txid)!;
  const outgoing = result.entries.find((e) => e.txid === spend.txid)!;

  check(
    "receive detected with correct amount",
    incoming?.direction === "received" && incoming.net === rxdToPhotons("1"),
    `${incoming?.direction} ${incoming?.net}`,
  );
  check(
    "receive confirmations = tip - height + 1",
    incoming?.confirmations === 6,
    String(incoming?.confirmations),
  );
  check(
    "send detected with negative net",
    outgoing?.direction === "sent" && outgoing.net < 0n,
    `${outgoing?.direction} ${outgoing?.net}`,
  );
  check(
    "send confirmations = tip - height + 1",
    outgoing?.confirmations === 5,
    String(outgoing?.confirmations),
  );
  check(
    "fee computed for a fully-owned send",
    typeof outgoing?.fee === "bigint" && outgoing.fee > 0n,
    String(outgoing?.fee),
  );
  check(
    "block time attached",
    incoming?.time === ts && outgoing?.time === ts,
  );
}

// 7. Screen-security holder counting.
//    The dangerous failure mode is clearing FLAG_SECURE while another component
//    still shows a seed, so the counter is worth asserting explicitly.
{
  const {
    acquireSecureScreen,
    releaseSecureScreen,
    secureScreenHolders,
    screenSecurityAvailable,
  } = await import("../src/lib/screenSecurity");

  check("screen security is inert off-device", screenSecurityAvailable() === false);

  await acquireSecureScreen();
  await acquireSecureScreen();
  check("two overlapping holders", secureScreenHolders() === 2);

  await releaseSecureScreen();
  check("flag stays raised with one holder left", secureScreenHolders() === 1);

  await releaseSecureScreen();
  check("cleared only after the last release", secureScreenHolders() === 0);

  await releaseSecureScreen();
  check("counter never goes negative", secureScreenHolders() === 0);
}

// 8. Vault policy + KDF upgrade (security report MEDIUM-1 / L4).
//    Uses a localStorage stub + the real WebCrypto, so this exercises the
//    actual encrypt/decrypt/upgrade path rather than a mock.
{
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
  };

  const vault = await import("../src/lib/vault");
  const secrets = {
    mnemonic: "test test test",
    network: "mainnet" as const,
    server: "",
    label: "t",
    createdAt: 1,
  };

  check("6-char passphrase rejected by policy", vault.checkPassphrase("abc123") !== null);
  check(
    "12-char passphrase accepted",
    vault.checkPassphrase("correct horse battery") === null,
  );
  check(
    "repetitive passphrase rejected",
    vault.checkPassphrase("aaaaaaaaaaaaaaaa") !== null,
  );

  let policyEnforced = false;
  try {
    await vault.saveVault("abc123", secrets);
  } catch {
    policyEnforced = true;
  }
  check("saveVault enforces the policy", policyEnforced);

  await vault.saveVault("correct horse battery", secrets);
  const meta = vault.readVaultMeta();
  check("new vault uses 600k iterations", meta?.iterations === 600_000, String(meta?.iterations));
  check("new vault is schema 2", meta?.schema === 2, String(meta?.schema));
  check(
    "vault round-trips",
    (await vault.unlockVault("correct horse battery")).mnemonic === secrets.mnemonic,
  );

  // Hand-build a LEGACY vault: schema 1, 310k iterations, 6-char passphrase.
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode("oldpass1"),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const oldKey = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: 310_000, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"],
  );
  const oldCt = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    oldKey,
    enc.encode(JSON.stringify(secrets)),
  );
  const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
  store.set(
    "rxd.wallet.vault.v1",
    JSON.stringify({
      v: 1,
      kdf: "PBKDF2-SHA256",
      iterations: 310_000,
      salt: b64(salt),
      iv: b64(iv),
      ct: b64(new Uint8Array(oldCt)),
      createdAt: 1,
    }),
  );

  check("legacy vault reported as needing upgrade", vault.needsKdfUpgrade());
  check(
    "legacy 6-char passphrase still unlocks",
    (await vault.unlockVault("oldpass1")).mnemonic === secrets.mnemonic,
  );
  const upgraded = vault.readVaultMeta();
  check(
    "legacy vault auto-upgraded to 600k / schema 2",
    upgraded?.iterations === 600_000 && upgraded?.schema === 2,
    `${upgraded?.iterations}/${upgraded?.schema}`,
  );
  check(
    "upgraded vault still opens with the same passphrase",
    (await vault.unlockVault("oldpass1")).mnemonic === secrets.mnemonic,
  );

  // Tampered KDF parameters must be refused, not honoured.
  const tampered = JSON.parse(store.get("rxd.wallet.vault.v1")!);
  tampered.iterations = 1_000;
  store.set("rxd.wallet.vault.v1", JSON.stringify(tampered));
  let tamperRejected = false;
  try {
    await vault.unlockVault("oldpass1");
  } catch {
    tamperRejected = true;
  }
  check("absurd stored iteration count rejected", tamperRejected);
}

console.log(`\n${failures === 0 ? "ALL BROWSER-PATH CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);

