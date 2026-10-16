'use strict';
/*
 * Turnier-Teilnehmer (18 Teams, 53 Spieler)
 */
const TEAMS = {
  'Die Normalerweisen': ['LuHa101', 'Seebaer1605', 'Chris0815'],
  'Die dreisten Drei': ['BlackHayate', 'Lalle'],
  'The Double Boogeys': ['Bimmi', 'Kamikazehexe', 'serschnee'],
  'Die Rasen-Rambos': ['SofakissenFD', 'Yolandi', 'Cedien777'],
  'Die drei ???': ['Eigi', 'Baco', 'Steffen'],
  'Golfbusters': ['Simon', 'PascaLaVista', 'Sonzok'],
  'Ballgefühl': ['Elle64', 'Eurosparr', 'Artox'],
  'd.S.w.n.w.E.t.': ['Pinguin', 'Cyber_C', 'Brombeerfee'],
  'Try‘n Error 3': ['Charly', 'JoyLali', 'Diabolic_Sign'],
  'Die Flauschgranaten': ['poki', 'Werneroi', 'DerDaniel82'],
  'Blackdevils': ['Pat_71', 'Jaxmi79', 'Mr.Kazimir'],
  'PARFECT LADIES': ['Sunny258', 'Marie', 'IRENE_irkis'],
  'Ganz schön 3st': ['zet1971', 'Bolle', 'scholzi'],
  'Foxhunters': ['Leviathan', 'Mo', 'Foxy'],
  'DIE LOCHDIEBE': ['Gio', 'Biagio', 'ferju1985'],
  'Pokerface 2.0': ['Revierpower', 'AlexConrad', 'Martin Carboni'],
  'Schlagfertig': ['TwizyNicky', 'Ernie', 'Handrake'],
  'MIGHTY MACHINES 3.0': ['Eisenseite', 'Cyphex', 'BuckRogers'],
};

async function seedTournamentTeams(db) {
  const existing = await db.all('SELECT id FROM teams');
  if (existing.length) {
    console.log('Bestehende Teams vorhanden – werden nicht überschrieben.');
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
  console.log(`Turnierdaten angelegt: ${teamIds.length} Teams, ${playerCount} Spieler.`);
  return { ok: true, teams: teamIds.length, players: playerCount };
}

module.exports = { TEAMS, seedTournamentTeams };
