package sa.zood.pdf;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * The phone remote: the page ZOOD PDF on the computer serves to phones on the
 * local network (apps/web/remote.html, served by
 * apps/desktop/src-tauri/src/remote/server.rs), exactly as a phone's browser
 * would show it after scanning the code, with the app's save and share added.
 * Only addresses on the local network are opened; the computer's address is
 * remembered so the next time goes straight back to it.
 */
public final class RemoteActivity extends WebHostActivity {
    static final String PREFS = "remote";
    static final String LAST = "last";

    private Uri address;
    private View lost;

    @Override
    protected boolean isEditor() {
        return false;
    }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        web.setWebViewClient(new Client());
        open(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        open(intent);
    }

    private void open(Intent intent) {
        Uri uri = intent != null ? intent.getData() : null;
        if (uri == null || !allowed(uri)) {
            finish();
            return;
        }
        address = uri.buildUpon().fragment(null).clearQuery().path("/").build();
        hideLost();
        web.loadUrl(uri.toString());
    }

    /** Plain http to a private address with a port: what the computer's remote serves, and nothing else. */
    static boolean allowed(Uri uri) {
        if (uri == null || !"http".equals(uri.getScheme()) || uri.getPort() <= 0) return false;
        String host = uri.getHost();
        if (host == null) return false;
        if (host.endsWith(".local")) return true;
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        int[] n = new int[4];
        try {
            for (int i = 0; i < 4; i++) {
                n[i] = Integer.parseInt(parts[i]);
                if (n[i] < 0 || n[i] > 255) return false;
            }
        } catch (NumberFormatException e) {
            return false;
        }
        return n[0] == 10
                || (n[0] == 172 && n[1] >= 16 && n[1] <= 31)
                || (n[0] == 192 && n[1] == 168)
                || (n[0] == 169 && n[1] == 254)
                || (n[0] == 100 && n[1] >= 64 && n[1] <= 127);
    }

    private boolean sameComputer(Uri uri) {
        return address != null && "http".equals(uri.getScheme())
                && address.getHost() != null && address.getHost().equals(uri.getHost())
                && address.getPort() == uri.getPort();
    }

    @Override
    protected boolean trusted(Uri origin) {
        return origin != null && sameComputer(origin);
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri url = request.getUrl();
            if (sameComputer(url)) return false;
            if ("https".equals(url.getScheme())) {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
                } catch (ActivityNotFoundException ignored) {
                    // Nothing to open it with.
                }
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            super.onPageFinished(view, url);
            if (lost != null) return;
            // The page reached: this computer is the one to come back to.
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(LAST, address.toString()).apply();
            // Save and share for the files the computer sends (the same script the editor gets).
            try (InputStream in = getAssets().open("zood/shim.js")) {
                byte[] bytes = new byte[in.available()];
                int read = 0;
                while (read < bytes.length) {
                    int got = in.read(bytes, read, bytes.length - read);
                    if (got < 0) break;
                    read += got;
                }
                view.evaluateJavascript(new String(bytes, 0, read, StandardCharsets.UTF_8), null);
            } catch (IOException ignored) {
                // Without it the remote still works; received files just can't be saved.
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) showLost();
        }
    }

    /** The computer did not answer: say so plainly, with the two ways forward. */
    private void showLost() {
        if (lost != null) return;
        showPage(false);
        float dp = getResources().getDisplayMetrics().density;
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setGravity(Gravity.CENTER);
        int pad = (int) (28 * dp);
        card.setPadding(pad, pad, pad, pad);
        card.setBackgroundColor(getColor(R.color.zood_navy));

        TextView text = new TextView(this);
        text.setText(R.string.remote_lost);
        text.setTextColor(Color.WHITE);
        text.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        text.setGravity(Gravity.CENTER);
        text.setLineSpacing(0, 1.3f);
        card.addView(text);

        Button retry = new Button(this);
        retry.setText(R.string.remote_retry);
        retry.setTypeface(Typeface.DEFAULT_BOLD);
        retry.setOnClickListener(v -> {
            hideLost();
            web.loadUrl(address.toString());
        });
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        gap.topMargin = (int) (24 * dp);
        card.addView(retry, gap);

        Button rescan = new Button(this);
        rescan.setText(R.string.remote_scan_again);
        rescan.setOnClickListener(v -> {
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(LAST).apply();
            startActivity(new Intent(this, MainActivity.class).setAction(MainActivity.ACTION_SCAN));
            finish();
        });
        LinearLayout.LayoutParams gap2 = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        gap2.topMargin = (int) (12 * dp);
        card.addView(rescan, gap2);

        lost = card;
        root.addView(card, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private void hideLost() {
        if (lost == null) return;
        root.removeView(lost);
        lost = null;
        showPage(true);
    }
}
