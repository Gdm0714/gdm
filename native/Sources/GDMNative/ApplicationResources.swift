import Foundation

enum GidemApplicationResources {
    private static let resourceBundleName = "GDMNative_GDMNative.bundle"

    static let bundle: Bundle = {
        // A signed macOS app must keep resource bundles in Contents/Resources.
        // SwiftPM command-line builds place the same bundle beside the binary.
        let candidates = [
            Bundle.main.resourceURL?.appendingPathComponent(resourceBundleName),
            Bundle.main.bundleURL.appendingPathComponent(resourceBundleName)
        ].compactMap { $0 }
        for candidate in candidates {
            if let bundle = Bundle(url: candidate) { return bundle }
        }

        #if SWIFT_PACKAGE
        // This fallback preserves tests and `swift run`; packaged apps return
        // above before SwiftPM's build-machine path is consulted.
        return Bundle.module
        #else
        return Bundle.main
        #endif
    }()
}
