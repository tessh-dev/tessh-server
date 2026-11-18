// The Tessh one-time code field: one real input behind a row of cells, so typing, deleting, pasting and
// autofill all just work. Each character rolls into its cell on a rising wash of colour; a deleted one drops
// out. A rail and a status line keep count underneath. When the code is complete a light scans the cells
// while it is checked, then the cells flip over one by one, or shake and clear if the code is wrong.
// Optional clicks are synthesized (no audio files) and only ever play after the person typed or pasted.
// Reduced motion: the CSS cuts every animation short.
//
// window.TesshCode.create(opts) (or mount(placeholder, opts)) returns { el, input, value, state, focus(), reset(), check(), setDisabled() }.
// opts: length (6), charset ("digits" | "code"), groups (e.g. [4, 4]), label, name (the input's form name),
// sound (true), onComplete(code), onAccepted(code), minCheckMs (1100), text ({ idle, checking, ok, bad }).
// onComplete may return false (wrong code), a string (rejected, with that status text), null (not checked:
// back to idle with the code kept) or a promise of any of these. Anything else accepts the code. A throw
// counts as a wrong code.
(function () {
  // ---- Clicks: a few milliseconds of noise through a narrow band-pass filter ----
  let audio = null;
  let hiss = null;

  // Creates (or resumes) the audio context, only inside a trusted user event.
  function armClicks(e) {
    if (!e.isTrusted) return !!audio;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      if (!audio) {
        audio = new Ctx();
        // iOS only lets audio start inside a gesture: play one silent sample now to unlock it.
        const quiet = audio.createBufferSource();
        quiet.buffer = audio.createBuffer(1, 1, audio.sampleRate);
        quiet.connect(audio.destination);
        quiet.start(0);
      }
      if (audio.state !== 'running') audio.resume();
      return true;
    } catch (x) {
      return false;
    }
  }

  function click(pitch, o) {
    if (!audio) return; // never armed by the person: stay quiet
    const opt = Object.assign({ length: 0.03, volume: 0.5, delay: 0, sharp: 6 }, o);
    try {
      if (!hiss) {
        hiss = audio.createBuffer(1, audio.sampleRate * 0.2, audio.sampleRate);
        const data = hiss.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      }
      const start = audio.currentTime + opt.delay;
      const source = audio.createBufferSource();
      const filter = audio.createBiquadFilter();
      const gain = audio.createGain();
      source.buffer = hiss;
      filter.type = 'bandpass';
      filter.frequency.value = pitch || 2400;
      filter.Q.value = opt.sharp;
      gain.gain.setValueAtTime(opt.volume, start);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + opt.length);
      source.connect(filter).connect(gain).connect(audio.destination);
      source.start(start, Math.random() * 0.1);
      source.stop(start + opt.length + 0.01);
    } catch (x) {
      // No audio available: stay quiet.
    }
  }

  const CLICKS = {
    // Each key clicks a little brighter than the last.
    type: (i) => click(2200 + i * 260),
    erase: () => click(1100, { length: 0.04, volume: 0.4 }),
    // Accepted: a lock turning. Five quick ratchet clicks, then the bolt.
    ok: () => {
      for (let i = 0; i < 5; i++) click(2600 + i * 300, { delay: i * 0.045, length: 0.02, volume: 0.35 });
      click(900, { delay: 0.27, length: 0.09, volume: 0.7, sharp: 3 });
      click(3400, { delay: 0.27, length: 0.03, volume: 0.4 });
    },
    // Rejected: two dull knocks.
    bad: () => [0, 0.14].forEach((delay) => click(320, { delay, length: 0.08, volume: 0.8, sharp: 2 })),
  };

  // ---- Characters ----
  const SETUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const cleaners = {
    digits: (v, n) => v.replace(/\D/g, '').slice(0, n),
    code: (v, n) => v.toUpperCase().split('').filter((c) => SETUP_ALPHABET.includes(c)).join('').slice(0, n),
  };

  function statusText(state, filled, length, charset, text) {
    if (text && text[state]) return text[state];
    switch (state) {
      case 'checking': return 'Checking';
      case 'ok': return 'Code accepted';
      case 'bad': return 'That code isn’t right';
      default:
        return filled ? filled + ' of ' + length : 'Enter the ' + length + (charset === 'code' ? '-character code' : '-digit code');
    }
  }

  const NS = 'http://www.w3.org/2000/svg';
  const BAD_CLEAR_MS = 1300;

  function tick() {
    const svg = document.createElementNS(NS, 'svg');
    const attrs = { width: '14', height: '14', viewBox: '0 0 14 14', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
    for (const k in attrs) svg.setAttribute(k, attrs[k]);
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', 'M2.5 7.5l3 3 6-6.5');
    svg.append(p);
    return svg;
  }

  // Where a gap goes: before each group after the first. No groups: the middle of an even code over 4.
  function splits(length, groups) {
    const at = new Set();
    if (Array.isArray(groups) && groups.length > 1) {
      let sum = 0;
      for (let g = 0; g < groups.length - 1; g++) { sum += groups[g]; if (sum > 0 && sum < length) at.add(sum); }
    } else if (!groups && length % 2 === 0 && length > 4) at.add(length / 2);
    return at;
  }

  function create(opts) {
    opts = opts || {};
    const length = opts.length || 6;
    const charset = opts.charset === 'code' ? 'code' : 'digits';
    const clean = cleaners[charset];
    const sound = opts.sound !== false;
    const minCheck = opts.minCheckMs == null ? 1100 : opts.minCheckMs;
    const gaps = splits(length, opts.groups);

    let code = '';
    let focused = false;
    let state = 'idle';
    let badText;
    let run = 0;
    let timer = 0;
    let saying = '';

    const root = document.createElement('label');
    root.className = 'ui-otp';
    root.dataset.charset = charset;
    const cellsBox = document.createElement('span');
    cellsBox.className = 'ui-otp-cells';
    const input = document.createElement('input');
    if (charset === 'code') {
      input.inputMode = 'text';
      input.autocomplete = 'off';
      input.setAttribute('autocapitalize', 'characters');
    } else {
      input.inputMode = 'numeric';
      input.autocomplete = 'one-time-code';
      input.setAttribute('autocapitalize', 'off');
    }
    if (opts.name) input.name = opts.name;
    input.setAttribute('aria-label', opts.label || 'Verification code');
    input.spellcheck = false;
    input.setAttribute('autocorrect', 'off');
    input.maxLength = length + 4; // room for a pasted "482 913" or "ABCD-EFGH"
    cellsBox.append(input);

    const cells = Array.from({ length }, (_, i) => {
      const cell = document.createElement('span');
      cell.className = 'ui-otp-cell';
      cell.setAttribute('aria-hidden', 'true');
      cell.style.setProperty('--i', String(i));
      if (gaps.has(i)) cell.dataset.split = 'true';
      const slot = document.createElement('span');
      slot.className = 'ui-otp-slot';
      slot.style.display = 'contents';
      const pip = document.createElement('u');
      pip.className = 'ui-otp-pip';
      cell.append(slot, pip);
      cellsBox.append(cell);
      return { cell, slot, ch: '', caret: false };
    });
    const scan = document.createElement('i');
    scan.className = 'ui-otp-scan';
    scan.setAttribute('aria-hidden', 'true');
    const rail = document.createElement('span');
    rail.className = 'ui-otp-rail';
    rail.setAttribute('aria-hidden', 'true');
    const status = document.createElement('span');
    status.className = 'ui-otp-status';
    status.setAttribute('aria-live', 'polite');
    root.append(cellsBox, rail, status);

    function render() {
      root.dataset.state = state;
      root.style.setProperty('--done', String(code.length / length));
      const active = Math.min(code.length, length - 1);
      cells.forEach((c, i) => {
        const live = focused && state === 'idle' && i === active && !input.disabled;
        c.cell.dataset.filled = String(i < code.length);
        c.cell.dataset.active = String(live);
        const d = code[i] || '';
        const caret = !d && live;
        if (d !== c.ch || caret !== c.caret) {
          c.ch = d;
          c.caret = caret;
          if (d) {
            const b = document.createElement('b');
            b.textContent = d;
            c.slot.replaceChildren(b);
          } else if (caret) {
            const k = document.createElement('i');
            k.className = 'ui-otp-caret';
            c.slot.replaceChildren(k);
          } else c.slot.replaceChildren();
        }
      });
      if (state === 'checking') {
        if (!scan.isConnected) cellsBox.append(scan);
      } else scan.remove();

      const says = state === 'bad' && badText ? badText : statusText(state, code.length, length, charset, opts.text);
      if (says !== saying) {
        saying = says;
        const s = document.createElement('span');
        if (state === 'ok') s.append(tick());
        s.append(says);
        if (state === 'checking') {
          const dots = document.createElement('span');
          dots.className = 'ui-otp-dots';
          dots.setAttribute('aria-hidden', 'true');
          for (let i = 0; i < 3; i++) {
            const d = document.createElement('i');
            d.style.setProperty('--i', String(i));
            dots.append(d);
          }
          s.append(dots);
        }
        status.replaceChildren(s);
      }
    }

    function ghost(at, ch) {
      const s = document.createElement('s');
      s.className = 'ui-otp-ghost';
      s.textContent = ch;
      const done = () => s.remove();
      s.addEventListener('animationend', done);
      window.setTimeout(done, 600);
      if (cells[at]) cells[at].cell.insertBefore(s, cells[at].cell.lastChild);
    }

    async function check(full) {
      const mine = ++run;
      clearTimeout(timer);
      state = 'checking';
      badText = undefined;
      render();
      const results = await Promise.all([
        Promise.resolve()
          .then(() => (opts.onComplete ? opts.onComplete(full) : undefined))
          .catch(() => false),
        new Promise((done) => setTimeout(done, minCheck)),
      ]);
      const verdict = results[0];
      if (mine !== run) return; // edited while it was being checked
      if (verdict === null) {
        state = 'idle';
        render();
      } else if (verdict === false || typeof verdict === 'string') {
        state = 'bad';
        badText = typeof verdict === 'string' ? verdict : undefined;
        if (sound) CLICKS.bad();
        render();
        timer = window.setTimeout(() => {
          if (mine !== run) return;
          code = '';
          input.value = '';
          state = 'idle';
          render();
        }, BAD_CLEAR_MS);
      } else {
        state = 'ok';
        input.readOnly = true;
        if (sound) CLICKS.ok();
        render();
        if (opts.onAccepted) opts.onAccepted(full);
      }
    }

    const toEnd = () => {
      try {
        input.setSelectionRange(input.value.length, input.value.length);
      } catch (x) {
        // not focusable right now
      }
    };

    input.addEventListener('input', (e) => {
      if (state === 'ok') return;
      const next = clean(input.value, length);
      if (input.value !== next) input.value = next;
      if (next === code) return;
      run++;
      clearTimeout(timer);
      const armed = sound && armClicks(e);
      if (next.length > code.length) {
        if (armed) CLICKS.type(next.length - 1);
      } else {
        if (armed) CLICKS.erase();
        ghost(next.length, code[next.length]);
      }
      code = next;
      if (code.length === length) check(code);
      else {
        state = 'idle';
        badText = undefined;
        render();
      }
    });
    // Typing on a phone keyboard may not count as a gesture for audio, so a tap or key press arms it too.
    if (sound) {
      const arm = (e) => { armClicks(e); };
      root.addEventListener('pointerdown', arm);
      root.addEventListener('touchend', arm);
      input.addEventListener('keydown', arm);
    }
    input.addEventListener('focus', () => {
      focused = true;
      toEnd();
      render();
    });
    input.addEventListener('blur', () => {
      focused = false;
      render();
    });
    input.addEventListener('click', toEnd);
    // Keep the caret at the end, except for select-all (Cmd+A, or a paste over the lot): that replaces the code.
    input.addEventListener('select', () => {
      if (!(input.selectionStart === 0 && input.selectionEnd === input.value.length)) toEnd();
    });

    render();

    return {
      el: root,
      input,
      get value() { return code; },
      get state() { return state; },
      focus: () => input.focus({ preventScroll: true }),
      // Clears the code and goes back to idle.
      reset() {
        run++;
        clearTimeout(timer);
        code = '';
        input.value = '';
        input.readOnly = false;
        state = 'idle';
        badText = undefined;
        render();
      },
      // Checks the code again (for a Continue button). False when it isn't complete or is already being checked.
      check() {
        if (code.length !== length || state === 'checking' || state === 'ok') return false;
        check(code);
        return true;
      },
      setDisabled(disabled) {
        input.disabled = disabled;
        root.setAttribute('aria-disabled', String(disabled));
        render();
      },
    };
  }

  // Builds a field into a placeholder such as <div data-otp data-length="8" data-charset="code" data-groups="4,4"
  // data-label="Setup code" data-name="code">, so the page's HTML stays free of inline script.
  function mount(box, opts) {
    const d = box.dataset;
    const field = create(Object.assign({
      length: d.length ? Number(d.length) : undefined,
      charset: d.charset,
      groups: d.groups ? d.groups.split(',').map(Number) : undefined,
      label: d.label,
      name: d.name,
    }, opts));
    box.replaceChildren(field.el);
    return field;
  }

  window.TesshCode = { create, mount };
})();
