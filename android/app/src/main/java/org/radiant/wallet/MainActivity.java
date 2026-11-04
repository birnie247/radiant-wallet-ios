package org.radiant.wallet;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins must be registered BEFORE the bridge is created,
        // otherwise the JS side cannot find them.
        registerPlugin(BiometricVaultPlugin.class);
        registerPlugin(ScreenSecurityPlugin.class);
        super.onCreate(savedInstanceState);

        hardenWebView();
    }

    /**
     * Defence in depth (finding L2).
     *
     * Capacitor enables several "open the web" WebView capabilities by default
     * that a self-contained wallet has no use for. Nothing here changes how the
     * app's own assets load: Capacitor serves them over https://localhost via a
     * WebViewAssetLoader, not file://.
     *
     * Some of these setters are marked deprecated because modern WebViews no
     * longer honour every flag, but they are still the documented way to turn
     * the behaviours off on older engines, which minSdk 26 still supports.
     */
    @SuppressWarnings("deprecation")
    private void hardenWebView() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView == null) return;

        WebSettings settings = webView.getSettings();

        // No popups or scripted window.open(): nothing legitimate needs them.
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);

        // No geolocation: the wallet must never request location.
        settings.setGeolocationEnabled(false);

        // Do not retain form/autofill state inside the WebView.
        settings.setSaveFormData(false);

        // DOM storage must stay ON: the encrypted vault lives in localStorage.
        settings.setDomStorageEnabled(true);

        // Belt and braces with capacitor.config.ts + the build type: a wallet
        // must never expose its JS context to chrome://inspect.
        WebView.setWebContentsDebuggingEnabled(false);
    }
}

