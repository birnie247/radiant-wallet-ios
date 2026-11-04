package org.radiant.wallet;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.annotation.NonNull;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;
import androidx.fragment.app.FragmentActivity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Hardware-backed biometric unlock.
 *
 * The wallet secret (the full encrypted-vault payload: mnemonic + network +
 * settings, JSON) is encrypted with an AES-256-GCM key that lives in the
 * AndroidKeyStore and is created with:
 *
 *   setUserAuthenticationRequired(true)
 *   setInvalidatedByBiometricEnrollment(true)   // adding a new fingerprint wipes it
 *
 * The key material never leaves the TEE/StrongBox. Decryption is only possible
 * after a successful BIOMETRIC_STRONG authentication, and the cipher is bound to
 * the prompt via a BiometricPrompt.CryptoObject so authentication and decryption
 * cannot be separated.
 *
 * Failure policy: everything here is best-effort. Any error is reported to JS as
 * a rejection so the UI can fall back to the passphrase. Biometric unlock must
 * never be the only way into a wallet.
 */
@CapacitorPlugin(name = "BiometricVault")
public class BiometricVaultPlugin extends Plugin {

    private static final String ANDROID_KEYSTORE = "AndroidKeyStore";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String PREFS = "rxd_biometric_vault";
    private static final int GCM_TAG_BITS = 128;

    private PluginCall pendingCall;
    private String pendingAlias;
    private Cipher pendingCipher;
    private byte[] pendingCiphertext;
    private boolean pendingEncrypt;
    private String pendingPlaintext;

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private KeyStore keystore() throws Exception {
        KeyStore ks = KeyStore.getInstance(ANDROID_KEYSTORE);
        ks.load(null);
        return ks;
    }

    private boolean keyExists(String alias) {
        try {
            return keystore().containsAlias(alias);
        } catch (Exception e) {
            return false;
        }
    }

    private static String describe(int code) {
        switch (code) {
            case BiometricManager.BIOMETRIC_SUCCESS:
                return "";
            case BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE:
                return "This device has no biometric hardware";
            case BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE:
                return "Biometric hardware is currently unavailable";
            case BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED:
                return "No fingerprint or face is enrolled in system settings";
            case BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED:
                return "A security update is required before biometrics can be used";
            default:
                return "Biometric authentication is unavailable";
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int result = BiometricManager.from(getContext())
                .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG);
        boolean available = result == BiometricManager.BIOMETRIC_SUCCESS;
        JSObject ret = new JSObject();
        ret.put("available", available);
        ret.put("reason", available ? "" : describe(result));
        call.resolve(ret);
    }

