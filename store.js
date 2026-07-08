"use strict";

// Pluggable persistence for Eryndor accounts + character saves.
//
// This is the ONLY module that knows how data is physically stored. It currently
// uses atomic JSON files under ./data, which runs with zero setup and is perfect
// for local development. To move to a real database later (e.g. Postgres for a
// deployment with a persistent disk), reimplement this same interface against the
// DB and nothing else in the server has to change.
//
// Interface:
//   init()
//   getUserByName(name) -> user | null
//   getUserById(id)     -> user | null
//   createUser({ name, salt, hash }) -> user            (throws if name taken)
//   listCharacters(userId) -> { [slot]: saveData }
//   saveCharacter(userId, slot, data)
//   deleteCharacter(userId, slot)
//
// A "user" record is { id, name, nameLower, salt, hash, createdAt }.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.ERYNDOR_DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SAVES_DIR = path.join(DATA_DIR, "saves");

// In-memory mirror of users.json, loaded once at startup and written through on change.
let users = {};

function ensureDirs() {
  // Startup-only, runs once before the server accepts any connection - blocking
  // here has no effect on live players, unlike the per-request I/O below.
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SAVES_DIR, { recursive: true });
}

// Write JSON to a temp file then rename over the target. rename is atomic on the
// same filesystem, so a crash mid-write can never leave a half-written save. Async
// so a save/delete during live play doesn't block the event loop the WebSocket
// relay (enemy_sync/player_update/party broadcasts) runs on for every other player.
async function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch (err) {
    // A missing file is the expected, silent case (first run / brand-new user).
    // Anything else - corrupt JSON, a permission error - must NOT be swallowed
    // silently: the next write through this same path (persistUsers/saveCharacter)
    // would overwrite the file with `fallback`, permanently discarding whatever
    // was actually on disk, with no trace of what happened.
    if (err.code !== "ENOENT") {
      console.error(`Failed to read ${file}, treating as empty:`, err);
    }
    return fallback;
  }
}

async function init() {
  ensureDirs();
  users = await readJson(USERS_FILE, {});
}

async function persistUsers() {
  await writeJsonAtomic(USERS_FILE, users);
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

// Returns the new user, or null if the name is already taken. The taken-check and
// the in-memory insert happen with no `await` between them, so two concurrent
// registrations for the same name can't both pass the check - whichever call runs
// second (even before the first one's file write finishes) sees the first one's
// entry already in `users` and correctly gets null. This is why the caller doesn't
// need its own pre-check: a single call here is both the check and the reservation.
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
  users[user.id] = user;
  await persistUsers();
  return user;
}

function saveFileFor(userId) {
  return path.join(SAVES_DIR, `${userId}.json`);
}

async function listCharacters(userId) {
  return await readJson(saveFileFor(userId), {});
}

async function saveCharacter(userId, slot, data) {
  const chars = await listCharacters(userId);
  chars[String(slot)] = data;
  await writeJsonAtomic(saveFileFor(userId), chars);
}

async function deleteCharacter(userId, slot) {
  const chars = await listCharacters(userId);
  delete chars[String(slot)];
  await writeJsonAtomic(saveFileFor(userId), chars);
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
