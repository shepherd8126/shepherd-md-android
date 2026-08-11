/*
 * Android glue, injected by the native shell after the page loads.
 *
 * Reads (/api/tree, /api/file, ...) are answered natively by shouldInterceptRequest, so nothing
 * is needed for them. WRITES are the exception: Android cannot see a request body during
 * interception, so /api/state saves are re-routed through the JS bridge here.
 */
(function () {
  'use strict';
  var H = window.__androidHost;
  if (!H) return;

  window.__android = {
    pickFolder: function () { try { H.pickFolder(); } catch (e) {} },
    pickFile: function () { try { H.pickFile(); } catch (e) {} },
    installUpdate: function (url) { try { H.installUpdate(url || ''); } catch (e) {} }
  };

  function save(text) { try { H.setState(text); } catch (e) {} }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var url = (typeof input === 'string') ? input : (input && input.url) || '';
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      if (url.indexOf('/api/state') === 0 && (method === 'PUT' || method === 'POST')) {
        var body = init && init.body;
        if (typeof body === 'string') { save(body); return Promise.resolve(new Response('', { status: 204 })); }
        if (body && typeof body.text === 'function') {
          return body.text().then(function (t) { save(t); return new Response('', { status: 204 }); });
        }
      }
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };

  var origBeacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
  navigator.sendBeacon = function (url, data) {
    try {
      if (String(url).indexOf('/api/state') === 0) {
        if (typeof data === 'string') { save(data); return true; }
        if (data && typeof data.text === 'function') { data.text().then(save).catch(function () {}); return true; }
      }
    } catch (e) {}
    return origBeacon ? origBeacon(url, data) : false;
  };

  // the shell calls this when the app is backgrounded; app.js already saves on 'pagehide'
  window.__flushState = function () { try { window.dispatchEvent(new Event('pagehide')); } catch (e) {} };
})();
