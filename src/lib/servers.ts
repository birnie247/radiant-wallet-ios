/**
 * ElectrumX endpoints for Radiant.
 *
 * Transport: the Radiant SDK speaks ElectrumX over **WebSocket** JSON-RPC, so
 * every endpoint below is `wss://`. The historical 50001/50002 hosts
 * (`electrum.radiant.ovh`, `electrum.radiantblockchain.org`) are dead — neither
 * hostname resolves — so do not reintroduce them.
 *
 * Trust model (security report MEDIUM-2):
 *   • Every endpoint is `wss://` with a hostname, so the TLS certificate is
 *     actually verifiable. A bare-IP endpoint was REMOVED: an IP cannot match a
 *     certificate's identity, which silently degrades to "trust the network".
 *   • `operator` groups endpoints that share an administrator. Cross-checking
 *     two servers from the same operator proves nothing, so quorum logic
 *     (see crossCheckTip in wallet.ts) only counts distinct operators.
 *   • `verified` is not a UI label — connect() tries verified servers first and
 *     only falls back to unverified ones. Both flags describe the node operator,
 *     not the chain.
 *
 * What this still does NOT do: full SPV. A server can lie about history or
 * confirmations, and this client does not verify merkle proofs against block
 * headers or check proof-of-work. It only cross-checks the chain tip between
 * independent operators, which detects gross disagreement/staleness. Treat the
 * Electrum server as a semi-trusted view of the chain.
 */
import type { NetworkName } from "@radiant-core/sdk";

export interface ServerEntry {
  url: string;
  /** Administrator grouping; quorum requires distinct operators. */
  operator: string;
  /** True when this endpoint answered a live handshake during development. */
  verified: boolean;
}

export const SERVERS: Record<NetworkName, ServerEntry[]> = {
  mainnet: [
    {
      url: "wss://electrumx.radiant4people.com:50022",
      operator: "radiant4people.com",
      verified: true,
    },
    {
      url: "wss://electrumx2.radiant4people.com:50022",
      operator: "radiant4people.com",
      verified: true,
    },
    {
      url: "wss://radiant2.bladenet.online:50022",
      operator: "bladenet.online",
      verified: false,
    },
    {
      url: "wss://radiantus.bladenet.online:50022",
      operator: "bladenet.online",
      verified: false,
    },
    {
      url: "wss://radiant4.bladenet.online:50022",
      operator: "bladenet.online",
      verified: false,
    },
    {
      url: "wss://radiantcore.org:50004",
      operator: "radiantcore.org",
      verified: false,
    },
    // NOTE: the bare-IP endpoint wss://82.180.136.182:50004 was removed (see
    // the trust-model note above).
  ],
  testnet: [
    {
      url: "wss://electrumx-testnet.radiant4people.com:53002",
      operator: "radiant4people.com",
      verified: false,
    },
    {
      url: "wss://testnet.bladenet.online:53002",
      operator: "bladenet.online",
      verified: false,
    },
  ],
  regtest: [],
};

export function serverList(network: NetworkName): string[] {
  return SERVERS[network].map((s) => s.url);
}

export function findServer(
  network: NetworkName,
  url: string,
): ServerEntry | undefined {
  return SERVERS[network].find((s) => s.url === url);
}

/**
 * Ordered candidates: the user's choice first, then verified endpoints, then
 * unverified ones. Verified-first is what makes the flag mean something.
 */
export function candidateServers(
  network: NetworkName,
  preferred?: string,
): string[] {
  const all = SERVERS[network];
  const ordered = [
    ...all.filter((s) => s.verified),
    ...all.filter((s) => !s.verified),
  ];
  const urls = ordered.map((s) => s.url);
  if (!preferred) return urls;
  return [preferred, ...urls.filter((u) => u !== preferred)];
}

/**
 * Endpoints run by a DIFFERENT operator than `endpoint` — the only ones useful
 * for an independent cross-check. Verified endpoints are ordered first, but
 * unverified ones are included: a cross-check only compares chain heights, it
 * never trusts the peer's data. Including them means the check can still detect
 * disagreement when the curated peers are offline. If every candidate is down
 * the check simply returns null and no warning is shown (better than a false
 * alarm).
 */
export function independentServers(
  network: NetworkName,
  endpoint: string,
): ServerEntry[] {
  const primary = findServer(network, endpoint);
  const others = SERVERS[network].filter(
    (s) => s.url !== endpoint && s.operator !== primary?.operator,
  );
  return [
    ...others.filter((s) => s.verified),
    ...others.filter((s) => !s.verified),
  ];
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
