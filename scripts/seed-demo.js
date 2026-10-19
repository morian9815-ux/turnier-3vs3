'use strict';
/*
 * Turnier-Teilnehmer (18 Teams, 53 Spieler) & Multi-Szenario-Testdaten
 * Jedes der 18 Teams (und damit jeder der 53 Spieler) erlebt beim Login sofort alle 5 Szenarien:
 *   1. 🏆 Fester Spieltermin (bereits verbindlich geeinigt & gesperrt)
 *   2. 🤝 Alle 6 Spieler eingetragen – offen für neuen Vorschlag (inkl. 📺 Stream- & Parallelspiel-Radar)
 *   3. 📩 Eingehender Terminvorschlag vom Gegner (2–3 Termine zur Auswahl: bestätigen oder Gegenvorschlag)
 *   4. ⏳ Eigener gesendeter Terminvorschlag (wartet auf Bestätigung durch das gegnerische Team)
 *   5. ⚠️ Noch nicht alle 6 Spieler eingetragen (4/6 abgestimmt, fehlende Spieler namentlich markiert)
 */
const { TEAMS } = require('./seed-teams.js');
const { HOURS, getPhase, phaseDates } = require('../public/phases.js');

const SEED_MIN_MATCHUPS = 40;

// Deterministischer Pseudo-Zufallsgenerator für reproduzierbare, realistische Testdaten
function createRng(seed = 20261109) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const WEEKDAYS_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
function fmtSlot(slotKey) {
  if (!slotKey || !String(slotKey).includes('|')) return String(slotKey || '');
  const [d, hStr] = String(slotKey).split('|');
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  const wd = WEEKDAYS_SHORT[dt.getUTCDay()] || '';
  const hh = String(Number(hStr)).padStart(2, '0');
  return `${wd}, ${String(day).padStart(2, '0')}.${String(m).padStart(2, '0')}. · ${hh}:00 Uhr`;
}

