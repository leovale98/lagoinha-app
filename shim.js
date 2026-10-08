/* Camada web: substitui o runtime do claude.ai (db, user, assets, downloads) por Supabase,
   com cache local (IndexedDB) para abrir e consultar sem sinal. */
(function () {
  'use strict';
  const CFG = window.SB_CFG || {};
  const sb = window.supabase.createClient(CFG.url, CFG.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    realtime: { params: { eventsPerSecond: 5 } }
  });
  const colOf = p => p.replace(/\/[^/]+$/, '');
  const clone = o => o == null ? o : JSON.parse(JSON.stringify(o));
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  const deepMerge = (a, b) => { const r = isObj(a) ? clone(a) : {}; for (const k in b) r[k] = isObj(b[k]) && isObj(r[k]) ? deepMerge(r[k], b[k]) : clone(b[k]); return r; };

  // ---------- cache local ----------
  const C = {};
  let cdbP = null;
  function cdb() {
    if (cdbP) return cdbP;
    cdbP = new Promise(res => { try { const r = indexedDB.open('lag-web-cache', 1); r.onupgradeneeded = () => r.result.createObjectStore('d'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); } catch (e) { res(null); } });
    return cdbP;
  }
  async function cOp(mode, fn) { const x = await cdb(); if (!x) return null; return new Promise(res => { try { const t = x.transaction('d', mode); const r = fn(t.objectStore('d')); t.oncomplete = () => res(r && r.result); t.onerror = () => res(null); } catch (e) { res(null); } }); }
  const cacheReady = (async () => {
    const x = await cdb(); if (!x) return;
    await new Promise(res => { try { const t = x.transaction('d', 'readonly'); const st = t.objectStore('d'); const rq = st.openCursor(); rq.onsuccess = () => { const c = rq.result; if (c) { C[c.key] = c.value; c.continue(); } else res(); }; rq.onerror = () => res(); } catch (e) { res(); } });
  })();

  // ---------- assinantes ----------
  const docL = {}, colL = {};
  const snap = (path, data) => ({ id: path.split('/').pop(), exists: data != null, data: () => data == null ? undefined : clone(data), metadata: {} });
  function emitDoc(path) { (docL[path] || []).forEach(f => { try { f(snap(path, C[path])); } catch (e) { console.error(e); } }); }
  function emitCol(col) {
    if (!colL[col]) return;
    const docs = Object.keys(C).filter(p => colOf(p) === col && p.split('/').length === col.split('/').length + 1).map(p => snap(p, C[p]));
    colL[col].forEach(f => { try { f({ docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: {} }); } catch (e) { console.error(e); } });
  }
  function setLocal(path, data) {
    if (data == null) { delete C[path]; cOp('readwrite', s => s.delete(path)); }
    else { C[path] = data; cOp('readwrite', s => s.put(data, path)); }
    emitDoc(path); emitCol(colOf(path));
  }

  const OFF = { code: 'offline', message: 'offline' };
  function mapErr(error) {
    const m = String((error && (error.message || error.error_description)) || error || '');
    if (/fetch|network|Load failed|timeout/i.test(m)) return OFF;
    if (/row-level security|permission|not allowed|violates|42501/i.test(m) || (error && error.code === '42501')) return { code: 'invalid_argument', message: m };
    return { code: 'error', message: m };
  }
  async function call(fn) {
    if (!navigator.onLine) throw OFF;
    let res; try { res = await fn(); } catch (e) { throw mapErr(e); }
    if (res && res.error) throw mapErr(res.error);
    return res ? res.data : null;
  }

  async function fetchDoc(path) {
    const rows = await call(() => sb.from('docs').select('path,data').eq('path', path).limit(1));
    setLocal(path, rows && rows.length ? rows[0].data : null);
  }
  async function fetchCol(col) {
    const out = {}; let from = 0;
    for (;;) {
      const rows = await call(() => sb.from('docs').select('path,data').eq('col', col).range(from, from + 999));
      (rows || []).forEach(r => out[r.path] = r.data);
      if (!rows || rows.length < 1000) break; from += 1000;
    }
    Object.keys(C).filter(p => colOf(p) === col && !(p in out)).forEach(p => { delete C[p]; cOp('readwrite', s => s.delete(p)); });
    Object.entries(out).forEach(([p, d]) => { C[p] = d; cOp('readwrite', s => s.put(d, p)); });
    emitCol(col); Object.keys(out).forEach(emitDoc);
  }

  const db = {
    doc(path) {
      return {
        path,
        async get() { await cacheReady; try { await fetchDoc(path); } catch (e) { if (e !== OFF && e.code !== 'offline') throw e; } return snap(path, C[path]); },
        async set(v) { await call(() => sb.from('docs').upsert({ path, data: v })); setLocal(path, clone(v)); },
        async update(v) { await call(() => sb.rpc('doc_merge', { p: path, patch: v })); setLocal(path, deepMerge(C[path], v)); },
        async delete() { await call(() => sb.from('docs').delete().eq('path', path)); setLocal(path, null); },
        onSnapshot(fn, err) {
          (docL[path] = docL[path] || []).push(fn);
          cacheReady.then(() => { if (path in C) fn(snap(path, C[path])); fetchDoc(path).catch(e => { if (!(path in C)) fn(snap(path, null)); if (err && e.code !== 'offline') err(e); }); });
          return () => { docL[path] = (docL[path] || []).filter(f => f !== fn); };
        }
      };
    },
    collection(col) {
      return {
        onSnapshot(fn, err) {
          (colL[col] = colL[col] || []).push(fn);
          cacheReady.then(() => { emitCol(col); fetchCol(col).catch(e => { if (err && e.code !== 'offline') err(e); }); });
          return () => { colL[col] = (colL[col] || []).filter(f => f !== fn); };
        },
        doc(id) { return db.doc(col + '/' + id); }
      };
    }
  };
  function refetchAll() { Object.keys(docL).filter(p => docL[p].length).forEach(p => fetchDoc(p).catch(() => {})); Object.keys(colL).filter(c => colL[c].length).forEach(c => fetchCol(c).catch(() => {})); }
  let chan = null;
  function startRealtime() {
    if (chan) return;
    chan = sb.channel('docs-live').on('postgres_changes', { event: '*', schema: 'public', table: 'docs' }, pl => {
      if (pl.eventType === 'DELETE') { if (pl.old && pl.old.path) setLocal(pl.old.path, null); }
      else if (pl.new && pl.new.path) setLocal(pl.new.path, pl.new.data);
    }).subscribe(st => { if (st === 'SUBSCRIBED') refetchAll(); });
  }
  window.addEventListener('online', () => { refetchAll(); });

  // ---------- identidade ----------
  let U = null;           // {id,email}
  let OWNER = false;
  const LS = { get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }, del(k) { try { localStorage.removeItem(k); } catch (e) {} } };
  const initials = n => (n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const avatar = n => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" rx="20" fill="#004a82"/><text x="20" y="25" font-family="Arial" font-size="15" font-weight="700" fill="#fff" text-anchor="middle">${initials(n)}</text></svg>`);
  const nameOf = id => ((C['people/' + id] || {}).n) || '';
  const user = {
    async me() { const n = nameOf(U.id) || U.email; return { id: U.id, name: n, email: U.email, avatarUrl: avatar(n), color: '#004a82' }; },
    async id() { return U.id; },
    async can() { return true; },
    async isOwner() { return OWNER; },
    async canEdit() { return OWNER; },
    async profiles(ids) { const o = {}; [].concat(ids || []).forEach(i => { const n = nameOf(i); o[i] = { id: i, name: n, avatarUrl: avatar(n), color: '#004a82', guest: false }; }); return o; },
    async search() { return []; }
  };
  async function refreshOwner() {
    try { const r = await call(() => sb.rpc('is_owner')); OWNER = !!r; LS.set('lag-web-owner', { id: U.id, v: OWNER }); } catch (e) { const c = LS.get('lag-web-owner'); OWNER = !!(c && c.id === U.id && c.v); }
  }

  // ---------- fotos e downloads ----------
  const blobUrl = id => `${CFG.url}/storage/v1/object/public/fotos/${encodeURIComponent(id)}.jpg`;
  const assets = {
    async upload(blob) {
      const id = (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '');
      await call(() => sb.storage.from('fotos').upload(id + '.jpg', blob, { contentType: 'image/jpeg', upsert: false }));
      return { id, url: blobUrl(id), sizeBytes: blob.size, contentType: 'image/jpeg' };
    },
    async list() { return { assets: [], usage: {} }; },
    async delete() { }
  };
  const downloads = {
    async save({ filename, data }) {
      const u = URL.createObjectURL(data); const a = document.createElement('a'); a.href = u; a.download = filename || 'arquivo'; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 4000); return { status: 'saved' };
    }
  };

  // ---------- tela de acesso ----------
  let readyRes; const ready = new Promise(r => readyRes = r);
  const h = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  let ov = null, card = null;
  function shell() {
    if (ov) return;
    ov = h('div', 'gate'); ov.id = 'webgate'; ov.style.zIndex = 400;
    const art = h('div', 'gart'); const big = h('img', 'gbig'); big.alt = ''; art.append(big);
    const side = h('div', 'gside'); const mid = h('div', 'gmid'); card = h('div', 'gcard'); mid.append(card); side.append(mid);
    ov.append(art, side); document.body.append(ov);
    try { const lg = window.__LOGOS || {}; if (lg.big) big.src = lg.big; } catch (e) {}
  }
  function head(sub) {
    card.innerHTML = '';
    const hd = h('div', 'ghead'); const lg = h('img', 'glogo'); lg.alt = 'CGN Brazil Energy'; try { lg.src = (window.__LOGOS || {}).white || ''; } catch (e) {} hd.append(lg);
    card.append(hd, h('div', 'gtitle', 'UFV Lagoinha'), h('div', 'gsub', 'Comissionamento dos Trackers HD'));
    if (sub) card.append(h('div', 'gtitle2', sub));
  }
  function field(f, id, label, type, ac, ph) {
    const w = h('label', 'gf'); w.htmlFor = id; w.append(h('span', null, label));
    const i = h('input'); i.id = id; i.type = type || 'text'; if (ac) i.autocomplete = ac; if (ph) i.placeholder = ph; i.maxLength = 120;
    w.append(i); f.append(w); return i;
  }
  function link(txt, fn) { const b = h('button', 'glink', txt); b.type = 'button'; b.onclick = fn; return b; }
  function form(btnTxt) { const f = h('form', 'gform'); f.noValidate = true; const msg = h('div', 'gmsg'); msg.setAttribute('role', 'alert'); const b = h('button', 'gbtn', btnTxt); b.type = 'submit'; return { f, msg, b, end() { f.append(msg, b); } }; }
  const errTxt = e => { const m = String((e && e.message) || e || ''); if (/Invalid login/i.test(m)) return 'E-mail ou senha incorretos.'; if (/not confirmed/i.test(m)) return 'E-mail ainda não confirmado. Abra o link que enviamos para o seu e-mail.'; if (/already registered|already exists/i.test(m)) return 'Este e-mail já tem cadastro. Use "Entrar" ou "Esqueci minha senha".'; if (/fetch|network/i.test(m)) return 'Sem conexão. Para o primeiro acesso é preciso estar com sinal.'; if (/rate limit/i.test(m)) return 'Muitas tentativas. Aguarde alguns minutos.'; return 'Não foi possível concluir: ' + m; };

  function viewLogin(note) {
    shell(); head();
    const x = form('Entrar'); const em = field(x.f, 'w-mail', 'E-mail', 'email', 'username', 'nome@empresa.com.br'); const pw = field(x.f, 'w-pwd', 'Senha', 'password', 'current-password'); x.end();
    if (note) card.append(Object.assign(h('div', 'gok'), { textContent: note }));
    card.append(x.f);
    const ls = h('div', 'glinks'); ls.append(link('Esqueci minha senha', viewForgot), link('Primeiro Acesso', viewSignup)); card.append(ls);
    card.append(h('div', 'ginfo', 'Use o e-mail e a senha cadastrados na plataforma.'));
    x.f.onsubmit = async e => {
      e.preventDefault(); x.msg.textContent = ''; const mail = em.value.trim().toLowerCase();
      if (!EMAIL_RE.test(mail)) { x.msg.textContent = 'Informe o seu e-mail.'; return; }
      if (!pw.value) { x.msg.textContent = 'Informe a senha.'; return; }
      x.b.disabled = true;
      const { data, error } = await sb.auth.signInWithPassword({ email: mail, password: pw.value }).catch(e2 => ({ error: e2 }));
      if (error) { x.msg.textContent = errTxt(error); x.b.disabled = false; return; }
      enter(data.user);
    };
    setTimeout(() => { try { em.focus(); } catch (e) {} }, 60);
  }
  function viewSignup() {
    shell(); head('Primeiro Acesso');
    card.append(h('div', 'ginfo', 'Crie seu usuário (e-mail) e senha. Em seguida você completa seus dados.'));
    const x = form('Criar acesso'); const em = field(x.f, 'w-mail', 'E-mail', 'email', 'username', 'nome@empresa.com.br'); const p1 = field(x.f, 'w-p1', 'Senha (mín. 6 caracteres)', 'password', 'new-password'); const p2 = field(x.f, 'w-p2', 'Confirmar senha', 'password', 'new-password'); x.end();
    card.append(x.f, link('Voltar para o login', () => viewLogin()));
    x.f.onsubmit = async e => {
      e.preventDefault(); x.msg.textContent = ''; const mail = em.value.trim().toLowerCase();
      if (!EMAIL_RE.test(mail)) { x.msg.textContent = 'Informe um e-mail válido.'; return; }
      if (p1.value.length < 6) { x.msg.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; return; }
      if (p1.value !== p2.value) { x.msg.textContent = 'As senhas não conferem.'; return; }
      x.b.disabled = true;
      const { data, error } = await sb.auth.signUp({ email: mail, password: p1.value, options: { emailRedirectTo: location.origin + location.pathname } }).catch(e2 => ({ error: e2 }));
      if (error) { x.msg.textContent = errTxt(error); x.b.disabled = false; return; }
      if (data.session) enter(data.user);
      else viewLogin('Enviamos um e-mail de confirmação para ' + mail + '. Abra o link do e-mail e depois entre com seu e-mail e senha.');
    };
  }
  function viewForgot() {
    shell(); head('Esqueci minha senha');
    card.append(h('div', 'ginfo', 'Informe o e-mail cadastrado. Você receberá um link para criar uma nova senha.'));
    const x = form('Enviar link'); const em = field(x.f, 'w-mail', 'E-mail', 'email', 'username', 'nome@empresa.com.br'); x.end();
    card.append(x.f, link('Voltar para o login', () => viewLogin()));
    x.f.onsubmit = async e => {
      e.preventDefault(); x.msg.textContent = ''; const mail = em.value.trim().toLowerCase();
      if (!EMAIL_RE.test(mail)) { x.msg.textContent = 'Informe um e-mail válido.'; return; }
      x.b.disabled = true;
      const { error } = await sb.auth.resetPasswordForEmail(mail, { redirectTo: location.origin + location.pathname }).catch(e2 => ({ error: e2 }));
      if (error) { x.msg.textContent = errTxt(error); x.b.disabled = false; return; }
      viewLogin('Se o e-mail estiver cadastrado, você receberá em instantes um link para criar uma nova senha.');
    };
  }
  function viewNewPwd() {
    shell(); head('Criar nova senha');
    const x = form('Salvar nova senha'); const p1 = field(x.f, 'w-p1', 'Nova senha (mín. 6 caracteres)', 'password', 'new-password'); const p2 = field(x.f, 'w-p2', 'Confirmar nova senha', 'password', 'new-password'); x.end();
    card.append(x.f);
    x.f.onsubmit = async e => {
      e.preventDefault(); x.msg.textContent = '';
      if (p1.value.length < 6) { x.msg.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; return; }
      if (p1.value !== p2.value) { x.msg.textContent = 'As senhas não conferem.'; return; }
      x.b.disabled = true;
      const { data, error } = await sb.auth.updateUser({ password: p1.value }).catch(e2 => ({ error: e2 }));
      if (error) { x.msg.textContent = errTxt(error); x.b.disabled = false; return; }
      enter(data.user);
    };
  }

  let entered = false;
  async function enter(u) {
    if (entered) return; entered = true;
    U = { id: u.id, email: (u.email || '').toLowerCase() };
    LS.set('lag-web-user', U);
    window.__WEB.email = U.email;
    await cacheReady;
    await refreshOwner();
    if (navigator.onLine) startRealtime();
    if (ov) { ov.remove(); ov = null; }
    readyRes();
  }

  window.__WEB = {
    email: '',
    blobUrl,
    async checkPwd(p) {
      if (!U) return false;
      if (!navigator.onLine) return false;
      const { error } = await sb.auth.signInWithPassword({ email: U.email, password: p }).catch(e => ({ error: e }));
      return !error;
    },
    async signOut() { try { await sb.auth.signOut(); } catch (e) {} LS.del('lag-web-user'); LS.del('lag-web-owner'); location.reload(); },
    sb
  };

  // ---------- início ----------
  const domReady = new Promise(r => document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', r) : r());
  (async () => {
    await domReady;
    let recovering = /type=recovery/.test(location.hash);
    sb.auth.onAuthStateChange((ev, session) => {
      if (ev === 'PASSWORD_RECOVERY') { recovering = true; viewNewPwd(); }
      else if (ev === 'SIGNED_IN' && session && !recovering && !entered) enter(session.user);
      if (session && navigator.onLine && entered) startRealtime();
    });
    let session = null;
    try { const r = await sb.auth.getSession(); session = r.data && r.data.session; } catch (e) {}
    if (recovering) { viewNewPwd(); return; }
    if (session) { if (/access_token|type=/.test(location.hash)) history.replaceState(null, '', location.pathname); enter(session.user); return; }
    const cached = LS.get('lag-web-user');
    if (!navigator.onLine && cached) { enter(cached); return; }   // sem sinal: segue com o último usuário deste aparelho
    viewLogin();
  })();

  // ---------- interface compatível com window.claude ----------
  const CAPS = { db, user, assets, downloads };
  window.claude = { use: async name => { await ready; return CAPS[name] || null; } };
})();
