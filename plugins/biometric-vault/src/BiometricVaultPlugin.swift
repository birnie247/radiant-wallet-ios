import Foundation
import LocalAuthentication
import Security
import CryptoKit
import Capacitor

/**
 * Hardware-backed biometric unlock.
 *
 * The wallet secret (the full encrypted-vault payload: mnemonic + network +
 * settings, JSON) is encrypted with an AES-256-GCM key that is stored in the
 * iOS Keychain as a generic password item carrying:
 *
 *   kSecAttrAccessControl = kSecAccessControlBiometryCurrentSet
 *
 * so that EVERY access to the key — including the first read right after
 * enrollment — requires a Face ID / Touch ID prompt, and enrolling a new face
 * or fingerprint invalidates the key (key reads then fail until the user
 * re-enrolls). The iOS equivalents of AndroidKeyStore's
 * setUserAuthenticationRequired(true) and
 * setInvalidatedByBiometricEnrollment(true) — with the invalidation enforced
 * by the Keychain itself, at the key item.
 *
 * The GCM work uses CryptoKit: the legacy SecKeyCreateEncryption /
 * SecKeyCreateDecryption APIs were removed from recent SDKs. The key material
 * is a raw 256-bit secret; the biometric access control — not the cipher — is
 * the security boundary.
 *
 * Failure policy: everything here is best-effort. Any error is reported to
 * JS as a rejection so the UI can fall back to the passphrase. Biometric
 * unlock must never be the only way into the wallet.
 *
 * Documented differences from the Android implementation:
 *   - the system prompt offers no device-passcode fallback (the key requires
 *     the currently enrolled biometrics); the app passphrase remains the
 *     universal fallback, as before;
 *   - the ciphertext lives in the Keychain (generic password) rather than
 *     SharedPreferences.
 */
