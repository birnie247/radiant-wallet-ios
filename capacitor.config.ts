import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "org.radiant.wallet",
  appName: "Radiant Wallet",
  webDir: "dist",
  android: {
    // The wallet never loads remote content, so mixed content stays off.
    allowMixedContent: false,
    backgroundColor: "#000000",
    // HIGH-1: Capacitor's default is "debuggable builds only", but state it
    // explicitly so a stray debug build cannot expose the JS context (and the
    // decrypted mnemonic) to chrome://inspect over adb.
    webContentsDebuggingEnabled: false,
  },
  server: {
    // An https scheme gives the WebView a secure context, which the clipboard
    // API and Web Crypto both require.
    androidScheme: "https",
  },
};

export default config;
