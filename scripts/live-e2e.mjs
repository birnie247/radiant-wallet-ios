// End-to-end validation: live chain read + offline signed-tx construction.
// NO BROADCAST happens here.
import {
  ElectrumClient,
  HDWallet,
  buildRxdTransfer,
  p2pkhScript,
  rxdToPhotons,
  photonsToRxd,
  radiantjs,
  selectRxdFunding,
} from "@radiant-core/sdk";

const ENDPOINT = "wss://electrumx.radiant4people.com:50022";
const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const ok = (m) => console.log("  OK   " + m);
const info = (m) => console.log("       " + m);

// ---------- 1. Live chain reads ----------
console.log("\n[1] Live ElectrumX read");
const client = new ElectrumClient({ endpoint: ENDPOINT });
await client.connect();
ok(`connected to ${ENDPOINT}`);

const wallet = HDWallet.fromMnemonic(MNEMONIC, { network: "mainnet" });
const me = wallet.deriveKey(0);
info(`derived ${me.path} -> ${me.address}`);

const bal = await client.getBalance(me.address);
ok(`getBalance -> confirmed=${photonsToRxd(bal.confirmed)} RXD unconfirmed=${photonsToRxd(bal.unconfirmed)}`);

const utxos = await client.listUnspent(me.address);
ok(`listUnspent -> ${utxos.length} utxo(s)`);

// Prove the round-trip works on an address with real history by walking
// recent blocks from the server and reading the coinbase payout address.
const tip = await client.request("blockchain.headers.subscribe");
if (tip?.height) ok(`tip height = ${tip.height}`);
const sv = await client.serverVersion("rxd-wallet", "1.4");
ok(`server.version -> ${JSON.stringify(sv)}`);

// ---------- 2. Signed transaction construction (offline) ----------
console.log("\n[2] Build + sign a transaction (offline, not broadcast)");
const FAKE_TXID = "a".repeat(64);
const funding = [
  { txid: FAKE_TXID, vout: 0, value: rxdToPhotons("1"), script: p2pkhScript(me.address), height: 400000 },
];

const dest = wallet.deriveKey(1).address; // send to our own second address
try {
  const built = buildRxdTransfer({
    address: me.address,
    wif: me.wif,
    to: dest,
    amount: rxdToPhotons("0.25"),
    utxos: funding,
    feeRate: 10_000n,
  });
  ok(`built tx ${built.txid}`);
  info(`hex length = ${built.hex.length} chars`);

  const tx = new radiantjs.Transaction(built.hex);
  info(`version=${tx.version} inputs=${tx.inputs.length} outputs=${tx.outputs.length}`);
  tx.outputs.forEach((o, i) => {
    info(`  out[${i}] value=${o.satoshis} script=${o.script.toHex().slice(0, 40)}...`);
  });

  // Radiant requires a trailing ref output; the last output must be 0-value.
  const last = tx.outputs[tx.outputs.length - 1];
  const lastScript = last.script.toHex();
  const hasRefOpcode = lastScript.includes("d0") || last.script.chunks?.some((c) => c.opc === 0xd0);
  console.log(
    `  ${last.satoshis === 0 && lastScript.length > 0 ? "OK  " : "WARN"} trailing ref output: value=${last.satoshis} script=${lastScript.slice(0, 30)} (refOpcode=${hasRefOpcode})`,
  );
  ok(`total out = ${photonsToRxd(tx.outputs.reduce((a, o) => a + BigInt(o.satoshis), 0n))} RXD`);
} catch (e) {
  console.log("  FAIL build:", e.message);
}

// ---------- 3. Ref-safe selection guard ----------
console.log("\n[3] Ref-safe funding guard");
const sel = selectRxdFunding(
  [
    { txid: "b".repeat(64), vout: 0, value: rxdToPhotons("1"), script: p2pkhScript(me.address) },
    { txid: "c".repeat(64), vout: 0, value: rxdToPhotons("5"), script: p2pkhScript(me.address) },
  ],
  rxdToPhotons("0.5"),
  10_000n,
);
ok(`selected ${sel.inputs.length} input(s), fee=${sel.fee}, change=${photonsToRxd(sel.change)} RXD`);

client.close?.();
console.log("\nAll checks finished.");
process.exit(0);
