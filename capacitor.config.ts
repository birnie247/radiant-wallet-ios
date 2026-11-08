import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  // The bundle id must be unique across the App Store. The Android build
  // (separate repo) uses org.radiant.wallet; keep a distinct id so the two
  // apps can coexist. Verify this one is unclaimed in the developer portal
  // before submitting.
  appId: "org.radiant.wallet.ios",
  appName: "Lumen RXD Wallet",
  webDir: "dist",
  backgroundColor: "#000000",
  ios: {
    // The wallet never loads remote content, so mixed content stays off.
    allowMixedContent: false,
  },
  server: {
    // An https scheme gives the WKWebView a secure context, which the
    // clipboard API and Web Crypto both require.
    iosScheme: "https",
  },
};

export default config;
