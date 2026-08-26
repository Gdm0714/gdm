import XCTest
@testable import GDMNative

@MainActor
final class BrandIdentityTests: XCTestCase {
    func testBundledBrandAssetsLoadAtRuntime() {
        XCTAssertEqual(GidemBrandAssets.productName, "Gidem")
        XCTAssertEqual(GidemBrandAssets.canonicalArcPath, "M50 19.4A22 22 0 1 0 54 32")
        XCTAssertNotNil(GidemBrandAssets.toolbarSymbolImage)
        XCTAssertNotNil(GidemBrandAssets.applicationIconImage)
    }

    func testToolbarUsesTheSmallSizeMaster() throws {
        let image = try XCTUnwrap(GidemBrandAssets.toolbarSymbolImage)
        XCTAssertEqual(image.size.width, 16, accuracy: 0.01)
        XCTAssertEqual(image.size.height, 16, accuracy: 0.01)
        XCTAssertTrue(image.isTemplate)
    }

    func testApplicationIconRemainsFullColor() throws {
        let image = try XCTUnwrap(GidemBrandAssets.applicationIconImage)
        XCTAssertEqual(image.size.width, 1024, accuracy: 0.01)
        XCTAssertEqual(image.size.height, 1024, accuracy: 0.01)
        XCTAssertFalse(image.isTemplate)
    }
}
