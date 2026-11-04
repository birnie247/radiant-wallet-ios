// Verify how radiantjs exposes input prevouts, so history parsing is grounded
// in observed behaviour rather than assumption.
import {
  HDWallet,
  buildTx,
  p2pkhScript,
  radiantjs,
  rxdToPhotons,
} from "@radiant-core/sdk";

const MN =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const w = HDWallet.fromMnemonic(MN, { network: "mainnet" });
const a0 = w.deriveKey(0);

// Deliberately NOT byte-symmetric, so reversal is detectable.
const DISPLAY_TXID =
  "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";

const built = buildTx({
  address: a0.address,
  wif: a0.wif,
  inputs: [
    {
      txid: DISPLAY_TXID,
      vout: 7,
      value: rxdToPhotons("1"),
      script: p2pkhScript(a0.address),
    },
  ],
  outputs: [{ script: p2pkhScript(w.deriveKey(3).address), value: rxdToPhotons("0.4") }],
  feeRate: 10_000n,
  network: "mainnet",
});

const tx = new radiantjs.Transaction(built.hex);
const input = tx.inputs[0];

const rawPrev = Buffer.from(input.prevTxId).toString("hex");
const reversedPrev = Buffer.from(input.prevTxId).reverse().toString("hex");

console.log("display txid we supplied :", DISPLAY_TXID);
console.log("input.prevTxId hex       :", rawPrev);
console.log("reversed                 :", reversedPrev);
console.log();
console.log("prevTxId === display     :", rawPrev === DISPLAY_TXID);
console.log("reverse()  === display   :", reversedPrev === DISPLAY_TXID);
console.log("input.outputIndex        :", input.outputIndex, "(expected 7)");
console.log("input object keys        :", Object.keys(input).join(", "));
console.log();
console.log("tx.id (computed)         :", tx.id);
console.log("built.txid               :", built.txid);
console.log("txid matches             :", tx.id === built.txid);
console.log();
tx.outputs.forEach((o, i) => {
  console.log(
    `out[${i}] satoshis=${o.satoshis} script=${o.script.toHex()}`,
  );
});
console.log("isCoinbase helper        :", typeof input.isNull, input.isNull?.());
