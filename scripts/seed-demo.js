'use strict';
/*
 * Demo-Daten anlegen:
 * Legt 8 Teams à 3 Spieler, Gruppenphasen-Paarungen (Woche 1) und zufällige Verfügbarkeiten an.
 */
const { HOURS, getPhase, phaseDates } = require('../public/phases.js');

const TEAMS = {
  'Team Alpha': ['Max Mustermann', 'Lena Krüger', 'Jonas Weber'],
  'Team Bravo': ['Sophie Becker', 'Paul Schulz', 'Mia Hoffmann'],
  'Team Charlie': ['Leon Fischer', 'Emma Wagner', 'Finn Schäfer'],
  'Team Delta': ['Hannah Koch', 'Noah Richter', 'Lea Klein'],
  'Team Echo': ['Elias Wolf', 'Clara Neumann', 'Ben Schwarz'],
  'Team Foxtrot': ['Marie Zimmermann', 'Luis Braun', 'Lina Hartmann'],
  'Team Golf': ['Felix Lange', 'Ida Schmitt', 'Theo Krause'],
  'Team Hotel': ['Nora Meier', 'Anton Lehmann', 'Ella König'],
};

async function seedDemoData(db) {
  const existing = await db.all('SELECT id FROM teams');
  if (existing.length) {
    console.log('Es existieren bereits Teams – bestehende Daten bleiben erhalten.');
    return { ok: true, skipped: true };
  }
  const teamIds = [];
  for (const [name, players] of Object.entries(TEAMS)) {
    const t = await db.get('INSERT INTO teams (name) VALUES (?) RETURNING id', [name]);
    teamIds.push(t.id);
    for (const p of players) {
      await db.get('INSERT INTO players (name, team_id) VALUES (?, ?) RETURNING id', [p, t.id]);
    }
  }
  for (let i = 0; i < teamIds.length; i += 2) {
    await db.get('INSERT INTO matchups (phase_id, team_a_id, team_b_id) VALUES (?, ?, ?) RETURNING id', [
      'w1-group',
      teamIds[i],
      teamIds[i + 1],
    ]);
  }
  const phase = getPhase('w1-group');
  const players = await db.all('SELECT id FROM players');
  for (const p of players) {
    const rows = [];
    for (const d of phaseDates(phase)) {
      for (const h of HOURS) {
        const evening = h >= 18 && h <= 22;
        const r = Math.random();
        const status = evening
          ? (r < 0.75 ? 'green' : r < 0.9 ? 'yellow' : 'red')
          : (r < 0.2 ? 'green' : r < 0.3 ? 'yellow' : 'red');
        rows.push([p.id, phase.id, d, h, status]);
      }
    }
    const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
    await db.run(
      `INSERT INTO availabilities (player_id, phase_id, date, hour, status) VALUES ${placeholders}`,
      rows.flat()
    );
  }
  console.log(`Demo-Daten angelegt: ${teamIds.length} Teams, ${players.length} Spieler, ${teamIds.length / 2} Paarungen.`);
  return { ok: true, teams: teamIds.length, players: players.length };
}

if (require.main === module) {
  try { process.loadEnvFile(); } catch { /* ignore */ }
  const { initDb } = require('../db');
  (async () => {
    const db = await initDb();
    await seedDemoData(db);
    process.exit(0);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { seedDemoData, TEAMS };
