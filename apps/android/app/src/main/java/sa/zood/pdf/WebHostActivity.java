package sa.zood.pdf;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * One full-screen web view and what a page needs from the phone around it:
 * the system bars kept clear, the file picker, the save panel and the share
 * sheet, printing, the camera and microphone on the person's say-so, and Back.
 * The editor ({@link MainActivity}) and the phone remote ({@link RemoteActivity})
 * are both this.
 */
abstract class WebHostActivity extends Activity implements Bridge.Host {
    private static final int REQUEST_CHOOSE = 11;
    private static final int REQUEST_SAVE = 12;
    private static final int REQUEST_PERMISSION = 13;

    protected final ExecutorService io = Executors.newSingleThreadExecutor();
    protected final Handler main = new Handler(Looper.getMainLooper());
    protected FrameLayout root;
    protected WebView web;
    protected Bridge bridge;

    private ValueCallback<Uri[]> chooser;
    private PermissionRequest permission;
    private String[] permissionResources;
    private File saving;
    private String savingId;

    /** True for the editor; the remote's page may only save and share. */
    protected abstract boolean isEditor();

    @SuppressLint({"SetJavaScriptEnabled", "JavascriptInterface"})
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        WebView.setWebContentsDebuggingEnabled((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);

        // Edge to edge on every version (Android 15 insists on it), with the
        // page kept clear of the bars, the camera cut-out and the keyboard.
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        root = new FrameLayout(this);
        root.setBackgroundColor(getColor(R.color.window_background));
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout()
                    | WindowInsetsCompat.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        tintBars();

        web = new WebView(this);
        web.setBackgroundColor(Color.TRANSPARENT);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setTextZoom(100);
        settings.setUserAgentString(settings.getUserAgentString() + " ZOODPDF-Android/" + version());
        bridge = new Bridge(this, isEditor());
        web.addJavascriptInterface(bridge, "ZoodAndroid");
        web.setWebChromeClient(new Chrome());

        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::back);
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        back();
    }

    /** Back closes what the page has open (a menu, a dialog); with nothing open the app steps aside. */
    private void back() {
        web.evaluateJavascript("window.__zoodBack ? window.__zoodBack() : false", value -> {
            if (!"true".equals(value)) {
                if (web.canGoBack() && !isEditor()) web.goBack();
                else leave();
            }
        });
    }

    @Override
    public void onConfigurationChanged(Configuration config) {
        super.onConfigurationChanged(config);
        tintBars();
    }

    private void tintBars() {
        boolean night = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        bars.setAppearanceLightStatusBars(!night);
        bars.setAppearanceLightNavigationBars(!night);
        if (root != null) root.setBackgroundColor(getColor(R.color.window_background));
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("ZoodAndroid");
            ((ViewGroup) web.getParent()).removeView(web);
            web.destroy();
            web = null;
        }
        io.shutdown();
        super.onDestroy();
    }

    /* ---------------------------------------------------------- Bridge.Host */

    @Override
    public File cacheDir() {
        return getCacheDir();
    }

    @Override
    public void deliver(String id, File file, String name, String mime, boolean share) {
        main.post(() -> {
            if (share) shareFile(id, file, name, mime);
            else askWhereToSave(id, file, name, mime);
        });
    }

    private void askWhereToSave(String id, File file, String name, String mime) {
        if (saving != null) {
            // One save panel at a time: the earlier one was abandoned.
            //noinspection ResultOfMethodCallIgnored
            saving.delete();
            finished(savingId, false);
        }
        saving = file;
        savingId = id;
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType(mime)
                .putExtra(Intent.EXTRA_TITLE, name);
        try {
            startActivityForResult(intent, REQUEST_SAVE);
        } catch (ActivityNotFoundException e) {
            // No document provider at all (a stripped-down phone): offer the share sheet instead.
            saving = null;
            savingId = null;
            shareFile(id, file, name, mime);
        }
    }

    private void shareFile(String id, File file, String name, String mime) {
        File dir = new File(new File(getCacheDir(), Files.OUTGOING), id);
        File named = new File(dir, name);
        if ((!dir.isDirectory() && !dir.mkdirs()) || !file.renameTo(named)) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            toast(R.string.save_failed);
            finished(id, false);
            return;
        }
        Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".files", named);
        Intent send = new Intent(Intent.ACTION_SEND)
                .setType(mime)
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri(name, uri));
        try {
            startActivity(Intent.createChooser(send, getString(R.string.share_with)));
            finished(id, true);
        } catch (ActivityNotFoundException e) {
            toast(R.string.no_app_for_this);
            finished(id, false);
        }
    }

    /** Tells the page how its save or share went. */
    private void finished(String id, boolean ok) {
        if (id == null || web == null) return;
        web.evaluateJavascript("window.__zoodSaved && window.__zoodSaved(" + quote(id) + "," + ok + ")", null);
    }

    @Override
    public void print(String title) {
        main.post(() -> {
            PrintManager printer = (PrintManager) getSystemService(PRINT_SERVICE);
            if (printer == null || web == null) return;
            PrintDocumentAdapter page = web.createPrintDocumentAdapter(title);
            // The page lays its print sheet out for window.print() and takes it
            // down on "afterprint": sent here once Android's print screen is done.
            PrintDocumentAdapter told = new PrintDocumentAdapter() {
                @Override
                public void onStart() {
                    page.onStart();
                }

                @Override
                public void onLayout(PrintAttributes old, PrintAttributes now, CancellationSignal cancel, LayoutResultCallback callback, Bundle extras) {
                    page.onLayout(old, now, cancel, callback, extras);
                }

                @Override
                public void onWrite(PageRange[] pages, ParcelFileDescriptor out, CancellationSignal cancel, WriteResultCallback callback) {
                    page.onWrite(pages, out, cancel, callback);
                }

                @Override
                public void onFinish() {
                    page.onFinish();
                    if (web != null) web.evaluateJavascript("window.dispatchEvent(new Event('afterprint'))", null);
                }
            };
            printer.print(title, told, new PrintAttributes.Builder().build());
        });
    }

    @Override
    public void openRemote() {
        // The editor overrides this.
    }

    @Override
    public void leave() {
        main.post(() -> moveTaskToBack(true));
    }

    @Override
    public String version() {
        try {
            PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return info.versionName != null ? info.versionName : "0";
        } catch (PackageManager.NameNotFoundException e) {
            return "0";
        }
    }

    /* -------------------------------------------------------- activity results */

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == REQUEST_CHOOSE) {
            ValueCallback<Uri[]> callback = chooser;
            chooser = null;
            if (callback == null) return;
            callback.onReceiveValue(result == RESULT_OK && data != null ? picked(data) : null);
        } else if (request == REQUEST_SAVE) {
            File file = saving;
            String id = savingId;
            saving = null;
            savingId = null;
            if (file == null) return;
            Uri target = result == RESULT_OK && data != null ? data.getData() : null;
            if (target == null) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                finished(id, false);
                return;
            }
            io.execute(() -> {
                boolean ok;
                try (InputStream in = new FileInputStream(file);
                     OutputStream out = getContentResolver().openOutputStream(target, "wt")) {
                    ok = out != null && Files.copy(in, out);
                } catch (Exception e) {
                    ok = false;
                }
                //noinspection ResultOfMethodCallIgnored
                file.delete();
                boolean done = ok;
                main.post(() -> {
                    toast(done ? R.string.saved : R.string.save_failed);
                    finished(id, done);
                });
            });
        }
    }

    private static Uri[] picked(Intent data) {
        ClipData clip = data.getClipData();
        if (clip != null && clip.getItemCount() > 0) {
            Uri[] uris = new Uri[clip.getItemCount()];
            for (int i = 0; i < uris.length; i++) uris[i] = clip.getItemAt(i).getUri();
            return uris;
        }
        return data.getData() != null ? new Uri[] {data.getData()} : null;
    }

    @Override
    public void onRequestPermissionsResult(int request, String[] names, int[] results) {
        super.onRequestPermissionsResult(request, names, results);
        if (request != REQUEST_PERMISSION || permission == null) return;
        PermissionRequest asked = permission;
        String[] resources = permissionResources;
        permission = null;
        permissionResources = null;
        List<String> granted = new ArrayList<>();
        for (String resource : resources) {
            String needed = resource.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE) ? Manifest.permission.CAMERA : Manifest.permission.RECORD_AUDIO;
            if (checkSelfPermission(needed) == PackageManager.PERMISSION_GRANTED) granted.add(resource);
            else toast(needed.equals(Manifest.permission.CAMERA) ? R.string.camera_needed : R.string.mic_needed);
        }
        if (granted.isEmpty()) asked.deny();
        else asked.grant(granted.toArray(new String[0]));
    }

    /** Whether the page asking for the camera or the microphone is one this activity trusts. */
    protected abstract boolean trusted(Uri origin);

    protected void toast(int message) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show();
    }

    static String quote(String text) {
        return org.json.JSONObject.quote(text);
    }

    private final class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (chooser != null) chooser.onReceiveValue(null);
            chooser = callback;
            Intent intent = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE);
            String[] types = mimeTypes(params.getAcceptTypes());
            if (types.length == 1) intent.setType(types[0]);
            else {
                intent.setType("*/*");
                if (types.length > 1) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
            }
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try {
                startActivityForResult(intent, REQUEST_CHOOSE);
                return true;
            } catch (ActivityNotFoundException e) {
                chooser = null;
                toast(R.string.no_app_for_this);
                return false;
            }
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            main.post(() -> {
                if (!trusted(request.getOrigin())) {
                    request.deny();
                    return;
                }
                Set<String> resources = new LinkedHashSet<>();
                Set<String> needed = new LinkedHashSet<>();
                for (String resource : request.getResources()) {
                    if (resource.equals(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) {
                        resources.add(resource);
                        needed.add(Manifest.permission.CAMERA);
                    } else if (resource.equals(PermissionRequest.RESOURCE_AUDIO_CAPTURE)) {
                        resources.add(resource);
                        needed.add(Manifest.permission.RECORD_AUDIO);
                    }
                }
                if (resources.isEmpty()) {
                    request.deny();
                    return;
                }
                List<String> missing = new ArrayList<>();
                for (String name : needed) {
                    if (checkSelfPermission(name) != PackageManager.PERMISSION_GRANTED) missing.add(name);
                }
                if (missing.isEmpty()) {
                    request.grant(resources.toArray(new String[0]));
                    return;
                }
                if (permission != null) permission.deny();
                permission = request;
                permissionResources = resources.toArray(new String[0]);
                requestPermissions(missing.toArray(new String[0]), REQUEST_PERMISSION);
            });
        }
    }

    /** An `accept` list (".pdf", "image/*", "application/pdf") as the types Android's picker filters by. */
    static String[] mimeTypes(String[] accept) {
        Set<String> types = new LinkedHashSet<>();
        if (accept != null) {
            for (String raw : accept) {
                if (raw == null) continue;
                for (String part : raw.split(",")) {
                    String item = part.trim().toLowerCase(Locale.ROOT);
                    if (item.isEmpty()) continue;
                    if (item.equals("*") || item.equals("*/*")) return new String[0];
                    if (item.startsWith(".")) {
                        String mime = Files.mimeOf("x" + item);
                        if (mime.equals("application/octet-stream")) return new String[0];
                        types.add(mime);
                    } else if (item.contains("/")) {
                        types.add(item);
                    }
                }
            }
        }
        return types.toArray(new String[0]);
    }

    /** Hides the page while a native view (the remote's "can't reach" card) is up. */
    protected void showPage(boolean shown) {
        if (web != null) web.setVisibility(shown ? View.VISIBLE : View.INVISIBLE);
    }
}
