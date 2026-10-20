'use strict';
const fs = require('fs');
const path = require('path');

const LOGOS_DIR = path.join(__dirname, '..', 'Team Logos');
const ALLOWED_EXT = new Set(['.webp', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.avif']);

function logoUrlFromFilename(filename) {
  if (!filename) return null;
  if (filename.startsWith('/') || filename.startsWith('http://') || filename.startsWith('https://') || filename.startsWith('data:')) {
    return filename;
  }
  return '/team-logos/' + encodeURIComponent(filename);
}

function listAvailableLogos() {
  try {
    if (!fs.existsSync(LOGOS_DIR)) return [];
    const files = fs.readdirSync(LOGOS_DIR);
    return files
      .filter((f) => ALLOWED_EXT.has(path.extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }))
      .map((filename) => ({
        filename,
        name: path.basename(filename, path.extname(filename)),
        url: logoUrlFromFilename(filename),
      }));
  } catch {
    return [];
  }
}

function cleanBase(str) {
  return String(str || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/\?\?\?/g, ' fragezeichen ')
    .replace(/\bdrei\b/g, '3')
    .replace(/['’‘`´]/g, '');
}

function normFull(str) {
  return cleanBase(str).replace(/[^a-z0-9]+/g, '');
}

function normCore(str) {
  return cleanBase(str)
    .replace(/^(die|the|der|das)\s+/i, '')
    .replace(/\s+\d+([._]\d+)?$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

function wordInitials(str) {
  const words = cleanBase(str)
    .replace(/[^a-z0-9\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length < 3) return '';
  return words.map((w) => w[0]).join('');
}

function matchLogoForTeamName(teamName, logos = listAvailableLogos()) {
  if (!teamName || !logos.length) return null;
  const tFull = normFull(teamName);
  const tCore = normCore(teamName);
  const tInit = wordInitials(teamName);

  // 1. Exakter Treffer (normFull)
  for (const l of logos) {
    if (normFull(l.name) === tFull) return l.url;
  }
  // 2. Kern-Treffer ohne Artikel / Versionsnummer (normCore)
  for (const l of logos) {
    const lCore = normCore(l.name);
    if (lCore && tCore && lCore === tCore) return l.url;
  }
  // 3. Initialen-Treffer (z. B. "d.S.w.n.w.E.t." <-> "denn sie wissen nicht was er tut")
  for (const l of logos) {
    const lInit = wordInitials(l.name);
    const lFull = normFull(l.name);
    if ((lInit && lInit === tFull) || (tInit && tInit === lFull)) return l.url;
  }
  return null;
}

async function autoAssignTeamLogos(db, { overwrite = false } = {}) {
  const logos = listAvailableLogos();
  const teams = await db.all('SELECT id, name, logo FROM teams ORDER BY id');
  let updated = 0;
  for (const t of teams) {
    if (t.logo && !overwrite) continue;
    const matchedUrl = matchLogoForTeamName(t.name, logos);
    if (matchedUrl && matchedUrl !== t.logo) {
      await db.run('UPDATE teams SET logo = ? WHERE id = ?', [matchedUrl, t.id]);
      updated++;
    }
  }
  return { updated, totalTeams: teams.length, availableLogos: logos.length };
}

module.exports = {
  LOGOS_DIR,
  ALLOWED_EXT,
  logoUrlFromFilename,
  listAvailableLogos,
  matchLogoForTeamName,
  autoAssignTeamLogos,
};
