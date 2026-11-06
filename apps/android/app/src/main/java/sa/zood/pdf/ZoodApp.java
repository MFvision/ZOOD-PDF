package sa.zood.pdf;

import android.app.Application;

import java.io.File;

/** Clears what the last run left in the cache: files shared out and files that came in. */
public final class ZoodApp extends Application {
    @Override
    public void onCreate() {
        super.onCreate();
        Files.clear(new File(getCacheDir(), Files.OUTGOING));
        Files.clear(new File(getCacheDir(), Files.INCOMING));
        Files.clear(new File(getCacheDir(), Files.SAVING));
    }
}
