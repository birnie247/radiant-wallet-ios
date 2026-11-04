import type { ElectrumClient, HDWallet } from "@radiant-core/sdk";
import type { WalletSecrets } from "./lib/vault";
import type { ScanResult } from "./lib/wallet";

/** An unlocked, connected wallet. Lives only in memory. */
export interface Session {
  secrets: WalletSecrets;
  wallet: HDWallet;
  client: ElectrumClient;
  endpoint: string;
  scan: ScanResult;
}

export type Screen = "home" | "receive" | "send" | "settings";

/** Navigation + wallet handles handed to every screen. */
export interface Nav {
  session: Session;
  go: (screen: Screen) => void;
  refresh: () => Promise<void>;
  lock: () => void;
  /** Drop the current socket and connect again (used after a server change). */
  reconnect: () => Promise<void>;
  /** Non-empty while a long operation is running. */
  busy: string;
}
