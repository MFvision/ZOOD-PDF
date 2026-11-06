package sa.zood.pdf;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.journeyapps.barcodescanner.ScanOptions;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The editor: the same ZOOD PDF the web and the desktop run (apps/web, with the
 * Rust engine compiled to WebAssembly), served from inside the app at
 * https://appassets.androidplatform.net — a name Android keeps for exactly
 * this, which never reaches the network. Nothing is downloaded to run it.
 *
 * Around it: files opened with or shared to ZOOD PDF reach the page, the
 * page's saves and shares reach Android, and the phone remote starts here.
 */
public final class MainActivity extends WebHostActivity {
    static final String HOST = "appassets.androidplatform.net";
    static final String ORIGIN = "https://" + HOST;
    static final String ACTION_REMOTE = "sa.zood.pdf.REMOTE";
    /** From the remote's "scan the code again": straight to the scanner. */
    static final String ACTION_SCAN = "sa.zood.pdf.SCAN";
    private static final int REQUEST_SCAN = 21;
    private static final Pattern HEAD = Pattern.compile("<head[^>]*>", Pattern.CASE_INSENSITIVE);
    private static final String SHIM = "<script src=\"/__zood/shim.js\"></script>";

    @Override
    protected boolean isEditor() {
        return true;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        web.setWebViewClient(new Client());
        if (state != null) web.restoreState(state);
        if (web.getUrl() == null) web.loadUrl(ORIGIN + "/index.html");
        handle(getIntent());
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        if (web != null) web.saveState(state);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handle(intent);
    }

    @Override
    protected boolean trusted(Uri origin) {
        return origin != null && "https".equals(origin.getScheme()) && HOST.equals(origin.getHost());
    }

    /* ------------------------------------------------- files from other apps */

