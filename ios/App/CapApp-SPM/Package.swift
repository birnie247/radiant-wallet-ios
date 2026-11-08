// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.0"),
        .package(name: "RxdBiometricVault", path: "../../../plugins/biometric-vault"),
        .package(name: "RxdQrScanner", path: "../../../plugins/qr-scanner"),
        .package(name: "RxdScreenSecurity", path: "../../../plugins/screen-security")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "RxdBiometricVault", package: "RxdBiometricVault"),
                .product(name: "RxdQrScanner", package: "RxdQrScanner"),
                .product(name: "RxdScreenSecurity", package: "RxdScreenSecurity")
            ]
        )
    ]
)
