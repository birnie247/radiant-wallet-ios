import { useEffect, useMemo, useRef } from "react";
import { acquireSecureScreen, releaseSecureScreen } from "./screenSecurity";

/**
 * Convenience wrapper around the ref-counted screen-security manager.
 *
 * Each component holds at most ONE reference, released automatically on unmount,
 * so a crash or navigation can never leave a stray holder behind (and a stray
 * holder is the safe failure mode anyway).
 *
 * Call `hold()` and AWAIT it before revealing a recovery phrase, rather than
 * relying on an effect: effects run after paint, which would leave a frame where
 * the seed is visible without FLAG_SECURE set.
 */
export function useSecureScreen(): {
  hold: () => Promise<void>;
  release: () => Promise<void>;
} {
  const held = useRef(false);

  useEffect(() => {
    return () => {
      if (held.current) {
        held.current = false;
        void releaseSecureScreen();
      }
    };
  }, []);

  return useMemo(
    () => ({
      hold: async () => {
        if (held.current) return;
        held.current = true;
        await acquireSecureScreen();
      },
      release: async () => {
        if (!held.current) return;
        held.current = false;
        await releaseSecureScreen();
      },
    }),
    [],
  );
}
