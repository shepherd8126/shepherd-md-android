# Shepherd Markdown | MD Reader - Android

A fast, offline reader for Markdown (`.md`) files. This is the Android build: a native
WebView shell around the **same** web UI used by the
[Windows](https://github.com/shepherd8126/shepherd-md-windows) and
[macOS](https://github.com/shepherd8126/shepherd-md-mac) builds.
Downloads: [shepherd-md-releases](https://github.com/shepherd8126/shepherd-md-releases/releases/latest).

## How it works

The desktop builds serve the UI from a tiny local HTTP server. Android forbids that style of
free-roaming file access (scoped storage), so instead:

- The UI is bundled in `assets/` and served through `WebViewAssetLoader`.
- `MainActivity.shouldInterceptRequest` answers every `/api/*` request **natively** - so the
  shared `app.js` keeps calling `fetch('/api/tree')` and `<img src="/api/raw?...">` unchanged.
- Folders and files are granted by the user through the **Storage Access Framework**. Each
  document gets a stable synthetic path (`/Notes/todo.md`) that maps back to its `content://` URI,
  which is what keeps the shared UI code identical across all three platforms.
- Request *bodies* are invisible to `shouldInterceptRequest`, so session saves (`PUT /api/state`)
  are re-routed through a small injected shim (`assets/android-bridge.js`).

## Install

Grab `Shepherd-Markdown.apk` from the
[latest release](https://github.com/shepherd8126/shepherd-md-releases/releases/latest).
Android will ask permission to install from this source the first time.

## Updates

The app checks the shared release feed on launch and shows an in-app banner when a newer
version exists. Tapping **Update now** downloads the new APK and hands it to the system
installer - Android always asks the user to confirm the install; that cannot be skipped
outside of Google Play.

Because updates install *over* the existing app, every release must be signed with the
**same** key (`ANDROID_KEYSTORE_BASE64` repo secret). Losing that key means existing installs
can never be updated again.

## Build

Built in CI - see `.github/workflows/build-apk.yml` (JDK 17 + Gradle 8.9 + Android SDK 34).
Locally you would need the Android SDK and then:

```bash
gradle assembleRelease
```

## Layout

- `app/src/main/java/com/shepherd/md/MainActivity.java` - WebView shell, `/api/*` interception,
  SAF pickers, update check + install.
- `app/src/main/java/com/shepherd/md/Store.java` - the document layer: SAF roots, synthetic paths,
  tree walking, reading, search, session storage.
- `app/src/main/assets/` - the shared web UI (synced from the Windows repo by `bin/sync-ui.ps1`).

## License

MIT - see [LICENSE](LICENSE).
