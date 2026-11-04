// Verify multi-address signing: does the input at index i get signed by wifs[i]?
import {
  HDWallet,
  p2pkhScript,
  rxdToPhotons,
  buildTx,
  radiantjs,
} from "@radiant-core/sdk";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

const w = HDWallet.fromMnemonic(MNEMONIC, { network: "mainnet" });
const a0 = w.deriveKey(0);
const a1 = w.deriveKey(1);
const a2 = w.deriveKey(2);
const dest = w.deriveKey(9);

console.log("addr0", a0.address, "pub", a0.publicKey.slice(0, 20));
console.log("addr1", a1.address, "pub", a1.publicKey.slice(0, 20));

const inputs = [
  { txid: "11".repeat(32), vout: 0, value: rxdToPhotons("1"), script: p2pkhScript(a0.address) },
  { txid: "22".repeat(32), vout: 1, value: rxdToPhotons("2"), script: p2pkhScript(a1.address) },
  { txid: "33".repeat(32), vout: 2, value: rxdToPhotons("3"), script: p2pkhScript(a2.address) },
];

let built;
try {
  built = buildTx({
    address: a0.address, // change destination
    wif: [a0.wif, a1.wif, a2.wif], // MUST be parallel to inputs
    inputs,
    outputs: [{ script: p2pkhScript(dest.address), value: rxdToPhotons("0.5") }],
    feeRate: 10_000n,
    addChange: true,
    network: "mainnet",
  });
} catch (e) {
  console.log("BUILD FAILED:", e.message);
  process.exit(1);
}

console.log("\ntxid:", built.txid, "hexlen:", built.hex.length);
const tx = new radiantjs.Transaction(built.hex);
console.log("inputs:", tx.inputs.length, "outputs:", tx.outputs.length);

const expect = [a0.publicKey, a1.publicKey, a2.publicKey];
let allOk = true;

tx.inputs.forEach((input, i) => {
  const chunks = input.script.chunks || [];
  // scriptSig = <sig+hashtype> <pubkey>
  const sigHex = chunks[0]?.buf ? Buffer.from(chunks[0].buf).toString("hex") : "";
  const pubHex = chunks[1]?.buf ? Buffer.from(chunks[1].buf).toString("hex") : "";
  const sigType = sigHex.slice(-2);
  const match = pubHex === expect[i];
  if (!match) allOk = false;
  console.log(
    `  in[${i}] pubkey ${match ? "MATCHES" : "MISMATCH"} addr${i}  sigType=0x${sigType} sigLen=${sigHex.length / 2}`,
  );
  if (!match) {
    console.log(`        got      ${pubHex}`);
    console.log(`        expected ${expect[i]}`);
  }
});

// Verify each signature cryptographically against its prevout script
let verifyOk = true;
try {
  tx.inputs.forEach((input, i) => {
    const ok = tx.verifyInput ? tx.verifyInput(i) : null;
    if (ok !== null) console.log(`  verifyInput(${i}) = ${ok}`);
  });
  console.log("  (radiantjs verifyInput available: " + String(!!tx.verifyInput) + ")");
} catch (e) {
  verifyOk = false;
  console.log("  verify threw:", e.message);
}

console.log(`\nRESULT: pubkey ordering ${allOk ? "OK" : "BROKEN"} | sigType must be 0x41`);
console.log(`out values: ${tx.outputs.map((o) => o.satoshis).join(", ")}`);
process.exit(allOk ? 0 : 1);
