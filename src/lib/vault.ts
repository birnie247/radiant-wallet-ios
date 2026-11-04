/**
 * Encrypted seed storage.
 *
 * The mnemonic is encrypted with AES-256-GCM using a key stretched from the
 * user's passphrase with PBKDF2-SHA256. Only the ciphertext is persisted, and
 * the plaintext exists in memory solely while the wallet is unlocked.
 *
 * Threat model note: this protects a lost/stolen device backup and casual
 * filesystem inspection. It does NOT protect against a rooted device with a
 * memory dumper. See README "Security model" for the full discussion and the
 * planned Android Keystore hardening.
 */
import type { NetworkName } from "@radiant-core/sdk";

const STORAGE_KEY = "rxd.wallet.vault.v1";
const KDF_ITERATIONS = 310_000;

export interface WalletSecrets {
  mnemonic: string;
  network: NetworkName;
  /** Preferred ElectrumX endpoint; empty means use the built-in pool. */
  server: string;
  label: string;
  createdAt: number;
}

export interface StoredVault {
  v: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  ct: string;
  createdAt: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Uint8Array is not structurally assignable to BufferSource in every TS lib
// version, so normalise at the WebCrypto boundary.
const bs = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(value: string): Uint8Array {
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    bs(encoder.encode(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bs(salt), iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function hasVault(): boolean {
  return localStorage.getItem(STORAGE_KEY) !== null;
}

export function readVaultMeta(): { createdAt: number } | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredVault;
    return { createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

export async function saveVault(
  passphrase: string,
  secrets: WalletSecrets,
): Promise<void> {
  if (passphrase.length < 6) {
    throw new Error("Passphrase must be at least 6 characters");
  }
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: bs(iv) },
    key,
    bs(encoder.encode(JSON.stringify(secrets))),
  );

  const stored: StoredVault = {
    v: 1,
    kdf: "PBKDF2-SHA256",
    iterations: KDF_ITERATIONS,
    salt: toB64(salt),
    iv: toB64(iv),
    ct: toB64(new Uint8Array(ct)),
    createdAt: Date.now(),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
}

export async function unlockVault(passphrase: string): Promise<WalletSecrets> {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) throw new Error("No wallet on this device");

  let stored: StoredVault;
  try {
    stored = JSON.parse(raw) as StoredVault;
  } catch {
    throw new Error("Wallet data is corrupted");
  }

  const key = await deriveKey(
    passphrase,
    fromB64(stored.salt),
    stored.iterations,
  );
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bs(fromB64(stored.iv)) },
      key,
      bs(fromB64(stored.ct)),
    );
  } catch {
    // GCM authentication failure = wrong passphrase (or tampered vault).
    throw new Error("Wrong passphrase");
  }

  const secrets = JSON.parse(decoder.decode(plain)) as WalletSecrets;
  if (!secrets?.mnemonic) throw new Error("Wallet data is corrupted");
  return secrets;
}

/** Update the stored settings without changing the passphrase. */
export async function updateVaultSettings(
  passphrase: string,
  patch: Partial<Pick<WalletSecrets, "server" | "label">>,
): Promise<WalletSecrets> {
  const current = await unlockVault(passphrase);
  const next = { ...current, ...patch };
  await saveVault(passphrase, next);
  return next;
}

export function deleteVault(): void {
  localStorage.removeItem(STORAGE_KEY);
}
