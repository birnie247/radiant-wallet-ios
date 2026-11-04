// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "RxdScreenSecurity",
    platforms: [.iOS(.v15)],
    products: [
        .library(
            name: "RxdScreenSecurity",
            targets: ["RxdScreenSecurity"]),
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.6.0")
    ],
    targets: [
        .target(
            name: "RxdScreenSecurity",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm")
            ],
            path: "src"
        )
    ]
)
