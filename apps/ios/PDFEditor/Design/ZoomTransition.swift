import SwiftUI

/// A document opens out of its own thumbnail and goes back into it: the
/// system's zoom transition, which follows the finger on the way back and
/// becomes a cross-fade under Reduce Motion. The Library's stack owns the
/// namespace; a thumbnail names itself as a source, and the document that
/// was opened from it names the same source.
extension EnvironmentValues {
    @Entry var zoomNamespace: Namespace.ID?
}

extension View {
    /// Marks a thumbnail as where its document zooms out of.
    @ViewBuilder
    func zoomSource(_ id: String) -> some View {
        modifier(ZoomSource(id: id))
    }

    /// Opens this screen out of the thumbnail marked `id`; the usual push
    /// when nothing was marked (a document opened from Files or a search).
    @ViewBuilder
    func zoomed(from id: String?, in namespace: Namespace.ID) -> some View {
        if let id {
            navigationTransition(.zoom(sourceID: id, in: namespace))
        } else {
            self
        }
    }
}

private struct ZoomSource: ViewModifier {
    let id: String
    @Environment(\.zoomNamespace) private var namespace

    func body(content: Content) -> some View {
        if let namespace {
            content.matchedTransitionSource(id: id, in: namespace)
        } else {
            content
        }
    }
}
