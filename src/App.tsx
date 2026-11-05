import { useCallback, useEffect, useRef, useState } from "react";
import { hasVault, unlockVault, type WalletSecrets } from "./lib/vault";
import { connect, crossCheckTip, scanWallet, walletFor } from "./lib/wallet";
import { getPreferredServer } from "./lib/servers";
import { loadHistory, type HistoryEntry } from "./lib/history";
import { unlockWithBiometric } from "./lib/biometric";
import {
  acquireSecureScreen,
  releaseSecureScreen,
} from "./lib/screenSecurity";
import type { Screen, Session } from "./types";
import Onboarding from "./screens/Onboarding";
import Unlock from "./screens/Unlock";
import Home from "./screens/Home";
import Receive from "./screens/Receive";
import Send from "./screens/Send";
import Settings from "./screens/Settings";

/** Lock the wallet automatically after this long in the background. */
const BACKGROUND_LOCK_MS = 60_000;

/** L1: screen capture (recording/mirroring) is blocked app-wide unless the user
 *  opts out. iOS cannot block manual screenshots — see screenSecurity.ts. */
const ALLOW_SCREEN_CAPTURE_KEY = "rxd.security.allowScreenCapture";

export default function App() {
  const [booted, setBooted] = useState(false);
  const [hasExisting, setHasExisting] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [busy, setBusy] = useState("");
  /**
   * A connect/scan failure that happened before a session existed. Without
   * this the onboarding screen silently reappears and the reason — including
   * the per-endpoint errors — is lost, which reads as a "stall".
   */
  const [bootError, setBootError] = useState("");
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [tipDrift, setTipDrift] = useState<number | null>(null);
  const [allowScreenCapture, setAllowScreenCaptureState] =
    useState<boolean>(() => {
      try {
        return localStorage.getItem(ALLOW_SCREEN_CAPTURE_KEY) === "1";
      } catch {
        return false;
      }
    });

  const setAllowScreenCapture = useCallback((allow: boolean) => {
    setAllowScreenCaptureState(allow);
    try {
      localStorage.setItem(ALLOW_SCREEN_CAPTURE_KEY, allow ? "1" : "0");
    } catch {
      /* ignore storage failure */
    }
  }, []);

  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  /** Secrets of the wallet that failed to open, so "Try again" can retry. */
  const pendingSecrets = useRef<WalletSecrets | null>(null);

  useEffect(() => {
    setHasExisting(hasVault());
    setBooted(true);
  }, []);

  /**
   * Load confirmation-annotated history in the background.
   * Deliberately non-blocking: the wallet is usable before this resolves, and a
   * server that refuses to serve history must not stop the user spending.
   */
  const hydrateHistory = useCallback(async (next: Session) => {
    setHistory(null);
    setTipDrift(null);
    try {
      const result = await loadHistory(next.client, next.scan.addresses, {
        limit: 25,
      });
      setHistory(result.entries);
      setHistoryTotal(result.totalKnown);

      // MEDIUM-2: confirm the primary server's tip against an independent
      // operator. Best effort — a wallet must stay usable if it fails.
      const other = await crossCheckTip(next.secrets.network, next.endpoint);
      if (other) {
        setTipDrift(Math.abs(result.tipHeight - other.height));
      }
    } catch {
      setHistory([]);
      setHistoryTotal(0);
    }
  }, []);

  /** Connect, scan, and hold the wallet in memory. */
  const openWallet = useCallback(async (secrets: WalletSecrets) => {
    pendingSecrets.current = secrets;
    setBootError("");
    setBusy("Connecting to a Radiant server…");
    try {
      const { client, endpoint } = await connect(
        secrets.network,
        secrets.server || getPreferredServer() || undefined,
        (url) => setBusy(`Connecting to ${url.replace("wss://", "")}…`),
      );

      const wallet = walletFor(secrets);

      setBusy("Scanning the blockchain…");
      const scan = await scanWallet(client, wallet, {
        onProgress: setBusy,
      });

      setSession({ secrets, wallet, client, endpoint, scan });
      setScreen("home");
      pendingSecrets.current = null;
      void hydrateHistory({ secrets, wallet, client, endpoint, scan });
    } catch (e) {
      // Keep the reason on screen. Returning to onboarding silently made a
      // failed connection look like the app had simply stalled.
      setBootError((e as Error).message);
    } finally {
      setBusy("");
    }
  }, [hydrateHistory]);

  /** Re-scan balances against the live connection. */
  const refresh = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    setBusy("Refreshing…");
    try {
      const scan = await scanWallet(current.client, current.wallet, {
        onProgress: setBusy,
      });
      const next = { ...current, scan };
      setSession(next);
      void hydrateHistory(next);
    } finally {
      setBusy("");
    }
  }, [hydrateHistory]);

  /** Drop the socket and reconnect, optionally to a newly preferred server. */
  const reconnect = useCallback(async () => {
    const current = sessionRef.current;
    if (!current) return;
    setBusy("Reconnecting…");
    try {
      current.client.close();
    } catch {
      /* ignore */
    }
    try {
      const { client, endpoint } = await connect(
        current.secrets.network,
        getPreferredServer() || undefined,
        (url) => setBusy(`Connecting to ${url.replace("wss://", "")}…`),
      );
      const scan = await scanWallet(client, current.wallet, {
        onProgress: setBusy,
      });
      const next = { ...current, client, endpoint, scan };
      setSession(next);
      void hydrateHistory(next);
    } finally {
      setBusy("");
    }
  }, [hydrateHistory]);

  const lock = useCallback(() => {
    const current = sessionRef.current;
    if (current) {
      try {
        current.client.close();
      } catch {
        /* ignore */
      }
    }
    setSession(null);
    setScreen("home");
    setHasExisting(hasVault());
    setHistory(null);
    setHistoryTotal(0);
  }, []);

  // Auto-lock when the app has been in the background.
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
      } else if (hiddenAt && Date.now() - hiddenAt > BACKGROUND_LOCK_MS) {
        lock();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [lock]);

  // L1: block screen capture (recording/mirroring) app-wide, not only on seed
  // screens. The refcount in screenSecurity.ts means seed screens stay
  // protected even when the user has opted out here (for sharing a receive
  // QR, say).
  useEffect(() => {
    if (allowScreenCapture) return;
    void acquireSecureScreen();
    return () => {
      void releaseSecureScreen();
    };
  }, [allowScreenCapture]);

  // Tear the socket down on unmount.
  useEffect(() => {
    return () => {
      try {
        sessionRef.current?.client.close();
      } catch {
        /* ignore */
      }
    };
  }, []);

  if (!booted) {
    return <Splash />;
  }

  // A failure while opening the wallet is shown here: bouncing straight back
  // to the welcome screen made a failed connection look like a stall and threw
  // away the per-endpoint reasons.
  if (!session && !busy && bootError) {
    return (
      <div className="app">
        <div className="content">
          <div className="field">
            <label>Could not open the wallet</label>
            <div
              className="error"
              style={{ whiteSpace: "pre-wrap", fontSize: 12 }}
            >
              {bootError}
            </div>
            <div className="hint">
              The wallet is still saved on this device — nothing is lost.
              Check the connection and try again.
            </div>
          </div>
          <button
            className="btn primary"
            onClick={() => {
              const secrets = pendingSecrets.current;
              if (secrets) void openWallet(secrets);
            }}
          >
            Try again
          </button>
          <button className="btn" onClick={() => setBootError("")}>
            Back
          </button>
        </div>
      </div>
    );
  }

  if (!session) {
    if (busy) return <Splash message={busy} />;
    return hasExisting ? (
      <Unlock
        onUnlock={async (passphrase) => {
          const secrets = await unlockVault(passphrase);
          await openWallet(secrets);
        }}
        onBiometricUnlock={async () => {
          const secrets = await unlockWithBiometric();
          await openWallet(secrets);
        }}
      />
    ) : (
      <Onboarding
        onReady={async (secrets) => {
          await openWallet(secrets);
          setHasExisting(true);
        }}
      />
    );
  }

  const nav = {
    session,
    go: setScreen,
    refresh,
    lock,
    reconnect,
    busy,
    history,
    historyTotal,
    tipDrift,
    allowScreenCapture,
    setAllowScreenCapture,
  };

  return (
    <>
      {screen === "home" && <Home nav={nav} />}
      {screen === "receive" && <Receive nav={nav} />}
      {screen === "send" && <Send nav={nav} />}
      {screen === "settings" && <Settings nav={nav} />}
      {busy && (
        <div className="sheet-backdrop">
          <div className="sheet center">
            <div className="spin" />
            <div style={{ color: "var(--text-dim)", fontSize: 13 }}>{busy}</div>
          </div>
        </div>
      )}
    </>
  );
}

function Splash({ message }: { message?: string }) {
  return (
    <div className="app">
      <div className="splash">
        <div className="brand-mark">R</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 20 }}>Radiant Wallet</div>
          <div style={{ color: "var(--text-faint)", fontSize: 13 }}>
            Non-custodial · RXD
          </div>
        </div>
        {message ? (
          <div style={{ color: "var(--text-dim)", fontSize: 13, maxWidth: 300 }}>
            {message}
          </div>
        ) : (
          <div className="spin" />
        )}
      </div>
    </div>
  );
}
