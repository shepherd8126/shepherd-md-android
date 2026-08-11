package com.shepherd.md;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.ByteArrayInputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashMap;
import java.util.Map;

/**
 * The whole Android shell: a WebView running the same UI as the desktop builds.
 *
 * Instead of a local HTTP server, /api/* requests are answered natively by
 * shouldInterceptRequest - so the shared app.js keeps using fetch() and <img src="/api/raw">
 * exactly as it does on Windows and macOS.
 */
public class MainActivity extends AppCompatActivity {

    private static final String UPDATE_FEED =
            "https://github.com/shepherd8126/shepherd-md-releases/releases/latest/download/latest.json";

    private WebView web;
    private Store store;
    private WebViewAssetLoader assetLoader;
    private ActivityResultLauncher<Uri> pickTree;
    private ActivityResultLauncher<String[]> pickDoc;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        store = new Store(this);

        assetLoader = new WebViewAssetLoader.Builder()
                .setDomain("appassets.androidplatform.net")
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        pickTree = registerForActivityResult(new ActivityResultContracts.OpenDocumentTree(), uri -> {
            if (uri == null) return;
            store.addRoot(uri);
            runJs("window.__folderAdded && window.__folderAdded()");
        });

        pickDoc = registerForActivityResult(new ActivityResultContracts.OpenDocument(), uri -> {
            if (uri == null) return;
            String synth = store.addSingleFile(uri);
            runJs("window.__externalOpen && window.__externalOpen(" + jsStr(synth) + ")");
        });

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // the UI stores theme + prefs in localStorage
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                Uri url = req.getUrl();
                String path = url.getPath();
                if (path != null && path.startsWith("/api/")) return api(path, url);
                return assetLoader.shouldInterceptRequest(url);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String host = u.getHost();
                if (host != null && host.equals("appassets.androidplatform.net")) return false;
                // real links open in the browser, never inside the app shell
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectBridge();
                if (pendingOpen != null) {
                    String p = pendingOpen;
                    pendingOpen = null;
                    runJs("window.__externalOpen && window.__externalOpen(" + jsStr(p) + ")");
                }
                if (!updateChecked) {
                    updateChecked = true;
                    new Thread(() -> { try { Thread.sleep(3500); } catch (Exception ignored) { } checkForUpdate(); }).start();
                }
            }
        });

        web.addJavascriptInterface(new Bridge(), "__androidHost");

        handleViewIntent(getIntent());
        web.loadUrl("https://appassets.androidplatform.net/index.html");
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (handleViewIntent(intent)) {
            // already running: open it straight into the live UI
            String p = pendingOpen;
            pendingOpen = null;
            if (p != null) runJs("window.__externalOpen && window.__externalOpen(" + jsStr(p) + ")");
        }
    }

    private String pendingOpen = null;
    private boolean updateChecked = false;
    private boolean bridgeInjected = false;

    /** android-bridge.js lives in assets so the shared index.html needs no Android-only script tag. */
    private void injectBridge() {
        if (bridgeInjected) return;
        try {
            InputStream in = getAssets().open("android-bridge.js");
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            web.evaluateJavascript(new String(bos.toByteArray(), StandardCharsets.UTF_8), null);
            bridgeInjected = true;
        } catch (Exception ignored) { }
    }

    /** Checked natively (not from JS) so there is no cross-origin problem reaching GitHub. */
    private void checkForUpdate() {
        try {
            String current = UPDATE_FEED;
            HttpURLConnection conn = null;
            for (int hop = 0; hop < 6; hop++) {
                conn = (HttpURLConnection) new URL(current).openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(20000);
                conn.setRequestProperty("User-Agent", "ShepherdMarkdown-Android");
                int code = conn.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    current = conn.getHeaderField("Location");
                    conn.disconnect();
                    continue;
                }
                if (code != 200) return;
                break;
            }
            if (conn == null) return;
            InputStream in = conn.getInputStream();
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            conn.disconnect();

            org.json.JSONObject feed = new org.json.JSONObject(new String(bos.toByteArray(), StandardCharsets.UTF_8));
            String version = feed.optString("version", "");
            String notes = feed.optString("notes", "");
            org.json.JSONObject android = feed.optJSONObject("android");
            if (android == null || version.isEmpty()) return;      // no Android build published yet
            String apkUrl = android.optString("url", "");
            if (apkUrl.isEmpty()) return;
            if (compareVersions(version, BuildConfig.VERSION_NAME) <= 0) return;

            org.json.JSONObject info = new org.json.JSONObject();
            info.put("version", version);
            info.put("notes", notes);
            info.put("url", apkUrl);
            runJs("window.__updateAvailable && window.__updateAvailable(" + info.toString() + ")");
        } catch (Exception ignored) { }
    }

    private static int compareVersions(String a, String b) {
        String[] pa = (a == null ? "0" : a).split("\\.");
        String[] pb = (b == null ? "0" : b).split("\\.");
        for (int i = 0; i < Math.max(pa.length, pb.length); i++) {
            int na = 0, nb = 0;
            try { if (i < pa.length) na = Integer.parseInt(pa[i].replaceAll("\\D", "")); } catch (Exception ignored) { }
            try { if (i < pb.length) nb = Integer.parseInt(pb[i].replaceAll("\\D", "")); } catch (Exception ignored) { }
            if (na != nb) return na > nb ? 1 : -1;
        }
        return 0;
    }

    /** A .md handed to us by another app ("Open with"). */
    private boolean handleViewIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) return false;
        Uri u = intent.getData();
        if (u == null) return false;
        try {
            String synth = store.addSingleFile(u);
            store.setInitialFile(synth);
            pendingOpen = synth;
            return true;
        } catch (Exception e) { return false; }
    }

    private void runJs(final String js) {
        runOnUiThread(() -> { if (web != null) web.evaluateJavascript(js, null); });
    }

    private static String jsStr(String s) {
        if (s == null) return "\"\"";
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    // ---------------- the /api surface (mirrors the desktop server) ----------------

    private static WebResourceResponse json(String body) {
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-cache");
        WebResourceResponse r = new WebResourceResponse("application/json", "utf-8",
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
        r.setResponseHeaders(h);
        return r;
    }

    private static WebResourceResponse status(int code, String reason, String body) {
        WebResourceResponse r = new WebResourceResponse("text/plain", "utf-8",
                new ByteArrayInputStream(body.getBytes(StandardCharsets.UTF_8)));
        r.setStatusCodeAndReasonPhrase(code, reason);
        r.setResponseHeaders(Collections.singletonMap("Cache-Control", "no-cache"));
        return r;
    }

    private WebResourceResponse api(String path, Uri url) {
        try {
            switch (path) {
                case "/api/ping":
                    return json("{}");
                case "/api/config":
                    return json(store.configJson());
                case "/api/state":
                    return json(store.getState());   // writes go through the JS bridge (bodies are not readable here)
                case "/api/tree":
                    return json(store.treeJson());
                case "/api/search":
                    return json(store.searchJson(url.getQueryParameter("q")));
                case "/api/removeroot": {
                    store.removeRoot(url.getQueryParameter("path"));
                    return json("{\"ok\":true}");
                }
                case "/api/file": {
                    String body = store.fileJson(url.getQueryParameter("path"));
                    if (body == null) return status(404, "Not found", "Not found");
                    return json(body);
                }
                case "/api/raw": {
                    byte[] b = store.rawBytes(url.getQueryParameter("path"));
                    if (b == null) return status(404, "Not found", "Not found");
                    String p = url.getQueryParameter("path");
                    String mime = "application/octet-stream";
                    if (p != null) {
                        String lower = p.toLowerCase();
                        if (lower.endsWith(".png")) mime = "image/png";
                        else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) mime = "image/jpeg";
                        else if (lower.endsWith(".gif")) mime = "image/gif";
                        else if (lower.endsWith(".svg")) mime = "image/svg+xml";
                        else if (lower.endsWith(".webp")) mime = "image/webp";
                    }
                    WebResourceResponse r = new WebResourceResponse(mime, null, new ByteArrayInputStream(b));
                    r.setResponseHeaders(Collections.singletonMap("Cache-Control", "no-cache"));
                    return r;
                }
            }
        } catch (Exception e) {
            return status(500, "Error", "error");
        }
        return status(404, "Not found", "Not found");
    }

    // ---------------- JS bridge ----------------

    public class Bridge {

        @JavascriptInterface
        public String appVersion() { return BuildConfig.VERSION_NAME; }

        @JavascriptInterface
        public void pickFolder() {
            runOnUiThread(() -> { try { pickTree.launch((Uri) null); } catch (Exception ignored) { } });
        }

        @JavascriptInterface
        public void pickFile() {
            runOnUiThread(() -> {
                try {
                    pickDoc.launch(new String[]{ "text/*", "application/octet-stream", "application/x-markdown" });
                } catch (Exception ignored) { }
            });
        }

        /** session/tab state - PUT bodies are invisible to shouldInterceptRequest, so it comes through here */
        @JavascriptInterface
        public void setState(String json) { store.setState(json); }

        @JavascriptInterface
        public String updateFeed() { return UPDATE_FEED; }

        /** download the new APK and hand it to the system installer (the user still confirms) */
        @JavascriptInterface
        public void installUpdate(final String apkUrl) {
            new Thread(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
                        runOnUiThread(() -> {
                            toast("Allow \"Install unknown apps\" for Shepherd Markdown, then tap Update again.");
                            try {
                                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                        Uri.parse("package:" + getPackageName())));
                            } catch (Exception ignored) { }
                        });
                        return;
                    }
                    File dir = new File(getCacheDir(), "updates");
                    if (!dir.exists() && !dir.mkdirs()) throw new Exception("no cache dir");
                    File apk = new File(dir, "update.apk");

                    String current = apkUrl;
                    HttpURLConnection conn = null;
                    for (int hop = 0; hop < 6; hop++) {
                        conn = (HttpURLConnection) new URL(current).openConnection();
                        conn.setInstanceFollowRedirects(false);
                        conn.setConnectTimeout(20000);
                        conn.setReadTimeout(60000);
                        conn.setRequestProperty("User-Agent", "ShepherdMarkdown-Android");
                        int code = conn.getResponseCode();
                        if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                            current = conn.getHeaderField("Location");
                            conn.disconnect();
                            continue;
                        }
                        if (code != 200) throw new Exception("HTTP " + code);
                        break;
                    }
                    if (conn == null) throw new Exception("no connection");

                    InputStream in = conn.getInputStream();
                    FileOutputStream out = new FileOutputStream(apk);
                    byte[] buf = new byte[32768];
                    int n;
                    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                    out.close();
                    in.close();
                    conn.disconnect();

                    if (apk.length() < 100000) throw new Exception("download too small");

                    Uri uri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", apk);
                    Intent i = new Intent(Intent.ACTION_VIEW);
                    i.setDataAndType(uri, "application/vnd.android.package-archive");
                    i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(i);
                } catch (Exception e) {
                    runOnUiThread(() -> {
                        toast("Update download failed");
                        runJs("window.__updateFailed && window.__updateFailed()");
                    });
                }
            }).start();
        }
    }

    private void toast(String msg) {
        try { Toast.makeText(this, msg, Toast.LENGTH_LONG).show(); } catch (Exception ignored) { }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        // best-effort flush of tab/session state before the app is backgrounded
        runJs("try{window.__flushState&&window.__flushState()}catch(e){}");
        super.onPause();
    }
}
