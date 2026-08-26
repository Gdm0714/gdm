// swift-tools-version: 6.0

import Foundation
import PackageDescription

let ghosttyCommit = "bb876a0d286b661089b7f40dd3a6488d629beffe"
let ghosttyArtifact = ".build/ghostty/artifacts/\(ghosttyCommit)/native/GhosttyKit.xcframework"
let ghosttyEnabled = ProcessInfo.processInfo.environment["GIDEM_ENABLE_GHOSTTY"] == "1"

var executableDependencies: [Target.Dependency] = [
    .product(name: "SwiftTerm", package: "SwiftTerm")
]
var executableLinkerSettings: [LinkerSetting] = []
var packageTargets: [Target] = []

if ghosttyEnabled {
    executableDependencies.append(.target(name: "GhosttyKit"))
    executableLinkerSettings.append(.linkedLibrary("c++"))
    packageTargets.append(.binaryTarget(name: "GhosttyKit", path: ghosttyArtifact))
}

packageTargets.append(
    .executableTarget(
        name: "GDMNative",
        dependencies: executableDependencies,
        resources: [.process("Resources")],
        linkerSettings: executableLinkerSettings
    )
)
packageTargets.append(
    .testTarget(
        name: "GDMNativeTests",
        dependencies: ["GDMNative"]
    )
)

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
    targets: packageTargets
)
