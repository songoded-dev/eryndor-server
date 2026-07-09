"use strict";

// Postgres-backed persistence for Eryndor accounts + character saves. Exposes the exact
// same interface as store-json.js, so nothing else in the server changes. Selected by
// store.js when DATABASE_URL is set (e.g. a free Neon/Supabase Postgres on Render, whose
// data survives restarts - unlike Render's ephemeral disk that the JSON store would use).
//
// Design notes:
//  - Users are cached in memory (loaded once at init, written through on createUser) so
//    getUserByName/getUserById stay SYNCHRONOUS, which server.js relies on. This mirrors
//    the JSON store's in-memory `users` mirror. Assumes a single server instance (fine for
//    this deployment); a multi-instance setup would need cache invalidation.
//  - Character saves are one row per (user_id, slot), so each save is an atomic upsert of a
//    single slot - the read-modify-write race the JSON store needs a lock for cannot happen.
//
// A "user" record is { id, name, nameLower, salt, hash, createdAt }.

const crypto = require("crypto");
const { Pool } = require("pg");

let pool = null;
let users = {}; // id -> user (in-memory cache)

function rowToUser(row) {
  return {
    id: row.id,
    name: row.name,
    nameLower: row.name_lower,
    salt: row.salt,
    hash: row.hash,
    createdAt: Number(row.created_at)
  };
}

async function init() {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Hosted Postgres (Neon/Supabase/Render) requires TLS. rejectUnauthorized:false accepts
    // the provider's cert without bundling a CA - standard for these managed services.
    ssl: { rejectUnauthorized: false }
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      name_lower  TEXT NOT NULL UNIQUE,
      salt        TEXT NOT NULL,
      hash        TEXT NOT NULL,
      created_at  BIGINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saves (
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slot        INTEGER NOT NULL,
      data        JSONB NOT NULL,
      updated_at  BIGINT NOT NULL,
      PRIMARY KEY (user_id, slot)
    )
  `);

  const { rows } = await pool.query("SELECT id, name, name_lower, salt, hash, created_at FROM users");
  users = {};
  for (const row of rows) users[row.id] = rowToUser(row);
}

function getUserByName(name) {
  if (typeof name !== "string") return null;
  const key = name.toLowerCase();
  for (const user of Object.values(users)) {
    if (user.nameLower === key) return user;
  }
  return null;
}

function getUserById(id) {
  return users[id] || null;
}

// Returns the new user, or null if the name is taken. The cache check is a fast reject;
// the UNIQUE(name_lower) constraint is the real guard - if two registrations for the same
// name race past the cache check, one INSERT wins and the other raises a unique violation
// (code 23505), which we translate to null (name taken) rather than a 500.
async function createUser({ name, salt, hash }) {
  if (getUserByName(name)) return null;
  const user = {
    id: crypto.randomUUID(),
    name,
    nameLower: name.toLowerCase(),
    salt,
    hash,
    createdAt: Date.now()
  };
  try {
    await pool.query(
      "INSERT INTO users (id, name, name_lower, salt, hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [user.id, user.name, user.nameLower, user.salt, user.hash, user.createdAt]
    );
  } catch (err) {
    if (err.code === "23505") return null; // unique_violation: name taken (race)
    throw err;
  }
  users[user.id] = user;
  return user;
}

async function listCharacters(userId) {
  const { rows } = await pool.query("SELECT slot, data FROM saves WHERE user_id = $1", [userId]);
  const chars = {};
  for (const row of rows) chars[String(row.slot)] = row.data;
  return chars;
}

// Atomic per-slot upsert - no read-modify-write, so concurrent saves to different slots are
// independent and two saves to the same slot are just last-write-wins on that one row.
async function saveCharacter(userId, slot, data) {
  await pool.query(
    `INSERT INTO saves (user_id, slot, data, updated_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, slot) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
    [userId, Number(slot), JSON.stringify(data), Date.now()]
  );
}

async function deleteCharacter(userId, slot) {
  await pool.query("DELETE FROM saves WHERE user_id = $1 AND slot = $2", [userId, Number(slot)]);
}

module.exports = {
  init,
  getUserByName,
  getUserById,
  createUser,
  listCharacters,
  saveCharacter,
  deleteCharacter
};
