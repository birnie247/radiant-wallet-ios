import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "org.radiant.wallet",
  appName: "Radiant Wallet",
  webDir: "dist",
  android: {
    // The wallet never loads remote content, so mixed content stays off.
    allowMixedContent: false,
    backgroundColor: "#000000",
  },
  server: {
    // An https scheme gives the WebView a secure context, which the clipboard
    // API and Web Crypto both require.
    androidScheme: "https",
  },
};

export default config;
