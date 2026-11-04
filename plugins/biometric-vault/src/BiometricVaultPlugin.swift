import Foundation
import LocalAuthentication
import Security
import Capacitor

/**
 * Hardware-backed biometric unlock.
 *
 * The wallet secret (the full encrypted-vault payload: mnemonic + network +
 * settings, JSON) is encrypted with an AES-256-GCM key that lives in the iOS
 * Keychain and is created with:
 *
 *   kSecAttrAccessControl = [.privateKeyUsage, .biometryCurrentSet]
 *
 * so EVERY use of the key (including encryption at enrollment) requires a
 * Face ID / Touch ID prompt, and enrolling a new face or fingerprint
 * invalidates the key — the iOS equivalents of AndroidKeyStore's
 * setUserAuthenticationRequired(true) and setInvalidatedByBiometricEnrollment(true).
 *
 * The access control is bound to the key itself: the OS only performs the GCM
 * operation after a successful biometric challenge, so authentication and
 * encryption/decryption cannot be separated (the iOS counterpart of binding
 * the BiometricPrompt to a CryptoObject). The key is a regular
 * keychain-protected key: the Secure Enclave does not support AES-GCM.
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

    /** Keychain service for the ciphertext item. */
    private let keychainService = "org.radiant.wallet.biometricvault"
    /** GCM nonce (96-bit) and auth tag (128-bit) lengths in bytes. */
    private let nonceBytes = 12
    private let tagBytes = 16

    // MARK: - JS API

    @objc func isAvailable(_ call: CAPPluginCall) {
        let context = LAContext()
        var error: NSError?

        // .biometryCurrentSet matches the key's access control exactly: true
        // only when biometric hardware is present, something is enrolled, and
        // the policy is evaluable right now.
        if !context.canEvaluatePolicy(.biometryCurrentSet, error: &error) {
            let reason = error?.localizedDescription
                ?? "No Face ID or Touch ID enrollment on this device"
            call.resolve(["available": false, "reason": reason])
            return
        }

        call.resolve(["available": true, "reason": ""])
    }

    @objc func isEnrolled(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "rxd-wallet-secrets"
        let enrolled = readCipher(alias: alias) != nil && findKey(alias: alias) != nil
        call.resolve(["enrolled": enrolled])
    }

    @objc func enroll(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "rxd-wallet-secrets"
        guard let secret = call.getString("secret"), !secret.isEmpty else {
            call.reject("No secret to enroll")
            return
        }

        // A missing or invalidated key is (re)created. The encryption below is
        // itself biometric-gated, so enrolling always shows the prompt.
        var key = findKey(alias: alias)
        let createdKey = (key == nil)
        if key == nil {
            key = createKey(alias: alias)
        }
        guard let key else {
            call.reject("Could not create the biometric-protected key")
            return
        }

        let nonce = randomNonce()
        guard !nonce.isEmpty, let cipher = encrypt(Data(secret.utf8), key: key, nonce: nonce) else {
            // Most often the user cancelled or failed the biometric prompt.
            if createdKey { deleteKey(alias: alias) }
            call.reject("Biometric enrollment failed")
            return
        }

        guard storeCipher(nonce + cipher, alias: alias) else {
            if createdKey { deleteKey(alias: alias) }
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
        guard let key = findKey(alias: alias) else {
            call.reject("Biometric unlock key is missing — use your passphrase")
            return
        }

        let nonce = Data(stored.prefix(nonceBytes))
        let cipher = Data(stored.dropFirst(nonceBytes))
        var error: Unmanaged<CFError>?
        guard let plain = SecKeyCreateDecryption(
            key,
            kSecKeyAlgorithmAESGCMDecryption,
            [kSecKeyInitializationVector as String: nonce],
            &error
        ) else {
            // Cancelled / failed prompt, or a key invalidated by new biometric
            // enrollment. Either way the passphrase still works.
            call.reject("Biometric unlock failed")
            return
        }
        guard let secret = String(data: plain, encoding: .utf8) else {
            call.reject("Stored biometric data is unreadable — use your passphrase")
            return
        }
        call.resolve(["secret": secret])
    }

    @objc func disable(_ call: CAPPluginCall) {
        let alias = call.getString("alias") ?? "rxd-wallet-secrets"
        deleteCipher(alias: alias)
        deleteKey(alias: alias)
        call.resolve(["ok": true])
    }

    // MARK: - Biometric-gated AES-256-GCM key

    private func keyTag(alias: String) -> Data {
        return Data("rxd-wallet-keystree:\(alias)".utf8)
    }

    private func keyQuery(alias: String) -> [String: Any] {
        return [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keyTag(alias: alias),
            kSecReturnRef as String: true,
        ]
    }

    private func makeAccessControl() -> SecAccessControl? {
        var error: Unmanaged<CFError>?
        return SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            [.privateKeyUsage, .biometryCurrentSet],
            &error
        )
    }

    private func createKey(alias: String) -> SecKey? {
        guard let accessControl = makeAccessControl() else { return nil }
        let attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeAES,
            kSecAttrKeyClass as String: kSecAttrKeyClassSecret,
            kSecAttrKeySizeInBits as String: 256,
            kSecAttrIsPermanent as String: true,
            kSecAttrApplicationTag as String: keyTag(alias: alias),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAttrAccessControl as String: accessControl,
        ]
        var error: Unmanaged<CFError>?
        return SecKeyCreateRandomKey(attributes as CFDictionary, &error)
    }

    private func findKey(alias: String) -> SecKey? {
        var result: CFTypeRef?
        let status = SecItemCopyMatching(keyQuery(alias: alias) as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? SecKey
    }

    private func deleteKey(alias: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrApplicationTag as String: keyTag(alias: alias),
        ]
        SecItemDelete(query as CFDictionary)
    }

    private func randomNonce() -> Data {
        var bytes = [UInt8](repeating: 0, count: nonceBytes)
        guard SecRandomCopyBytes(kSecRandomDefault, nonceBytes, &bytes) == errSecSuccess else {
            return Data()
        }
        return Data(bytes)
    }

    /** GCM: returns ciphertext || 16-byte auth tag. */
    private func encrypt(_ plaintext: Data, key: SecKey, nonce: Data) -> Data? {
        var error: Unmanaged<CFError>?
        let output = SecKeyCreateEncryption(
            key,
            kSecKeyAlgorithmAESGCMEncryption,
            [kSecKeyInitializationVector as String: nonce],
            &error
        )
        guard let output, output.count > tagBytes else { return nil }
        return output
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

