package sa.zood.pdf;

import android.content.ContentResolver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/** Small file helpers: names, types, copies. Nothing here trusts a name it was given. */
final class Files {
    static final String OUTGOING = "outgoing";
    static final String INCOMING = "incoming";
    static final String SAVING = "saving";

    /** The most a single file handed to or from the app may be: well past any real PDF. */
    static final long MAX_BYTES = 2L * 1024 * 1024 * 1024;

    private Files() {}

    static void clear(File dir) {
        File[] children = dir.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory()) clear(child);
                //noinspection ResultOfMethodCallIgnored
                child.delete();
            }
        }
    }

    /** A name that is only a name: no folders, no control characters, not empty, not too long. */
    static String safeName(String name, String fallback) {
        if (name == null) return fallback;
        String cut = name;
        int slash = Math.max(cut.lastIndexOf('/'), cut.lastIndexOf('\\'));
        if (slash >= 0) cut = cut.substring(slash + 1);
        StringBuilder out = new StringBuilder(cut.length());
        for (int i = 0; i < cut.length(); i++) {
            char c = cut.charAt(i);
            if (c < 0x20 || c == 0x7f || c == ':' || c == '*' || c == '?' || c == '"' || c == '<' || c == '>' || c == '|') continue;
            out.append(c);
        }
        String clean = out.toString().trim();
        while (clean.startsWith(".")) clean = clean.substring(1);
        if (clean.isEmpty()) return fallback;
        return clean.length() > 180 ? clean.substring(clean.length() - 180) : clean;
    }

    /** What the other app calls the file, when it says. */
    static String displayName(ContentResolver resolver, Uri uri) {
        if ("content".equals(uri.getScheme())) {
            try (Cursor cursor = resolver.query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (column >= 0) {
                        String name = cursor.getString(column);
                        if (name != null && !name.isEmpty()) return name;
                    }
                }
            } catch (RuntimeException ignored) {
                // Some providers refuse the query; the path's last part will do.
            }
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "document.pdf";
    }

    static String extension(String name) {
        int dot = name.lastIndexOf('.');
        return dot >= 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
    }

    /** The type of a file by its name, as the page and other apps expect it. */
    static String mimeOf(String name) {
        String ext = extension(name);
        switch (ext) {
            case "html":
            case "htm":
                return "text/html";
            case "js":
            case "mjs":
                return "text/javascript";
            case "css":
                return "text/css";
            case "json":
            case "map":
                return "application/json";
            case "webmanifest":
                return "application/manifest+json";
            case "wasm":
                return "application/wasm";
            case "svg":
                return "image/svg+xml";
            case "woff2":
                return "font/woff2";
            case "woff":
                return "font/woff";
            case "ttf":
                return "font/ttf";
            case "otf":
                return "font/otf";
            case "txt":
            case "md":
                return "text/plain";
            case "pdf":
                return "application/pdf";
            case "onnx":
            case "bin":
            case "gguf":
                return "application/octet-stream";
            default:
                String known = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
                return known != null ? known : "application/octet-stream";
        }
    }

    /** Copies at most `MAX_BYTES`; false when the file is bigger than that. */
    static boolean copy(InputStream in, File to) throws IOException {
        try (OutputStream out = new FileOutputStream(to)) {
            return copy(in, out);
        }
    }

    static boolean copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[256 * 1024];
        long total = 0;
        int read;
        while ((read = in.read(buffer)) != -1) {
            total += read;
            if (total > MAX_BYTES) return false;
            out.write(buffer, 0, read);
        }
        out.flush();
        return true;
    }
}
