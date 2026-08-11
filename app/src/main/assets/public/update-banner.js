/*
 * Update nudge - shared by the Windows and macOS builds.
 * The host (native Windows exe / Electron main) checks a release feed on launch and,
 * if a newer version exists, calls window.__updateAvailable({version, notes, url}).
 * This file only renders the banner and sends the "update" action back to the host.
 * Self-contained: theme-aware inline styles, no dependency on app.js.
 */
(function () {
  'use strict';

  function btnStyle(primary) {
    var base = 'padding:7px 15px;border-radius:999px;font-size:12.5px;line-height:1.2;cursor:pointer;white-space:nowrap;font-family:inherit;border:1px solid var(--border-strong,#4b4841);transition:filter .15s,background .15s;';
    return primary
      ? base + 'background:var(--accent,#d97757);color:var(--on-accent,#2a1710);border-color:var(--accent,#d97757);font-weight:500;'
      : base + 'background:transparent;color:var(--fg,#ece9e0);';
  }

  if (!document.getElementById('smd-up-kf')) {
    var kf = document.createElement('style');
    kf.id = 'smd-up-kf';
    kf.textContent = '@keyframes smdUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}';
    document.head.appendChild(kf);
  }

  window.__updateAvailable = function (info) {
    try {
      if (!info || !info.version) return;
      if (localStorage.getItem('smd-update-skip') === info.version) return; // "Later" was chosen for this version

      var existing = document.getElementById('update-banner');
      if (existing) existing.remove();
      window.__smdUpdateInfo = info;

      var bar = document.createElement('div');
      bar.id = 'update-banner';
      bar.setAttribute('style',
        'position:fixed;left:0;right:0;bottom:18px;margin:0 auto;z-index:13000;width:max-content;max-width:calc(100% - 32px);' +
        'display:flex;align-items:center;gap:14px;padding:12px 14px 12px 18px;border-radius:14px;' +
        'background:var(--bg-2,#1f1e1d);color:var(--fg,#ece9e0);border:1px solid var(--border,#3a3833);' +
        'box-shadow:0 10px 34px rgba(0,0,0,.4);font-family:"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;' +
        'font-size:13px;animation:smdUp .25s cubic-bezier(.2,.7,.3,1);');

      var msg = document.createElement('div');
      msg.style.cssText = 'flex:1;min-width:0;';
      var title = document.createElement('div');
      title.style.cssText = 'font-weight:500;';
      title.textContent = 'Shepherd Markdown ' + info.version + ' is available';
      msg.appendChild(title);
      if (info.notes) {
        var notes = document.createElement('div');
        notes.style.cssText = 'color:var(--fg-2,#a8a295);font-size:12px;margin-top:2px;max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
        notes.textContent = info.notes;
        notes.title = info.notes;
        msg.appendChild(notes);
      }
      bar.appendChild(msg);

      var later = document.createElement('button');
      later.textContent = 'Later';
      later.setAttribute('style', btnStyle(false));
      var update = document.createElement('button');
      update.textContent = 'Update now';
      update.setAttribute('style', btnStyle(true));
      bar.appendChild(later);
      bar.appendChild(update);
      document.body.appendChild(bar);

      later.onclick = function () {
        try { localStorage.setItem('smd-update-skip', info.version); } catch (_) {}
        bar.remove();
      };
      update.onclick = function () {
        title.textContent = 'Downloading update…';
        if (bar.contains(later)) later.remove();
        update.disabled = true;
        update.style.opacity = '.6';
        update.style.cursor = 'default';
        if (window.chrome && window.chrome.webview) {
          window.chrome.webview.postMessage({ cmd: 'update' });
        } else if (window.__android && window.__android.installUpdate) {
          window.__android.installUpdate(info.url || '');
          title.textContent = 'Downloading… then confirm the install.';
        } else if (window.__electron && window.__electron.installUpdate) {
          window.__electron.installUpdate(info.url || '');
          title.textContent = 'Opening download… drag the new app into Applications.';
        }
      };
    } catch (_) {}
  };

  // called by the Windows host if the download fails - re-show the banner so the user can retry
  window.__updateFailed = function () {
    var info = window.__smdUpdateInfo;
    if (!info) return;
    try { localStorage.removeItem('smd-update-skip'); } catch (_) {}
    window.__updateAvailable(info);
    var t = document.querySelector('#update-banner div');
    if (t) t.textContent = 'Update download failed - try again';
  };
})();
