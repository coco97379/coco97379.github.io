/* Agenda de travail : interface. Dépend de lib.js (window.AG). */
(function () {
  'use strict';
  const CFG = window.AGENDA_CONFIG || {};
  const Q = new URLSearchParams(location.search);
  const DEMO = Q.get('demo') === '1';
  const LOCK_MS = 5 * 60 * 1000;

  const CATS = {
    C: { c: '#1D4ED8', n: 'Congé / permission' }, P: { c: '#B45309', n: 'Permanence' }, R: { c: '#15803D', n: 'Repos hebdomadaire' },
    RPC: { c: '#0E7490', n: 'Repos physiologique compensatoire' }, RR: { c: '#7E22CE', n: 'Repos récupérateur' }, F: { c: '#BE185D', n: 'Formation' }
  };
  const CHIPS = [['P', 'Permanence'], ['R', 'Repos'], ['RPC', 'RPC'], ['RR', 'RR'], ['F', 'Formation'], ['C', 'Congé / permission']];
  const TYPES = ['Audition témoin', 'Audition victime', 'Visio', 'GAV', 'Autre'];
  const MOIS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];
  const MOIS3 = ['JAN', 'FÉV', 'MAR', 'AVR', 'MAI', 'JUN', 'JUL', 'AOÛ', 'SEP', 'OCT', 'NOV', 'DÉC'];
  const JOURS = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const now = new Date();
  const todayIso = AG.iso(now.getFullYear(), now.getMonth() + 1, now.getDate());

  const S = {
    phase: 'boot', view: 'mois', dk: null, meta: null, rows: new Map(), pending: new Set(), entries: new Map(),
    y: now.getFullYear(), m: now.getMonth() + 1, date: todayIso, territoire: 'Guyane', local: true,
    sync: 'idle', syncInfo: '', form: null, toast: '', err: '', busy: false, confirmDel: false, metaDirty: false, tmp: {}
  };

  /* ---------- Stockage local (IndexedDB) ---------- */
  let DB;
  const openDb = () => new Promise((res, rej) => {
    const r = indexedDB.open(DEMO ? 'agenda-demo' : 'agenda', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('rows', { keyPath: 'id' }); r.result.createObjectStore('kv'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const P = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  const store = (n, mode) => DB.transaction(n, mode).objectStore(n);
  const kvGet = (k) => P(store('kv', 'readonly').get(k));
  const kvSet = (k, v) => P(store('kv', 'readwrite').put(v, k));
  async function persist() {
    const t = DB.transaction(['rows', 'kv'], 'readwrite');
    S.rows.forEach((row, id) => t.objectStore('rows').put({ id, row }));
    t.objectStore('kv').put(Array.from(S.pending), 'pending');
    await new Promise((res, rej) => { t.oncomplete = res; t.onerror = () => rej(t.error); });
  }
  async function refreshEntries() {
    const m = new Map(); let bad = 0;
    for (const [id, row] of S.rows) { try { m.set(id, await AG.entryFromRow(row, S.dk)); } catch (e) { bad++; } }
    S.entries = m; S.bad = bad;
  }

  /* ---------- Google : connexion et API ---------- */
  function cachedToken() { try { const t = JSON.parse(localStorage.getItem('ag_tok') || 'null'); if (t && t.exp > Date.now()) return t.v; } catch (e) { /* rien */ } return null; }
  let gisLoading;
  function loadGis() {
    if (window.google && google.accounts) return Promise.resolve();
    if (!gisLoading) gisLoading = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client';
      s.onload = res; s.onerror = () => { gisLoading = null; rej(new Error('réseau')); }; document.head.appendChild(s);
    });
    return gisLoading;
  }
  function googleSignIn() {
    if (DEMO) return Promise.resolve('demo');
    return loadGis().then(() => new Promise((res, rej) => {
      const c = google.accounts.oauth2.initTokenClient({
        client_id: CFG.CLIENT_ID, scope: 'https://www.googleapis.com/auth/spreadsheets',
        callback: (r) => {
          if (r.error) return rej(new Error(r.error));
          localStorage.setItem('ag_tok', JSON.stringify({ v: r.access_token, exp: Date.now() + (r.expires_in - 120) * 1000 }));
          res(r.access_token);
        },
        error_callback: (e) => rej(new Error((e && e.type) || 'annulé'))
      });
      c.requestAccessToken({ prompt: '' });
    }));
  }
  /* Faux Google pour le mode démonstration (?demo=1) */
  const demo = { rows: [], meta: {} }; window.__demo = demo;
  const demoFetch = async (url, opts) => {
    if (window.__demoOffline) throw new Error('offline');
    opts = opts || {}; const u = decodeURIComponent(url); const body = opts.body ? JSON.parse(opts.body) : null;
    const ok = (j) => ({ ok: true, status: 200, json: async () => j || {} });
    let m = u.match(/values\/Jours!A(\d+):O\d+/);
    if (m && opts.method === 'PUT') { demo.rows[+m[1] - 2] = body.values[0]; return ok(); }
    if (u.includes('/values/Jours!A2:O')) return ok({ values: demo.rows });
    if (u.includes(':append')) { body.values.forEach((r) => demo.rows.push(r)); return ok(); }
    if (u.includes('Réglages!A5:B10')) { body.values.forEach(([k, v]) => { demo.meta[k] = v; }); return ok(); }
    if (u.includes('Réglages!A2:B12')) return ok({ values: Object.entries(demo.meta) });
    if (u.includes('Réglages!B2')) return ok({ values: [['Guyane']] });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const api = () => DEMO ? AG.sheetsApi(demoFetch, async () => 'demo', 'DEMO')
    : AG.sheetsApi((u, o) => fetch(u, o), async () => cachedToken(), CFG.SHEET_ID);

  /* ---------- Synchronisation ---------- */
  let syncTimer;
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(doSync, ms == null ? 800 : ms); }
  async function doSync() {
    if (!S.dk || S.busy) return;
    if (!DEMO && !navigator.onLine) { S.sync = 'off'; render(); return; }
    S.busy = true; S.sync = 'run'; render();
    try {
      const a = api();
      if (S.metaDirty) { await a.setMeta(S.meta); S.metaDirty = false; await kvSet('metaDirty', false); }
      const r = await AG.sync(a, S.rows, S.pending);
      await persist(); await refreshEntries();
      if (!S.tmp.terrChecked) { S.tmp.terrChecked = true; const t = await kvGet('territoire'); if (!t) { const tr = await a.getTerritoire().catch(() => ''); if (AG.TERRITOIRES.includes(tr)) { S.territoire = tr; await kvSet('territoire', tr); } } }
      S.sync = S.pending.size ? 'off' : 'ok'; S.syncInfo = '';
      if (r.conflicts) toast(r.conflicts + ' modification(s) remplacée(s) par une version plus récente faite ailleurs.');
    } catch (e) { S.sync = e.code === 'auth' ? 'auth' : 'off'; }
    S.busy = false; render();
  }

  /* ---------- Données ---------- */
  async function saveEntry(e) {
    e.maj = Date.now();
    S.rows.set(e.id, await AG.rowFromEntry(e, S.dk));
    S.entries.set(e.id, e); S.pending.add(e.id);
    await persist(); scheduleSync();
  }
  const dayEntries = (date, kinds) => Array.from(S.entries.values()).filter((e) => e.date === date && !e.del && kinds.includes(e.kind))
    .sort((a, b) => (a.debut || '99').localeCompare(b.debut || '99'));
  const statutOf = (date) => { const e = S.entries.get('st-' + date); return e && !e.del ? e.statut : ''; };
  async function setStatut(date, code) {
    const old = S.entries.get('st-' + date);
    if (!code && !old) return;
    await saveEntry({ id: 'st-' + date, date, kind: 'statut', statut: code, del: !code });
  }
  const holidays = (y) => AG.holidays(y, S.territoire, S.local);
  function toast(msg) { S.toast = msg; render(); setTimeout(() => { if (S.toast === msg) { S.toast = ''; render(); } }, 4500); }

  /* ---------- Verrouillage ---------- */
  let lockTimer;
  function touch() { clearTimeout(lockTimer); if (S.dk) lockTimer = setTimeout(lock, LOCK_MS); }
  function lock() { S.dk = null; S.entries = new Map(); S.form = null; S.per = null; S.view = 'mois'; S.phase = 'unlock'; S.err = ''; render(); }
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) hiddenAt = Date.now();
    else if (S.dk && hiddenAt && Date.now() - hiddenAt > LOCK_MS) lock();
    else if (S.dk) scheduleSync(300);
  });
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, touch, { passive: true }));
  window.addEventListener('online', () => scheduleSync(500));
  window.addEventListener('offline', () => { S.sync = 'off'; render(); });
  setInterval(() => { if (S.dk && S.pending.size) scheduleSync(0); }, 60000);

  async function afterUnlock(dk) {
    S.dk = dk; await refreshEntries();
    S.phase = 'app'; S.err = ''; touch(); render(); scheduleSync(200);
  }

  /* ---------- Rendu ---------- */
  const app = document.getElementById('app');
  function pill() { const x = pillInner(); return x ? '<span class="pw">' + x + '</span>' : ''; }
  function pillInner() {
    const n = S.pending.size;
    if (S.sync === 'run') return '<span class="pill run">↻ Synchronisation…</span>';
    if (S.sync === 'auth') return '<button class="pill auth" data-act="reauth">Se reconnecter à Google' + (n ? ' · ' + n + ' en attente' : '') + '</button>';
    if (S.sync === 'off' || n) return '<span class="pill off">● ' + (navigator.onLine || DEMO ? '' : 'Hors réseau · ') + n + ' en attente</span>';
    if (S.sync === 'ok') return '<span class="pill ok">✓ Synchronisé</span>';
    return '';
  }
  const gear = '<button class="iconbtn" data-act="settings" aria-label="Réglages"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>';
  const logo = '<div class="logo"><svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></div>';
  function legend() { return '<div class="legend">' + Object.keys(CATS).map((k) => '<div class="lg"><div class="lgb" style="background:' + CATS[k].c + '">' + k + '</div>' + esc(CATS[k].n.replace('Repos physiologique compensatoire', 'Rep. physio. comp.').replace('Repos récupérateur', 'Rep. récup.').replace('Repos hebdomadaire', 'Repos').replace('Congé / permission', 'Congé/perm.')) + '</div>').join('') + '</div>'; }
  const fmtLong = (iso) => { const [y, m, d] = iso.split('-').map(Number); return JOURS[AG.dow(y, m, d)] + ' ' + d + ' ' + MOIS[m - 1].toLowerCase(); };

  function viewLock() {
    const ph = S.phase, err = '<div class="err">' + esc(S.err) + '</div>';
    if (ph === 'boot') return '<div class="center">' + logo + '<h1>Agenda</h1><p>Chargement…</p></div>';
    if (ph === 'signin') return '<div class="center">' + logo + '<h1>Agenda</h1><p>Première utilisation : connecte-toi avec le compte Google qui contient ton Sheet.</p>' + err +
      '<button class="btn pri" data-act="signin">Se connecter à Google</button></div>';
    if (ph === 'setup') return '<div class="center">' + logo + '<h1>Crée ton mot de passe</h1><p>Il protège l\'application et chiffre le nom, l\'UNA et les notes. Choisis une phrase d\'au moins 10 caractères.</p>' +
      '<input class="inp" id="pw1" type="password" autocomplete="new-password" placeholder="Mot de passe"><input class="inp" id="pw2" type="password" autocomplete="new-password" placeholder="Répète le mot de passe">' + err +
      '<button class="btn pri" data-act="setup">Créer</button></div>';
    if (ph === 'recovery') return '<div class="center">' + logo + '<h1>Code de récupération</h1><p>Note ce code sur papier et range-le en lieu sûr. Il permet de choisir un nouveau mot de passe sans perdre tes données. Il ne sera plus affiché.</p>' +
      '<div class="code">' + esc(S.tmp.code) + '</div><label style="font-size:13px;margin-bottom:14px"><input type="checkbox" id="noted"> J\'ai noté ce code</label>' + err +
      '<button class="btn pri" data-act="recoveryDone">Continuer</button></div>';
    if (ph === 'reset') return '<div class="center">' + logo + '<h1>Mot de passe oublié</h1><p>Entre ton code de récupération puis choisis un nouveau mot de passe.</p>' +
      '<input class="inp" id="rc" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" autocapitalize="characters" autocomplete="off"><input class="inp" id="pw1" type="password" autocomplete="new-password" placeholder="Nouveau mot de passe">' + err +
      '<button class="btn pri" data-act="reset">Valider</button><button class="link" data-act="toUnlock">Retour</button></div>';
    return '<div class="center">' + logo + '<h1>Agenda</h1><p>Entre ton mot de passe</p><input class="inp" id="pw" type="password" autocomplete="current-password" placeholder="Mot de passe">' + err +
      '<button class="btn pri" data-act="unlock">Déverrouiller</button><button class="link" data-act="toReset">Mot de passe oublié ?</button>' +
      '<p style="font-size:12px;margin-top:10px">Se reverrouille après 5 minutes d\'inactivité.</p>' + (S.pending.size ? '<div>' + pill() + '</div>' : '') + '</div>';
  }

  function cellStyle(code) { return code ? 'background:' + CATS[code].c + ';' : ''; }

  function viewYear() {
    const y = S.y, hol = holidays(y); let rows = '';
    let head = '<div></div>'; for (let d = 1; d <= 31; d++) head += '<div class="yh">' + d + '</div>';
    for (let m = 1; m <= 12; m++) {
      rows += '<div class="ym">' + MOIS3[m - 1] + '</div>';
      for (let d = 1; d <= 31; d++) {
        if (d > AG.daysIn(y, m)) { rows += '<div class="yc none"></div>'; continue; }
        const iso = AG.iso(y, m, d), code = statutOf(iso), h = hol[iso], we = AG.dow(y, m, d) >= 5;
        rows += '<button class="yc' + (code ? ' cat' : we ? ' we' : '') + (iso === todayIso ? ' sel' : '') + (code && code.length > 1 ? ' long' : '') + '" style="' + cellStyle(code) + '" data-act="goDay" data-date="' + iso + '" aria-label="' + fmtLong(iso) + (code ? ', ' + CATS[code].n : '') + (h ? ', ' + esc(h.nom) : '') + '">' + (code || '') + (h ? '<i class="dot' + (h.legal ? '' : ' loc') + '"></i>' : '') + '</button>';
      }
    }
    return '<div class="top"><div class="title">' + y + '</div>' + pill() + '<div style="display:flex;align-items:center;gap:2px">' +
      '<button class="iconbtn" data-act="yPrev" aria-label="Année précédente">‹</button><button class="iconbtn" data-act="yNext" aria-label="Année suivante">›</button>' + gear + '</div></div>' +
      legend() + '<div class="sub" style="padding-bottom:6px">Touche un jour pour ouvrir son détail. Point plein : jour férié. Point creux : usage local.</div>' +
      '<div class="yscroll"><div class="ygrid">' + head + rows + '</div></div>';
  }

  function viewMonth() {
    const y = S.y, m = S.m, hol = holidays(y), first = AG.dow(y, m, 1), n = AG.daysIn(y, m);
    let cells = '';
    for (let i = 0; i < first; i++) cells += '<div></div>';
    for (let d = 1; d <= n; d++) {
      const iso = AG.iso(y, m, d), code = statutOf(iso), h = hol[iso], we = AG.dow(y, m, d) >= 5;
      cells += '<button class="mc' + (code ? ' cat' : we ? ' we' : '') + (iso === S.date ? ' sel' : '') + '" style="' + cellStyle(code) + '" data-act="pickDay" data-date="' + iso + '" aria-label="' + fmtLong(iso) + '"><b>' + d + '</b><span>' + (code || '') + '</span>' +
        (h ? '<i class="dot' + (h.legal ? '' : ' loc') + '"></i>' : '') + '</button>';
    }
    const sel = S.date, hh = (holidays(+sel.slice(0, 4)) || {})[sel], code = statutOf(sel);
    const list = dayEntries(sel, ['activite', 'rdv']).map((e) => '<div style="display:flex;gap:12px;align-items:baseline;font-size:14px"><div style="width:44px;font-size:12px;font-weight:600;color:#4B5563">' + esc(e.debut) + '</div><div>' + esc(e.kind === 'rdv' ? e.type : (e.detail || 'Activité')) + '</div></div>').join('');
    return '<div class="top"><div class="title">' + MOIS[m - 1] + ' ' + y + '</div>' + pill() + '<div style="display:flex;align-items:center;gap:2px">' +
      '<button class="iconbtn" data-act="mPrev" aria-label="Mois précédent">‹</button><button class="iconbtn" data-act="mNext" aria-label="Mois suivant">›</button>' + gear + '</div></div>' +
      '<div class="wk">' + 'LMMJVSD'.split('').map((x) => '<div>' + x + '</div>').join('') + '</div><div class="m7">' + cells + '</div>' + legend() +
      '<div class="sec"><div class="card" style="padding:14px 16px;display:flex;flex-direction:column;gap:10px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b style="font-size:15px">' + fmtLong(sel) + '</b>' +
      (code ? '<span style="font-size:11px;font-weight:700;color:#fff;background:' + CATS[code].c + ';border-radius:999px;padding:3px 10px">' + esc(CATS[code].n) + '</span>' : '') + '</div>' +
      (hh ? '<div style="font-size:13px;color:#713F12">Jour férié : ' + esc(hh.nom) + '</div>' : '') + (list || '<div style="font-size:13px;color:#4B5563">Rien de noté.</div>') +
      '<button data-act="goDay" data-date="' + sel + '" style="text-align:left;font-size:13px;font-weight:600;color:#1D4ED8;min-height:32px">Ouvrir le détail du jour →</button>' +
      '<button data-act="openPer" style="text-align:left;font-size:13px;font-weight:600;color:#1D4ED8;min-height:32px">📅 Saisir sur plusieurs jours…</button></div></div>';
  }

  function viewDay() {
    const date = S.date, [y, m, d] = date.split('-').map(Number), code = statutOf(date), hh = holidays(y)[date];
    const chips = CHIPS.map(([k, n]) => { const on = code === k; return '<button class="chip' + (on ? ' on' : '') + '" style="' + (on ? 'background:' + CATS[k].c : '') + '" data-act="statut" data-code="' + k + '">' + n + '</button>'; }).join('');
    const items = dayEntries(date, ['activite', 'rdv']).map((e) => {
      const una = [e.cu, e.np, e.an].filter(Boolean).join('/');
      const sub = e.kind === 'rdv' ? [e.nom, una ? 'UNA ' + una : ''].filter(Boolean).join(' · ') : '';
      return '<button class="card item" data-act="editEntry" data-id="' + esc(e.id) + '"><div class="t">' + esc(e.debut) + '</div><div class="b"><div>' + esc(e.kind === 'rdv' ? e.type : (e.detail || 'Activité')) + '</div>' +
        (sub ? '<div>' + esc(sub) + '</div>' : (e.kind === 'rdv' && e.detail ? '<div>' + esc(e.detail) + '</div>' : '')) + '</div>' + (e.kind === 'rdv' ? '<span class="tag">RDV</span>' : '') + '</button>';
    }).join('');
    const note = S.entries.get('no-' + date); const noteTxt = note && !note.del ? note.detail : '';
    return '<div class="top" style="padding-bottom:0"><button data-act="backMonth" style="height:44px;font-size:14px;font-weight:600;color:#1D4ED8">‹ ' + MOIS[m - 1] + ' ' + y + '</button><div style="display:flex;align-items:center;gap:2px">' + pill() + gear + '</div></div>' +
      '<div class="sec" style="padding-top:0"><div class="title">' + fmtLong(date) + '</div><div style="font-size:12px;color:#4B5563">Semaine ' + isoWeek(y, m, d) + '</div></div>' +
      (hh ? '<div class="banner">Jour férié : ' + esc(hh.nom) + '</div>' : '') +
      '<div class="sec"><div class="lab">STATUT DU JOUR</div><div class="chips">' + chips + '</div>' +
      '<div class="row2" style="margin-top:10px">' + (code ? '<button class="btn" data-act="statut" data-code="">✕ Effacer le statut</button>' : '') + '<button class="btn" data-act="openPer">📅 Plusieurs jours…</button></div></div>' +
      '<div class="sec"><div class="lab">ACTIVITÉ ET RENDEZ-VOUS</div>' + items + '<div class="sp"></div>' +
      '<div class="row2"><button class="btn" data-act="newRdv">+ Rendez-vous</button><button class="btn" data-act="newAct">+ Activité</button></div></div>' +
      '<div class="sec"><div class="lab">NOTES</div><textarea class="inp" id="note" placeholder="Écrire ici…">' + esc(noteTxt) + '</textarea></div>';
  }
  function isoWeek(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d)); const day = (dt.getUTCDay() + 6) % 7; dt.setUTCDate(dt.getUTCDate() - day + 3);
    const fy = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4)); return 1 + Math.round(((dt - fy) / 86400000 - 3 + ((fy.getUTCDay() + 6) % 7)) / 7);
  }

  const perDays = (per) => {
    const out = []; if (!per.from || !per.to || per.to < per.from) return out;
    let t = Date.parse(per.from + 'T00:00:00Z'); const end = Date.parse(per.to + 'T00:00:00Z');
    for (; t <= end && out.length < 400; t += 86400000) {
      const d = new Date(t), iso = AG.iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
      if (per.skipWe && AG.dow(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) >= 5) continue;
      out.push(iso);
    }
    return out;
  };
  function viewPer() {
    const P = S.per, days = perDays(P), erase = P.code === '-';
    const chips = CHIPS.map(([k, n]) => '<button class="chip' + (P.code === k ? ' on' : '') + '" style="' + (P.code === k ? 'background:' + CATS[k].c : '') + '" data-act="perCode" data-code="' + k + '">' + n + '</button>').join('') +
      '<button class="chip' + (erase ? ' on' : '') + '" style="' + (erase ? 'background:#111827' : '') + '" data-act="perCode" data-code="-">✕ Effacer</button>';
    const msg = P.to < P.from ? 'La date de fin est avant la date de début.' : !P.code ? 'Choisis un statut.' : days.length + ' jour' + (days.length > 1 ? 's' : '') + (erase ? ' à effacer' : ' à enregistrer') + (days.length >= 400 ? ' (maximum)' : '') + '.';
    const ok = P.code && days.length > 0 && P.to >= P.from;
    return '<div class="top" style="padding-bottom:0"><button data-act="cancelPer" style="height:44px;font-size:14px;font-weight:600;color:#1D4ED8">‹ Retour</button><div>' + pill() + '</div></div>' +
      '<div class="sec" style="padding-top:0"><div class="title">Saisir sur plusieurs jours</div></div>' +
      '<div class="sec"><div class="lab">STATUT</div><div class="chips">' + chips + '</div></div>' +
      '<div class="sec"><div class="row2"><div class="field"><label for="p-from">Du</label><input class="inp" type="date" id="p-from" data-p="from" value="' + P.from + '"></div>' +
      '<div class="field"><label for="p-to">Au (inclus)</label><input class="inp" type="date" id="p-to" data-p="to" value="' + P.to + '"></div></div>' +
      '<label style="display:flex;align-items:center;gap:10px;font-size:14px;margin:6px 0 12px;min-height:44px"><input type="checkbox" data-act="perWe" ' + (P.skipWe ? 'checked' : '') + ' style="width:22px;height:22px"> Ne pas toucher les samedis et dimanches</label>' +
      '<div class="card" style="padding:12px 16px;font-size:14px;margin-bottom:12px">' + msg + '</div>' +
      '<div class="row2"><button class="btn" data-act="cancelPer">Annuler</button><button class="btn pri" data-act="applyPer" style="flex:1.4;' + (ok ? '' : 'opacity:.4') + '">' + (erase ? 'Effacer' : 'Appliquer') + '</button></div></div>';
  }
  async function applyPer() {
    const P = S.per, days = perDays(P);
    if (!P.code || !days.length) return;
    const code = P.code === '-' ? '' : P.code;
    for (const d of days) await setStatut(d, code);
    S.date = P.from; S.y = +P.from.slice(0, 4); S.m = +P.from.slice(5, 7); S.view = S.perBack || 'mois'; S.per = null;
    toast(days.length + ' jour' + (days.length > 1 ? 's' : '') + (code ? ' enregistré' : ' effacé') + (days.length > 1 ? 's' : '') + '.');
  }
  function viewForm() {
    const f = S.form, rdv = f.kind === 'rdv';
    const types = TYPES.map((t) => '<button class="chip' + (f.type === t ? ' on' : '') + '" style="' + (f.type === t ? 'background:#312E81' : '') + '" data-act="setType" data-type="' + t + '">' + t + '</button>').join('');
    const inp = (k, label, attrs) => '<div class="field"><label for="f-' + k + '">' + label + '</label><input class="inp" id="f-' + k + '" data-f="' + k + '" value="' + esc(f[k]) + '" ' + (attrs || '') + '></div>';
    return '<div class="top" style="padding-bottom:0"><button data-act="cancelForm" style="height:44px;font-size:14px;font-weight:600;color:#1D4ED8">‹ ' + fmtLong(f.date) + '</button><div>' + pill() + '</div></div>' +
      '<div class="sec" style="padding-top:0"><div class="title">' + (f.id ? 'Modifier' : 'Nouveau') + (rdv ? ' rendez-vous' : 'e activité') + '</div></div>' +
      (rdv ? '<div class="sec"><div class="lab">TYPE</div><div class="chips">' + types + '</div>' +
        (f.type === 'Autre' ? '<div style="margin-top:10px">' + inp('typeLibre', 'Préciser le type', 'placeholder="Type libre…"') + '</div>' : '') + '</div>' : '') +
      '<div class="sec"><div class="row2">' + inp('debut', 'Début', 'type="time"') + inp('fin', 'Fin', 'type="time"') + '</div></div>' +
      (rdv ? '<div class="sec"><div class="lab">PERSONNE CONCERNÉE</div>' + inp('nom', 'Nom', 'placeholder="NOM Prénom" autocomplete="off"') + '</div>' +
        '<div class="sec"><div class="lab">UNA</div><div class="row2" style="gap:8px">' + inp('cu', 'Code unité', 'inputmode="numeric" placeholder="000" autocomplete="off"') + inp('np', 'N° de procédure', 'inputmode="numeric" placeholder="00000" autocomplete="off"') + inp('an', 'Année', 'inputmode="numeric" placeholder="' + f.date.slice(0, 4) + '" maxlength="4" autocomplete="off"') + '</div></div>' : '') +
      '<div class="sec"><div class="field"><label for="f-detail">' + (rdv ? 'Remarque (facultatif)' : 'Activité') + '</label><textarea class="inp" id="f-detail" data-f="detail" style="height:64px">' + esc(f.detail) + '</textarea></div>' +
      '<div style="font-size:12px;color:#4B5563;margin-bottom:12px">Hors réseau, c\'est gardé dans le téléphone et envoyé au retour du réseau.</div>' +
      '<div class="row2"><button class="btn" data-act="cancelForm">Annuler</button><button class="btn pri" data-act="saveForm" style="flex:1.4">Enregistrer</button></div>' +
      (f.id ? '<div class="sp"></div><button class="btn warn" data-act="delEntry">' + (S.confirmDel ? 'Confirmer la suppression' : 'Supprimer') + '</button>' : '') + '<div class="err" style="margin-top:8px">' + esc(S.err) + '</div></div>';
  }

  function viewSettings() {
    const n = S.pending.size;
    return '<div class="top"><button data-act="closeSettings" style="height:44px;font-size:14px;font-weight:600;color:#1D4ED8">‹ Retour</button>' + pill() + '</div>' +
      '<div class="sec" style="padding-top:0"><div class="title">Réglages</div></div>' +
      '<div class="set"><h3>JOURS FÉRIÉS</h3><div class="field"><label for="terr">Territoire</label><select class="inp" id="terr" data-act="terr">' + AG.TERRITOIRES.map((t) => '<option' + (t === S.territoire ? ' selected' : '') + '>' + t + '</option>').join('') + '</select></div>' +
      '<label style="font-size:13px;display:flex;gap:8px;align-items:center"><input type="checkbox" id="loc" data-act="loc"' + (S.local ? ' checked' : '') + '> Montrer les usages locaux (jours gras en Guyane)</label></div>' +
      '<div class="set"><h3>SYNCHRONISATION</h3><div style="font-size:13px;color:#4B5563;margin-bottom:10px">' + (n ? n + ' modification(s) en attente d\'envoi.' : 'Tout est envoyé dans le Sheet.') + '</div>' +
      '<div class="row2"><button class="btn" data-act="syncNow">Synchroniser</button><button class="btn" data-act="reauth">Connexion Google</button></div></div>' +
      '<div class="set"><h3>MOT DE PASSE</h3><div class="field"><input class="inp" id="op" type="password" placeholder="Mot de passe actuel" autocomplete="current-password"></div><div class="field"><input class="inp" id="np2" type="password" placeholder="Nouveau mot de passe (10 caractères minimum)" autocomplete="new-password"></div>' +
      '<button class="btn" data-act="chgPw">Changer le mot de passe</button><div class="err" style="margin-top:8px">' + esc(S.err) + '</div></div>' +
      '<div class="set"><button class="btn pri" data-act="lock">Verrouiller maintenant</button></div>' + (S.bad ? '<div class="sub">' + S.bad + ' ligne(s) illisible(s) ignorée(s).</div>' : '') +
      '<div class="sub" style="padding-top:14px">Territoire et option sont gardés sur ce téléphone.</div>';
  }

  function render() {
    let html;
    if (S.phase !== 'app') html = viewLock();
    else if (S.view === 'form') html = '<div class="main">' + viewForm() + '</div>';
    else if (S.view === 'settings') html = '<div class="main">' + viewSettings() + '</div>';
    else if (S.view === 'periode' && S.per) html = '<div class="main">' + viewPer() + '</div>';
    else {
      const v = S.view === 'annee' ? viewYear() : S.view === 'jour' ? viewDay() : viewMonth();
      html = '<div class="main">' + v + '</div><div class="tabs">' + [['annee', 'Année'], ['mois', 'Mois'], ['jour', 'Jour']].map(([k, n]) => '<button class="' + (S.view === k ? 'on' : '') + '" data-act="tab" data-v="' + k + '">' + n + '</button>').join('') + '</div>';
    }
    const ids = ['pw', 'pw1', 'pw2', 'rc', 'op', 'np2'], sig = S.phase + '|' + S.view, saved = {};
    if (sig === S._sig) ids.forEach((id) => { const el = document.getElementById(id); if (el && el.value) saved[id] = el.value; });
    S._sig = sig;
    const ms = app.querySelector('.main'); const st = ms ? ms.scrollTop : 0;
    app.innerHTML = html + (S.toast ? '<div class="toast">' + esc(S.toast) + '</div>' : '');
    const ms2 = app.querySelector('.main'); if (ms2 && S.keepScroll) ms2.scrollTop = st;
    Object.keys(saved).forEach((id) => { const el = document.getElementById(id); if (el) el.value = saved[id]; });
  }

  /* ---------- Actions ---------- */
  const val = (id) => (document.getElementById(id) || {}).value || '';
  function fail(msg) { S.err = msg; render(); }
  const openForm = (kind, e) => {
    const base = e ? Object.assign({}, e) : { id: null, kind, date: S.date, type: '', debut: '', fin: '', detail: '', nom: '', cu: '', np: '', an: '' };
    let typeLibre = '';
    if (base.type && base.type.startsWith('Autre : ')) { typeLibre = base.type.slice(8); base.type = 'Autre'; }
    S.form = Object.assign(base, { typeLibre }); S.err = ''; S.confirmDel = false; S.view = 'form'; S.keepScroll = false; render();
  };
  async function saveForm() {
    const f = S.form;
    if (f.kind === 'rdv' && !f.type) return fail('Choisis un type de rendez-vous.');
    if (f.kind === 'rdv' && f.type === 'Autre' && !f.typeLibre.trim()) return fail('Précise le type de rendez-vous.');
    if (f.kind === 'activite' && !f.detail.trim()) return fail('Décris l\'activité.');
    const e = Object.assign({}, f, { id: f.id || (f.kind === 'rdv' ? 'rv-' : 'ac-') + AG.uuid(), del: false });
    e.type = f.kind === 'rdv' ? (f.type === 'Autre' ? 'Autre : ' + f.typeLibre.trim() : f.type) : '';
    delete e.typeLibre;
    await saveEntry(e); S.view = 'jour'; S.form = null; S.err = ''; S.keepScroll = false; render();
  }

  app.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset && el.dataset.f && S.form) S.form[el.dataset.f] = el.value;
  });
  app.addEventListener('focusout', async (ev) => {
    if (ev.target.id === 'note' && S.dk) {
      const txt = ev.target.value.trim(), old = S.entries.get('no-' + S.date);
      if (txt === ((old && !old.del && old.detail) || '')) return;
      await saveEntry({ id: 'no-' + S.date, date: S.date, kind: 'note', detail: txt, del: !txt });
    }
  });
  app.addEventListener('change', async (ev) => {
    const el = ev.target, a = el.dataset && el.dataset.act;
    if (a === 'terr') { S.territoire = el.value; await kvSet('territoire', el.value); render(); }
    if (a === 'loc') { S.local = el.checked; await kvSet('local', el.checked); render(); }
    if (el.dataset && el.dataset.p && S.per) { S.per[el.dataset.p] = el.value; if (el.dataset.p === 'from' && S.per.to < el.value) S.per.to = el.value; S.keepScroll = true; render(); }
    if (a === 'perWe' && S.per) { S.per.skipWe = el.checked; S.keepScroll = true; render(); }
  });
  app.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
    const a = b.dataset.act; S.keepScroll = false;
    try {
      if (a === 'tab') { S.view = b.dataset.v; if (S.view === 'annee') S.y = +S.date.slice(0, 4); render(); }
      else if (a === 'settings') { S.view = 'settings'; S.err = ''; render(); }
      else if (a === 'closeSettings') { S.view = 'mois'; render(); }
      else if (a === 'yPrev') { S.y--; render(); } else if (a === 'yNext') { S.y++; render(); }
      else if (a === 'mPrev') { S.m--; if (S.m < 1) { S.m = 12; S.y--; } render(); }
      else if (a === 'mNext') { S.m++; if (S.m > 12) { S.m = 1; S.y++; } render(); }
      else if (a === 'pickDay') { S.date = b.dataset.date; S.keepScroll = true; render(); }
      else if (a === 'goDay') { S.date = b.dataset.date; S.y = +S.date.slice(0, 4); S.m = +S.date.slice(5, 7); S.view = 'jour'; render(); }
      else if (a === 'backMonth') { S.y = +S.date.slice(0, 4); S.m = +S.date.slice(5, 7); S.view = 'mois'; render(); }
      else if (a === 'statut') { S.keepScroll = true; await setStatut(S.date, b.dataset.code); render(); }
      else if (a === 'openPer') { S.per = { from: S.date, to: S.date, code: '', skipWe: false }; S.perBack = S.view; S.view = 'periode'; render(); }
      else if (a === 'perCode') { S.per.code = b.dataset.code; S.keepScroll = true; render(); }
      else if (a === 'cancelPer') { S.view = S.perBack || 'mois'; S.per = null; render(); }
      else if (a === 'applyPer') await applyPer();
      else if (a === 'newRdv') openForm('rdv'); else if (a === 'newAct') openForm('activite');
      else if (a === 'editEntry') openForm(S.entries.get(b.dataset.id).kind, S.entries.get(b.dataset.id));
      else if (a === 'setType') { S.form.type = b.dataset.type; S.keepScroll = true; render(); }
      else if (a === 'cancelForm') { S.view = 'jour'; S.form = null; render(); }
      else if (a === 'saveForm') await saveForm();
      else if (a === 'delEntry') {
        if (!S.confirmDel) { S.confirmDel = true; render(); } else { const e = S.entries.get(S.form.id); await saveEntry(Object.assign({}, e, { del: true })); S.view = 'jour'; S.form = null; S.confirmDel = false; render(); }
      }
      else if (a === 'syncNow') scheduleSync(0);
      else if (a === 'reauth') { try { await googleSignIn(); S.sync = 'idle'; scheduleSync(0); } catch (e) { toast('Connexion Google impossible (réseau ou annulée).'); } }
      else if (a === 'lock') lock();
      else if (a === 'signin') {
        try { await googleSignIn(); const meta = await api().getMeta(); if (meta.wrapPw) { S.meta = meta; await kvSet('meta', meta); S.phase = 'unlock'; } else S.phase = 'setup'; S.err = ''; }
        catch (e) { S.err = 'Connexion impossible. Vérifie le réseau et la configuration (config.js).'; }
        render();
      }
      else if (a === 'setup') {
        const p1 = val('pw1'), p2 = val('pw2');
        if (p1.length < 10) return fail('10 caractères minimum.'); if (p1 !== p2) return fail('Les deux mots de passe sont différents.');
        S.busy = true; const k = await AG.setupKeys(p1); S.busy = false;
        S.tmp.setup = k; S.tmp.code = k.recoveryCode; S.phase = 'recovery'; S.err = ''; render();
      }
      else if (a === 'recoveryDone') {
        if (!document.getElementById('noted').checked) return fail('Coche la case une fois le code noté.');
        const k = S.tmp.setup; S.meta = k.meta; await kvSet('meta', k.meta);
        try { await api().setMeta(k.meta); } catch (e) { S.metaDirty = true; await kvSet('metaDirty', true); }
        S.tmp.setup = null; S.tmp.code = ''; await afterUnlock(k.dk);
        if (DEMO) await seedDemo();
      }
      else if (a === 'unlock') {
        try { const dk = await AG.unlock(S.meta, val('pw')); await afterUnlock(dk); } catch (e) { fail('Mot de passe incorrect.'); }
      }
      else if (a === 'toReset') { S.phase = 'reset'; S.err = ''; render(); } else if (a === 'toUnlock') { S.phase = 'unlock'; S.err = ''; render(); }
      else if (a === 'reset') {
        if (val('pw1').length < 10) return fail('10 caractères minimum pour le nouveau mot de passe.');
        try {
          S.meta = await AG.changePassword(S.meta, { recoveryCode: val('rc') }, val('pw1')); await kvSet('meta', S.meta); S.metaDirty = true; await kvSet('metaDirty', true);
          await afterUnlock(await AG.unlock(S.meta, val('pw1')));
        } catch (e) { fail('Code de récupération incorrect.'); }
      }
      else if (a === 'chgPw') {
        if (val('np2').length < 10) return fail('10 caractères minimum.');
        try { S.meta = await AG.changePassword(S.meta, { oldPassword: val('op') }, val('np2')); await kvSet('meta', S.meta); S.metaDirty = true; await kvSet('metaDirty', true); S.err = ''; toast('Mot de passe changé.'); scheduleSync(0); S.view = 'mois'; render(); }
        catch (e) { fail('Mot de passe actuel incorrect.'); }
      }
    } catch (e) { console.error(e); fail('Une erreur est survenue : ' + (e.message || e)); }
  });
  app.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && S.phase !== 'app') { const b = app.querySelector('.btn.pri'); if (b) b.click(); } });

  /* ---------- Démonstration ---------- */
  async function seedDemo() {
    const jobs = [];
    const st = (date, c) => jobs.push(saveEntry({ id: 'st-' + date, date, kind: 'statut', statut: c }));
    const mk = (a, b, c, y, m) => { for (let d = a; d <= b; d++) st(AG.iso(y, m, d), c); };
    mk(6, 7, 'P', 2027, 3); mk(8, 8, 'RR', 2027, 3); mk(10, 10, 'R', 2027, 3); mk(15, 16, 'C', 2027, 3); mk(22, 22, 'RPC', 2027, 3); mk(23, 25, 'F', 2027, 3); mk(27, 28, 'P', 2027, 3); mk(29, 29, 'RR', 2027, 3);
    mk(15, 26, 'C', 2027, 2); mk(2, 20, 'C', 2027, 8); mk(20, 31, 'C', 2027, 12);
    jobs.push(saveEntry({ id: 'rv-demo1', date: '2027-03-06', kind: 'rdv', type: 'Audition témoin', debut: '14:00', fin: '15:00', nom: 'NOM Prénom', cu: '000', np: '00000', an: '2027', detail: '' }));
    jobs.push(saveEntry({ id: 'ac-demo1', date: '2027-03-06', kind: 'activite', debut: '08:00', fin: '09:00', detail: 'Prise de permanence' }));
    jobs.push(saveEntry({ id: 'ac-demo2', date: '2027-03-06', kind: 'activite', debut: '17:00', fin: '18:00', detail: 'Compte rendu et passation' }));
    await Promise.all(jobs); render();
  }

  /* ---------- Démarrage ---------- */
  async function boot() {
    render();
    if ('serviceWorker' in navigator && !DEMO && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
    DB = await openDb();
    const rows = await P(store('rows', 'readonly').getAll()); rows.forEach((r) => S.rows.set(r.id, r.row));
    (await kvGet('pending') || []).forEach((id) => S.pending.add(id));
    S.meta = await kvGet('meta'); S.metaDirty = !!(await kvGet('metaDirty'));
    S.territoire = (await kvGet('territoire')) || 'Guyane'; const loc = await kvGet('local'); S.local = loc === undefined ? true : !!loc;
    if (Q.get('date')) { S.date = Q.get('date'); S.y = +S.date.slice(0, 4); S.m = +S.date.slice(5, 7); }
    if (Q.get('view')) S.view = Q.get('view');
    if (S.pending.size) S.sync = 'off';
    if (S.meta) S.phase = 'unlock'; else S.phase = 'signin';
    if (DEMO && !S.meta && Q.get('fresh') !== '1') {
      const k = await AG.setupKeys('demo'); S.meta = k.meta; await kvSet('meta', k.meta); await api().setMeta(k.meta); S.phase = 'unlock';
      if (Q.get('auto') === '1') { await afterUnlock(k.dk); await seedDemo(); S.sync = 'ok'; render(); }
    } else if (DEMO && Q.get('auto') === '1') { await afterUnlock(await AG.unlock(S.meta, 'demo')); }
    if (Q.get('state') === 'offline') { S.sync = 'off'; }
    render();
  }
  window.__AG_STATE = S;
  boot().catch((e) => { console.error(e); app.innerHTML = '<div class="center"><h1>Erreur</h1><p>' + esc(e.message || e) + '</p></div>'; });
})();
