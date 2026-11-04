import { useState } from "react";
import { deleteVault } from "../lib/vault";

export default function Unlock({
  onUnlock,
}: {
  onUnlock: (passphrase: string) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);

  async function submit() {
    setError("");
    setWorking(true);
    try {
      await onUnlock(passphrase);
    } catch (e) {
      setError((e as Error).message);
      setPassphrase("");
      setWorking(false);
    }
  }

  return (
    <div className="app">
      <div className="splash" style={{ justifyContent: "flex-start", paddingTop: 48 }}>
        <div className="brand-mark">R</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 20 }}>Welcome back</div>
          <div style={{ color: "var(--text-faint)", fontSize: 13 }}>
            Enter your passphrase to unlock
          </div>
        </div>
      </div>

      <div className="content" style={{ justifyContent: "flex-end", gap: 14 }}>
        <div className="field">
          <label>Passphrase</label>
          <input
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            placeholder="Your wallet passphrase"
            autoCapitalize="none"
            autoCorrect="off"
            onKeyDown={(e) => {
              if (e.key === "Enter" && passphrase.length > 0) void submit();
            }}
          />
        </div>
        {error && <div className="error">{error}</div>}
        <button
          className="btn primary"
          disabled={working || passphrase.length === 0}
          onClick={submit}
        >
          {working ? "Unlocking…" : "Unlock"}
        </button>

        <hr className="hr" />

        {confirmWipe ? (
          <div className="danger-zone stack">
            <div style={{ fontSize: 13 }}>
              This permanently deletes the wallet from this device. You can only
              get your funds back with your written recovery phrase.
            </div>
            <div className="btn-row">
              <button className="btn ghost" onClick={() => setConfirmWipe(false)}>
                Cancel
              </button>
              <button
                className="btn danger"
                onClick={() => {
                  deleteVault();
                  window.location.reload();
                }}
              >
                Delete wallet
              </button>
            </div>
          </div>
        ) : (
          <button className="btn ghost small" onClick={() => setConfirmWipe(true)}>
            Forgot passphrase?
          </button>
        )}
      </div>
    </div>
  );
}
