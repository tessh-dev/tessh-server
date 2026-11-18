// Panel appearance, applied before the first paint (loaded in <head> without defer). Every other page is
// always dark and never loads this. The choice is per browser: "dark" (default), "light" or "system".
(function () {
  const KEY = 'tessh.theme';
  const valid = (t) => (t === 'light' || t === 'system' ? t : 'dark');
  function apply(t) {
    t = valid(t);
    document.documentElement.dataset.theme = t;
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = t === 'light' ? 'light' : t === 'system' ? 'dark light' : 'dark';
    return t;
  }
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) { saved = null; }
  apply(saved);
  window.tesshTheme = {
    get: () => valid(document.documentElement.dataset.theme),
    set(t) {
      t = apply(t);
      try { localStorage.setItem(KEY, t); } catch (e) { /* private mode: this page only */ }
      return t;
    },
  };
})();
