import Foundation
import XCTest
@testable import GDMNative

final class GDMToolchainLocatorTests: XCTestCase {
    func testPackagedAppResolvesOnlyContentsHelpersGDM() throws {
        let fixture = try ToolchainLocatorFixture.make()
        defer { fixture.remove() }
        let helper = fixture.appBundleURL
            .appendingPathComponent("Contents/Helpers/gdm", isDirectory: false)
        let development = fixture.sourceRootURL
            .appendingPathComponent("cli/dist/gdm", isDirectory: false)
        try fixture.installExecutable(at: helper)
        try fixture.installExecutable(at: development)

        let invocation = try GDMToolchainLocator.resolve(
            bundleURL: fixture.appBundleURL,
            developmentSourceFileURL: fixture.locatorSourceFileURL
        ).get()

        XCTAssertEqual(
            invocation,
            CommandInvocation(executable: helper.standardizedFileURL.path, prefixArguments: [])
        )
    }

    func testPackagedAppDoesNotFallBackToDevelopmentExecutable() throws {
        let fixture = try ToolchainLocatorFixture.make()
        defer { fixture.remove() }
        let development = fixture.sourceRootURL
            .appendingPathComponent("cli/dist/gdm", isDirectory: false)
        try fixture.installExecutable(at: development)
        let expectedHelper = fixture.appBundleURL
            .appendingPathComponent("Contents/Helpers/gdm", isDirectory: false)
            .standardizedFileURL

        XCTAssertEqual(
            GDMToolchainLocator.resolve(
                bundleURL: fixture.appBundleURL,
                developmentSourceFileURL: fixture.locatorSourceFileURL
            ),
            .failure(.missing(mode: .packaged, path: expectedHelper.path))
        )
    }

    func testDevelopmentResolutionUsesOnlyLocatorSourceTree() throws {
        let fixture = try ToolchainLocatorFixture.make()
        defer { fixture.remove() }
        let expected = fixture.sourceRootURL
            .appendingPathComponent("cli/dist/gdm", isDirectory: false)
        let adversarialRepositoryGDM = fixture.rootURL
            .appendingPathComponent("selected-repository/cli/dist/gdm", isDirectory: false)
        try fixture.installExecutable(at: expected)
        try fixture.installExecutable(at: adversarialRepositoryGDM)

        let invocation = try GDMToolchainLocator.resolve(
            bundleURL: fixture.rootURL.appendingPathComponent("GDMNativeTests.xctest"),
            developmentSourceFileURL: fixture.locatorSourceFileURL
        ).get()

        XCTAssertEqual(invocation.executable, expected.standardizedFileURL.path)
        XCTAssertNotEqual(invocation.executable, adversarialRepositoryGDM.standardizedFileURL.path)
        XCTAssertTrue(invocation.prefixArguments.isEmpty)
    }

    func testDevelopmentResolutionDoesNotFallBackToRepositoryOrPATH() throws {
        let fixture = try ToolchainLocatorFixture.make()
        defer { fixture.remove() }
        let adversarialRepositoryGDM = fixture.rootURL
            .appendingPathComponent("selected-repository/cli/dist/gdm", isDirectory: false)
        let adversarialPATHGDM = fixture.rootURL
            .appendingPathComponent("path-bin/gdm", isDirectory: false)
        try fixture.installExecutable(at: adversarialRepositoryGDM)
        try fixture.installExecutable(at: adversarialPATHGDM)
        let expected = fixture.sourceRootURL
            .appendingPathComponent("cli/dist/gdm", isDirectory: false)
            .standardizedFileURL

        XCTAssertEqual(
            GDMToolchainLocator.resolve(
                bundleURL: fixture.rootURL.appendingPathComponent("GDMNativeTests.xctest"),
                developmentSourceFileURL: fixture.locatorSourceFileURL
            ),
            .failure(.missing(mode: .development, path: expected.path))
        )
    }

