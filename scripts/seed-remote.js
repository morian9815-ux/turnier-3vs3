'use strict';
const { HOURS, getPhase, phaseDates } = require('../public/phases.js');

const TARGET_URL = process.env.TARGET_URL || 'https://turnier-3vs3turnier-3vs3.onrender.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin2026';

const { TEAMS } = require('./seed-teams.js');

async function api(path, { method = 'GET', body, token } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${TARGET_URL}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status}: ${data.error || 'Fehler'}`);
  return data;
}

(async () => {
  console.log(`Verbinde mit ${TARGET_URL} …`);
  const { token } = await api('/admin/login', { method: 'POST', body: { password: ADMIN_PASSWORD } });
  console.log('Admin-Login erfolgreich.');

  const createdTeams = [];
  for (const [teamName, playerNames] of Object.entries(TEAMS)) {
    const team = await api('/teams', { method: 'POST', body: { name: teamName }, token });
    console.log(`Team angelegt: ${team.name} (ID ${team.id})`);
    const playerObjs = [];
    for (const pName of playerNames) {
      const p = await api('/players', { method: 'POST', body: { name: pName, team_id: team.id }, token });
      playerObjs.push(p);
    }
    createdTeams.push({ ...team, players: playerObjs });
  }

  console.log('Erstelle Paarungen für Woche 1 (Gruppenphase) …');
  for (let i = 0; i < createdTeams.length; i += 2) {
    const a = createdTeams[i];
    const b = createdTeams[i + 1];
    await api('/matchups', {
      method: 'POST',
      body: { phase_id: 'w1-group', team_a_id: a.id, team_b_id: b.id },
      token,
    });
    console.log(`Paarung angelegt: ${a.name} vs. ${b.name}`);
  }

  const phase = getPhase('w1-group');
  const dates = phaseDates(phase);
  console.log(`Trage Verfügbarkeiten für alle Spieler in ${phase.name} ein …`);

  for (const t of createdTeams) {
    for (const p of t.players) {
      const cells = [];
      for (const d of dates) {
        for (const h of HOURS) {
          const evening = h >= 18 && h <= 22;
          const r = Math.random();
          const status = evening
            ? (r < 0.75 ? 'green' : r < 0.9 ? 'yellow' : 'red')
            : (r < 0.2 ? 'green' : r < 0.3 ? 'yellow' : 'red');
          cells.push({ date: d, hour: h, status });
        }
      }
      await api(`/players/${p.id}/availability/${phase.id}`, {
        method: 'PUT',
        body: { cells },
      });
    }
  }

  console.log('✅ Fertig! Alle Demo-Daten wurden erfolgreich auf den Live-Server übertragen.');
})().catch((err) => {
  console.error('Fehler beim Seeden:', err);
  process.exit(1);
});
