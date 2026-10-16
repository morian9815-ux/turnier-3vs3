'use strict';
const { TEAMS } = require('./seed-teams.js');

const TARGET_URL = process.env.TARGET_URL || 'https://turnier-3vs3turnier-3vs3.onrender.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin2026';

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

  // 1. Alle alten Paarungen löschen
  const oldMatchups = await api('/matchups');
  console.log(`Lösche ${oldMatchups.length} alte Paarungen …`);
  for (const m of oldMatchups) {
    await api(`/matchups/${m.id}`, { method: 'DELETE', token });
  }

  // 2. Alle alten Teams löschen (Spieler & Availabilities werden kaskadiert gelöscht)
  const oldTeams = await api('/teams');
  console.log(`Lösche ${oldTeams.length} alte Teams …`);
  for (const t of oldTeams) {
    await api(`/teams/${t.id}`, { method: 'DELETE', token });
  }

  // 3. Alle übrigen Spieler ohne Team löschen
  const oldPlayers = await api('/players');
  console.log(`Lösche ${oldPlayers.length} verbliebene alte Spieler …`);
  for (const p of oldPlayers) {
    await api(`/players/${p.id}`, { method: 'DELETE', token });
  }

  // 4. Neue 18 Teams & 53 Spieler anlegen
  console.log('Erstelle die 18 offiziellen Teams und Spieler …');
  let createdPlayers = 0;
  for (const [teamName, playerNames] of Object.entries(TEAMS)) {
    const team = await api('/teams', { method: 'POST', body: { name: teamName }, token });
    for (const pName of playerNames) {
      await api('/players', { method: 'POST', body: { name: pName, team_id: team.id }, token });
      createdPlayers++;
    }
    console.log(`✓ ${teamName} (${playerNames.length} Spieler): ${playerNames.join(', ')}`);
  }

  console.log(`\n🎉 Fertig! ${Object.keys(TEAMS).length} Teams und ${createdPlayers} Spieler sind jetzt live auf ${TARGET_URL}!`);
})().catch((err) => {
  console.error('Fehler beim Aktualisieren:', err);
  process.exit(1);
});
