// Behaviour for the setup pages: each step posts JSON to /setup/api/* and then reloads /setup, which shows
// the next step. The last step of each flow shows its finished card in place.
(function () {
  const form = document.querySelector('form[data-step]');
  if (!form) return;
  const err = form.querySelector('.err');
  const submitBtn = form.querySelector('button[type=submit]');

  function showError(message) {
    err.textContent = message || '';
    err.hidden = !message;
  }

  async function post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-tessh-owner': '1' },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (!res.ok) throw new Error(data.message || 'Something went wrong. Try again.');
    return data;
  }

  function onSubmit(run) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      showError('');
      submitBtn.disabled = true;
      try {
        await run();
      } catch (x) {
        showError(x.message);
      } finally {
        submitBtn.disabled = false;
      }
    });
  }

  const next = () => location.assign('/setup');

  function showDone() {
    const done = document.querySelector('[data-done]');
    form.hidden = true;
    done.hidden = false;
    // Mounted once visible: the field needs the canvas's size.
    const tile = done.querySelector('canvas[data-tile]');
    if (tile && window.mountAscii) window.mountAscii(tile, { ramp: 'blue', shape: 'tile', cell: 9, glow: 0.6, mouse: false });
    const h = done.querySelector('h3');
    if (h) { h.tabIndex = -1; h.focus(); }
  }

  // ---- Setup code ----
  function code() {
    const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const boxes = Array.from(form.querySelectorAll('.code input'));
    const clean = (s) => s.toUpperCase().split('').filter((c) => ALPHABET.includes(c));
    function fill(from, chars) {
      let i = from;
      for (const c of chars) {
        if (i >= boxes.length) break;
        boxes[i++].value = c;
      }
      boxes[Math.min(i, boxes.length - 1)].focus();
    }
    boxes.forEach((box, i) => {
      box.addEventListener('input', () => {
        const chars = clean(box.value);
        box.value = '';
        if (chars.length) fill(i, chars);
      });
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Backspace' && !box.value && i > 0) { boxes[i - 1].value = ''; boxes[i - 1].focus(); e.preventDefault(); }
        else if (e.key === 'ArrowLeft' && i > 0) boxes[i - 1].focus();
        else if (e.key === 'ArrowRight' && i < boxes.length - 1) boxes[i + 1].focus();
      });
      box.addEventListener('paste', (e) => {
        e.preventDefault();
        fill(i, clean((e.clipboardData || window.clipboardData).getData('text')));
      });
    });
    onSubmit(async () => {
      const value = boxes.map((b) => b.value).join('');
      if (value.length < boxes.length) throw new Error('Type all 8 characters of the setup code.');
      await post('/setup/api/code', { code: value });
      next();
    });
  }

  // ---- Name and address ----
  function server() {
    const name = form.querySelector('#name');
    const address = form.querySelector('#address');
    const okt = form.querySelector('[data-check]');
    const warn = form.querySelector('[data-check-warn]');
    let seq = 0;
    let timer = 0;

    function status(kind, text) {
      okt.hidden = kind !== 'ok';
      if (kind === 'ok') okt.querySelector('span').textContent = text;
      warn.hidden = kind !== 'warn';
      warn.textContent = kind === 'warn' ? text : '';
    }

    async function check() {
      const raw = address ? address.value.trim() : form.dataset.address;
      let origin;
      try {
        const u = new URL(raw);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
        origin = u.origin;
      } catch (e) {
        status('', '');
        return;
      }
      const mine = ++seq;
      let same = false;
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 6000);
        const res = await fetch(origin + '/v1/server', { credentials: 'omit', cache: 'no-store', signal: ctl.signal });
        clearTimeout(t);
        const info = await res.json();
        same = res.ok && info.instance === form.dataset.instance;
      } catch (e) {
        same = false;
      }
      if (mine !== seq) return;
      if (!same) status('warn', "Can't reach this address from your browser");
      else if (origin.startsWith('https:')) status('ok', 'HTTPS');
      else status('warn', 'Not HTTPS yet: the apps need HTTPS');
    }

    if (address) address.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(check, 450); });
    check();
    if (name && !name.value) name.focus();

    onSubmit(async () => {
      await post('/setup/api/server', { name: name ? name.value : '', address: address ? address.value : '' });
      next();
    });
  }

  // ---- Owner login ----
  function owner() {
    const password = form.querySelector('#password');
    const strength = form.querySelector('[data-strength]');
    const toggle = form.querySelector('[data-totp-toggle]');
    const box = form.querySelector('[data-totp]');
    const secretEl = form.querySelector('[data-secret]');
    const uriEl = form.querySelector('[data-uri]');
    const codeEl = form.querySelector('#totp');
    let enrolled = false;

    password.addEventListener('input', () => {
      const p = password.value;
      if (!p) { strength.hidden = true; return; }
      const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(p)).length;
      const [text, weak] = p.length < 12 ? ['Too short', true] : p.length >= 16 || kinds >= 3 ? ['Strong', false] : ['OK', false];
      strength.querySelector('span').textContent = text;
      strength.classList.toggle('warn', weak);
      strength.hidden = false;
    });

    async function enrol() {
      if (enrolled) return;
      try {
        const { secret, uri } = await post('/setup/api/owner/totp', {});
        secretEl.textContent = secret.match(/.{1,4}/g).join(' ');
        uriEl.href = uri;
        enrolled = true;
      } catch (x) {
        showError(x.message);
      }
    }

    function setTotp(on) {
      toggle.setAttribute('aria-checked', String(on));
      box.hidden = !on;
      if (on) enrol();
    }
    toggle.addEventListener('click', () => setTotp(toggle.getAttribute('aria-checked') !== 'true'));
    setTotp(true);
    form.querySelector('#email').focus();

    onSubmit(async () => {
      const body = { email: form.querySelector('#email').value, password: password.value };
      if (toggle.getAttribute('aria-checked') === 'true') {
        const c = codeEl.value.replace(/\s/g, '');
        if (!c) throw new Error('Type the code from your authenticator app, or turn the authenticator off.');
        body.totpCode = c;
      }
      await post('/setup/api/owner', body);
      if (form.dataset.mode === 'owner') showDone();
      else next();
    });
  }

  // ---- Who can join ----
  function team() {
    const choices = Array.from(form.querySelectorAll('[data-signups]'));
    const sizes = Array.from(form.querySelectorAll('[data-bytes]'));
    const tags = form.querySelector('[data-tags]');
    const input = form.querySelector('[data-tag-input]');
    const names = [];

    function pick(list, el) {
      for (const x of list) {
        const on = x === el;
        x.classList.toggle('on', on);
        x.setAttribute('aria-checked', String(on));
      }
    }
    choices.forEach((c) => c.addEventListener('click', () => pick(choices, c)));
    sizes.forEach((s) => s.addEventListener('click', () => pick(sizes, s)));

    function drawTags() {
      tags.querySelectorAll('.tagc').forEach((t) => t.remove());
      names.forEach((n, i) => {
        const chip = document.createElement('span');
        chip.className = 'tagc';
        chip.textContent = n;
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.setAttribute('aria-label', 'Remove ' + n);
        x.addEventListener('click', () => { names.splice(i, 1); drawTags(); input.focus(); });
        chip.appendChild(x);
        tags.insertBefore(chip, input);
      });
    }
    function addName() {
      const n = input.value.trim();
      input.value = '';
      if (!n) return;
      if (names.length >= 20) { showError('Invite up to 20 people now; you can add more later.'); return; }
      names.push(n.slice(0, 64));
      drawTags();
    }
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addName(); }
      else if (e.key === 'Backspace' && !input.value && names.length) { names.pop(); drawTags(); }
    });
    input.addEventListener('blur', addName);

    const done = document.querySelector('[data-done]');
    const rowTemplate = document.querySelector('template[data-invite-row]');

    function copyButton(btn, text) {
      btn.addEventListener('click', async () => {
        const label = btn.querySelector('span');
        try {
          await navigator.clipboard.writeText(text);
          label.textContent = 'Copied';
        } catch (e) {
          label.textContent = 'Copy failed';
        }
        setTimeout(() => { label.textContent = 'Copy'; }, 1600);
      });
    }

    onSubmit(async () => {
      addName();
      const on = (list, key) => (list.find((x) => x.getAttribute('aria-checked') === 'true') || list[0]).dataset[key];
      const res = await post('/setup/api/team', {
        signups: on(choices, 'signups'),
        invites: names,
        defaultBytes: Number(on(sizes, 'bytes')),
      });
      const list = done.querySelector('[data-invites]');
      res.invites.forEach((inv, i) => {
        const row = rowTemplate.content.firstElementChild.cloneNode(true);
        const who = row.querySelector('.who');
        who.textContent = inv.label.charAt(0).toUpperCase();
        who.classList.add('c' + (i % 6));
        row.querySelector('b').textContent = inv.label;
        row.querySelector('small').textContent = inv.url.replace(/^https?:\/\//, '');
        copyButton(row.querySelector('[data-copy]'), inv.url);
        list.appendChild(row);
      });
      list.hidden = res.invites.length === 0;
      if (!res.invites.length) done.querySelector('[data-ready-sub]').textContent = 'Now connect your own apps.';
      done.querySelector('[data-owner-code]').textContent = res.ownerCode;
      showDone();
    });
  }

  ({ code, server, owner, team })[form.dataset.step]();
})();
