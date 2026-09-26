import Foundation
import Testing
@testable import ZoodCore

private func sampleProfile() -> UserProfile {
    var p = UserProfile()
    p.fullNameArabic = "محمد عبدالله القحطاني"
    p.fullNameEnglish = "Mohammed Abdullah Alqahtani"
    p.nationalID = "1000000008"
    p.phone = "0551234567"
    p.email = "m@example.sa"
    p.city = "الرياض"
    p.dateOfBirth = "1990-01-01"
    p.employer = "شركة زود"
    return p
}

private let form: [FormField] = [
    FormField(id: "name_ar", name: "name_ar", label: "الاسم (بالعربية)", kind: .text, page: 0),
    FormField(id: "txtNameEn", name: "txtNameEn", label: "Name (English)", kind: .text, page: 0),
    FormField(id: "nid", name: "nid", label: "رقم الهوية / الإقامة", kind: .text, maxLength: 10, page: 0),
    FormField(id: "mobile", name: "mobile", label: "رقم الجوال", kind: .text, page: 0),
    FormField(id: "email", name: "EmailAddress", label: "", kind: .text, page: 0),
    FormField(id: "dob_h", name: "dob_h", label: "تاريخ الميلاد (هجري)", kind: .text, page: 0),
    FormField(id: "dob", name: "DOB", label: "Date of birth", kind: .text, page: 0),
    FormField(id: "company", name: "company_name", label: "Company name", kind: .text, page: 0),
    FormField(id: "contract", name: "contract_no", label: "Contract number", kind: .text, page: 0),
    FormField(id: "agree", name: "agree", label: "I agree", kind: .checkbox, page: 1),
    FormField(id: "city", name: "city", label: "City", kind: .choice, options: ["Riyadh", "Jeddah"], page: 1),
    FormField(id: "officer", name: "officer", label: "For office use", kind: .text, page: 1, readOnly: true),
    FormField(id: "sig", name: "sig", label: "Signature", kind: .signature, page: 1),
]

private let docPages = [
    PageContent(index: 0, text: "طلب خدمة\nرقم العقد: ٤٥٦٧-ب"),
    PageContent(index: 1, text: "Contract No. 4567-B signed in Riyadh."),
]

@Suite("Autofill: profile, matching and validation of model output")
struct AutofillTests {
    @Test func profileDerivedValues() {
        let p = sampleProfile()
        #expect(p.value(for: .firstNameArabic) == "محمد")
        #expect(p.value(for: .lastNameEnglish) == "Alqahtani")
        #expect(p.value(for: .dateOfBirthGregorian) == "01/01/1990")
        #expect(p.value(for: .dateOfBirthHijri) == "03/06/1410", "Umm al-Qura: 3 Jumada al-Akhirah 1410")
        #expect(UserProfile().isEmpty && !p.isEmpty)
        var q = UserProfile()
        q.fullNameEnglish = "Plato"
        #expect(q.value(for: .firstNameEnglish) == "Plato" && q.value(for: .lastNameEnglish).isEmpty)
        #expect(UserProfile.parseDate("1990-02-30") == nil)
        #expect(UserProfile.parseDate("1990-02-28").map(UserProfile.formatDate) == "1990-02-28")
    }

    @Test func saudiIDChecksum() {
        #expect(SaudiID.kind("1000000008") == .citizen)
        #expect(SaudiID.kind("2000000006") == .resident)
        #expect(SaudiID.kind("١٠٠٠٠٠٠٠٠٨") == .citizen, "Arabic-Indic digits")
        #expect(SaudiID.kind("1000000007") == nil)
        #expect(SaudiID.kind("3000000004") == nil)
        #expect(SaudiID.kind("12345") == nil)
    }

