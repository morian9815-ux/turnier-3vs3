'use strict';
try { process.loadEnvFile(); } catch { /* keine .env vorhanden */ }

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { initDb } = require('./db');
const { HOURS, STATUSES, getPhase, phaseDates } = require('./public/phases.js');
const { seedDemoData } = require('./scripts/seed-demo.js');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin2026';
const SECRET = process.env.SESSION_SECRET
  || crypto.createHash('sha256').update('3vs3-terminfinder:' + ADMIN_PASSWORD).digest('hex');
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PLAYERS_PER_TEAM = 3;

let db;
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

// ---------- Helfer ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (msg) => new HttpError(400, msg);
const notFound = (msg) => new HttpError(404, msg);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function toId(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw bad('Ungültige ID.');
  return n;
}
function cleanName(value, label) {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!s) throw bad(`${label} darf nicht leer sein.`);
  if (s.length > 60) throw bad(`${label} ist zu lang (max. 60 Zeichen).`);
  return s;
}

const hmac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
function signToken() {
  const exp = String(Date.now() + TOKEN_TTL_MS);
  return `${exp}.${hmac(exp)}`;
}
function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const expected = hmac(exp);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function requireAdmin(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!verifyToken(token)) return res.status(401).json({ error: 'Admin-Anmeldung erforderlich bzw. abgelaufen.' });
  next();
}

const MATCHUP_SELECT = `
  SELECT m.id, m.phase_id, m.team_a_id, m.team_b_id,
         ta.name AS team_a_name, tb.name AS team_b_name,
         m.proposed_slots, m.proposed_by_team_id, m.proposed_by_player_name,
         m.confirmed_slot, m.confirmed_by_player_name
  FROM matchups m
  JOIN teams ta ON ta.id = m.team_a_id
  JOIN teams tb ON tb.id = m.team_b_id`;

function formatMatchup(m) {
  if (!m) return null;
  let proposed_slots = [];
  if (m.proposed_slots) {
    try { proposed_slots = JSON.parse(m.proposed_slots); } catch { proposed_slots = []; }
  }
  return {
    ...m,
    proposed_slots: Array.isArray(proposed_slots) ? proposed_slots : [],
  };
}

const WEEKDAYS_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
function formatSlotLabel(slotKey) {
  if (!slotKey || !String(slotKey).includes('|')) return String(slotKey || '');
  const [d, hStr] = String(slotKey).split('|');
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  const wd = WEEKDAYS_SHORT[dt.getUTCDay()] || '';
  const hh = String(Number(hStr)).padStart(2, '0');
  return `${wd}, ${String(day).padStart(2, '0')}.${String(m).padStart(2, '0')}. · ${hh}:00 Uhr`;
}

function formatSlotsList(slots) {
  return (slots || []).map(formatSlotLabel).join(' / ');
}