    private void handle(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (ACTION_REMOTE.equals(action)) {
            intent.setAction(Intent.ACTION_MAIN);
            openRemote();
            return;
        }
        if (ACTION_SCAN.equals(action)) {
            intent.setAction(Intent.ACTION_MAIN);
            scan();
            return;
        }
        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            uris.add(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri one = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (one != null) uris.add(one);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) uris.addAll(many.subList(0, Math.min(many.size(), 50)));
        }
        // Handled once: rotating the phone must not open the same file again.
        intent.setAction(Intent.ACTION_MAIN);
        intent.setData(null);
        intent.removeExtra(Intent.EXTRA_STREAM);
        if (uris.isEmpty()) return;
        io.execute(() -> {
            boolean any = false;
            for (Uri uri : uris) any |= copyIn(uri);
            boolean arrived = any;
            main.post(() -> {
                if (!arrived) toast(R.string.open_failed);
                else if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('zood:incoming'))", null);
            });
        });
    }

    /** Copies a file another app offered into the cache, where the page can fetch it. */
    private boolean copyIn(Uri uri) {
        String scheme = uri.getScheme();
        if (!"content".equals(scheme) && !"file".equals(scheme)) return false;
        // A file:// path must not reach into the app's own data.
        if ("file".equals(scheme)) {
            String path = uri.getPath();
            if (path == null || path.startsWith(getApplicationInfo().dataDir) || path.contains("/data/data/")) return false;
        }
        File dir = new File(getCacheDir(), Files.INCOMING);
        if (!dir.isDirectory() && !dir.mkdirs()) return false;
        String id = UUID.randomUUID().toString();
        File file = new File(dir, id);
        String name = Files.safeName(Files.displayName(getContentResolver(), uri), "document.pdf");
        String type = getContentResolver().getType(uri);
        if (type == null || type.equals("application/octet-stream")) type = Files.mimeOf(name);
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null || !Files.copy(in, file)) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                return false;
            }
        } catch (IOException | SecurityException e) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            return false;
        }
        // A PDF that came without its extension still opens as one.
        if (type.equals("application/pdf") && !name.toLowerCase(java.util.Locale.ROOT).endsWith(".pdf")) name = name + ".pdf";
        bridge.arrive(new Bridge.Incoming(id, name, type, file));
        return true;
    }

    /* ----------------------------------------------------------- phone remote */

    @Override
    public void openRemote() {
        main.post(() -> {
            SharedPreferences remembered = getSharedPreferences(RemoteActivity.PREFS, MODE_PRIVATE);
            String last = remembered.getString(RemoteActivity.LAST, null);
            if (last != null && RemoteActivity.allowed(Uri.parse(last))) {
                startActivity(new Intent(this, RemoteActivity.class).setData(Uri.parse(last)));
            } else {
                scan();
            }
        });
    }

    void scan() {
        ScanOptions options = new ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(getString(R.string.remote_scan_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false);
        try {
            startActivityForResult(options.createScanIntent(this), REQUEST_SCAN);
        } catch (ActivityNotFoundException e) {
            toast(R.string.no_app_for_this);
        }
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request != REQUEST_SCAN) {
            super.onActivityResult(request, result, data);
            return;
        }
        String text = data != null ? data.getStringExtra(com.google.zxing.client.android.Intents.Scan.RESULT) : null;
        if (result != RESULT_OK || text == null) return;
        Uri uri = Uri.parse(text.trim());
        if (!RemoteActivity.allowed(uri) || uri.getFragment() == null || !uri.getFragment().startsWith("k=")) {
            toast(R.string.remote_not_zood);
            return;
        }
        startActivity(new Intent(this, RemoteActivity.class).setData(uri));
    }

    /* --------------------------------------------------- the app's own files */

    private final class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (!"https".equals(url.getScheme()) || !HOST.equals(url.getHost())) return null;
            return serve(url.getPath());
        }

        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if ("https".equals(url.getScheme()) && HOST.equals(url.getHost())) return false;
            // Links in a document or in Help open in the phone's browser, never in here.
            String scheme = url.getScheme();
            if ("https".equals(scheme) || "http".equals(scheme) || "mailto".equals(scheme) || "tel".equals(scheme)) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
                } catch (ActivityNotFoundException e) {
                    toast(R.string.no_app_for_this);
                }
            }
            return true;
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            // The page ran out of memory (a huge scan) or crashed: start it again
            // instead of taking the whole app down with it.
            recreate();
            return true;
        }
    }

    private WebResourceResponse serve(String path) {
        if (path == null || path.isEmpty() || path.equals("/")) path = "/index.html";
        if (path.contains("..") || path.contains("\\") || path.contains("//")) return missing();
        try {
            if (path.startsWith("/__incoming/")) {
                Bridge.Incoming file = bridge.incoming(path.substring("/__incoming/".length()));
                if (file == null) return missing();
                return response(file.mime, new FileInputStream(file.file));
            }
            if (path.equals("/__zood/shim.js")) {
                return response("text/javascript", getAssets().open("zood/shim.js"));
            }
            String asset = "www" + path;
            if (path.equals("/index.html")) {
                return response("text/html", withShim(getAssets().open(asset)));
            }
            return response(Files.mimeOf(path), getAssets().open(asset));
        } catch (FileNotFoundException e) {
            return missing();
        } catch (IOException e) {
            return missing();
        }
    }

    /** The page with the Android bridge's script first in its head, before any of its own. */
    private static InputStream withShim(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream page = in) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = page.read(buffer)) != -1) out.write(buffer, 0, read);
        }
        String html = out.toString(StandardCharsets.UTF_8.name());
        Matcher head = HEAD.matcher(html);
        html = head.find() ? html.substring(0, head.end()) + SHIM + html.substring(head.end()) : SHIM + html;
        return new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8));
    }

    private static WebResourceResponse response(String mime, InputStream body) {
        boolean text = mime.startsWith("text/") || mime.endsWith("json") || mime.endsWith("+xml");
        WebResourceResponse response = new WebResourceResponse(mime, text ? "utf-8" : null, body);
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-cache");
        headers.put("X-Content-Type-Options", "nosniff");
        response.setResponseHeaders(headers);
        return response;
    }

    private static WebResourceResponse missing() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<>(), new ByteArrayInputStream(new byte[0]));
    }
}
