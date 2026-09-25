import Foundation
import Testing
@testable import ZoodEngine

/// Runs the real Rust engine (libwarraq_core.a, feature "ffi") through the C ABI.
@Suite("WarraqEngine over the C ABI")
struct WarraqEngineTests {
    let pdf = SamplePDF.make(pages: 3)

    @Test func opensAndReportsInfo() async throws {
        let engine = try WarraqEngine(data: pdf)
        let info = try await engine.info()
        #expect(info.pageCount == 3)
        #expect(info.pages.count == 3)
        #expect(info.pages[0].width == 612)
        #expect(info.encrypted == false)
        #expect(info.revisions == 1)
        #expect(info.permissions.print)
    }

    @Test func garbageIsAParseErrorNotACrash() {
        #expect(throws: WarraqError.self) { try WarraqEngine(data: Data("not a pdf".utf8)) }
        do {
            _ = try WarraqEngine(data: Data("not a pdf".utf8))
        } catch {
            #expect(error.code == "parse_error")
        }
        #expect(throws: WarraqError.self) { try WarraqEngine(data: Data()) }
    }

    @Test func rotateIsAnIncrementalUpdate() async throws {
        let engine = try WarraqEngine(data: pdf)
        let out = try await engine.rotate(pages: [1], degrees: 90)
        #expect(out.bytes.count > pdf.count)
        #expect(out.bytes.prefix(pdf.count) == pdf, "original bytes must stay untouched")
        #expect(out.info.pageCount == 3)
        #expect(out.info.revisions == 2)
        let reopened = try WarraqEngine(data: out.bytes)
        #expect(try await reopened.info().pages[1].rotation == 90)
    }

    @Test func organizeDeleteInsertMoveExtract() async throws {
        let engine = try WarraqEngine(data: pdf)
        #expect(try await engine.delete(pages: [0]).info.pageCount == 2)
        #expect(try await engine.insertBlank(at: 0, count: 2).info.pageCount == 4)
        #expect(try await engine.reorder([3, 2, 1, 0]).info.pageCount == 4)
        #expect(try await engine.move(pages: [0], to: 3).info.pageCount == 4)
        let other = SamplePDF.make(pages: 2)
        let ins = try await engine.insert(from: other, at: 1)
        #expect(ins.info.pageCount == 6)
        #expect(ins.info.inserted == 2)
        let extracted = try await engine.extract(pages: [0, 5])
        #expect(try await WarraqEngine(data: extracted).info().pageCount == 2)
        #expect(try await engine.info().pageCount == 6, "extract leaves the document unchanged")
    }

    @Test func badParamsAndUnknownMethodsAreErrors() async throws {
        let engine = try WarraqEngine(data: pdf)
        await #expect(throws: WarraqError.self) { try await engine.delete(pages: [99]) }
        do {
            _ = try await engine.call("nope")
            Issue.record("unknown method must fail")
        } catch {
            #expect(error.code == "unknown_method")
        }
        do {
            _ = try await engine.call("pages.rotate", json: "{not json")
            Issue.record("bad JSON must fail")
        } catch {
            #expect(error.code == "invalid_params")
        }
    }

    @Test func rebaseKeepsTheOriginalBytes() async throws {
        // A whole-file rewrite with one change (what PDFKit's dataRepresentation produces).
        let writer = try WarraqEngine(data: pdf)
        _ = try await writer.rotate(pages: [0], degrees: 180)
        let whole = try await writer.call("doc.saveFull").blob0()

        let engine = try WarraqEngine(data: pdf)
        let unchanged = try await engine.rebase(edited: pdf)
        #expect(unchanged.info.mode == .unchanged)

        let r = try await engine.rebase(edited: whole)
        #expect(r.info.mode == .incremental)
        #expect(!r.info.changed.isEmpty)
        #expect(r.bytes.prefix(pdf.count) == pdf)
        #expect(try await WarraqEngine(data: r.bytes).info().pages[0].rotation == 180)
    }

    @Test func protectAndReopenWithPassword() async throws {
        let engine = try WarraqEngine(data: pdf)
        var perms = Permissions()
        perms.copy = false
        let locked = try await engine.protect(userPassword: "سر123", ownerPassword: "owner", permissions: perms)
        let check = try WarraqEngine.isEncrypted(locked)
        #expect(check.encrypted && check.needsPassword)
        do {
            _ = try WarraqEngine(data: locked)
            Issue.record("must need a password")
        } catch {
            #expect(error.code == "password_required")
        }
        #expect(throws: WarraqError.self) { try WarraqEngine(data: locked, password: "wrong") }
        let asUser = try WarraqEngine(data: locked, password: "سر123")
        let info = try await asUser.info()
        #expect(info.encrypted)
        #expect(info.encryption?.method == "AES-256")
        #expect(info.permissions.copy == false)
        let asOwner = try WarraqEngine(data: locked, password: "owner")
        let open = try await asOwner.removeProtection()
        #expect(try WarraqEngine.isEncrypted(open).encrypted == false)
    }

    @Test func mergeIsStatic() throws {
        let (count, bytes) = try WarraqEngine.merge([pdf, SamplePDF.make(pages: 2)])
        #expect(count == 5)
        #expect(bytes.starts(with: Data("%PDF-".utf8)))
        #expect(throws: WarraqError.self) { try WarraqEngine.merge([pdf]) }
    }

    @Test func methodListing() throws {
        let m = try WarraqEngine.methods()
        #expect(m.document.contains("doc.rebase"))
        #expect(m.document.contains("protect.set"))
        #expect(m.static.contains("pdf.merge"))
        #expect(WarraqEngine.supports("pages.rotate"))
        #expect(!WarraqEngine.supports("no.such"))
    }

    @Test func metadataSetIsIncremental() async throws {
        let engine = try WarraqEngine(data: pdf)
        let out = try await engine.setMetadata(["Title": "تقرير الربع الثالث"])
        #expect(out.bytes.prefix(pdf.count) == pdf)
        #expect(try await WarraqEngine(data: out.bytes).info().title == "تقرير الربع الثالث")
    }

    @Test func documentsRunInParallel() async throws {
        let pdf = self.pdf
        let counts = try await withThrowingTaskGroup(of: Int.self) { group in
            for i in 0..<16 {
                group.addTask {
                    let e = try WarraqEngine(data: pdf)
                    let r = try await e.rotate(pages: [i % 3], degrees: 90)
                    return r.info.pageCount ?? 0
                }
            }
            return try await group.reduce(into: []) { $0.append($1) }
        }
        #expect(counts == Array(repeating: 3, count: 16))
    }

    @Test func plainTextComesFromTheEngineWhenAvailable() async throws {
        let engine = try WarraqEngine(data: pdf)
        // warraq-core registers warraq-text's `text.*` namespace.
        #expect(WarraqEngine.supports("text.plain"))
        let text = try #require(await engine.plainText())
        #expect(text.contains("Page 1") && text.contains("Page 3"), "\(text)")
        #expect(await engine.plainText(maxCharacters: 4) == "Page")
    }
}

@Suite("Header copy")
struct HeaderSyncTests {
    /// Sources/CWarraq/include/warraq.h must equal the engine's header.
    @Test func cwarraqHeaderMatchesEngineHeader() throws {
        let here = URL(fileURLWithPath: #filePath)
        let pkg = here.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let copy = pkg.appendingPathComponent("Sources/CWarraq/include/warraq.h")
        let engine = pkg.appendingPathComponent("../../../../packages/core/crates/warraq-core/include/warraq.h")
            .standardizedFileURL
        #expect(try Data(contentsOf: copy) == Data(contentsOf: engine))
    }
}