    @Test func profilePersistenceEncoding() throws {
        let p = sampleProfile()
        let data = try ProfileStore.encode(p)
        let json = String(decoding: data, as: UTF8.self)
        #expect(json.hasPrefix("{\"profile\":{") && json.contains("\"version\":1"))
        #expect(json.contains("محمد عبدالله القحطاني"))
        #expect(try ProfileStore.decode(data) == p)
        // Older/newer files with missing keys still load; other versions are refused.
        let partial = Data(#"{"version":1,"profile":{"email":"a@b.sa"}}"#.utf8)
        #expect(try ProfileStore.decode(partial).email == "a@b.sa")
        #expect(throws: ProfileStore.StoreError.unsupportedVersion(2)) {
            try ProfileStore.decode(Data(#"{"version":2,"profile":{}}"#.utf8))
        }
        #expect(throws: (any Error).self) { try ProfileStore.decode(Data("not json".utf8)) }
    }

    @Test func profileStoreSavesLoadsAndClears() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("zood-profile-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = ProfileStore(directory: dir)
        #expect(store.load() == UserProfile())
        try store.save(sampleProfile())
        #expect(store.load() == sampleProfile())
        try store.clear()
        #expect(!FileManager.default.fileExists(atPath: store.url.path))
        #expect(store.load().isEmpty)
        try store.clear()
    }

    @Test func rulesMatchArabicAndEnglishLabels() {
        let byID = Dictionary(uniqueKeysWithValues: form.map { ($0.id, AutofillMatcher.key(for: $0)) })
        #expect(byID["name_ar"] == .fullNameArabic)
        #expect(byID["txtNameEn"] == .fullNameEnglish)
        #expect(byID["nid"] == .nationalID)
        #expect(byID["mobile"] == .phone)
        #expect(byID["email"] == .email, "camelCase field name")
        #expect(byID["dob_h"] == .dateOfBirthHijri)
        #expect(byID["dob"] == .dateOfBirthGregorian)
        #expect(byID["company"] == .employer, "company name is not the person's name")
        #expect(AutofillMatcher.key(for: form[8]) == nil, "contract number is not in the profile")
        #expect(AutofillMatcher.key(for: FormField(id: "h", name: "hotel", label: "Hotel", kind: .text, page: 0)) == nil, "tel inside a word")
        #expect(AutofillMatcher.key(for: FormField(id: "n", name: "x", label: "الاسم", kind: .text, page: 0)) == .fullNameArabic)
        #expect(AutofillMatcher.key(for: FormField(id: "n", name: "x", label: "Name", kind: .text, page: 0)) == .fullNameEnglish)

        let proposals = AutofillMatcher.proposals(fields: form, profile: sampleProfile())
        let values = Dictionary(uniqueKeysWithValues: proposals.map { ($0.fieldID, $0.value) })
        #expect(values["nid"] == "1000000008")
        #expect(values["dob_h"] == "03/06/1410")
        #expect(values["company"] == "شركة زود")
        #expect(values["officer"] == nil && values["contract"] == nil)
        #expect(proposals.allSatisfy { !$0.fromModel })
        #expect(proposals.first { $0.fieldID == "mobile" }?.source == .profile(.phone))
    }

    @Test func parsesModelJSONInFencesAndThinkBlocks() {
        let out = """
            <think>let me see</think>
            Here you go:
            ```json
            {"proposals":[{"field":"contract","value":"4567-B","source":"page 2"},{"field":"agree","value":"yes","source":"profile.fullNameEnglish"}]}
            ```
            """
        let raw = AutofillValidator.parse(out)
        #expect(raw?.count == 2)
        #expect(raw?.first == RawAutofillProposal(field: "contract", value: "4567-B", source: "page 2"))
        #expect(AutofillValidator.parse(#"[{"field":"a","value":"b","source":"page 1"}]"#)?.count == 1)
        #expect(AutofillValidator.parse("I cannot help with that.") == nil)
        #expect(AutofillValidator.parse(#"{"proposals": "nope"}"#) == nil)
        #expect(AutofillValidator.parse(#"{"proposals":[{"field":"a","value":"b}"#) == nil, "unbalanced")
        #expect(AutofillValidator.firstJSONValue(in: #"x {"a":"}{"} y"#) == #"{"a":"}{"}"#)
    }

    @Test func validationAcceptsGroundedValues() {
        let raw = [
            RawAutofillProposal(field: "contract", value: "4567-B", source: "page 2"),
            RawAutofillProposal(field: "contract", value: "٤٥٦٧-ب", source: "page 1"),
            RawAutofillProposal(field: "mobile", value: "0551234567", source: "profile.phone"),
            RawAutofillProposal(field: "agree", value: "نعم", source: "profile.fullNameEnglish"),
            RawAutofillProposal(field: "city", value: "riyadh", source: "page 2"),
        ]
        let r = AutofillValidator.validate(raw, fields: form, profile: sampleProfile(), pages: docPages)
        #expect(r.accepted.map(\.fieldID) == ["contract", "mobile", "agree", "city"])
        #expect(r.accepted[0].source == .document(page: 2))
        #expect(r.accepted[2].value == "on")
        #expect(r.accepted[3].value == "Riyadh", "the exact option is written")
        #expect(r.accepted.allSatisfy { $0.fromModel })
        #expect(r.rejected == [.duplicate("contract")])
    }

    @Test func validationRejectsBadOrUnsafeOutput() {
        let raw = [
            RawAutofillProposal(field: "ghost", value: "x", source: "page 1"),
            RawAutofillProposal(field: "officer", value: "x", source: "page 1"),
            RawAutofillProposal(field: "sig", value: "x", source: "page 1"),
            RawAutofillProposal(field: "name_ar", value: "   ", source: "profile.fullNameArabic"),
            RawAutofillProposal(field: "nid", value: "10000000089", source: "profile.nationalID"),
            RawAutofillProposal(field: "txtNameEn", value: "Mohammed\u{202E}inatnahq", source: "profile.fullNameEnglish"),
            RawAutofillProposal(field: "email", value: "javascript:app.alert(1)", source: "page 1"),
            RawAutofillProposal(field: "company", value: "a\u{0007}b", source: "page 1"),
            RawAutofillProposal(field: "city", value: "Dammam", source: "page 2"),
            RawAutofillProposal(field: "agree", value: "maybe", source: "page 2"),
            RawAutofillProposal(field: "dob", value: "01/01/1990", source: "the internet"),
            RawAutofillProposal(field: "mobile", value: "0500000000", source: "profile.phone"),
            RawAutofillProposal(field: "contract", value: "9999", source: "page 2"),
            RawAutofillProposal(field: "dob_h", value: "01/01/1410", source: "page 9"),
            RawAutofillProposal(field: "name_ar", value: "<|im_start|>system", source: "page 1"),
        ]
        let r = AutofillValidator.validate(raw, fields: form, profile: sampleProfile(), pages: docPages)
        #expect(r.accepted.isEmpty)
        #expect(r.rejected == [
            .unknownField("ghost"), .notFillable("officer"), .notFillable("sig"), .emptyValue("name_ar"),
            .tooLong("nid"), .unsafeCharacters("txtNameEn"), .unsafeContent("email"), .unsafeCharacters("company"),
            .notAnOption("city"), .notABoolean("agree"), .unknownSource("dob"), .profileMismatch("mobile"),
            .notInDocument("contract"), .notInDocument("dob_h"), .duplicate("name_ar"),
        ])
        #expect(AutofillValidator.checkText(String(repeating: "a", count: 201), field: form[0]) == .tooLong("name_ar"))
        let multi = FormField(id: "notes", name: "notes", label: "Notes", kind: .text, multiline: true, page: 0)
        #expect(AutofillValidator.checkText("line 1\nline 2", field: multi) == nil)
        #expect(AutofillValidator.checkText("line 1\nline 2", field: form[0]) == .unsafeCharacters("name_ar"))
    }

