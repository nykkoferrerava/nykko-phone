// Runs before the first paint (a classic script in <head>), so a forced Light or Dark theme never
// flashes the other one. The colours match --bg in app.css; keep them in sync.
(function () {
  var BG = { light: '#f2f2f6', dark: '#000000' };
  var root = document.documentElement;
  var theme = 'system';
  try { theme = localStorage.getItem('pitaka.ui.theme') || 'system'; } catch (e) { /* storage blocked: follow the system */ }
  if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
  // A forced theme gets one theme-color meta without a media query; "system" keeps both.
  if (theme === 'light' || theme === 'dark') {
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].parentNode.removeChild(metas[i]);
    var m = document.createElement('meta');
    m.name = 'theme-color';
    m.content = BG[theme];
    document.head.appendChild(m);
  }
})();
