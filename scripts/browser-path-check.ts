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
import { buildPayment, connect, scanWallet } from "../src/lib/wallet";
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

  client.close();
}

console.log(`\n${failures === 0 ? "ALL BROWSER-PATH CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
process.exit(failures === 0 ? 0 : 1);