async function seedDemoData(db, { force = false } = {}) {
  const existingTeams = await db.all('SELECT id FROM teams');
  const existingMatchups = await db.all('SELECT id FROM matchups');
  let existingNotifs = [];
  try {
    existingNotifs = await db.all('SELECT id FROM notifications LIMIT 1');
  } catch { /* Tabelle ggf. neu */ }

  if (!force && existingTeams.length > 0 && existingMatchups.length >= SEED_MIN_MATCHUPS && existingNotifs.length > 0) {
    console.log('Multi-Szenario-Testdaten sind bereits vorhanden – bestehende Daten bleiben erhalten.');
    return { ok: true, skipped: true };
  }

  const rand = createRng(20261109);

  return await db.tx(async (tx) => {
    // Vorhandene Daten sauber zurücksetzen, falls ein älterer Stand oder force=true vorliegt
    try { await tx.run('DELETE FROM notifications'); } catch { /* ignore */ }
    await tx.run('DELETE FROM availabilities');
    await tx.run('DELETE FROM matchups');
    await tx.run('DELETE FROM players');
    await tx.run('DELETE FROM teams');
    try { await tx.run('DELETE FROM sqlite_sequence'); } catch { /* PostgreSQL nutzt eigene Sequenzen */ }

    const createdTeams = [];
    let playerCount = 0;

    // 1. Alle 18 realen Teams und 53 Spieler anlegen
    for (const [name, players] of Object.entries(TEAMS)) {
      const t = await tx.get('INSERT INTO teams (name) VALUES (?) RETURNING id', [name]);
      const pObjs = [];
      for (const pName of players) {
        const row = await tx.get('INSERT INTO players (name, team_id) VALUES (?, ?) RETURNING id', [pName, t.id]);
        pObjs.push({ id: row.id, name: pName, team_id: t.id });
        playerCount++;
      }
      createdTeams.push({ id: t.id, name, players: pObjs });
    }

    const addNotifs = async (playerIds, { kind, title, body, phase_id, matchup_id, is_read = 0, created_at }) => {
      for (const pid of playerIds) {
        await tx.run(
          `INSERT INTO notifications (player_id, kind, title, body, phase_id, matchup_id, is_read, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [pid, kind, title, body, phase_id, matchup_id, is_read ? 1 : 0, created_at]
        );
      }
    };

    // Garantierte gemeinsame Abend-Slots für Woche 1 und Woche 2, damit jede Paarung
    // sowohl perfekte (6/6 Grün) als auch mögliche (Grün + Gelb) Termine hat:
    const w1Perfect = new Set([
      '2026-11-09|20',
      '2026-11-10|19',
      '2026-11-10|20',
      '2026-11-11|20',
      '2026-11-12|20',
      '2026-11-13|20',
      '2026-11-14|19',
      '2026-11-14|21',
      '2026-11-15|18',
      '2026-11-15|20',
    ]);
    const w1Maybe = new Set([
      '2026-11-09|21',
      '2026-11-11|19',
      '2026-11-12|21',
      '2026-11-13|19',
      '2026-11-14|20',
      '2026-11-15|19',
    ]);

    const w2Perfect = new Set([
      '2026-11-16|20',
      '2026-11-17|19',
      '2026-11-17|20',
      '2026-11-18|20',
      '2026-11-19|20',
      '2026-11-20|20',
      '2026-11-21|19',
      '2026-11-21|21',
      '2026-11-22|18',
      '2026-11-22|20',
    ]);
    const w2Maybe = new Set([
      '2026-11-16|21',
      '2026-11-18|19',
      '2026-11-19|21',
      '2026-11-20|19',
      '2026-11-21|20',
      '2026-11-22|19',
    ]);

    const w3Perfect = new Set([
      '2026-11-24|20',
      '2026-11-26|20',
      '2026-11-27|20',
      '2026-11-28|19',
      '2026-11-29|20',
    ]);

    const insertPhaseAvailability = async (player, pIdxInTeam, phase, perfectSet, maybeSet) => {
      const dates = phaseDates(phase);
      const rows = [];
      for (const d of dates) {
        const dayOfWeek = new Date(d + 'T00:00:00Z').getUTCDay();
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        for (const h of HOURS) {
          const slotKey = `${d}|${h}`;
          let status;
          if (perfectSet && perfectSet.has(slotKey)) {
            status = 'green';
          } else if (maybeSet && maybeSet.has(slotKey)) {
            status = pIdxInTeam === 0 ? 'yellow' : 'green';
          } else {
            const r = rand();
            if (isWeekend) {
              if (h >= 14 && h <= 22) status = r < 0.65 ? 'green' : r < 0.85 ? 'yellow' : 'red';
              else status = r < 0.25 ? 'green' : r < 0.42 ? 'yellow' : 'red';
            } else if (h >= 19 && h <= 22) {
              status = r < 0.62 ? 'green' : r < 0.82 ? 'yellow' : 'red';
            } else if (h === 18 || h === 23) {
              status = r < 0.38 ? 'green' : r < 0.65 ? 'yellow' : 'red';
            } else {
              status = r < 0.08 ? 'green' : r < 0.18 ? 'yellow' : 'red';
            }
          }
          rows.push([player.id, phase.id, d, h, status]);
        }
      }
      const placeholders = rows.map(() => '(?, ?, ?, ?, ?)').join(', ');
      await tx.run(
        `INSERT INTO availabilities (player_id, phase_id, date, hour, status) VALUES ${placeholders}`,
        rows.flat()
      );
    };

    // 2. Verfügbarkeiten eintragen:
    // - Woche 1 (w1-group) & Woche 2 (w2-group): ALLE 53 Spieler haben gespeichert
    // - Woche 3 (w3-r16): Pro Team fehlt jeweils der letzte Spieler (Szenario 5: "Wartet noch auf Spieler-Zeiten")
    const phaseW1 = getPhase('w1-group');
    const phaseW2 = getPhase('w2-group');
    const phaseW3 = getPhase('w3-r16');

    for (const team of createdTeams) {
      for (let pIdx = 0; pIdx < team.players.length; pIdx++) {
        const player = team.players[pIdx];
        await insertPhaseAvailability(player, pIdx, phaseW1, w1Perfect, w1Maybe);
        await insertPhaseAvailability(player, pIdx, phaseW2, w2Perfect, w2Maybe);
        // In Woche 3 speichert der letzte Spieler jedes Teams absichtlich noch NICHT:
        if (pIdx < team.players.length - 1) {
          await insertPhaseAvailability(player, pIdx, phaseW3, w3Perfect, null);
        }
      }
    }

    let matchupCount = 0;

    // -------------------------------------------------------------------------
    // SZENARIO 1 (w1-group, 9 Paarungen):
    // 🏆 Fester Spieltermin steht bereits verbindlich fest (Team-Handshake abgeschlossen)
    // -------------------------------------------------------------------------
    const w1ConfirmedSlots = [
      '2026-11-10|20', // Di, 10.11. 20:00
      '2026-11-11|20', // Mi, 11.11. 20:00
      '2026-11-12|20', // Do, 12.11. 20:00
      '2026-11-13|20', // Fr, 13.11. 20:00
      '2026-11-14|19', // Sa, 14.11. 19:00
      '2026-11-14|21', // Sa, 14.11. 21:00
      '2026-11-15|18', // So, 15.11. 18:00
      '2026-11-15|20', // So, 15.11. 20:00
      '2026-11-09|20', // Mo, 09.11. 20:00
    ];
    for (let i = 0; i < 18; i += 2) {
      const teamA = createdTeams[i];
      const teamB = createdTeams[i + 1];
      const chosen = w1ConfirmedSlots[i / 2];
      const propList = [chosen, '2026-11-10|19', '2026-11-14|20'].filter((v, idx, arr) => arr.indexOf(v) === idx).slice(0, 3);
      const mRow = await tx.get(
        `INSERT INTO matchups (
          phase_id, team_a_id, team_b_id,
          proposed_slots, proposed_by_team_id, proposed_by_player_name,
          confirmed_slot, confirmed_by_player_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [
          'w1-group',
          teamA.id,
          teamB.id,
          JSON.stringify(propList),
          teamA.id,
          teamA.players[0].name,
          chosen,
          teamB.players[0].name,
        ]
      );
      matchupCount++;

      // Bereits gelesene ältere Historien-Nachricht (Terminvorschlag vor der Bestätigung):
      const allSixIds = [...teamA.players.map((p) => p.id), ...teamB.players.map((p) => p.id)];
      await addNotifs(allSixIds, {
        kind: 'teammate_availability',
        title: `Gruppenphase · Woche 1: Zeiten von ${teamA.players[0].name} gespeichert`,
        body: `${teamA.players[0].name} (${teamA.name}) hat seine Verfügbarkeiten für „Gruppenphase · Woche 1“ eingetragen.`,
        phase_id: 'w1-group',
        matchup_id: mRow.id,
        is_read: 1,
        created_at: '2026-11-07T16:20:00.000Z',
      });

      // Ungelesene Bestätigungs-Nachricht (🎉 Grün) für alle außer dem bestätigenden Spieler (teamB.players[0]);
      // für teamB.players[0] als gelesen hinterlegen, da er selbst bestätigt hat:
      const otherFive = allSixIds.filter((id) => id !== teamB.players[0].id);
      await addNotifs(otherFive, {
        kind: 'match_confirmed',
        title: `Fester Spieltermin bestätigt: ${teamA.name} vs. ${teamB.name}`,
        body: `${teamB.players[0].name} (${teamB.name}) hat den Terminvorschlag angenommen! Euer Match in „Gruppenphase · Woche 1“ findet verbindlich am ${fmtSlot(chosen)} statt.`,
        phase_id: 'w1-group',
        matchup_id: mRow.id,
        is_read: 0,
        created_at: '2026-11-08T18:15:00.000Z',
      });
    }

    // -------------------------------------------------------------------------
    // SZENARIO 2 (w1-group, 9 Paarungen):
    // 🤝 Alle 6 Spieler haben eingetragen – Termin-Einigung bereit (noch kein Vorschlag gesendet)
    // -------------------------------------------------------------------------
    const scen2Pairs = [
      [1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 0],
    ];
    for (const [idxA, idxB] of scen2Pairs) {
      const teamA = createdTeams[idxA];
      const teamB = createdTeams[idxB];
      const mRow = await tx.get(
        'INSERT INTO matchups (phase_id, team_a_id, team_b_id) VALUES (?, ?, ?) RETURNING id',
        ['w1-group', teamA.id, teamB.id]
      );
      matchupCount++;

      // Ungelesene Nachricht (🔓 Blau): Alle 6 Spieler bereit!
      const allSixIds = [...teamA.players.map((p) => p.id), ...teamB.players.map((p) => p.id)];
      await addNotifs(allSixIds, {
        kind: 'all_6_ready',
        title: `Alle 6 Spieler bereit: ${teamA.name} vs. ${teamB.name}`,
        body: `Alle 6 Spieler haben ihre Zeiten für „Gruppenphase · Woche 1“ eingetragen! Ihr könnt euch ab sofort im Match-Abgleich auf einen Spieltermin einigen.`,
        phase_id: 'w1-group',
        matchup_id: mRow.id,
        is_read: 0,
        created_at: '2026-11-08T19:40:00.000Z',
      });
    }

    // -------------------------------------------------------------------------
    // SZENARIO 3 & 4 (w2-group, 18 Paarungen + 2 feste Showcase-Spiele für den Stream-Radar):
    // 📩 Eingehender Terminvorschlag vom Gegner (Bestätigen oder Gegenvorschlag testen)
    // ⏳ Eigener gesendeter Terminvorschlag (Wartet auf Antwort vom Gegner / Vorschlag ändern)
    // -------------------------------------------------------------------------
    const w2ShowcaseConfirmed = [
      { a: 0, b: 9, slot: '2026-11-17|20' },  // Di, 17.11. 20:00
      { a: 4, b: 13, slot: '2026-11-18|20' }, // Mi, 18.11. 20:00
    ];
    for (const sc of w2ShowcaseConfirmed) {
      const teamA = createdTeams[sc.a];
      const teamB = createdTeams[sc.b];
      await tx.run(
        `INSERT INTO matchups (
          phase_id, team_a_id, team_b_id,
          proposed_slots, proposed_by_team_id, proposed_by_player_name,
          confirmed_slot, confirmed_by_player_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'w2-group',
          teamA.id,
          teamB.id,
          JSON.stringify([sc.slot, '2026-11-20|20']),
          teamA.id,
          teamA.players[0].name,
          sc.slot,
          teamB.players[0].name,
        ]
      );
      matchupCount++;
    }

    const pickW2Proposals = (aIdx, bIdx, defList) => {
      if (aIdx === 0 || bIdx === 0 || aIdx === 9 || bIdx === 9) {
        return ['2026-11-18|20', '2026-11-20|20', '2026-11-22|19'];
      }
      if (aIdx === 4 || bIdx === 4 || aIdx === 13 || bIdx === 13) {
        return ['2026-11-17|20', '2026-11-19|20', '2026-11-21|20'];
      }
      return defList;
    };

    // Runde 2A: Gerade Teams (0, 2, ..., 16) schlagen 3 Termine an ungerade Teams (3, 5, ..., 1) vor
    const round2APairs = [
      [0, 3], [2, 5], [4, 7], [6, 9], [8, 11], [10, 13], [12, 15], [14, 17], [16, 1],
    ];
    const proposals2A = [
      ['2026-11-17|20', '2026-11-19|20', '2026-11-21|20'],
      ['2026-11-16|20', '2026-11-17|19', '2026-11-20|20'],
      ['2026-11-18|20', '2026-11-20|19', '2026-11-22|20'],
    ];
    for (let idx = 0; idx < round2APairs.length; idx++) {
      const [aIdx, bIdx] = round2APairs[idx];
      const teamA = createdTeams[aIdx];
      const teamB = createdTeams[bIdx];
      const slots = pickW2Proposals(aIdx, bIdx, proposals2A[idx % proposals2A.length]);
      const mRow = await tx.get(
        `INSERT INTO matchups (
          phase_id, team_a_id, team_b_id,
          proposed_slots, proposed_by_team_id, proposed_by_player_name
        ) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        [
          'w2-group',
          teamA.id,
          teamB.id,
          JSON.stringify(slots),
          teamA.id,
          teamA.players[0].name,
        ]
      );
      matchupCount++;

      const slotsTxt = slots.map(fmtSlot).join(' / ');
      // Gegner (teamB) bekommt 📩 Terminvorschlag erhalten (ungelesen):
      await addNotifs(teamB.players.map((p) => p.id), {
        kind: 'proposal_received',
        title: `Terminvorschlag von ${teamA.name}`,
        body: `${teamA.players[0].name} (${teamA.name}) hat euch 3 Terminvorschläge für „Gruppenphase · Woche 2“ geschickt: ${slotsTxt}. Bitte wählt einen Termin aus oder sendet einen Gegenvorschlag!`,
        phase_id: 'w2-group',
        matchup_id: mRow.id,
        is_read: 0,
        created_at: '2026-11-08T21:10:00.000Z',
      });
      // Eigene Mitspieler von teamA.players[0] bekommen 👥 Mitspieler-Vorschlag (ungelesen):
      const teamAMates = teamA.players.slice(1).map((p) => p.id);
      await addNotifs(teamAMates, {
        kind: 'teammate_proposed',
        title: `Mitspieler ${teamA.players[0].name} hat Termine vorgeschlagen`,
        body: `Dein Mitspieler ${teamA.players[0].name} hat ${teamB.name} folgende Termine für „Gruppenphase · Woche 2“ vorgeschlagen: ${slotsTxt}.`,
        phase_id: 'w2-group',
        matchup_id: mRow.id,
        is_read: 0,
        created_at: '2026-11-08T20:30:00.000Z',
      });
    }

    // Runde 2B: Ungerade Teams (1, 3, ..., 17) schlagen 3 Termine an gerade Teams (4, 6, ..., 2) vor
    const round2BPairs = [
      [1, 4], [3, 6], [5, 8], [7, 10], [9, 12], [11, 14], [13, 16], [15, 0], [17, 2],
    ];
    const proposals2B = [
      ['2026-11-18|20', '2026-11-20|20', '2026-11-22|19'],
      ['2026-11-17|20', '2026-11-19|21', '2026-11-21|19'],
      ['2026-11-16|20', '2026-11-18|19', '2026-11-22|20'],
    ];
    for (let idx = 0; idx < round2BPairs.length; idx++) {
      const [aIdx, bIdx] = round2BPairs[idx];
      const teamA = createdTeams[aIdx];
      const teamB = createdTeams[bIdx];
      const slots = pickW2Proposals(aIdx, bIdx, proposals2B[idx % proposals2B.length]);
      const mRow = await tx.get(
        `INSERT INTO matchups (
          phase_id, team_a_id, team_b_id,
          proposed_slots, proposed_by_team_id, proposed_by_player_name
        ) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        [
          'w2-group',
          teamA.id,
          teamB.id,
          JSON.stringify(slots),
          teamA.id,
          teamA.players[0].name,
        ]
      );
      matchupCount++;

      const slotsTxt = slots.map(fmtSlot).join(' / ');
      // Gegner (teamB) bekommt 📩 Terminvorschlag erhalten (ungelesen):
      await addNotifs(teamB.players.map((p) => p.id), {
        kind: 'proposal_received',
        title: `Terminvorschlag von ${teamA.name}`,
        body: `${teamA.players[0].name} (${teamA.name}) hat euch 3 Terminvorschläge für „Gruppenphase · Woche 2“ geschickt: ${slotsTxt}. Bitte wählt einen Termin aus oder sendet einen Gegenvorschlag!`,
        phase_id: 'w2-group',
        matchup_id: mRow.id,
        is_read: 0,
        created_at: '2026-11-08T21:15:00.000Z',
      });
      // Eigene Mitspieler von teamA.players[0] bekommen 👥 Mitspieler-Vorschlag (ungelesen):
      const teamAMates = teamA.players.slice(1).map((p) => p.id);
      await addNotifs(teamAMates, {
        kind: 'teammate_proposed',
        title: `Mitspieler ${teamA.players[0].name} hat Termine vorgeschlagen`,
        body: `Dein Mitspieler ${teamA.players[0].name} hat ${teamB.name} folgende Termine für „Gruppenphase · Woche 2“ vorgeschlagen: ${slotsTxt}.`,
        phase_id: 'w2-group',
        matchup_id: mRow.id,
        is_read: 0,
        created_at: '2026-11-08T20:35:00.000Z',
      });
    }

    // -------------------------------------------------------------------------
    // SZENARIO 5 (w3-r16, Achtelfinale · Woche 3, 9 Paarungen):
    // ⚠️ Noch nicht alle 6 Spieler haben ihre Zeiten eingetragen (4/6 abgestimmt)
    // -------------------------------------------------------------------------
    const scen5Pairs = [
      [0, 5], [1, 6], [2, 7], [3, 8], [4, 9], [10, 15], [11, 16], [12, 17], [13, 14],
    ];
    for (const [idxA, idxB] of scen5Pairs) {
      const teamA = createdTeams[idxA];
      const teamB = createdTeams[idxB];
      const mRow = await tx.get(
        'INSERT INTO matchups (phase_id, team_a_id, team_b_id) VALUES (?, ?, ?) RETURNING id',
        ['w3-r16', teamA.id, teamB.id]
      );
      matchupCount++;

      // Für Spieler[0] jedes Teams eine ungelesene Mitspieler-Nachricht von Spieler[1] in Woche 3,
      // damit auch Spieler[0] eine Team-Aktivitäts-Nachricht hat:
      for (const t of [teamA, teamB]) {
        if (t.players.length >= 2) {
          await addNotifs([t.players[0].id], {
            kind: 'teammate_availability',
            title: `Mitspieler ${t.players[1].name} hat Zeiten eingetragen`,
            body: `Dein Mitspieler ${t.players[1].name} hat seine Verfügbarkeiten für „Achtelfinale · Woche 3“ gespeichert.`,
            phase_id: 'w3-r16',
            matchup_id: mRow.id,
            is_read: 0,
            created_at: '2026-11-08T20:05:00.000Z',
          });
        }
      }
    }

    console.log(
      `Multi-Szenario-Initialisierung abgeschlossen: ${createdTeams.length} Teams, ${playerCount} Spieler, ${matchupCount} Paarungen (inkl. Nachrichtenzentrale für alle Spieler).`
    );
    return { ok: true, teams: createdTeams.length, players: playerCount, matchups: matchupCount };
  });
}

if (require.main === module) {
  try { process.loadEnvFile(); } catch { /* ignore */ }
  const { initDb } = require('../db');
  (async () => {
    const db = await initDb();
    await seedDemoData(db, { force: true });
    process.exit(0);
  })().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { seedDemoData, TEAMS, SEED_MIN_MATCHUPS };