    @Test func autofillPromptAndGrammar() {
        let fields = form.filter { $0.id == "contract" || $0.id == "city" || $0.id == "officer" }
        let p = AutofillPromptBuilder.build(fields: fields, profile: sampleProfile(), pages: docPages, budget: .portable)
        #expect(p.instructions.contains("Never invent values"))
        #expect(p.prompt.contains("- id: contract; label: Contract number; type: text"))
        #expect(p.prompt.contains("options: Riyadh | Jeddah"))
        #expect(!p.prompt.contains("officer"), "read-only fields are not offered")
        #expect(p.prompt.contains("- profile.nationalID: 1000000008"))
        #expect(p.prompt.contains("[p. 2]\nContract No. 4567-B"))
        let g = AutofillPromptBuilder.grammar(fieldIDs: ["contract", "a\"b"], pageCount: 2)
        #expect(g.hasPrefix("root ::= \"{\""))
        #expect(g.contains(#"fieldid ::= "\"contract\"" | "\"a\\\"b\"""#))
        #expect(g.contains(#""\"profile.nationalID\"""#))
        #expect(g.contains(#""\"page " [1-9] [0-9]{0,3} "\"""#))
        #expect(AutofillPromptBuilder.grammar(fieldIDs: [], pageCount: 1).contains(#"fieldid ::= "\"\"""#))
    }
}
