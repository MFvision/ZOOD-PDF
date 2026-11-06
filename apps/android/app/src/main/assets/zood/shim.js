/*
 * ZOOD PDF on Android: what the page needs from the phone, through
 * window.ZoodAndroid (app/src/main/java/sa/zood/pdf/Bridge.java).
 *
 * The editor loads this first in its <head> (MainActivity serves it); the phone
 * remote's page, which comes from the computer, gets it after it has loaded
 * (RemoteActivity). Both: download links and navigator.share reach Android's
 * save panel and share sheet. The editor also: files opened with or shared to
 * the app, printing, Back, and no service worker (the app's files are inside it).
 *
 * Plain script, no modules, no eval: the page's policy allows 'self' scripts only.
 */
(function () {
  'use strict';
  var bridge = window.ZoodAndroid;
  if (!bridge || window.__zoodShim) return;
  window.__zoodShim = true;
  var editor = false;
  try {
    editor = bridge.isEditor() === true;
  } catch (e) {
    editor = false;
  }
  window.__ZOOD_ANDROID__ = { version: String(bridge.version()), editor: editor };

  /* ------------------------------------------------ bytes out to Android */

  var CHUNK = 786432; // 768 KiB: a few MB of base64 per round trip at most
  var waiting = {};

  window.__zoodSaved = function (id, ok) {
    var done = waiting[id];
    delete waiting[id];
    if (done) done(ok === true);
  };

  function base64(bytes) {
    var text = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(text);
  }

  /** Hands a Blob to Android: the save panel, or the share sheet. Resolves true once it is done. */
  function hand(blob, name, type, share) {
    var id = bridge.saveBegin(String(name || 'document.pdf'), String(type || blob.type || ''));
    if (!id) return Promise.resolve(false);
    var at = 0;
    function next() {
      if (at >= blob.size) {
        return new Promise(function (resolve) {
          waiting[id] = resolve;
          if (!bridge.saveEnd(id, share === true)) {
            delete waiting[id];
            resolve(false);
          }
        });
      }
      var piece = blob.slice(at, at + CHUNK);
      at += CHUNK;
      return piece.arrayBuffer().then(function (buffer) {
        if (!bridge.saveChunk(id, base64(new Uint8Array(buffer)))) throw new Error('E_SAVE');
        return next();
      });
    }
    return next().catch(function () {
      bridge.saveCancel(id);
      return false;
    });
  }

  // The Blob behind each blob: URL the page makes, until revoked: a download
  // link names its bytes by one, and the page's policy may not let fetch read it.
  var blobs = new Map();
  var createURL = URL.createObjectURL.bind(URL);
  var revokeURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = function (object) {
    var url = createURL(object);
    if (object instanceof Blob) blobs.set(url, object);
    return url;
  };
  URL.revokeObjectURL = function (url) {
    // Kept a moment longer: the page revokes right after clicking, before the bytes are read.
    setTimeout(function () {
      blobs.delete(url);
      revokeURL(url);
    }, 60000);
  };

  function dataBlob(url) {
    var match = /^data:([^,;]*)(;[^,]*)?,(.*)$/s.exec(url);
    if (!match) return null;
    var type = match[1] || 'application/octet-stream';
    if (match[2] && match[2].indexOf(';base64') >= 0) {
      var binary = atob(match[3]);
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: type });
    }
    return new Blob([decodeURIComponent(match[3])], { type: type });
  }

  function blobOf(href) {
    var known = blobs.get(href);
    if (known) return Promise.resolve(known);
    if (href.indexOf('data:') === 0) return Promise.resolve(dataBlob(href));
    return fetch(href).then(function (response) {
      return response.ok ? response.blob() : null;
    });
  }

  function isDownload(link) {
    if (!link || !link.href) return false;
    if (link.hasAttribute('download')) return true;
    return link.href.indexOf('blob:') === 0 || link.href.indexOf('data:') === 0;
  }

  function download(link) {
    var name = link.getAttribute('download') || 'download';
    blobOf(link.href)
      .then(function (blob) {
        if (blob) return hand(blob, name, blob.type, false);
        return false;
      })
      .catch(function () {
        return false;
      });
  }

  var linkClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (isDownload(this)) {
      download(this);
      return;
    }
    return linkClick.call(this);
  };
  document.addEventListener(
    'click',
    function (event) {
      var link = event.target && event.target.closest ? event.target.closest('a') : null;
      if (link && isDownload(link)) {
        event.preventDefault();
        download(link);
      }
    },
    true,
  );

  // Share: Android's share sheet, for files (WhatsApp, Gmail, Drive…).
  if (typeof navigator.share !== 'function') {
    navigator.canShare = function (data) {
      return !!data && !!data.files && data.files.length > 0;
    };
    navigator.share = function (data) {
      if (!data || !data.files || data.files.length === 0) {
        return Promise.reject(new DOMException('Only files can be shared here', 'NotAllowedError'));
      }
      var file = data.files[0];
      return hand(file, file.name, file.type, true).then(function (ok) {
        if (!ok) throw new DOMException('Share failed', 'AbortError');
      });
    };
  }

  if (!editor) return;

  /* ------------------------------------------------------- the editor only */

  // The app's own files are inside the app: a service worker would only keep stale copies.
  try {
    if (navigator.serviceWorker) {
      Object.defineProperty(navigator.serviceWorker, 'register', {
        configurable: true,
        value: function () {
          return Promise.reject(new Error('Not used in the Android app'));
        },
      });
    }
  } catch (e) {
    // Nothing to stop.
  }

  window.print = function () {
    bridge.print(document.title || 'ZOOD PDF');
  };

  // Files opened with or shared to ZOOD PDF: read here, handed to the interface
  // once it says it is ready (packages/ui/src/core/host-android.ts).
  var reading = false;
  function takeIncoming() {
    if (reading || typeof window.__zoodOpenFiles !== 'function') return;
    var list;
    try {
      list = JSON.parse(bridge.takeIncoming());
    } catch (e) {
      return;
    }
    if (!list.length) return;
    reading = true;
    var files = [];
    var chain = Promise.resolve();
    list.forEach(function (item) {
      chain = chain.then(function () {
        return fetch(item.url)
          .then(function (response) {
            return response.ok ? response.blob() : null;
          })
          .then(function (blob) {
            if (blob) files.push(new File([blob], item.name, { type: item.type || blob.type }));
          })
          .catch(function () {
            return null;
          })
          .then(function () {
            bridge.doneIncoming(item.id);
          });
      });
    });
    chain.then(function () {
      reading = false;
      if (files.length > 0) window.__zoodOpenFiles(files);
      takeIncoming();
    });
  }
  window.addEventListener('zood:incoming', takeIncoming);
  window.addEventListener('zood:ready', takeIncoming);

  // Back: closes the menu or dialog that is open. With nothing open (or the
  // same thing still open after a second Back) the app steps aside.
  var lastOpen = null;
  var lastAt = 0;
  window.__zoodBack = function () {
    var open = document.querySelector(
      'dialog[open], [aria-modal="true"], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
    );
    if (!open) {
      lastOpen = null;
      return false;
    }
    var now = Date.now();
    if (open === lastOpen && now - lastAt < 1500) {
      lastOpen = null;
      return false;
    }
    lastOpen = open;
    lastAt = now;
    var target = document.activeElement && document.activeElement !== document.body ? document.activeElement : open;
    var init = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    return true;
  };
})();
