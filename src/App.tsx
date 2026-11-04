import { useCallback, useEffect, useRef, useState } from "react";
import { HDWallet } from "@radiant-core/sdk";
import { hasVault, unlockVault, type WalletSecrets } from "./lib/vault";
import { connect, scanWallet } from "./lib/wallet";
import { getPreferredServer } from "./lib/servers";
import { loadHistory, type HistoryEntry } from "./lib/history";
import { unlockWithBiometric } from "./lib/biometric";
import type { Screen, Session } from "./types";
import Onboarding from "./screens/Onboarding";
import Unlock from "./screens/Unlock";
import Home from "./screens/Home";
import Receive from "./screens/Receive";
import Send from "./screens/Send";
import Settings from "./screens/Settings";

/** Lock the wallet automatically after this long in the background. */
const BACKGROUND_LOCK_MS = 60_000;

export default function App() {
  const [booted, setBooted] = useState(false);
  const [hasExisting, setHasExisting] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [busy, setBusy] = useState("");
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);

  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

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
    try {
      const result = await loadHistory(next.client, next.scan.addresses, {
        limit: 25,
      });
      setHistory(result.entries);
      setHistoryTotal(result.totalKnown);
    } catch {
      setHistory([]);
      setHistoryTotal(0);
    }
  }, []);

  /** Connect, scan, and hold the wallet in memory. */
  const openWallet = useCallback(async (secrets: WalletSecrets) => {
    setBusy("Connecting to a Radiant server…");
    try {
      const { client, endpoint } = await connect(
        secrets.network,
        secrets.server || getPreferredServer() || undefined,
        (url) => setBusy(`Connecting to ${url.replace("wss://", "")}…`),
      );

      const wallet = HDWallet.fromMnemonic(secrets.mnemonic, {
        network: secrets.network,
      });

      setBusy("Scanning the blockchain…");
      const scan = await scanWallet(client, wallet, {
        onProgress: setBusy,
      });

      setSession({ secrets, wallet, client, endpoint, scan });
      setScreen("home");
      void hydrateHistory({ secrets, wallet, client, endpoint, scan });
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
