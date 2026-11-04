import Foundation
import UIKit
import Capacitor

/**
 * Screen-capture protection for the iOS app.
 *
 * iOS has no FLAG_SECURE: the OS cannot be asked to refuse a user-initiated
 * screenshot, and there is no API to blank the app-switcher thumbnail. The
 * closest enforceable protection is to watch for screen capture (screen
 * recording, AirPlay mirroring, Sidecar) and cover the window with an opaque
 * black layer while capture is in progress, so captured frames contain
 * nothing but black.
 *
 * A manual screenshot (volume + side button) cannot be detected or blocked
 * on iOS — the JS layer documents that in the UI instead.
 *
 * The JS side raises protection only while a recovery phrase is on screen
 * (and optionally app-wide, see src/lib/screenSecurity.ts). Fail-safe
 * direction matches the Android implementation: if a release is ever missed
 * the app stays covered, which is harmless; the dangerous direction —
 * dropping the overlay while a phrase is visible — is what the refcount
 * prevents.
 */
@objc(ScreenSecurityPlugin)
public class ScreenSecurityPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ScreenSecurityPlugin"
    public let jsName = "ScreenSecurity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "setSecure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isSecure", returnType: CAPPluginReturnPromise),
    ]

    /** Tag so a second overlay can never be stacked on the first. */
    private static let overlayTag = 987_654_321

    /// Whether the JS layer currently holds protection.
    private var secure = false
    private var observing = false
    private var overlay: UIView?

    // MARK: - JS API

    @objc func setSecure(_ call: CAPPluginCall) {
        let enabled = call.getBool("enabled") ?? false
        DispatchQueue.main.async {
            self.setSecure(enabled: enabled)
            call.resolve(["secure": self.secure])
        }
    }

    @objc func isSecure(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["secure": self.secure])
        }
    }

    // MARK: - Implementation

    private func setSecure(enabled: Bool) {
        guard secure != enabled else { return }
        secure = enabled
        if enabled {
            startObserving()
            updateOverlay()
        } else {
            hideOverlay()
            stopObserving()
        }
    }

    private func startObserving() {
        guard !observing else { return }
        observing = true
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(screenCapturedDidChange),
            name: UIScreen.capturedDidChangeNotification,
            object: nil
        )
    }

    private func stopObserving() {
        guard observing else { return }
        observing = false
        NotificationCenter.default.removeObserver(
            self,
            name: UIScreen.capturedDidChangeNotification,
            object: nil
        )
    }

    @objc private func screenCapturedDidChange() {
        updateOverlay()
    }

    /// Show or hide the overlay to match (secure && capturing right now).
    private func updateOverlay() {
        if secure && UIScreen.main.captured {
            showOverlay()
        } else {
            hideOverlay()
        }
    }

    private func showOverlay() {
        guard overlay == nil,
              let host = bridge?.bridgedViewController?.view
                ?? webView?.window?.rootViewController?.view else {
            return
        }

        let layer = UIView(frame: host.bounds)
        layer.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        layer.backgroundColor = .black
        layer.tag = ScreenSecurityPlugin.overlayTag

        let label = UILabel(frame: .zero)
        label.text = "Screen capture in progress — content hidden"
        label.textColor = UIColor(white: 0.6, alpha: 1.0)
        label.font = .systemFont(ofSize: 13)
        label.textAlignment = .center
        label.translatesAutoresizingMaskIntoConstraints = false
        layer.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: layer.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: layer.centerYAnchor),
        ])

        host.addSubview(layer)
        host.bringSubviewToFront(layer)
        overlay = layer
    }

    private func hideOverlay() {
        overlay?.removeFromSuperview()
        overlay = nil
    }
}
