/* Agenda de travail : logique pure (dates, jours fériés, chiffrement, synchronisation).
   Fonctionne dans le navigateur (window.AG) et dans Node (pour les tests). */
(function (root) {
  'use strict';
  const AG = {};
  const cryptoApi = (typeof globalThis !== 'undefined' && globalThis.crypto) || root.crypto;
  const subtle = cryptoApi.subtle;
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  /* ---------- Dates ---------- */
  AG.pad = (n) => String(n).padStart(2, '0');
  AG.iso = (y, m, d) => y + '-' + AG.pad(m) + '-' + AG.pad(d);
  AG.daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  AG.dow = (y, m, d) => (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // 0 = lundi
  AG.isoOf = (dt) => AG.iso(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  AG.addDays = (dt, n) => new Date(dt.getTime() + n * 86400000);

  /* ---------- Pâques et jours fériés ---------- */
  AG.easter = function (y) {
    const a = y % 19, b = Math.floor(y / 100), c = y % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(y, month - 1, day));
  };

  AG.TERRITOIRES = ['Guyane', 'Guadeloupe', 'Martinique', 'La Réunion', 'Mayotte', 'Saint-Martin', 'Saint-Barthélemy', 'Saint-Pierre-et-Miquelon', 'Polynésie française', 'Wallis-et-Futuna', 'Nouvelle-Calédonie', 'Métropole'];

  /* Retourne { 'AAAA-MM-JJ': { nom, legal } } pour une année et un territoire.
     legal = jour férié légal ; sinon usage local (jours gras, etc.), affiché plus discrètement. */
  AG.holidays = function (y, territoire, withLocal) {
    const out = {};
    const put = (iso, nom, legal) => { if (!out[iso] || legal) out[iso] = { nom, legal }; };
    [[1, 1, "Jour de l'an"], [5, 1, 'Fête du Travail'], [5, 8, 'Victoire 1945'], [7, 14, 'Fête nationale'],
     [8, 15, 'Assomption'], [11, 1, 'Toussaint'], [11, 11, 'Armistice 1918'], [12, 25, 'Noël']]
      .forEach(([m, d, n]) => put(AG.iso(y, m, d), n, true));
    const E = AG.easter(y);
    put(AG.isoOf(AG.addDays(E, 1)), 'Lundi de Pâques', true);
    put(AG.isoOf(AG.addDays(E, 39)), 'Ascension', true);
    put(AG.isoOf(AG.addDays(E, 50)), 'Lundi de Pentecôte', true);
    if (territoire === 'Guyane') {
      put(AG.iso(y, 6, 10), "Abolition de l'esclavage", true);
      if (withLocal !== false) {
        put(AG.isoOf(AG.addDays(E, -48)), 'Lundi gras (usage local)', false);
        put(AG.isoOf(AG.addDays(E, -47)), 'Mardi gras (usage local)', false);
        put(AG.isoOf(AG.addDays(E, -46)), 'Mercredi des Cendres (usage local)', false);
      }
    } else if (territoire === 'Nouvelle-Calédonie') {
      put(AG.iso(y, 9, 24), 'Fête de la Citoyenneté', true);
    } else if (territoire === 'Mayotte') {
      put(AG.iso(y, 4, 27), "Abolition de l'esclavage", true);
    } else if (territoire === 'Guadeloupe' || territoire === 'Saint-Martin') {
      put(AG.iso(y, 5, 27), "Abolition de l'esclavage", true);
    } else if (territoire === 'Martinique') {
      put(AG.iso(y, 5, 22), "Abolition de l'esclavage", true);
    } else if (territoire === 'La Réunion') {
      put(AG.iso(y, 12, 20), "Abolition de l'esclavage", true);
    } else if (territoire === 'Saint-Barthélemy') {
      put(AG.iso(y, 10, 9), "Abolition de l'esclavage", true);
    }
    return out;
  };


  /* ---------- Jours à récupérer (fériés travaillés, Sainte-Geneviève, repos hebdomadaires non pris) ---------- */
  const PERM_CODES = ['PAM', 'A', 'OPJ', 'PERM', 'P'];
  AG.REC_START = '2026-11-23';
  AG.parseIso = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  AG.mondayOf = (iso) => { const dt = AG.parseIso(iso); return AG.isoOf(AG.addDays(dt, -((dt.getUTCDay() + 6) % 7))); };
  AG.isoWeekNo = (iso) => {
    const dt = AG.parseIso(iso); dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7) + 3);
    const f = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
    return 1 + Math.round(((dt - f) / 86400000 - 3 + ((f.getUTCDay() + 6) % 7)) / 7);
  };
  /* c : { hol, st(iso)->code, act(iso)->bool, refs{idCredit:dateRR}, today, start } */
  AG.recup = function (y, c) {
    const out = [], start = c.start || AG.REC_START, pre = y + '-';
    Object.keys(c.hol).sort().forEach((iso) => {
      const h = c.hol[iso]; if (!iso.startsWith(pre) || !h.legal || iso < start || iso >= c.today) return;
      const code = c.st(iso), mon = AG.mondayOf(iso), dow = (AG.parseIso(iso).getUTCDay() + 6) % 7;
      let nC = 0, nROther = 0;
      for (let i = 0; i < 7; i++) { const d = AG.isoOf(AG.addDays(AG.parseIso(mon), i)), cd = c.st(d); if (cd === 'C') nC++; if (cd === 'R' && d !== iso) nROther++; }
      let auto = '';
      if (code === 'C') auto = 'conge'; else if (dow >= 5 && nC > 0) auto = 'weekend'; else if (code === 'R' && nROther >= 2) auto = 'repos';
      const how = code || (c.act(iso) ? 'ACT' : 'BLANC');
      out.push({ id: 'F:' + iso, g: 'F', iso, nom: h.nom, how, auto });
    });
    const gen = AG.iso(y, 1, 3); if (gen >= start) out.push({ id: 'G:' + y, g: 'G', iso: gen });
    let mon = AG.mondayOf(AG.iso(y, 1, 1));
    for (let guard = 0; guard < 60; guard++, mon = AG.isoOf(AG.addDays(AG.parseIso(mon), 7))) {
      const th = AG.isoOf(AG.addDays(AG.parseIso(mon), 3));
      if (+th.slice(0, 4) > y) break; if (+th.slice(0, 4) < y || mon < start) continue;
      const sun = AG.isoOf(AG.addDays(AG.parseIso(mon), 6)); if (sun >= c.today) continue;
      let any = false, conge = false, nR = 0;
      for (let i = 0; i < 7; i++) { const code = c.st(AG.isoOf(AG.addDays(AG.parseIso(mon), i))); if (code) any = true; if (code === 'C') conge = true; if (code === 'R') nR++; }
      if (!any || conge) continue;
      for (let k = 1; k <= Math.max(0, 2 - nR); k++) out.push({ id: 'H:' + mon + ':' + k, g: 'H', iso: mon, k, wk: AG.isoWeekNo(mon) });
    }
    const have = new Set(out.map((x) => x.id));
    Object.keys(c.refs).forEach((id) => {
      if (have.has(id)) return; const p = id.split(':'); let yy = 0;
      if (p[0] === 'F') yy = +p[1].slice(0, 4); else if (p[0] === 'G') yy = +p[1]; else if (p[0] === 'H') yy = +AG.isoOf(AG.addDays(AG.parseIso(p[1]), 3)).slice(0, 4);
      if (yy === y) out.push({ id, g: p[0], iso: p[1].length > 4 ? p[1] : '', k: +p[2] || 0, orphan: true });
    });
    out.forEach((x) => { x.used = x.auto ? x.iso : (c.refs[x.id] || ''); });
    return out;
  };

  /* Jours de permission réellement décomptés : dans une suite de jours de congé consécutifs,
     chaque période de 7 jours contient 2 jours de repos (les 5 premiers comptent, les 2 suivants non). */
  AG.congeCounted = (dates, isHol) => {
    const sorted = Array.from(new Set(dates)).sort(), out = new Set(); let prev = null, idx = 0;
    sorted.forEach((iso) => {
      const cont = prev && AG.isoOf(AG.addDays(AG.parseIso(prev), 1)) === iso;
      idx = cont ? idx + 1 : 0; prev = iso;
      if (idx % 7 < 5 && !(isHol && isHol(iso))) out.add(iso);
    });
    return out;
  };

  /* Solde de permission : s = solde saisi à la date sd ; q = droit annuel ajouté chaque 1er janvier ;
     counted = Set des jours décomptés. Retourne le détail pour l'année y (ou null). */
  AG.soldePerm = (cfg, counted, y) => {
    if (cfg.s === null || cfg.s === undefined || cfg.s === '' || !cfg.sd) return null;
    const y0 = +cfg.sd.slice(0, 4); if (y < y0) return null;
    const takenIn = (yr) => { let n = 0; counted.forEach((iso) => { if (+iso.slice(0, 4) === yr && iso > cfg.sd) n++; }); return n; };
    let run = +cfg.s, prevEnd = +cfg.s, pris = 0;
    for (let yr = y0; yr <= y; yr++) { if (yr > y0) run += (+cfg.q || 0); pris = takenIn(yr); prevEnd = run; run -= pris; }
    const first = y === y0;
    return { base: first, report: first ? +cfg.s : prevEnd - (y > y0 ? (+cfg.q || 0) : 0), droits: first ? 0 : (+cfg.q || 0), pris, reste: run };
  };

  /* ---------- Outils base64 / aléatoire ---------- */
  const b64 = (buf) => {
    const u = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return (typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64'));
  };
  const unb64 = (str) => {
    const s = (typeof atob === 'function' ? atob(str) : Buffer.from(str, 'base64').toString('binary'));
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  };
  const rand = (n) => cryptoApi.getRandomValues(new Uint8Array(n));
  AG.uuid = () => Array.from(rand(8)).map((x) => x.toString(16).padStart(2, '0')).join('');

  /* ---------- Chiffrement ----------
     Une clé de données (DK) aléatoire chiffre les champs sensibles.
     DK est elle-même "enveloppée" par le mot de passe et par le code de récupération
     (PBKDF2-SHA256 + AES-GCM). Changer de mot de passe ne rechiffre pas les données. */
  const ITER = 310000;
  AG.setIterations = (n) => { AG._iter = n; };
  const iterations = () => AG._iter || ITER;

  async function deriveKek(secret, saltB64, iter) {
    const base = await subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveKey']);
    return subtle.deriveKey(
      { name: 'PBKDF2', salt: unb64(saltB64), iterations: iter || iterations(), hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  async function wrap(rawDk, kek) {
    const iv = rand(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, kek, rawDk);
    return b64(iv) + '.' + b64(ct);
  }
  async function unwrap(wrapped, kek) {
    const [iv, ct] = wrapped.split('.');
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, kek, unb64(ct)));
  }
  const importDk = (raw) => subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  function newRecoveryCode() {
    const r = rand(16); let bits = '', out = '';
    r.forEach((x) => { bits += x.toString(2).padStart(8, '0'); });
    for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
    return out.slice(0, 24).match(/.{4}/g).join('-');
  }
  AG.newRecoveryCode = newRecoveryCode;

  /* Création initiale : retourne { meta, dk, recoveryCode } */
  AG.setupKeys = async function (password) {
    const raw = rand(32);
    const salt = b64(rand(16)), saltRec = b64(rand(16));
    const recoveryCode = newRecoveryCode();
    const meta = {
      version: '1', salt, saltRec, iter: String(iterations()),
      wrapPw: await wrap(raw, await deriveKek(password, salt)),
      wrapRec: await wrap(raw, await deriveKek(normCode(recoveryCode), saltRec))
    };
    return { meta, dk: await importDk(raw), recoveryCode };
  };
  AG.unlock = async function (meta, password) {
    const raw = await unwrap(meta.wrapPw, await deriveKek(password, meta.salt, +meta.iter));
    return importDk(raw);
  };
  /* Remplace le mot de passe : exige l'ancien mot de passe OU le code de récupération. */
  AG.changePassword = async function (meta, { oldPassword, recoveryCode }, newPassword) {
    const raw = oldPassword !== undefined
      ? await unwrap(meta.wrapPw, await deriveKek(oldPassword, meta.salt, +meta.iter))
      : await unwrap(meta.wrapRec, await deriveKek(normCode(recoveryCode), meta.saltRec, +meta.iter));
    const salt = b64(rand(16));
    return Object.assign({}, meta, { salt, iter: String(iterations()), wrapPw: await wrap(raw, await deriveKek(newPassword, salt)) });
  };
  AG.encField = async function (dk, text) {
    if (text === undefined || text === null || text === '') return '';
    const iv = rand(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, dk, enc.encode(String(text)));
    return 'v1.' + b64(iv) + '.' + b64(ct);
  };
  AG.decField = async function (dk, str) {
    if (!str) return '';
    const [v, iv, ct] = String(str).split('.');
    if (v !== 'v1') throw new Error('format inconnu');
    return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, dk, unb64(ct)));
  };

  /* ---------- Entrées et lignes du Sheet ----------
     Colonnes : A id | B date | C kind | D statut | E début | F fin | G type RDV |
     H détail* | I nom* | J code unité* | K n° procédure* | L année UNA* | M maj | N supprimé | O clé statut
     (* = chiffré) */
  AG.COLS = 15;
  AG.rowFromEntry = async function (e, dk) {
    return [
      e.id, e.date, e.kind, e.statut || '', e.debut || '', e.fin || '', e.type || '',
      await AG.encField(dk, e.detail), await AG.encField(dk, e.nom), await AG.encField(dk, e.cu),
      await AG.encField(dk, e.np), await AG.encField(dk, e.an),
      e.maj, e.del ? 1 : 0, (e.kind === 'statut' && !e.del) ? e.date + '|statut' : ''
    ];
  };
  AG.entryFromRow = async function (r, dk) {
    return {
      id: r[0], date: r[1], kind: r[2], statut: r[3] || '', debut: r[4] || '', fin: r[5] || '', type: r[6] || '',
      detail: await AG.decField(dk, r[7]), nom: await AG.decField(dk, r[8]), cu: await AG.decField(dk, r[9]),
      np: await AG.decField(dk, r[10]), an: await AG.decField(dk, r[11]),
      maj: Number(r[12]) || 0, del: Number(r[13]) === 1
    };
  };
  const padRow = (r) => { const x = r.slice(); while (x.length < AG.COLS) x.push(''); return x; };

  /* ---------- Client Google Sheets (fetch injectable) ---------- */
  AG.sheetsApi = function (fetchFn, getToken, sheetId) {
    const base = 'https://sheets.googleapis.com/v4/spreadsheets/' + encodeURIComponent(sheetId);
    async function call(path, opts) {
      const token = await getToken();
      if (!token) { const e = new Error('auth'); e.code = 'auth'; throw e; }
      let res;
      try {
        res = await fetchFn(base + path, Object.assign({}, opts, {
          headers: Object.assign({ Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, (opts || {}).headers)
        }));
      } catch (err) { const e = new Error('réseau'); e.code = 'network'; throw e; }
      if (res.status === 401 || res.status === 403) { const e = new Error('auth'); e.code = 'auth'; throw e; }
      if (!res.ok) { const e = new Error('Google ' + res.status); e.code = 'http'; throw e; }
      return res.json();
    }
    let gridRows = 0;
    async function ensureGrid(needRows) {
      try {
        const j = await call('?fields=' + encodeURIComponent('sheets(properties(sheetId,title,gridProperties(rowCount,columnCount)))'));
        const sh = (j.sheets || []).map((s) => s.properties).find((p) => p && p.title === 'Jours'); if (!sh) return;
        const g = sh.gridProperties || {}, cols = Math.max(g.columnCount || 0, 32), rows = Math.max(g.rowCount || 0, needRows + 200);
        if (cols !== g.columnCount || rows !== g.rowCount) await call(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ updateSheetProperties: { properties: { sheetId: sh.sheetId, gridProperties: { rowCount: rows, columnCount: cols } }, fields: 'gridProperties(rowCount,columnCount)' } }] }) });
        gridRows = rows;
      } catch (e) { if (e.code === 'auth') throw e; gridRows = needRows + 200; }
    }
    return {
      /* Lit A2:AF et recale chaque ligne sur son identifiant (st-, no-, ac-, rv-) :
         répare les lignes décalées par une ancienne version. rows.mis = indices recalés. */
      async getRows() {
        const j = await call('/values/' + encodeURIComponent('Jours!A2:AF') + '?valueRenderOption=FORMATTED_VALUE');
        const rows = [], mis = new Set();
        (j.values || []).forEach((raw, i) => {
          let k = raw.findIndex((x) => /^(st|no|ac|rv)-/.test(String(x)));
          if (k < 0) { rows.push(padRow(raw.slice(0, AG.COLS))); return; }
          if (k > 0) mis.add(i);
          rows.push(padRow(raw.slice(k, k + AG.COLS)));
        });
        rows.mis = mis; return rows;
      },
      /* Écrit toujours dans A:AF à partir d'une ligne explicite (jamais « append »). */
      async writeRows(start, rows) {
        const w = (r) => { const x = padRow(r); while (x.length < 32) x.push(''); return x; };
        const end = start + rows.length - 1;
        if (!gridRows || end > gridRows) await ensureGrid(end);
        await call('/values/' + encodeURIComponent('Jours!A' + start + ':AF' + end) + '?valueInputOption=RAW',
          { method: 'PUT', body: JSON.stringify({ values: rows.map(w) }) });
      },
      async updateRow(n, row) { await this.writeRows(n, [row]); },
      async clearRow(n) { await this.writeRows(n, [new Array(32).fill('')]); },
      async getMeta() {
        const j = await call('/values/' + encodeURIComponent('Réglages!A2:B14') + '?valueRenderOption=FORMATTED_VALUE');
        const m = {};
        (j.values || []).forEach((r) => { if (r[0]) m[r[0]] = r[1] || ''; });
        return m;
      },
      async setMeta(meta) {
        const keys = ['version', 'salt', 'wrapPw', 'saltRec', 'wrapRec', 'iter', 'perms', 'cfg'];
        await call('/values/' + encodeURIComponent('Réglages!A5:B12') + '?valueInputOption=RAW',
          { method: 'PUT', body: JSON.stringify({ values: keys.map((k) => [k, meta[k] || '']) }) });
      },
      async getTerritoire() {
        const j = await call('/values/' + encodeURIComponent('Réglages!B2'));
        return ((j.values || [])[0] || [])[0] || '';
      }
    };
  };

  /* ---------- Synchronisation ----------
     local : Map id -> ligne chiffrée ; pending : Set d'ids à envoyer.
     Règle : la modification la plus récente gagne ; une modification locale écrasée est signalée. */
  AG.sync = async function (api, local, pending) {
    const result = { pushed: 0, pulled: 0, conflicts: 0 };
    const remoteRows = await api.getRows();
    const mis = remoteRows.mis || new Set();
    const remote = new Map(), junk = [];
    remoteRows.forEach((r, i) => {
      if (!r[0]) return;
      const id = String(r[0]), n = i + 2, prev = remote.get(id);
      if (!prev) { remote.set(id, { n, row: r, mis: mis.has(i) }); return; }
      if (Number(r[12]) >= Number(prev.row[12])) { junk.push(prev.n); remote.set(id, { n, row: r, mis: mis.has(i) }); } else junk.push(n);
    });
    for (const n of junk) await api.clearRow(n);              // doublons vidés
    for (const rem of remote.values()) if (rem.mis) await api.updateRow(rem.n, rem.row); // lignes décalées remises en place
    const toAppend = [];
    for (const id of Array.from(pending)) {
      const row = local.get(id);
      if (!row) { pending.delete(id); continue; }
      const rem = remote.get(id);
      if (rem) {
        if (Number(rem.row[12]) > Number(row[12])) { local.set(id, rem.row); result.conflicts++; pending.delete(id); continue; }
        await api.updateRow(rem.n, row);
        pending.delete(id); result.pushed++;
      } else { toAppend.push(id); }
    }
    if (toAppend.length) {
      await api.writeRows(remoteRows.length + 2, toAppend.map((id) => padRow(local.get(id))));
      toAppend.forEach((id) => pending.delete(id)); result.pushed += toAppend.length;
    }
    remote.forEach((rem, id) => {
      const mine = local.get(id);
      if (!mine || Number(rem.row[12]) > Number(mine[12])) { if (!pending.has(id)) { local.set(id, rem.row); result.pulled++; } }
    });
    return result;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AG; else root.AG = AG;
})(typeof window !== 'undefined' ? window : globalThis);
