import { useEffect, useState } from "react";
import { deleteVault, unlockVault } from "../lib/vault";
import { SERVERS, setPreferredServer } from "../lib/servers";
import {
  biometricStatus,
  disableBiometricUnlock,
  enableBiometricUnlock,
  type BiometricStatus,
} from "../lib/biometric";
import { formatRxd, shortId } from "../lib/money";
import { useSecureScreen } from "../lib/useSecureScreen";
import { screenSecurityAvailable } from "../lib/screenSecurity";
import type { Nav } from "../types";

export default function Settings({ nav }: { nav: Nav }) {
  const { session } = nav;
  const network = session.secrets.network;
  const servers = SERVERS[network];

  const [confirmWipe, setConfirmWipe] = useState(false);
  const [revealOpen, setRevealOpen] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [revealed, setRevealed] = useState("");
  const [revealError, setRevealError] = useState("");
  const [switching, setSwitching] = useState("");
  const [bio, setBio] = useState<BiometricStatus | null>(null);
  const [bioBusy, setBioBusy] = useState(false);
  const [bioError, setBioError] = useState("");

  // Screenshots / recording are blocked while the phrase sheet is open.
  const secure = useSecureScreen();

  async function openReveal() {
    await secure.hold();
    setRevealOpen(true);
  }

  async function closeReveal() {
    await secure.release();
    setRevealOpen(false);
    setRevealed("");
    setRevealError("");
    setPassphrase("");
  }

  useEffect(() => {
    let alive = true;
    biometricStatus()
      .then((status) => {
        if (alive) setBio(status);
      })
      .catch(() => {
        /* biometrics are optional */
      });
    return () => {
      alive = false;
    };
  }, []);

  const bioEnrolled = bio?.enrolled === true;

  async function toggleBiometric() {
    setBioError("");
    setBioBusy(true);
    try {
      if (bioEnrolled) {
        await disableBiometricUnlock();
      } else {
        await enableBiometricUnlock(session.secrets);
      }
      setBio(await biometricStatus());
    } catch (e) {
      setBioError((e as Error).message);
    } finally {
      setBioBusy(false);
    }
  }

  async function chooseServer(url: string) {
    if (url === session.endpoint) return;
    setSwitching(url);
    setPreferredServer(url);
    try {
      await nav.reconnect();
    } finally {
      setSwitching("");
    }
  }

  async function reveal() {
    setRevealError("");
    try {
      const secrets = await unlockVault(passphrase);
      setRevealed(secrets.mnemonic);
      setPassphrase("");
    } catch (e) {
      setRevealError((e as Error).message);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <button className="icon-btn" onClick={() => nav.go("home")}>
          ←
        </button>
        <h1>Settings</h1>
      </div>

      <div className="content">
        <div className="section-title">Wallet</div>
        <div className="card tight">
          <div className="row" style={{ paddingTop: 0 }}>
            <div className="grow">
              <div className="title">Network</div>
              <div className="sub">
                {network === "mainnet" ? "Radiant mainnet" : "Radiant testnet"}
              </div>
            </div>
            <span className="pill live">
              <span className="dot" /> {network}
            </span>
          </div>
          <div className="row">
            <div className="grow">
              <div className="title">Balance</div>
              <div className="sub">
                {session.scan.utxos.length} UTXO
                {session.scan.utxos.length === 1 ? "" : "s"}
              </div>
            </div>
            <div className="value">{formatRxd(session.scan.total, 8)} RXD</div>
          </div>
          <div className="row">
            <div className="grow">
              <div className="title">Next address</div>
              <div className="sub">
                {shortId(session.scan.nextReceive.address, 12, 10)}
              </div>
            </div>
            <div className="sub">{session.scan.nextReceive.path}</div>
          </div>
          <div className="row">
            <div className="grow">
              <div className="title">Connected to</div>
              <div className="sub">{session.endpoint.replace("wss://", "")}</div>
            </div>
          </div>
        </div>

        <div className="section-title">ElectrumX server</div>
        <div className="card tight">
          {servers.map((server) => {
            const active = server.url === session.endpoint;
            return (
              <div className="row" key={server.url}>
                <div className="grow">
                  <div className="title">{server.url.replace("wss://", "")}</div>
                  <div className="sub">
                    {server.verified ? "verified" : "unverified"}
                    {switching === server.url ? " · connecting…" : ""}
                  </div>
                </div>
                <button
                  className={`btn small ${active ? "primary" : ""}`}
                  disabled={active || !!switching || !!nav.busy}
                  onClick={() => void chooseServer(server.url)}
                >
                  {active ? "In use" : "Use"}
                </button>
              </div>
            );
          })}
        </div>

        <div className="hint">
          If your balance ever looks wrong, switch servers and refresh. Servers
          only index public chain data and never see your keys.
        </div>

        <div className="section-title">Security</div>
        <div className="stack">
          <button className="btn" onClick={nav.lock}>
            Lock wallet now
          </button>
          <button className="btn" onClick={() => void openReveal()}>
            Show recovery phrase
          </button>

          {bio?.platform === true && bio.available ? (
            <button
              className="btn"
              onClick={toggleBiometric}
              disabled={bioBusy}
            >
              {bioBusy
                ? "Waiting for biometric…"
                : bioEnrolled
                  ? "Disable biometric unlock"
                  : "Enable biometric unlock"}
            </button>
          ) : (
            <div className="hint">
              {bio?.reason ||
                "Biometric unlock is only available in the Android app."}
            </div>
          )}

          {bioEnrolled && (
            <div className="hint">
              Your wallet secret is encrypted by a hardware key in the Android
              Keystore that requires a strong biometric for every use. Enrolling
              a new fingerprint invalidates the key and disables biometric
              unlock.
            </div>
          )}

          {bioError && <div className="error">{bioError}</div>}
        </div>

        <div className="section-title">Danger zone</div>
        {confirmWipe ? (
          <div className="danger-zone stack">
            <div style={{ fontSize: 13 }}>
              This deletes the encrypted wallet from this device. Without your
              written recovery phrase the funds are gone forever.
            </div>
            <div className="btn-row">
              <button
                className="btn ghost"
                onClick={() => setConfirmWipe(false)}
              >
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  // Drop the Keystore-wrapped copy too, so a deleted wallet
                  // cannot be reopened through the biometric prompt.
                  await disableBiometricUnlock();
                  deleteVault();
                  window.location.reload();
                }}
              >
                Delete forever
              </button>
            </div>
          </div>
        ) : (
          <button className="btn danger" onClick={() => setConfirmWipe(true)}>
            Delete wallet from this device
          </button>
        )}

        <div className="section-title">About</div>
        <div className="card tight">
          <div className="row" style={{ paddingTop: 0 }}>
            <div className="grow">
              <div className="title">Radiant Wallet</div>
              <div className="sub">v0.1.0 · non-custodial</div>
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <div className="title">Derivation</div>
              <div className="sub">BIP44 m/44'/512'/account'/change/index</div>
            </div>
          </div>
          <div className="row">
            <div className="grow">
              <div className="title">Address type</div>
              <div className="sub">P2PKH base58 (Radiant has no SegWit)</div>
            </div>
          </div>
        </div>
      </div>

      {revealOpen && (
        <RevealSheet
          revealed={revealed}
          passphrase={passphrase}
          setPassphrase={setPassphrase}
          error={revealError}
          onReveal={reveal}
          onClose={() => void closeReveal()}
        />
      )}
    </div>
  );
}

