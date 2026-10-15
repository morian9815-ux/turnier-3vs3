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
    return `<div class="brand ${small ? 'small' : ''}"><span class="logo"><b>3<i>vs</i>3</b></span><span class="brand-text"><b>Turnier-Terminfinder</b><small>Winter 2026 · 09.11. – 06.12.</small></span></div>`;
  }

  function legend(kind = 'edit') {
    if (kind === 'match') {
      return `<div class="legend">
        <span><i class="lg m-perfect"></i>Perfekt – alle grün</span>
        <span><i class="lg m-maybe"></i>Möglich – keiner rot, mind. 1 gelb</span>
        <span><i class="lg m-no"></i>Nicht möglich – mind. 1 rot / nicht eingetragen</span>
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
        <button class="btn btn-ghost btn-sm" id="logout-btn">Logout</button>
      </header>`;
  }

  function bindLogout() {
    document.getElementById('logout-btn')?.addEventListener('click', () => {
      localStorage.removeItem(LS_PLAYER);
      go('#/');
    });
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
    $app.innerHTML = `
      ${playerTopbar(me)}
      <main class="container">
        ${kickoffBanner()}
        <div class="section-head">
          <h2>Turnierphasen</h2>
          <p class="muted">Wähle eine Phase, um deine Zeiten einzutragen oder den Match-Abgleich zu öffnen.</p>
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
                    <button class="phase-bar c-${p.color}" data-phase="${p.id}">
                      <span class="pb-top"><span class="pb-name">${esc(p.name)}${p.subtitle ? ` <small>${esc(p.subtitle)}</small>` : ''}</span><span class="pb-arrow">›</span></span>
                      <span class="pb-dates">${formatRange(p)}</span>
                      <span class="pb-meta">
                        ${saved.has(p.id) ? '<span class="badge ok">✓ Zeiten gespeichert</span>' : '<span class="badge open">Noch nicht eingetragen</span>'}
                        ${ms.map((m) => `<span class="badge vs">⚔ vs. ${esc(opponentOf(m, me.player.team_id))}</span>`).join('')}
                      </span>
                    </button>`;
                }).join('')}
              </div>
            </section>`).join('')}
        </div>
      </main>`;
    bindLogout();
    $app.querySelectorAll('.phase-bar').forEach((b) => b.addEventListener('click', () => go(`#/player/phase/${b.dataset.phase}`)));
  }

  async function renderPlayerPhase(phaseId, matchupId) {
    const phase = getPhase(phaseId);
    if (!phase) return go('#/player');
    const me = await loadMe();
    if (!me) return;
    const myMatchups = me.matchups.filter((m) => m.phase_id === phase.id);
    const mode = matchupId ? 'match' : 'mine';
    const groupSiblings = PHASES.filter((p) => p.name === phase.name && PHASES.filter((x) => x.name === p.name).length > 1);

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
          <div class="pv-user"><span class="avatar sm">${esc(me.player.name.slice(0, 1).toUpperCase())}</span><span>${esc(me.player.name)}<small>${esc(me.player.team_name || 'ohne Team')}</small></span></div>
        </header>
        <div class="pv-content">
          ${groupSiblings.length > 1 ? `<div class="week-switch">${groupSiblings.map((p) => `<a href="#/player/phase/${p.id}" class="${p.id === phase.id ? 'active' : ''}">Woche ${p.week} <small>${formatDay(p.start).short} – ${formatDay(p.end).short}</small></a>`).join('')}</div>` : ''}
          <nav class="tabs">
            <a class="tab ${mode === 'mine' ? 'active' : ''}" href="#/player/phase/${phase.id}">🗓 Meine Zeiten</a>
            ${myMatchups.length
              ? `<a class="tab ${mode === 'match' ? 'active' : ''}" href="#/player/phase/${phase.id}/match/${myMatchups[0].id}">⚔ Match-Abgleich (Team vs. Team)</a>`
              : `<span class="tab disabled" title="Für diese Phase wurde noch keine Paarung für dein Team festgelegt.">⚔ Match-Abgleich (Team vs. Team)</span>`}
          </nav>
          ${!myMatchups.length ? '<p class="hint small">Der Match-Abgleich wird freigeschaltet, sobald der Admin eine Paarung mit deinem Team für diese Phase festlegt.</p>' : ''}
          <div id="pv-body"><div class="loading"><div class="spinner"></div></div></div>
        </div>
      </div>`;
    document.getElementById('back-btn').addEventListener('click', () => go('#/player'));
    const body = document.getElementById('pv-body');

    if (mode === 'mine') {
      await mountMyTimes(body, phase, me);
    } else {
      const m = myMatchups.find((x) => String(x.id) === String(matchupId));
      if (!m) return go(`#/player/phase/${phase.id}`);
      const chooser = myMatchups.length > 1
        ? `<div class="mu-chooser">${myMatchups.map((x) => `<a href="#/player/phase/${phase.id}/match/${x.id}" class="chip ${x.id === m.id ? 'active' : ''}">${esc(x.team_a_name)} vs. ${esc(x.team_b_name)}</a>`).join('')}</div>`
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

  // ---------- Match-Abgleich (6 Spieler) ----------
  async function mountMatchView(body, phase, matchupId, { prefix = '', highlightPlayer = null } = {}) {
    let data;
    const tip = el('<div class="tooltip" hidden></div>');
    document.body.appendChild(tip);
    onCleanup(() => tip.remove());
    let pinned = null;

    const render = () => {
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
      maybe.sort((a, b) => b.g - a.g);
      const missing = allPlayers.filter((p) => !hasSaved(p.id));
      const short = [data.teamA, data.teamB].filter((t) => t.players.length < 3);

      const teamBox = (t, side) => `
        <div class="team-box ${side}">
          <h3>${esc(t.name)}</h3>
          <ul>${t.players.map((p) => `<li class="${p.id === highlightPlayer ? 'me' : ''}">${esc(p.name)}${p.id === highlightPlayer ? ' <em>(du)</em>' : ''}
            ${hasSaved(p.id) ? '<span class="badge ok sm">✓ eingetragen</span>' : '<span class="badge open sm">fehlt</span>'}</li>`).join('') || '<li class="muted">Keine Spieler</li>'}</ul>
        </div>`;

      body.innerHTML = `
        ${prefix}
        <div class="match-head">
          <div class="vs-card metal">${teamBox(data.teamA, 'a')}<div class="vs-badge">VS</div>${teamBox(data.teamB, 'b')}</div>
          <div class="match-stats">
            <div class="stat perfect"><b>${perfect.length}</b><span>Perfekte Termine<br><small>alle ${n} grün</small></span></div>
            <div class="stat maybe"><b>${maybe.length}</b><span>Mögliche Optionen<br><small>keiner rot</small></span></div>
          </div>
        </div>
        ${missing.length ? `<div class="notice warn">⚠ ${missing.map((p) => esc(p.name)).join(', ')} ${missing.length === 1 ? 'hat' : 'haben'} für diese Phase noch keine Zeiten gespeichert – das zählt als <b>Rot</b>.</div>` : ''}
        ${short.length ? `<div class="notice warn">⚠ ${short.map((t) => esc(t.name)).join(', ')} ${short.length === 1 ? 'hat' : 'haben'} noch keine 3 Spieler.</div>` : ''}
        ${perfect.length
          ? `<div class="slot-list"><h4>🏆 Perfekte Termine</h4><div>${perfect.slice(0, 24).map((k) => `<span class="slot perfect">${slotLabel(k)}</span>`).join('')}${perfect.length > 24 ? `<span class="slot more">+${perfect.length - 24} weitere</span>` : ''}</div></div>`
          : maybe.length ? `<div class="slot-list"><h4>Beste Optionen (kein Rot)</h4><div>${maybe.slice(0, 12).map((m) => `<span class="slot maybe">${slotLabel(m.k)} · ${m.g}✓ ${m.y}?</span>`).join('')}</div></div>` : '<div class="notice">Aktuell gibt es keine Stunde, in der alle Spieler können.</div>'}
        <div class="cal-toolbar">
          ${legend('match')}
          <div class="tool-actions"><span class="muted small" id="refresh-info"></span><button class="btn btn-ghost btn-sm" id="refresh-btn">⟳ Aktualisieren</button></div>
        </div>
        <p class="hint small">Maus über ein Feld bewegen (am Handy antippen), um den Status aller ${n} Spieler zu sehen.</p>
        <div id="match-grid"></div>`;

      const gridBox = body.querySelector('#match-grid');
      gridBox.innerHTML = gridHTML(phase, {
        cellHTML: (d, h) => {
          const k = key(d, h);
          const i = info(k);
          const txt = i.cls === 'm-perfect' ? `${i.g}/${n}` : i.cls === 'm-maybe' ? `${i.g}✓ ${i.y}?` : n ? `${n - i.r}/${n}` : '–';
          return `<td class="cell mcell ${i.cls}" data-k="${k}"><span class="mc">${txt}</span></td>`;
        },
      });

      const showTip = (td) => {
        const k = td.dataset.k;
        const i = info(k);
        const row = (p) => { const s = statusOf(p.id, k); return `<li><i class="dot s-${s}"></i><span>${esc(p.name)}${p.id === highlightPlayer ? ' (du)' : ''}</span><b class="t-${s}">${hasSaved(p.id) ? STATUS_LABEL[s] : 'nicht eingetragen'}</b></li>`; };
        const verdict = i.cls === 'm-perfect' ? '<span class="t-green">Perfekter Match-Termin</span>' : i.cls === 'm-maybe' ? '<span class="t-yellow">Mögliche Option</span>' : '<span class="t-red">Nicht möglich</span>';
        tip.innerHTML = `
          <div class="tip-head"><b>${slotLabel(k)}</b>${verdict}</div>
          <div class="tip-teams">
            <div><h5>${esc(data.teamA.name)}</h5><ul>${data.teamA.players.map(row).join('')}</ul></div>
            <div><h5>${esc(data.teamB.name)}</h5><ul>${data.teamB.players.map(row).join('')}</ul></div>
          </div>
          <div class="tip-foot">${i.g} grün · ${i.y} gelb · ${i.r} rot</div>`;
        tip.hidden = false;
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
    const timer = setInterval(() => { if (!document.hidden && tip.hidden) load(); }, REFRESH_MS);
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
          <div class="mini-stats"><span><b>${teams.length}</b> Teams</span><span><b>${players.length}</b> Spieler</span><span><b>${full}</b>/${teams.length} vollständig</span></div>
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
    const viewRow = (m) => `
      <li class="mu-row" data-id="${m.id}">
        <div class="mu-teams"><span class="mu-team">${esc(m.team_a_name)}</span><span class="vs-sm">vs.</span><span class="mu-team">${esc(m.team_b_name)}</span></div>
        <div class="actions">
          <a class="btn btn-sm btn-ghost" href="#/admin/match/${m.id}">📊 Abgleich</a>
          <button class="icon-btn" data-act="edit" title="Bearbeiten">✎</button>
          <button class="icon-btn danger" data-act="delete" title="Löschen">🗑</button>
        </div>
      </li>`;

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
          <h3 class="card-title">⚔ Paarungs-Abgleich</h3>
          <p class="muted">Klicke auf eine Paarung, um die 6-Spieler-Schnittmengen-Ansicht zu öffnen.</p>
          ${matchups.length ? PHASES.filter((p) => matchups.some((m) => m.phase_id === p.id)).map((p) => `
            <div class="mu-group c-${p.color}">
              <h4><i class="dot"></i>W${p.week} · ${esc(p.name)}${p.subtitle ? ` <small>${esc(p.subtitle)}</small>` : ''} <span class="muted small">${formatRange(p)}</span></h4>
              <div class="mu-buttons">${matchups.filter((m) => m.phase_id === p.id).map((m) => `<a class="mu-btn" href="#/admin/match/${m.id}">${esc(m.team_a_name)} <span>vs</span> ${esc(m.team_b_name)}</a>`).join('')}</div>
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
          <div class="pv-title"><span class="pv-dot"></span><div><h1>${esc(phase.name)}${phase.subtitle ? ` <small>${esc(phase.subtitle)}</small>` : ''}</h1><p>Woche ${phase.week} · ${formatRange(phase)} · Paarungs-Abgleich</p></div></div>
        </div>
        <div class="pv-content" id="am-body"></div>
      </div>`;
    const chooser = siblings.length > 1
      ? `<div class="mu-chooser">${siblings.map((x) => `<a href="#/admin/match/${x.id}" class="chip ${x.id === m.id ? 'active' : ''}">${esc(x.team_a_name)} vs. ${esc(x.team_b_name)}</a>`).join('')}</div>`
      : '';
    await mountMatchView(body.querySelector('#am-body'), phase, m.id, { prefix: chooser });
  }

  // ---------- Start ----------
  route();
})();
