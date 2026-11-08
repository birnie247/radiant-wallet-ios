import Foundation
import AVFoundation
import UIKit
import Capacitor

/**
 * Camera QR scanning.
 *
 * `scan()` presents a full-screen capture view, decodes the first QR code it
 * sees, and resolves with the raw payload — interpreting the payload (a bare
 * address, or a `radiant:…?amount=…` payment URI) is the JS layer's job, so the
 * parsing rules live with the rest of the wallet logic and can be tested
 * without a camera.
 *
 * The camera runs only while the sheet is open: the capture session starts in
 * `viewDidLoad` and is stopped the moment the sheet goes away. Frames are
 * decoded on the fly and never stored, recorded or sent anywhere.
 *
 * Cancel rejects with "Scan cancelled" so the UI can tell a deliberate back-out
 * from a real failure. Every other path rejects with a message suitable for
 * showing directly to the user.
 */
@objc(QrScannerPlugin)
public class QrScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "QrScannerPlugin"
    public let jsName = "QrScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
    ]

    /** The presented sheet, if any; also keeps a second scan from stacking. */
    private var scanner: QrScannerViewController?

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": AVCaptureDevice.default(for: .video) != nil])
    }

    @objc func scan(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard AVCaptureDevice.default(for: .video) != nil else {
                call.reject("This device has no camera to scan with")
                return
            }
            guard self.scanner == nil else {
                call.reject("The scanner is already open")
                return
            }
            guard let presenter = self.bridge?.viewController else {
                call.reject("No view controller to present from")
                return
            }

            let controller = QrScannerViewController()
            controller.onFinish = { [weak self] result in
                self?.scanner = nil
                switch result {
                case .success(let payload):
                    call.resolve(["value": payload])
                case .failure(let error):
                    call.reject(error.localizedDescription)
                }
            }
            controller.modalPresentationStyle = .fullScreen
            self.scanner = controller
            presenter.present(controller, animated: true)
        }
    }
}

/** Full-screen QR capture sheet. Owns the session, the overlay and the result. */
final class QrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    /// Called exactly once, on the main thread, before the sheet is dismissed.
    var onFinish: ((Result<String, Error>) -> Void)?

    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "org.radiant.wallet.qr")
    private var preview: AVCaptureVideoPreviewLayer?
    private var device: AVCaptureDevice?
    private var torchOn = false

    private let hintLabel = UILabel()
    private let cancelButton = UIButton(type: .system)
    private let torchButton = UIButton(type: .system)
    private let frameLayer = CAShapeLayer()

    private struct ScanCancelled: LocalizedError {
        var errorDescription: String? { "Scan cancelled" }
    }

    private struct ScanFailure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureOverlay()
        startCamera()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        stopSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
        // Square guide in the middle of the screen; decoding itself is not
        // restricted to it, so a code that is partly outside still scans.
        let side = min(view.bounds.width, view.bounds.height) * 0.64
        let rect = CGRect(
            x: (view.bounds.width - side) / 2,
            y: (view.bounds.height - side) / 2,
            width: side,
            height: side
        )
        frameLayer.path = UIBezierPath(roundedRect: rect, cornerRadius: 16).cgPath
    }

    // MARK: - Camera

    private func startCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configureSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if granted {
                        self.configureSession()
                    } else {
                        self.finish(.failure(ScanFailure(
                            message: "Camera access is off. Turn it on in Settings → Radiant Wallet."
                        )))
                    }
                }
            }
        default:
            finish(.failure(ScanFailure(
                message: "Camera access is off. Turn it on in Settings → Radiant Wallet."
            )))
        }
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video) else {
            finish(.failure(ScanFailure(message: "This device has no camera to scan with")))
            return
        }
        self.device = device

        do {
            let input = try AVCaptureDeviceInput(device: device)
            let output = AVCaptureMetadataOutput()

            session.beginConfiguration()
            session.sessionPreset = .high
            if session.canAddInput(input) { session.addInput(input) }
            guard session.canAddOutput(output) else {
                session.commitConfiguration()
                finish(.failure(ScanFailure(message: "The camera could not be prepared for scanning")))
                return
            }
            session.addOutput(output)
            session.commitConfiguration()

            guard output.availableMetadataObjectTypes.contains(.qr) else {
                finish(.failure(ScanFailure(message: "This camera cannot read QR codes")))
                return
            }
            output.setMetadataObjectsDelegate(self, queue: .main)
            output.metadataObjectTypes = [.qr]

            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            layer.frame = view.bounds
            view.layer.insertSublayer(layer, at: 0)
            preview = layer

            torchButton.isHidden = !device.hasTorch
            sessionQueue.async { [session] in
                if !session.isRunning { session.startRunning() }
            }
        } catch {
            finish(.failure(error))
        }
    }

    private func stopSession() {
        sessionQueue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    // MARK: - Overlay

    private func configureOverlay() {
        frameLayer.fillColor = UIColor.clear.cgColor
        frameLayer.strokeColor = UIColor(white: 1, alpha: 0.85).cgColor
        frameLayer.lineWidth = 3
        view.layer.addSublayer(frameLayer)

        hintLabel.text = "Point at a payment QR code"
        hintLabel.textColor = .white
        hintLabel.font = .systemFont(ofSize: 15, weight: .medium)
        hintLabel.textAlignment = .center
        hintLabel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(hintLabel)

        cancelButton.setTitle("Cancel", for: .normal)
        cancelButton.setTitleColor(.white, for: .normal)
        cancelButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(cancelButton)

        torchButton.setTitle("Torch", for: .normal)
        torchButton.setTitleColor(.white, for: .normal)
        torchButton.titleLabel?.font = .systemFont(ofSize: 15, weight: .medium)
        torchButton.addTarget(self, action: #selector(torchTapped), for: .touchUpInside)
        torchButton.translatesAutoresizingMaskIntoConstraints = false
        torchButton.isHidden = true
        view.addSubview(torchButton)

        NSLayoutConstraint.activate([
            hintLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            hintLabel.topAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 30),
            cancelButton.leadingAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 20),
            cancelButton.topAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 20),
            torchButton.trailingAnchor.constraint(
                equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -20),
            torchButton.centerYAnchor.constraint(equalTo: cancelButton.centerYAnchor),
        ])
    }

    // MARK: - Result

    /**
     * Delivers the result exactly once. Clearing `onFinish` before dismissing
     * makes a late decode, a second tap or a duplicate delegate call a no-op.
     */
    private func finish(_ result: Result<String, Error>) {
        guard let callback = onFinish else { return }
        onFinish = nil
        stopSession()

        if presentingViewController != nil {
            dismiss(animated: true) { callback(result) }
        } else {
            callback(result)
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard onFinish != nil else { return }
        for object in metadataObjects {
            guard
                let code = object as? AVMetadataMachineReadableCodeObject,
                code.type == .qr,
                let value = code.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                !value.isEmpty
            else { continue }
            finish(.success(value))
            return
        }
    }

    // MARK: - Actions

    @objc private func cancelTapped() {
        finish(.failure(ScanCancelled()))
    }

    @objc private func torchTapped() {
        guard let device, device.hasTorch, device.isTorchAvailable else { return }
        do {
            try device.lockForConfiguration()
            torchOn.toggle()
            device.torchMode = torchOn ? .on : .off
            device.unlockForConfiguration()
            torchButton.setTitle(torchOn ? "Torch off" : "Torch", for: .normal)
        } catch {
            /* the torch is a convenience; scanning works without it */
        }
    }
}

