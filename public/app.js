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

  const S = { adminPhase: PHASES[0].id, insightPlayer: null, insightPhase: null, homeFilter: 'all' };
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

  function teamInitials(name) {
    const words = String(name || '')
      .replace(/^(die|the|der|das)\s+/i, '')
      .trim()
      .split(/[\s.-]+/)
      .filter(Boolean);
    if (!words.length) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function teamLogoHTML(logo, name, size = 'sm', extraCls = '') {
    const cls = `team-crest tc-${size} ${logo ? '' : 'tc-fallback'} ${extraCls}`.trim();
    if (logo) {
      return `<span class="${cls}" title="${esc(name || '')}"><img src="${esc(logo)}" alt="${esc(name || '')}" loading="lazy"></span>`;
    }
    return `<span class="${cls}" title="${esc(name || 'Ohne Logo')}"><span>${esc(teamInitials(name))}</span></span>`;
  }

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
        <span><i class="lg m-perfect"></i>Perfekt (alle grün)</span>
        <span><i class="lg m-maybe"></i>Möglich (mit gelb)</span>
        <span><i class="lg m-no"></i>Nicht möglich</span>
        <span><i class="lg m-own-busy"></i>🚫 Eigenes Spiel</span>
        <span><i class="lg m-tv"></i>📺 Parallelspiel</span>
      </div>`;
    }
    return `<div class="legend">
      <span><i class="lg s-green"></i>Grün = Kann ich</span>
      <span><i class="lg s-yellow"></i>Gelb = Unsicher</span>
      <span><i class="lg s-red"></i>Rot = Kann ich nicht</span>
    </div>`;
  }

  // ---------- Router ----------
  let handlingUnsavedHash = false;
  window.addEventListener('hashchange', async () => {
    if (ignoreHash) { ignoreHash = false; return; }
    if (dirty) {
      if (handlingUnsavedHash) return;
      handlingUnsavedHash = true;
      const targetHash = location.hash;
      ignoreHash = true;
      location.hash = currentHash;
      const ok = await modal({
        title: 'Ungespeicherte Änderungen',
        body: '<p>Du hast Änderungen an deinen Zeiten vorgenommen, die noch nicht gespeichert wurden. Möchtest du die Seite wirklich verlassen und deine Änderungen verwerfen?</p>',
        confirmText: 'Ja, verwerfen',
        cancelText: 'Zurück zum Kalender',
        danger: true,
      });
      handlingUnsavedHash = false;
      if (ok) {
        dirty = false;
        go(targetHash);
      }
      return;
    }
    dirty = false;
    route();
  });
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

  async function go(hash) {
    if (dirty) {
      if (handlingUnsavedHash) return;
      handlingUnsavedHash = true;
      const ok = await modal({
        title: 'Ungespeicherte Änderungen',
        body: '<p>Du hast Änderungen an deinen Zeiten vorgenommen, die noch nicht gespeichert wurden. Möchtest du die Seite wirklich verlassen und deine Änderungen verwerfen?</p>',
        confirmText: 'Ja, verwerfen',
        cancelText: 'Zurück zum Kalender',
        danger: true,
      });
      handlingUnsavedHash = false;
      if (!ok) return;
      dirty = false;
    }
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
        </div>
        <section class="card metal login-card">
          <h2>Spieler-Login</h2>
          <p class="muted">Suche deinen Namen und logge dich ein – kein Passwort nötig.</p>
          ${remembered ? `<button class="continue-chip" id="continue-btn">${remembered.team_name ? teamLogoHTML(remembered.team_logo, remembered.team_name, 'xs') : ''}<span>↩ Weiter als <b>${esc(remembered.name)}</b>${remembered.team_name ? ` <small class="muted">(${esc(remembered.team_name)})</small>` : ''}</span></button>` : ''}
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
        ? results.map((p, i) => `<li role="option" data-i="${i}" class="${i === active ? 'active' : ''}"><span class="r-name">${highlight(p.name, q)}</span><span class="r-team">${p.team_name ? `${teamLogoHTML(p.team_logo, p.team_name, 'xs')}<span>${highlight(p.team_name, q)}</span>` : '<em>ohne Team</em>'}</span></li>`).join('')
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
    // Entschlackt: Der große rote Alarm-Banner wird nicht mehr auf der Startseite angezeigt,
    // um ältere Spieler nicht zu überfordern. Die Nachrichten bleiben über die Glocke oben erreichbar.
    return '<div id="notif-start-banner-wrap"></div>';
  }

  function playerTopbar(me) {
    const p = me.player;
    return `
      <header class="topbar metal">
        <a href="#/player" class="brand-link">${brand(true)}</a>
        <div class="who">
          <div class="who-main">
            ${p.team_name ? teamLogoHTML(p.team_logo, p.team_name, 'md') : `<span class="avatar">${esc(p.name.slice(0, 1).toUpperCase())}</span>`}
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
    backdrop.className = 'modal-backdrop notif-backdrop show';
    backdrop.id = 'notif-modal-backdrop';

    const onKey = (e) => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
      }
    };
    document.addEventListener('keydown', onKey);
    const close = () => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    };

    const renderModalContent = () => {
      const list = me.notifications || [];
      const unread = list.filter((n) => !n.is_read);
      const read = list.filter((n) => n.is_read);

      const renderItem = (n) => {
        const meta = notifMeta(n.kind);
        const ph = n.phase_id ? getPhase(n.phase_id) : null;
        const canJump = Boolean(n.phase_id && n.matchup_id);
        const jumpBtnCls = (n.kind === 'proposal_received' || n.kind === 'counter_proposal')
          ? 'btn-amber'
          : (n.kind === 'all_6_ready' || n.kind === 'match_confirmed')
            ? 'btn-primary'
            : 'btn-blue';
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
                ? `<button type="button" class="btn ${jumpBtnCls} btn-sm nc-jump-btn" data-nid="${n.id}" data-phase="${esc(n.phase_id)}" data-match="${n.matchup_id}">
                    ⚔ Direkt zum Match-Abgleich ›
                  </button>`
                : ph
                ? `<button type="button" class="btn btn-steel btn-sm nc-jump-phase-btn" data-nid="${n.id}" data-phase="${esc(n.phase_id)}">
                    🗓 Zur Turnierphase ›
                  </button>`
                : ''}
              ${!n.is_read
                ? `<button type="button" class="btn btn-steel btn-sm nc-mark-btn" data-nid="${n.id}">✓ Als gelesen markieren</button>`
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

      backdrop.querySelector('#nc-close-btn')?.addEventListener('click', close);
      backdrop.onclick = (e) => { if (e.target === backdrop) close(); };

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

  function opponentLogoOf(m, teamId) {
    return m.team_a_id === teamId ? m.team_b_logo : m.team_a_logo;
  }

  function myLogoOf(m, teamId, fallbackLogo = null) {
    if (m.team_a_id === teamId) return m.team_a_logo || fallbackLogo;
    if (m.team_b_id === teamId) return m.team_b_logo || fallbackLogo;
    return fallbackLogo;
  }

  async function renderPlayerHome() {
    const me = await loadMe();
    if (!me) return;
    const saved = new Set(me.savedPhases);
    const weekRange = (w) => {
      const ps = PHASES.filter((p) => p.week === w);
      return `${formatDay(ps[0].start).short} – ${formatDay(ps[ps.length - 1].end).short}`;
    };

    const enriched = me.matchups.map((m) => {
      const ph = getPhase(m.phase_id);
      const opponent = opponentOf(m, me.player.team_id);
      const oppLogo = opponentLogoOf(m, me.player.team_id);
      const myLogo = myLogoOf(m, me.player.team_id, me.player.team_logo);
      const mySaved = saved.has(m.phase_id);
      const propSlots = Array.isArray(m.proposed_slots) ? m.proposed_slots : [];
      const isConfirmed = Boolean(m.confirmed_slot);
      const isIncoming = !isConfirmed && propSlots.length > 0 && m.proposed_by_team_id !== me.player.team_id;
      const isOutgoing = !isConfirmed && propSlots.length > 0 && m.proposed_by_team_id === me.player.team_id;
      const isWaiting = !isConfirmed && !propSlots.length && (m.phase_id === 'w3-r16' || !mySaved);
      const isReady = !isConfirmed && !propSlots.length && !isWaiting;
      const needsAction = !isConfirmed && (isIncoming || isReady || !mySaved);
      const prio = isIncoming ? 1 : isReady ? 2 : isWaiting ? 3 : isOutgoing ? 4 : 5;
      return { m, ph, opponent, oppLogo, myLogo, mySaved, propSlots, isConfirmed, isIncoming, isOutgoing, isWaiting, isReady, needsAction, prio };
    });

    const openMatches = enriched.filter((x) => !x.isConfirmed).sort((a, b) => a.prio - b.prio);
    const actionMatches = openMatches.filter((x) => x.needsAction);
    const waitingMatches = openMatches.filter((x) => !x.needsAction);
    const confirmedMatches = enriched.filter((x) => x.isConfirmed);

    const renderFocusHero = () => {
      const incoming = enriched.find((x) => x.isIncoming);
      const missingMy = enriched.find((x) => !x.isConfirmed && !x.mySaved);
      const ready = enriched.find((x) => x.isReady);
      const outgoing = enriched.find((x) => x.isOutgoing);
      const waitingOther = enriched.find((x) => x.isWaiting && x.mySaved);
      const nextConfirmed = confirmedMatches[0];

      let badge = '';
      let badgeCls = '';
      let title = '';
      let desc = '';
      let actionBtn = '';

      if (incoming) {
        badge = '📩 Rückmeldung erbeten';
        badgeCls = 'warn';
        title = `Euer Gegner ${esc(incoming.opponent)} hat Spieltermine vorgeschlagen!`;
        desc = `Für „${esc(incoming.ph.name)}“ liegen Terminvorschläge vor. Bitte wähle gemeinsam mit deinem Team einen Termin aus oder schicke einen Gegenvorschlag.`;
        actionBtn = `<a href="#/player/phase/${incoming.m.phase_id}/match/${incoming.m.id}" class="btn btn-amber btn-lg focus-action-btn">📩 Jetzt Termine ansehen & wählen ›</a>`;
      } else if (missingMy) {
        badge = '🗓 Deine Zeiten fehlen';
        badgeCls = 'warn';
        title = `Hallo ${esc(me.player.name)}, deine Zeiten für „${esc(missingMy.ph.name)}“ fehlen noch!`;
        desc = `Damit euer Spiel gegen <b>${esc(missingMy.opponent)}</b> abgestimmt werden kann, trage bitte im Kalender ein, wann du spielen kannst.`;
        actionBtn = `<a href="#/player/phase/${missingMy.m.phase_id}" class="btn btn-amber btn-lg focus-action-btn">🗓 Jetzt meine freien Zeiten eintragen ›</a>`;
      } else if (ready) {
        badge = '🤝 Bereit zur Terminauswahl';
        badgeCls = 'ready-badge';
        title = `Alle 6 Spieler haben Zeiten eingetragen für „${esc(ready.ph.name)}“!`;
        desc = `Alle Verfügbarkeiten sind da. Euer Team (${esc(me.player.team_name || 'Dein Team')}) kann jetzt 1 bis 3 gemeinsame Spieltermine an ${esc(ready.opponent)} senden.`;
        actionBtn = `<a href="#/player/phase/${ready.m.phase_id}/match/${ready.m.id}" class="btn btn-primary btn-lg focus-action-btn">🤝 Spieltermine vorschlagen ›</a>`;
      } else if (outgoing) {
        badge = '⏳ Warten auf Gegner';
        badgeCls = 'open';
        title = `Terminvorschlag gesendet – wir warten auf ${esc(outgoing.opponent)}`;
        desc = `Euer Terminvorschlag für „${esc(outgoing.ph.name)}“ liegt beim gegnerischen Team zur Prüfung. Du musst aktuell nichts weiter tun!`;
        actionBtn = `<a href="#/player/phase/${outgoing.m.phase_id}/match/${outgoing.m.id}" class="btn btn-blue btn-lg focus-action-btn">🔍 Vorschlag & Status ansehen ›</a>`;
      } else if (waitingOther) {
        badge = '⏳ Warten auf Mitspieler & Gegner';
        badgeCls = 'open';
        title = `Deine Zeiten sind gespeichert! Wir warten noch auf andere Spieler.`;
        desc = `Für „${esc(waitingOther.ph.name)}“ hast du deine Zeiten eingetragen. Sobald alle 6 Spieler fertig sind, schlagt ihr Termine vor.`;
        actionBtn = `<a href="#/player/phase/${waitingOther.m.phase_id}/match/${waitingOther.m.id}" class="btn btn-blue btn-lg focus-action-btn">⚔ Wer fehlt noch? (Status prüfen) ›</a>`;
      } else if (nextConfirmed) {
        badge = '🏆 Spieltermin steht fest';
        badgeCls = 'ok';
        title = `Euer nächstes Spiel: ${slotLabel(nextConfirmed.m.confirmed_slot)} Uhr!`;
        desc = `Das Spiel gegen <b>${esc(nextConfirmed.opponent)}</b> in „${esc(nextConfirmed.ph.name)}“ ist verbindlich vereinbart.`;
        actionBtn = `<a href="#/player/phase/${nextConfirmed.m.phase_id}/match/${nextConfirmed.m.id}" class="btn btn-blue btn-lg focus-action-btn">🏆 Zum Spiel-Abgleich & Details ›</a>`;
      } else {
        badge = '✅ Alles erledigt';
        badgeCls = 'ok';
        title = `Alles erledigt, ${esc(me.player.name)}!`;
        desc = `Aktuell gibt es keinen offenen Handlungsbedarf für dich. Du kannst dich entspannt zurücklehnen oder unten deine Kalenderzeiten prüfen.`;
        actionBtn = `<button type="button" class="btn btn-steel btn-lg focus-action-btn" data-switch-tab="calendar">🗓 Kalenderzeiten ansehen ›</button>`;
      }

      return `
        <section class="focus-hero card metal focus-${badgeCls}">
          <div class="focus-hero-head">
            <span class="focus-hero-label">👉 Was ist jetzt zu tun?</span>
            <span class="badge ${badgeCls}">${badge}</span>
          </div>
          <div class="focus-hero-body">
            <h2 class="focus-hero-title">${title}</h2>
            <p class="focus-hero-desc">${desc}</p>
            <div class="focus-hero-actions">
              ${actionBtn}
            </div>
          </div>
        </section>`;
    };

    const renderMatchRow = (item) => {
      const { m, ph, opponent, oppLogo, myLogo, mySaved, propSlots, isConfirmed, isIncoming, isOutgoing, isWaiting } = item;
      let stateCls = 'st-ready';
      let statusHTML = '';
      let primaryBtnHTML = '';

      if (isConfirmed) {
        stateCls = 'st-confirmed';
        statusHTML = `
          <div class="m-row-status">
            <span class="badge ok">🏆 Fester Termin</span>
            <b class="m-row-slot">${slotLabel(m.confirmed_slot)} Uhr</b>
            <small class="muted">Bestätigt von ${esc(m.confirmed_by_player_name || 'Admin')}</small>
          </div>`;
        primaryBtnHTML = `<a href="#/player/phase/${m.phase_id}/match/${m.id}" class="btn btn-blue btn-sm">🏆 Details ansehen ›</a>`;
      } else if (isIncoming) {
        stateCls = 'st-incoming';
        statusHTML = `
          <div class="m-row-status">
            <div class="m-row-status-top">
              <span class="badge warn">📩 Vorschlag von ${esc(opponent)}</span>
              <small class="muted">von ${esc(m.proposed_by_player_name || '')} · bitte Termin auswählen oder Gegenvorschlag senden:</small>
            </div>
            <div class="m-row-chips">${propSlots.map((s) => `<span class="prop-chip">${slotLabel(s)} Uhr</span>`).join('')}</div>
          </div>`;
        primaryBtnHTML = `<a href="#/player/phase/${m.phase_id}/match/${m.id}" class="btn btn-amber btn-sm">📩 Termin auswählen ›</a>`;
      } else if (isOutgoing) {
        stateCls = 'st-outgoing';
        statusHTML = `
          <div class="m-row-status">
            <div class="m-row-status-top">
              <span class="badge open">⏳ Wartet auf ${esc(opponent)}</span>
              <small class="muted">Euer Terminvorschlag:</small>
            </div>
            <div class="m-row-chips">${propSlots.map((s) => `<span class="prop-chip subtle">${slotLabel(s)} Uhr</span>`).join('')}</div>
          </div>`;
        primaryBtnHTML = `<a href="#/player/phase/${m.phase_id}/match/${m.id}" class="btn btn-blue btn-sm">⏳ Status ansehen ›</a>`;
      } else if (isWaiting) {
        stateCls = 'st-waiting';
        statusHTML = `
          <div class="m-row-status">
            <span class="badge warn">⚠️ Zeiten fehlen noch</span>
            <small class="muted">${!mySaved ? 'Bitte trage zuerst deine eigenen freien Zeiten für diese Phase ein.' : 'Noch nicht alle 6 Spieler haben ihre Zeiten gespeichert.'}</small>
          </div>`;
        primaryBtnHTML = !mySaved
          ? `<a href="#/player/phase/${m.phase_id}" class="btn btn-amber btn-sm">🗓 Zeiten eintragen ›</a>`
          : `<a href="#/player/phase/${m.phase_id}/match/${m.id}" class="btn btn-blue btn-sm">⚔ Wer fehlt noch? ›</a>`;
      } else {
        stateCls = 'st-ready';
        statusHTML = `
          <div class="m-row-status">
            <span class="badge ready-badge">🤝 Bereit zur Terminauswahl</span>
            <small class="muted">Alle 6 Spieler haben Zeiten eingetragen – schlagt dem Gegner jetzt Termine vor.</small>
          </div>`;
        primaryBtnHTML = `<a href="#/player/phase/${m.phase_id}/match/${m.id}" class="btn btn-primary btn-sm">🤝 Termine vorschlagen ›</a>`;
      }

      return `
        <article class="m-row-card c-${ph ? ph.color : 'green'} ${stateCls}">
          <div class="m-row-left">
            <div class="m-row-phase">
              <i class="dot"></i>
              <span>W${ph ? ph.week : ''} · ${ph ? esc(ph.name) : ''}${ph && ph.subtitle ? ` (${esc(ph.subtitle)})` : ''}</span>
              <small>${ph ? formatRange(ph) : ''}</small>
            </div>
            <div class="m-row-teams">
              <span class="m-team-entry">${teamLogoHTML(myLogo, me.player.team_name, 'sm')}<span class="m-team-mine">${esc(me.player.team_name || 'Dein Team')}</span></span>
              <span class="m-vs">vs.</span>
              <span class="m-team-entry">${teamLogoHTML(oppLogo, opponent, 'sm')}<span class="m-team-opp">${esc(opponent)}</span></span>
            </div>
          </div>
          <div class="m-row-center">
            ${statusHTML}
          </div>
          <div class="m-row-right">
            ${primaryBtnHTML}
            <a href="#/player/phase/${m.phase_id}" class="btn ${mySaved ? 'btn-steel' : 'btn-amber'} btn-xs" title="Eigene Zeiten für diese Phase bearbeiten">
              🗓 Meine Zeiten ${mySaved ? '✓' : 'fehlen'}
            </a>
          </div>
        </article>`;
    };

    const renderDashboardBody = () => {
      const activeTab = S.homeMainTab || 'matches';
      const matchFilter = S.homeMatchFilter || 'all';

      let displayMatches = openMatches;
      if (matchFilter === 'confirmed') displayMatches = confirmedMatches;
      else if (matchFilter === 'all') displayMatches = [...openMatches, ...confirmedMatches];

      const matchesSectionHTML = `
        <section class="dashboard-section">
          <div class="sec-bar">
            <div>
              <h2>⚔ Deine Spiele & Termine</h2>
              <p class="muted">Hier siehst du alle angesetzten Spiele deines Teams und wie weit die Termin-Abstimmung ist:</p>
            </div>
            <div class="sub-filter-pills">
              <button type="button" class="sub-pill ${matchFilter === 'all' ? 'active' : ''}" data-match-filter="all">Alle (${enriched.length})</button>
              <button type="button" class="sub-pill ${matchFilter === 'open' ? 'active' : ''}" data-match-filter="open">In Abstimmung (${openMatches.length})</button>
              <button type="button" class="sub-pill ${matchFilter === 'confirmed' ? 'active' : ''}" data-match-filter="confirmed">Fest vereinbart (${confirmedMatches.length})</button>
            </div>
          </div>
          ${!enriched.length ? `
            <section class="player-matches-hero metal no-match">
              <div class="pmh-empty">
                <img src="/logo.png" alt="" class="pmh-empty-crest">
                <div>
                  <h3>Noch keine Spielpaarung für dein Team</h3>
                  <p class="muted">Sobald der Admin eine Paarung für <b>${esc(me.player.team_name || 'dein Team')}</b> ansetzt, kannst du hier mit dem gegnerischen Team einen Spieltermin abstimmen.</p>
                </div>
              </div>
            </section>
          ` : matchFilter === 'all' ? `
            ${openMatches.length ? `
              <div class="m-group">
                <h3 class="m-group-title">⏳ In Termin-Abstimmung (${openMatches.length})</h3>
                <div class="m-row-list">${openMatches.map(renderMatchRow).join('')}</div>
              </div>` : ''}
            ${confirmedMatches.length ? `
              <div class="m-group">
                <h3 class="m-group-title">🏆 Fest vereinbarte Spieltermine (${confirmedMatches.length})</h3>
                <div class="m-row-list">${confirmedMatches.map(renderMatchRow).join('')}</div>
              </div>` : ''}
          ` : `
            <div class="m-row-list">${displayMatches.map(renderMatchRow).join('') || '<div class="notice">Keine Spiele in dieser Auswahl.</div>'}</div>
          `}
        </section>`;

      const calendarSectionHTML = `
        <section class="dashboard-section">
          <div class="sec-bar">
            <div>
              <h2>🗓 Dein Verfügbarkeits-Kalender</h2>
              <p class="muted">Wähle eine Spielwoche aus, um deine freien Zeiten einzutragen oder zu ändern:</p>
            </div>
            <div class="sec-pills">
              <span class="badge ${saved.size === PHASES.length ? 'ok' : saved.size > 0 ? 'warn' : 'open'}">✓ ${saved.size} von ${PHASES.length} Phasen gespeichert</span>
            </div>
          </div>
          <div class="weeks">
            ${WEEKS.map((w) => `
              <section class="week-card metal">
                <header class="week-head">
                  <span class="week-no">${w.title}</span>
                  <span class="week-range">${weekRange(w.week)}</span>
                  <span class="week-sub">${esc(w.subtitle)}</span>
                </header>
                <div class="phase-list">
                  ${PHASES.filter((p) => p.week === w.week).map((p) => {
                    const ms = me.matchups.filter((m) => m.phase_id === p.id);
                    const isSaved = saved.has(p.id);
                    const oppName = ms.length === 1 ? opponentOf(ms[0], me.player.team_id) : '';
                    const oppLogo = ms.length === 1 ? opponentLogoOf(ms[0], me.player.team_id) : null;
                    return `
                      <div class="phase-bar c-${p.color}" data-phase="${p.id}">
                        <div class="pb-top">
                          <span class="pb-name">${esc(p.name)}${p.subtitle ? ` <small>${esc(p.subtitle)}</small>` : ''}</span>
                          ${ms.length === 1
                            ? `<span class="badge vs sm">${teamLogoHTML(oppLogo, oppName, 'xs')}<span>vs. ${esc(oppName)}</span></span>`
                            : ms.length > 1
                              ? `<span class="badge vs sm">⚔ ${ms.length} Spiele</span>`
                              : ''}
                        </div>
                        <span class="pb-dates">${formatRange(p)}</span>
                        <div class="pb-btn-wrap">
                          <span class="btn ${isSaved ? 'btn-steel' : 'btn-amber'} btn-xs btn-block">
                            ${isSaved ? '🗓 Zeiten bearbeiten (✓ gespeichert)' : '🗓 Jetzt freie Zeiten eintragen ›'}
                          </span>
                        </div>
                      </div>`;
                  }).join('')}
                </div>
              </section>`).join('')}
          </div>
        </section>`;

      return `
        ${renderFocusHero()}

        <nav class="main-hub-tabs" aria-label="Hauptbereiche">
          <button type="button" class="hub-tab ${activeTab === 'matches' ? 'active' : ''}" data-hub-tab="matches">
            <span class="hub-tab-icon">⚔</span>
            <div class="hub-tab-txt">
              <strong>1. Meine Spiele & Termine</strong>
              <small>${openMatches.length ? `${openMatches.length} Spiel(e) in Abstimmung` : 'Alle Termine geklärt'}</small>
            </div>
          </button>
          <button type="button" class="hub-tab ${activeTab === 'calendar' ? 'active' : ''}" data-hub-tab="calendar">
            <span class="hub-tab-icon">🗓</span>
            <div class="hub-tab-txt">
              <strong>2. Mein Kalender (Zeiten eintragen)</strong>
              <small>${saved.size} von ${PHASES.length} Phasen gespeichert</small>
            </div>
          </button>
        </nav>

        ${activeTab === 'matches' ? matchesSectionHTML : calendarSectionHTML}
      `;
    };

    $app.innerHTML = `
      ${playerTopbar(me)}
      <main class="container">
        ${notifStartBanner(me)}
        <div id="player-home-content"></div>
      </main>`;
    bindLogout(me);

    const contentBox = document.getElementById('player-home-content');
    const mountHomeContent = () => {
      contentBox.innerHTML = renderDashboardBody();
      contentBox.querySelectorAll('[data-hub-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          S.homeMainTab = btn.dataset.hubTab;
          mountHomeContent();
        });
      });
      contentBox.querySelectorAll('[data-match-filter]').forEach((btn) => {
        btn.addEventListener('click', () => {
          S.homeMatchFilter = btn.dataset.matchFilter;
          mountHomeContent();
        });
      });
      contentBox.querySelectorAll('[data-switch-tab]').forEach((btn) => {
        btn.addEventListener('click', () => {
          S.homeMainTab = btn.dataset.switchTab;
          mountHomeContent();
        });
      });
      contentBox.querySelectorAll('.phase-bar').forEach((b) => {
        b.addEventListener('click', () => go(`#/player/phase/${b.dataset.phase}`));
      });
    };
    mountHomeContent();
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
    const mySaved = me.savedPhases.includes(phase.id);

    $app.innerHTML = `
      <div class="phase-view c-${phase.color}">
        <header class="pv-head metal">
          <button class="btn btn-ghost btn-sm" id="back-btn">← Übersicht</button>
          <div class="pv-title">
            <span class="pv-dot"></span>
            <div>
              <h1>${esc(phase.name)}${phase.subtitle ? ` <small>${esc(phase.subtitle)}</small>` : ''}</h1>
              <p>Woche ${phase.week} · ${formatRange(phase)}</p>
            </div>
          </div>
          <div class="pv-right-actions">
            ${notifTopbarBtn(me)}
            <div class="pv-user">
              ${me.player.team_name ? teamLogoHTML(me.player.team_logo, me.player.team_name, 'sm') : `<span class="avatar sm">${esc(me.player.name.slice(0, 1).toUpperCase())}</span>`}
              <span>${esc(me.player.name)}<small>${esc(me.player.team_name || 'ohne Team')}</small></span>
            </div>
          </div>
        </header>
        <div class="pv-content">
          <div class="pv-nav-bar">
            <nav class="pv-mode-switch" aria-label="Ansicht wählen">
              <a class="pv-mode-btn ${mode === 'mine' ? 'active' : ''}" href="#/player/phase/${phase.id}">
                <span>🗓 1. Meine Zeiten</span>
                <span class="badge ${mySaved ? 'ok' : 'open'} sm" id="tab-saved-badge">${mySaved ? '✓ gespeichert' : 'offen'}</span>
              </a>
              ${activeMatchup
                ? `<a class="pv-mode-btn ${mode === 'match' ? 'active' : ''}" href="#/player/phase/${phase.id}/match/${activeMatchup.id}">
                    <span>⚔ 2. Match-Abgleich (6 Spieler)</span>
                    <span class="badge vs sm">${myMatchups.length > 1 ? `${myMatchups.length} Spiele` : `${teamLogoHTML(opponentLogoOf(activeMatchup, me.player.team_id), opponentOf(activeMatchup, me.player.team_id), 'xs')}<span>vs. ${esc(opponentOf(activeMatchup, me.player.team_id))}</span>`}</span>
                  </a>`
                : `<span class="pv-mode-btn disabled" title="Für diese Phase wurde noch keine Paarung für dein Team festgelegt.">⚔ 2. Match-Abgleich <small>(noch kein Gegner)</small></span>`}
            </nav>
            ${groupSiblings.length > 1 ? `<div class="week-switch">${groupSiblings.map((p) => `<a href="#/player/phase/${p.id}" class="${p.id === phase.id ? 'active' : ''}">Woche ${p.week} <small>${formatDay(p.start).short} – ${formatDay(p.end).short}</small></a>`).join('')}</div>` : ''}
          </div>
          ${mode === 'mine' && myMatchups.length ? `
            <div class="pv-quick-matches">
              <span class="muted small">Direkt zum 6-Spieler-Abgleich in dieser Phase:</span>
              <div class="pv-qm-btns">
                ${myMatchups.map((m) => {
                  const ps = Array.isArray(m.proposed_slots) ? m.proposed_slots : [];
                  const isInc = !m.confirmed_slot && ps.length > 0 && m.proposed_by_team_id !== me.player.team_id;
                  const isOut = !m.confirmed_slot && ps.length > 0 && m.proposed_by_team_id === me.player.team_id;
                  const isWait = !m.confirmed_slot && !ps.length && (m.phase_id === 'w3-r16' || !mySaved);
                  const btnCls = isInc ? 'btn-amber' : (!m.confirmed_slot && !ps.length && !isWait) ? 'btn-primary' : 'btn-blue';
                  const st = m.confirmed_slot ? `🏆 ${slotLabel(m.confirmed_slot)}` : isInc ? '📩 Vorschlag prüfen' : isOut ? '⏳ Vorschlag offen' : isWait ? '⚔ Abgleich' : '🤝 Termine vorschlagen';
                  const oppName = opponentOf(m, me.player.team_id);
                  const oppLogo = opponentLogoOf(m, me.player.team_id);
                  return `<a href="#/player/phase/${phase.id}/match/${m.id}" class="btn ${btnCls} btn-xs">${teamLogoHTML(oppLogo, oppName, 'xs')}<span>vs. ${esc(oppName)} · ${st} ›</span></a>`;
                }).join('')}
              </div>
            </div>` : ''}
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
            <span class="muc-label">Spiel auswählen:</span>
            ${myMatchups.map((x) => {
              const ps = Array.isArray(x.proposed_slots) ? x.proposed_slots : [];
              const tag = x.confirmed_slot ? '🏆 Fest' : ps.length ? (x.proposed_by_team_id !== me.player.team_id ? '📩 Anfrage' : '⏳ Gesendet') : '🤝 Offen';
              const oppName = opponentOf(x, me.player.team_id);
              const oppLogo = opponentLogoOf(x, me.player.team_id);
              return `<a href="#/player/phase/${phase.id}/match/${x.id}" class="chip ${x.id === m.id ? 'active' : ''}">${teamLogoHTML(oppLogo, oppName, 'xs')}<span>vs. ${esc(oppName)} <small>(${tag})</small></span></a>`;
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

    // Phasen ermitteln, die dieser Spieler bereits gespeichert hat (außer der aktuellen):
    const otherSavedPhases = PHASES.filter(
      (p) => p.id !== phase.id && me.savedPhases.includes(p.id)
    );
    const myPhaseIdx = PHASES.findIndex((p) => p.id === phase.id);
    const prevSavedPhases = PHASES.slice(0, myPhaseIdx).filter((p) => me.savedPhases.includes(p.id));
    const defaultSourcePhase = prevSavedPhases.length
      ? prevSavedPhases[prevSavedPhases.length - 1]
      : otherSavedPhases[0] || null;

    const copyBarHTML = otherSavedPhases.length ? `
      <div class="copy-week-bar metal">
        <div class="cwb-left">
          <span class="cwb-icon" aria-hidden="true">📋</span>
          <div class="cwb-txt">
            <strong>Zeiten aus anderer Woche übernehmen:</strong>
            <small class="muted">Übernimmt deine freien Wochentage & Uhrzeiten (z. B. Mo–Fr ab 19 Uhr) mit 1 Klick</small>
          </div>
        </div>
        <div class="cwb-actions">
          <select id="cwb-source-select" class="cwb-select" aria-label="Vorlage-Woche wählen">
            ${otherSavedPhases.map((sp) => `
              <option value="${sp.id}" ${sp.id === defaultSourcePhase?.id ? 'selected' : ''}>
                W${sp.week}: ${esc(sp.name)}${sp.subtitle ? ` (${esc(sp.subtitle)})` : ''}
              </option>
            `).join('')}
          </select>
          <button type="button" class="btn btn-primary btn-sm" id="cwb-copy-btn">
            📋 Zeiten jetzt übernehmen
          </button>
        </div>
      </div>` : '';

    body.innerHTML = `
      ${copyBarHTML}
      <div class="cal-toolbar">
        ${legend('edit')}
        <span class="cal-help-inline muted small">💡 Klick/Ziehen = Stunden markieren · Klick auf Tag/Uhrzeit = ganze Spalte/Zeile</span>
        <div class="tool-actions">
          <button type="button" class="btn btn-steel btn-xs" data-preset="workdays-19" title="Montag bis Freitag von 19:00 bis 23:00 Uhr auf Grün setzen">⚡ Werktags ab 19 Uhr</button>
          <button type="button" class="btn btn-steel btn-xs" data-preset="evenings-20" title="Montag bis Sonntag von 20:00 bis 23:00 Uhr auf Grün setzen">⚡ Abende ab 20 Uhr</button>
          <button type="button" class="btn btn-ghost btn-xs" data-fill="green">Alles grün</button>
          <button type="button" class="btn btn-ghost btn-xs" data-fill="red">Alles rot</button>
        </div>
      </div>
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
      const tabBadge = document.getElementById('tab-saved-badge');
      if (tabBadge && savedOnce && !dirty) {
        tabBadge.className = 'badge ok sm';
        tabBadge.textContent = '✓ gespeichert';
      }
    };

    const editor = mountEditor(document.getElementById('editor'), phase, cells, () => { dirty = true; updateState(); });
    updateState();

    body.querySelectorAll('[data-fill]').forEach((b) => b.addEventListener('click', () => {
      editor.setAll(b.dataset.fill);
    }));

    body.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      const p = b.dataset.preset;
      if (p === 'workdays-19') {
        editor.applyPreset(({ isWorkday, hour }) => (isWorkday && hour >= 19 && hour <= 22 ? 'green' : null));
        toast('Montag–Freitag ab 19 Uhr auf Grün gesetzt!');
      } else if (p === 'evenings-20') {
        editor.applyPreset(({ hour }) => (hour >= 20 && hour <= 22 ? 'green' : null));
        toast('Jeden Abend ab 20 Uhr auf Grün gesetzt!');
      }
    }));

    // Klick auf "Zeiten von anderer Woche übernehmen":
    const copyBtn = body.querySelector('#cwb-copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', async () => {
        const sel = body.querySelector('#cwb-source-select');
        const sourceId = sel?.value;
        if (!sourceId) return;
        const sourcePhase = getPhase(sourceId);
        copyBtn.disabled = true;
        copyBtn.textContent = 'Lade Vorlage …';
        try {
          const res = await api(`/players/${me.player.id}/availability/${sourceId}`);
          if (!res.cells || !res.cells.length) {
            toast('In dieser Vorlage wurden keine Zeiten gefunden.', 'warn');
            return;
          }
          const wMap = new Map();
          res.cells.forEach((c) => {
            const wd = new Date(c.date + 'T00:00:00Z').getUTCDay();
            wMap.set(`${wd}|${c.hour}`, c.status);
          });
          editor.applyWeekdayMap(wMap);
          dirty = true;
          updateState();
          toast(`✓ Zeiten aus „${sourcePhase?.name || 'Vorwoche'}“ übernommen! Klicke unten auf „Zeiten speichern“, um sie zu sichern.`);
          saveBtn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } catch (err) {
          toast('Fehler beim Laden der Vorlage: ' + err.message, 'error');
        } finally {
          copyBtn.disabled = false;
          copyBtn.textContent = '📋 Zeiten jetzt übernehmen';
        }
      });
    }

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      saveBtn.classList.add('loading');
      saveBtn.querySelector('.btn-label').textContent = 'Speichere …';
      try {
        const payload = [...cells].map(([k, status]) => { const [date, hour] = k.split('|'); return { date, hour: Number(hour), status }; });
        await api(`/players/${me.player.id}/availability/${phase.id}`, { method: 'PUT', body: { cells: payload } });
        dirty = false;
        savedOnce = true;
        if (!me.savedPhases.includes(phase.id)) me.savedPhases.push(phase.id);
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
      applyWeekdayMap(weekdayMap) {
        let changed = false;
        dates.forEach((d) => {
          const wd = new Date(d + 'T00:00:00Z').getUTCDay();
          HOURS.forEach((h) => {
            const k = key(d, h);
            if (weekdayMap.has(`${wd}|${h}`)) {
              changed = setCell(k, weekdayMap.get(`${wd}|${h}`)) || changed;
            }
          });
        });
        if (changed) onChange();
      },
      applyPreset(fn) {
        let changed = false;
        dates.forEach((d) => {
          const wd = new Date(d + 'T00:00:00Z').getUTCDay();
          const isWorkday = wd >= 1 && wd <= 5;
          HOURS.forEach((h) => {
            const k = key(d, h);
            const target = fn({ date: d, weekday: wd, isWorkday, hour: h, current: cells.get(k) });
            if (target) changed = setCell(k, target) || changed;
          });
        });
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
    let showMaybe = false;
    let showRadar = false;

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
      const missing = allPlayers.filter((p) => !hasSaved(p.id));
      const short = [data.teamA, data.teamB].filter((t) => t.players.length < 3);
      const allSaved = data.teamA.players.length > 0 && data.teamB.players.length > 0 && missing.length === 0;
      const mePlayer = highlightPlayer ? allPlayers.find((p) => p.id === highlightPlayer) : null;
      const myTeamId = mePlayer ? mePlayer.team_id : null;
      const propTeamName = m.proposed_by_team_id === data.teamA.id ? data.teamA.name : m.proposed_by_team_id === data.teamB.id ? data.teamB.name : '';
      const waitTeamName = m.proposed_by_team_id === data.teamA.id ? data.teamB.name : m.proposed_by_team_id === data.teamB.id ? data.teamA.name : '';

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
          return `<span class="sp-conflict own-busy">🚫 ${esc(busyTeamNameOf(c))} (${pad2(c.otherHour)}:00)</span>`;
        }
        const cs = streamConflictsFor(k);
        if (!cs.length) return '';
        const hasExact = cs.some((c) => c.exact);
        const label = hasExact
          ? `📺 ${cs.length > 1 ? `${cs.length}× parallel` : 'Parallelspiel'}`
          : '📺 ~1,5h Überschn.';
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

      const teamColumn = (t, side) => `
        <div class="mc-team ${side}">
          <div class="mc-team-head">
            ${teamLogoHTML(t.logo, t.name, 'lg')}
            <div class="mc-team-titles">
              <h3>${esc(t.name)}</h3>
              <span class="muted small">${t.players.filter((p) => hasSaved(p.id)).length}/${t.players.length} Spieler bereit</span>
            </div>
          </div>
          <div class="mc-players">
            ${t.players.map((p) => {
              const sv = hasSaved(p.id);
              return `<span class="mc-player-pill ${sv ? 'is-saved' : 'is-missing'} ${p.id === highlightPlayer ? 'is-me' : ''}">
                <i class="mcp-icon">${sv ? '✓' : '⏳'}</i>
                <span>${esc(p.name)}${p.id === highlightPlayer ? ' <em>(du)</em>' : ''}</span>
              </span>`;
            }).join('') || '<span class="muted small">Keine Spieler</span>'}
          </div>
        </div>`;

      const adminBarHTML = isAdmin ? `
        <div class="sched-admin-bar">
          <span>🔧 <b>Admin-Steuerung:</b></span>
          ${m.confirmed_slot || propSlots.length ? `<button type="button" class="btn btn-sm btn-ghost" id="admin-reset-sched">🔓 ${m.confirmed_slot ? 'Festen Termin freigeben' : 'Vorschlag zurücksetzen'}</button>` : ''}
          <button type="button" class="btn btn-sm btn-primary" id="admin-set-sched">🏆 ${m.confirmed_slot ? 'Termin ändern' : 'Termin manuell setzen'}</button>
        </div>` : '';

      let schedBoxHTML = '';
      if (m.confirmed_slot) {
        schedBoxHTML = `
          <section class="sched-card confirmed metal">
            <div class="sched-top">
              <span class="sched-icon">🏆</span>
              <div class="sched-main">
                <span class="sched-kicker">Verbindlicher Spieltermin</span>
                <h3 class="sched-time">${slotLabel(m.confirmed_slot)} Uhr</h3>
                <p class="sched-sub">
                  ${m.confirmed_by_player_name === 'Admin'
                    ? 'Festgelegt durch die Turnierleitung (Admin).'
                    : `Bestätigt von <b>${esc(m.confirmed_by_player_name || '')}</b>${m.proposed_by_player_name ? ` · Vorschlag von ${esc(m.proposed_by_player_name)} (${esc(propTeamName)})` : ''}.`}
                </p>
              </div>
              <span class="badge ok">🔒 Steht fest</span>
            </div>
            ${isAdmin ? adminBarHTML : '<div class="sched-lock-note">🔒 Dieser Termin ist verbindlich eingetragen. Änderungen sind nur über den Admin möglich.</div>'}
          </section>`;
      } else if (!allSaved) {
        const iAmMissing = mePlayer && !hasSaved(mePlayer.id);
        schedBoxHTML = `
          <section class="sched-card locked metal">
            <div class="sched-top">
              <span class="sched-icon">⏳</span>
              <div class="sched-main">
                <span class="sched-kicker">Termin-Einigung (${n - missing.length} von ${n} Spielern bereit)</span>
                <h3 class="sched-title">Wartet noch auf fehlende Zeiten</h3>
                <p class="sched-sub">Sobald alle ${n} Spieler ihre Zeiten für diese Phase gespeichert haben, könnt ihr euch hier auf einen Termin einigen.</p>
                ${missing.length ? `<div class="sched-missing">Es fehlen noch: ${missing.map((p) => `<span class="badge warn">${esc(p.name)}</span>`).join(' ')}</div>` : ''}
              </div>
              ${iAmMissing ? `<a href="#/player/phase/${phase.id}" class="btn btn-amber btn-sm">🗓 Jetzt meine Zeiten eintragen ›</a>` : ''}
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
                  <h3 class="sched-title">${propSlots.length === 1 ? 'Termin bestätigen oder Gegenvorschlag senden' : `Einen der ${propSlots.length} Vorschläge auswählen & bestätigen`}</h3>
                  <p class="sched-sub">Mit Klick auf <b>„✓ Verbindlich bestätigen“</b> steht das Match für beide Teams fest.</p>
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
                    tvInfo = `<div class="pcc-own-busy-warn">🚫 <b>Gesperrt:</b> ${ownCs.map((c) => `${esc(busyTeamNameOf(c))} spielt bereits (${pad2(c.otherHour)}:00–${pad2(c.otherHour + 1)}:30)`).join(', ')}</div>`;
                  } else if (cs.length) {
                    tvInfo = `<div class="pcc-conflict-warn">📺 <b>Parallelspiel (~1,5h):</b> ${cs.map((c) => `${esc(c.team_a_name)} vs. ${esc(c.team_b_name)} (${pad2(c.otherHour)}:00)`).join(', ')}</div>`;
                  } else if (otherConfirmed.length) {
                    tvInfo = `<span class="badge tv-free">📺 Frei für Stream</span>`;
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
                      <button type="button" class="btn btn-primary btn-sm pcc-confirm-btn" data-confirm-slot="${k}" ${ownCs.length ? 'disabled' : ''}>
                        ${ownCs.length ? '🚫 Nicht wählbar' : '✓ Verbindlich bestätigen'}
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
                  <h3 class="sched-title">Vorschlag von ${esc(propTeamName)} (${esc(m.proposed_by_player_name || '')}) gesendet</h3>
                  <p class="sched-sub">Sobald <b>${esc(waitTeamName)}</b> einen dieser Termine annimmt, steht das Spiel verbindlich fest:</p>
                  <div class="pmh-prop-list">${propSlots.map((k) => {
                    const i = info(k);
                    return `<span class="prop-chip prop-chip-lg"><b>${slotLabel(k)} Uhr</b> <small>(${i.cls === 'm-perfect' ? `${i.g}/${n} Grün` : `${i.g}✓ ${i.y}?`})</small>${conflictChipBadge(k)}</span>`;
                  }).join('')}</div>
                </div>
                ${myTeamId === m.proposed_by_team_id ? `<button type="button" class="btn btn-ghost btn-sm" id="edit-propose-btn">✎ Vorschlag ändern</button>` : ''}
              </div>
              ${adminBarHTML}
            </section>`;
        }
      } else {
        const perfectSelectable = perfect.filter((k) => ownConflictsFor(k).length === 0);
        const perfectBlocked = perfect.filter((k) => ownConflictsFor(k).length > 0);
        const maybeSelectable = maybe.filter((x) => ownConflictsFor(x.k).length === 0);
        const maybeBlocked = maybe.filter((x) => ownConflictsFor(x.k).length > 0);
        const blockedSlots = [
          ...perfectBlocked.map((k) => ({ k, label: slotLabel(k) })),
          ...maybeBlocked.map((x) => ({ k: x.k, label: `${slotLabel(x.k)} (${x.g}✓ ${x.y}?)` })),
        ];

        const hasSelectable = perfectSelectable.length > 0 || maybeSelectable.length > 0;
        const isCounter = propSlots.length > 0 && myTeamId !== m.proposed_by_team_id;
        const isEdit = propSlots.length > 0 && myTeamId === m.proposed_by_team_id;
        const selectedWithConflicts = [...selectedPropose]
          .map((k) => ({ k, cs: streamConflictsFor(k) }))
          .filter((x) => x.cs.length > 0);
        const hasSelectedMaybe = maybeSelectable.some((x) => selectedPropose.has(x.k));
        const maybeOpen = showMaybe || perfectSelectable.length === 0 || hasSelectedMaybe;

        schedBoxHTML = `
          <section class="sched-card propose metal">
            <div class="sched-top">
              <span class="sched-icon">🤝</span>
              <div class="sched-main">
                <span class="sched-kicker">Termin-Einigung · Alle ${n} Spieler bereit</span>
                <h3 class="sched-title">${isCounter ? `Gegenvorschlag an ${esc(propTeamName)} senden` : isEdit ? 'Terminvorschlag anpassen' : '1 bis 3 Spieltermine vorschlagen'}</h3>
                <p class="sched-sub">
                  ${mePlayer
                    ? 'Wähle bis zu <b>3 passende Termine</b> (per Klick hier oder unten im Kalender) und sende sie an das gegnerische Team.'
                    : 'Hier können die Teams 1 bis 3 Termine auswählen und sich verbindlich einigen.'}
                </p>
              </div>
            </div>
            ${!hasSelectable
              ? '<div class="notice warn">Aktuell gibt es keine freie Stunde ohne Rot. Bitte passt eure Zeiten im Kalender noch einmal an.</div>'
              : `
                ${perfectSelectable.length ? `
                  <div class="pick-group pick-box perfect-box">
                    <h4>🏆 Perfekte wählbare Termine (${perfectSelectable.length}× alle ${n} Grün):</h4>
                    <div class="pick-chips">
                      ${perfectSelectable.map((k) => {
                        const sel = selectedPropose.has(k);
                        const cs = streamConflictsFor(k);
                        const confCls = cs.length ? (cs.some((c) => c.exact) ? 'has-conflict exact' : 'has-conflict overlap') : '';
                        return `<button type="button" class="slot-pick perfect ${sel ? 'selected' : ''} ${confCls}" data-pick-slot="${k}" title="${esc(conflictTitle(k))}" ${!mePlayer ? 'disabled' : ''}>
                          <span class="sp-check">${sel ? '✓' : '+'}</span>
                          <span>${slotLabel(k)}</span>
                          ${conflictChipBadge(k)}
                        </button>`;
                      }).join('')}
                    </div>
                  </div>` : ''}
                ${maybeSelectable.length ? `
                  <div class="pick-group pick-box maybe-box">
                    ${perfectSelectable.length > 0 ? `
                      <button type="button" class="maybe-toggle-btn" id="toggle-maybe-btn">
                        <span>⚡ ${maybeSelectable.length} mögliche Ausweichtermine (kein Rot, mind. 1 Gelb)</span>
                        <span>${maybeOpen ? 'Ausblenden ▴' : 'Anzeigen ▾'}</span>
                      </button>
                    ` : `<h4>⚡ Mögliche wählbare Optionen (${maybeSelectable.length}× kein Rot, mind. 1 Gelb):</h4>`}
                    ${maybeOpen ? `
                      <div class="pick-chips">
                        ${maybeSelectable.slice(0, 24).map((x) => {
                          const sel = selectedPropose.has(x.k);
                          const cs = streamConflictsFor(x.k);
                          const confCls = cs.length ? (cs.some((c) => c.exact) ? 'has-conflict exact' : 'has-conflict overlap') : '';
                          return `<button type="button" class="slot-pick maybe ${sel ? 'selected' : ''} ${confCls}" data-pick-slot="${x.k}" title="${esc(conflictTitle(x.k))}" ${!mePlayer ? 'disabled' : ''}>
                            <span class="sp-check">${sel ? '✓' : '+'}</span>
                            <span>${slotLabel(x.k)} <small>(${x.g}✓ ${x.y}?)</small></span>
                            ${conflictChipBadge(x.k)}
                          </button>`;
                        }).join('')}
                      </div>` : ''}
                  </div>` : ''}
              `}
            ${blockedSlots.length ? `
              <div class="pick-group pick-box blocked-box">
                <div class="blocked-box-head">
                  <h4>🚫 Gesperrte Stunden – Eigenes Spiel / Gegner belegt (${blockedSlots.length}):</h4>
                  <small class="muted">Nicht wählbar, da ${esc(data.teamA.name)} oder ${esc(data.teamB.name)} dort bereits ein festes Spiel (±1 Std.) hat</small>
                </div>
                <div class="pick-chips">
                  ${blockedSlots.map((b) => `
                    <button type="button" class="slot-pick own-busy" disabled title="${esc(conflictTitle(b.k))}">
                      <span class="sp-check">🚫</span>
                      <span>${esc(b.label)}</span>
                      ${conflictChipBadge(b.k)}
                    </button>
                  `).join('')}
                </div>
              </div>` : ''}
            ${selectedWithConflicts.length ? `
              <div class="propose-conflict-alert">
                <span class="pca-icon">📺</span>
                <div class="pca-body">
                  <b>Hinweis – Parallelspiel anderer Teams (~1,5h Spielzeit):</b>
                  <ul>
                    ${selectedWithConflicts.map(({ k, cs }) => `
                      <li><b>${slotLabel(k)} Uhr:</b> ${cs.map((c) => `<b>${esc(c.team_a_name)} vs. ${esc(c.team_b_name)}</b> (${pad2(c.otherHour)}:00–${pad2(c.otherHour + 1)}:30)`).join(' · ')}</li>
                    `).join('')}
                  </ul>
                  <p>Trotzdem wählbar – falls möglich gerne auf einen freien Termin ausweichen, damit einzeln gestreamt werden kann.</p>
                </div>
              </div>` : ''}
            ${mePlayer && hasSelectable ? `
              <div class="propose-bar">
                <div class="pb-selected-info">
                  <b>Auswahl (${selectedPropose.size}/3):</b>
                  ${selectedPropose.size
                    ? [...selectedPropose].map((k) => `<span class="prop-chip">${slotLabel(k)}${conflictChipBadge(k)} <button type="button" class="rm-pick" data-pick-slot="${k}" title="Entfernen">✕</button></span>`).join('')
                    : '<span class="muted">Klicke oben oder im Kalender 1 bis 3 Termine an</span>'}
                </div>
                <div class="pb-btns">
                  ${proposeMode ? `<button type="button" class="btn btn-ghost btn-sm" id="cancel-propose-btn">Abbrechen</button>` : ''}
                  <button type="button" class="btn btn-primary btn-sm" id="submit-propose-btn" ${selectedPropose.size === 0 ? 'disabled' : ''}>
                    📩 ${selectedPropose.size ? `${selectedPropose.size} ${selectedPropose.size === 1 ? 'Termin' : 'Termine'} vorschlagen` : 'Vorschlag senden'}
                  </button>
                </div>
              </div>` : ''}
            ${adminBarHTML}
          </section>`;
      }

      const ownBusyList = otherConfirmed.filter((oc) => oc.is_own_team);
      const streamBusyList = otherConfirmed.filter((oc) => !oc.is_own_team);

      const ownBusyBoxHTML = ownBusyList.length ? `
        <section class="radar-drawer blocked-drawer metal">
          <div class="radar-static-head">
            <span class="radar-title">
              <span>🚫</span>
              <b>Gesperrte Termine (Eigene Spiele & Gegner):</b>
              <span>${ownBusyList.length} ${ownBusyList.length === 1 ? 'festes Spiel sperrt' : 'feste Spiele sperren'} jeweils ±1 Std. (~1,5h Spielzeit)</span>
            </span>
            <span class="badge danger sm">🔒 Nicht wählbar</span>
          </div>
          <div class="radar-body">
            <div class="omb-list">
              ${ownBusyList.map((oc) => {
                const [, ohStr] = oc.confirmed_slot.split('|');
                const oh = Number(ohStr);
                const bName = busyTeamNameOf(oc);
                return `<div class="omb-chip own-busy">
                  <span class="omb-time">🚫 ${slotLabel(oc.confirmed_slot)} <small>(gesperrt ${pad2(Math.max(0, oh - 1))}:00–${pad2(oh + 2)}:00)</small></span>
                  <span class="omb-teams">${teamLogoHTML(oc.team_a_logo, oc.team_a_name, 'xs')}<span>${esc(oc.team_a_name)}</span> <i>vs.</i> ${teamLogoHTML(oc.team_b_logo, oc.team_b_name, 'xs')}<span>${esc(oc.team_b_name)}</span></span>
                  <span class="badge danger sm">🚫 ${esc(bName)}</span>
                </div>`;
              }).join('')}
            </div>
          </div>
        </section>` : '';

      const streamRadarBoxHTML = streamBusyList.length ? `
        <section class="radar-drawer stream-drawer metal">
          <button type="button" class="radar-toggle" id="toggle-radar-btn">
            <span class="radar-title">
              <span>📺</span>
              <b>Stream- & Parallelspiel-Radar (Andere Teams):</b>
              <span>${streamBusyList.length} ${streamBusyList.length === 1 ? 'fremdes Spiel' : 'fremde Spiele'} in dieser Woche</span>
            </span>
            <span class="muted small">${showRadar ? 'Ausblenden ▴' : 'Anzeigen ▾'}</span>
          </button>
          ${showRadar ? `
            <div class="radar-body">
              <small class="muted">Spiele anderer Teams (~1,5h Spielzeit) sind <b>nicht gesperrt</b> – falls möglich gerne ausweichen, damit einzeln gestreamt werden kann:</small>
              <div class="omb-list">
                ${streamBusyList.map((oc) => {
                  const [, ohStr] = oc.confirmed_slot.split('|');
                  const oh = Number(ohStr);
                  return `<div class="omb-chip">
                    <span class="omb-time">📺 ${slotLabel(oc.confirmed_slot)} <small>(bis ~${pad2(oh + 1)}:30)</small></span>
                    <span class="omb-teams">${teamLogoHTML(oc.team_a_logo, oc.team_a_name, 'xs')}<span>${esc(oc.team_a_name)}</span> <i>vs.</i> ${teamLogoHTML(oc.team_b_logo, oc.team_b_name, 'xs')}<span>${esc(oc.team_b_name)}</span></span>
                  </div>`;
                }).join('')}
              </div>
            </div>` : ''}
        </section>` : '';

      const otherMatchesHTML = `${ownBusyBoxHTML}${streamRadarBoxHTML}`;

      body.innerHTML = `
        ${prefix}
        <section class="mc-cockpit metal">
          ${teamColumn(data.teamA, 'a')}
          <div class="mc-center">
            <div class="mc-vs-badge">VS</div>
            <div class="mc-QuickStats">
              <span class="mc-stat perfect" title="Alle ${n} Spieler haben Grün">🏆 <b>${perfect.length}</b> Perfekt</span>
              <span class="mc-stat maybe" title="Kein Spieler Rot, mindestens 1 Gelb">⚡ <b>${maybe.length}</b> Möglich</span>
            </div>
          </div>
          ${teamColumn(data.teamB, 'b')}
        </section>
        ${short.length ? `<div class="notice warn">⚠ ${short.map((t) => esc(t.name)).join(', ')} ${short.length === 1 ? 'hat' : 'haben'} noch keine 3 Spieler.</div>` : ''}
        ${schedBoxHTML}
        ${otherMatchesHTML}
        <div class="cal-toolbar">
          ${legend('match')}
          <div class="tool-actions"><span class="muted small" id="refresh-info"></span><button class="btn btn-ghost btn-sm" id="refresh-btn">⟳ Aktualisieren</button></div>
        </div>
        <div id="match-grid"></div>`;

      body.querySelector('#toggle-maybe-btn')?.addEventListener('click', () => {
        showMaybe = !showMaybe;
        render();
      });
      body.querySelector('#toggle-radar-btn')?.addEventListener('click', () => {
        showRadar = !showRadar;
        render();
      });

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
            <div><h5>${teamLogoHTML(data.teamA.logo, data.teamA.name, 'xs')}<span>${esc(data.teamA.name)}</span></h5><ul>${data.teamA.players.map(row).join('')}</ul></div>
            <div><h5>${teamLogoHTML(data.teamB.logo, data.teamB.name, 'xs')}<span>${esc(data.teamB.name)}</span></h5><ul>${data.teamB.players.map(row).join('')}</ul></div>
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
        <div id="admin-search-host"></div>
        <nav class="tabs big">${tabs.map(([id, label]) => `<a class="tab ${id === activeTab ? 'active' : ''}" href="#/admin/${id}">${label}</a>`).join('')}</nav>
        <div id="admin-body"><div class="loading"><div class="spinner"></div></div></div>
      </main>`;
    document.getElementById('admin-logout').addEventListener('click', () => { sessionStorage.removeItem(SS_ADMIN); go('#/'); });
    const body = document.getElementById('admin-body');
    const searchHost = document.getElementById('admin-search-host');

    const loadCurrentTab = async () => {
      if (tab === 'teams') await adminTeams(body);
      else if (tab === 'matchups') await adminMatchups(body);
      else if (tab === 'insight') await adminInsight(body);
      else if (tab === 'match') await adminMatch(body, rest[0]);
      else go('#/admin/teams');
    };

    await mountAdminSearch(searchHost, loadCurrentTab);
    await loadCurrentTab();
  }

  // ---------- Admin-Freitextsuche (Teams & Spieler mit Vorschlägen & Detail-Dossier) ----------
  function highlightText(text, query) {
    const s = String(text ?? '');
    const q = String(query ?? '').trim();
    if (!q) return esc(s);
    const idx = s.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1) return esc(s);
    return `${esc(s.slice(0, idx))}<mark class="as-hl">${esc(s.slice(idx, idx + q.length))}</mark>${esc(s.slice(idx + q.length))}`;
  }

  async function mountAdminSearch(host, onDataMutated) {
    if (!host) return;
    let teams = [];
    let players = [];
    let matchups = [];
    let savedSet = new Set();
    let activeIdx = -1;
    let currentSuggestions = [];
    let calReqId = 0;

    const loadSearchData = async () => {
      const [t, p, m, st] = await Promise.all([
        api('/teams'),
        api('/players'),
        api('/matchups'),
        api('/admin/save-status'),
      ]);
      teams = t;
      players = p;
      matchups = m;
      savedSet = new Set(st.map((s) => `${s.player_id}|${s.phase_id}`));
    };

    await loadSearchData();

    host.innerHTML = `
      <section class="admin-search-section metal" aria-label="Team- und Spielersuche">
        <div class="as-bar">
          <div class="as-input-wrap">
            <span class="as-icon" aria-hidden="true">🔍</span>
            <input
              type="search"
              id="admin-omni-input"
              class="as-input"
              placeholder="Team oder Spieler suchen (z. B. Foxhunters, Mo, Ballgefühl …) – Vorschlag anklicken für Komplett-Übersicht"
              autocomplete="off"
              spellcheck="false"
            >
            <button type="button" class="as-clear-btn" id="admin-omni-clear" hidden title="Eingabe löschen">✕</button>
          </div>
          <div class="as-dropdown" id="admin-omni-dropdown" hidden role="listbox"></div>
        </div>
        <div id="admin-dossier-wrap"></div>
      </section>`;

    const input = host.querySelector('#admin-omni-input');
    const clearBtn = host.querySelector('#admin-omni-clear');
    const dropdown = host.querySelector('#admin-omni-dropdown');
    const dossierWrap = host.querySelector('#admin-dossier-wrap');

    const closeDropdown = () => {
      dropdown.hidden = true;
      dropdown.innerHTML = '';
      activeIdx = -1;
      currentSuggestions = [];
    };

    const selectTarget = async (target, { scroll = true } = {}) => {
      S.adminSearchTarget = target;
      closeDropdown();
      await loadSearchData();
      await renderDossier();
      if (scroll && dossierWrap.firstElementChild) {
        dossierWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    };

    const updateSuggestions = () => {
      const q = input.value.trim();
      clearBtn.hidden = !q && !S.adminSearchTarget;
      if (q.length < 1) {
        closeDropdown();
        return;
      }
      const ql = q.toLowerCase();

      // Teams filtern (Name trifft zu ODER ein Spieler im Team trifft zu)
      const matchedTeams = teams
        .filter((t) => t.name.toLowerCase().includes(ql) || t.players.some((p) => p.name.toLowerCase().includes(ql)))
        .sort((a, b) => {
          const aStarts = a.name.toLowerCase().startsWith(ql) ? 0 : 1;
          const bStarts = b.name.toLowerCase().startsWith(ql) ? 0 : 1;
          return aStarts - bStarts || a.name.localeCompare(b.name, 'de');
        })
        .slice(0, 8);

      // Spieler filtern (Spielername trifft zu ODER Teamname trifft zu)
      const matchedPlayers = players
        .filter((p) => p.name.toLowerCase().includes(ql) || (p.team_name || '').toLowerCase().includes(ql))
        .sort((a, b) => {
          const aNameMatch = a.name.toLowerCase().includes(ql) ? 0 : 1;
          const bNameMatch = b.name.toLowerCase().includes(ql) ? 0 : 1;
          const aStarts = a.name.toLowerCase().startsWith(ql) ? 0 : 1;
          const bStarts = b.name.toLowerCase().startsWith(ql) ? 0 : 1;
          return aNameMatch - bNameMatch || aStarts - bStarts || a.name.localeCompare(b.name, 'de');
        })
        .slice(0, 10);

      currentSuggestions = [
        ...matchedTeams.map((t) => ({ type: 'team', id: t.id, item: t })),
        ...matchedPlayers.map((p) => ({ type: 'player', id: p.id, item: p })),
      ];
      activeIdx = currentSuggestions.length ? 0 : -1;

      if (!currentSuggestions.length) {
        dropdown.innerHTML = `<div class="as-empty">Kein Team oder Spieler für „<b>${esc(q)}</b>“ gefunden.</div>`;
        dropdown.hidden = false;
        return;
      }

      let idxCounter = 0;
      const renderTeamSug = (t) => {
        const myIdx = idxCounter++;
        const tMatches = matchups.filter((m) => m.team_a_id === t.id || m.team_b_id === t.id);
        const confCnt = tMatches.filter((m) => m.confirmed_slot).length;
        const pNames = t.players.map((p) => highlightText(p.name, q)).join(', ') || '<span class="muted">keine Spieler</span>';
        return `
          <button type="button" class="as-item ${myIdx === activeIdx ? 'is-active' : ''}" data-sug-idx="${myIdx}" role="option">
            <div class="as-item-main">
              ${teamLogoHTML(t.logo, t.name, 'sm')}
              <div class="as-item-txt">
                <div class="as-item-title">
                  <span class="as-type-tag team">🛡️ Team</span>
                  <b>${highlightText(t.name, q)}</b>
                  <span class="badge ${t.players.length === 3 ? 'ok' : 'warn'} sm">${t.players.length}/3 Spieler</span>
                  ${tMatches.length ? `<span class="badge vs sm">⚔ ${tMatches.length} Spiele (${confCnt} fest)</span>` : ''}
                </div>
                <small class="as-item-sub">Kader: ${pNames}</small>
              </div>
            </div>
            <span class="as-open-hint">Team-Übersicht öffnen ›</span>
          </button>`;
      };

      const renderPlayerSug = (p) => {
        const myIdx = idxCounter++;
        const savedCnt = PHASES.filter((ph) => savedSet.has(`${p.id}|${ph.id}`)).length;
        return `
          <button type="button" class="as-item ${myIdx === activeIdx ? 'is-active' : ''}" data-sug-idx="${myIdx}" role="option">
            <div class="as-item-main">
              ${p.team_name ? teamLogoHTML(p.team_logo, p.team_name, 'sm') : `<span class="avatar sm">${esc(p.name.slice(0, 1).toUpperCase())}</span>`}
              <div class="as-item-txt">
                <div class="as-item-title">
                  <span class="as-type-tag player">👤 Spieler</span>
                  <b>${highlightText(p.name, q)}</b>
                  <span class="badge ${savedCnt === PHASES.length ? 'ok' : savedCnt > 0 ? 'warn' : 'open'} sm">🗓 ${savedCnt}/${PHASES.length} Phasen</span>
                </div>
                <small class="as-item-sub">Team: ${p.team_name ? highlightText(p.team_name, q) : '<em>Ohne Team</em>'}</small>
              </div>
            </div>
            <span class="as-open-hint">Spieler-Übersicht öffnen ›</span>
          </button>`;
      };

      dropdown.innerHTML = `
        ${matchedTeams.length ? `<div class="as-group-label">🛡️ Teams (${matchedTeams.length}) – anklicken für Team-Dossier</div>${matchedTeams.map(renderTeamSug).join('')}` : ''}
        ${matchedPlayers.length ? `<div class="as-group-label">👤 Spieler (${matchedPlayers.length}) – anklicken für Spieler-Dossier</div>${matchedPlayers.map(renderPlayerSug).join('')}` : ''}
      `;
      dropdown.hidden = false;

      dropdown.querySelectorAll('[data-sug-idx]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const chosen = currentSuggestions[Number(btn.dataset.sugIdx)];
          if (chosen) {
            input.value = chosen.item.name;
            clearBtn.hidden = false;
            selectTarget({ type: chosen.type, id: chosen.id });
          }
        });
      });
    };

    const syncActiveItemUI = () => {
      dropdown.querySelectorAll('[data-sug-idx]').forEach((btn) => {
        const isAct = Number(btn.dataset.sugIdx) === activeIdx;
        btn.classList.toggle('is-active', isAct);
        if (isAct) btn.scrollIntoView({ block: 'nearest' });
      });
    };

    input.addEventListener('input', () => {
      const val = input.value.trim();
      if (!val) {
        closeDropdown();
        return;
      }
      // Sofort ab dem 1. getippten Buchstaben Vorschläge zeigen (oder Fokus)
      updateSuggestions();
    });

    input.addEventListener('focus', () => {
      if (input.value.trim().length >= 1) updateSuggestions();
    });

    input.addEventListener('keydown', (e) => {
      if (dropdown.hidden || !currentSuggestions.length) {
        if (e.key === 'Escape') closeDropdown();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = (activeIdx + 1) % currentSuggestions.length;
        syncActiveItemUI();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = (activeIdx - 1 + currentSuggestions.length) % currentSuggestions.length;
        syncActiveItemUI();
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0 && currentSuggestions[activeIdx]) {
          e.preventDefault();
          const chosen = currentSuggestions[activeIdx];
          input.value = chosen.item.name;
          clearBtn.hidden = false;
          selectTarget({ type: chosen.type, id: chosen.id });
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeDropdown();
      }
    });

    clearBtn.addEventListener('click', () => {
      input.value = '';
      S.adminSearchTarget = null;
      clearBtn.hidden = true;
      closeDropdown();
      dossierWrap.innerHTML = '';
      input.focus();
    });

    const onDocClick = (e) => {
      if (!e.target.closest('.as-bar')) closeDropdown();
    };
    document.addEventListener('click', onDocClick);
    onCleanup(() => document.removeEventListener('click', onDocClick));

    // ---------- Hilfsfunktion: Matchup-Analyse für Team oder Spieler ----------
    const analyzeMatchup = (m, perspectiveTeamId) => {
      const ph = getPhase(m.phase_id);
      const isA = m.team_a_id === perspectiveTeamId;
      const ownTeamId = isA ? m.team_a_id : m.team_b_id;
      const oppTeamId = isA ? m.team_b_id : m.team_a_id;
      const ownTeamObj = teams.find((t) => t.id === ownTeamId);
      const oppTeamObj = teams.find((t) => t.id === oppTeamId);
      const ownPlayers = ownTeamObj ? ownTeamObj.players : [];
      const oppPlayers = oppTeamObj ? oppTeamObj.players : [];
      const all6 = [...ownPlayers, ...oppPlayers];
      const saved6 = all6.filter((p) => savedSet.has(`${p.id}|${m.phase_id}`));
      const missingOwn = ownPlayers.filter((p) => !savedSet.has(`${p.id}|${m.phase_id}`));
      const missingOpp = oppPlayers.filter((p) => !savedSet.has(`${p.id}|${m.phase_id}`));
      const propSlots = Array.isArray(m.proposed_slots) ? m.proposed_slots : [];

      let category = 'waiting_times';
      let prio = 3;
      if (m.confirmed_slot) {
        category = 'confirmed';
        prio = 4;
      } else if (propSlots.length > 0) {
        category = m.proposed_by_team_id === ownTeamId ? 'proposed_by_us' : 'proposed_by_opp';
        prio = m.proposed_by_team_id === ownTeamId ? 2 : 1;
      } else if (all6.length > 0 && saved6.length === all6.length) {
        category = 'ready';
        prio = 2;
      }

      return {
        m,
        ph,
        ownTeamId,
        oppTeamId,
        ownName: isA ? m.team_a_name : m.team_b_name,
        ownLogo: isA ? m.team_a_logo : m.team_b_logo,
        oppName: isA ? m.team_b_name : m.team_a_name,
        oppLogo: isA ? m.team_b_logo : m.team_a_logo,
        ownPlayers,
        oppPlayers,
        all6,
        saved6,
        missingOwn,
        missingOpp,
        propSlots,
        category,
        prio,
      };
    };

    const renderMatchCardHTML = (info, highlightPlayerId = null) => {
      const { m, ph, ownTeamId, oppTeamId, ownName, ownLogo, oppName, oppLogo, all6, saved6, missingOwn, missingOpp, propSlots, category } = info;
      const propByOwn = m.proposed_by_team_id === ownTeamId;
      const propTeamName = m.proposed_by_team_id === m.team_a_id ? m.team_a_name : m.team_b_name;
      const waitingTeamName = m.proposed_by_team_id === m.team_a_id ? m.team_b_name : m.team_a_name;

      let statusHTML = '';
      if (category === 'confirmed') {
        statusHTML = `
          <div class="ad-m-status">
            <div class="ad-m-top">
              <span class="badge ok">🏆 Fest terminiert</span>
              <strong class="ad-m-slot">${slotLabel(m.confirmed_slot)} Uhr</strong>
            </div>
            <small class="muted">Verbindlich bestätigt${m.confirmed_by_player_name ? ` von <b>${esc(m.confirmed_by_player_name)}</b>` : ''}</small>
          </div>`;
      } else if (category === 'proposed_by_opp' || category === 'proposed_by_us') {
        statusHTML = `
          <div class="ad-m-status">
            <div class="ad-m-top">
              <span class="badge warn">📩 ${propSlots.length} Terminvorschläge offen</span>
              <small class="muted">Vorschlag von <b>${esc(m.proposed_by_player_name || propTeamName)}</b> (${esc(propTeamName)}) → <b>wartet auf ${esc(waitingTeamName)}</b></small>
            </div>
            <div class="m-row-chips">${propSlots.map((s) => `<span class="prop-chip">${slotLabel(s)} Uhr</span>`).join('')}</div>
          </div>`;
      } else if (category === 'ready') {
        statusHTML = `
          <div class="ad-m-status">
            <div class="ad-m-top">
              <span class="badge ready-badge">🤝 Alle ${saved6.length}/${all6.length} Spieler haben Zeiten eingetragen</span>
            </div>
            <small class="muted">Beide Teams sind vollständig eingetragen – Terminvorschlag kann jederzeit gesendet werden.</small>
          </div>`;
      } else {
        const missOwnLinks = missingOwn.map((p) => `<button type="button" class="ad-inline-link ${p.id === highlightPlayerId ? 'is-me-warn' : ''}" data-ad-open-player="${p.id}" data-ad-phase="${ph?.id || ''}">👤 ${esc(p.name)}</button>`).join(', ');
        const missOppLinks = missingOpp.map((p) => `<button type="button" class="ad-inline-link" data-ad-open-player="${p.id}" data-ad-phase="${ph?.id || ''}">👤 ${esc(p.name)}</button>`).join(', ');
        statusHTML = `
          <div class="ad-m-status">
            <div class="ad-m-top">
              <span class="badge open">⏳ Wartet auf Zeiten (${saved6.length}/${all6.length} Spieler eingetragen)</span>
            </div>
            <div class="ad-missing-box">
              ${missingOwn.length ? `<div><span class="t-yellow">Es fehlen (${esc(ownName)}):</span> ${missOwnLinks}</div>` : `<div class="t-green">✓ ${esc(ownName)} komplett (3/3)</div>`}
              ${missingOpp.length ? `<div><span class="muted">Es fehlen (${esc(oppName)}):</span> ${missOppLinks}</div>` : `<div class="t-green">✓ ${esc(oppName)} komplett (3/3)</div>`}
            </div>
          </div>`;
      }

      let playerPersonalTag = '';
      if (highlightPlayerId && ph) {
        const pSaved = savedSet.has(`${highlightPlayerId}|${ph.id}`);
        playerPersonalTag = pSaved
          ? `<span class="badge ok sm">✓ Spieler-Zeiten für ${esc(ph.short)} gespeichert</span>`
          : `<span class="badge warn sm">⚠ Spieler hat für ${esc(ph.short)} noch KEINE Zeiten gespeichert!</span>`;
      }

      return `
        <article class="ad-match-card c-${ph?.color || 'group'} ${category === 'confirmed' ? 'is-conf' : category === 'proposed_by_opp' ? 'is-inc' : ''}">
          <div class="ad-m-left">
            <div class="m-row-phase">
              <i class="dot"></i>
              <span>Woche ${ph?.week || '?'} · ${esc(ph?.name || m.phase_id)}${ph?.subtitle ? ` (${esc(ph.subtitle)})` : ''}</span>
              ${ph ? `<small>${formatRange(ph)}</small>` : ''}
            </div>
            <div class="ad-m-teams">
              <span class="m-team-entry m-team-mine">${teamLogoHTML(ownLogo, ownName, 'sm')}<span>${esc(ownName)}</span></span>
              <span class="m-vs">vs.</span>
              <button type="button" class="ad-opp-btn" data-ad-open-team="${oppTeamId}" title="Zur Team-Übersicht von ${esc(oppName)} wechseln">
                ${teamLogoHTML(oppLogo, oppName, 'sm')}
                <span>${esc(oppName)}</span>
                <small>🔍</small>
              </button>
            </div>
            ${playerPersonalTag ? `<div class="ad-p-personal">${playerPersonalTag}</div>` : ''}
          </div>
          <div class="ad-m-center">
            ${statusHTML}
          </div>
          <div class="ad-m-right">
            <a class="btn btn-sm btn-blue" href="#/admin/match/${m.id}">📊 6-Spieler-Abgleich & Termin</a>
            ${m.confirmed_slot || propSlots.length
              ? `<button type="button" class="btn btn-xs btn-steel" data-ad-reset-match="${m.id}" data-ad-match-label="${esc(ownName)} vs. ${esc(oppName)}">🔓 Termin-Einigung zurücksetzen</button>`
              : ''}
          </div>
        </article>`;
    };

    // ---------- Dossier Rendern (Team oder Spieler) ----------
    const renderDossier = async () => {
      const target = S.adminSearchTarget;
      clearBtn.hidden = !input.value.trim() && !target;
      if (!target) {
        dossierWrap.innerHTML = '';
        return;
      }

      if (target.type === 'team') {
        const team = teams.find((t) => String(t.id) === String(target.id));
        if (!team) {
          S.adminSearchTarget = null;
          dossierWrap.innerHTML = '';
          return;
        }
        const teamMatchups = matchups
          .filter((m) => m.team_a_id === team.id || m.team_b_id === team.id)
          .map((m) => analyzeMatchup(m, team.id))
          .sort((a, b) => a.prio - b.prio || (a.ph?.week || 0) - (b.ph?.week || 0));

        const confCnt = teamMatchups.filter((x) => x.category === 'confirmed').length;
        const propCnt = teamMatchups.filter((x) => x.category === 'proposed_by_opp' || x.category === 'proposed_by_us').length;
        const openCnt = teamMatchups.length - confCnt;
        const totalPossiblePhases = team.players.length * PHASES.length;
        const totalSavedPhases = team.players.reduce(
          (acc, p) => acc + PHASES.filter((ph) => savedSet.has(`${p.id}|${ph.id}`)).length,
          0
        );
        const activePhaseIds = new Set(teamMatchups.map((x) => x.m.phase_id));

        dossierWrap.innerHTML = `
          <div class="admin-dossier card metal">
            <header class="ad-head">
              <div class="ad-head-main">
                <button type="button" class="team-logo-trigger" data-ad-act="logo-team" title="Team-Logo ändern">
                  ${teamLogoHTML(team.logo, team.name, 'lg')}
                  <span class="tlt-badge">🖼</span>
                </button>
                <div class="ad-head-titles">
                  <div class="ad-overline">🛡️ TEAM-DOSSIER & KOMPLETT-ÜBERSICHT</div>
                  <h2>${esc(team.name)}</h2>
                  <div class="ad-kpis">
                    <span class="badge ${team.players.length === 3 ? 'ok' : 'warn'}">👥 ${team.players.length}/3 Spieler</span>
                    <span class="badge vs">⚔ ${teamMatchups.length} Paarungen</span>
                    <span class="badge ${confCnt ? 'ok' : 'open'}">🏆 ${confCnt} fest terminiert</span>
                    ${propCnt ? `<span class="badge warn">📩 ${propCnt} Vorschlag aktiv</span>` : ''}
                    ${openCnt ? `<span class="badge open">⏳ ${openCnt} noch offen</span>` : ''}
                    <span class="badge ${totalSavedPhases === totalPossiblePhases && totalPossiblePhases > 0 ? 'ok' : 'vs'}">🗓 ${totalSavedPhases}/${totalPossiblePhases} Team-Phasen eingetragen</span>
                  </div>
                </div>
              </div>
              <div class="ad-head-actions">
                <button type="button" class="btn btn-sm btn-blue" data-ad-act="logo-team">🖼 Logo ändern</button>
                <button type="button" class="btn btn-sm btn-steel" data-ad-act="rename-team">✎ Umbenennen</button>
                <button type="button" class="btn btn-sm btn-ghost" data-ad-act="close">✕ Übersicht schließen</button>
              </div>
            </header>

            <section class="ad-sec">
              <div class="ad-sec-head">
                <h3>👥 Team-Kader & Eingetragene Phasen pro Spieler (${team.players.length}/3)</h3>
                <span class="muted small">Klicke auf einen Spieler oder eine Phase, um seinen persönlichen Verfügbarkeits-Kalender zu öffnen</span>
              </div>
              ${team.players.length ? `
                <div class="ad-roster-grid">
                  ${team.players.map((p) => {
                    const pSavedCnt = PHASES.filter((ph) => savedSet.has(`${p.id}|${ph.id}`)).length;
                    return `
                      <div class="ad-player-card">
                        <div class="ad-pc-top">
                          <div>
                            <strong class="ad-pc-name">👤 ${esc(p.name)}</strong>
                            <small class="muted">Spieler in ${esc(team.name)}</small>
                          </div>
                          <span class="badge ${pSavedCnt === PHASES.length ? 'ok' : pSavedCnt > 0 ? 'warn' : 'open'} sm">${pSavedCnt}/${PHASES.length} Phasen</span>
                        </div>
                        <div class="ad-pc-phases">
                          ${PHASES.map((ph) => {
                            const hasSaved = savedSet.has(`${p.id}|${ph.id}`);
                            const hasMatch = activePhaseIds.has(ph.id);
                            return `
                              <button
                                type="button"
                                class="ad-ph-pill ${hasSaved ? 'is-ok' : hasMatch ? 'is-warn' : 'is-open'}"
                                data-ad-open-player="${p.id}"
                                data-ad-phase="${ph.id}"
                                title="${esc(p.name)} · ${esc(ph.name)}: ${hasSaved ? 'Gespeichert (Klicken für Kalender)' : 'Noch nicht eingetragen'}"
                              >
                                <span>${esc(ph.short)}</span>
                                <b>${hasSaved ? '✓' : hasMatch ? '!' : '·'}</b>
                              </button>`;
                          }).join('')}
                        </div>
                        <div class="ad-pc-foot">
                          <button type="button" class="btn btn-xs btn-blue btn-block" data-ad-open-player="${p.id}">
                            🔍 Spieler-Dossier & Zeiten von ${esc(p.name)} öffnen ›
                          </button>
                        </div>
                      </div>`;
                  }).join('')}
                </div>` : '<div class="notice warn">Diesem Team sind aktuell noch keine Spieler zugewiesen.</div>'}
            </section>

            <section class="ad-sec">
              <div class="ad-sec-head">
                <h3>⚔ Alle Paarungen, Gegner & Termin-Status (${teamMatchups.length})</h3>
                <span class="muted small">Direkter Überblick über vereinbarte Zeiten, offene Vorschläge und fehlende Spieler-Eintragungen</span>
              </div>
              ${teamMatchups.length
                ? `<div class="ad-match-list">${teamMatchups.map((info) => renderMatchCardHTML(info)).join('')}</div>`
                : `<div class="notice">Für <b>${esc(team.name)}</b> sind aktuell noch keine Paarungen angelegt.</div>`}
            </section>
          </div>`;

        bindDossierEvents({ team });
        return;
      }

      if (target.type === 'player') {
        const player = players.find((p) => String(p.id) === String(target.id));
        if (!player) {
          S.adminSearchTarget = null;
          dossierWrap.innerHTML = '';
          return;
        }
        const team = teams.find((t) => t.id === player.team_id) || null;
        const mates = team ? team.players.filter((x) => x.id !== player.id) : [];
        const savedPhases = PHASES.filter((ph) => savedSet.has(`${player.id}|${ph.id}`));
        const playerMatchups = team
          ? matchups
              .filter((m) => m.team_a_id === team.id || m.team_b_id === team.id)
              .map((m) => analyzeMatchup(m, team.id))
              .sort((a, b) => a.prio - b.prio || (a.ph?.week || 0) - (b.ph?.week || 0))
          : [];
        const activePhaseIds = new Set(playerMatchups.map((x) => x.m.phase_id));
        const missingMatchPhases = playerMatchups.filter((x) => x.category !== 'confirmed' && !savedSet.has(`${player.id}|${x.m.phase_id}`));

        const chosenPhaseId = target.phaseId
          || (PHASES.find((ph) => activePhaseIds.has(ph.id) && savedSet.has(`${player.id}|${ph.id}`))?.id)
          || savedPhases[0]?.id
          || PHASES[0].id;
        const activePhase = getPhase(chosenPhaseId) || PHASES[0];

        dossierWrap.innerHTML = `
          <div class="admin-dossier card metal">
            <header class="ad-head">
              <div class="ad-head-main">
                ${team ? teamLogoHTML(team.logo, team.name, 'lg') : `<span class="avatar" style="width:52px;height:52px;font-size:1.3rem">${esc(player.name.slice(0, 1).toUpperCase())}</span>`}
                <div class="ad-head-titles">
                  <div class="ad-overline">👤 SPIELER-DOSSIER & ZEITPLAN-EINSICHT</div>
                  <h2>${esc(player.name)}</h2>
                  <div class="ad-kpis">
                    ${team
                      ? `<button type="button" class="ad-team-chip" data-ad-open-team="${team.id}" title="Zur Team-Übersicht von ${esc(team.name)} wechseln">
                          ${teamLogoHTML(team.logo, team.name, 'xs')}
                          <span>Team: <b>${esc(team.name)}</b> (Team öffnen ›)</span>
                        </button>`
                      : '<span class="badge warn">Ohne Team</span>'}
                    <span class="badge ${savedPhases.length === PHASES.length ? 'ok' : savedPhases.length > 0 ? 'warn' : 'open'}">🗓 ${savedPhases.length}/${PHASES.length} Phasen gespeichert</span>
                    <span class="badge vs">⚔ ${playerMatchups.length} Team-Spiele</span>
                    ${missingMatchPhases.length
                      ? `<span class="badge warn">⚠ Bei ${missingMatchPhases.length} offenem Spiel fehlen noch Zeiten von ${esc(player.name)}</span>`
                      : playerMatchups.length
                        ? `<span class="badge ok">✓ Alle Match-Phasen eingetragen</span>`
                        : ''}
                  </div>
                  ${mates.length ? `
                    <div class="ad-mates-row">
                      <span class="muted small">Mitspieler in ${esc(team.name)}:</span>
                      ${mates.map((m) => {
                        const mSaved = PHASES.filter((ph) => savedSet.has(`${m.id}|${ph.id}`)).length;
                        return `<button type="button" class="ad-mate-btn" data-ad-open-player="${m.id}">👤 ${esc(m.name)} <small>(${mSaved}/${PHASES.length})</small></button>`;
                      }).join('')}
                    </div>` : ''}
                </div>
              </div>
              <div class="ad-head-actions">
                ${team ? `<button type="button" class="btn btn-sm btn-blue" data-ad-open-team="${team.id}">🛡️ Zum Team „${esc(team.name)}“</button>` : ''}
                <button type="button" class="btn btn-sm btn-steel" data-ad-act="rename-player">✎ Umbenennen</button>
                <button type="button" class="btn btn-sm btn-ghost" data-ad-act="close">✕ Übersicht schließen</button>
              </div>
            </header>

            <section class="ad-sec">
              <div class="ad-sec-head">
                <h3>⚔ Spiele & Abstimmungs-Status für ${esc(player.name)} (${playerMatchups.length})</h3>
                <span class="muted small">Zeigt für jedes Team-Spiel sofort, ob ${esc(player.name)} seine Zeiten bereits eingetragen hat und wie der Termin-Stand ist</span>
              </div>
              ${playerMatchups.length
                ? `<div class="ad-match-list">${playerMatchups.map((info) => renderMatchCardHTML(info, player.id)).join('')}</div>`
                : `<div class="notice">Für ${team ? `das Team <b>${esc(team.name)}</b>` : `<b>${esc(player.name)}</b>`} sind aktuell noch keine Paarungen angesetzt.</div>`}
            </section>

            <section class="ad-sec">
              <div class="ad-sec-head">
                <h3>🗓 Eingetragene Verfügbarkeiten von ${esc(player.name)} (${savedPhases.length}/${PHASES.length} Phasen)</h3>
                <span class="muted small">Wähle eine Turnierphase, um den kompletten Stunden-Kalender von ${esc(player.name)} einzusehen</span>
              </div>
              <div class="phase-chips">
                ${PHASES.map((ph) => {
                  const isSaved = savedSet.has(`${player.id}|${ph.id}`);
                  const hasMatch = activePhaseIds.has(ph.id);
                  return `
                    <button type="button" class="chip c-${ph.color} ${ph.id === activePhase.id ? 'active' : ''}" data-ad-cal-phase="${ph.id}">
                      <i class="dot"></i>
                      <span>W${ph.week} · ${esc(ph.short)}</span>
                      ${hasMatch ? '<span title="Team hat ein Spiel in dieser Phase">⚔</span>' : ''}
                      ${isSaved ? '<span class="ok-mark">✓</span>' : '<small class="muted">(offen)</small>'}
                    </button>`;
                }).join('')}
              </div>
              <div id="ad-player-cal-box"><div class="loading"><div class="spinner"></div></div></div>
            </section>
          </div>`;

        bindDossierEvents({ player, team });

        // Kalender für activePhase laden
        const myReq = ++calReqId;
        const calBox = dossierWrap.querySelector('#ad-player-cal-box');
        try {
          const data = await api(`/players/${player.id}/availability/${activePhase.id}`);
          if (myReq !== calReqId || !calBox) return;
          const cells = new Map(data.cells.map((c) => [key(c.date, c.hour), c.status]));
          const cnt = { green: 0, yellow: 0, red: 0 };
          if (data.saved) data.cells.forEach((x) => cnt[x.status]++);
          calBox.innerHTML = `
            <div class="cal-toolbar" style="margin-top:10px">
              ${legend('edit')}
              ${data.saved
                ? `<div class="save-state"><span class="cnt g">${cnt.green} grün</span><span class="cnt y">${cnt.yellow} gelb</span><span class="cnt r">${cnt.red} rot</span></div>`
                : ''}
            </div>
            ${data.saved
              ? ''
              : `<div class="notice warn" style="margin-bottom:10px"><b>${esc(player.name)}</b> hat für „${esc(activePhase.name)}${activePhase.subtitle ? ' – ' + esc(activePhase.subtitle) : ''}“ (${formatRange(activePhase)}) noch keine Zeiten gespeichert.</div>`}
            <div class="ro-grid ${data.saved ? '' : 'unsaved'}"></div>`;
          mountReadonlyGrid(calBox.querySelector('.ro-grid'), activePhase, cells);
        } catch (err) {
          if (calBox) calBox.innerHTML = `<div class="notice warn">${esc(err.message)}</div>`;
        }
      }
    };

    const bindDossierEvents = ({ team = null, player = null }) => {
      dossierWrap.querySelector('[data-ad-act="close"]')?.addEventListener('click', () => {
        S.adminSearchTarget = null;
        dossierWrap.innerHTML = '';
        clearBtn.hidden = !input.value.trim();
      });

      dossierWrap.querySelectorAll('[data-ad-act="logo-team"]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!team) return;
          await openTeamLogoModal(team, teams, async () => {
            await loadSearchData();
            await renderDossier();
            if (onDataMutated) await onDataMutated();
          });
        });
      });

      dossierWrap.querySelector('[data-ad-act="rename-team"]')?.addEventListener('click', async () => {
        if (!team) return;
        const ok = await promptModal('Team umbenennen', 'Teamname', team.name, (name) =>
          api(`/teams/${team.id}`, { method: 'PUT', body: { name } })
        );
        if (ok) {
          toast('Team umbenannt');
          await loadSearchData();
          const updated = teams.find((t) => t.id === team.id);
          if (updated) input.value = updated.name;
          await renderDossier();
          if (onDataMutated) await onDataMutated();
        }
      });

      dossierWrap.querySelector('[data-ad-act="rename-player"]')?.addEventListener('click', async () => {
        if (!player) return;
        const ok = await promptModal('Spieler umbenennen', 'Spielername', player.name, (name) =>
          api(`/players/${player.id}`, { method: 'PUT', body: { name } })
        );
        if (ok) {
          toast('Spieler umbenannt');
          await loadSearchData();
          const updated = players.find((p) => p.id === player.id);
          if (updated) input.value = updated.name;
          await renderDossier();
          if (onDataMutated) await onDataMutated();
        }
      });

      dossierWrap.querySelectorAll('[data-ad-open-player]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const pid = Number(btn.dataset.adOpenPlayer);
          const phId = btn.dataset.adPhase || null;
          const pObj = players.find((x) => x.id === pid);
          if (pObj) input.value = pObj.name;
          selectTarget({ type: 'player', id: pid, phaseId: phId });
        });
      });

      dossierWrap.querySelectorAll('[data-ad-open-team]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const tid = Number(btn.dataset.adOpenTeam);
          const tObj = teams.find((x) => x.id === tid);
          if (tObj) input.value = tObj.name;
          selectTarget({ type: 'team', id: tid });
        });
      });

      dossierWrap.querySelectorAll('[data-ad-cal-phase]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (!S.adminSearchTarget) return;
          S.adminSearchTarget.phaseId = btn.dataset.adCalPhase;
          renderDossier();
        });
      });

      dossierWrap.querySelectorAll('[data-ad-reset-match]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const mid = Number(btn.dataset.adResetMatch);
          const label = btn.dataset.adMatchLabel || 'dieser Paarung';
          const ok = await confirmModal(
            'Termin-Einigung zurücksetzen?',
            `Der feste Termin bzw. Vorschlag für <b>${esc(label)}</b> wird aufgehoben, sodass sich die Teams neu einigen können.`,
            'Zurücksetzen'
          );
          if (!ok) return;
          try {
            await api(`/matchups/${mid}/schedule`, { method: 'PUT', body: { action: 'reset' } });
            toast('Termin-Einigung wurde zurückgesetzt.');
            await loadSearchData();
            await renderDossier();
            if (onDataMutated) await onDataMutated();
          } catch (err) {
            toast(err.message, 'error');
          }
        });
      });
    };

    // Falls bereits ein Suchziel aus dem vorherigen Tab-Wechsel aktiv war, wiederherstellen:
    if (S.adminSearchTarget) {
      const t = S.adminSearchTarget;
      const obj = t.type === 'team'
        ? teams.find((x) => String(x.id) === String(t.id))
        : players.find((x) => String(x.id) === String(t.id));
      if (obj) input.value = obj.name;
      await renderDossier();
    }
  }

  // ---------- Team-Logo Auswahl & Upload Modal (Admin) ----------
  async function openTeamLogoModal(team, allTeams, onUpdated) {
    let { logos } = await api('/admin/logos');
    const existing = document.getElementById('logo-modal-backdrop');
    if (existing) existing.remove();

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop notif-backdrop show';
    backdrop.id = 'logo-modal-backdrop';

    const onKey = (e) => {
      if (e.key === 'Escape') {
        document.removeEventListener('keydown', onKey);
        backdrop.remove();
      }
    };
    document.addEventListener('keydown', onKey);
    const close = () => {
      document.removeEventListener('keydown', onKey);
      backdrop.remove();
    };

    const assignLogo = async (logoUrl) => {
      try {
        await api(`/teams/${team.id}`, { method: 'PUT', body: { logo: logoUrl } });
        team.logo = logoUrl;
        toast(logoUrl ? `Logo für „${team.name}“ gespeichert!` : `Logo von „${team.name}“ entfernt.`);
        close();
        if (onUpdated) await onUpdated();
      } catch (err) {
        toast(err.message, 'error');
      }
    };

    const renderPicker = () => {
      const usedByOther = new Map();
      allTeams.forEach((t) => {
        if (t.id !== team.id && t.logo) usedByOther.set(t.logo, t.name);
      });

      backdrop.innerHTML = `
        <div class="modal notif-modal logo-picker-modal metal" role="dialog" aria-modal="true">
          <header class="nc-head">
            <div class="nc-head-title">
              ${teamLogoHTML(team.logo, team.name, 'lg')}
              <div>
                <h3>Team-Logo: ${esc(team.name)}</h3>
                <p class="muted">Wähle ein Logo aus dem Ordner „Team Logos“ oder lade eine neue Bilddatei hoch</p>
              </div>
            </div>
            <div class="nc-head-actions">
              ${team.logo ? `<button type="button" class="btn btn-danger btn-sm" id="lp-remove-btn">🗑 Logo entfernen</button>` : ''}
              <button type="button" class="btn btn-steel btn-sm" id="lp-close-btn">✕ Schließen</button>
            </div>
          </header>
          <div class="nc-body">
            <div class="lp-upload-bar">
              <div>
                <b>📤 Eigenes Logo vom PC hochladen</b>
                <small class="muted">Wird im Ordner „Team Logos“ gespeichert und direkt diesem Team zugeordnet (.webp, .png, .jpg, .svg)</small>
              </div>
              <label class="btn btn-primary btn-sm lp-upload-label">
                <span>📁 Bilddatei auswählen …</span>
                <input type="file" id="lp-file-input" accept=".webp,.png,.jpg,.jpeg,.svg,.gif,.avif" hidden>
              </label>
            </div>
            <div class="nc-section">
              <div class="nc-sec-title"> Verfügbare Logos im Ordner „Team Logos“ (${logos.length})</div>
              ${logos.length ? `
                <div class="lp-grid">
                  ${logos.map((l) => {
                    const isCurrent = team.logo === l.url;
                    const otherTeam = usedByOther.get(l.url);
                    return `
                      <button type="button" class="lp-card ${isCurrent ? 'is-current' : ''}" data-logo-url="${esc(l.url)}">
                        <div class="lp-img-wrap">
                          <img src="${esc(l.url)}" alt="${esc(l.name)}" loading="lazy">
                        </div>
                        <span class="lp-name">${esc(l.name)}</span>
                        ${isCurrent
                          ? '<span class="badge ok sm">✓ Aktuell gewählt</span>'
                          : otherTeam
                            ? `<span class="badge open sm" title="Wird genutzt von ${esc(otherTeam)}">🔗 ${esc(otherTeam)}</span>`
                            : '<span class="badge vs sm">Auswählen</span>'}
                      </button>`;
                  }).join('')}
                </div>
              ` : '<div class="notice">Noch keine Dateien im Ordner „Team Logos“ gefunden.</div>'}
            </div>
          </div>
        </div>`;

      backdrop.querySelector('#lp-close-btn')?.addEventListener('click', close);
      backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
      backdrop.querySelector('#lp-remove-btn')?.addEventListener('click', () => assignLogo(null));

      backdrop.querySelectorAll('[data-logo-url]').forEach((btn) => {
        btn.addEventListener('click', () => assignLogo(btn.dataset.logoUrl));
      });

      const fileInput = backdrop.querySelector('#lp-file-input');
      fileInput?.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            const res = await api('/admin/logos/upload', {
              method: 'POST',
              body: { filename: file.name, dataUrl: String(reader.result || ''), team_id: team.id },
            });
            logos = res.logos || logos;
            team.logo = res.url;
            toast(`Logo „${res.filename}“ hochgeladen und „${team.name}“ zugeordnet!`);
            close();
            if (onUpdated) await onUpdated();
          } catch (err) {
            toast(err.message, 'error');
          }
        };
        reader.readAsDataURL(file);
      });
    };

    renderPicker();
    document.body.appendChild(backdrop);
  }

  // ---------- Tab 1: Teams & Spieler ----------
  async function adminTeams(body) {
    const [teams, players] = await Promise.all([api('/teams'), api('/players')]);
    const unassigned = players.filter((p) => p.team_id == null);
    const full = teams.filter((t) => t.players.length === 3).length;
    const withLogo = teams.filter((t) => Boolean(t.logo)).length;

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
            <span><b>${withLogo}</b>/${teams.length} mit Logo</span>
            <button class="btn btn-sm btn-blue" id="auto-logos-btn" title="Ordner 'Team Logos' nach passenden Teamnamen durchsuchen und automatisch zuordnen">🖼 Logos auto-zuordnen</button>
            <button class="btn btn-sm btn-ghost" id="seed-demo-btn" title="Alle 18 Teams, 53 Spieler & alle 5 Test-Szenarien (inkl. Termin-Einigung & Stream-Radar) neu laden">🔄 Test-Szenarien zurücksetzen</button>
          </div>
        </div>
        ${teams.length ? `<div class="team-grid">${teams.map((t) => `
          <article class="team-card metal ${t.players.length === 3 ? 'full' : ''}" data-team="${t.id}" data-name="${esc(t.name)}">
            <header>
              <button type="button" class="team-logo-trigger" data-act="logo-team" title="Team-Logo auswählen oder hochladen">
                ${teamLogoHTML(t.logo, t.name, 'md')}
                <span class="tlt-badge">🖼</span>
              </button>
              <h3 title="${esc(t.name)}">${esc(t.name)}</h3>
              <span class="badge ${t.players.length === 3 ? 'ok' : 'warn'}">${t.players.length}/3</span>
              <div class="actions">
                <button class="icon-btn" data-act="logo-team" title="Team-Logo zuordnen / ändern">🖼</button>
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
    root.querySelector('#auto-logos-btn')?.addEventListener('click', async () => {
      try {
        const res = await api('/admin/logos/auto-assign', { method: 'POST', body: { overwrite: false } });
        toast(res.updated > 0 ? `${res.updated} Team-Logos automatisch nach Namen zugeordnet!` : `Alle passenden Team-Logos (${res.availableLogos} Dateien im Ordner) sind bereits zugeordnet.`);
        await refresh();
      } catch (err) {
        fail(err);
      }
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
        if (act === 'logo-team') {
          const tObj = teams.find((x) => String(x.id) === teamEl.dataset.team);
          if (tObj) await openTeamLogoModal(tObj, teams, refresh);
        } else if (act === 'rename-team') {
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
            <span class="mu-team">${teamLogoHTML(m.team_a_logo, m.team_a_name, 'sm')}<span>${esc(m.team_a_name)}</span></span>
            <span class="vs-sm">vs.</span>
            <span class="mu-team">${teamLogoHTML(m.team_b_logo, m.team_b_name, 'sm')}<span>${esc(m.team_b_name)}</span></span>
            ${schedBadge}
          </div>
          <div class="actions">
            ${m.confirmed_slot || propSlots.length ? `<button class="btn btn-sm btn-ghost" data-act="reset-sched" title="Termin-Einigung zurücksetzen / freigeben">🔓 Freigeben</button>` : ''}
            <a class="btn btn-sm btn-blue" href="#/admin/match/${m.id}">📊 Abgleich & Termin</a>
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
    const groups = [...teams.map((t) => ({ label: t.name, logo: t.logo, players: t.players })), ...(unassigned.length ? [{ label: 'Ohne Team', logo: null, players: unassigned }] : [])];

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
                return `<a class="mu-btn" href="#/admin/match/${m.id}">${teamLogoHTML(m.team_a_logo, m.team_a_name, 'xs')}<span>${esc(m.team_a_name)}</span> <span>vs</span> ${teamLogoHTML(m.team_b_logo, m.team_b_name, 'xs')}<span>${esc(m.team_b_name)}</span>${badge}</a>`;
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
                <tr class="grp"><td colspan="${PHASES.length + 2}"><span class="grp-team-cell">${g.logo ? teamLogoHTML(g.logo, g.label, 'xs') : ''}<span>${esc(g.label)}</span></span></td></tr>
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
          ${player.team_name ? teamLogoHTML(player.team_logo, player.team_name, 'sm') : ''}
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
      ? `<div class="mu-chooser">${siblings.map((x) => `<a href="#/admin/match/${x.id}" class="chip ${x.id === m.id ? 'active' : ''}">${teamLogoHTML(x.team_a_logo, x.team_a_name, 'xs')}<span>${esc(x.team_a_name)} vs. ${esc(x.team_b_name)}</span>${teamLogoHTML(x.team_b_logo, x.team_b_name, 'xs')} ${x.confirmed_slot ? '🏆' : ''}</a>`).join('')}</div>`
      : '';
    await mountMatchView(body.querySelector('#am-body'), phase, m.id, { prefix: chooser, isAdmin: true });
  }

  // ---------- Start ----------
  route();
})();
