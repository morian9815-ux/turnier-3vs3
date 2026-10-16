'use strict';
/*
 * Turnier-Teilnehmer (18 Teams, 53 Spieler)
 */
const { TEAMS } = require('./seed-teams.js');

async function seedDemoData(db) {
  const existing = await db.all('SELECT id FROM teams');
  if (existing.length) {
    console.log('Es existieren bereits Teams – bestehende Daten bleiben erhalten.');
    return { ok: true, skipped: true };
  }
  const teamIds = [];
  let playerCount = 0;
  for (const [name, players] of Object.entries(TEAMS)) {
    const t = await db.get('INSERT INTO teams (name) VALUES (?) RETURNING id', [name]);
    teamIds.push(t.id);
    for (const p of players) {
      await db.get('INSERT INTO players (name, team_id) VALUES (?, ?) RETURNING id', [p, t.id]);
      playerCount++;
    }
  }
  console.log(`Turnier-Teams angelegt: ${teamIds.length} Teams, ${playerCount} Spieler.`);
  return { ok: true, teams: teamIds.length, players: playerCount };
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
