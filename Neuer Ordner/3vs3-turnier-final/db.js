'use strict';
/*
 * Datenbank-Schicht.
 *  - Ist DATABASE_URL gesetzt  -> PostgreSQL (z. B. Supabase, Neon, Render, Railway)  [empfohlen für die Cloud]
 *  - sonst                     -> SQLite-Datei (node:sqlite, eingebaut ab Node 22.13)  [lokal / Server mit Disk]
 * Beide Varianten bieten dieselbe Mini-API: all(), get(), run(), tx().
 * SQL wird mit "?"-Platzhaltern geschrieben und für Postgres automatisch in $1, $2, … umgewandelt.
 */
const path = require('path');
const fs = require('fs');

const SCHEMA_PG = `
CREATE TABLE IF NOT EXISTS teams (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id);
CREATE TABLE IF NOT EXISTS availabilities (
  id SERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  phase_id TEXT NOT NULL,
  date TEXT NOT NULL,
  hour INTEGER NOT NULL CHECK (hour BETWEEN 0 AND 23),
  status TEXT NOT NULL CHECK (status IN ('red', 'green', 'yellow')),
  UNIQUE (player_id, phase_id, date, hour)
);
CREATE INDEX IF NOT EXISTS idx_avail_phase ON availabilities(phase_id);
CREATE TABLE IF NOT EXISTS matchups (
  id SERIAL PRIMARY KEY,
  phase_id TEXT NOT NULL,
  team_a_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  team_b_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_matchups_phase ON matchups(phase_id);
`;

const SCHEMA_SQLITE = SCHEMA_PG.replace(/SERIAL PRIMARY KEY/g, 'INTEGER PRIMARY KEY AUTOINCREMENT');

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => '$' + ++i);
}

async function createPostgres(rawUrl) {
  const { Pool } = require('pg');
  let connectionString = rawUrl;
  // sslmode aus der URL entfernen, damit unsere SSL-Einstellung greift (Supabase/Neon-Zertifikate)
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('sslmode');
    connectionString = u.toString();
  } catch { /* URL unverändert verwenden */ }
  const isLocal = /@(localhost|127\.0\.0\.1)(:|\/)/.test(rawUrl);
  const ssl = process.env.PGSSL === 'disable' || isLocal ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString, ssl, max: Number(process.env.PG_POOL_MAX || 5) });

  const make = (runner) => ({
    all: async (sql, params = []) => (await runner.query(toPg(sql), params)).rows,
    get: async (sql, params = []) => (await runner.query(toPg(sql), params)).rows[0],
    run: async (sql, params = []) => ({ changes: (await runner.query(toPg(sql), params)).rowCount }),
  });

  await pool.query(SCHEMA_PG);

  const db = make(pool);
  db.kind = 'postgres';
  db.tx = async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(make(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
  return db;
}

function createSqlite() {
  const { DatabaseSync } = require('node:sqlite');
  const file = process.env.SQLITE_PATH || path.join(__dirname, 'data', 'turnier.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const sdb = new DatabaseSync(file);
  sdb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  sdb.exec(SCHEMA_SQLITE);

  const norm = (row) => (row ? { ...row } : row);
  const runner = {
    all: async (sql, params = []) => sdb.prepare(sql).all(...params).map(norm),
    get: async (sql, params = []) => norm(sdb.prepare(sql).get(...params)),
    run: async (sql, params = []) => ({ changes: Number(sdb.prepare(sql).run(...params).changes) }),
  };

  let queue = Promise.resolve();
  const db = { ...runner, kind: 'sqlite', file };
  db.tx = (fn) => {
    const p = queue.then(async () => {
      sdb.exec('BEGIN');
      try {
        const result = await fn(runner);
        sdb.exec('COMMIT');
        return result;
      } catch (err) {
        try { sdb.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    });
    queue = p.catch(() => {});
    return p;
  };
  return db;
}

async function initDb() {
  const url = process.env.DATABASE_URL;
  return url ? createPostgres(url) : createSqlite();
}

module.exports = { initDb };
