package com.shepherd.md;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The Android equivalent of the desktop app's local file engine.
 *
 * Android's scoped storage forbids reading arbitrary paths, so folders and files are granted
 * through the Storage Access Framework and addressed by content:// URIs. The web UI, however,
 * thinks in plain paths - so every document is given a stable SYNTHETIC path ("/Notes/todo.md")
 * that maps back to its real URI. That keeps the shared app.js unchanged.
 */
public class Store {

    private static final String PREFS = "shepherd_md";
    private static final String KEY_ROOTS = "roots";      // JSON array of {uri, name}
    private static final String KEY_SINGLES = "singles";  // JSON array of {uri, name}
    private static final String KEY_STATE = "session";    // the web UI's session.json blob

    private static final String[] MD_EXT = { ".md", ".markdown", ".mdown", ".mkd", ".txt" };
    private static final long MAX_SEARCH_BYTES = 2L * 1024 * 1024;
    private static final int MAX_DEPTH = 12;
    private static final int MAX_RESULTS = 60;

    private final Context ctx;
    private final ContentResolver cr;

    /** synthetic path -> document uri (rebuilt on every tree walk, used by file/raw lookups) */
    private final Map<String, Uri> pathMap = new HashMap<>();
    /** synthetic path -> display name */
    private final Map<String, String> nameMap = new HashMap<>();

    private String initialFile = null;

    public Store(Context c) {
        ctx = c.getApplicationContext();
        cr = ctx.getContentResolver();
    }

