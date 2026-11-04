// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RxdBiometricVault",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "RxdBiometricVault",
            targets: ["RxdBiometricVault"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.0")
    ],
    targets: [
        .target(
            name: "RxdBiometricVault",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm")
            ],
            path: "src"
        )
    ]
)
