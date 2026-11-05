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
 * Capture detection (current SDK, where UIScreen.captured and its
 * notification were removed):
 *   - iOS 17+: the scene's capture state is a UITraitCollection trait
 *     (sceneCaptureState). The overlay view stays mounted while protection
 *     is held (transparent when idle) and observes traitCollectionDidChange
 *     on itself.
 *   - iOS 15/16: the legacy UIScreenCapturedDidChange notification is
 *     referenced by its string value (the SDK symbol is gone) and the state
 *     is read from the window's screen.
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

    /// Legacy capture notification, referenced by string because the
    /// UIScreen.capturedDidChangeNotification symbol was removed from the
    /// current SDK.
    private static let capturedDidChange = Notification.Name("UIScreenCapturedDidChange")

    /// Whether the JS layer currently holds protection.
    private var secure = false
    private var observing = false
    private var overlay: CaptureSentinelView?

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
            installOverlay()
        } else {
            stopObserving()
            removeOverlay()
        }
    }

    /**
     * The overlay is kept mounted for as long as protection is held, in two
     * visual states: transparent (capture idle) and black (capture in
     * progress). On iOS 17+ it is also the receiver of the capture-state
     * trait, so it cannot simply be removed when capture stops.
     */
    private func installOverlay() {
        guard overlay == nil, let host = hostView() else { return }

        let layer = CaptureSentinelView(frame: host.bounds)
        layer.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        layer.backgroundColor = .clear
        // Never swallow touches — the overlay is a mirror, not an input
        // surface; the app underneath keeps working while it is transparent.
        layer.isUserInteractionEnabled = false
        layer.tag = ScreenSecurityPlugin.overlayTag
        layer.onCaptureStateChanged = { [weak self] in self?.updateOverlayState() }

        host.addSubview(layer)
        host.bringSubviewToFront(layer)
        overlay = layer

        startObserving()
        updateOverlayState()
    }

    private func hostView() -> UIView? {
        if let view = bridge?.viewController?.view { return view }
        let window = UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene)?.keyWindow }
            .first
        return window?.rootViewController?.view
    }


    private func startObserving() {
        guard !observing else { return }
        observing = true
        if #unavailable(iOS 17.0) {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(capturedDidChangeNotified),
                name: ScreenSecurityPlugin.capturedDidChange,
                object: nil
            )
        }
    }

    private func stopObserving() {
        guard observing else { return }
        observing = false
        if #unavailable(iOS 17.0) {
            NotificationCenter.default.removeObserver(
                self,
                name: ScreenSecurityPlugin.capturedDidChange,
                object: nil
            )
        }
    }

    @objc private func capturedDidChangeNotified() {
        updateOverlayState()
    }

    private func screenIsCaptured() -> Bool {
        if #available(iOS 17.0, *) {
            return overlay?.traitCollection.sceneCaptureState == .active
        } else {
            let screen = overlay?.window?.windowScene?.screen ?? UIScreen.main
            return screen.isCaptured
        }
    }

    private func updateOverlayState() {
        guard secure, let overlay else { return }
        overlay.setCaptured(screenIsCaptured())
    }

    private func removeOverlay() {
        overlay?.removeFromSuperview()
        overlay = nil
    }
}

/**
 * Full-window mirror that serves two purposes: covers the content with
 * black while capture is in progress, and (on iOS 17+) receives the
 * sceneCaptureState trait change that signals capture starting and stopping.
 */
private final class CaptureSentinelView: UIView {
    var onCaptureStateChanged: (() -> Void)?
    private var label: UILabel?

    func setCaptured(_ captured: Bool) {
        backgroundColor = captured ? .black : .clear
        if captured {
            guard label == nil else { return }
            let l = UILabel(frame: .zero)
            l.text = "Screen capture in progress — content hidden"
            l.textColor = UIColor(white: 0.6, alpha: 1.0)
            l.font = .systemFont(ofSize: 13)
            l.textAlignment = .center
            l.translatesAutoresizingMaskIntoConstraints = false
            addSubview(l)
            NSLayoutConstraint.activate([
                l.centerXAnchor.constraint(equalTo: centerXAnchor),
                l.centerYAnchor.constraint(equalTo: centerYAnchor),
            ])
            label = l
        } else {
            label?.removeFromSuperview()
            label = nil
        }
    }

    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        // Any trait refresh re-evaluates the capture state; on iOS 17+ this
        // is where sceneCaptureState changes are observed.
        if #available(iOS 17.0, *) {
            onCaptureStateChanged?()
        }
    }
}
