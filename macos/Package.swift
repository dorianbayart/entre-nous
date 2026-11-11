// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "EntreNous",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "EntreNous",
            path: "Sources/EntreNous",
            linkerSettings: [.linkedFramework("AppKit"), .linkedFramework("WebKit"), .linkedFramework("Security")]
        ),
    ]
)
