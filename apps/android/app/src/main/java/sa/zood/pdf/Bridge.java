package sa.zood.pdf;

import android.util.Base64;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * What the page can ask of the phone, as `window.ZoodAndroid` (assets/zood/shim.js
 * is its only caller). Every method is short and checks what it is given: the
 * page treats PDFs as hostile, and this side treats the page the same way.
 *
 * Files leave the page in base64 pieces (a JavaScript string is the only way
 * across), written straight to a file in the cache; they reach the page from
 * the phone as a URL on the app's own origin (`/__incoming/<id>`), read by fetch.
 */
final class Bridge {
    /** The activity the bridge works for: the editor, or the phone remote. */
    interface Host {
        File cacheDir();
        /** Shows the save panel (`share` false) or the share sheet for a finished file. */
        void deliver(String id, File file, String name, String mime, boolean share);
        void print(String title);
        void openRemote();
        void leave();
        String version();
    }

    static final class Incoming {
        final String id;
        final String name;
        final String mime;
        final File file;

        Incoming(String id, String name, String mime, File file) {
            this.id = id;
            this.name = name;
            this.mime = mime;
            this.file = file;
        }
    }

    private static final class Outgoing {
        final File file;
        final String name;
        final String mime;
        final FileOutputStream out;
        long written;

        Outgoing(File file, String name, String mime, FileOutputStream out) {
            this.file = file;
            this.name = name;
            this.mime = mime;
            this.out = out;
        }
    }

    private final Host host;
    private final boolean editor;
    private final Map<String, Outgoing> outgoing = new HashMap<>();
    private final Map<String, Incoming> incoming = new HashMap<>();
    private final List<Incoming> waiting = new ArrayList<>();

    /** `editor` false for the phone remote's page, which may only save and share. */
    Bridge(Host host, boolean editor) {
        this.host = host;
        this.editor = editor;
    }

    /* ------------------------------------------------ files the page hands out */

    @JavascriptInterface
    public String saveBegin(String name, String mime) {
        synchronized (outgoing) {
            if (outgoing.size() > 8) return "";
            File dir = new File(host.cacheDir(), Files.SAVING);
            if (!dir.isDirectory() && !dir.mkdirs()) return "";
            String id = UUID.randomUUID().toString();
            try {
                File file = new File(dir, id);
                String clean = Files.safeName(name, "document.pdf");
                String type = mime != null && mime.matches("[a-z]+/[a-zA-Z0-9.+\\-]+") ? mime : Files.mimeOf(clean);
                outgoing.put(id, new Outgoing(file, clean, type, new FileOutputStream(file)));
                return id;
            } catch (IOException e) {
                return "";
            }
        }
    }

    @JavascriptInterface
    public boolean saveChunk(String id, String base64) {
        Outgoing file;
        synchronized (outgoing) {
            file = outgoing.get(id);
        }
        if (file == null || base64 == null) return false;
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            file.written += bytes.length;
            if (file.written > Files.MAX_BYTES) {
                drop(id);
                return false;
            }
            file.out.write(bytes);
            return true;
        } catch (IOException | IllegalArgumentException e) {
            drop(id);
            return false;
        }
    }

    /** `share` true hands the file to another app; false asks where to save it. */
    @JavascriptInterface
    public boolean saveEnd(String id, boolean share) {
        Outgoing file;
        synchronized (outgoing) {
            file = outgoing.remove(id);
        }
        if (file == null) return false;
        try {
            file.out.close();
        } catch (IOException e) {
            //noinspection ResultOfMethodCallIgnored
            file.file.delete();
            return false;
        }
        host.deliver(id, file.file, file.name, file.mime, share);
        return true;
    }

    @JavascriptInterface
    public void saveCancel(String id) {
        drop(id);
    }

    private void drop(String id) {
        Outgoing file;
        synchronized (outgoing) {
            file = outgoing.remove(id);
        }
        if (file == null) return;
        try {
            file.out.close();
        } catch (IOException ignored) {
            // Deleted below either way.
        }
        //noinspection ResultOfMethodCallIgnored
        file.file.delete();
    }

    /* --------------------------------------------- files the phone hands in */

    void arrive(Incoming file) {
        synchronized (incoming) {
            incoming.put(file.id, file);
            waiting.add(file);
        }
    }

    Incoming incoming(String id) {
        synchronized (incoming) {
            return incoming.get(id);
        }
    }

    /** The files opened with or shared to the app since the last call, as JSON, each given once. */
    @JavascriptInterface
    public String takeIncoming() {
        if (!editor) return "[]";
        JSONArray list = new JSONArray();
        synchronized (incoming) {
            for (Incoming file : waiting) {
                try {
                    list.put(new JSONObject()
                            .put("id", file.id)
                            .put("name", file.name)
                            .put("type", file.mime)
                            .put("url", "/__incoming/" + file.id));
                } catch (JSONException ignored) {
                    // A name JSON cannot hold is skipped.
                }
            }
            waiting.clear();
        }
        return list.toString();
    }

    /** The page has read the file: its copy in the cache can go. */
    @JavascriptInterface
    public void doneIncoming(String id) {
        Incoming file;
        synchronized (incoming) {
            file = incoming.remove(id);
        }
        if (file != null) {
            //noinspection ResultOfMethodCallIgnored
            file.file.delete();
        }
    }

    /* ------------------------------------------------------------ the rest */

    @JavascriptInterface
    public void print(String title) {
        if (editor) host.print(Files.safeName(title, "ZOOD PDF"));
    }

    @JavascriptInterface
    public void openRemote() {
        if (editor) host.openRemote();
    }

    /** Back with nothing left to close: the app goes to the background, as Android apps do. */
    @JavascriptInterface
    public void leave() {
        host.leave();
    }

    @JavascriptInterface
    public String version() {
        return host.version();
    }

    @JavascriptInterface
    public boolean isEditor() {
        return editor;
    }
}
