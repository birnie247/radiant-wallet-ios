package org.radiant.wallet;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins must be registered BEFORE the bridge is created,
        // otherwise the JS side cannot find them.
        registerPlugin(BiometricVaultPlugin.class);
        registerPlugin(ScreenSecurityPlugin.class);
        super.onCreate(savedInstanceState);
    }
}

