/**
 * ElectrumX endpoints for Radiant.
 *
 * IMPORTANT: these are WebSocket (wss) endpoints, because the Radiant SDK talks
 * ElectrumX over WebSocket JSON-RPC. The historical ports 50001/50002 (plain
 * TCP/TLS) hosted by `electrum.radiant.ovh` and
 * `electrum.radiantblockchain.org` are DEAD — neither hostname resolves any
 * more, so do not reintroduce them.
 *
 * The list below mirrors Photonic Wallet's production `config.json`, with the
 * endpoints that answered a live `server.version` handshake ordered first.
 */
import type { NetworkName } from "@radiant-core/sdk";

export interface ServerEntry {
  url: string;
  /** True when this endpoint answered a live handshake during development. */
  verified: boolean;
}

export const SERVERS: Record<NetworkName, ServerEntry[]> = {
  mainnet: [
    { url: "wss://electrumx.radiant4people.com:50022", verified: true },
    { url: "wss://electrumx2.radiant4people.com:50022", verified: true },
    { url: "wss://radiant2.bladenet.online:50022", verified: false },
    { url: "wss://radiantus.bladenet.online:50022", verified: false },
    { url: "wss://radiant4.bladenet.online:50022", verified: false },
    { url: "wss://radiantcore.org:50004", verified: false },
    { url: "wss://82.180.136.182:50004", verified: false },
  ],
  testnet: [
    { url: "wss://electrumx-testnet.radiant4people.com:53002", verified: false },
    { url: "wss://testnet.bladenet.online:53002", verified: false },
  ],
  regtest: [],
};

export function serverList(network: NetworkName): string[] {
  return SERVERS[network].map((s) => s.url);
}

/** Endpoints to try, preferred first, then everything else. */
export function candidateServers(
  network: NetworkName,
  preferred?: string,
): string[] {
  const all = serverList(network);
  if (!preferred) return all;
  const rest = all.filter((u) => u !== preferred);
  return [preferred, ...rest];
}

/**
 * The user's chosen server is NOT a secret, so it lives outside the encrypted
 * vault — that way switching servers never requires the passphrase.
 */
const PREFERRED_KEY = "rxd.wallet.preferredServer";

export function getPreferredServer(): string | null {
  try {
    return localStorage.getItem(PREFERRED_KEY);
  } catch {
    return null;
  }
}

export function setPreferredServer(url: string): void {
  try {
    if (url) localStorage.setItem(PREFERRED_KEY, url);
    else localStorage.removeItem(PREFERRED_KEY);
  } catch {
    /* storage may be unavailable in private mode */
  }
}

