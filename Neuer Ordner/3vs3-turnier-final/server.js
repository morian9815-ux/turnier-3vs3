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
  SELECT m.id, m.phase_id, m.team_a_id, m.team_b_id, ta.name AS team_a_name, tb.name AS team_b_name
  FROM matchups m
  JOIN teams ta ON ta.id = m.team_a_id
  JOIN teams tb ON tb.id = m.team_b_id`;

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
  res.json(rows);
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
  const matchups = player.team_id
    ? await db.all(`${MATCHUP_SELECT} WHERE m.team_a_id = ? OR m.team_b_id = ? ORDER BY m.id`, [player.team_id, player.team_id])
    : [];
  const saved = await db.all('SELECT DISTINCT phase_id FROM availabilities WHERE player_id = ?', [pid]);
  res.json({ player, teammates, matchups, savedPhases: saved.map((r) => r.phase_id) });
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
  const player = await db.get('SELECT id FROM players WHERE id = ?', [pid]);
  if (!player) throw notFound('Spieler nicht gefunden.');
  const input = Array.isArray(req.body?.cells) ? req.body.cells : null;
  if (!input) throw bad('Keine Kalenderdaten übermittelt.');

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
  const counts = { green: 0, yellow: 0, red: 0 };
  rows.forEach((r) => counts[r[4]]++);
  res.json({ ok: true, saved: true, counts });
}));

app.get('/api/matchups/:id/overlap', wrap(async (req, res) => {
  const mid = toId(req.params.id);
  const m = await db.get(`${MATCHUP_SELECT} WHERE m.id = ?`, [mid]);
  if (!m) throw notFound('Paarung nicht gefunden.');
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
  res.json({
    matchup: m,
    teamA: { id: m.team_a_id, name: m.team_a_name, players: players.filter((p) => p.team_id === m.team_a_id) },
    teamB: { id: m.team_b_id, name: m.team_b_name, players: players.filter((p) => p.team_id === m.team_b_id) },
    availability,
  });
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
  res.status(201).json(await db.get(`${MATCHUP_SELECT} WHERE m.id = ?`, [row.id]));
}));

app.put('/api/matchups/:id', requireAdmin, wrap(async (req, res) => {
  const mid = toId(req.params.id);
  const existing = await db.get('SELECT id, phase_id FROM matchups WHERE id = ?', [mid]);
  if (!existing) throw notFound('Paarung nicht gefunden.');
  const { phaseId, a, b } = await validateMatchup({ phase_id: existing.phase_id, ...req.body }, mid);
  await db.run('UPDATE matchups SET phase_id = ?, team_a_id = ?, team_b_id = ? WHERE id = ?', [phaseId, a, b, mid]);
  res.json(await db.get(`${MATCHUP_SELECT} WHERE m.id = ?`, [mid]));
}));

app.delete('/api/matchups/:id', requireAdmin, wrap(async (req, res) => {
  const r = await db.run('DELETE FROM matchups WHERE id = ?', [toId(req.params.id)]);
  if (!r.changes) throw notFound('Paarung nicht gefunden.');
  res.json({ ok: true });
}));

app.post('/api/admin/seed-demo', requireAdmin, wrap(async (req, res) => {
  const result = await seedDemoData(db);
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
      const existing = await db.all('SELECT id FROM teams LIMIT 1');
      if (!existing.length && process.env.AUTO_SEED !== 'false') {
        console.log('Datenbank ist leer – initialisiere Demo-Daten (8 Teams, 24 Spieler, Paarungen)...');
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
