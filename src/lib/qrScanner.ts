/**
 * Camera QR scanning for payment addresses.
 *
 * The native side (`QrScannerPlugin.swift`) presents the capture sheet and hands
 * back the raw payload; this module owns the bridge and the parsing rules, so
 * what a payload means is decided — and tested — in one place without a camera.
 *
 * Accepted payloads:
 *   • a bare address                   `1BvBMSE…xyz`
 *   • a payment URI, BIP-21 style      `radiant:1BvBMSE…xyz?amount=1.25&label=Coffee`
 *
 * The scheme is accepted loosely on purpose: wallets in the wild disagree on
 * whether it is `radiant:`, `rxd:` or absent, and the address is validated by
 * the caller anyway. Anything that does not carry an address-shaped value
 * returns null, so a URL or a random QR is rejected instead of half-parsed.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

interface QrScannerApi {
  isAvailable(): Promise<{ available: boolean }>;
  scan(): Promise<{ value: string }>;
}

const QrScanner = registerPlugin<QrScannerApi>("QrScanner");

/** True only inside the iOS app — a plain browser has no scanner. */
export function qrScanAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

/** True when the sheet was closed by the user rather than failing. */
export function isScanCancelled(error: unknown): boolean {
  const message = (error as Error)?.message ?? "";
  return /cancel/i.test(message);
}

export interface ScannedPayment {
  address: string;
  /** Amount in RXD exactly as written in the code, if it carried one. */
  amount?: string;
}

/** Base58, no 0/O/I/l — the shape of a Radiant address, before checksums. */
const ADDRESS_SHAPE = /^[1-9A-HJ-NP-Za-km-z]{25,40}$/;

/**
 * Extracts a payment from a scanned payload, or null when the code is neither
 * an address nor a payment URI carrying one.
 */
export function parsePaymentQr(payload: string): ScannedPayment | null {
  const text = payload.trim();
  if (!text) return null;

  const uri = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.+)$/.exec(text);
  if (uri) {
    const rest = uri[2];
    const queryAt = rest.indexOf("?");
    const address = (queryAt >= 0 ? rest.slice(0, queryAt) : rest).trim();
    if (!ADDRESS_SHAPE.test(address)) return null;
    const query = queryAt >= 0 ? rest.slice(queryAt + 1) : "";
    const amount = /(?:^|&)(?:amount|amt)=([^&]+)/i.exec(query)?.[1];
    return { address, amount: amount ? safeDecode(amount) : undefined };
  }

  if (!ADDRESS_SHAPE.test(text)) return null;
  return { address: text };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}

/**
 * Opens the scanner and returns the payment it found.
 *
 * Throws with a user-facing message when the code is unreadable, the camera is
 * unavailable or permission was refused; a deliberate cancel throws a message
 * containing "cancelled", which {@link isScanCancelled} recognises.
 */
export async function scanPaymentQr(): Promise<ScannedPayment> {
  if (!qrScanAvailable()) {
    throw new Error("QR scanning is only available in the iOS app");
  }
  const { value } = await QrScanner.scan();
  const parsed = parsePaymentQr(value);
  if (!parsed) {
    throw new Error("That QR code does not contain a Radiant address");
  }
  return parsed;
}
