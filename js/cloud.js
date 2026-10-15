/* End-to-end encrypted cloud storage on Supabase.
 *
 * Your password never leaves this device. PBKDF2 (600k rounds) turns it into 512 bits:
 *   - the first half is the AES-256-GCM key that encrypts all your data, and
 *   - the second half is what Supabase sees as your login password.
 * Supabase therefore stores only ciphertext and can't derive the encryption key.
 * Decrypted data lives only in this tab's memory; nothing is written to browser storage.
 */
const Cloud = (() => {
  const cfg = window.ATLAS_CONFIG || {};
  const API = String(cfg.supabaseUrl || '').trim().replace(/\/+$/, '');
  const ANON = String(cfg.supabaseAnonKey || '').trim();
  const KDF_ITERATIONS = 600000;
  const IDLE_LOCK_MS = 30 * 60 * 1000;
  const POLL_MS = 60 * 1000;
  const te = new TextEncoder(), td = new TextDecoder();
  const $ = s => document.querySelector(s);

  let session = null;     // {access_token, refresh_token, user:{id,email}}
  let key = null;         // non-extractable AES-GCM CryptoKey
  let version = 0;        // server row version we last saw
  let base = null;        // last synced snapshot (for 3-way merge)
  let dirty = false, saving = false, changeSeq = 0, saveTimer = null, refreshTimer = null;
  let lastActive = Date.now();
  let onRemote = () => {};

  const configured = () => /^https:\/\/\S+$/.test(API) && ANON.length > 20;

  // ---------- encoding / crypto ----------
  function toB64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(str) {
    const bin = atob(str), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  const b64url = bytes => toB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  async function deriveKeys(email, password) {
    const material = await crypto.subtle.importKey('raw', te.encode(password.normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: te.encode(`atlas-money/v1/${email.trim().toLowerCase()}`), iterations: KDF_ITERATIONS },
      material, 512));
    const aes = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const authPassword = 'atlas1.' + b64url(bits.slice(32));
    bits.fill(0);
    return { aes, authPassword };
  }

  const aad = () => te.encode(`atlas-vault/v1/${session.user.id}`);
  async function encrypt(obj) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad() }, key, te.encode(JSON.stringify(obj)));
    return { ciphertext: toB64(new Uint8Array(ct)), iv: toB64(iv) };
  }
  async function decrypt(row) {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(row.iv), additionalData: aad() }, key, fromB64(row.ciphertext));
    return JSON.parse(td.decode(pt));
  }

  // ---------- Supabase REST ----------
  class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
  async function api(path, { method = 'GET', body, auth = true, prefer, retry = true } = {}) {
    const headers = { apikey: ANON, 'Content-Type': 'application/json' };
    if (auth && session) headers.Authorization = `Bearer ${session.access_token}`;
    if (prefer) headers.Prefer = prefer;
    let res;
    try {
      res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
    } catch {
      throw new ApiError(0, 'Can’t reach the server. Check your internet connection.');
    }
    if (res.status === 401 && auth && session && retry) {
      await refreshSession();
      return api(path, { method, body, auth, prefer, retry: false });
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) throw new ApiError(res.status, data?.msg || data?.error_description || data?.message || data?.error || `Request failed (${res.status})`);
    return data;
  }

  function setSession(s) {
    session = { access_token: s.access_token, refresh_token: s.refresh_token, user: { id: s.user.id, email: s.user.email } };
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => refreshSession().catch(() => {}), Math.max(30, (s.expires_in || 3600) - 120) * 1000);
  }
  async function refreshSession() {
    const s = await api('/auth/v1/token?grant_type=refresh_token', { method: 'POST', auth: false, body: { refresh_token: session.refresh_token } })
      .catch(e => { lock('Your session expired. Please sign in again.'); throw e; });
    setSession(s);
  }

  // ---------- vault ----------
  const vaultPath = extra => `/rest/v1/vaults?user_id=eq.${session.user.id}${extra || ''}`;
  async function fetchVault() {
    const rows = await api(vaultPath('&select=ciphertext,iv,version'));
    return rows?.[0] || null;
  }

  /** 3-way merge so edits made on two devices at once are both kept (this device wins on the same item). */
  function merge(b, local, remote) {
    const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
    const byId = list => new Map((list || []).map(x => [x.id, x]));
    const mergeList = name => {
      const B = byId(b[name]), L = byId(local[name]), R = byId(remote[name]);
      const out = [];
      const pick = id => {
        const bi = B.get(id), li = L.get(id), ri = R.get(id);
        if (li && ri) return same(li, bi) ? ri : li;
        if (li) return bi && same(li, bi) ? null : li;     // deleted remotely unless changed here
        if (ri) return bi && same(ri, bi) ? null : ri;     // deleted here unless changed remotely
        return null;
      };
      const seen = new Set();
      [...R.keys(), ...L.keys()].forEach(id => {
        if (seen.has(id)) return;
        seen.add(id);
        const v = pick(id);
        if (v) out.push(v);
      });
      return out;
    };
    const cats = type => {
      const bs = new Set(b.categories?.[type] || []), ls = new Set(local.categories[type]);
      const removed = [...bs].filter(c => !ls.has(c));
      const added = local.categories[type].filter(c => !bs.has(c));
      return [...new Set([...(remote.categories?.[type] || []), ...added])].filter(c => !removed.includes(c));
    };
    const settings = { ...remote.settings };
    Object.keys(local.settings).forEach(k => { if (!same(local.settings[k], b.settings?.[k])) settings[k] = local.settings[k]; });
    return {
      ...remote,
      accounts: mergeList('accounts'),
      transactions: mergeList('transactions'),
      categories: { expense: cats('expense'), income: cats('income') },
      settings,
    };
  }

  // ---------- sync engine ----------
  function setStatus(kind, text) {
    const el = $('#sync-status');
    if (!el) return;
    el.dataset.state = kind;
    el.textContent = text;
  }

  function markDirty() {
    if (!session) return;
    dirty = true;
    changeSeq++;
    setStatus('pending', 'Saving…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 800);
  }

  async function flush() {
    if (!session || !dirty) return;
    if (saving) { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 500); return; }
    saving = true;
    const seq = changeSeq;
    let retryIn = 300;
    try {
      const snapshot = structuredClone(Store.exportData());
      const payload = await encrypt(snapshot);
      const rows = await api(vaultPath(`&version=eq.${version}`), {
        method: 'PATCH', prefer: 'return=representation',
        body: { ...payload, version: version + 1, updated_at: new Date().toISOString() },
      });
      if (rows?.length) {
        version += 1;
        base = snapshot;
        if (seq === changeSeq) { dirty = false; setStatus('saved', 'Saved'); }
      } else {
        await pullAndMerge(); // someone else saved first
      }
    } catch (e) {
      console.warn('Save failed', e);
      if (session) {
        setStatus('error', e.status === 0 ? 'Offline – not saved' : 'Not saved – retrying');
        retryIn = 10000;
      }
    } finally {
      saving = false;
    }
    if (dirty && session) { clearTimeout(saveTimer); saveTimer = setTimeout(flush, retryIn); }
  }

  async function pullAndMerge() {
    const row = await fetchVault();
    if (!row) return;
    const remote = Store.normalize(await decrypt(row));
    const merged = dirty ? merge(base, Store.exportData(), remote) : remote;
    Store.load(merged);
    base = remote;
    version = row.version;
    onRemote();
    if (!dirty) setStatus('saved', 'Saved');
  }

  async function poll() {
    if (!session || saving || dirty || document.hidden) return;
    try {
      const rows = await api(vaultPath('&select=version'));
      if (rows?.[0] && rows[0].version > version) await pullAndMerge();
    } catch { /* next poll */ }
  }

  // ---------- sign in / sign up ----------
  function friendly(e) {
    const m = String(e.message || '');
    if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
    if (/email not confirmed/i.test(m)) return 'Please confirm your email first. Check your inbox for the link from Supabase.';
    if (/already registered|already exists/i.test(m)) return 'An account with this email already exists. Sign in instead.';
    if (/rate limit|too many/i.test(m)) return 'Too many attempts. Please wait a few minutes and try again.';
    return m || 'Something went wrong.';
  }

  async function signIn(email, password) {
    const k = await deriveKeys(email, password);
    const s = await api('/auth/v1/token?grant_type=password', { method: 'POST', auth: false, body: { email: email.trim(), password: k.authPassword } });
    key = k.aes;
    setSession(s);
    await openVault();
  }

  async function signUp(email, password) {
    const k = await deriveKeys(email, password);
    const redirect = encodeURIComponent(location.origin + location.pathname);
    const r = await api(`/auth/v1/signup?redirect_to=${redirect}`, { method: 'POST', auth: false, body: { email: email.trim(), password: k.authPassword } });
    if (!r?.access_token) return { confirm: true };
    key = k.aes;
    setSession(r);
    await openVault();
    return { confirm: false };
  }

  async function openVault() {
    const row = await fetchVault();
    const legacy = Store.legacyData();
    const legacyMsg = legacy && `This browser still has data from the earlier version of Atlas (${legacy.transactions.length} transactions, ${legacy.accounts.length} accounts).`;
    if (row) {
      let data;
      try { data = Store.normalize(await decrypt(row)); }
      catch { throw new Error('Your data couldn’t be decrypted with this password.'); }
      version = row.version;
      base = structuredClone(data);
      Store.load(data);
      if (legacy && confirm(`${legacyMsg}\n\nAdd it to your encrypted cloud data and remove it from this browser?`)) {
        Store.load(merge(Store.normalize({}), legacy, data));
        Store.clearLegacy();
        markDirty();
      }
    } else {
      const start = legacy && confirm(`${legacyMsg}\n\nMove it into your new encrypted cloud storage? It will be removed from this browser afterwards.`)
        ? legacy : Store.normalize({});
      const payload = await encrypt(start);
      await api('/rest/v1/vaults', { method: 'POST', prefer: 'return=minimal', body: { user_id: session.user.id, ...payload, version: 1 } });
      version = 1;
      base = structuredClone(start);
      Store.load(start);
      if (start === legacy) Store.clearLegacy();
    }
    setStatus('saved', 'Saved');
  }

  /** Wipe everything from memory by reloading the page. */
  function lock(message) {
    session = null; key = null;
    try { if (message) sessionStorage.setItem('atlas-lock-msg', message); } catch { /* ignore */ }
    location.replace(location.pathname);
  }

  async function signOut() {
    if (dirty) await flush();
    if (dirty && !confirm('Some changes haven’t been saved yet (you may be offline). Sign out anyway and lose them?')) return;
    try { await api('/auth/v1/logout', { method: 'POST' }); } catch { /* ignore */ }
    lock();
  }

  // ---------- auth screen ----------
  function showAuth() {
    const box = $('#auth');
    box.hidden = false;
    document.body.classList.add('locked');
    const form = $('#auth-form'), err = $('#auth-error'), info = $('#auth-info');
    let mode = 'signin';

    // Supabase's email-confirmation link lands here with tokens in the URL; we don't use them.
    if (/access_token|error_description|type=signup/.test(location.hash)) {
      const confirmed = /type=signup|access_token/.test(location.hash) && !/error/.test(location.hash);
      history.replaceState(null, '', location.pathname);
      if (confirmed) info.textContent = 'Email confirmed. You can sign in now.';
    }
    try {
      const m = sessionStorage.getItem('atlas-lock-msg');
      if (m) { info.textContent = m; sessionStorage.removeItem('atlas-lock-msg'); }
    } catch { /* ignore */ }

    if (!configured()) {
      $('#auth-setup').hidden = false;
      form.hidden = true;
      return;
    }

    const setMode = m => {
      mode = m;
      $$('.signup-only').forEach(e => (e.hidden = m !== 'signup'));
      $('#auth-title').textContent = m === 'signup' ? 'Create your Atlas account' : 'Sign in to Atlas';
      $('#auth-submit').textContent = m === 'signup' ? 'Create account' : 'Sign in';
      $('#auth-toggle').textContent = m === 'signup' ? 'I already have an account' : 'Create an account';
      form.elements.password.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
      err.textContent = '';
    };
    const $$ = s => [...document.querySelectorAll(s)];
    $('#auth-toggle').addEventListener('click', () => setMode(mode === 'signup' ? 'signin' : 'signup'));
    setMode('signin');

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const f = form.elements;
      const email = f.email.value.trim(), password = f.password.value;
      err.textContent = ''; info.textContent = '';
      if (mode === 'signup') {
        if (password.length < 12) return (err.textContent = 'Use at least 12 characters. A few random words works well.');
        if (password !== f.confirm.value) return (err.textContent = 'The two passwords don’t match.');
        if (!f.understand.checked) return (err.textContent = 'Please tick the box to confirm you understand.');
      }
      const btn = $('#auth-submit');
      btn.disabled = true;
      btn.textContent = mode === 'signup' ? 'Creating…' : 'Unlocking…';
      try {
        if (mode === 'signup') {
          const r = await signUp(email, password);
          if (r.confirm) {
            setMode('signin');
            f.password.value = f.confirm.value = '';
            info.textContent = `We sent a confirmation link to ${email}. Open it, then sign in here.`;
            return;
          }
        } else {
          await signIn(email, password);
        }
        f.password.value = '';
        if (f.confirm) f.confirm.value = '';
        unlocked();
      } catch (ex) {
        session = null; key = null;
        err.textContent = friendly(ex);
      } finally {
        btn.disabled = false;
        btn.textContent = mode === 'signup' ? 'Create account' : 'Sign in';
      }
    });
    form.elements.email.focus();
  }

  function unlocked() {
    $('#auth').hidden = true;
    document.body.classList.remove('locked');
    $('#account-email').textContent = session.user.email;
    window.AtlasApp.start();
    setInterval(poll, POLL_MS);
    document.addEventListener('visibilitychange', poll);
    ['pointerdown', 'keydown', 'scroll', 'touchstart'].forEach(ev => addEventListener(ev, () => (lastActive = Date.now()), { passive: true }));
    setInterval(async () => {
      if (Date.now() - lastActive < IDLE_LOCK_MS) return;
      if (dirty) await flush();
      if (!dirty) lock('Locked after 30 minutes of inactivity.');
    }, 60 * 1000);
    addEventListener('beforeunload', e => { if (dirty || saving) { e.preventDefault(); e.returnValue = ''; } });
  }

  Store.onChange(markDirty);

  return {
    boot: showAuth,
    onRemoteChange(fn) { onRemote = fn; },
    signOut,
    lockNow: () => (dirty ? flush().then(() => !dirty && lock()) : lock()),
    get email() { return session?.user.email || ''; },
    _merge: merge, // exposed for tests
  };
})();