@objc(BiometricVaultPlugin)
public class BiometricVaultPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BiometricVaultPlugin"
    public let jsName = "BiometricVault"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isEnrolled", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enroll", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disable", returnType: CAPPluginReturnPromise),
    ]

    /** Keychain service shared by the key material and the ciphertext. */
    private let keychainService = "org.radiant.wallet.biometricvault"
    /** GCM nonce (96-bit) and auth tag (128-bit) lengths in bytes. */
    private let nonceBytes = 12
    private let tagBytes = 16

    // MARK: - JS API

    @objc func isAvailable(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?

        // The closest live policy to the key's access control: true only when
        // biometric hardware is present, something is enrolled, and the policy
        // is evaluable right now. (The biometryCurrentSet policy constant was
        // removed from recent SDKs; the current-set guarantee is enforced by
        // the Keychain access control itself, at key access.)
        if !context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) {
            let reason = error?.localizedDescription
                ?? "No Face ID or Touch ID enrollment on this device"
            call.resolve(["available": false, "reason": reason])
            return
        }

        call.resolve(["available": true, "reason": ""])
    }

    @objc func isEnrolled(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "rxd-wallet-secrets"
        let enrolled = readCipher(alias: alias) != nil && keyData(alias: alias) != nil
        call.resolve(["enrolled": enrolled])
    }

    @objc func enroll(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "rxd-wallet-secrets"
        guard let secret = call.getString("secret"), !secret.isEmpty else {
            call.reject("No secret to enroll")
            return
        }

        // A key (re)created below is bound to the biometric set enrolled at
        // that moment. Reading the key back is biometric-gated, so the prompt
        // the user sees here is the enrollment confirmation.
        deleteKey(alias: alias)
        deleteCipher(alias: alias)

        let key = SymmetricKey(size: .bits256)
        let rawKey = key.withUnsafeBytes { Data($0) }
        guard storeKey(rawKey, alias: alias) else {
            call.reject("Could not create the biometric-protected key")
            return
        }

        // Biometric prompt happens here. If it is cancelled or fails, drop
        // the fresh key so no orphaned material survives the attempt.
        guard keyData(alias: alias) != nil else {
            deleteKey(alias: alias)
            call.reject("Biometric enrollment failed")
            return
        }

        let nonce = AES.GCM.Nonce()
        let stored: Data
        do {
            let sealed = try AES.GCM.seal(Data(secret.utf8), using: key, nonce: nonce)
            // Container layout: nonce || ciphertext || auth tag.
            stored = nonce.withUnsafeBytes { Data($0) } + sealed.ciphertext + sealed.tag
        } catch {
            deleteKey(alias: alias)
            call.reject("Biometric enrollment failed")
            return
        }
        guard storeCipher(stored, alias: alias) else {
            deleteKey(alias: alias)
            call.reject("Could not store the encrypted secret")
            return
        }

        call.resolve(["ok": true])
    }


    @objc func unlock(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "rxd-wallet-secrets"
        guard let stored = readCipher(alias: alias),
              stored.count > nonceBytes + tagBytes else {
            call.reject("Biometric unlock is not enabled — use your passphrase")
            return
        }

        // Keychain access is where the biometric prompt happens: the OS
        // only returns the key after a successful Face ID / Touch ID against
        // the currently enrolled set.
        guard let rawKey = keyData(alias: alias) else {
            // Cancelled / failed prompt, or a key invalidated by new
            // biometric enrollment. Either way the passphrase still works.
            call.reject("Biometric unlock failed — use your passphrase")
            return
        }
        let key = SymmetricKey(data: rawKey)

        // Container layout: nonce || ciphertext || auth tag.
        let nonceData = Data(stored.prefix(nonceBytes))
        let cipherData = Data(stored.dropFirst(nonceBytes).dropLast(tagBytes))
        let tagData = Data(stored.suffix(tagBytes))
        do {
            let nonce = try AES.GCM.Nonce(data: nonceData)
            let sealedBox = try AES.GCM.SealedBox(nonce: nonce, ciphertext: cipherData, tag: tagData)
            let plain = try AES.GCM.open(sealedBox, using: key)
            guard let secret = String(data: plain, encoding: .utf8) else {
                call.reject("Stored biometric data is unreadable — use your passphrase")
                return
            }
            call.resolve(["secret": secret])
        } catch {
            call.reject("Biometric unlock failed — use your passphrase")
        }
    }

    @objc func disable(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "rxd-wallet-secrets"
        deleteCipher(alias: alias)
        deleteKey(alias: alias)
        call.resolve(["ok": true])
    }

    // MARK: - Biometric-gated key material (Keychain generic password)

    private func keyAccount(alias: String) -> String { "rxd-key:\(alias)" }

    private func keyQuery(alias: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keyAccount(alias: alias),
        ]
    }

    private func makeAccessControl() -> SecAccessControl? {
        var error: Unmanaged<CFError>?
        return SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            .biometryCurrentSet,
            &error
        )
    }

    private func storeKey(_ rawKey: Data, alias: String) -> Bool {
        guard let accessControl = makeAccessControl() else { return false }
        var query = keyQuery(alias: alias)
        query[kSecValueData as String] = rawKey
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        query[kSecAttrAccessControl as String] = accessControl
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    /**
     * Returns the raw key bytes, or nil when the biometric prompt is
     * cancelled/fails or the key was invalidated by a new enrollment.
     */
    private func keyData(alias: String) -> Data? {
        var query = keyQuery(alias: alias)
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    private func deleteKey(alias: String) {
        SecItemDelete(keyQuery(alias: alias) as CFDictionary)
    }

    // MARK: - Ciphertext item (Keychain generic password)

    private func cipherQuery(alias: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: alias,
        ]
    }

    private func storeCipher(_ data: Data, alias: String) -> Bool {
        SecItemDelete(cipherQuery(alias: alias) as CFDictionary)
        var query = cipherQuery(alias: alias)
        query[kSecValueData as String] = data
        query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(query as CFDictionary, nil) == errSecSuccess
    }

    private func readCipher(alias: String) -> Data? {
        var query = cipherQuery(alias: alias)
        query[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    private func deleteCipher(alias: String) {
        SecItemDelete(cipherQuery(alias: alias) as CFDictionary)
    }
}

