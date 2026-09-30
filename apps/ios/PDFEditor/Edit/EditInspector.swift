import SwiftUI

/// The editor's inspector, beside the pages where there is room for it (an
/// iPad, or an iPhone turned on its side): what this page holds of the kind
/// being edited — its paragraphs, its pictures, its links — each a row that
/// picks it, and under the picked one what can be done to it.
///
/// It is the same operations the bar has; the inspector is what makes them
/// reachable without hunting on the page, and what names each thing for
/// VoiceOver.
struct EditInspector: View {
    @Bindable var edit: EditModel
    let openPicture: () -> Void

    private var page: Int { edit.model.currentPage }

    var body: some View {
        List {
            switch edit.mode {
            case .text: textRows
            case .pictures: pictureRows
            case .links: linkRows
            }
        }
        .listStyle(.insetGrouped)
        .accessibilityIdentifier("edit.inspector")
    }

    // MARK: - Text

    @ViewBuilder
    private var textRows: some View {
        Section("Text on this page") {
            let paragraphs = edit.paragraphs(onPage: page)
            if let paragraphs, paragraphs.isEmpty {
                Text("This page has no text the editor can take apart. A line can still be added to it.")
                    .font(TextStyle.caption)
                    .foregroundStyle(Surface.secondaryLabel)
            } else if let paragraphs {
                ForEach(paragraphs, id: \.index) { paragraph in
                    Button {
                        edit.begin(editing: paragraph, onPage: page)
                    } label: {
                        VStack(alignment: .leading, spacing: Space.x1) {
                            Text(verbatim: paragraph.text)
                                .font(TextStyle.callout)
                                .lineLimit(3)
                                .multilineTextAlignment(paragraph.isRightToLeft ? .trailing : .leading)
                                .frame(maxWidth: .infinity, alignment: paragraph.isRightToLeft ? .trailing : .leading)
                                .environment(\.layoutDirection, paragraph.isRightToLeft ? .rightToLeft : .leftToRight)
                            Text("\(paragraph.lineCount) lines, \(Int(paragraph.fontSize)) points")
                                .font(TextStyle.caption)
                                .foregroundStyle(Surface.secondaryLabel)
                        }
                    }
                    .disabled(edit.working)
                    .accessibilityIdentifier("edit.paragraph.\(paragraph.index)")
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
            }
        }
    }

    // MARK: - Pictures

    @ViewBuilder
    private var pictureRows: some View {
        Section("Pictures on this page") {
            let pictures = edit.pictures(onPage: page)
            if let pictures, pictures.isEmpty {
                Text("This page has no pictures. Add one and drag out where it goes.")
                    .font(TextStyle.caption)
                    .foregroundStyle(Surface.secondaryLabel)
            } else if let pictures {
                ForEach(pictures) { picture in
                    Button {
                        guard picture.isEditable else { return }
                        edit.selectedPicture = PictureRef(page: page, id: picture.id)
                    } label: {
                        HStack {
                            Image(systemName: picture.isEditable ? "photo" : "photo.badge.exclamationmark")
                                .foregroundStyle(picture.isEditable ? Color.accentColor : Surface.tertiaryLabel)
                            VStack(alignment: .leading, spacing: Space.x1) {
                                Text("\(picture.pixels.first ?? 0) by \(picture.pixels.last ?? 0) pixels")
                                    .font(TextStyle.callout)
                                    .tabularNumbers()
                                if !picture.isEditable {
                                    Text("Drawn in more than one place, so it is not edited here.")
                                        .font(TextStyle.caption)
                                        .foregroundStyle(Surface.secondaryLabel)
                                } else if picture.inForm {
                                    Text("Inside a form on the page: it stays within the form's box.")
                                        .font(TextStyle.caption)
                                        .foregroundStyle(Surface.secondaryLabel)
                                }
                            }
                            Spacer()
                            if picture.id == edit.selectedPicture?.id, edit.selectedPicture?.page == page {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                    .disabled(edit.working || !picture.isEditable)
                    .accessibilityIdentifier("edit.picture.\(picture.id)")
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
            }
        }
        Section {
            Button("Add a picture", systemImage: "photo.badge.plus", action: openPicture)
                .disabled(edit.working)
                .accessibilityIdentifier("edit.inspector.addPicture")
            if let picture = edit.picked, let on = edit.selectedPicture?.page {
                Button("Turn a quarter", systemImage: "rotate.right") {
                    Task { await edit.turn(picture, onPage: on) }
                }
                .accessibilityIdentifier("edit.inspector.turn")
                Toggle("Crop", systemImage: "crop", isOn: $edit.cropping)
                    .accessibilityIdentifier("edit.inspector.crop")
                Button(role: .destructive) {
                    Task { await edit.delete(picture, onPage: on) }
                } label: {
                    Label("Delete", systemImage: "trash")
                }
                .accessibilityIdentifier("edit.inspector.delete")
            }
        } footer: {
            if edit.pendingPicture != nil {
                Text("Drag out a box on the page to put the picture there.")
            } else if edit.picked != nil {
                Text("Drag the picture to move it, or a handle to resize it; with Crop on, a handle trims it.")
            }
        }
    }

    // MARK: - Links

    @ViewBuilder
    private var linkRows: some View {
        Section("Links on this page") {
            let links = edit.links(onPage: page)
            if let links, links.isEmpty {
                Text("This page has no links. Drag a box on the page to add one.")
                    .font(TextStyle.caption)
                    .foregroundStyle(Surface.secondaryLabel)
            } else if let links {
                ForEach(links) { link in
                    Button {
                        edit.selectedLink = LinkRef(page: page, id: link.id)
                    } label: {
                        HStack {
                            Image(systemName: link.to.uri != nil ? "globe" : (link.to.page != nil ? "doc.text" : "link.badge.plus"))
                                .foregroundStyle(Color.accentColor)
                            destination(of: link)
                                .font(TextStyle.callout)
                                .lineLimit(2)
                            Spacer()
                            if link.id == edit.selectedLink?.id, edit.selectedLink?.page == page {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                    .disabled(edit.working)
                    .accessibilityIdentifier("edit.link.\(link.id)")
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
            }
        }
        if let link = edit.pickedLink, let on = edit.selectedLink?.page {
            Section {
                Button("Where it goes", systemImage: "arrow.turn.down.right") {
                    edit.draftLink = DraftLink(page: on, rect: link.shownRect)
                }
                .accessibilityIdentifier("edit.inspector.linkWhere")
                Button(role: .destructive) {
                    Task { await edit.remove(link, onPage: on) }
                } label: {
                    Label("Remove", systemImage: "link.slash")
                }
                .accessibilityIdentifier("edit.inspector.linkRemove")
            } footer: {
                Text("Drag the box to move it, or a handle to resize it.")
            }
        }
    }

    /// Where a link goes, as a person reads it: the address as written, the
    /// page as numbered, or that the file gives it nowhere to go.
    private func destination(of link: PageLink) -> Text {
        if let uri = link.to.uri { return Text(verbatim: uri) }
        if let page = link.to.page { return Text("Page \(page + 1)") }
        return Text("Nowhere in this file")
    }
}
