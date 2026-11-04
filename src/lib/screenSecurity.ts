/**
 * Reference-counted screen-recording protection.
 *
 * The native `ScreenSecurity` plugin toggles WindowManager FLAG_SECURE, which
 * blocks screenshots, keeps the window out of screen recordings / casting, and
 * blanks the app in the Recents thumbnail.
 *
 * FLAG_SECURE is global to the window, so a naive "turn it on, turn it off" from
 * two components at once would let the second caller clear the flag while the
 * first still shows a seed. Hence a holder count: the flag is only cleared when
 * the LAST holder releases it.
 *
 * Fail-safe direction: if a release is ever missed the app stays
 * screenshot-blocked, which is harmless. The dangerous direction — dropping the
 * flag while a phrase is visible — is what the counter prevents.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";

interface ScreenSecurityApi {
  setSecure(options: { enabled: boolean }): Promise<{ secure: boolean }>;
  isSecure(): Promise<{ secure: boolean }>;
}

const ScreenSecurity = registerPlugin<ScreenSecurityApi>("ScreenSecurity");

let holders = 0;
/** Last state we successfully pushed to the window, to avoid bridge churn. */
let applied: boolean | null = null;

/** True only where the plugin exists (the Android app). */
export function screenSecurityAvailable(): boolean {
  return Capacitor.isNativePlatform();
}

async function apply(enabled: boolean): Promise<void> {
  if (!screenSecurityAvailable()) return;
  if (applied === enabled) return;
  try {
    await ScreenSecurity.setSecure({ enabled });
    applied = enabled;
  } catch {
    // Let a later call retry rather than caching a failed state.
    applied = null;
  }
}

/**
 * Mark that a sensitive surface is visible. Safe to call repeatedly, but pair
 * every call with exactly one {@link releaseSecureScreen}.
 */
export async function acquireSecureScreen(): Promise<void> {
  holders++;
  await apply(true);
}

/** Release one hold; the window is only unprotected once none remain. */
export async function releaseSecureScreen(): Promise<void> {
  holders = Math.max(0, holders - 1);
  if (holders === 0) await apply(false);
}

/** Diagnostic helper: how many surfaces currently hold the protection. */
export function secureScreenHolders(): number {
  return holders;
}
