// Tessh ASCII field: our own renderer (no third-party code).
// A soft light field (arc + glow, drifting with value noise) drawn as monospace glyphs on a grid.
// mountAscii(canvas, opts) -> stop()
(function () {
  const RAMPS = {
    blue: ['#0b1a5e', '#1e3fd8', '#2f8fe0', '#7cc4ff'],
    blueLight: ['#c9d8ff', '#6f8ff0', '#2f5fe0', '#1e3fd8'],
    aurora: ['#3b2a6e', '#a78bfa', '#60a5fa', '#4ade80'],
    mono: ['#1a1a1a', '#3a3a3a', '#6f6f6f', '#bdbdbd'],
  };
  function hex(h) { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  function ramp(stops, t) {
    t = Math.max(0, Math.min(1, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(t)), f = t - i;
    const a = stops[i], b = stops[i + 1];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
  }
  // value noise
  function h2(x, y) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
  function noise(x, y) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = h2(xi, yi), b = h2(xi + 1, yi), c = h2(xi, yi + 1), d = h2(xi + 1, yi + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function mountAscii(canvas, o = {}) {
    const opt = Object.assign({ ramp: 'blue', cell: 14, shape: 'horizon', strength: 1, glyphs: ' .:-=+*xX#', light: false, veil: 0, glow: 0.55, ink: 0.85, speed: 1, static: false, mouse: true }, o);
    const stops = (Array.isArray(opt.ramp) ? opt.ramp : RAMPS[opt.ramp]).map(hex);
    const ctx = canvas.getContext('2d');
    let off = null, w = 0, h = 0, dpr = 1, raf = 0, t0 = performance.now(), mx = -1, my = -1, scr = new Map();
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    function size() {
      dpr = Math.min(2, devicePixelRatio || 1);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = Math.max(1, w * dpr); canvas.height = Math.max(1, h * dpr);
    }
    function field(nx, ny, t) {
      // nx 0..1 across, ny 0..1 down
      const wob = (noise(nx * 3 + t * 0.07, ny * 3 - t * 0.05) - 0.5) * 0.18;
      let v;
      if (opt.shape === 'rise') {
        const dx = (nx - 0.5) * 1.3, dy = (ny - 1.05) * 1.6;
        v = Math.exp(-(dx * dx + dy * dy) * 2.2) * 1.15;
      } else if (opt.shape === 'tile') {
        const dx = nx - 0.5, dy = ny - 0.95;
        v = Math.exp(-(dx * dx * 2.5 + dy * dy * 3.2)) * 1.25;
      } else {
        // horizon: a bright band that bows up at the edges, brightest top-centre
        const bow = 0.30 - 0.22 * Math.pow((nx - 0.5) * 2, 2);
        const d = (ny - bow + wob) / 0.13;
        v = Math.exp(-d * d) * (0.55 + 0.5 * Math.exp(-((nx - 0.5) ** 2) * 9));
        v += Math.exp(-((nx - 0.5) ** 2 * 5 + (ny - 0.05) ** 2 * 14)) * 0.45;
        v *= 0.9 + 0.35 * noise(nx * 4 - t * 0.1, ny * 4);
      }
      v += (noise(nx * 14 - t * 0.12, ny * 14 + t * 0.09) - 0.5) * 0.22;
      return v * opt.strength;
    }
    function draw(now) {
      const t = opt.static || reduce ? 3 : (now - t0) / 1000 * opt.speed;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const cw = opt.cell * 0.62, ch = opt.cell;
      const cols = Math.ceil(w / cw), rows = Math.ceil(h / ch);
      ctx.font = `500 ${opt.cell * 0.86}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.textBaseline = 'top';
      const G = opt.glyphs, n = G.length - 1;
      // 1. field grid
      const V = new Float32Array(cols * rows);
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const nx = (c + 0.5) / cols, ny = (r + 0.5) / rows;
        let v = field(nx, ny, t);
        if (opt.veil) {
          const vx = (nx - 0.5) / 0.32, vy = (ny - opt.veilY) / 0.22;
          v *= 1 - opt.veil * Math.exp(-(vx * vx + vy * vy));
        }
        V[r * cols + c] = v;
      }
      // 2. soft colour glow under the glyphs (the field, blurred)
      if (opt.glow > 0) {
        if (!off) { off = document.createElement('canvas'); }
        if (off.width !== cols || off.height !== rows) { off.width = cols; off.height = rows; }
        const ox = off.getContext('2d'), img = ox.createImageData(cols, rows);
        for (let i = 0; i < V.length; i++) {
          const v = Math.max(0, V[i]), [R, Gc, B] = ramp(stops, v * 0.9);
          img.data[i * 4] = R; img.data[i * 4 + 1] = Gc; img.data[i * 4 + 2] = B;
          img.data[i * 4 + 3] = Math.min(255, v * v * 255 * opt.glow);
        }
        ox.putImageData(img, 0, 0);
        ctx.save(); ctx.imageSmoothingEnabled = true; ctx.filter = `blur(${opt.cell * 1.4}px)`;
        ctx.drawImage(off, 0, 0, cols * cw, rows * ch); ctx.restore();
      }
      // 3. glyphs
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let v = V[r * cols + c] * opt.ink;
          v += (h2(c + Math.floor(t * 2) * 0.37, r) - 0.5) * 0.16 * (v > 0.1 ? 1 : 0);
          if (v < 0.1) continue;
          let gi = Math.min(n, Math.max(1, Math.round(v * n)));
          const key = r * 9999 + c;
          if (scr.has(key)) gi = 1 + Math.floor(Math.random() * n);
          const [R, Gc, B] = ramp(stops, v);
          const a = Math.min(0.95, Math.pow(v, 1.3) * 0.95);
          ctx.fillStyle = `rgba(${R | 0},${Gc | 0},${B | 0},${a})`;
          ctx.fillText(G[gi], c * cw, r * ch);
        }
      }
      // decay scramble
      for (const [k, life] of scr) { if (life <= 1) scr.delete(k); else scr.set(k, life - 1); }
      if (!opt.static && !reduce) raf = requestAnimationFrame(draw);
    }
    function move(e) {
      if (!opt.mouse || reduce) return;
      const b = canvas.getBoundingClientRect();
      const x = e.clientX - b.left, y = e.clientY - b.top;
      if (x < 0 || y < 0 || x > b.width || y > b.height) return;
      const cw = opt.cell * 0.62, ch = opt.cell;
      const c0 = Math.floor(x / cw), r0 = Math.floor(y / ch);
      for (let dr = -2; dr <= 2; dr++) for (let dc = -3; dc <= 3; dc++) if (dr * dr + dc * dc / 2 < 5) scr.set((r0 + dr) * 9999 + c0 + dc, 12);
    }
    opt.veilY = opt.veilY ?? 0.42;
    size();
    const ro = new ResizeObserver(() => { size(); if (opt.static || reduce) draw(performance.now()); });
    ro.observe(canvas);
    addEventListener('pointermove', move);
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); removeEventListener('pointermove', move); };
  }
  window.mountAscii = mountAscii;

  // Auto-mount every canvas[data-field]; mount again when the colour scheme changes.
  const scheme = matchMedia('(prefers-color-scheme: light)');
  let stops = [];
  function mountAll() {
    stops.forEach((stop) => stop());
    stops = [];
    const light = scheme.matches;
    const base = { ramp: light ? 'blueLight' : 'blue', glow: light ? 0.25 : 0.55, ink: light ? 0.7 : 0.85, mouse: true };
    document.querySelectorAll('canvas[data-field]').forEach((cv) => {
      const kind = cv.dataset.field;
      if (kind === 'moment') stops.push(mountAscii(cv, Object.assign({}, base, { shape: 'horizon', veil: 0.97, veilY: 0.52, cell: 13, strength: 0.85 })));
      else if (kind === 'tile') stops.push(mountAscii(cv, { ramp: 'blue', shape: 'tile', cell: 9, glow: 0.6, mouse: false }));
      else if (kind === 'top') stops.push(mountAscii(cv, Object.assign({}, base, { shape: 'horizon', cell: 12 })));
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();
  scheme.addEventListener('change', mountAll);
})();
