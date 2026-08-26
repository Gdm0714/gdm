import Foundation
import XCTest
@testable import GDMNative

final class VerificationPlanFingerprintTests: XCTestCase {
    func testCanonicalFingerprintMatchesSharedCLIFixture() throws {
        let fixture = try loadFixture()

        XCTAssertEqual(fixture.schemaVersion, 1)
        XCTAssertEqual(fixture.work.verificationPlanFingerprint, fixture.sha256)
    }

    func testOmittedDefaultsMatchTheirExplicitCanonicalValues() throws {
        let fixture = try loadFixture()
        let work = fixture.work
        let explicitChecks = work.checks.map { check in
            CheckRecord(
                id: check.id,
                desc: check.desc,
                cmd: check.cmd,
                expect: check.expect,
                manual: check.manual,
                kind: check.kind ?? (check.manual ? "manual" : "behavior"),
                expert: check.expert ?? false,
                status: check.status,
                redEvidence: check.redEvidence,
                evidence: check.evidence
            )
        }
        let explicitContract = WorkContractRecord(
            required: work.contract.required,
            forbidden: work.contract.forbidden,
            commit: work.contract.commit ?? "forbidden",
            assumptions: work.contract.assumptions ?? [],
            uncertainties: work.contract.uncertainties ?? [],
            allowedPaths: work.contract.allowedPaths ?? ["."],
            forbiddenPaths: work.contract.forbiddenPaths ?? [],
            stopConditions: work.contract.stopConditions ?? [],
            risk: work.contract.risk ?? "low",
            verification: work.contract.verification ?? "deterministic",
            simplificationRequired: work.contract.simplificationRequired ?? false
        )
        let explicit = WorkDocument(
            slug: work.slug,
            brief: work.brief,
            createdAt: work.createdAt,
            done: work.done,
            doneAt: work.doneAt,
            auditRequired: work.auditRequired ?? false,
            audit: work.audit,
            delivery: work.delivery,
            checks: explicitChecks,
            contract: explicitContract,
            verificationPlanSourceFingerprint: work.verificationPlanSourceFingerprint
        )

        XCTAssertEqual(explicit.verificationPlanFingerprint, fixture.sha256)
    }

    func testSourceFingerprintAndRuntimeEvidenceAreExcluded() throws {
        let fixture = try loadFixture()
        var changed = fixture.work
        changed.verificationPlanSourceFingerprint = String(repeating: "f", count: 64)
        changed = WorkDocument(
            slug: changed.slug,
            brief: changed.brief,
            createdAt: changed.createdAt,
            done: true,
            doneAt: "2026-08-12T00:00:00.000Z",
            auditRequired: changed.auditRequired,
            audit: changed.audit,
            delivery: changed.delivery,
            checks: changed.checks.map { check in
                CheckRecord(
                    id: check.id,
                    desc: check.desc,
                    cmd: check.cmd,
                    expect: check.expect,
                    manual: check.manual,
                    kind: check.kind,
                    expert: check.expert,
                    status: "proven",
                    redEvidence: check.redEvidence,
                    evidence: EvidenceRecord(
                        observed: ".gdm/fixture/out/\(check.id).txt",
                        sha256: String(repeating: "a", count: 64),
                        exitCode: check.manual ? nil : 0,
                        manual: check.manual,
                        note: check.manual ? "reviewed" : nil,
                        reviewer: check.manual ? "human" : nil,
                        at: "2026-08-12T00:00:00.000Z"
                    )
                )
            },
            contract: changed.contract,
            verificationPlanSourceFingerprint: changed.verificationPlanSourceFingerprint
        )

        XCTAssertEqual(changed.verificationPlanFingerprint, fixture.sha256)
    }

    func testContractDefinitionChangeChangesFingerprint() throws {
        let fixture = try loadFixture()
        let work = fixture.work
        let changedContract = WorkContractRecord(
            required: work.contract.required,
            forbidden: work.contract.forbidden,
            commit: work.contract.commit,
            assumptions: (work.contract.assumptions ?? []) + ["새 가정"],
            uncertainties: work.contract.uncertainties,
            allowedPaths: work.contract.allowedPaths,
            forbiddenPaths: work.contract.forbiddenPaths,
            stopConditions: work.contract.stopConditions,
            risk: work.contract.risk,
            verification: work.contract.verification,
            simplificationRequired: work.contract.simplificationRequired
        )
        let changed = WorkDocument(
            slug: work.slug,
            brief: work.brief,
            createdAt: work.createdAt,
            done: work.done,
            doneAt: work.doneAt,
            auditRequired: work.auditRequired,
            audit: work.audit,
            delivery: work.delivery,
            checks: work.checks,
            contract: changedContract,
            verificationPlanSourceFingerprint: work.verificationPlanSourceFingerprint
        )

        XCTAssertNotEqual(changed.verificationPlanFingerprint, fixture.sha256)
    }

    private func loadFixture() throws -> VerificationPlanFingerprintFixture {
        var repositoryURL = URL(fileURLWithPath: #filePath, isDirectory: false)
        for _ in 0..<4 { repositoryURL.deleteLastPathComponent() }
        let fixtureURL = repositoryURL
            .appendingPathComponent("fixtures", isDirectory: true)
            .appendingPathComponent("verification-plan-fingerprint-v1.json", isDirectory: false)
        return try JSONDecoder().decode(
            VerificationPlanFingerprintFixture.self,
            from: Data(contentsOf: fixtureURL)
        )
    }
}

private struct VerificationPlanFingerprintFixture: Decodable {
    let schemaVersion: Int
    let work: WorkDocument
    let sha256: String
}
