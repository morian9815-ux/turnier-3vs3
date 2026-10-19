/* 3vs3 Turnier-Terminfinder – Frontend (Vanilla JS SPA mit Hash-Routing) */
(() => {
  'use strict';

  const T = window.TOURNAMENT;
  const { PHASES, WEEKS, HOURS, KICKOFF, phaseDates, getPhase, formatDay, hourLabel, formatRange } = T;

  const $app = document.getElementById('app');
  const LS_PLAYER = '3vs3.playerId';
  const SS_ADMIN = '3vs3.adminToken';
  const STATUS_LABEL = { green: 'Kann ich', yellow: 'Unsicher', red: 'Kann ich nicht' };
  const NEXT = { red: 'green', green: 'yellow', yellow: 'red' };
  const REFRESH_MS = 30000;

  const S = { adminPhase: PHASES[0].id, insightPlayer: null, insightPhase: null };
  let dirty = false;
  let ignoreHash = false;
  let currentHash = location.hash || '#/';
  let cleanups = [];

  // ---------- Helfer ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const key = (date, hour) => `${date}|${hour}`;
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const onCleanup = (fn) => cleanups.push(fn);
  const runCleanup = () => { cleanups.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); cleanups = []; };
  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const slotLabel = (k) => { const [d, h] = k.split('|'); const f = formatDay(d); return `${f.weekday}, ${f.short} · ${hourLabel(Number(h))}`; };

  async function api(path, { method = 'GET', body } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = sessionStorage.getItem(SS_ADMIN);
    if (token) headers.Authorization = 'Bearer ' + token;
    let res;
    try {
      res = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, cache: 'no-store' });
    } catch {
      throw new Error('Keine Verbindung zum Server. Bitte Internetverbindung prüfen.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && token && !path.startsWith('/admin/login')) {
        sessionStorage.removeItem(SS_ADMIN);
        toast('Admin-Sitzung abgelaufen – bitte neu anmelden.', 'error');
        setTimeout(() => go('#/'), 0);
      }
      const err = new Error(data.error || `Fehler ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function toast(msg, type = 'ok') {
    const box = document.getElementById('toasts');
    const t = el(`<div class="toast ${type}"><span>${type === 'error' ? '⚠' : type === 'info' ? 'ℹ' : '✓'}</span><p>${esc(msg)}</p></div>`);
    box.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, type === 'error' ? 5000 : 3000);
  }

  function modal({ title, body = '', confirmText = 'OK', cancelText = 'Abbrechen', danger = false, onConfirm }) {
    return new Promise((resolve) => {
      const m = el(`
        <div class="modal-backdrop">
          <form class="modal metal" novalidate>
            <h3>${esc(title)}</h3>
            <div class="modal-body">${body}</div>
            <p class="modal-error" hidden></p>
            <div class="modal-actions">
              ${cancelText ? `<button type="button" class="btn btn-ghost" data-cancel>${esc(cancelText)}</button>` : ''}
              <button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(confirmText)}</button>
            </div>
          </form>
        </div>`);
      document.body.appendChild(m);
      const form = m.querySelector('form');
      const errBox = m.querySelector('.modal-error');
      const submit = form.querySelector('[type=submit]');
      const close = (val) => { m.classList.remove('show'); setTimeout(() => m.remove(), 200); document.removeEventListener('keydown', onKey); resolve(val); };
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      document.addEventListener('keydown', onKey);
      m.addEventListener('mousedown', (e) => { if (e.target === m) close(null); });
      form.querySelector('[data-cancel]')?.addEventListener('click', () => close(null));
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (!onConfirm) return close(true);
        submit.disabled = true;
        errBox.hidden = true;
        try {
          const result = await onConfirm(form);
          close(result === undefined ? true : result);
        } catch (err) {
          errBox.textContent = err.message;
          errBox.hidden = false;
          submit.disabled = false;
        }
      });
      requestAnimationFrame(() => {
        m.classList.add('show');
        (form.querySelector('input,select') || submit).focus();
      });
    });
  }

  const promptModal = (title, label, value, onSave) => modal({
    title,
    confirmText: 'Speichern',
    body: `<label class="field"><span>${esc(label)}</span><input name="value" value="${esc(value)}" maxlength="60" autocomplete="off" required></label>`,
    onConfirm: (form) => onSave(form.value.value.trim()),
  });

  const confirmModal = (title, text, confirmText = 'Löschen') => modal({ title, body: `<p>${text}</p>`, confirmText, danger: true });

  function kickoffBanner(compact = false) {
    const days = Math.ceil((new Date(KICKOFF.iso) - Date.now()) / 86400000);
    const f = formatDay(KICKOFF.date);
    const when = days > 1 ? `noch ${days} Tage` : days === 1 ? 'morgen!' : days === 0 ? 'heute!' : 'Turnier läuft';
    return `
      <div class="kickoff ${compact ? 'compact' : ''}">
        <span class="live-dot"></span>
        <div class="ko-text"><b>${esc(KICKOFF.label)}</b><span>${f.weekdayLong}, ${f.full} · ${KICKOFF.time} Uhr</span></div>
        <span class="ko-count">${when}</span>
      </div>`;
  }

  function brand(small = false) {
    if (small) {
      return `
        <div class="brand small">
          <img src="/logo.png" alt="3vs3 Turnier Logo" class="brand-crest-sm">
          <span class="logo"><b>3<i>vs</i>3</b></span>
          <span class="brand-text"><b>Turnier-Terminfinder</b><small>Winter 2026 · 09.11. – 06.12.</small></span>
        </div>`;
    }
    return `
      <div class="brand hero-brand">
        <div class="crest-showcase">
          <div class="crest-glow"></div>
          <img src="/logo.png" alt="3vs3 Turnier Wappen" class="crest-img">
        </div>
        <div class="brand-row">
          <span class="logo"><b>3<i>vs</i>3</b></span>
          <span class="brand-text"><b>Turnier-Terminfinder</b><small>Winter 2026 · 09.11. – 06.12.</small></span>
        </div>
      </div>`;
  }

  function legend(kind = 'edit') {
    if (kind === 'match') {
      return `<div class="legend">
        <span><i class="lg m-perfect"></i>Perfekt – alle grün</span>
        <span><i class="lg m-maybe"></i>Möglich – keiner rot, mind. 1 gelb</span>
        <span><i class="lg m-no"></i>Nicht möglich – mind. 1 rot / nicht eingetragen</span>
        <span><i class="lg m-own-busy"></i>🚫 Eigenes Spiel (gesperrt, inkl. ~1,5h)</span>
        <span><i class="lg m-tv"></i>📺 Anderes Spiel (Stream-Hinweis)</span>
      </div>`;
    }
    return `<div class="legend">
      <span><i class="lg s-green"></i>Grün = Kann ich</span>
      <span><i class="lg s-yellow"></i>Gelb = Unsicher</span>
      <span><i class="lg s-red"></i>Rot = Kann ich nicht</span>
    </div>`;
  }

  // ---------- Router ----------
  window.addEventListener('hashchange', () => {
    if (ignoreHash) { ignoreHash = false; return; }
    if (dirty && !confirm('Du hast ungespeicherte Änderungen. Wirklich verwerfen?')) {
      ignoreHash = true;
      location.hash = currentHash;
      return;
    }
    dirty = false;
    route();
  });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  async function route() {
    currentHash = location.hash || '#/';
    runCleanup();
    window.scrollTo(0, 0);
    const parts = currentHash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    try {
      if (parts[0] === 'player' && parts[1] === 'phase') await renderPlayerPhase(parts[2], parts[3] === 'match' ? parts[4] : null);
      else if (parts[0] === 'player') await renderPlayerHome();
      else if (parts[0] === 'admin') await renderAdmin(parts[1] || 'teams', parts.slice(2));
      else await renderLogin();
    } catch (err) {
      console.error(err);
      $app.innerHTML = `<div class="container"><div class="card error-card"><h2>Da ist etwas schiefgelaufen</h2><p>${esc(err.message)}</p><button class="btn btn-primary" onclick="location.reload()">Neu laden</button> <a class="btn btn-ghost" href="#/">Zur Startseite</a></div></div>`;
    }
  }

  // =====================================================================
  //  STARTSEITE / LOGIN
  // =====================================================================
  async function renderLogin() {
    const players = await api('/players');
    const remembered = players.find((p) => String(p.id) === localStorage.getItem(LS_PLAYER));
    $app.innerHTML = `
      <div class="login-page">
        <div class="login-hero">
          ${brand()}
          <h1 class="hero-title">Finde deinen <span>Spieltermin</span></h1>
          <p class="hero-sub">3 gegen 3 · 6 Spieler pro Match · 4 Turnierwochen</p>
          ${kickoffBanner()}
        </div>
        <section class="card metal login-card">
          <h2>Spieler-Login</h2>
          <p class="muted">Suche deinen Namen und logge dich ein – kein Passwort nötig.</p>
          ${remembered ? `<button class="continue-chip" id="continue-btn">↩ Weiter als <b>${esc(remembered.name)}</b></button>` : ''}
          <div class="search">
            <span class="search-icon">⌕</span>
            <input id="player-search" type="search" autocomplete="off" spellcheck="false" placeholder="${players.length ? 'Namen eingeben …' : 'Noch keine Spieler angelegt'}" ${players.length ? '' : 'disabled'} role="combobox" aria-expanded="false" aria-controls="search-results">
            <ul id="search-results" class="dropdown" role="listbox" hidden></ul>
          </div>
          <button id="login-btn" class="btn btn-primary btn-block" disabled>Einloggen</button>
          ${players.length ? '' : '<p class="hint">Der Admin muss zuerst Teams & Spieler anlegen.</p>'}
        </section>
        <div class="admin-entry">
          <button class="btn btn-ghost" id="admin-login-btn">🔒 Admin-Login</button>
        </div>
        ${phaseStrip()}
      </div>`;

    const input = document.getElementById('player-search');
    const list = document.getElementById('search-results');
    const loginBtn = document.getElementById('login-btn');
    let selected = null;
    let results = [];
    let active = -1;

    const label = (p) => `${p.name} (${p.team_name || 'ohne Team'})`;
    const highlight = (text, q) => {
      if (!q) return esc(text);
      const i = norm(text).indexOf(norm(q));
      if (i < 0) return esc(text);
      return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
    };
    const renderList = () => {
      const q = input.value.trim();
      results = players.filter((p) => !q || norm(p.name).includes(norm(q)) || norm(p.team_name).includes(norm(q))).slice(0, 50);
      list.innerHTML = results.length
        ? results.map((p, i) => `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}"><span class="r-name">${highlight(p.name, q)}</span><span class="r-team">${p.team_name ? highlight(p.team_name, q) : '<em>ohne Team</em>'}</span></li>`).join('')
        : '<li class="empty">Kein Spieler gefunden</li>';
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    };
    const choose = (p) => {
      selected = p;
      input.value = label(p);
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      loginBtn.disabled = false;
      loginBtn.textContent = `Einloggen als ${p.name}`;
      loginBtn.focus();
    };
    const login = (p) => { localStorage.setItem(LS_PLAYER, String(p.id)); go('#/player'); };

    input.addEventListener('input', () => {
      selected = null; active = -1;
      loginBtn.disabled = true; loginBtn.textContent = 'Einloggen';
      renderList();
    });
    input.addEventListener('focus', () => { if (!selected) renderList(); });
    input.addEventListener('keydown', (e) => {
      if (list.hidden && e.key === 'Enter' && selected) { login(selected); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); renderList(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); renderList(); }
      else if (e.key === 'Enter') { e.preventDefault(); const p = results[active >= 0 ? active : 0]; if (p) choose(p); }
      else if (e.key === 'Escape') { list.hidden = true; }
      list.querySelector('li.active')?.scrollIntoView({ block: 'nearest' });
    });
    list.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-i]');
      if (li) { e.preventDefault(); choose(results[Number(li.dataset.i)]); }
    });
    const outside = (e) => { if (!e.target.closest('.search')) list.hidden = true; };
    document.addEventListener('mousedown', outside);
    onCleanup(() => document.removeEventListener('mousedown', outside));
    loginBtn.addEventListener('click', () => selected && login(selected));
    document.getElementById('continue-btn')?.addEventListener('click', () => login(remembered));
    document.getElementById('admin-login-btn').addEventListener('click', openAdminLogin);
  }

  function phaseStrip() {
    return `<div class="phase-strip">${PHASES.map((p) => `<span class="strip-seg c-${p.color}" title="${esc(p.name)} · ${formatRange(p)}"></span>`).join('')}</div>`;
  }

  function openAdminLogin() {
    modal({
      title: 'Admin-Login',
      confirmText: 'Anmelden',
      body: `<label class="field"><span>Admin-Passwort</span><input type="password" name="password" autocomplete="current-password" required></label>`,
      onConfirm: async (form) => {
        const pw = form.password.value;
        if (!pw) throw new Error('Bitte Passwort eingeben.');
        const { token } = await api('/admin/login', { method: 'POST', body: { password: pw } });
        sessionStorage.setItem(SS_ADMIN, token);
      },
    }).then((ok) => { if (ok) go('#/admin/teams'); });
  }

  // =====================================================================
  //  SPIELER-BEREICH
  // =====================================================================
  async function loadMe() {
    const pid = localStorage.getItem(LS_PLAYER);
    if (!pid) { go('#/'); return null; }
    try {
      return await api(`/players/${pid}`);
    } catch (err) {
      if (err.status === 404 || err.status === 400) {
        localStorage.removeItem(LS_PLAYER);
        toast('Dein Spielerprofil wurde nicht gefunden. Bitte erneut einloggen.', 'error');
        go('#/');
        return null;
      }
      throw err;
    }
  }

  function notifMeta(kind) {
    switch (kind) {
      case 'proposal_received':
        return { icon: '📩', label: 'Terminvorschlag erhalten', cls: 'nc-incoming' };
      case 'counter_proposal':
        return { icon: '🔄', label: 'Gegenvorschlag erhalten', cls: 'nc-incoming' };
      case 'match_confirmed':
        return { icon: '🎉', label: 'Fester Termin bestätigt', cls: 'nc-confirmed' };
      case 'all_6_ready':
        return { icon: '🔓', label: 'Alle 6 Spieler bereit', cls: 'nc-ready' };
      case 'teammate_proposed':
        return { icon: '👥', label: 'Mitspieler-Vorschlag', cls: 'nc-team' };
      case 'teammate_availability':
        return { icon: '👥', label: 'Mitspieler-Zeiten', cls: 'nc-team' };
      case 'match_reset':
        return { icon: '⚠️', label: 'Termin zurückgesetzt', cls: 'nc-reset' };
      default:
        return { icon: '🔔', label: 'Turnier-Info', cls: 'nc-team' };
    }
  }

  function notifTopbarBtn(me) {
    const unread = Number(me.unreadCount || 0);
    return `
      <button type="button" class="notif-top-btn ${unread > 0 ? 'has-unread' : ''}" id="notif-center-btn" title="Nachrichtenzentrale öffnen">
        <span class="notif-bell" aria-hidden="true">🔔</span>
        <span class="notif-btn-text">Nachrichten</span>
        ${unread > 0
          ? `<span class="notif-red-badge" id="notif-top-badge" aria-label="${unread} ungelesene Nachrichten">${unread}</span>`
          : `<span class="notif-zero-badge" id="notif-top-badge">0</span>`}
      </button>`;
  }

  function notifStartBanner(me) {
    const unread = Number(me.unreadCount || 0);
    if (unread <= 0) return '<div id="notif-start-banner-wrap"></div>';
    const unreadList = (me.notifications || []).filter((n) => !n.is_read);
    const newest = unreadList[0];
    const meta = newest ? notifMeta(newest.kind) : { icon: '🔔' };
    return `
      <div id="notif-start-banner-wrap">
        <div class="notif-slim-banner metal" id="notif-slim-banner" role="region" aria-label="Ungelesene Nachrichten">
          <div class="nsb-left">
            <span class="notif-red-badge lg">${unread}</span>
            <div class="nsb-text">
              <b>Du hast ${unread === 1 ? '1 neue, ungelesene Nachricht' : `${unread} neue, ungelesene Nachrichten`}!</b>
              ${newest ? `<span class="nsb-preview">${meta.icon} <em>${esc(newest.title)}</em>${unread > 1 ? ` · und ${unread - 1} weitere` : ''}</span>` : ''}
            </div>
          </div>
          <div class="nsb-actions">
            <button type="button" class="btn btn-primary btn-sm" id="nsb-open-btn">📬 Nachrichtenzentrale öffnen</button>
            <button type="button" class="btn btn-ghost btn-sm" id="nsb-readall-btn" title="Alle als gelesen markieren">✓ Alle gelesen</button>
          </div>
        </div>
      </div>`;
  }

  function playerTopbar(me) {
    const p = me.player;
    return `
      <header class="topbar metal">
        ${brand(true)}
        <div class="who">
          <div class="who-main"><span class="avatar">${esc(p.name.slice(0, 1).toUpperCase())}</span>
            <div><b>${esc(p.name)}</b><small>${p.team_name ? esc(p.team_name) : 'ohne Team'}</small></div>
          </div>
          ${me.teammates.length ? `<div class="mates"><span>Mitspieler:</span>${me.teammates.map((m) => `<span class="mate">${esc(m.name)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="topbar-actions">
          ${notifTopbarBtn(me)}
          <button class="btn btn-ghost btn-sm" id="logout-btn">Logout</button>
        </div>
      </header>`;
  }

  function updateNotifUI(me) {
    const unread = Number(me.unreadCount || 0);
    const topBtn = document.getElementById('notif-center-btn');
    if (topBtn) {
      topBtn.classList.toggle('has-unread', unread > 0);
      const badge = document.getElementById('notif-top-badge');
      if (badge) {
        badge.className = unread > 0 ? 'notif-red-badge' : 'notif-zero-badge';
        badge.textContent = String(unread);
      }
    }
    const bannerWrap = document.getElementById('notif-start-banner-wrap');
    if (bannerWrap) {
      const tmp = document.createElement('div');
      tmp.innerHTML = notifStartBanner(me);
      bannerWrap.replaceWith(tmp.firstElementChild);
      bindNotifBannerEvents(me);
    }
  }

  function openNotificationCenter(me) {
    const existing = document.getElementById('notif-modal-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop notif-backdrop';
    backdrop.id = 'notif-modal-backdrop';

    const renderModalContent = () => {
      const list = me.notifications || [];
      const unread = list.filter((n) => !n.is_read);
      const read = list.filter((n) => n.is_read);

      const renderItem = (n) => {
        const meta = notifMeta(n.kind);
        const ph = n.phase_id ? getPhase(n.phase_id) : null;
        const canJump = Boolean(n.phase_id && n.matchup_id);
        return `
          <div class="nc-card ${meta.cls} ${n.is_read ? 'is-read' : 'is-unread'}" data-nid="${n.id}">
            <div class="nc-card-top">
              <span class="nc-type-badge">${meta.icon} ${esc(meta.label)}</span>
              ${ph ? `<span class="nc-phase-tag">${esc(ph.name)} · Woche ${ph.week}</span>` : ''}
              ${!n.is_read
                ? '<span class="nc-unread-pill"><i class="nc-red-dot"></i>NEU</span>'
                : '<span class="nc-read-pill">✓ Gelesen</span>'}
            </div>
            <h4 class="nc-card-title">${esc(n.title)}</h4>
            <p class="nc-card-body">${esc(n.body)}</p>
            <div class="nc-card-actions">
              ${canJump
                ? `<button type="button" class="btn btn-primary btn-sm nc-jump-btn" data-nid="${n.id}" data-phase="${esc(n.phase_id)}" data-match="${n.matchup_id}">
                    ⚔ Direkt zum Match-Abgleich ›
                  </button>`
                : ph
                ? `<button type="button" class="btn btn-primary btn-sm nc-jump-phase-btn" data-nid="${n.id}" data-phase="${esc(n.phase_id)}">
                    🗓 Zur Turnierphase ›
                  </button>`
                : ''}
              ${!n.is_read
                ? `<button type="button" class="btn btn-ghost btn-sm nc-mark-btn" data-nid="${n.id}">✓ Als gelesen markieren</button>`
                : ''}
            </div>
          </div>`;
      };

      backdrop.innerHTML = `
        <div class="modal notif-modal metal" role="dialog" aria-modal="true" aria-labelledby="nc-modal-title">
          <header class="nc-head">
            <div class="nc-head-title">
              <span class="nc-head-icon">📬</span>
              <div>
                <h3 id="nc-modal-title">Nachrichtenzentrale</h3>
                <p class="muted">Alle wichtigen Updates zu Terminvorschlägen, Einigungen & deinem Team</p>
              </div>
              ${unread.length > 0 ? `<span class="notif-red-badge lg">${unread.length} neu</span>` : '<span class="badge ok">Alles gelesen</span>'}
            </div>
            <div class="nc-head-actions">
              ${unread.length > 0 ? `<button type="button" class="btn btn-ghost btn-sm" id="nc-mark-all-btn">✓ Alle als gelesen markieren</button>` : ''}
              <button type="button" class="btn btn-ghost btn-sm" id="nc-close-btn">✕ Schließen</button>
            </div>
          </header>
          <div class="nc-body">
            ${list.length === 0 ? `
              <div class="nc-empty">
                <p>Aktuell liegen noch keine Nachrichten für dich vor.</p>
              </div>
            ` : `
              ${unread.length > 0 ? `
                <div class="nc-section">
                  <div class="nc-sec-title"><span class="notif-red-badge sm">${unread.length}</span> Ungelesene Nachrichten</div>
                  <div class="nc-list">${unread.map(renderItem).join('')}</div>
                </div>
              ` : `
                <div class="nc-all-clear">
                  <span>🎉</span> Du bist auf dem neuesten Stand – keine ungelesenen Nachrichten!
                </div>
              `}
              ${read.length > 0 ? `
                <div class="nc-section nc-read-sec">
                  <div class="nc-sec-title muted">Bereits gelesen (${read.length})</div>
                  <div class="nc-list">${read.map(renderItem).join('')}</div>
                </div>
              ` : ''}
            `}
          </div>
        </div>`;

      const close = () => backdrop.remove();
      backdrop.querySelector('#nc-close-btn')?.addEventListener('click', close);
      backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });

      backdrop.querySelector('#nc-mark-all-btn')?.addEventListener('click', async () => {
        try {
          const res = await api(`/players/${me.player.id}/notifications/read-all`, { method: 'POST' });
          me.notifications = res.notifications;
          me.unreadCount = res.unreadCount;
          updateNotifUI(me);
          renderModalContent();
          toast('Alle Nachrichten als gelesen markiert.', 'ok');
        } catch (err) {
          toast(err.message, 'error');
        }
      });

      backdrop.querySelectorAll('.nc-mark-btn').forEach((btn) => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          const nid = btn.dataset.nid;
          try {
            const res = await api(`/players/${me.player.id}/notifications/${nid}/read`, { method: 'POST' });
            me.notifications = res.notifications;
            me.unreadCount = res.unreadCount;
            updateNotifUI(me);
            renderModalContent();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });

      backdrop.querySelectorAll('.nc-jump-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const nid = btn.dataset.nid;
          const phId = btn.dataset.phase;
          const mId = btn.dataset.match;
          try {
            const res = await api(`/players/${me.player.id}/notifications/${nid}/read`, { method: 'POST' });
            me.notifications = res.notifications;
            me.unreadCount = res.unreadCount;
            updateNotifUI(me);
          } catch { /* ignore */ }
          close();
          go(`#/player/phase/${phId}/match/${mId}`);
        });
      });

      backdrop.querySelectorAll('.nc-jump-phase-btn').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const nid = btn.dataset.nid;
          const phId = btn.dataset.phase;
          try {
            const res = await api(`/players/${me.player.id}/notifications/${nid}/read`, { method: 'POST' });
            me.notifications = res.notifications;
            me.unreadCount = res.unreadCount;
            updateNotifUI(me);
          } catch { /* ignore */ }
          close();
          go(`#/player/phase/${phId}`);
        });
      });
    };

    renderModalContent();
    document.body.appendChild(backdrop);
  }

  function bindNotifBannerEvents(me) {
    document.getElementById('nsb-open-btn')?.addEventListener('click', () => openNotificationCenter(me));
    document.getElementById('notif-slim-banner')?.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openNotificationCenter(me);
    });
    document.getElementById('nsb-readall-btn')?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const res = await api(`/players/${me.player.id}/notifications/read-all`, { method: 'POST' });
        me.notifications = res.notifications;
        me.unreadCount = res.unreadCount;
        updateNotifUI(me);
        toast('Alle Nachrichten als gelesen markiert.', 'ok');
      } catch (err) {
        toast(err.message, 'error');
      }
    });
  }

  function bindLogout(me) {
    document.getElementById('logout-btn')?.addEventListener('click', () => {
      localStorage.removeItem(LS_PLAYER);
      go('#/');
    });
    if (me) {
      document.getElementById('notif-center-btn')?.addEventListener('click', () => openNotificationCenter(me));
      bindNotifBannerEvents(me);
    }
  }

  function opponentOf(m, teamId) {
    return m.team_a_id === teamId ? m.team_b_name : m.team_a_name;
  }

  async function renderPlayerHome() {
    const me = await loadMe();
    if (!me) return;
    const saved = new Set(me.savedPhases);
    const weekRange = (w) => {
      const ps = PHASES.filter((p) => p.week === w);
      return `${formatDay(ps[0].start).short} – ${formatDay(ps[ps.length - 1].end).short}`;
    };

    const heroMatchupsHTML = me.matchups.length ? `
      <section class="player-matches-hero metal">
        <div class="pmh-header">
          <div class="pmh-title">
            <span class="live-dot-green"></span>
            <div>
              <h2>⚔ Deine Spielpaarungen & 6-Spieler-Match-Abgleich</h2>
              <p class="muted">Hier siehst du auf einen Klick, wann alle 6 Spieler (3 vs. 3) gleichzeitig Zeit haben:</p>
            </div>
          </div>
          <span class="badge ok">${me.matchups.length} ${me.matchups.length === 1 ? 'Match angesetzt' : 'Matches angesetzt'}</span>
        </div>
        <div class="pmh-list">
          ${me.matchups.map((m) => {
            const ph = getPhase(m.phase_id);
            const opponent = opponentOf(m, me.player.team_id);
            const mySaved = saved.has(m.phase_id);
            const propSlots = Array.isArray(m.proposed_slots) ? m.proposed_slots : [];
            const isIncomingProp = !m.confirmed_slot && propSlots.length > 0 && m.proposed_by_team_id !== me.player.team_id;
            const isOutgoingProp = !m.confirmed_slot && propSlots.length > 0 && m.proposed_by_team_id === me.player.team_id;
            const isWaitingPlayers = !m.confirmed_slot && !propSlots.length && (m.phase_id === 'w3-r16' || !mySaved);

            let schedBanner = '';
            if (m.confirmed_slot) {
              schedBanner = `
                <div class="pmh-sched confirmed">
                  <span class="pmh-sched-icon">🏆</span>
                  <div class="pmh-sched-info">
                    <small>Fester Spieltermin (verbindlich festgelegt · Bestätigt von ${esc(m.confirmed_by_player_name || '')})</small>
                    <b>${slotLabel(m.confirmed_slot)} Uhr</b>
                  </div>
                  <span class="badge ok">🔒 Steht fest</span>
                </div>`;
            } else if (isIncomingProp) {
              schedBanner = `
                <div class="pmh-sched incoming">
                  <span class="pmh-sched-icon">📩</span>
                  <div class="pmh-sched-info">
                    <small>Terminvorschlag von <b>${esc(opponent)}</b> (${esc(m.proposed_by_player_name || '')}) – bitte im Match-Abgleich bestätigen oder Gegenvorschlag machen:</small>
                    <div class="pmh-prop-list">${propSlots.map((s) => `<span class="prop-chip">${slotLabel(s)} Uhr</span>`).join('')}</div>
                  </div>
                </div>`;
            } else if (isOutgoingProp) {
              schedBanner = `
                <div class="pmh-sched outgoing">
                  <span class="pmh-sched-icon">⏳</span>
                  <div class="pmh-sched-info">
                    <small>Euer Vorschlag (${esc(m.proposed_by_player_name || '')}) – wartet auf Bestätigung von <b>${esc(opponent)}</b>:</small>
                    <div class="pmh-prop-list">${propSlots.map((s) => `<span class="prop-chip">${slotLabel(s)} Uhr</span>`).join('')}</div>
                  </div>
                </div>`;
            } else if (isWaitingPlayers) {
              schedBanner = `
                <div class="pmh-sched pending">
                  <span class="pmh-sched-icon">⚠️</span>
                  <div class="pmh-sched-info">
                    <small>Noch nicht alle 6 Spieler haben ihre Zeiten für diese Phase gespeichert</small>
                    <span class="pmh-sched-sub">Die Termin-Einigung schaltet sich frei, sobald alle Spieler beider Teams eingetragen haben.</span>
                  </div>
                  <span class="badge warn">Zeiten fehlen noch</span>
                </div>`;
            } else {
              schedBanner = `
                <div class="pmh-sched ready">
                  <span class="pmh-sched-icon">🤝</span>
                  <div class="pmh-sched-info">
                    <small>Alle 6 Spieler haben abgestimmt · Termin-Einigung bereit (inkl. 📺 Stream-Radar)</small>
                    <span class="pmh-sched-sub">Jetzt im Match-Abgleich 1 bis 3 passende Termine auswählen & an <b>${esc(opponent)}</b> vorschlagen!</span>
                  </div>
                  <span class="badge ok">Bereit zur Einigung</span>
                </div>`;
            }

            return `
              <div class="pmh-card c-${ph ? ph.color : 'green'} ${m.confirmed_slot ? 'has-confirmed' : isIncomingProp ? 'has-incoming' : ''}">
                <div class="pmh-meta">
                  <span class="pmh-phase"><i class="dot"></i>${ph ? esc(ph.name) : ''}${ph && ph.subtitle ? ` (${esc(ph.subtitle)})` : ''} · Woche ${ph ? ph.week : ''}</span>
                  <span class="pmh-dates">${ph ? formatRange(ph) : ''}</span>
                </div>
                <div class="pmh-teams">
                  <div class="pmh-team my-team">
                    <small>Dein Team</small>
                    <b>${esc(me.player.team_name || 'Team A')}</b>
                  </div>
                  <div class="pmh-vs"><img src="/logo.png" alt="" class="pmh-vs-crest"><span>VS</span></div>
                  <div class="pmh-team opp-team">
                    <small>Gegner</small>
                    <b>${esc(opponent)}</b>
                  </div>
                </div>
                ${schedBanner}
                <div class="pmh-actions">
                  <a href="#/player/phase/${m.phase_id}/match/${m.id}" class="btn btn-primary btn-lg pmh-btn-match">
                    <span class="btn-main-txt">${isIncomingProp ? '📩 Terminvorschlag prüfen & bestätigen ›' : isOutgoingProp ? '⏳ Euren Vorschlag & Match-Abgleich ansehen ›' : m.confirmed_slot ? '🏆 Match-Abgleich & festen Termin ansehen ›' : isWaitingPlayers ? '⚠️ Match-Abgleich ansehen (wer fehlt noch?) ›' : '🤝 Jetzt 1–3 Termine im Match-Abgleich vorschlagen ›'}</span>
                    <span class="btn-sub-txt">${isIncomingProp ? `${propSlots.length} ${propSlots.length === 1 ? 'Termin' : 'Termine'} von ${esc(opponent)} vorgeschlagen` : isOutgoingProp ? `Wartet auf Antwort von ${esc(opponent)}` : m.confirmed_slot ? `Festgelegt: ${slotLabel(m.confirmed_slot)} Uhr` : isWaitingPlayers ? 'Zeigt, welche Spieler noch eintragen müssen' : 'Alle 6 Spieler fertig · Gemeinsame Termine & Stream-Radar'}</span>
                  </a>
                  <a href="#/player/phase/${m.phase_id}" class="btn btn-ghost pmh-btn-edit">
                    🗓 ${mySaved ? '✓ Meine Zeiten bearbeiten' : '⚠️ Erst eigene Zeiten eintragen'}
                  </a>
                </div>
              </div>`;
          }).join('')}
        </div>
      </section>
    ` : `
      <section class="player-matches-hero metal no-match">
        <div class="pmh-empty">
          <img src="/logo.png" alt="" class="pmh-empty-crest">
          <div>
            <h3>Noch keine Spielpaarung für dein Team</h3>
            <p class="muted">Sobald der Admin eine Paarung für <b>${esc(me.player.team_name || 'dein Team')}</b> festlegt, erscheint hier ganz oben der direkte 6-Spieler-Terminabgleich. Trage in der Zwischenzeit unten deine Zeiten in den Kalendern ein!</p>
          </div>
        </div>
      </section>
    `;

    $app.innerHTML = `
      ${playerTopbar(me)}
      <main class="container">
        ${notifStartBanner(me)}
        ${kickoffBanner()}
        ${heroMatchupsHTML}
        <div class="section-head">
          <h2>🗓 Alle Turnierphasen & Kalender</h2>
          <p class="muted">Trage deine persönlichen Verfügbarkeiten für jede Turnierwoche im Kalender ein:</p>
        </div>
        <div class="weeks">
          ${WEEKS.map((w) => `
            <section class="week-card metal">
              <header class="week-head">
                <span class="week-no">${w.title}</span>
                <span class="week-sub">${esc(w.subtitle)}</span>
                <span class="week-range">${weekRange(w.week)}</span>
              </header>
              <div class="phase-list">
                ${PHASES.filter((p) => p.week === w.week).map((p) => {
                  const ms = me.matchups.filter((m) => m.phase_id === p.id);
                  return `
                    <div class="phase-bar c-${p.color}" data-phase="${p.id}">
                      <div class="pb-top">
                        <span class="pb-name">${esc(p.name)}${p.subtitle ? ` <small>${esc(p.subtitle)}</small>` : ''}</span>
                        <span class="pb-arrow">›</span>
                      </div>
                      <span class="pb-dates">${formatRange(p)}</span>
                      <div class="pb-meta">
                        ${saved.has(p.id) ? '<span class="badge ok">✓ Zeiten gespeichert</span>' : '<span class="badge open">Noch nicht eingetragen</span>'}
                        ${ms.map((m) => `<span class="badge vs">⚔ vs. ${esc(opponentOf(m, me.player.team_id))}</span>${m.confirmed_slot ? `<span class="badge ok">🏆 ${slotLabel(m.confirmed_slot)}</span>` : ''}`).join('')}
                      </div>
                      ${ms.length ? `
                        <div class="pb-quick-match">
                          ${ms.map((m) => {
                            const ps = Array.isArray(m.proposed_slots) ? m.proposed_slots : [];
                            const ico = m.confirmed_slot ? '🏆' : ps.length ? (m.proposed_by_team_id !== me.player.team_id ? '📩' : '⏳') : '⚔';
                            return `<a href="#/player/phase/${p.id}/match/${m.id}" class="btn-match-direct" onclick="event.stopPropagation()">
                              ${ico} Match-Abgleich vs. ${esc(opponentOf(m, me.player.team_id))} ›
                            </a>`;
                          }).join('')}
                        </div>` : ''}
                    </div>`;
                }).join('')}
              </div>
            </section>`).join('')}
        </div>
      </main>`;
    bindLogout(me);
    $app.querySelectorAll('.phase-bar').forEach((b) => b.addEventListener('click', () => go(`#/player/phase/${b.dataset.phase}`)));
  }

  async function renderPlayerPhase(phaseId, matchupId) {
    const phase = getPhase(phaseId);
    if (!phase) return go('#/player');
    const me = await loadMe();
    if (!me) return;
    const myMatchups = me.matchups.filter((m) => m.phase_id === phase.id);
    const activeMatchup = myMatchups.find((x) => String(x.id) === String(matchupId)) || myMatchups[0] || null;
    const mode = matchupId ? 'match' : 'mine';
    const groupSiblings = PHASES.filter((p) => p.name === phase.name && PHASES.filter((x) => x.name === p.name).length > 1);

    $app.innerHTML = `
      <div class="phase-view c-${phase.color}">
        <header class="pv-head metal">
          <button class="btn btn-ghost btn-sm" id="back-btn">← Zur Übersicht</button>
          <div class="pv-title">
            <img src="/logo.png" alt="3vs3" class="pv-crest">
            <span class="pv-dot"></span>
            <div>
              <h1>${esc(phase.name)}${phase.subtitle ? ` <small>${esc(phase.subtitle)}</small>` : ''}</h1>
              <p>Woche ${phase.week} · ${formatRange(phase)}</p>
            </div>
          </div>
          <div class="pv-right-actions">
            ${notifTopbarBtn(me)}
            <div class="pv-user"><span class="avatar sm">${esc(me.player.name.slice(0, 1).toUpperCase())}</span><span>${esc(me.player.name)}<small>${esc(me.player.team_name || 'ohne Team')}</small></span></div>
          </div>
        </header>
        <div class="pv-content">
          ${groupSiblings.length > 1 ? `<div class="week-switch">${groupSiblings.map((p) => `<a href="#/player/phase/${p.id}" class="${p.id === phase.id ? 'active' : ''}">Woche ${p.week} <small>${formatDay(p.start).short} – ${formatDay(p.end).short}</small></a>`).join('')}</div>` : ''}
          <nav class="tabs big match-nav-tabs">
            <a class="tab ${mode === 'mine' ? 'active' : ''}" href="#/player/phase/${phase.id}">
              🗓 1. Meine Zeiten eintragen
            </a>
            ${activeMatchup
              ? `<a class="tab match-tab-highlight ${mode === 'match' ? 'active' : ''}" href="#/player/phase/${phase.id}/match/${activeMatchup.id}">
                  ⚔ 2. Match-Abgleich: 6 Spieler (${esc(me.player.team_name)} vs. ${esc(opponentOf(activeMatchup, me.player.team_id))}${myMatchups.length > 1 ? ` · +${myMatchups.length - 1} weiteres Spiel` : ''})
                  <span class="pulse-pill">🔥 Wichtig</span>
                </a>`
              : `<span class="tab disabled" title="Für diese Phase wurde noch keine Paarung für dein Team festgelegt.">⚔ 2. Match-Abgleich (Noch kein Gegner eingeteilt)</span>`}
          </nav>
          ${mode === 'mine' && activeMatchup ? `
            <div class="match-callout metal">
              <span class="mc-icon">⚔</span>
              <div class="mc-content">
                <b>${myMatchups.length > 1 ? `Angesetzte Matches (${myMatchups.length}) in dieser Phase:` : `Angesetztes Match: ${esc(me.player.team_name)} vs. ${esc(opponentOf(activeMatchup, me.player.team_id))}`}</b>
                <p>Trage unten deine Zeiten ein und speichere sie. Über die Buttons rechts (oder den Tab oben) gelangst du direkt zum 6-Spieler-Match-Abgleich:</p>
              </div>
              <div class="mc-cta-list">
                ${myMatchups.map((m) => `<a href="#/player/phase/${phase.id}/match/${m.id}" class="btn btn-primary btn-sm mc-cta">vs. ${esc(opponentOf(m, me.player.team_id))} ›</a>`).join('')}
              </div>
            </div>` : ''}
          ${!myMatchups.length ? '<p class="hint small">Der Match-Abgleich wird hier freigeschaltet, sobald der Admin eine Paarung mit deinem Team für diese Phase festlegt.</p>' : ''}
          <div id="pv-body"><div class="loading"><div class="spinner"></div></div></div>
        </div>
      </div>`;
    document.getElementById('back-btn').addEventListener('click', () => go('#/player'));
    document.getElementById('notif-center-btn')?.addEventListener('click', () => openNotificationCenter(me));
    const body = document.getElementById('pv-body');

    if (mode === 'mine') {
      await mountMyTimes(body, phase, me);
    } else {
      const m = myMatchups.find((x) => String(x.id) === String(matchupId));
      if (!m) return go(`#/player/phase/${phase.id}`);
      const chooser = myMatchups.length > 1
        ? `<div class="mu-chooser">
            <span class="muc-label">Deine Spiele in dieser Phase:</span>
            ${myMatchups.map((x) => {
              const ps = Array.isArray(x.proposed_slots) ? x.proposed_slots : [];
              const tag = x.confirmed_slot ? '🏆 Fest' : ps.length ? (x.proposed_by_team_id !== me.player.team_id ? '📩 Anfrage vom Gegner' : '⏳ Euer Vorschlag') : '🤝 Bereit';
              return `<a href="#/player/phase/${phase.id}/match/${x.id}" class="chip ${x.id === m.id ? 'active' : ''}">vs. ${esc(opponentOf(x, me.player.team_id))} <small>(${tag})</small></a>`;
            }).join('')}
          </div>`
        : '';
      await mountMatchView(body, phase, m.id, { prefix: chooser, highlightPlayer: me.player.id });
    }
  }

  async function mountMyTimes(body, phase, me) {
    const data = await api(`/players/${me.player.id}/availability/${phase.id}`);
    const cells = new Map();
    for (const d of phaseDates(phase)) for (const h of HOURS) cells.set(key(d, h), 'red');
    for (const c of data.cells) cells.set(key(c.date, c.hour), c.status);
    let savedOnce = data.saved;

    body.innerHTML = `
      <div class="cal-toolbar">
        ${legend('edit')}
        <div class="tool-actions">
          <button class="btn btn-ghost btn-sm" data-fill="green">Alles grün</button>
          <button class="btn btn-ghost btn-sm" data-fill="red">Alles zurücksetzen</button>
        </div>
      </div>
      <p class="hint small">Klick auf ein Feld: <b class="t-green">Grün</b> → <b class="t-yellow">Gelb</b> → <b class="t-red">Rot</b>. Mit gedrückter Maustaste ziehen, um mehrere Stunden zu markieren. Klick auf Tag oder Uhrzeit schaltet eine ganze Spalte/Zeile um.</p>
      <div id="editor"></div>
      <div class="savebar metal">
        <div class="save-state" id="save-state"></div>
        <button class="btn btn-primary btn-lg" id="save-btn"><span class="btn-label">💾 Zeiten speichern</span></button>
      </div>`;

    const stateEl = document.getElementById('save-state');
    const saveBtn = document.getElementById('save-btn');
    const counts = () => { const c = { green: 0, yellow: 0, red: 0 }; cells.forEach((s) => c[s]++); return c; };
    const updateState = () => {
      const c = counts();
      const summary = `<span class="cnt g">${c.green} grün</span><span class="cnt y">${c.yellow} gelb</span><span class="cnt r">${c.red} rot</span>`;
      stateEl.innerHTML = dirty
        ? `<b class="unsaved">● Ungespeicherte Änderungen</b>${summary}`
        : `<b class="${savedOnce ? 'saved' : 'unsaved-soft'}">${savedOnce ? '✓ Gespeichert' : 'Noch nicht gespeichert'}</b>${summary}`;
      saveBtn.classList.toggle('pulse', dirty);
    };

    const editor = mountEditor(document.getElementById('editor'), phase, cells, () => { dirty = true; updateState(); });
    updateState();

    body.querySelectorAll('[data-fill]').forEach((b) => b.addEventListener('click', () => {
      editor.setAll(b.dataset.fill);
    }));

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.classList.add('loading');
      saveBtn.querySelector('.btn-label').textContent = 'Speichere …';
      try {
        const payload = [...cells].map(([k, status]) => { const [date, hour] = k.split('|'); return { date, hour: Number(hour), status }; });
        await api(`/players/${me.player.id}/availability/${phase.id}`, { method: 'PUT', body: { cells: payload } });
        dirty = false;
        savedOnce = true;
        toast(`Zeiten für „${phase.name}${phase.subtitle ? ' – ' + phase.subtitle : ''}“ gespeichert!`);
        saveBtn.querySelector('.btn-label').textContent = '✓ Gespeichert';
        setTimeout(() => { saveBtn.querySelector('.btn-label').textContent = '💾 Zeiten speichern'; }, 1800);
      } catch (err) {
        toast('Speichern fehlgeschlagen: ' + err.message, 'error');
        saveBtn.querySelector('.btn-label').textContent = '💾 Zeiten speichern';
      } finally {
        saveBtn.disabled = false;
        saveBtn.classList.remove('loading');
        updateState();
      }
    });
  }

  // ---------- Kalender-Raster ----------
  function gridHTML(phase, { cellHTML, editable = false }) {
    const dates = phaseDates(phase);
    const hourCell = (h) => `<span class="hl-long">${hourLabel(h)}</span><span class="hl-short">${String(h).padStart(2, '0')}–${String(h + 1).padStart(2, '0')}</span>`;
    return `
      <div class="grid-scroll">
        <table class="cal ${editable ? 'editable' : ''} cols-${Math.min(dates.length, 7)}">
          <thead><tr>
            <th class="corner">Uhrzeit</th>
            ${dates.map((d) => { const f = formatDay(d); const inner = `<span class="wd">${f.weekday}</span><span class="dt">${f.short}</span>`;
              return `<th class="day ${['Sa', 'So'].includes(f.weekday) ? 'weekend' : ''}">${editable ? `<button type="button" class="hdr-btn" data-col="${d}" title="Ganzen Tag umschalten">${inner}</button>` : inner}</th>`; }).join('')}
          </tr></thead>
          <tbody>
            ${HOURS.map((h) => `<tr>
              <th class="hour">${editable ? `<button type="button" class="hdr-btn" data-row="${h}" title="Diese Stunde an allen Tagen umschalten">${hourCell(h)}</button>` : hourCell(h)}</th>
              ${dates.map((d) => cellHTML(d, h)).join('')}
            </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function mountEditor(container, phase, cells, onChange) {
    const dates = phaseDates(phase);
    container.innerHTML = gridHTML(phase, {
      editable: true,
      cellHTML: (d, h) => `<td class="cell s-${cells.get(key(d, h))}" data-k="${key(d, h)}" title="${slotLabel(key(d, h))}"></td>`,
    });
    const table = container.querySelector('table');
    const tdByKey = new Map([...table.querySelectorAll('td.cell')].map((td) => [td.dataset.k, td]));

    const setCell = (k, status) => {
      if (cells.get(k) === status) return false;
      cells.set(k, status);
      tdByKey.get(k).className = 'cell s-' + status;
      return true;
    };
    const bulk = (keys) => {
      const st = keys.map((k) => cells.get(k));
      const target = st.every((s) => s === 'green') ? 'yellow' : st.every((s) => s === 'yellow') ? 'red' : 'green';
      let changed = false;
      keys.forEach((k) => { changed = setCell(k, target) || changed; });
      if (changed) onChange();
    };

    let painting = null;
    let lastPointer = 'mouse';
    table.addEventListener('pointerdown', (e) => {
      lastPointer = e.pointerType;
      const td = e.target.closest('td.cell');
      if (!td || e.pointerType === 'touch' || e.button !== 0) return;
      e.preventDefault();
      painting = NEXT[cells.get(td.dataset.k)];
      if (setCell(td.dataset.k, painting)) onChange();
    });
    table.addEventListener('pointerover', (e) => {
      if (!painting) return;
      const td = e.target.closest('td.cell');
      if (td && setCell(td.dataset.k, painting)) onChange();
    });
    const stop = () => { painting = null; };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    onCleanup(() => { window.removeEventListener('pointerup', stop); window.removeEventListener('pointercancel', stop); });

    table.addEventListener('click', (e) => {
      const hb = e.target.closest('.hdr-btn');
      if (hb) {
        if (hb.dataset.col) bulk(HOURS.map((h) => key(hb.dataset.col, h)));
        else bulk(dates.map((d) => key(d, Number(hb.dataset.row))));
        return;
      }
      if (lastPointer !== 'touch') return; // Maus/Stift werden bereits über pointerdown behandelt
      const td = e.target.closest('td.cell');
      if (td && setCell(td.dataset.k, NEXT[cells.get(td.dataset.k)])) onChange();
    });

    return {
      setAll(status) {
        let changed = false;
        cells.forEach((_, k) => { changed = setCell(k, status) || changed; });
        if (changed) onChange();
      },
    };
  }

  function mountReadonlyGrid(container, phase, cells) {
    container.innerHTML = gridHTML(phase, {
      cellHTML: (d, h) => { const s = cells.get(key(d, h)) || 'red'; return `<td class="cell ro s-${s}" title="${slotLabel(key(d, h))}: ${STATUS_LABEL[s]}"></td>`; },
    });
  }

  // ---------- Match-Abgleich (6 Spieler + Termin-Einigung) ----------
  async function mountMatchView(body, phase, matchupId, { prefix = '', highlightPlayer = null, isAdmin = false } = {}) {
    let data;
    const tip = el('<div class="tooltip" hidden></div>');
    document.body.appendChild(tip);
    onCleanup(() => tip.remove());
    let pinned = null;
    const selectedPropose = new Set();
    let proposeMode = false;

    const render = () => {
      const m = data.matchup;
      const propSlots = Array.isArray(m.proposed_slots) ? m.proposed_slots : [];
      const allPlayers = [...data.teamA.players, ...data.teamB.players];
      const n = allPlayers.length;
      const statusOf = (pid, k) => data.availability[pid]?.[k] || 'red';
      const hasSaved = (pid) => Object.keys(data.availability[pid] || {}).length > 0;
      const info = (k) => {
        let g = 0, y = 0, r = 0;
        allPlayers.forEach((p) => { const s = statusOf(p.id, k); if (s === 'green') g++; else if (s === 'yellow') y++; else r++; });
        const cls = n === 0 ? 'm-none' : r > 0 ? 'm-no' : y > 0 ? 'm-maybe' : 'm-perfect';
        return { g, y, r, cls };
      };
      const dates = phaseDates(phase);
      const perfect = [];
      const maybe = [];
      for (const d of dates) for (const h of HOURS) {
        const i = info(key(d, h));
        if (i.cls === 'm-perfect') perfect.push(key(d, h));
        else if (i.cls === 'm-maybe') maybe.push({ k: key(d, h), ...i });
      }
      // Chronologische Sortierung beibehalten (Mo -> So, 08:00 -> 23:00)
      const missing = allPlayers.filter((p) => !hasSaved(p.id));
      const short = [data.teamA, data.teamB].filter((t) => t.players.length < 3);
      const allSaved = data.teamA.players.length > 0 && data.teamB.players.length > 0 && missing.length === 0;
      const mePlayer = highlightPlayer ? allPlayers.find((p) => p.id === highlightPlayer) : null;
      const myTeamId = mePlayer ? mePlayer.team_id : null;
      const propTeamName = m.proposed_by_team_id === data.teamA.id ? data.teamA.name : m.proposed_by_team_id === data.teamB.id ? data.teamB.name : '';
      const waitTeamName = m.proposed_by_team_id === data.teamA.id ? data.teamB.name : m.proposed_by_team_id === data.teamB.id ? data.teamA.name : '';

      // Parallelspiel- & Stream-Radar (Spieldauer bis ca. 1,5 Stunden -> ±1 Stunde am selben Tag)
      // - is_own_team === true: Eines der beiden beteiligten Teams spielt selbst schon -> GESPERRT (🚫)
      // - is_own_team === false: Fremdes Spiel -> Stream-/Zuschauer-Hinweis (📺⚠️)
      const pad2 = (x) => String(x).padStart(2, '0');
      const otherConfirmed = Array.isArray(data.otherConfirmed) ? data.otherConfirmed : [];
      const busyTeamNameOf = (c) => (c.team_a_id === data.teamA.id || c.team_b_id === data.teamA.id ? data.teamA.name : data.teamB.name);
      const conflictsFor = (slotKey) => {
        if (!slotKey || !slotKey.includes('|')) return [];
        const [d, hStr] = slotKey.split('|');
        const h = Number(hStr);
        const list = [];
        for (const oc of otherConfirmed) {
          if (!oc.confirmed_slot || !oc.confirmed_slot.includes('|')) continue;
          const [od, ohStr] = oc.confirmed_slot.split('|');
          const oh = Number(ohStr);
          if (od !== d) continue;
          const diff = h - oh;
          if (Math.abs(diff) <= 1) {
            list.push({
              ...oc,
              otherHour: oh,
              diff,
              exact: diff === 0,
            });
          }
        }
        return list;
      };
      const ownConflictsFor = (slotKey) => conflictsFor(slotKey).filter((c) => c.is_own_team);
      const streamConflictsFor = (slotKey) => conflictsFor(slotKey).filter((c) => !c.is_own_team);

      const conflictChipBadge = (k) => {
        const ownCs = ownConflictsFor(k);
        if (ownCs.length) {
          const c = ownCs[0];
          return `<span class="sp-conflict own-busy">🚫 ${esc(busyTeamNameOf(c))} spielt bereits (${pad2(c.otherHour)}:00)</span>`;
        }
        const cs = streamConflictsFor(k);
        if (!cs.length) return '';
        const hasExact = cs.some((c) => c.exact);
        const label = hasExact
          ? `📺⚠️ ${cs.length > 1 ? `${cs.length} Spiele parallel` : 'Parallelspiel'}`
          : '📺⚠️ Überschneidung (~1,5h)';
        return `<span class="sp-conflict ${hasExact ? 'exact' : 'overlap'}">${label}</span>`;
      };
      const conflictTitle = (k) => {
        const ownCs = ownConflictsFor(k);
        if (ownCs.length) {
          return 'Gesperrt (Eigenes Spiel ~1,5h): ' + ownCs.map((c) => `${busyTeamNameOf(c)} spielt bereits (${c.team_a_name} vs. ${c.team_b_name}, ${pad2(c.otherHour)}:00–${pad2(c.otherHour + 1)}:30 Uhr)`).join(', ');
        }
        const cs = streamConflictsFor(k);
        if (!cs.length) return '';
        return 'Achtung Stream/Zuschauer (~1,5h Spielzeit): ' + cs.map((c) => `${c.team_a_name} vs. ${c.team_b_name} (${pad2(c.otherHour)}:00–${pad2(c.otherHour + 1)}:30 Uhr)`).join(', ');
      };

      const teamBox = (t, side) => `
        <div class="team-box ${side}">
          <h3>${esc(t.name)}</h3>
          <ul>${t.players.map((p) => `<li class="${p.id === highlightPlayer ? 'me' : ''}">${esc(p.name)}${p.id === highlightPlayer ? ' <em>(du)</em>' : ''}
            ${hasSaved(p.id) ? '<span class="badge ok sm">✓ eingetragen</span>' : '<span class="badge open sm">fehlt</span>'}</li>`).join('') || '<li class="muted">Keine Spieler</li>'}</ul>
        </div>`;

      const adminBarHTML = isAdmin ? `
        <div class="sched-admin-bar">
          <span>🔧 <b>Admin-Steuerung:</b></span>
          ${m.confirmed_slot || propSlots.length ? `<button type="button" class="btn btn-sm btn-ghost" id="admin-reset-sched">🔓 ${m.confirmed_slot ? 'Festen Termin wieder freigeben' : 'Vorschlag zurücksetzen'}</button>` : ''}
          <button type="button" class="btn btn-sm btn-primary" id="admin-set-sched">🏆 ${m.confirmed_slot ? 'Termin manuell ändern' : 'Termin manuell festlegen'}</button>
        </div>` : '';

      let schedBoxHTML = '';
      if (m.confirmed_slot) {
        schedBoxHTML = `
          <section class="sched-card confirmed metal">
            <div class="sched-top">
              <span class="sched-icon">🏆</span>
              <div class="sched-main">
                <span class="sched-kicker">Offizieller & verbindlicher Spieltermin</span>
                <h3 class="sched-time">${slotLabel(m.confirmed_slot)} Uhr</h3>
                <p class="sched-sub">
                  ${m.confirmed_by_player_name === 'Admin'
                    ? 'Festgelegt durch die Turnierleitung (Admin).'
                    : `Verbindlich geeinigt · Bestätigt von <b>${esc(m.confirmed_by_player_name || '')}</b>${m.proposed_by_player_name ? ` (Vorschlag von ${esc(m.proposed_by_player_name)}, ${esc(propTeamName)})` : ''}.`}
                </p>
              </div>
              <span class="badge ok">🔒 Fest hinterlegt</span>
            </div>
            ${isAdmin ? adminBarHTML : '<div class="sched-lock-note">🔒 Dieser Termin ist fest eingetragen und gesperrt. Nachträgliche Änderungen sind nur über den Turnier-Admin möglich.</div>'}
          </section>`;
      } else if (!allSaved) {
        schedBoxHTML = `
          <section class="sched-card locked metal">
            <div class="sched-top">
              <span class="sched-icon">⏳</span>
              <div class="sched-main">
                <span class="sched-kicker">Termin-Einigung (${n - missing.length}/${n} Spieler haben abgestimmt)</span>
                <h3 class="sched-title">Wartet noch auf alle Spieler-Zeiten</h3>
                <p class="sched-sub">Sobald alle Spieler beider Teams ihre Zeiten für diese Phase gespeichert haben, wird hier die Termin-Einigung freigeschaltet (1 bis 3 Termine vorschlagen & vom Gegner bestätigen lassen).</p>
                ${missing.length ? `<div class="sched-missing">Noch offen: ${missing.map((p) => `<span class="badge warn">${esc(p.name)}</span>`).join(' ')}</div>` : ''}
              </div>
            </div>
            ${adminBarHTML}
          </section>`;
      } else if (propSlots.length > 0 && !proposeMode) {
        if (myTeamId && myTeamId !== m.proposed_by_team_id) {
          schedBoxHTML = `
            <section class="sched-card incoming metal">
              <div class="sched-top">
                <span class="sched-icon">📩</span>
                <div class="sched-main">
                  <span class="sched-kicker">Terminvorschlag von ${esc(propTeamName)} (${esc(m.proposed_by_player_name || '')})</span>
                  <h3 class="sched-title">${propSlots.length === 1 ? '1 Termin vorgeschlagen – jetzt bestätigen oder Gegenvorschlag machen:' : `${propSlots.length} Termine zur Auswahl – wähle einen aus & bestätige:`}</h3>
                  <p class="sched-sub">Klicke bei eurem Wunschtermin auf <b>„✓ Verbindlich bestätigen“</b>, um ihn als festen Spieltermin einzuloggen – oder mache bis zu 3 Gegenvorschläge.</p>
                </div>
              </div>
              <div class="prop-choice-grid">
                ${propSlots.map((k) => {
                  const i = info(k);
                  const ownCs = ownConflictsFor(k);
                  const cs = streamConflictsFor(k);
                  const badge = i.cls === 'm-perfect'
                    ? `<span class="badge ok">🏆 Perfekt (${i.g}/${n} Grün)</span>`
                    : `<span class="badge warn">⚡ Möglich (${i.g} Grün · ${i.y} Gelb)</span>`;
                  let tvInfo = '';
                  if (ownCs.length) {
                    tvInfo = `<div class="pcc-own-busy-warn">🚫 <b>Gesperrt (Eigenes Spiel):</b><br>${ownCs.map((c) => `<b>${esc(busyTeamNameOf(c))}</b> spielt bereits (${esc(c.team_a_name)} vs. ${esc(c.team_b_name)}, ${pad2(c.otherHour)}:00–${pad2(c.otherHour + 1)}:30 Uhr)`).join('<br>')}</div>`;
                  } else if (cs.length) {
                    tvInfo = `<div class="pcc-conflict-warn">📺⚠️ <b>Achtung (Stream/Zuschauer):</b><br>${cs.map((c) => `${c.exact ? 'Zeitgleich' : 'Überschneidung (~1,5h)'} mit <b>${esc(c.team_a_name)} vs. ${esc(c.team_b_name)}</b> (${pad2(c.otherHour)}:00–${pad2(c.otherHour + 1)}:30 Uhr)`).join('<br>')}</div>`;
                  } else if (otherConfirmed.length) {
                    tvInfo = `<span class="badge tv-free">📺 Frei (kein Parallelspiel)</span>`;
                  }
                  const hasWarnBox = ownCs.length > 0 || cs.length > 0;
                  const pccKind = i.cls === 'm-perfect' ? 'pcc-perfect' : 'pcc-maybe';
                  return `
                    <div class="prop-choice-card ${pccKind} ${ownCs.length ? 'is-own-busy' : cs.length ? 'has-conflict' : ''}">
                      <div class="pcc-info">
                        <b class="pcc-slot-title">${slotLabel(k)} Uhr</b>
                        <div class="pcc-badges">${badge}${!hasWarnBox ? tvInfo : ''}</div>
                        ${hasWarnBox ? tvInfo : ''}
                      </div>
                      <button type="button" class="btn btn-primary pcc-confirm-btn" data-confirm-slot="${k}" ${ownCs.length ? 'disabled' : ''}>
                        ${ownCs.length ? '🚫 Nicht wählbar (Eigenes Spiel)' : '✓ Verbindlich bestätigen'}
                      </button>
                    </div>`;
                }).join('')}
              </div>
              <div class="sched-footer-actions">
                <button type="button" class="btn btn-ghost btn-sm" id="start-counter-btn">↺ Keiner passt? Gegenvorschlag (1–3 Termine) machen</button>
              </div>
              ${adminBarHTML}
            </section>`;
        } else {
          schedBoxHTML = `
            <section class="sched-card outgoing metal">
              <div class="sched-top">
                <span class="sched-icon">⏳</span>
                <div class="sched-main">
                  <span class="sched-kicker">Wartet auf Antwort von ${esc(waitTeamName)}</span>
                  <h3 class="sched-title">Terminvorschlag von ${esc(propTeamName)} (${esc(m.proposed_by_player_name || '')}) ist aktiv</h3>
                  <p class="sched-sub">Folgende ${propSlots.length === 1 ? 'Termin wurde' : `${propSlots.length} Termine wurden`} vorgeschlagen. Sobald ein Spieler von <b>${esc(waitTeamName)}</b> einen davon bestätigt, steht das Match fest:</p>
                  <div class="pmh-prop-list">${propSlots.map((k) => {
                    const i = info(k);
                    return `<span class="prop-chip prop-chip-lg"><b>${slotLabel(k)} Uhr</b> <small>(${i.cls === 'm-perfect' ? `${i.g}/${n} Grün` : `${i.g}✓ ${i.y}?`})</small>${conflictChipBadge(k)}</span>`;
                  }).join('')}</div>
                </div>
              </div>
              ${myTeamId === m.proposed_by_team_id ? `
                <div class="sched-footer-actions">
                  <button type="button" class="btn btn-ghost btn-sm" id="edit-propose-btn">✎ Vorschlag ändern (andere 1–3 Termine wählen)</button>
                </div>` : ''}
              ${adminBarHTML}
            </section>`;
        }
      } else {
        const hasSelectable = perfect.length > 0 || maybe.length > 0;
        const isCounter = propSlots.length > 0 && myTeamId !== m.proposed_by_team_id;
        const isEdit = propSlots.length > 0 && myTeamId === m.proposed_by_team_id;
        const selectedWithConflicts = [...selectedPropose]
          .map((k) => ({ k, cs: streamConflictsFor(k) }))
          .filter((x) => x.cs.length > 0);

        schedBoxHTML = `
          <section class="sched-card propose metal">
            <div class="sched-top">
              <span class="sched-icon">🤝</span>
              <div class="sched-main">
                <span class="sched-kicker">Alle ${n} Spieler haben abgestimmt · Termin-Einigung bereit</span>
                <h3 class="sched-title">${isCounter ? `Gegenvorschlag (1–3 Termine) an ${esc(propTeamName)} senden` : isEdit ? 'Terminvorschlag anpassen (1–3 Termine)' : 'Spieltermin vereinbaren: 1 bis 3 Termine vorschlagen'}</h3>
                <p class="sched-sub">
                  ${mePlayer
                    ? 'Klicke unten <b>1 bis maximal 3 passende Termine</b> an (oder wähle sie direkt im Kalender aus) und sende sie als Vorschlag an das gegnerische Team.'
                    : 'Die Spieler beider Teams können hier 1 bis 3 Termine auswählen und sich per Team-Handshake verbindlich einigen.'}
                </p>
              </div>
            </div>
            ${!hasSelectable
              ? '<div class="notice warn">Aktuell gibt es keine Stunde ohne Rot. Bitte passt eure Zeiten im Kalender noch einmal an, damit mindestens ein gemeinsamer Termin (Grün oder Gelb) entsteht.</div>'
              : `
                ${perfect.length ? `
                  <div class="pick-group">
                    <h4>🏆 Perfekte Termine (alle ${n} Grün) – chronologisch sortiert, zum Auswählen anklicken:</h4>
                    <div class="pick-chips">
                      ${perfect.map((k) => {
                        const sel = selectedPropose.has(k);
                        const ownCs = ownConflictsFor(k);
                        const cs = streamConflictsFor(k);
                        const confCls = ownCs.length
                          ? 'own-busy'
                          : cs.length ? (cs.some((c) => c.exact) ? 'has-conflict exact' : 'has-conflict overlap') : '';
                        return `<button type="button" class="slot-pick perfect ${sel ? 'selected' : ''} ${confCls}" data-pick-slot="${k}" title="${esc(conflictTitle(k))}" ${!mePlayer || ownCs.length ? 'disabled' : ''}>
                          <span class="sp-check">${ownCs.length ? '🚫' : sel ? '✓' : '+'}</span>
                          <span>${slotLabel(k)}</span>
                          ${conflictChipBadge(k)}
                        </button>`;
                      }).join('')}
                    </div>
                  </div>` : ''}
                ${maybe.length ? `
                  <div class="pick-group">
                    <h4>⚡ Mögliche Optionen (kein Rot, mind. 1 Gelb) – chronologisch sortiert, zum Auswählen anklicken:</h4>
                    <div class="pick-chips">
                      ${maybe.slice(0, 24).map((x) => {
                        const sel = selectedPropose.has(x.k);
                        const ownCs = ownConflictsFor(x.k);
                        const cs = streamConflictsFor(x.k);
                        const confCls = ownCs.length
                          ? 'own-busy'
                          : cs.length ? (cs.some((c) => c.exact) ? 'has-conflict exact' : 'has-conflict overlap') : '';
                        return `<button type="button" class="slot-pick maybe ${sel ? 'selected' : ''} ${confCls}" data-pick-slot="${x.k}" title="${esc(conflictTitle(x.k))}" ${!mePlayer || ownCs.length ? 'disabled' : ''}>
                          <span class="sp-check">${ownCs.length ? '🚫' : sel ? '✓' : '+'}</span>
                          <span>${slotLabel(x.k)} <small>(${x.g}✓ ${x.y}?)</small></span>
                          ${conflictChipBadge(x.k)}
                        </button>`;
                      }).join('')}
                    </div>
                  </div>` : ''}
                ${selectedWithConflicts.length ? `
                  <div class="propose-conflict-alert">
                    <span class="pca-icon">📺⚠️</span>
                    <div class="pca-body">
                      <b>Achtung – Parallelspiel / Überschneidung (Spieldauer ca. 1,5 Std.):</b>
                      <ul>
                        ${selectedWithConflicts.map(({ k, cs }) => `
                          <li><b>${slotLabel(k)} Uhr:</b> ${cs.map((c) => `${c.exact ? 'Startet zeitgleich mit' : 'Überschneidet sich (~1,5h) mit'} <b>${esc(c.team_a_name)} vs. ${esc(c.team_b_name)}</b> (Start ${pad2(c.otherHour)}:00 Uhr, läuft bis ~${pad2(c.otherHour + 1)}:30 Uhr)`).join(' · ')}</li>
                        `).join('')}
                      </ul>
                      <p>💡 <i>Kein Verbot – ihr könnt den Termin trotzdem vorschlagen! Falls für euch aber auch ein freier Termin passt, weicht gerne aus, damit möglichst viele Spiele einzeln gestreamt und von anderen geschaut werden können.</i></p>
                    </div>
                  </div>` : ''}
                ${mePlayer ? `
                  <div class="propose-bar">
                    <div class="pb-selected-info">
                      <b>Ausgewählt (${selectedPropose.size}/3):</b>
                      ${selectedPropose.size
                        ? [...selectedPropose].map((k) => `<span class="prop-chip">${slotLabel(k)}${conflictChipBadge(k)} <button type="button" class="rm-pick" data-pick-slot="${k}" title="Entfernen">✕</button></span>`).join('')
                        : '<span class="muted">Noch kein Termin angeklickt (wähle 1 bis 3 Termine)</span>'}
                    </div>
                    <div class="pb-btns">
                      ${proposeMode ? `<button type="button" class="btn btn-ghost btn-sm" id="cancel-propose-btn">Abbrechen</button>` : ''}
                      <button type="button" class="btn btn-primary" id="submit-propose-btn" ${selectedPropose.size === 0 ? 'disabled' : ''}>
                        📩 ${selectedPropose.size ? `${selectedPropose.size} ${selectedPropose.size === 1 ? 'Termin' : 'Termine'} vorschlagen` : 'Termin(e) vorschlagen'}
                      </button>
                    </div>
                  </div>` : ''}
              `}
            ${adminBarHTML}
          </section>`;
      }

      const otherMatchesHTML = otherConfirmed.length ? `
        <div class="other-matches-bar metal">
          <div class="omb-head">
            <span class="omb-icon">📺</span>
            <div class="omb-title">
              <b>Bereits festgelegte Spiele in diesem Zeitraum (${otherConfirmed.length})</b>
              <small>Spiele mit Beteiligung eurer beiden Teams (🚫) sind inkl. ~1,5h Spielzeit automatisch gesperrt. Bei Spielen anderer Teams (📺) bitte wenn möglich ausweichen, damit gestreamt/geschaut werden kann.</small>
            </div>
          </div>
          <div class="omb-list">
            ${otherConfirmed.map((oc) => {
              const [, ohStr] = oc.confirmed_slot.split('|');
              const oh = Number(ohStr);
              return `<div class="omb-chip ${oc.is_own_team ? 'own-busy' : ''}">
                <span class="omb-time">${oc.is_own_team ? '🚫' : '🏆'} ${slotLabel(oc.confirmed_slot)} <small>(bis ~${pad2(oh + 1)}:30 Uhr)</small></span>
                <span class="omb-teams">${esc(oc.team_a_name)} <i>vs.</i> ${esc(oc.team_b_name)}</span>
                ${oc.is_own_team ? `<span class="badge danger sm">Eigenes Spiel (${esc(busyTeamNameOf(oc))})</span>` : ''}
              </div>`;
            }).join('')}
          </div>
        </div>` : '';

      body.innerHTML = `
        ${prefix}
        <div class="match-head">
          <div class="vs-card metal">${teamBox(data.teamA, 'a')}<div class="vs-badge"><img src="/logo.png" alt="" class="vs-crest"><span>VS</span></div>${teamBox(data.teamB, 'b')}</div>
          <div class="match-stats">
            <div class="stat perfect"><b>${perfect.length}</b><span>Perfekte Termine<br><small>alle ${n} grün</small></span></div>
            <div class="stat maybe"><b>${maybe.length}</b><span>Mögliche Optionen<br><small>keiner rot</small></span></div>
          </div>
        </div>
        ${missing.length ? `<div class="notice warn">⚠ ${missing.map((p) => esc(p.name)).join(', ')} ${missing.length === 1 ? 'hat' : 'haben'} für diese Phase noch keine Zeiten gespeichert – das zählt als <b>Rot</b>.</div>` : ''}
        ${short.length ? `<div class="notice warn">⚠ ${short.map((t) => esc(t.name)).join(', ')} ${short.length === 1 ? 'hat' : 'haben'} noch keine 3 Spieler.</div>` : ''}
        ${schedBoxHTML}
        ${otherMatchesHTML}
        <div class="cal-toolbar">
          ${legend('match')}
          <div class="tool-actions"><span class="muted small" id="refresh-info"></span><button class="btn btn-ghost btn-sm" id="refresh-btn">⟳ Aktualisieren</button></div>
        </div>
        <p class="hint small">Maus über ein Feld bewegen (am Handy antippen), um den Status aller ${n} Spieler sowie eventuelle Parallelspiele (📺 / 🚫) zu sehen.</p>
        <div id="match-grid"></div>`;

      const togglePickSlot = (k) => {
        if (!mePlayer || m.confirmed_slot || !allSaved) return;
        const ownCs = ownConflictsFor(k);
        if (ownCs.length) {
          const c = ownCs[0];
          toast(`Nicht wählbar: ${busyTeamNameOf(c)} hat dort bereits ein festes Spiel (${c.team_a_name} vs. ${c.team_b_name}, ${pad2(c.otherHour)}:00–${pad2(c.otherHour + 1)}:30 Uhr).`, 'error');
          return;
        }
        const i = info(k);
        if (i.cls !== 'm-perfect' && i.cls !== 'm-maybe') {
          toast('Nur grüne oder gelbe Termine (ohne Rot) können vorgeschlagen werden.', 'error');
          return;
        }
        if (selectedPropose.has(k)) {
          selectedPropose.delete(k);
        } else {
          if (selectedPropose.size >= 3) {
            toast('Du kannst maximal 3 Termine gleichzeitig auswählen.', 'error');
            return;
          }
          selectedPropose.add(k);
        }
        if (propSlots.length > 0 && !proposeMode) proposeMode = true;
        render();
      };

      const confirmChosenSlot = async (k) => {
        if (!mePlayer) return;
        const ownCs = ownConflictsFor(k);
        if (ownCs.length) {
          const c = ownCs[0];
          toast(`Nicht möglich: ${busyTeamNameOf(c)} hat dort bereits ein festes Spiel (${c.team_a_name} vs. ${c.team_b_name}).`, 'error');
          return;
        }
        const cs = streamConflictsFor(k);
        const conflictWarnModal = cs.length ? `
          <div class="propose-conflict-alert" style="margin-top:10px">
            <span class="pca-icon">📺⚠️</span>
            <div class="pca-body">
              <b>Hinweis (Parallelspiel / ~1,5h Spielzeit):</b>
              <ul>${cs.map((c) => `<li><b>${esc(c.team_a_name)} vs. ${esc(c.team_b_name)}</b> (${pad2(c.otherHour)}:00–${pad2(c.otherHour + 1)}:30 Uhr)</li>`).join('')}</ul>
              <p>Ihr könnt diesen Termin trotzdem verbindlich festlegen, falls kein anderer Termin besser passt.</p>
            </div>
          </div>` : '';
        const ok = await modal({
          title: '🏆 Spieltermin verbindlich bestätigen',
          confirmText: '✓ Ja, verbindlich festlegen',
          body: `
            <p>Möchtest du für das Match <b>${esc(data.teamA.name)} vs. ${esc(data.teamB.name)}</b> folgenden Termin verbindlich einloggen?</p>
            <div class="modal-slot-preview">🏆 ${slotLabel(k)} Uhr</div>
            ${conflictWarnModal}
            <p class="hint small" style="margin:8px 0 0">🔒 <b>Wichtig:</b> Nach der Bestätigung steht der Termin fest und kann nur noch vom Turnier-Admin geändert werden.</p>`,
          onConfirm: async () => {
            await api(`/matchups/${matchupId}/confirm`, {
              method: 'POST',
              body: { player_id: mePlayer.id, slot: k },
            });
          },
        });
        if (ok) {
          toast('Spieltermin wurde verbindlich festgelegt! 🏆');
          proposeMode = false;
          selectedPropose.clear();
          await load();
        }
      };

      body.querySelectorAll('[data-pick-slot]').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          togglePickSlot(btn.dataset.pickSlot);
        });
      });

      body.querySelectorAll('[data-confirm-slot]').forEach((btn) => {
        btn.addEventListener('click', () => confirmChosenSlot(btn.dataset.confirmSlot));
      });

      body.querySelector('#start-counter-btn')?.addEventListener('click', () => {
        selectedPropose.clear();
        proposeMode = true;
        render();
      });

      body.querySelector('#edit-propose-btn')?.addEventListener('click', () => {
        selectedPropose.clear();
        propSlots.filter((s) => !ownConflictsFor(s).length).forEach((s) => selectedPropose.add(s));
        proposeMode = true;
        render();
      });

      body.querySelector('#cancel-propose-btn')?.addEventListener('click', () => {
        selectedPropose.clear();
        proposeMode = false;
        render();
      });

      body.querySelector('#submit-propose-btn')?.addEventListener('click', async (e) => {
        if (!mePlayer || selectedPropose.size === 0) return;
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await api(`/matchups/${matchupId}/propose`, {
            method: 'POST',
            body: { player_id: mePlayer.id, slots: [...selectedPropose] },
          });
          toast(`${selectedPropose.size === 1 ? 'Terminvorschlag' : `${selectedPropose.size} Terminvorschläge`} gesendet!`);
          selectedPropose.clear();
          proposeMode = false;
          await load();
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
        }
      });

      body.querySelector('#admin-reset-sched')?.addEventListener('click', async () => {
        const ok = await confirmModal(
          'Termin-Einigung zurücksetzen?',
          `Der feste Termin bzw. aktuelle Vorschlag für <b>${esc(data.teamA.name)} vs. ${esc(data.teamB.name)}</b> wird aufgehoben, sodass sich die Teams neu einigen können.`,
          'Zurücksetzen'
        );
        if (!ok) return;
        try {
          await api(`/matchups/${matchupId}/schedule`, { method: 'PUT', body: { action: 'reset' } });
          toast('Termin-Einigung wurde zurückgesetzt.');
          await load();
        } catch (err) { toast(err.message, 'error'); }
      });

      body.querySelector('#admin-set-sched')?.addEventListener('click', async () => {
        const allSlots = [];
        for (const d of dates) for (const h of HOURS) allSlots.push(key(d, h));
        const otherSlots = allSlots.filter((k) => !perfect.includes(k) && !maybe.some((x) => x.k === k));
        const optSuffix = (k) => {
          const ownCs = ownConflictsFor(k);
          if (ownCs.length) return ` [🚫 EIGENES SPIEL: ${busyTeamNameOf(ownCs[0])}]`;
          const cs = streamConflictsFor(k);
          if (!cs.length) return '';
          return ` [📺⚠️ ${cs.some((c) => c.exact) ? 'Parallelspiel' : 'Überschneidung ~1,5h'}]`;
        };
        const ok = await modal({
          title: '🏆 Spieltermin als Admin festlegen',
          confirmText: 'Verbindlich speichern',
          body: `
            <p>Wähle den festen Spieltermin für <b>${esc(data.teamA.name)} vs. ${esc(data.teamB.name)}</b>:</p>
            <label class="field" style="margin-top:10px">
              <span>Datum & Uhrzeit</span>
              <select name="slot" required>
                ${perfect.length ? `<optgroup label="🏆 Perfekte Termine (alle ${n} Grün)">${perfect.map((k) => `<option value="${k}" ${m.confirmed_slot === k ? 'selected' : ''}>${slotLabel(k)} (${n}/${n} Grün)${optSuffix(k)}</option>`).join('')}</optgroup>` : ''}
                ${maybe.length ? `<optgroup label="⚡ Mögliche Optionen (kein Rot)">${maybe.map((x) => `<option value="${x.k}" ${m.confirmed_slot === x.k ? 'selected' : ''}>${slotLabel(x.k)} (${x.g} Grün, ${x.y} Gelb)${optSuffix(x.k)}</option>`).join('')}</optgroup>` : ''}
                <optgroup label="Alle weiteren Stunden (${esc(phase.name)})">
                  ${otherSlots.map((k) => { const i = info(k); return `<option value="${k}" ${m.confirmed_slot === k ? 'selected' : ''}>${slotLabel(k)} (${i.g}✓ ${i.y}? ${i.r}✕)${optSuffix(k)}</option>`; }).join('')}
                </optgroup>
              </select>
            </label>`,
          onConfirm: async (form) => {
            await api(`/matchups/${matchupId}/schedule`, {
              method: 'PUT',
              body: { action: 'set', slot: form.slot.value },
            });
          },
        });
        if (ok) {
          toast('Fester Spieltermin wurde vom Admin gespeichert.');
          await load();
        }
      });

      const gridBox = body.querySelector('#match-grid');
      gridBox.innerHTML = gridHTML(phase, {
        cellHTML: (d, h) => {
          const k = key(d, h);
          const i = info(k);
          const isConf = m.confirmed_slot === k;
          const isProp = !m.confirmed_slot && propSlots.includes(k);
          const isSel = !m.confirmed_slot && selectedPropose.has(k);
          const ownCs = ownConflictsFor(k);
          const cs = streamConflictsFor(k);
          const hasExact = cs.some((c) => c.exact);
          let txt = i.cls === 'm-perfect' ? `${i.g}/${n}` : i.cls === 'm-maybe' ? `${i.g}✓ ${i.y}?` : n ? `${n - i.r}/${n}` : '–';
          if (isConf) txt = `🏆 FIX`;
          else if (isProp) txt = `📩 ${txt}`;
          else if (isSel) txt = `✓ ${txt}`;
          let tvBadge = '';
          if (!isConf) {
            if (ownCs.length) {
              tvBadge = `<span class="tv-cell-badge own-busy" title="${esc(conflictTitle(k))}">🚫</span>`;
            } else if (cs.length) {
              tvBadge = `<span class="tv-cell-badge ${hasExact ? 'exact' : 'overlap'}" title="${esc(conflictTitle(k))}">📺${hasExact ? cs.length : '~'}</span>`;
            }
          }
          const extraCls = [
            isConf ? 'is-confirmed' : '',
            isProp ? 'is-proposed' : '',
            isSel ? 'is-selected' : '',
            ownCs.length ? 'has-own-busy' : cs.length ? (hasExact ? 'has-tv-exact' : 'has-tv-overlap') : '',
          ].filter(Boolean).join(' ');
          return `<td class="cell mcell ${i.cls} ${extraCls}" data-k="${k}"><span class="mc">${txt}</span>${tvBadge}</td>`;
        },
      });

      const showTip = (td) => {
        const k = td.dataset.k;
        const i = info(k);
        const ownCs = ownConflictsFor(k);
        const cs = streamConflictsFor(k);
        const row = (p) => { const s = statusOf(p.id, k); return `<li><i class="dot s-${s}"></i><span>${esc(p.name)}${p.id === highlightPlayer ? ' (du)' : ''}</span><b class="t-${s}">${hasSaved(p.id) ? STATUS_LABEL[s] : 'nicht eingetragen'}</b></li>`; };
        const verdict = m.confirmed_slot === k
          ? '<span class="t-green">🏆 Fester Spieltermin</span>'
          : ownCs.length
            ? '<span class="t-red">🚫 Gesperrt (Eigenes Spiel)</span>'
            : i.cls === 'm-perfect' ? '<span class="t-green">Perfekter Match-Termin</span>' : i.cls === 'm-maybe' ? '<span class="t-yellow">Mögliche Option</span>' : '<span class="t-red">Nicht möglich</span>';

        const tipOwnBusyHTML = ownCs.length ? `
          <div class="tip-own-busy">
            <b>🚫 Gesperrt – Eigenes Spiel (~1,5h Spielzeit):</b>
            <ul>
              ${ownCs.map((c) => `<li><b>${esc(busyTeamNameOf(c))}</b> spielt bereits: <b>${esc(c.team_a_name)} vs. ${esc(c.team_b_name)}</b> (Start ${pad2(c.otherHour)}:00 Uhr, läuft bis ~${pad2(c.otherHour + 1)}:30 Uhr)</li>`).join('')}
            </ul>
            <small>Ein Team kann nicht zwei Spiele gleichzeitig bestreiten – dieser Zeitraum ist daher für Vorschläge gesperrt.</small>
          </div>` : '';

        const tipConflictHTML = cs.length ? `
          <div class="tip-conflict">
            <b>📺⚠️ Achtung – Parallelspiel / Überschneidung (~1,5h Spielzeit):</b>
            <ul>
              ${cs.map((c) => `<li><b>${esc(c.team_a_name)} vs. ${esc(c.team_b_name)}</b> · Start ${pad2(c.otherHour)}:00 Uhr (läuft bis ~${pad2(c.otherHour + 1)}:30 Uhr)</li>`).join('')}
            </ul>
            <small>Wenn möglich anderen Termin wählen, damit Spiele einzeln gestreamt & geschaut werden können.</small>
          </div>` : '';

        let tipAction = '';
        if (allSaved && !m.confirmed_slot && mePlayer && !ownCs.length && (i.cls === 'm-perfect' || i.cls === 'm-maybe')) {
          if (propSlots.includes(k) && myTeamId !== m.proposed_by_team_id && !proposeMode) {
            tipAction = `<div class="tip-actions"><button type="button" class="btn btn-sm btn-primary btn-block" data-tip-confirm="${k}">✓ Diesen Termin verbindlich bestätigen</button></div>`;
          } else if (propSlots.length === 0 || proposeMode) {
            const sel = selectedPropose.has(k);
            tipAction = `<div class="tip-actions"><button type="button" class="btn btn-sm ${sel ? 'btn-ghost' : 'btn-primary'} btn-block" data-tip-pick="${k}">${sel ? '✕ Aus Auswahl entfernen' : '+ Für Vorschlag auswählen (max. 3)'}</button></div>`;
          }
        }

        tip.innerHTML = `
          <div class="tip-head"><b>${slotLabel(k)}</b>${verdict}</div>
          ${tipOwnBusyHTML}
          ${tipConflictHTML}
          <div class="tip-teams">
            <div><h5>${esc(data.teamA.name)}</h5><ul>${data.teamA.players.map(row).join('')}</ul></div>
            <div><h5>${esc(data.teamB.name)}</h5><ul>${data.teamB.players.map(row).join('')}</ul></div>
          </div>
          <div class="tip-foot">${i.g} grün · ${i.y} gelb · ${i.r} rot</div>
          ${tipAction}`;
        tip.hidden = false;
        tip.querySelector('[data-tip-pick]')?.addEventListener('click', () => { hideTip(); togglePickSlot(k); });
        tip.querySelector('[data-tip-confirm]')?.addEventListener('click', () => { hideTip(); confirmChosenSlot(k); });
        const r = td.getBoundingClientRect();
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        let left = Math.max(8, Math.min(r.left + r.width / 2 - tw / 2, window.innerWidth - tw - 8));
        let top = r.bottom + 8;
        if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 8);
        tip.style.left = left + 'px';
        tip.style.top = top + 'px';
      };
      const hideTip = () => { tip.hidden = true; pinned = null; };
      const table = gridBox.querySelector('table');
      table.addEventListener('pointerover', (e) => {
        if (e.pointerType !== 'mouse' || pinned) return;
        const td = e.target.closest('td.mcell');
        if (td) showTip(td);
      });
      table.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !pinned) tip.hidden = true; });
      table.addEventListener('click', (e) => {
        const td = e.target.closest('td.mcell');
        if (!td) return;
        e.stopPropagation();
        if (pinned === td) { hideTip(); return; }
        pinned = td;
        showTip(td);
      });
      body.querySelector('#refresh-btn').addEventListener('click', () => load(true));
      body.querySelector('#refresh-info').textContent = 'Stand: ' + new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    };

    const docClick = (e) => { if (!e.target.closest('.tooltip')) { tip.hidden = true; pinned = null; } };
    const onScroll = () => { tip.hidden = true; pinned = null; };
    document.addEventListener('click', docClick);
    window.addEventListener('scroll', onScroll, { passive: true });
    onCleanup(() => { document.removeEventListener('click', docClick); window.removeEventListener('scroll', onScroll); });

    const load = async (manual = false) => {
      try {
        data = await api(`/matchups/${matchupId}/overlap`);
        tip.hidden = true; pinned = null;
        render();
        if (manual) toast('Abgleich aktualisiert', 'info');
      } catch (err) {
        if (!data) throw err;
        if (manual) toast(err.message, 'error');
      }
    };
    await load();
    const timer = setInterval(() => {
      if (!document.hidden && tip.hidden && selectedPropose.size === 0 && !proposeMode) load();
    }, REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  }

  // =====================================================================
  //  ADMIN-BEREICH
  // =====================================================================
  async function renderAdmin(tab, rest) {
    if (!sessionStorage.getItem(SS_ADMIN)) return go('#/');
    await api('/admin/verify');
    const tabs = [
      ['teams', '👥 Teams & Spieler'],
      ['matchups', '⚔ Paarungen'],
      ['insight', '📊 Zeitplan-Einsicht'],
    ];
    const activeTab = tab === 'match' ? 'insight' : tab;
    $app.innerHTML = `
      <header class="topbar metal">
        ${brand(true)}
        <div class="who"><div class="who-main"><span class="avatar admin">★</span><div><b>Admin-Dashboard</b><small>Verwaltung & Einsicht</small></div></div></div>
        <button class="btn btn-ghost btn-sm" id="admin-logout">Logout</button>
      </header>
      <main class="container">
        ${kickoffBanner(true)}
        <nav class="tabs big">${tabs.map(([id, label]) => `<a class="tab ${id === activeTab ? 'active' : ''}" href="#/admin/${id}">${label}</a>`).join('')}</nav>
        <div id="admin-body"><div class="loading"><div class="spinner"></div></div></div>
      </main>`;
    document.getElementById('admin-logout').addEventListener('click', () => { sessionStorage.removeItem(SS_ADMIN); go('#/'); });
    const body = document.getElementById('admin-body');
    if (tab === 'teams') await adminTeams(body);
    else if (tab === 'matchups') await adminMatchups(body);
    else if (tab === 'insight') await adminInsight(body);
    else if (tab === 'match') await adminMatch(body, rest[0]);
    else go('#/admin/teams');
  }

  // ---------- Tab 1: Teams & Spieler ----------
  async function adminTeams(body) {
    const [teams, players] = await Promise.all([api('/teams'), api('/players')]);
    const unassigned = players.filter((p) => p.team_id == null);
    const full = teams.filter((t) => t.players.length === 3).length;

    const teamOptions = (p) => `<option value="">— ohne Team —</option>${teams.map((t) => {
      const isFull = t.players.length >= 3 && t.id !== p.team_id;
      return `<option value="${t.id}" ${t.id === p.team_id ? 'selected' : ''} ${isFull ? 'disabled' : ''}>${esc(t.name)}${isFull ? ' (voll)' : ''}</option>`;
    }).join('')}`;
    const playerRow = (p) => `
      <li class="player-row" data-player="${p.id}" data-name="${esc(p.name)}">
        <span class="pname">${esc(p.name)}</span>
        <select data-act="move" title="Einem anderen Team zuweisen" aria-label="Team von ${esc(p.name)}">${teamOptions(p)}</select>
        <button class="icon-btn" data-act="rename-player" title="Umbenennen">✎</button>
        <button class="icon-btn danger" data-act="delete-player" title="Löschen">🗑</button>
      </li>`;

    const root = el(`
      <div>
        <div class="card metal admin-toolbar">
          <form class="inline-form" data-form="new-team">
            <input name="name" placeholder="Neuer Teamname, z. B. Team Alpha" maxlength="60" required autocomplete="off">
            <button class="btn btn-primary">+ Team erstellen</button>
          </form>
          <div class="mini-stats">
            <span><b>${teams.length}</b> Teams</span>
            <span><b>${players.length}</b> Spieler</span>
            <span><b>${full}</b>/${teams.length} vollständig</span>
            <button class="btn btn-sm btn-ghost" id="seed-demo-btn" title="Alle 18 Teams, 53 Spieler & alle 5 Test-Szenarien (inkl. Termin-Einigung & Stream-Radar) neu laden">🔄 Test-Szenarien zurücksetzen</button>
          </div>
        </div>
        ${teams.length ? `<div class="team-grid">${teams.map((t) => `
          <article class="team-card metal ${t.players.length === 3 ? 'full' : ''}" data-team="${t.id}" data-name="${esc(t.name)}">
            <header>
              <h3>${esc(t.name)}</h3>
              <span class="badge ${t.players.length === 3 ? 'ok' : 'warn'}">${t.players.length}/3 Spieler</span>
              <div class="actions">
                <button class="icon-btn" data-act="rename-team" title="Team umbenennen">✎</button>
                <button class="icon-btn danger" data-act="delete-team" title="Team löschen">🗑</button>
              </div>
            </header>
            <ul class="player-list">
              ${t.players.map(playerRow).join('')}
              ${Array.from({ length: Math.max(0, 3 - t.players.length) }, (_, i) => `<li class="slot-empty">Freier Platz ${t.players.length + i + 1}</li>`).join('')}
            </ul>
            ${t.players.length < 3 ? `
              <form class="inline-form add-player" data-form="add-player" data-team="${t.id}">
                <input name="name" placeholder="Spielername" maxlength="60" required autocomplete="off">
                ${unassigned.length ? `<select name="existing"><option value="">oder vorhandenen wählen…</option>${unassigned.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>` : ''}
                <button class="btn btn-sm btn-primary">+ Hinzufügen</button>
              </form>` : ''}
          </article>`).join('')}</div>`
        : '<div class="card empty-state"><h3>Noch keine Teams</h3><p class="muted">Lege oben das erste Team an und füge anschließend je 3 Spieler hinzu.</p></div>'}
        ${unassigned.length ? `
          <section class="card metal unassigned">
            <h3>Spieler ohne Team <span class="badge warn">${unassigned.length}</span></h3>
            <ul class="player-list">${unassigned.map(playerRow).join('')}</ul>
          </section>` : ''}
      </div>`);
    body.replaceChildren(root);
    const refresh = () => adminTeams(body);
    const fail = (err) => toast(err.message, 'error');

    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        if (f.dataset.form === 'new-team') {
          await api('/teams', { method: 'POST', body: { name: f.elements.namedItem('name').value } });
          toast('Team erstellt');
        } else if (f.dataset.form === 'add-player') {
          const existing = f.existing?.value;
          if (existing) await api(`/players/${existing}`, { method: 'PUT', body: { team_id: Number(f.dataset.team) } });
          else await api('/players', { method: 'POST', body: { name: f.elements.namedItem('name').value, team_id: Number(f.dataset.team) } });
          toast('Spieler hinzugefügt');
        }
        await refresh();
        body.querySelector(`[data-form="${f.dataset.form}"]${f.dataset.team ? `[data-team="${f.dataset.team}"]` : ''} input`)?.focus();
      } catch (err) { fail(err); }
    });
    root.addEventListener('change', async (e) => {
      const sel = e.target;
      if (sel.name === 'existing') {
        const input = sel.form.elements.namedItem('name');
        input.required = !sel.value;
        input.disabled = !!sel.value;
        return;
      }
      if (sel.dataset.act !== 'move') return;
      const pid = sel.closest('[data-player]').dataset.player;
      try {
        await api(`/players/${pid}`, { method: 'PUT', body: { team_id: sel.value ? Number(sel.value) : null } });
        toast('Spieler verschoben');
      } catch (err) { fail(err); }
      await refresh();
    });
    root.querySelector('#seed-demo-btn')?.addEventListener('click', async () => {
      const ok = await confirmModal(
        'Test-Szenarien neu laden?',
        'Möchtest du die 18 realen Teams (53 Spieler) samt aller 5 Test-Szenarien pro Team (feste Termine, eingehende/ausgehende Anfragen, offene Abstimmungen & Stream-Radar) frisch zurücksetzen?',
        'Ja, Test-Szenarien neu laden'
      );
      if (!ok) return;
      try {
        await api('/admin/seed-demo', { method: 'POST', body: { force: true } });
        toast('Test-Szenarien wurden frisch geladen!');
        await refresh();
      } catch (err) {
        fail(err);
      }
    });

    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn || btn.tagName === 'SELECT') return;
      const teamEl = btn.closest('[data-team]');
      const playerEl = btn.closest('[data-player]');
      const act = btn.dataset.act;
      try {
        if (act === 'rename-team') {
          const ok = await promptModal('Team umbenennen', 'Teamname', teamEl.dataset.name, (name) => api(`/teams/${teamEl.dataset.team}`, { method: 'PUT', body: { name } }));
          if (ok) { toast('Team umbenannt'); await refresh(); }
        } else if (act === 'delete-team') {
          const ok = await confirmModal('Team löschen?', `<b>${esc(teamEl.dataset.name)}</b> wird gelöscht. Die Spieler bleiben erhalten (ohne Team) und können neu zugewiesen werden. Alle Paarungen dieses Teams werden entfernt.`);
          if (ok) { await api(`/teams/${teamEl.dataset.team}`, { method: 'DELETE' }); toast('Team gelöscht'); await refresh(); }
        } else if (act === 'rename-player') {
          const ok = await promptModal('Spieler umbenennen', 'Spielername', playerEl.dataset.name, (name) => api(`/players/${playerEl.dataset.player}`, { method: 'PUT', body: { name } }));
          if (ok) { toast('Spieler umbenannt'); await refresh(); }
        } else if (act === 'delete-player') {
          const ok = await confirmModal('Spieler löschen?', `<b>${esc(playerEl.dataset.name)}</b> und alle gespeicherten Zeiten dieses Spielers werden dauerhaft gelöscht.`);
          if (ok) { await api(`/players/${playerEl.dataset.player}`, { method: 'DELETE' }); toast('Spieler gelöscht'); await refresh(); }
        }
      } catch (err) { fail(err); }
    });
  }

  // ---------- Tab 2: Paarungen ----------
  async function adminMatchups(body) {
    const [teams, matchups] = await Promise.all([api('/teams'), api('/matchups')]);
    const phase = getPhase(S.adminPhase) || PHASES[0];
    const list = matchups.filter((m) => m.phase_id === phase.id);
    const used = new Set(list.flatMap((m) => [m.team_a_id, m.team_b_id]));
    const free = teams.filter((t) => !used.has(t.id));
    const opts = (sel) => teams.map((t) => `<option value="${t.id}" ${t.id === sel ? 'selected' : ''}>${esc(t.name)} (${t.players.length}/3)</option>`).join('');
    const viewRow = (m) => {
      const propSlots = Array.isArray(m.proposed_slots) ? m.proposed_slots : [];
      const schedBadge = m.confirmed_slot
        ? `<span class="badge ok">🏆 Fest: ${slotLabel(m.confirmed_slot)}</span>`
        : propSlots.length
          ? `<span class="badge warn">📩 ${propSlots.length} Vorschl. offen</span>`
          : `<span class="badge open">⏳ Termin offen</span>`;
      return `
        <li class="mu-row" data-id="${m.id}">
          <div class="mu-teams">
            <span class="mu-team">${esc(m.team_a_name)}</span><span class="vs-sm">vs.</span><span class="mu-team">${esc(m.team_b_name)}</span>
            ${schedBadge}
          </div>
          <div class="actions">
            ${m.confirmed_slot || propSlots.length ? `<button class="btn btn-sm btn-ghost" data-act="reset-sched" title="Termin-Einigung zurücksetzen / freigeben">🔓 Freigeben</button>` : ''}
            <a class="btn btn-sm btn-ghost" href="#/admin/match/${m.id}">📊 Abgleich & Termin</a>
            <button class="icon-btn" data-act="edit" title="Bearbeiten">✎</button>
            <button class="icon-btn danger" data-act="delete" title="Löschen">🗑</button>
          </div>
        </li>`;
    };

    const root = el(`
      <div>
        <div class="card metal">
          <h3 class="card-title">Turnierphase wählen</h3>
          <div class="phase-chips">${PHASES.map((p) => {
            const c = matchups.filter((m) => m.phase_id === p.id).length;
            return `<button class="chip c-${p.color} ${p.id === phase.id ? 'active' : ''}" data-phase="${p.id}"><i class="dot"></i>W${p.week} · ${esc(p.name)}${p.subtitle ? ` <small>${esc(p.subtitle)}</small>` : ''}${c ? `<span class="count">${c}</span>` : ''}</button>`;
          }).join('')}</div>
        </div>
        <section class="card metal phase-card c-${phase.color}">
          <header class="phase-card-head"><i class="pv-dot"></i><div><h3>${esc(phase.name)}${phase.subtitle ? ` <small>${esc(phase.subtitle)}</small>` : ''}</h3><p class="muted">Woche ${phase.week} · ${formatRange(phase)}</p></div></header>
          ${teams.length < 2 ? '<div class="notice">Es werden mindestens 2 Teams benötigt, um Paarungen anzulegen.</div>' : `
          <form class="matchup-form" data-form="add">
            <select name="a" aria-label="Team A">${opts(free[0]?.id ?? teams[0].id)}</select>
            <span class="vs-badge sm">VS</span>
            <select name="b" aria-label="Team B">${opts(free[1]?.id ?? teams[1].id)}</select>
            <button class="btn btn-primary">+ Paarung hinzufügen</button>
          </form>`}
          <ul class="mu-list">${list.map(viewRow).join('') || '<li class="empty-row">Noch keine Paarungen in dieser Phase.</li>'}</ul>
          ${list.length && free.length ? `<p class="hint small">Teams ohne Paarung in dieser Phase: ${free.map((t) => esc(t.name)).join(', ')}</p>` : ''}
        </section>
      </div>`);
    body.replaceChildren(root);
    const refresh = () => adminMatchups(body);

    root.querySelectorAll('[data-phase]').forEach((b) => b.addEventListener('click', () => { S.adminPhase = b.dataset.phase; refresh(); }));
    root.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      try {
        if (f.dataset.form === 'add') {
          await api('/matchups', { method: 'POST', body: { phase_id: phase.id, team_a_id: Number(f.a.value), team_b_id: Number(f.b.value) } });
          toast('Paarung angelegt');
        } else if (f.dataset.form === 'edit') {
          await api(`/matchups/${f.dataset.id}`, { method: 'PUT', body: { team_a_id: Number(f.a.value), team_b_id: Number(f.b.value) } });
          toast('Paarung aktualisiert');
        }
        await refresh();
      } catch (err) { toast(err.message, 'error'); }
    });
    root.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const row = btn.closest('[data-id]');
      const m = list.find((x) => String(x.id) === row?.dataset.id);
      if (btn.dataset.act === 'edit' && m) {
        row.replaceChildren(el(`
          <form class="matchup-form editing" data-form="edit" data-id="${m.id}">
            <select name="a">${opts(m.team_a_id)}</select><span class="vs-sm">vs.</span><select name="b">${opts(m.team_b_id)}</select>
            <button class="btn btn-sm btn-primary">Speichern</button><button type="button" class="btn btn-sm btn-ghost" data-act="cancel">Abbrechen</button>
          </form>`));
      } else if (btn.dataset.act === 'cancel') {
        refresh();
      } else if (btn.dataset.act === 'reset-sched' && m) {
        const ok = await confirmModal('Termin-Einigung zurücksetzen?', `Der feste Termin bzw. Vorschlag für <b>${esc(m.team_a_name)} vs. ${esc(m.team_b_name)}</b> wird aufgehoben, sodass sich die Teams neu einigen können.`, 'Zurücksetzen');
        if (!ok) return;
        try { await api(`/matchups/${m.id}/schedule`, { method: 'PUT', body: { action: 'reset' } }); toast('Termin freigegeben'); await refresh(); } catch (err) { toast(err.message, 'error'); }
      } else if (btn.dataset.act === 'delete' && m) {
        const ok = await confirmModal('Paarung löschen?', `<b>${esc(m.team_a_name)}</b> vs. <b>${esc(m.team_b_name)}</b> (${esc(phase.name)}) wird gelöscht. Die gespeicherten Zeiten der Spieler bleiben erhalten.`);
        if (!ok) return;
        try { await api(`/matchups/${m.id}`, { method: 'DELETE' }); toast('Paarung gelöscht'); await refresh(); } catch (err) { toast(err.message, 'error'); }
      }
    });
  }

  // ---------- Tab 3: Einsicht ----------
  async function adminInsight(body) {
    const [teams, players, matchups, status] = await Promise.all([api('/teams'), api('/players'), api('/matchups'), api('/admin/save-status')]);
    const saved = new Set(status.map((s) => `${s.player_id}|${s.phase_id}`));
    const unassigned = players.filter((p) => p.team_id == null);
    const groups = [...teams.map((t) => ({ label: t.name, players: t.players })), ...(unassigned.length ? [{ label: 'Ohne Team', players: unassigned }] : [])];

    const root = el(`
      <div>
        <section class="card metal">
          <h3 class="card-title">⚔ Paarungs-Abgleich & Vereinbarte Spieltermine</h3>
          <p class="muted">Klicke auf eine Paarung, um den 6-Spieler-Abgleich zu öffnen oder den festen Termin als Admin zu verwalten.</p>
          ${matchups.length ? PHASES.filter((p) => matchups.some((m) => m.phase_id === p.id)).map((p) => `
            <div class="mu-group c-${p.color}">
              <h4><i class="dot"></i>W${p.week} · ${esc(p.name)}${p.subtitle ? ` <small>${esc(p.subtitle)}</small>` : ''} <span class="muted small">${formatRange(p)}</span></h4>
              <div class="mu-buttons">${matchups.filter((m) => m.phase_id === p.id).map((m) => {
                const propLen = Array.isArray(m.proposed_slots) ? m.proposed_slots.length : 0;
                const badge = m.confirmed_slot
                  ? `<small class="mu-sched-tag ok">🏆 ${slotLabel(m.confirmed_slot)}</small>`
                  : propLen
                    ? `<small class="mu-sched-tag warn">📩 ${propLen} Vorschl.</small>`
                    : '';
                return `<a class="mu-btn" href="#/admin/match/${m.id}">${esc(m.team_a_name)} <span>vs</span> ${esc(m.team_b_name)}${badge}</a>`;
              }).join('')}</div>
            </div>`).join('') : '<div class="notice">Noch keine Paarungen angelegt. → Tab „Paarungen“</div>'}
        </section>

        <section class="card metal" id="single-view">
          <h3 class="card-title">👤 Einzelspieler-Ansicht</h3>
          ${players.length ? `
          <label class="field inline"><span>Spieler</span>
            <select id="ins-player">
              <option value="">Spieler auswählen …</option>
              ${groups.map((g) => `<optgroup label="${esc(g.label)}">${g.players.map((p) => `<option value="${p.id}" ${String(p.id) === String(S.insightPlayer) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</optgroup>`).join('')}
            </select>
          </label>
          <div id="ins-body"></div>` : '<div class="notice">Noch keine Spieler angelegt.</div>'}
        </section>

        <section class="card metal">
          <h3 class="card-title">✓ Eintragungs-Status</h3>
          <p class="muted">Welche Spieler haben für welche Phase bereits Zeiten gespeichert? (Klick öffnet den Kalender)</p>
          ${players.length ? `
          <div class="grid-scroll">
            <table class="status-matrix">
              <thead><tr><th>Spieler</th>${PHASES.map((p) => `<th class="c-${p.color}" title="${esc(p.name)} · ${formatRange(p)}"><i class="dot"></i>${esc(p.short)}</th>`).join('')}<th>Σ</th></tr></thead>
              <tbody>${groups.map((g) => `
                <tr class="grp"><td colspan="${PHASES.length + 2}">${esc(g.label)}</td></tr>
                ${g.players.map((p) => {
                  const n = PHASES.filter((ph) => saved.has(`${p.id}|${ph.id}`)).length;
                  return `<tr><td class="pn">${esc(p.name)}</td>${PHASES.map((ph) => saved.has(`${p.id}|${ph.id}`)
                    ? `<td><button class="mx ok" data-p="${p.id}" data-ph="${ph.id}" title="Gespeichert – ansehen">✓</button></td>`
                    : `<td><button class="mx" data-p="${p.id}" data-ph="${ph.id}" title="Noch nicht gespeichert">·</button></td>`).join('')}<td class="sum">${n}/${PHASES.length}</td></tr>`;
                }).join('')}`).join('')}
              </tbody>
            </table>
          </div>` : ''}
        </section>
      </div>`);
    body.replaceChildren(root);

    const insBody = root.querySelector('#ins-body');
    const sel = root.querySelector('#ins-player');
    let reqId = 0;
    const showPlayer = async () => {
      const pid = S.insightPlayer;
      if (!pid || !insBody) { if (insBody) insBody.innerHTML = ''; return; }
      const player = players.find((p) => String(p.id) === String(pid));
      if (!player) { insBody.innerHTML = ''; return; }
      if (!S.insightPhase) S.insightPhase = (PHASES.find((ph) => saved.has(`${pid}|${ph.id}`)) || PHASES[0]).id;
      const phase = getPhase(S.insightPhase);
      const savedCount = PHASES.filter((ph) => saved.has(`${pid}|${ph.id}`)).length;
      insBody.innerHTML = `
        <div class="ins-info">
          <b>${esc(player.name)}</b> <span class="muted">· ${esc(player.team_name || 'ohne Team')}</span>
          ${savedCount ? `<span class="badge ok">Zeiten für ${savedCount}/${PHASES.length} Phasen gespeichert</span>` : '<span class="badge open">Hat noch keine Zeiten gespeichert</span>'}
        </div>
        <div class="phase-chips">${PHASES.map((p) => `<button class="chip c-${p.color} ${p.id === phase.id ? 'active' : ''}" data-ins-phase="${p.id}"><i class="dot"></i>${esc(p.short)} ${saved.has(`${pid}|${p.id}`) ? '<span class="ok-mark">✓</span>' : ''}</button>`).join('')}</div>
        <div id="ins-grid"><div class="loading"><div class="spinner"></div></div></div>`;
      insBody.querySelectorAll('[data-ins-phase]').forEach((b) => b.addEventListener('click', () => { S.insightPhase = b.dataset.insPhase; showPlayer(); }));
      const my = ++reqId;
      const data = await api(`/players/${pid}/availability/${phase.id}`);
      if (my !== reqId) return;
      const cells = new Map(data.cells.map((c) => [key(c.date, c.hour), c.status]));
      const gridBox = insBody.querySelector('#ins-grid');
      const c = { green: 0, yellow: 0, red: 0 };
      if (data.saved) data.cells.forEach((x) => c[x.status]++);
      gridBox.innerHTML = `
        <div class="cal-toolbar">${legend('edit')}
          ${data.saved ? `<div class="save-state"><span class="cnt g">${c.green} grün</span><span class="cnt y">${c.yellow} gelb</span><span class="cnt r">${c.red} rot</span></div>` : ''}</div>
        ${data.saved ? '' : `<div class="notice warn">${esc(player.name)} hat für „${esc(phase.name)}${phase.subtitle ? ' – ' + esc(phase.subtitle) : ''}“ noch keine Zeiten gespeichert.</div>`}
        <div class="ro-grid ${data.saved ? '' : 'unsaved'}"></div>`;
      mountReadonlyGrid(gridBox.querySelector('.ro-grid'), phase, cells);
    };
    sel?.addEventListener('change', () => { S.insightPlayer = sel.value || null; S.insightPhase = null; showPlayer(); });
    root.querySelectorAll('.mx').forEach((b) => b.addEventListener('click', () => {
      S.insightPlayer = b.dataset.p;
      S.insightPhase = b.dataset.ph;
      if (sel) sel.value = b.dataset.p;
      showPlayer();
      root.querySelector('#single-view').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    await showPlayer();
  }

  async function adminMatch(body, matchupId) {
    const matchups = await api('/matchups');
    const m = matchups.find((x) => String(x.id) === String(matchupId));
    if (!m) { toast('Paarung nicht gefunden', 'error'); return go('#/admin/insight'); }
    const phase = getPhase(m.phase_id);
    const siblings = matchups.filter((x) => x.phase_id === m.phase_id);
    body.innerHTML = `
      <div class="phase-view embedded c-${phase.color}">
        <div class="pv-head metal">
          <a class="btn btn-ghost btn-sm" href="#/admin/insight">← Zurück</a>
          <div class="pv-title"><img src="/logo.png" alt="3vs3" class="pv-crest"><span class="pv-dot"></span><div><h1>${esc(phase.name)}${phase.subtitle ? ` <small>${esc(phase.subtitle)}</small>` : ''}</h1><p>Woche ${phase.week} · ${formatRange(phase)} · Paarungs-Abgleich</p></div></div>
        </div>
        <div class="pv-content" id="am-body"></div>
      </div>`;
    const chooser = siblings.length > 1
      ? `<div class="mu-chooser">${siblings.map((x) => `<a href="#/admin/match/${x.id}" class="chip ${x.id === m.id ? 'active' : ''}">${esc(x.team_a_name)} vs. ${esc(x.team_b_name)} ${x.confirmed_slot ? '🏆' : ''}</a>`).join('')}</div>`
      : '';
    await mountMatchView(body.querySelector('#am-body'), phase, m.id, { prefix: chooser, isAdmin: true });
  }

  // ---------- Start ----------
  route();
})();