    func testRejectsSymlinkExecutable() throws {
        let fixture = try ToolchainLocatorFixture.make()
        defer { fixture.remove() }
        let target = fixture.rootURL.appendingPathComponent("actual-gdm", isDirectory: false)
        let helper = fixture.appBundleURL
            .appendingPathComponent("Contents/Helpers/gdm", isDirectory: false)
        try fixture.installExecutable(at: target)
        try FileManager.default.createDirectory(
            at: helper.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createSymbolicLink(
            atPath: helper.path,
            withDestinationPath: target.path
        )

        XCTAssertEqual(
            GDMToolchainLocator.resolve(
                bundleURL: fixture.appBundleURL,
                developmentSourceFileURL: fixture.locatorSourceFileURL
            ),
            .failure(.symbolicLink(mode: .packaged, path: helper.standardizedFileURL.path))
        )
    }

    func testDevelopmentResolutionRejectsSymlinkExecutable() throws {
        let fixture = try ToolchainLocatorFixture.make()
        defer { fixture.remove() }
        let target = fixture.rootURL.appendingPathComponent("actual-development-gdm", isDirectory: false)
        let development = fixture.sourceRootURL
            .appendingPathComponent("cli/dist/gdm", isDirectory: false)
        try fixture.installExecutable(at: target)
        try FileManager.default.createDirectory(
            at: development.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try FileManager.default.createSymbolicLink(
            atPath: development.path,
            withDestinationPath: target.path
        )

        XCTAssertEqual(
            GDMToolchainLocator.resolve(
                bundleURL: fixture.rootURL.appendingPathComponent("GDMNativeTests.xctest"),
                developmentSourceFileURL: fixture.locatorSourceFileURL
            ),
            .failure(.symbolicLink(mode: .development, path: development.standardizedFileURL.path))
        )
    }

    func testRejectsNonExecutableRegularFile() throws {
        let fixture = try ToolchainLocatorFixture.make()
        defer { fixture.remove() }
        let helper = fixture.appBundleURL
            .appendingPathComponent("Contents/Helpers/gdm", isDirectory: false)
        try fixture.installRegularFile(at: helper, permissions: 0o644)

        XCTAssertEqual(
            GDMToolchainLocator.resolve(
                bundleURL: fixture.appBundleURL,
                developmentSourceFileURL: fixture.locatorSourceFileURL
            ),
            .failure(.notExecutable(mode: .packaged, path: helper.standardizedFileURL.path))
        )
    }

    func testLiveSwiftPMResolutionUsesBuiltGDMSourceTreeCLI() throws {
        let invocation = try GDMToolchainLocator.require()

        XCTAssertTrue(invocation.executable.hasSuffix("/cli/dist/gdm"))
        XCTAssertTrue((invocation.executable as NSString).isAbsolutePath)
        XCTAssertTrue(invocation.prefixArguments.isEmpty)
    }
}

private struct ToolchainLocatorFixture {
    let rootURL: URL
    let sourceRootURL: URL
    let locatorSourceFileURL: URL
    let appBundleURL: URL

    static func make() throws -> ToolchainLocatorFixture {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("GDMToolchainLocatorTests-\(UUID().uuidString)", isDirectory: true)
        let sourceRoot = root.appendingPathComponent("source-root", isDirectory: true)
        let locatorSource = sourceRoot
            .appendingPathComponent("native/Sources/GDMNative/GDMToolchainLocator.swift", isDirectory: false)
        try FileManager.default.createDirectory(
            at: locatorSource.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("// locator fixture\n".utf8).write(to: locatorSource)
        return ToolchainLocatorFixture(
            rootURL: root,
            sourceRootURL: sourceRoot,
            locatorSourceFileURL: locatorSource,
            appBundleURL: root.appendingPathComponent("Gidem.app", isDirectory: true)
        )
    }

    func installExecutable(at url: URL) throws {
        try installRegularFile(at: url, permissions: 0o755)
    }

    func installRegularFile(at url: URL, permissions: Int) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: url)
        try FileManager.default.setAttributes(
            [.posixPermissions: permissions],
            ofItemAtPath: url.path
        )
    }

    func remove() {
        try? FileManager.default.removeItem(at: rootURL)
    }
}
