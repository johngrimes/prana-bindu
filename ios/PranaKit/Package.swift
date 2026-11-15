// swift-tools-version: 6.2
// Author: John Grimes

import PackageDescription

let package = Package(
    name: "PranaKit",
    platforms: [.iOS(.v26), .macOS(.v26), .watchOS(.v26)],
    products: [
        .library(name: "PranaKit", targets: ["PranaKit"])
    ],
    targets: [
        .target(name: "PranaKit"),
        .testTarget(name: "PranaKitTests", dependencies: ["PranaKit"], resources: [.copy("Fixtures")]),
    ]
)
