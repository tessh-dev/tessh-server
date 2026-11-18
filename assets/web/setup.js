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
    if (!res.ok) {
      const x = new Error(data.message || 'Something went wrong. Try again.');
      x.code = data.error;
      x.status = res.status;
      throw x;
    }
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

  // ---- Setup code: checked as soon as all 8 characters are in ----
  function code() {
    const field = window.TesshCode.mount(form.querySelector('[data-otp]'), {
      text: { bad: 'That code didn’t work' },
      async onComplete(value) {
        showError('');
        try {
          await post('/setup/api/code', { code: value });
          return true;
        } catch (x) {
          // A plain wrong code shakes; anything else (expired, too many tries) says what happened.
          if (x.code === 'setup_code_wrong' && x.message === "That code isn't right.") return false;
          return x.message;
        }
      },
      onAccepted: () => setTimeout(next, 500),
    });
    // Enter (or a screen reader's submit) checks a complete code again.
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!field.check()) field.focus();
    });
    field.focus();
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
    let enrolled = false;
    let sending = false;

    function details() {
      return { email: form.querySelector('#email').value, password: password.value };
    }
    function finish() {
      if (form.dataset.mode === 'owner') showDone();
      else next();
    }
    // A complete code sends the whole step. Until the email and password are in, it just waits.
    const field = window.TesshCode.mount(form.querySelector('[data-otp]'), {
      text: { bad: 'That code didn’t work' },
      async onComplete(value) {
        const body = details();
        if (sending) return null;
        if (!body.email || !body.password) {
          showError('Fill in your email and password, then press Continue.');
          return null;
        }
        showError('');
        sending = true;
        submitBtn.disabled = true;
        try {
          await post('/setup/api/owner', Object.assign(body, { totpCode: value }));
          return true;
        } catch (x) {
          if (x.code === 'invalid_code') return false;
          showError(x.message);
          return null;
        } finally {
          sending = false;
          submitBtn.disabled = false;
        }
      },
      onAccepted: () => setTimeout(finish, 500),
    });

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
      if (toggle.getAttribute('aria-checked') === 'true') {
        // The code field sends the step itself, with its check and tick.
        if (field.value.length < 6) {
          field.focus();
          throw new Error('Type the code from your authenticator app, or turn the authenticator off.');
        }
        field.check();
        return;
      }
      await post('/setup/api/owner', details());
      finish();
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