async function createNotifications(runner, recipientIds, { kind, title, body, phase_id = null, matchup_id = null, created_at = null }) {
  const uniqueIds = [...new Set((recipientIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (!uniqueIds.length) return;
  const ts = created_at || new Date().toISOString();
  for (const pid of uniqueIds) {
    await runner.run(
      `INSERT INTO notifications (player_id, kind, title, body, phase_id, matchup_id, is_read, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      [pid, kind, title, body, phase_id, matchup_id, ts]
    );
  }
}

async function loadPlayerNotifications(pid) {
  const rows = await db.all(
    `SELECT id, player_id, kind, title, body, phase_id, matchup_id, is_read, created_at
     FROM notifications
     WHERE player_id = ?
     ORDER BY is_read ASC, id DESC
     LIMIT 60`,
    [pid]
  );
  const notifications = rows.map((r) => ({ ...r, is_read: Boolean(r.is_read) }));
  const unreadCount = notifications.reduce((acc, n) => acc + (n.is_read ? 0 : 1), 0);
  return { notifications, unreadCount };
}

async function loadMatchupContext(mid) {
  const raw = await db.get(`${MATCHUP_SELECT} WHERE m.id = ?`, [mid]);
  if (!raw) throw notFound('Paarung nicht gefunden.');
  const m = formatMatchup(raw);
  const phase = getPhase(m.phase_id);
  const players = await db.all(
    'SELECT id, name, team_id FROM players WHERE team_id IN (?, ?) ORDER BY id', [m.team_a_id, m.team_b_id]);
  const ids = players.map((p) => p.id);
  const avail = ids.length
    ? await db.all(
      `SELECT player_id, date, hour, status FROM availabilities WHERE phase_id = ? AND player_id IN (${ids.map(() => '?').join(', ')})`,
      [m.phase_id, ...ids])
    : [];
  const availability = {};
  for (const p of players) availability[p.id] = {};
  for (const a of avail) availability[a.player_id][`${a.date}|${a.hour}`] = a.status;

  const teamAPlayers = players.filter((p) => p.team_id === m.team_a_id);
  const teamBPlayers = players.filter((p) => p.team_id === m.team_b_id);
  const allSaved = teamAPlayers.length > 0 && teamBPlayers.length > 0 && players.every((p) => Object.keys(availability[p.id]).length > 0);
  const validDates = new Set(phase ? phaseDates(phase) : []);

  const checkSlot = (slotKey) => {
    if (typeof slotKey !== 'string' || !slotKey.includes('|')) return 'invalid';
    const [d, hStr] = slotKey.split('|');
    const h = Number(hStr);
    if (!validDates.has(d) || !HOURS.includes(h)) return 'invalid';
    let r = 0, y = 0;
    for (const p of players) {
      const s = availability[p.id]?.[slotKey] || 'red';
      if (s === 'red') r++;
      else if (s === 'yellow') y++;
    }
    return r > 0 ? 'no' : y > 0 ? 'maybe' : 'perfect';
  };

  const rawOthers = await db.all(
    `${MATCHUP_SELECT} WHERE m.id <> ? AND m.confirmed_slot IS NOT NULL ORDER BY m.confirmed_slot, m.id`,
    [mid]
  );
  const otherConfirmed = rawOthers
    .map(formatMatchup)
    .filter((x) => {
      const [d] = String(x.confirmed_slot || '').split('|');
      return validDates.has(d);
    })
    .map((x) => {
      const isOwn = x.team_a_id === m.team_a_id || x.team_b_id === m.team_a_id
        || x.team_a_id === m.team_b_id || x.team_b_id === m.team_b_id;
      return {
        id: x.id,
        phase_id: x.phase_id,
        team_a_id: x.team_a_id,
        team_b_id: x.team_b_id,
        team_a_name: x.team_a_name,
        team_b_name: x.team_b_name,
        confirmed_slot: x.confirmed_slot,
        is_own_team: isOwn,
      };
    });

  // Prüft, ob eines der beiden beteiligten Teams zur selben Zeit (inkl. ±1h wegen 1,5h Spieldauer) bereits ein eigenes festes Spiel hat
  const ownTeamConflict = (slotKey) => {
    if (typeof slotKey !== 'string' || !slotKey.includes('|')) return null;
    const [d, hStr] = slotKey.split('|');
    const h = Number(hStr);
    for (const oc of otherConfirmed) {
      if (!oc.is_own_team || !oc.confirmed_slot) continue;
      const [od, ohStr] = oc.confirmed_slot.split('|');
      const oh = Number(ohStr);
      if (od === d && Math.abs(h - oh) <= 1) return oc;
    }
    return null;
  };

  return {
    matchup: m,
    phase,
    players,
    teamA: { id: m.team_a_id, name: m.team_a_name, players: teamAPlayers },
    teamB: { id: m.team_b_id, name: m.team_b_name, players: teamBPlayers },
    availability,
    allSaved,
    checkSlot,
    otherConfirmed,
    ownTeamConflict,
  };
}

async function loadTeams() {
  const teams = await db.all('SELECT id, name FROM teams ORDER BY LOWER(name), id');
  const players = await db.all('SELECT id, name, team_id FROM players ORDER BY id');
  return teams.map((t) => ({ ...t, players: players.filter((p) => p.team_id === t.id) }));
}

async function ensureUniqueTeamName(name, exceptId = 0) {
  const row = await db.get('SELECT id FROM teams WHERE LOWER(name) = LOWER(?) AND id <> ?', [name, exceptId]);
  if (row) throw bad('Ein Team mit diesem Namen existiert bereits.');
}
async function ensureUniquePlayerName(name, exceptId = 0) {
  const row = await db.get('SELECT id FROM players WHERE LOWER(name) = LOWER(?) AND id <> ?', [name, exceptId]);
  if (row) throw bad('Ein Spieler mit diesem Namen existiert bereits (Namen müssen für den Login eindeutig sein).');
}
async function ensureTeamCapacity(teamId, exceptPlayerId = 0) {
  if (teamId == null) return;
  const team = await db.get('SELECT id FROM teams WHERE id = ?', [teamId]);
  if (!team) throw bad('Team existiert nicht.');
  const rows = await db.all('SELECT id FROM players WHERE team_id = ? AND id <> ?', [teamId, exceptPlayerId]);
  if (rows.length >= MAX_PLAYERS_PER_TEAM) throw bad(`Dieses Team hat bereits ${MAX_PLAYERS_PER_TEAM} Spieler.`);
}
function parseTeamId(value) {
  if (value === null || value === undefined || value === '') return null;
  return toId(value);
}

// ---------- Öffentliche API ----------
app.get('/api/health', wrap(async (req, res) => {
  await db.get('SELECT 1 AS ok');
  res.json({ ok: true, db: db.kind });
}));

app.get('/api/players', wrap(async (req, res) => {
  res.json(await db.all(`
    SELECT p.id, p.name, p.team_id, t.name AS team_name
    FROM players p LEFT JOIN teams t ON t.id = p.team_id
    ORDER BY LOWER(p.name), p.id`));
}));

app.get('/api/teams', wrap(async (req, res) => {
  res.json(await loadTeams());
}));

app.get('/api/matchups', wrap(async (req, res) => {
  const phase = typeof req.query.phase === 'string' ? req.query.phase : null;
  const rows = phase
    ? await db.all(`${MATCHUP_SELECT} WHERE m.phase_id = ? ORDER BY m.id`, [phase])
    : await db.all(`${MATCHUP_SELECT} ORDER BY m.id`);
  res.json(rows.map(formatMatchup));
}));

app.get('/api/players/:id', wrap(async (req, res) => {
  const pid = toId(req.params.id);
  const player = await db.get(`
    SELECT p.id, p.name, p.team_id, t.name AS team_name
    FROM players p LEFT JOIN teams t ON t.id = p.team_id WHERE p.id = ?`, [pid]);
  if (!player) throw notFound('Spieler nicht gefunden.');
  const teammates = player.team_id
    ? await db.all('SELECT id, name FROM players WHERE team_id = ? AND id <> ? ORDER BY id', [player.team_id, pid])
    : [];
  const rawMatchups = player.team_id
    ? await db.all(`${MATCHUP_SELECT} WHERE m.team_a_id = ? OR m.team_b_id = ? ORDER BY m.id`, [player.team_id, player.team_id])
    : [];
  const saved = await db.all('SELECT DISTINCT phase_id FROM availabilities WHERE player_id = ?', [pid]);
  const { notifications, unreadCount } = await loadPlayerNotifications(pid);
  res.json({
    player,
    teammates,
    matchups: rawMatchups.map(formatMatchup),
    savedPhases: saved.map((r) => r.phase_id),
    notifications,
    unreadCount,
  });
}));

app.get('/api/players/:id/notifications', wrap(async (req, res) => {
  const pid = toId(req.params.id);
  res.json(await loadPlayerNotifications(pid));
}));

app.post('/api/players/:id/notifications/read-all', wrap(async (req, res) => {
  const pid = toId(req.params.id);
  await db.run('UPDATE notifications SET is_read = 1 WHERE player_id = ? AND is_read = 0', [pid]);
  res.json(await loadPlayerNotifications(pid));
}));

app.post('/api/players/:id/notifications/:notifId/read', wrap(async (req, res) => {
  const pid = toId(req.params.id);
  const nid = toId(req.params.notifId);
  await db.run('UPDATE notifications SET is_read = 1 WHERE id = ? AND player_id = ?', [nid, pid]);
  res.json(await loadPlayerNotifications(pid));
}));

app.get('/api/players/:id/availability/:phaseId', wrap(async (req, res) => {
  const pid = toId(req.params.id);
  const phase = getPhase(req.params.phaseId);
  if (!phase) throw notFound('Unbekannte Phase.');
  const cells = await db.all(
    'SELECT date, hour, status FROM availabilities WHERE player_id = ? AND phase_id = ? ORDER BY date, hour',
    [pid, phase.id]);
  res.json({ saved: cells.length > 0, cells });
}));

app.put('/api/players/:id/availability/:phaseId', wrap(async (req, res) => {
  const pid = toId(req.params.id);
  const phase = getPhase(req.params.phaseId);
  if (!phase) throw notFound('Unbekannte Phase.');
  const player = await db.get('SELECT id, name, team_id FROM players WHERE id = ?', [pid]);
  if (!player) throw notFound('Spieler nicht gefunden.');
  const input = Array.isArray(req.body?.cells) ? req.body.cells : null;
  if (!input) throw bad('Keine Kalenderdaten übermittelt.');

  const prevRow = await db.get('SELECT 1 AS ok FROM availabilities WHERE player_id = ? AND phase_id = ? LIMIT 1', [pid, phase.id]);
  const hadSavedBefore = Boolean(prevRow);

  const dates = phaseDates(phase);
  const dateSet = new Set(dates);
  const map = new Map();
  for (const c of input) {
    const hour = Number(c?.hour);
    if (!dateSet.has(c?.date) || !HOURS.includes(hour) || !STATUSES.includes(c?.status)) {
      throw bad('Ungültiger Eintrag im Kalender.');
    }
    map.set(`${c.date}|${hour}`, c.status);
  }
  // Vollständiges Raster speichern (nicht markierte Felder = Rot)
  const rows = [];
  for (const d of dates) for (const h of HOURS) rows.push([pid, phase.id, d, h, map.get(`${d}|${h}`) || 'red']);

  await db.tx(async (q) => {
    await q.run('DELETE FROM availabilities WHERE player_id = ? AND phase_id = ?', [pid, phase.id]);
    const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
    await q.run(`INSERT INTO availabilities (player_id, phase_id, date, hour, status) VALUES ${placeholders}`, rows.flat());
  });

  // Benachrichtigungen für Mitspieler & ggf. Paarungen, bei denen jetzt alle 6 Spieler fertig sind:
  if (player.team_id) {
    const teammates = await db.all('SELECT id FROM players WHERE team_id = ? AND id <> ?', [player.team_id, pid]);
    const tmIds = teammates.map((t) => t.id);
    const phaseMatchups = await db.all(
      `${MATCHUP_SELECT} WHERE m.phase_id = ? AND (m.team_a_id = ? OR m.team_b_id = ?) ORDER BY m.id`,
      [phase.id, player.team_id, player.team_id]
    );
    const firstMatchupId = phaseMatchups[0]?.id || null;

    if (tmIds.length) {
      await createNotifications(db, tmIds, {
        kind: 'teammate_availability',
        title: `Mitspieler ${player.name} hat Zeiten ${hadSavedBefore ? 'aktualisiert' : 'eingetragen'}`,
        body: `Dein Mitspieler ${player.name} hat seine Verfügbarkeiten für „${phase.name}“ gespeichert.`,
        phase_id: phase.id,
        matchup_id: firstMatchupId,
      });
    }

    // Wenn dieser Spieler zum ersten Mal für diese Phase gespeichert hat, prüfen ob jetzt alle 6 Spieler einer Paarung fertig sind
    if (!hadSavedBefore && phaseMatchups.length) {
      for (const m of phaseMatchups) {
        const ctx = await loadMatchupContext(m.id);
        if (ctx.allSaved && !ctx.matchup.confirmed_slot) {
          const otherFiveIds = ctx.players.filter((p) => p.id !== pid).map((p) => p.id);
          await createNotifications(db, otherFiveIds, {
            kind: 'all_6_ready',
            title: `Alle 6 Spieler bereit: ${m.team_a_name} vs. ${m.team_b_name}`,
            body: `Alle 6 Spieler haben ihre Zeiten für „${phase.name}“ eingetragen! Ihr könnt euch ab sofort im Match-Abgleich auf einen Spieltermin einigen.`,
            phase_id: phase.id,
            matchup_id: m.id,
          });
        }
      }
    }
  }

  const counts = { green: 0, yellow: 0, red: 0 };
  rows.forEach((r) => counts[r[4]]++);
  res.json({ ok: true, saved: true, counts });
}));

app.get('/api/matchups/:id/overlap', wrap(async (req, res) => {
  const mid = toId(req.params.id);
  const ctx = await loadMatchupContext(mid);
  res.json({
    matchup: ctx.matchup,
    teamA: ctx.teamA,
    teamB: ctx.teamB,
    availability: ctx.availability,
    otherConfirmed: ctx.otherConfirmed,
  });
}));

// ---------- Termin-Einigung (1–3 Vorschläge + Team-Handshake) ----------
app.post('/api/matchups/:id/propose', wrap(async (req, res) => {
  const mid = toId(req.params.id);
  const pid = toId(req.body?.player_id);
  const rawSlots = Array.isArray(req.body?.slots) ? req.body.slots : [];
  const slots = [...new Set(rawSlots.map(String))];

  const ctx = await loadMatchupContext(mid);
  const { matchup: m } = ctx;

  if (m.confirmed_slot) {
    throw bad('Der Spieltermin steht bereits verbindlich fest und kann nur noch vom Admin geändert werden.');
  }
  const player = ctx.players.find((p) => p.id === pid);
  if (!player) {
    throw new HttpError(403, 'Du gehörst keinem der beiden Teams dieser Paarung an.');
  }
  if (!ctx.allSaved) {
    throw bad('Erst müssen alle Spieler beider Teams ihre Zeiten für diese Phase gespeichert haben.');
  }
  if (slots.length < 1 || slots.length > 3) {
    throw bad('Bitte wähle zwischen 1 und 3 Terminen für deinen Vorschlag aus.');
  }
  for (const s of slots) {
    const st = ctx.checkSlot(s);
    if (st !== 'perfect' && st !== 'maybe') {
      throw bad('Es dürfen nur perfekte (alle Grün) oder mögliche (Grün/Gelb) Termine vorgeschlagen werden.');
    }
    const ownBusy = ctx.ownTeamConflict(s);
    if (ownBusy) {
      const busyTeam = (ownBusy.team_a_id === m.team_a_id || ownBusy.team_b_id === m.team_a_id) ? m.team_a_name : m.team_b_name;
      throw bad(`Nicht möglich: ${busyTeam} hat zu dieser Zeit (inkl. ~1,5h Spielzeit) bereits ein eigenes festes Spiel (${ownBusy.team_a_name} vs. ${ownBusy.team_b_name}).`);
    }
  }

  const wasCounterProposal = Boolean(m.proposed_slots.length && m.proposed_by_team_id && m.proposed_by_team_id !== player.team_id);
  const myTeamName = player.team_id === m.team_a_id ? m.team_a_name : m.team_b_name;
  const oppTeamName = player.team_id === m.team_a_id ? m.team_b_name : m.team_a_name;
  const phaseName = ctx.phase ? ctx.phase.name : m.phase_id;
  const slotsText = formatSlotsList(slots);

  await db.run(
    'UPDATE matchups SET proposed_slots = ?, proposed_by_team_id = ?, proposed_by_player_name = ? WHERE id = ?',
    [JSON.stringify(slots), player.team_id, player.name, mid]
  );

  // Empfänger: Gegnerisches Team (alle 3 Spieler) + eigene Mitspieler (ohne den absendenden Spieler selbst)
  const oppIds = ctx.players.filter((p) => p.team_id !== player.team_id).map((p) => p.id);
  const mateIds = ctx.players.filter((p) => p.team_id === player.team_id && p.id !== pid).map((p) => p.id);

  if (wasCounterProposal) {
    await createNotifications(db, oppIds, {
      kind: 'counter_proposal',
      title: `Gegenvorschlag von ${myTeamName}`,
      body: `${player.name} (${myTeamName}) hat für euer Match in „${phaseName}“ ${slots.length === 1 ? 'einen neuen Termin' : `${slots.length} neue Termine`} vorgeschlagen: ${slotsText}. Bitte bestätigen oder Gegenvorschlag senden!`,
      phase_id: m.phase_id,
      matchup_id: mid,
    });
    await createNotifications(db, mateIds, {
      kind: 'teammate_proposed',
      title: `Gegenvorschlag an ${oppTeamName} gesendet`,
      body: `Dein Mitspieler ${player.name} hat ${oppTeamName} einen Gegenvorschlag (${slotsText}) für „${phaseName}“ geschickt.`,
      phase_id: m.phase_id,
      matchup_id: mid,
    });
  } else {
    await createNotifications(db, oppIds, {
      kind: 'proposal_received',
      title: `Terminvorschlag von ${myTeamName}`,
      body: `${player.name} (${myTeamName}) hat euch ${slots.length === 1 ? '1 Terminvorschlag' : `${slots.length} Terminvorschläge`} für „${phaseName}“ geschickt: ${slotsText}. Bitte wählt einen Termin aus oder sendet einen Gegenvorschlag!`,
      phase_id: m.phase_id,
      matchup_id: mid,
    });
    await createNotifications(db, mateIds, {
      kind: 'teammate_proposed',
      title: `Mitspieler ${player.name} hat Termine vorgeschlagen`,
      body: `Dein Mitspieler ${player.name} hat ${oppTeamName} folgende Termine für „${phaseName}“ vorgeschlagen: ${slotsText}.`,
      phase_id: m.phase_id,
      matchup_id: mid,
    });
  }

  res.json(formatMatchup(await db.get(`${MATCHUP_SELECT} WHERE m.id = ?`, [mid])));
}));

app.post('/api/matchups/:id/confirm', wrap(async (req, res) => {
  const mid = toId(req.params.id);
  const pid = toId(req.body?.player_id);
  const slot = String(req.body?.slot || '');

  const ctx = await loadMatchupContext(mid);
  const { matchup: m } = ctx;

  if (m.confirmed_slot) {
    throw bad('Der Spieltermin steht bereits verbindlich fest.');
  }
  const player = ctx.players.find((p) => p.id === pid);
  if (!player) {
    throw new HttpError(403, 'Du gehörst keinem der beiden Teams dieser Paarung an.');
  }
  if (!m.proposed_slots.length || !m.proposed_by_team_id) {
    throw bad('Es liegt aktuell kein Terminvorschlag vor.');
  }
  if (player.team_id === m.proposed_by_team_id) {
    throw bad('Das gegnerische Team muss den Terminvorschlag bestätigen.');
  }
  if (!m.proposed_slots.includes(slot)) {
    throw bad('Dieser Termin gehört nicht zu den vorgeschlagenen Terminen.');
  }
  const ownBusy = ctx.ownTeamConflict(slot);
  if (ownBusy) {
    const busyTeam = (ownBusy.team_a_id === m.team_a_id || ownBusy.team_b_id === m.team_a_id) ? m.team_a_name : m.team_b_name;
    throw bad(`Nicht möglich: ${busyTeam} hat zu dieser Zeit (inkl. ~1,5h Spielzeit) bereits ein eigenes festes Spiel (${ownBusy.team_a_name} vs. ${ownBusy.team_b_name}).`);
  }

  await db.run(
    'UPDATE matchups SET confirmed_slot = ?, confirmed_by_player_name = ? WHERE id = ?',
    [slot, player.name, mid]
  );

  // Alle 5 anderen Spieler der Paarung (eigene Mitspieler + Gegner) erhalten eine Erfolgs-Nachricht
  const otherFiveIds = ctx.players.filter((p) => p.id !== pid).map((p) => p.id);
  const myTeamName = player.team_id === m.team_a_id ? m.team_a_name : m.team_b_name;
  const phaseName = ctx.phase ? ctx.phase.name : m.phase_id;
  const slotFormatted = formatSlotLabel(slot);

  await createNotifications(db, otherFiveIds, {
    kind: 'match_confirmed',
    title: `Fester Spieltermin bestätigt: ${m.team_a_name} vs. ${m.team_b_name}`,
    body: `${player.name} (${myTeamName}) hat den Terminvorschlag angenommen! Euer Match in „${phaseName}“ findet verbindlich am ${slotFormatted} statt.`,
    phase_id: m.phase_id,
    matchup_id: mid,
  });

  res.json(formatMatchup(await db.get(`${MATCHUP_SELECT} WHERE m.id = ?`, [mid])));
}));

// ---------- Admin-API ----------
app.post('/api/admin/login', wrap(async (req, res) => {
  if (!safeEqual(req.body?.password ?? '', ADMIN_PASSWORD)) {
    await new Promise((r) => setTimeout(r, 400));
    throw new HttpError(401, 'Falsches Passwort.');
  }
  res.json({ token: signToken() });
}));

app.get('/api/admin/verify', requireAdmin, (req, res) => res.json({ ok: true }));

app.get('/api/admin/save-status', requireAdmin, wrap(async (req, res) => {
  res.json(await db.all('SELECT DISTINCT player_id, phase_id FROM availabilities'));
}));

// Teams
app.post('/api/teams', requireAdmin, wrap(async (req, res) => {
  const name = cleanName(req.body?.name, 'Teamname');
  await ensureUniqueTeamName(name);
  const row = await db.get('INSERT INTO teams (name) VALUES (?) RETURNING id, name', [name]);
  res.status(201).json(row);
}));

app.put('/api/teams/:id', requireAdmin, wrap(async (req, res) => {
  const tid = toId(req.params.id);
  const name = cleanName(req.body?.name, 'Teamname');
  await ensureUniqueTeamName(name, tid);
  const r = await db.run('UPDATE teams SET name = ? WHERE id = ?', [name, tid]);
  if (!r.changes) throw notFound('Team nicht gefunden.');
  res.json({ id: tid, name });
}));

app.delete('/api/teams/:id', requireAdmin, wrap(async (req, res) => {
  const tid = toId(req.params.id);
  const r = await db.tx(async (q) => {
    await q.run('DELETE FROM matchups WHERE team_a_id = ? OR team_b_id = ?', [tid, tid]);
    await q.run('UPDATE players SET team_id = NULL WHERE team_id = ?', [tid]);
    return q.run('DELETE FROM teams WHERE id = ?', [tid]);
  });
  if (!r.changes) throw notFound('Team nicht gefunden.');
  res.json({ ok: true });
}));

// Spieler
app.post('/api/players', requireAdmin, wrap(async (req, res) => {
  const name = cleanName(req.body?.name, 'Spielername');
  const teamId = parseTeamId(req.body?.team_id);
  await ensureUniquePlayerName(name);
  await ensureTeamCapacity(teamId);
  const row = await db.get('INSERT INTO players (name, team_id) VALUES (?, ?) RETURNING id, name, team_id', [name, teamId]);
  res.status(201).json(row);
}));

app.put('/api/players/:id', requireAdmin, wrap(async (req, res) => {
  const pid = toId(req.params.id);
  const existing = await db.get('SELECT id, name, team_id FROM players WHERE id = ?', [pid]);
  if (!existing) throw notFound('Spieler nicht gefunden.');
  const body = req.body || {};
  const name = body.name !== undefined ? cleanName(body.name, 'Spielername') : existing.name;
  const teamId = Object.prototype.hasOwnProperty.call(body, 'team_id') ? parseTeamId(body.team_id) : existing.team_id;
  if (name !== existing.name) await ensureUniquePlayerName(name, pid);
  if (teamId !== existing.team_id) await ensureTeamCapacity(teamId, pid);
  await db.run('UPDATE players SET name = ?, team_id = ? WHERE id = ?', [name, teamId, pid]);
  res.json({ id: pid, name, team_id: teamId });
}));

app.delete('/api/players/:id', requireAdmin, wrap(async (req, res) => {
  const pid = toId(req.params.id);
  const r = await db.tx(async (q) => {
    await q.run('DELETE FROM availabilities WHERE player_id = ?', [pid]);
    return q.run('DELETE FROM players WHERE id = ?', [pid]);
  });
  if (!r.changes) throw notFound('Spieler nicht gefunden.');
  res.json({ ok: true });
}));

// Paarungen
async function validateMatchup(body, exceptId = 0) {
  const phase = getPhase(body?.phase_id);
  if (!phase) throw bad('Bitte eine gültige Phase wählen.');
  const a = toId(body?.team_a_id);
  const b = toId(body?.team_b_id);
  if (a === b) throw bad('Ein Team kann nicht gegen sich selbst spielen.');
  const teams = await db.all('SELECT id FROM teams WHERE id IN (?, ?)', [a, b]);
  if (teams.length !== 2) throw bad('Team nicht gefunden.');
  const dup = await db.get(
    `SELECT id FROM matchups WHERE phase_id = ? AND id <> ?
       AND ((team_a_id = ? AND team_b_id = ?) OR (team_a_id = ? AND team_b_id = ?))`,
    [phase.id, exceptId, a, b, b, a]);
  if (dup) throw bad('Diese Paarung existiert in dieser Phase bereits.');
  return { phaseId: phase.id, a, b };
}

app.post('/api/matchups', requireAdmin, wrap(async (req, res) => {
  const { phaseId, a, b } = await validateMatchup(req.body);
  const row = await db.get('INSERT INTO matchups (phase_id, team_a_id, team_b_id) VALUES (?, ?, ?) RETURNING id', [phaseId, a, b]);
  res.status(201).json(formatMatchup(await db.get(`${MATCHUP_SELECT} WHERE m.id = ?`, [row.id])));
}));

app.put('/api/matchups/:id', requireAdmin, wrap(async (req, res) => {
  const mid = toId(req.params.id);
  const existing = await db.get('SELECT id, phase_id FROM matchups WHERE id = ?', [mid]);
  if (!existing) throw notFound('Paarung nicht gefunden.');
  const { phaseId, a, b } = await validateMatchup({ phase_id: existing.phase_id, ...req.body }, mid);
  await db.run(
    `UPDATE matchups
     SET phase_id = ?, team_a_id = ?, team_b_id = ?,
         proposed_slots = NULL, proposed_by_team_id = NULL, proposed_by_player_name = NULL,
         confirmed_slot = NULL, confirmed_by_player_name = NULL
     WHERE id = ?`,
    [phaseId, a, b, mid]
  );
  res.json(formatMatchup(await db.get(`${MATCHUP_SELECT} WHERE m.id = ?`, [mid])));
}));

app.put('/api/matchups/:id/schedule', requireAdmin, wrap(async (req, res) => {
  const mid = toId(req.params.id);
  const ctx = await loadMatchupContext(mid);
  const { matchup: m } = ctx;
  const phaseName = ctx.phase ? ctx.phase.name : m.phase_id;
  const allPlayerIds = ctx.players.map((p) => p.id);
  const action = req.body?.action;
  if (action === 'reset') {
    await db.run(
      `UPDATE matchups
       SET proposed_slots = NULL, proposed_by_team_id = NULL, proposed_by_player_name = NULL,
           confirmed_slot = NULL, confirmed_by_player_name = NULL
       WHERE id = ?`,
      [mid]
    );
    await createNotifications(db, allPlayerIds, {
      kind: 'match_reset',
      title: `Termin zurückgesetzt: ${m.team_a_name} vs. ${m.team_b_name}`,
      body: `Der Termin bzw. Vorschlag für euer Match in „${phaseName}“ wurde vom Admin zurückgesetzt. Bitte stimmt euch im Match-Abgleich neu ab.`,
      phase_id: m.phase_id,
      matchup_id: mid,
    });
  } else if (action === 'set') {
    const slot = String(req.body?.slot || '');
    const st = ctx.checkSlot(slot);
    if (st === 'invalid') throw bad('Ungültiges Datum oder Uhrzeit für diese Phase.');
    await db.run(
      `UPDATE matchups
       SET confirmed_slot = ?, confirmed_by_player_name = 'Admin'
       WHERE id = ?`,
      [slot, mid]
    );
    await createNotifications(db, allPlayerIds, {
      kind: 'match_confirmed',
      title: `Fester Spieltermin festgelegt: ${m.team_a_name} vs. ${m.team_b_name}`,
      body: `Die Turnierleitung (Admin) hat euer Match in „${phaseName}“ verbindlich auf ${formatSlotLabel(slot)} festgelegt.`,
      phase_id: m.phase_id,
      matchup_id: mid,
    });
  } else {
    throw bad('Unbekannte Aktion.');
  }
  res.json(formatMatchup(await db.get(`${MATCHUP_SELECT} WHERE m.id = ?`, [mid])));
}));

app.delete('/api/matchups/:id', requireAdmin, wrap(async (req, res) => {
  const r = await db.run('DELETE FROM matchups WHERE id = ?', [toId(req.params.id)]);
  if (!r.changes) throw notFound('Paarung nicht gefunden.');
  res.json({ ok: true });
}));

app.post('/api/admin/seed-demo', requireAdmin, wrap(async (req, res) => {
  const result = await seedDemoData(db, { force: req.body?.force !== false });
  res.json(result);
}));

// ---------- Fallbacks & Fehler ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpunkt nicht gefunden.' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungültige Anfrage (JSON).' });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Interner Serverfehler. Bitte erneut versuchen.' : err.message });
});

initDb()
  .then(async (database) => {
    db = database;
    try {
      if (process.env.AUTO_SEED !== 'false') {
        await seedDemoData(db);
      }
    } catch (err) {
      console.error('Hinweis beim Demo-Seed:', err.message);
    }
    app.listen(PORT, () => {
      console.log(`3vs3 Terminfinder läuft auf http://localhost:${PORT}  (Datenbank: ${db.kind}${db.file ? ' → ' + db.file : ''})`);
      if (!process.env.ADMIN_PASSWORD) console.log('Hinweis: Standard-Admin-Passwort "admin2026" aktiv (über ADMIN_PASSWORD änderbar).');
    });
  })
  .catch((err) => {
    console.error('Datenbank konnte nicht initialisiert werden:', err);
    process.exit(1);
  });
