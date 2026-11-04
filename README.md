# Radiant Wallet — non-custodial RXD for Android

A self-custody wallet for the [Radiant](https://radiantblockchain.org) (RXD)
blockchain. Your recovery phrase is generated on the device, encrypted on the
device, and used to sign transactions on the device. No server ever sees a
private key.

Built with **React + TypeScript + Capacitor**, signing through
[`@radiant-core/sdk`](https://www.npmjs.com/package/@radiant-core/sdk) — the
same library that powers Photonic Wallet — so Radiant-specific consensus
behaviour is the ecosystem's own proven code rather than a re-implementation.

---

## What works today

| Flow | Status |
| --- | --- |
| Create wallet (BIP39 12-word) with encrypted backup | ✅ verified |
| Restore from 12/15/18/21/24-word phrase (checksum validated) | ✅ verified |
| Encrypted seed at rest (AES-256-GCM, PBKDF2-SHA256 310k) | ✅ implemented |
| BIP44 discovery, gap limit 20, receive + change chains | ✅ verified |
| Live balance / UTXO fetch over ElectrumX WebSocket | ✅ verified vs mainnet |
| Ref-safe send with review screen | ✅ signing verified offline |
| Broadcast | ⚠️ implemented, not exercised with real funds |
| Mainnet / testnet, server switch with failover | ✅ implemented |
| Reveal recovery phrase behind passphrase re-entry | ✅ implemented |
| Auto-lock after 60 s in background | ✅ implemented |
| QR code display for receiving | ✅ implemented |
| **QR scanning, Glyph tokens, WAVE names, price** | ❌ not yet |

> **Honest caveat:** no transaction has been broadcast to mainnet from this code
> by me, because that requires funds. Everything up to and including a valid
> signature is verified. Treat the first real send as a test: start small.

---

## Radiant-specific facts (verified, not assumed)

Checked against the live chain, Radiant Core constants and the production
Photonic Wallet config. Getting any of them wrong produces a wallet that
silently derives the wrong addresses or burns tokens.

| Parameter | Value |
| --- | --- |
| Address format | Base58 only — P2PKH `0x00` (`1…`), P2SH `0x05` (`3…`). **No SegWit/bech32** |
| HD path | `m/44'/512'/account'/change/index` (SLIP-0044 coin type **512**) |
| Base unit | 1 RXD = **100,000,000 photons** |
| Signing | `SIGHASH_ALL \| FORKID` = `0x41` |
| Chain access | ElectrumX over **WebSocket**: `electrumx.radiant4people.com:50022` |
| Node P2P port | 7333 |

### The two places a naive wallet loses money

**1. Ref outputs (`OP_PUSHINPUTREF`, opcodes `0xD0–0xD8`).** A UTXO holding a
Glyph FT/NFT carries a ref *inside its output script*. It looks like ordinary
spendable value, so a value-based coin selector will spend it as fee funding —
and **burn the token**. Every funding path here goes through the SDK's
`selectRxdFunding`, which screens candidates by both indexer-reported refs and a
local opcode scan, and throws `TokenBurnGuardError` rather than risk a burn.

These are *not* a mandatory trailing output: a plain P2PKH payment legitimately
has no ref output. An earlier assumption during development that they were was
wrong, and the live build disproved it.

**2. Signing key order.** `buildTx` selects the signing key by **input index**
(`privKeys[index]`), not by matching the address. Spend inputs from several
addresses and the WIF array must stay exactly parallel to the inputs array, or
you get valid-looking transactions with invalid signatures. `buildPayment`
builds both in a single pass so they cannot drift, and
`scripts/check-multisign.mjs` proves the behaviour against the real signer.

### Dead servers (do not reintroduce)

The endpoints published in `@radiant-core/constants` are stale — both
`electrum.radiant.ovh` and `electrum.radiantblockchain.org` **no longer resolve
in DNS**, and `electrumx.radiantcore.org` accepts TCP but never completes a TLS
handshake. `src/lib/servers.ts` uses Photonic's production list instead. Run
`npm run probe` to re-check which endpoints are alive.

---

## Architecture

```
src/
  lib/
    wallet.ts     HD discovery, balance aggregation, ref-safe payment building
    vault.ts      AES-256-GCM + PBKDF2 encrypted seed storage
    servers.ts    ElectrumX endpoint pool (WebSocket) + preferred server
    money.ts      BigInt photon/RXD conversion (never float)
  screens/
    Onboarding.tsx  create / restore / passphrase
    Unlock.tsx      unlock + wipe
    Home.tsx        balance, sync status, funds by address
    Receive.tsx     QR + address
    Send.tsx        compose → review → broadcast
    Settings.tsx    servers, seed backup, lock, wipe
  shims/          browser replacements for Node internals (see below)
scripts/
  browser-path-check.ts  runtime proof of the browser crypto path
  check-multisign.mjs    multi-address signing-order proof
  live-e2e.mjs           live ElectrumX read + offline tx build
  probe-servers.mjs      liveness probe for every endpoint
```

### Why the shims exist

`radiantjs` was written for Node and reaches for Node internals. Bundling it for
a WebView is exactly where a wallet quietly breaks, so each replacement is
deliberate:

| Shim | Why |
| --- | --- |
| `shims/crypto.ts` | `createHash` is deliberately **absent** so radiantjs picks its pure-JS hasher. `createHmac` **is** provided (over `js-sha512`) because `lib/mnemonic/pbkdf2.js` calls it unconditionally with no fallback — without it, *creating any wallet fails*. |
| `shims/assert.cjs` | Node's `assert` is externalized to an empty module, so `assert(…)` throws "not a function" — during HD key building and **transaction serialisation**. Must be `.cjs` so `module.exports` is the callable. |
| `shims/ws.ts` | The SDK imports `ws` only as a Node fallback; the WebView always uses the global `WebSocket`. |
| `process.browser` define | `lib/crypto/random.js` branches on it to choose Web Crypto over `crypto.randomBytes`. Without it the CSPRNG path is dead. |

None of this was guessed: `npm run check:browser` builds the app's real module
graph and asserts a known BIP39 test-vector address, a freshly generated
mnemonic, and a signed transaction (sighash `0x41`, correct pubkey, sane fee).

---

## Quick start (browser dev)

```bash
npm install
npm run dev          # http://localhost:5173
```

The app runs in a normal browser, so you can develop the whole UI without an
emulator. Web Crypto and WebSocket both work over `localhost`.

## Build the APK

**Option A — cloud build (no Android Studio needed).**
`.github/workflows/android.yml` builds a debug APK on every push to `main` (and
on manual dispatch), running `npm ci → npm run build → npm run check:browser →
npx cap sync android → ./gradlew assembleDebug`. The APK is uploaded as the
`rxd-wallet-debug-apk` artifact.

**Option B — local build.**

```bash
npm install
npm run build
npx cap sync android
npx cap open android      # opens Android Studio
# or, from the command line:
cd android && ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
```

Requires JDK 21 and the Android SDK (platform 36). `minSdkVersion` is 26.

## Testing

```bash
npm run check:browser   # offline: crypto path, derivation, signing (fast, CI-safe)
npm run check:live      # live ElectrumX read + offline tx build (network required)
npm run probe           # which endpoints answer a handshake right now
node scripts/check-multisign.mjs   # proves input-index ↔ key pairing
```

`check:browser` is the important one: it builds the real module graph with the
production aliases, so it catches the class of bug where the app builds fine but
fails at runtime inside the WebView.

To also exercise the app's own `connect()` failover and `scanWallet()` discovery
against mainnet, append the `--live` flag:

```bash
npx vite build -c vite.test.config.ts && node dist-test/browser-path-check.js --live
```

Last live run: connected in 1.6 s, tip height 478552, 40 addresses discovered.

---

## Security model

**What is protected.** The mnemonic is encrypted with AES-256-GCM using a key
stretched from your passphrase via PBKDF2-SHA256 (310,000 iterations, 16-byte
random salt, 12-byte random IV, per-vault). Only ciphertext is stored; the
plaintext exists in memory solely while unlocked. The GCM tag means a wrong
passphrase or tampered vault fails cleanly rather than producing a garbage seed.

**Device hardening.** `android:allowBackup="false"` (so `adb backup` cannot
exfiltrate the vault), `usesCleartextTraffic="false"`, and no remote content is
ever loaded into the WebView.

**Known limitations — read these:**

1. **No Android Keystore / biometrics yet.** The passphrase alone protects the
   vault. A rooted device with a memory dumper can recover the seed while the
   wallet is unlocked. This is the top hardening priority.
2. **Keys are held in JS memory** while unlocked (WebView), not in native
   storage. Same class of exposure as any JavaScript wallet.
3. **No screenshot protection** (`FLAG_SECURE`) yet, so the recovery-phrase
   screen can be screen-recorded.
4. **Change goes to one address** (the first unused change-chain address) rather
   than a fresh change address per transaction. It is watched by the scanner, so
   funds are never stranded, but it is weaker privacy than ideal.
5. **Address gap is fixed at 20.** If history is spread further, raise
   `GAP_LIMIT` in `src/lib/wallet.ts`; the hard cap is 200.
6. **The vault is not independently audited.** Standard primitives, careful
   usage, but no third-party review.

**Never** ask anyone for your recovery phrase, and never type it into a website.
This app only ever asks for your *passphrase*, which is local to this device.

---

## Known issues / next steps

- `radiantcore.org` (Glyph/WAVE REST API) was unreachable from the development
  network, so Glyph-token and WAVE-name features are intentionally absent. The
  SDK has them; wiring them up is straightforward once that host is reachable.
- Broadcast is implemented via the standard `blockchain.transaction.broadcast`
  call but has not been exercised against mainnet with real funds.
- No price feed, no transaction history list (only UTXOs and per-address
  totals), no QR *scanner* (a `BarcodeDetector` hook fits naturally in
  `Receive.tsx`/`Send.tsx`).

**Roadmap:** Android Keystore-wrapped key + biometric unlock → `FLAG_SECURE` →
QR scanning → transaction history → Glyph FT send/receive → fiat price.

---

## Attribution & licence

Signing, ref-safety and Glyph logic come from
[`@radiant-core/sdk`](https://github.com/Radiant-Core/radiant-sdk) and
`@radiant-core/radiantjs` (both MIT). Endpoint list adapted from
[Photonic Wallet](https://github.com/RadiantBlockchain-Community/photonic-wallet).
This wallet is an independent client and is not affiliated with the Radiant
Foundation. Use at your own risk — this is unaudited software handling real
money.