function RevealSheet({
  revealed,
  passphrase,
  setPassphrase,
  error,
  onReveal,
  onClose,
}: {
  revealed: string;
  passphrase: string;
  setPassphrase: (v: string) => void;
  error: string;
  onReveal: () => void;
  onClose: () => void;
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: 700, fontSize: 17 }}>
          {revealed ? "Your recovery phrase" : "Confirm passphrase"}
        </div>

        {revealed ? (
          <>
            <div className="card tight" style={{ background: "var(--bg)" }}>
              <div className="seed-grid">
                {revealed.split(" ").map((w, i) => (
                  <div className="seed-word" key={`${w}-${i}`}>
                    <i>{i + 1}</i>
                    {w}
                  </div>
                ))}
              </div>
            </div>
            <div className="notice">
              Anyone with these words can spend your RXD. Never photograph them
              or type them into a website.
            </div>
            {screenSecurityAvailable() && (
              <div className="hint">
                Screenshots and screen recording are blocked while this phrase is
                on screen.
              </div>
            )}
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </>
        ) : (
          <>
            <div className="field">
              <label>Passphrase</label>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
              />
            </div>
            {error && <div className="error">{error}</div>}
            <div className="btn-row">
              <button className="btn ghost" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn primary"
                onClick={onReveal}
                disabled={passphrase.length === 0}
              >
                Reveal
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
