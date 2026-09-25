import Foundation

/// The container the app, its widgets and its share extension share
/// (`group.app.warraq`): the recents list the widgets read, the thumbnails,
/// and the Inbox the share extension drops files into. Everything in it
/// stays on the device.
public enum AppGroup {
    public static let identifier = "group.app.warraq"
    /// Where widgets and the app find each other: `pdfeditor://open/<id>`.
    public static let urlScheme = "pdfeditor"

    /// The shared container, or the app's own caches when the entitlement
    /// is missing (an unsigned build), so nothing ever fails for want of it.
    public static var containerURL: URL {
        if let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: identifier) {
            return url
        }
        return FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appending(path: "group.app.warraq", directoryHint: .isDirectory)
    }

    /// Files the share extension saved, waiting for the app to take them
    /// into its Documents folder.
    public static var inboxURL: URL {
        containerURL.appending(path: "Inbox", directoryHint: .isDirectory)
    }

    /// Thumbnails of recent documents, one PNG per entry, for the grid and
    /// the widgets.
    public static var thumbnailsURL: URL {
        containerURL.appending(path: "Thumbnails", directoryHint: .isDirectory)
    }

    public static var recentsFileURL: URL {
        containerURL.appending(path: "recents.json")
    }

    /// The last Library searches, for the Library search widget.
    public static var searchesFileURL: URL {
        containerURL.appending(path: "searches.json")
    }

    /// Small facts the app records for its widgets (whether a scan with a
    /// camera is possible here), one file per flag in the container.
    public static func setFlag(_ name: String, _ on: Bool) {
        let url = ensure(containerURL).appending(path: "flag-\(name)")
        if on {
            try? Data().write(to: url, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: url)
        }
    }

    public static func flag(_ name: String) -> Bool {
        FileManager.default.fileExists(atPath: containerURL.appending(path: "flag-\(name)").path)
    }

    /// Makes a folder if it is not there yet.
    @discardableResult
    public static func ensure(_ url: URL) -> URL {
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
