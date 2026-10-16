'use strict';
/*
 * Turnier-Teilnehmer (18 Teams, 53 Spieler)
 * Automatische Initialisierung mit 18 Teams, Gruppenphase-Paarungen und Testzeiten.
 */
const { TEAMS } = require('./seed-teams.js');
const { HOURS, getPhase, phaseDates } = require('../public/phases.js');

async function seedDemoData(db) {
  const existing = await db.all('SELECT id FROM teams');
  if (existing.length) {
    console.log('Es existieren bereits Teams – bestehende Daten bleiben erhalten.');
    return { ok: true, skipped: true };
  }

  return await db.tx(async (tx) => {
    const createdTeams = [];
    let playerCount = 0;
    const allPlayerIds = [];

    // 1. Teams und Spieler anlegen
    for (const [name, players] of Object.entries(TEAMS)) {
      const t = await tx.get('INSERT INTO teams (name) VALUES (?) RETURNING id', [name]);
      const pIds = [];
      for (const p of players) {
        const row = await tx.get('INSERT INTO players (name, team_id) VALUES (?, ?) RETURNING id', [p, t.id]);
        pIds.push(row.id);
        allPlayerIds.push(row.id);
        playerCount++;
      }
      createdTeams.push({ id: t.id, name, playerIds: pIds });
    }

    // 2. Gruppenphase-Paarungen (je 2 Paarungen pro Team: Woche 1 und Woche 2)
    // Runde 1 (w1-group): Team 0 vs 1, 2 vs 3, ...
    for (let i = 0; i < createdTeams.length; i += 2) {
      await tx.run('INSERT INTO matchups (phase_id, team_a_id, team_b_id) VALUES (?, ?, ?)', [
        'w1-group',
        createdTeams[i].id,
        createdTeams[i + 1].id,
      ]);
    }

    // Runde 2 (w2-group): Zyklischer Versatz
    for (let i = 0; i < createdTeams.length; i += 2) {
      const a = createdTeams[i];
      const b = createdTeams[(i + 3) % createdTeams.length];
      await tx.run('INSERT INTO matchups (phase_id, team_a_id, team_b_id) VALUES (?, ?, ?)', [
        'w2-group',
        a.id,
        b.id,
      ]);
    }

    // 3. Testverfügbarkeiten für alle Spieler in Woche 1 und Woche 2 generieren
    const phases = [getPhase('w1-group'), getPhase('w2-group')];
    for (const phase of phases) {
      const dates = phaseDates(phase);
      for (const pid of allPlayerIds) {
        for (const d of dates) {
          const dayOfWeek = new Date(d + 'T00:00:00Z').getUTCDay();
          const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

          for (const h of HOURS) {
            let status;
            const r = Math.random();
            if (isWeekend) {
              if (h >= 14 && h <= 23) {
                status = r < 0.85 ? 'green' : r < 0.95 ? 'yellow' : 'red';
              } else {
                status = r < 0.35 ? 'green' : r < 0.5 ? 'yellow' : 'red';
              }
            } else {
              if (h >= 19 && h <= 22) {
                status = r < 0.82 ? 'green' : r < 0.92 ? 'yellow' : 'red';
              } else if (h === 18 || h === 23) {
                status = r < 0.5 ? 'green' : r < 0.75 ? 'yellow' : 'red';
              } else {
                status = r < 0.12 ? 'green' : r < 0.22 ? 'yellow' : 'red';
              }
            }

            await tx.run(
              'INSERT INTO availabilities (player_id, phase_id, date, hour, status) VALUES (?, ?, ?, ?, ?)',
              [pid, phase.id, d, h, status]
            );
          }
        }
      }
    }

    console.log(`Initialisierung abgeschlossen: ${createdTeams.length} Teams, ${playerCount} Spieler, 18 Paarungen und Kalenderdaten.`);
    return { ok: true, teams: createdTeams.length, players: playerCount, matchups: 18 };
  });
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
