// The page the desktop app's welcome tour code leads to (/app/).
//
// IPHONE_LINK is the phone app's App Store page (also APP_STORE_URL in js/story.js). Put the TestFlight
// public link here now, or the App Store link once the app is approved, and
// upload the site: an iPhone or iPad that scans the code then goes straight
// to it, and the button below shows. Nothing in the desktop app changes.
// While it is null, the page says the app is coming and how to connect with
// the camera instead.
var IPHONE_LINK = 'https://apps.apple.com/app/id6816571917';
// ANDROID_LINK is the Android app's Google Play page (also PLAY_STORE_URL in js/story.js).
var ANDROID_LINK = 'https://play.google.com/store/apps/details?id=sa.zood.pdf';

(function () {
  var ua = navigator.userAgent;
  // iPadOS asks for the desktop site and calls itself a Mac; it has touch.
  var apple = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (IPHONE_LINK && apple) {
    location.replace(IPHONE_LINK);
    return;
  }
  if (ANDROID_LINK && /Android/i.test(ua)) {
    location.replace(ANDROID_LINK);
    return;
  }
  var english = !/^ar\b/i.test(navigator.language || '');
  document.addEventListener('DOMContentLoaded', function () {
    if (english) {
      document.documentElement.lang = 'en';
      document.documentElement.dir = 'ltr';
      document.title = 'ZOOD PDF on your phone';
      document.querySelectorAll('[data-en]').forEach(function (el) {
        if (el.dataset.ar !== undefined && el.tagName === 'IMG') {
          el.src = el.dataset.en;
          el.alt = 'ZOOD PDF';
        } else {
          el.textContent = el.dataset.en;
        }
        if (el.dataset.enHref) el.setAttribute('href', el.dataset.enHref);
      });
    }
    if (IPHONE_LINK) {
      var store = document.getElementById('pa-store');
      store.href = IPHONE_LINK;
      store.hidden = false;
      document.getElementById('pa-soon').hidden = true;
    }
  });
})();
