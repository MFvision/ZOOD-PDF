// Runs before the page paints: applies the chosen theme so nothing flashes.
// The choice is kept in this browser only (localStorage), never sent anywhere.
(function () {
  try {
    var theme = localStorage.getItem('zood-site-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch (e) {
    /* storage blocked: Auto */
  }
  document.documentElement.classList.add('js');
})();
