// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "GDMNative",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "gdm-native", targets: ["GDMNative"])
    ],
    dependencies: [
        .package(
            url: "https://github.com/migueldeicaza/SwiftTerm.git",
            revision: "dd2fb8ac5b861e7bf617c872895e338f38165648"
        )
    ],
    targets: [
        .executableTarget(
            name: "GDMNative",
            dependencies: [
                .product(name: "SwiftTerm", package: "SwiftTerm")
            ],
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "GDMNativeTests",
            dependencies: ["GDMNative"]
        )
    ]
)
