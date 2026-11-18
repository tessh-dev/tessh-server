// Behaviour for the panel pages. The pages are rendered on the server; this adds the writes (JSON to
// /admin/api/* with the panel header), copy buttons, confirm dialogs and segmented controls. After a change the
// page reloads to show it. Text from the server is only ever set with textContent.
(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  class ApiError extends Error {
    constructor(message, code) {
      super(message);
      this.code = code;
    }
  }

  async function call(method, path, body) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-tessh-owner': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { data = {}; }
    if (res.status === 401 && data.error === 'unauthorized') {
      location.assign('/admin/login');
      throw new ApiError('Sign in again', data.error);
    }
    if (!res.ok) throw new ApiError(data.message || 'Something went wrong. Try again.', data.error);
    return data;
  }

  // ---- Toast ----
  const toast = $('[data-toast]');
  let toastTimer = 0;
  function say(message, bad) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.toggle('bad', !!bad);
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, bad ? 5000 : 2200);
  }

  const after = (then) => (then ? location.assign(then) : location.reload());

  // ---- Copy ----
  $$('[data-copy]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!b.dataset.copy) return;
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        const label = $('span', b);
        if (label) {
          const was = label.textContent;
          label.textContent = 'Copied';
          setTimeout(() => { label.textContent = was; }, 1500);
        } else say('Copied');
      } catch (x) {
        say("Couldn't copy. Select the text and copy it instead.", true);
      }
    });
  });

  // ---- Storage bars ----
  $$('[data-pct]').forEach((i) => { i.style.width = Math.max(0, Math.min(100, Number(i.dataset.pct))) + '%'; });

  // ---- Confirm dialog ----
  const confirmDlg = $('dialog[data-dialog=confirm]');
  function ask(title, text, okLabel, danger) {
    if (!confirmDlg) return Promise.resolve(true);
    $('[data-c-title]', confirmDlg).textContent = title;
    $('[data-c-text]', confirmDlg).textContent = text || '';
    const ok = $('[data-c-ok]', confirmDlg);
    ok.textContent = okLabel || 'OK';
    ok.classList.toggle('danger', !!danger);
    confirmDlg.returnValue = '';
    confirmDlg.showModal();
    return new Promise((resolve) => confirmDlg.addEventListener('close', () => resolve(confirmDlg.returnValue === 'yes'), { once: true }));
  }
  function confirmFirst(b) {
    if (!b.dataset.confirm) return Promise.resolve(true);
    return ask(b.dataset.confirm, b.dataset.confirmText, b.dataset.confirmOk, b.classList.contains('danger') || b.classList.contains('warn'));
  }

  // ---- Action buttons ----
  $$('[data-act]').forEach((b) => {
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!(await confirmFirst(b))) return;
      b.disabled = true;
      try {
        await call(b.dataset.method || 'POST', b.dataset.path, b.dataset.body ? JSON.parse(b.dataset.body) : undefined);
        after(b.dataset.then);
      } catch (x) {
        say(x.message, true);
        b.disabled = false;
      }
    });
  });

  // ---- Segmented controls ----
  function choose(group, button) {
    $$('button', group).forEach((x) => {
      const on = x === button;
      x.classList.toggle('on', on);
      x.setAttribute('aria-checked', String(on));
    });
  }
  $$('.sg').forEach((group) => {
    $$('button', group).forEach((b) => b.addEventListener('click', () => choose(group, b)));
  });

  // ---- Settings: save as you go ----
  async function saveSetting(key, value, el) {
    try {
      await call('POST', '/admin/api/settings', { [key]: value });
      say('Saved');
      return true;
    } catch (x) {
      say(x.message, true);
      if (el) el.focus();
      return false;
    }
  }
  $$('input[data-setting]').forEach((input) => {
    let saved = input.value;
    const isAddress = input.dataset.setting === 'address';
    const save = async () => {
      const value = input.value.trim();
      if (value === saved.trim() || (isAddress && !value)) return;
      if (isAddress) {
        // The panel moves to the new address, so ask first.
        const target = value.replace(/\/+$/, '');
        if (!(await ask('Change the address?', "You'll open the panel at " + target + ' from now on.', 'Change address'))) {
          input.value = saved;
          return;
        }
        if (await saveSetting('address', value, input)) location.assign(target + '/admin');
        return;
      }
      if (await saveSetting(input.dataset.setting, value, input)) {
        saved = input.value;
        // The sidebar and the address check follow the new values.
        setTimeout(() => location.reload(), 600);
      }
    };
    input.addEventListener('change', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  });
  $$('button[data-setting]').forEach((b) => {
    b.addEventListener('click', async () => {
      const group = b.closest('.sg');
      const before = $('button.on', group);
      const raw = b.dataset.value;
      const value = b.dataset.setting === 'defaultBytes' ? Number(raw) : raw;
      if (!(await saveSetting(b.dataset.setting, value)) && before) choose(group, before);
    });
  });

  // ---- Forms that post to the API ----
  function formBody(form) {
    const body = {};
    $$('input[name]', form).forEach((i) => { body[i.name] = i.value; });
    return body;
  }
  function wireForm(form, opts) {
    const err = $('.err', form);
    const submit = $('button[type=submit]', form);
    const show = (m) => { if (err) { err.textContent = m || ''; err.hidden = !m; } };
    form.addEventListener('submit', async (e) => {
      // Cancel in a dialog closes it without a call.
      if (e.submitter && e.submitter.value === 'cancel') return;
      e.preventDefault();
      show('');
      if (opts && opts.before && opts.before(show)) return;
      submit.disabled = true;
      try {
        const body = opts && opts.body ? opts.body(form) : formBody(form);
        await call('POST', form.dataset.api, body);
        after(form.dataset.then);
      } catch (x) {
        if (opts && opts.onError && opts.onError(x)) return;
        show(x.message);
      } finally {
        submit.disabled = false;
      }
    });
    return show;
  }

  // ---- Authenticator codes ----
  // A code field sends its form as soon as the code is complete; the submit button checks it again.
  const WRONG = { bad: 'That code didn’t work' };
  function codeField(box, send, done) {
    return window.TesshCode.mount(box, {
      text: WRONG,
      async onComplete(code) {
        try {
          return await send(code);
        } catch (x) {
          // A wrong code shakes; anything else (too many tries, a wrong password) says what happened.
          if (x.code === 'invalid_code') return false;
          return x.message;
        }
      },
      onAccepted: () => setTimeout(done, 450),
    });
  }
  // For a submit button next to a code field: checks a complete code, or asks for one.
  function checkCode(field, show) {
    if (field.value.length === 6) {
      if (!field.check()) field.focus();
    } else {
      show('Type the 6-digit code from your authenticator app.');
      field.focus();
    }
    return true;
  }

  // Sign-in: a second step for the authenticator code when the server asks for it.
  const login = $('form[data-login]');
  if (login) {
    const codeRow = $('[data-code-row]', login);
    const field = codeField(
      codeRow,
      (code) => call('POST', login.dataset.api, Object.assign(formBody(login), { code })),
      () => after(login.dataset.then),
    );
    wireForm(login, {
      before: (show) => (codeRow.hidden ? false : checkCode(field, show)),
      onError(x) {
        if (x.code !== 'code_required') return false;
        codeRow.hidden = false;
        field.focus();
        return true;
      },
    });
  }

  // ---- Backup download: confirm with the password (and code), then save the file the server sends ----
  async function download(form) {
    const res = await fetch(form.dataset.download, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-tessh-owner': '1' },
      body: JSON.stringify(formBody(form)),
    });
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch (x) { data = {}; }
      throw new ApiError(data.message || 'Something went wrong. Try again.', data.error);
    }
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name ? name[1] : 'tessh-backup.db';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  // Code fields inside dialogs, cleared each time their dialog opens.
  const dialogFields = new Map();
  $$('form[data-download]').forEach((form) => {
    const err = $('.err', form);
    const submit = $('button[type=submit]', form);
    const show = (m) => { err.textContent = m || ''; err.hidden = !m; };
    const saved = () => { form.closest('dialog').close(); say('Backup downloaded'); };
    const box = $('[data-otp]', form);
    const field = box && codeField(box, async () => {
      show('');
      if (!$('input[name=password]', form).value) {
        show('Type your password, then press Download.');
        return null;
      }
      try {
        await download(form);
        return true;
      } catch (x) {
        if (x.code === 'invalid_code') throw x;
        show(x.message);
        return null;
      }
    }, saved);
    if (field) dialogFields.set(form.closest('dialog'), field);
    form.addEventListener('submit', async (e) => {
      if (e.submitter && e.submitter.value === 'cancel') return;
      e.preventDefault();
      show('');
      if (field) { checkCode(field, show); return; }
      submit.disabled = true;
      try {
        await download(form);
        saved();
      } catch (x) {
        show(x.message);
      } finally {
        submit.disabled = false;
      }
    });
  });

  // ---- Dialogs ----
  function openDialog(name) {
    const d = $(`dialog[data-dialog="${name}"]`);
    if (!d) return null;
    $$('.err', d).forEach((x) => { x.hidden = true; });
    $$('input', d).forEach((x) => { x.value = ''; });
    if (dialogFields.has(d)) dialogFields.get(d).reset();
    d.showModal();
    return d;
  }
  $$('dialog form[data-api]').forEach((f) => {
    const box = $('[data-otp]', f);
    if (!box) { wireForm(f); return; }
    const field = codeField(box, (code) => call('POST', f.dataset.api, Object.assign(formBody(f), { code })), () => after(f.dataset.then));
    dialogFields.set(f.closest('dialog'), field);
    wireForm(f, { before: (show) => checkCode(field, show) });
  });
  $$('[data-open]').forEach((b) => {
    b.addEventListener('click', async () => {
      const d = openDialog(b.dataset.open);
      if (!d) return;
      const form = $('form[data-totp-start]', d);
      if (!form) return;
      // A fresh key each time the dialog opens.
      const secret = $('[data-secret]', d);
      const uri = $('[data-uri]', d);
      const qr = $('[data-qr]', d);
      const copy = $('[data-copy-secret]', d);
      secret.textContent = '…';
      qr.textContent = '';
      copy.dataset.copy = '';
      try {
        const r = await call('POST', '/admin/api/owner/totp/start');
        // The server draws the code as a plain SVG (no scripts or styles).
        qr.innerHTML = r.qr;
        secret.textContent = r.secret.replace(/(.{4})/g, '$1 ').trim();
        copy.dataset.copy = r.secret;
        uri.href = r.uri;
        dialogFields.get(d).focus();
      } catch (x) {
        const err = $('.err', d);
        err.textContent = x.message;
        err.hidden = false;
      }
    });
  });

  // Storage limit for one person.
  const limitDlg = $('dialog[data-dialog=limit]');
  let limitPath = '';
  $$('[data-limit]').forEach((b) => {
    b.addEventListener('click', () => {
      if (!limitDlg) return;
      limitPath = b.dataset.limit;
      $('[data-limit-for]', limitDlg).textContent = 'For ' + b.dataset.limitName + '. Their data is never deleted: over the limit, they just can’t add more.';
      const group = $('.sg', limitDlg);
      const current = b.dataset.limitCurrent;
      const match = $$('button', group).find((x) => x.dataset.limitValue === current) || null;
      $$('button', group).forEach((x) => { x.classList.toggle('on', x === match); x.setAttribute('aria-checked', String(x === match)); });
      $('.err', limitDlg).hidden = true;
      limitDlg.showModal();
    });
  });
  if (limitDlg) {
    $('[data-limit-save]', limitDlg).addEventListener('click', async () => {
      const on = $('.sg button.on', limitDlg);
      const err = $('.err', limitDlg);
      if (!on) { err.textContent = 'Choose a limit'; err.hidden = false; return; }
      const v = on.dataset.limitValue;
      try {
        await call('POST', limitPath, { bytes: v === '' ? null : Number(v) });
        location.reload();
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
      }
    });
  }

  // ---- New invite ----
  const invite = $('form[data-invite]');
  if (invite) {
    const err = $('[data-invite-err]');
    invite.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.hidden = true;
      const label = $('input[name=label]', invite).value.trim();
      const days = Number(($('.sg button.on', invite) || {}).dataset?.days || 7);
      if (!label) {
        err.textContent = "Add a name so you know who it's for";
        err.hidden = false;
        return;
      }
      try {
        const r = await call('POST', '/admin/api/invites', { label, days });
        try { await navigator.clipboard.writeText(r.url); say('Invite made, link copied'); } catch (x) { say('Invite made'); }
        setTimeout(() => location.reload(), 700);
      } catch (x) {
        err.textContent = x.message;
        err.hidden = false;
      }
    });
  }
})();
