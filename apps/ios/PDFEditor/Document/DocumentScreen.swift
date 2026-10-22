import SwiftUI

/// What a document's screen has in hand — the tool that is open, the sheet
/// that is up, the reading voice, the AI conversation — kept apart from the
/// view so it outlives one copy of it.
///
/// Folding or unfolding iPhone Duo moves the window between its two screens
/// and changes its size class: the Library swaps its phone stack for its
/// split view (or back), and SwiftUI makes a new `DocumentView`. The new one
/// takes this object from the model, so the reading goes on, Edit PDF stays
/// open on its page and the AI keeps its answer. The view holds it; the
/// model only points at it (weakly), so a closed document is let go.
@MainActor @Observable
final class DocumentScreen {
    let search = DocumentSearch()
    let host = PDFViewHost()
    let thumbnails = PageThumbnailCache()
    var editor: AnnotationEditor?
    var edit: EditModel?
    var pagesModel: PagesModel?
    var editing = false
    var showingMarksSheet = false
    var pickingPicture = false
    var showingSearch = false
    var showingThumbnails = false
    var thumbnailsForMarkup = false
    var readerMode = false
    var markup = false
    var showingInfo = false
    var showingOutline = false
    var showingGoTo = false
    var showingPages = false
    var showingExport = false
    var showingProtect = false
    var showingCompare = false
    var showingSignatures = false
    var showingMarks = false
    var showingStamps = false
    var showingSignature = false
    var showingCrop = false
    var placingSignature: UIImage?
    var saveError: String?
    var pageText: String?
    // On-device AI and read-aloud (AI/, Speech/): the assistant is made once
    // the engine is known to be there; the reader lives as long as the screen.
    var assistant: AIAssistant?
    var autofill: FormAutofillModel?
    var pendingAutofill: FormAutofillModel?
    let reader = ReadAloudController()
    var stampsAdded = 0
    var showingScanner = false
    var scanSaved: URL?
    /// Redact and Prepare form (`DocumentTools`).
    var tools: DocumentTools?

    /// How many copies of the screen are up. During a fold the new copy
    /// comes as the old one goes; read aloud stops only once none is left.
    @ObservationIgnored var views = 0

    func appeared() {
        views += 1
    }

    func disappeared() {
        views -= 1
        Task { @MainActor [weak self] in
            // Long enough for the copy on the other screen to appear.
            try? await Task.sleep(for: .milliseconds(400))
            guard let self, views <= 0 else { return }
            reader.stop()
        }
    }
}
