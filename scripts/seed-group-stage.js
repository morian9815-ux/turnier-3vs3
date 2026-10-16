'use strict';
const { HOURS, getPhase, phaseDates } = require('../public/phases.js');

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

  // 1. Teams & Spieler laden
  const teams = await api('/teams');
  console.log(`${teams.length} Teams geladen.`);
  if (teams.length < 18) {
    throw new Error(`Erwartet 18 Teams, gefunden: ${teams.length}`);
  }

  // 2. Bestehende Paarungen löschen
  const oldMatchups = await api('/matchups');
  console.log(`Lösche ${oldMatchups.length} alte Paarungen …`);
  for (const m of oldMatchups) {
    await api(`/matchups/${m.id}`, { method: 'DELETE', token });
  }

  // 3. Genau 2 Paarungen pro Team in der Gruppenphase erstellen
  // Woche 1 (w1-group): 9 Paarungen (Team 0 vs 1, 2 vs 3, ...)
  // Woche 2 (w2-group): 9 Paarungen (Team 0 vs 2, 1 vs 3, ...)
  console.log('Erstelle je 2 Gruppenphasen-Paarungen pro Team (Woche 1 & Woche 2) …');

  const round1 = [];
  for (let i = 0; i < teams.length; i += 2) {
    round1.push([teams[i], teams[i + 1]]);
  }

  const round2 = [];
  // Zyklischer Versatz für Runde 2, damit jedes Team einen neuen Gegner hat
  for (let i = 0; i < teams.length; i += 2) {
    const a = teams[i];
    const b = teams[(i + 3) % teams.length];
    round2.push([a, b]);
  }

  for (const [ta, tb] of round1) {
    await api('/matchups', {
      method: 'POST',
      body: { phase_id: 'w1-group', team_a_id: ta.id, team_b_id: tb.id },
      token,
    });
    console.log(`  [Woche 1] ${ta.name} vs. ${tb.name}`);
  }

  for (const [ta, tb] of round2) {
    await api('/matchups', {
      method: 'POST',
      body: { phase_id: 'w2-group', team_a_id: ta.id, team_b_id: tb.id },
      token,
    });
    console.log(`  [Woche 2] ${ta.name} vs. ${tb.name}`);
  }

  // 4. Testzeiten für JEDEN Spieler in der gesamten Gruppenphase (Woche 1 & Woche 2) eintragen
  const phases = [getPhase('w1-group'), getPhase('w2-group')];
  const allPlayers = await api('/players');
  console.log(`\nGeneriere Kalender-Testzeiten für alle ${allPlayers.length} Spieler (Woche 1 & 2) …`);

  for (const phase of phases) {
    const dates = phaseDates(phase);
    console.log(`  Verarbeite ${phase.name} (${phase.subtitle}) – ${dates.length} Tage …`);

    for (let pIdx = 0; pIdx < allPlayers.length; pIdx++) {
      const p = allPlayers[pIdx];
      const cells = [];

      for (const d of dates) {
        const dayOfWeek = new Date(d + 'T00:00:00Z').getUTCDay(); // 0 = So, 6 = Sa
        const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

        for (const h of HOURS) {
          // Realistisches Muster:
          // Werktags 19-22 Uhr: Hohe Verfügbarkeit (80% grün, 10% gelb)
          // Wochenende 14-23 Uhr: Sehr hohe Verfügbarkeit (85% grün, 10% gelb)
          // Vormittags/Nachmittags unter der Woche: meist rot
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

          cells.push({ date: d, hour: h, status });
        }
      }

      await api(`/players/${p.id}/availability/${phase.id}`, {
        method: 'PUT',
        body: { cells },
      });

      if ((pIdx + 1) % 10 === 0 || pIdx === allPlayers.length - 1) {
        console.log(`    ${pIdx + 1}/${allPlayers.length} Spieler eingetragen …`);
      }
    }
  }

  console.log('\n🎉 Fertig! Alle 18 Teams haben 2 Paarungen und alle 53 Spieler haben Zeiten für die gesamte Gruppenphase!');
})().catch((err) => {
  console.error('Fehler:', err);
  process.exit(1);
});