    @PluginMethod
    public void isEnrolled(PluginCall call) {
        String alias = call.getString("alias");
        boolean enrolled = alias != null
                && prefs().contains(alias + ".ct")
                && prefs().contains(alias + ".iv")
                && keyExists(alias);
        JSObject ret = new JSObject();
        ret.put("enrolled", enrolled);
        call.resolve(ret);
    }
    @PluginMethod
    public void enroll(PluginCall call) {
        String alias = call.getString("alias");
        String secret = call.getString("secret");
        if (alias == null || alias.isEmpty() || secret == null || secret.isEmpty()) {
            call.reject("alias and secret are required");
            return;
        }
        if (pendingCall != null) {
            call.reject("Another biometric request is already in progress");
            return;
        }
        try {
            SecretKey key = getOrCreateKey(alias);
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key);

            pendingCall = call;
            pendingAlias = alias;
            pendingCipher = cipher;
            pendingEncrypt = true;
            pendingPlaintext = secret;
            pendingCiphertext = null;

            showPrompt(cipher, "Enable biometric unlock", "Confirm to protect this wallet");
        } catch (Exception e) {
            clearPending();
            call.reject("Could not start biometric enrolment: " + e.getMessage());
        }
    }

    @PluginMethod
    public void unlock(PluginCall call) {
        String alias = call.getString("alias");
        if (alias == null || alias.isEmpty()) {
            call.reject("alias is required");
            return;
        }
        if (pendingCall != null) {
            call.reject("Another biometric request is already in progress");
            return;
        }
        String ivB64 = prefs().getString(alias + ".iv", null);
        String ctB64 = prefs().getString(alias + ".ct", null);
        if (ivB64 == null || ctB64 == null) {
            call.reject("Biometric unlock is not set up on this device");
            return;
        }
        try {
            byte[] iv = Base64.decode(ivB64, Base64.NO_WRAP);
            byte[] ct = Base64.decode(ctB64, Base64.NO_WRAP);

            KeyStore ks = keystore();
            if (!ks.containsAlias(alias)) {
                call.reject("The biometric key is gone; re-enable it in settings");
                return;
            }
            SecretKey key = (SecretKey) ks.getKey(alias, null);
            if (key == null) {
                call.reject("The biometric key is unavailable; re-enable it in settings");
                return;
            }

            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(GCM_TAG_BITS, iv));

            pendingCall = call;
            pendingAlias = alias;
            pendingCipher = cipher;
            pendingEncrypt = false;
            pendingPlaintext = null;
            pendingCiphertext = ct;

            showPrompt(cipher, "Unlock wallet", "Confirm your identity to unlock");
        } catch (Exception e) {
            clearPending();
            call.reject("Could not start biometric unlock: " + e.getMessage());
        }
    }


    @PluginMethod
    public void disable(PluginCall call) {
        String alias = call.getString("alias");
        if (alias != null) {
            try {
                KeyStore ks = keystore();
                if (ks.containsAlias(alias)) ks.deleteEntry(alias);
            } catch (Exception ignored) {
                // Losing the key is the goal; an error here is not fatal.
            }
            prefs().edit().remove(alias + ".iv").remove(alias + ".ct").apply();
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    private void showPrompt(Cipher cipher, String title, String subtitle) {
        if (!(getActivity() instanceof FragmentActivity)) {
            failPending("No foreground activity to show the biometric prompt in");
            return;
        }
        final FragmentActivity activity = (FragmentActivity) getActivity();

        activity.runOnUiThread(() -> {
            try {
                BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                        .setTitle(title)
                        .setSubtitle(subtitle)
                        .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
                        .setNegativeButtonText("Use passphrase")
                        .setConfirmationRequired(true)
                        .build();

                BiometricPrompt prompt = new BiometricPrompt(
                        activity,
                        ContextCompat.getMainExecutor(activity),
                        new BiometricPrompt.AuthenticationCallback() {
                            @Override
                            public void onAuthenticationSucceeded(
                                    @NonNull BiometricPrompt.AuthenticationResult result) {
                                Cipher used = cipher;
                                if (result.getCryptoObject() != null
                                        && result.getCryptoObject().getCipher() != null) {
                                    used = result.getCryptoObject().getCipher();
                                }
                                completeWith(used);
                            }

                            @Override
                            public void onAuthenticationError(int errorCode,
                                                              @NonNull CharSequence errString) {
                                failPending(errString == null || errString.length() == 0
                                        ? "Authentication cancelled"
                                        : errString.toString());
                            }

                            @Override
                            public void onAuthenticationFailed() {
                                // One non-matching attempt: leave the prompt open.
                            }
                        });

                prompt.authenticate(new BiometricPrompt.CryptoObject(cipher), info);
            } catch (Exception e) {
                failPending("Biometric prompt failed: " + e.getMessage());
            }
        });
    }


    private void completeWith(Cipher cipher) {
        PluginCall call = pendingCall;
        String alias = pendingAlias;
        boolean encrypting = pendingEncrypt;
        String plaintext = pendingPlaintext;
        byte[] ciphertext = pendingCiphertext;
        try {
            if (encrypting) {
                byte[] ct = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
                byte[] iv = cipher.getIV();
                if (iv == null) throw new IllegalStateException("Cipher produced no IV");
                prefs().edit()
                        .putString(alias + ".iv", Base64.encodeToString(iv, Base64.NO_WRAP))
                        .putString(alias + ".ct", Base64.encodeToString(ct, Base64.NO_WRAP))
                        .apply();
                clearPending();
                JSObject ret = new JSObject();
                ret.put("ok", true);
                if (call != null) call.resolve(ret);
            } else {
                byte[] plain = cipher.doFinal(ciphertext);
                clearPending();
                JSObject ret = new JSObject();
                ret.put("secret", new String(plain, StandardCharsets.UTF_8));
                if (call != null) call.resolve(ret);
            }
        } catch (Exception e) {
            clearPending();
            if (call != null) call.reject("Biometric cryptography failed: " + e.getMessage());
        }
    }

    private void failPending(String message) {
        PluginCall call = pendingCall;
        clearPending();
        if (call != null) call.reject(message);
    }

    private void clearPending() {
        pendingCall = null;
        pendingAlias = null;
        pendingCipher = null;
        pendingCiphertext = null;
        pendingPlaintext = null;
        pendingEncrypt = false;
    }

    private SecretKey getOrCreateKey(String alias) throws Exception {
        KeyStore ks = keystore();
        if (ks.containsAlias(alias)) {
            return (SecretKey) ks.getKey(alias, null);
        }

        KeyGenerator generator = KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE);

        KeyGenParameterSpec.Builder builder = new KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                // Enrolling a new biometric invalidates the key, so a fingerprint
                // added later to the device cannot unwrap the wallet.
                .setInvalidatedByBiometricEnrollment(true);

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.R) {
            // Per-use authentication (timeout 0), strong biometrics only.
            builder.setUserAuthenticationParameters(
                    0, KeyProperties.AUTH_BIOMETRIC_STRONG);
        }

        generator.init(builder.build());
        return generator.generateKey();
    }


}
