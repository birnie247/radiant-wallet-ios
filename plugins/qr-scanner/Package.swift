// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RxdQrScanner",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "RxdQrScanner",
            targets: ["RxdQrScanner"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.0")
    ],
    targets: [
        .target(
            name: "RxdQrScanner",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm")
            ],
            path: "src"
        )
    ]
)
