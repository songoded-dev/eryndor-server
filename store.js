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
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.ERYNDOR_DATA_DIR || path.join(__dirname, "data");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SAVES_DIR = path.join(DATA_DIR, "saves");

// In-memory mirror of users.json, loaded once at startup and written through on change.
let users = {};

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SAVES_DIR, { recursive: true });
}

// Write JSON to a temp file then rename over the target. rename is atomic on the
// same filesystem, so a crash mid-write can never leave a half-written save.
function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function init() {
  ensureDirs();
  users = readJson(USERS_FILE, {});
}

function persistUsers() {
  writeJsonAtomic(USERS_FILE, users);
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

function createUser({ name, salt, hash }) {
  if (getUserByName(name)) throw new Error("name_taken");
  const user = {
    id: crypto.randomUUID(),
    name,
    nameLower: name.toLowerCase(),
    salt,
    hash,
    createdAt: Date.now()
  };
  users[user.id] = user;
  persistUsers();
  return user;
}

function saveFileFor(userId) {
  return path.join(SAVES_DIR, `${userId}.json`);
}

function listCharacters(userId) {
  return readJson(saveFileFor(userId), {});
}

function saveCharacter(userId, slot, data) {
  const chars = listCharacters(userId);
  chars[String(slot)] = data;
  writeJsonAtomic(saveFileFor(userId), chars);
}

function deleteCharacter(userId, slot) {
  const chars = listCharacters(userId);
  delete chars[String(slot)];
  writeJsonAtomic(saveFileFor(userId), chars);
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