    private SharedPreferences prefs() { return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    // ---------------- roots ----------------

    private JSONArray readList(String key) {
        try { return new JSONArray(prefs().getString(key, "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    private void writeList(String key, JSONArray arr) {
        prefs().edit().putString(key, arr.toString()).apply();
    }

    /** Persist a folder the user granted, so it survives restarts. Returns its display name. */
    public String addRoot(Uri treeUri) {
        try {
            cr.takePersistableUriPermission(treeUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) { /* some providers only offer read */ }

        String name = displayNameOfTree(treeUri);
        JSONArray roots = readList(KEY_ROOTS);
        for (int i = 0; i < roots.length(); i++) {
            JSONObject o = roots.optJSONObject(i);
            if (o != null && treeUri.toString().equals(o.optString("uri"))) return name; // already added
        }
        try {
            JSONObject o = new JSONObject();
            o.put("uri", treeUri.toString());
            o.put("name", name);
            roots.put(o);
            writeList(KEY_ROOTS, roots);
        } catch (Exception ignored) { }
        return name;
    }

    public void removeRoot(String synthPath) {
        String want = synthPath == null ? "" : synthPath.trim();
        if (want.startsWith("/")) want = want.substring(1);
        JSONArray roots = readList(KEY_ROOTS), keep = new JSONArray();
        for (int i = 0; i < roots.length(); i++) {
            JSONObject o = roots.optJSONObject(i);
            if (o == null) continue;
            if (want.equalsIgnoreCase(o.optString("name"))) {
                try { cr.releasePersistableUriPermission(Uri.parse(o.optString("uri")),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION); } catch (Exception ignored) { }
                continue;
            }
            keep.put(o);
        }
        writeList(KEY_ROOTS, keep);
    }

    /** A single file the user opened directly (its folder is NOT added to the sidebar). */
    public String addSingleFile(Uri docUri) {
        try { cr.takePersistableUriPermission(docUri, Intent.FLAG_GRANT_READ_URI_PERMISSION); } catch (Exception ignored) { }
        String name = displayNameOfDoc(docUri);
        JSONArray singles = readList(KEY_SINGLES);
        boolean found = false;
        for (int i = 0; i < singles.length(); i++) {
            JSONObject o = singles.optJSONObject(i);
            if (o != null && docUri.toString().equals(o.optString("uri"))) { found = true; break; }
        }
        if (!found) {
            try {
                JSONObject o = new JSONObject();
                o.put("uri", docUri.toString());
                o.put("name", name);
                singles.put(o);
                writeList(KEY_SINGLES, singles);
            } catch (Exception ignored) { }
        }
        String synth = "/" + name;
        pathMap.put(synth, docUri);
        nameMap.put(synth, name);
        return synth;
    }

    public void setInitialFile(String synthPath) { initialFile = synthPath; }

    // ---------------- names ----------------

    private String displayNameOfTree(Uri treeUri) {
        try {
            String docId = DocumentsContract.getTreeDocumentId(treeUri);
            Uri d = DocumentsContract.buildDocumentUriUsingTree(treeUri, docId);
            String n = displayNameOfDoc(d);
            if (n != null && !n.isEmpty()) return n;
            if (docId != null && docId.contains(":")) {
                String tail = docId.substring(docId.lastIndexOf(':') + 1);
                if (!tail.isEmpty()) return tail.contains("/") ? tail.substring(tail.lastIndexOf('/') + 1) : tail;
            }
        } catch (Exception ignored) { }
        return "Folder";
    }

    private String displayNameOfDoc(Uri docUri) {
        Cursor c = null;
        try {
            c = cr.query(docUri, new String[]{ DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null);
            if (c != null && c.moveToFirst()) return c.getString(0);
        } catch (Exception ignored) {
        } finally { if (c != null) c.close(); }
        return "";
    }

    // ---------------- tree ----------------

    private static boolean openable(String name) {
        if (name == null) return false;
        String n = name.toLowerCase(Locale.ROOT);
        for (String e : MD_EXT) if (n.endsWith(e)) return true;
        return false;
    }

    private static class Entry {
        String docId, name, mime; long modified, size;
        boolean isDir() { return DocumentsContract.Document.MIME_TYPE_DIR.equals(mime); }
    }

    /** One cursor query per directory - far faster than DocumentFile.listFiles(). */
    private List<Entry> children(Uri treeUri, String parentDocId) {
        List<Entry> out = new ArrayList<>();
        Cursor c = null;
        try {
            Uri kids = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId);
            c = cr.query(kids, new String[]{
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_LAST_MODIFIED,
                    DocumentsContract.Document.COLUMN_SIZE
            }, null, null, null);
            while (c != null && c.moveToNext()) {
                Entry e = new Entry();
                e.docId = c.getString(0);
                e.name = c.getString(1);
                e.mime = c.getString(2);
                e.modified = c.isNull(3) ? 0 : c.getLong(3);
                e.size = c.isNull(4) ? 0 : c.getLong(4);
                if (e.name == null || e.name.startsWith(".")) continue;
                out.add(e);
            }
        } catch (Exception ignored) {
        } finally { if (c != null) c.close(); }
        return out;
    }

    private JSONArray walk(Uri treeUri, String docId, String synthPrefix, int depth) {
        JSONArray kids = new JSONArray();
        if (depth > MAX_DEPTH) return kids;

        List<Entry> all = children(treeUri, docId);
        List<Entry> dirs = new ArrayList<>(), files = new ArrayList<>();
        for (Entry e : all) { if (e.isDir()) dirs.add(e); else if (openable(e.name)) files.add(e); }
        Comparator<Entry> byName = new Comparator<Entry>() {
            public int compare(Entry a, Entry b) { return a.name.compareToIgnoreCase(b.name); }
        };
        Collections.sort(dirs, byName);
        Collections.sort(files, byName);

        for (Entry d : dirs) {
            String synth = synthPrefix + "/" + d.name;
            JSONArray sub = walk(treeUri, d.docId, synth, depth + 1);
            if (sub.length() == 0) continue; // prune empty folders, like the desktop tree
            try {
                JSONObject o = new JSONObject();
                o.put("name", d.name); o.put("path", synth); o.put("type", "dir"); o.put("children", sub);
                kids.put(o);
            } catch (Exception ignored) { }
        }
        for (Entry f : files) {
            String synth = synthPrefix + "/" + f.name;
            pathMap.put(synth, DocumentsContract.buildDocumentUriUsingTree(treeUri, f.docId));
            nameMap.put(synth, f.name);
            try {
                JSONObject o = new JSONObject();
                o.put("name", f.name); o.put("path", synth); o.put("type", "file");
                kids.put(o);
            } catch (Exception ignored) { }
        }
        return kids;
    }

    public String treeJson() {
        pathMap.clear();
        nameMap.clear();
        // single files stay addressable even though they are not in any root
        JSONArray singles = readList(KEY_SINGLES);
        for (int i = 0; i < singles.length(); i++) {
            JSONObject o = singles.optJSONObject(i);
            if (o == null) continue;
            String nm = o.optString("name");
            pathMap.put("/" + nm, Uri.parse(o.optString("uri")));
            nameMap.put("/" + nm, nm);
        }

        JSONArray roots = readList(KEY_ROOTS);
        JSONArray outRoots = new JSONArray();
        for (int i = 0; i < roots.length(); i++) {
            JSONObject o = roots.optJSONObject(i);
            if (o == null) continue;
            Uri treeUri = Uri.parse(o.optString("uri"));
            String name = o.optString("name");
            String synth = "/" + name;
            try {
                String docId = DocumentsContract.getTreeDocumentId(treeUri);
                JSONArray kids = walk(treeUri, docId, synth, 0);
                JSONObject r = new JSONObject();
                r.put("name", name); r.put("path", synth); r.put("type", "dir"); r.put("children", kids);
                outRoots.put(r);
            } catch (Exception ignored) { }
        }
        try { return new JSONObject().put("roots", outRoots).toString(); }
        catch (Exception e) { return "{\"roots\":[]}"; }
    }

    private Uri resolve(String synthPath) {
        if (synthPath == null) return null;
        Uri u = pathMap.get(synthPath);
        if (u != null) return u;
        treeJson();                 // cold start (e.g. a tab restored before the tree was built)
        return pathMap.get(synthPath);
    }

    // ---------------- reading ----------------

    private byte[] readAll(Uri uri) throws Exception {
        InputStream in = cr.openInputStream(uri);
        if (in == null) throw new Exception("cannot open");
        try {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        } finally { try { in.close(); } catch (Exception ignored) { } }
    }

    private long lastModified(Uri uri) {
        Cursor c = null;
        try {
            c = cr.query(uri, new String[]{ DocumentsContract.Document.COLUMN_LAST_MODIFIED }, null, null, null);
            if (c != null && c.moveToFirst() && !c.isNull(0)) return c.getLong(0);
        } catch (Exception ignored) {
        } finally { if (c != null) c.close(); }
        return 0;
    }

    /** null when the path is unknown or unreadable (the caller turns that into a 404/403). */
    public String fileJson(String synthPath) {
        Uri u = resolve(synthPath);
        if (u == null) return null;
        try {
            String content = new String(readAll(u), "UTF-8");
            String name = nameMap.get(synthPath);
            if (name == null) name = displayNameOfDoc(u);
            JSONObject o = new JSONObject();
            o.put("path", synthPath);
            o.put("name", name);
            o.put("content", content);
            o.put("mtime", lastModified(u));
            return o.toString();
        } catch (Exception e) { return null; }
    }

    public byte[] rawBytes(String synthPath) {
        Uri u = resolve(synthPath);
        if (u == null) return null;
        try { return readAll(u); } catch (Exception e) { return null; }
    }

    // ---------------- search ----------------

    private void collect(JSONArray nodes, List<String> out) {
        for (int i = 0; i < nodes.length(); i++) {
            JSONObject n = nodes.optJSONObject(i);
            if (n == null) continue;
            if ("file".equals(n.optString("type"))) out.add(n.optString("path"));
            else collect(n.optJSONArray("children") == null ? new JSONArray() : n.optJSONArray("children"), out);
        }
    }

    public String searchJson(String q) {
        JSONArray results = new JSONArray();
        if (q == null || q.trim().length() < 2) {
            try { return new JSONObject().put("results", results).toString(); } catch (Exception e) { return "{\"results\":[]}"; }
        }
        String needle = q.trim().toLowerCase(Locale.ROOT);
        List<String> files = new ArrayList<>();
        try {
            JSONObject tree = new JSONObject(treeJson());
            collect(tree.optJSONArray("roots"), files);
        } catch (Exception ignored) { }

        for (String p : files) {
            if (results.length() >= MAX_RESULTS) break;
            String name = nameMap.get(p);
            if (name == null) name = p;
            boolean nameHit = name.toLowerCase(Locale.ROOT).contains(needle);
            String snippet = ""; int line = 0, count = 0; boolean contentHit = false;
            Uri u = pathMap.get(p);
            if (u != null) {
                try {
                    byte[] b = readAll(u);
                    if (b.length < MAX_SEARCH_BYTES) {
                        String text = new String(b, "UTF-8");
                        String lower = text.toLowerCase(Locale.ROOT);
                        int idx = lower.indexOf(needle);
                        if (idx >= 0) {
                            contentHit = true;
                            int start = Math.max(0, idx - 40);
                            int end = Math.min(text.length(), idx + needle.length() + 60);
                            snippet = text.substring(start, end).replaceAll("\\s+", " ").trim();
                            int nl = 0;
                            for (int i = 0; i < idx; i++) if (text.charAt(i) == '\n') nl++;
                            line = nl + 1;
                            int k = 0;
                            while ((k = lower.indexOf(needle, k)) >= 0) { count++; k += needle.length(); }
                        }
                    }
                } catch (Exception ignored) { }
            }
            if (nameHit || contentHit) {
                try {
                    JSONObject o = new JSONObject();
                    o.put("path", p); o.put("name", name); o.put("snippet", snippet);
                    o.put("line", line); o.put("count", count);
                    results.put(o);
                } catch (Exception ignored) { }
            }
        }
        try { return new JSONObject().put("results", results).toString(); }
        catch (Exception e) { return "{\"results\":[]}"; }
    }

    // ---------------- config + session ----------------

    public String configJson() {
        JSONArray roots = readList(KEY_ROOTS);
        JSONArray names = new JSONArray();
        for (int i = 0; i < roots.length(); i++) {
            JSONObject o = roots.optJSONObject(i);
            if (o != null) names.put("/" + o.optString("name"));
        }
        try {
            JSONObject o = new JSONObject();
            o.put("roots", names);
            if (initialFile == null) o.put("initialFile", JSONObject.NULL); else o.put("initialFile", initialFile);
            return o.toString();
        } catch (Exception e) { return "{\"roots\":[],\"initialFile\":null}"; }
    }

    public String getState() { return prefs().getString(KEY_STATE, "{}"); }

    public void setState(String json) {
        if (json == null) return;
        String t = json.trim();
        if (t.startsWith("{") || t.startsWith("[")) prefs().edit().putString(KEY_STATE, t).apply();
    }
}
