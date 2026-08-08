import AppKit
import SwiftUI

@MainActor
enum GidemBrandAssets {
    static let productName = "Gidem"
    static let canonicalArcPath = "M50 19.4A22 22 0 1 0 54 32"

    static let toolbarSymbolImage = image(named: "gidem-symbol-16", template: true)
    static let applicationIconImage = image(named: "gidem-icon-1024", template: false)

    private static func image(named name: String, template: Bool) -> NSImage? {
        guard let url = Bundle.module.url(forResource: name, withExtension: "svg"),
              let image = NSImage(contentsOf: url) else {
            return nil
        }
        image.isTemplate = template
        return image
    }
}

struct GidemBrandMark: View {
    var body: some View {
        Group {
            if let image = GidemBrandAssets.toolbarSymbolImage {
                Image(nsImage: image)
                    .resizable()
                    .interpolation(.high)
            } else {
                Text("G")
                    .font(.system(size: DesignTokens.bodySize, weight: .bold, design: .rounded))
                    .foregroundStyle(DesignTokens.textStrong)
            }
        }
        .aspectRatio(1, contentMode: .fit)
        .accessibilityHidden(true)
    }
}
