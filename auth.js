"use strict";

// Authentication primitives for Eryndor: password hashing and session tokens.
// Uses only Node's built-in crypto - no external dependencies.
//
//  - Passwords are hashed with scrypt and a per-user random salt, compared in
//    constant time. The plaintext password is never stored.
//  - Session tokens are stateless HMACs: "<userId>.<expiryMs>.<signature>".
//    The server can verify a token by recomputing the signature with its secret,
//    so no session table is needed and tokens survive server restarts. Rotating
//    the secret invalidates every outstanding token (a global logout).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = process.env.ERYNDOR_DATA_DIR || path.join(__dirname, "data");
const SECRET_FILE = path.join(DATA_DIR, "secret.key");
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// The signing secret comes from the environment in production; locally we persist
// a generated one so tokens stay valid across restarts during development.
let secret = null;
function getSecret() {
  if (secret) return secret;
  if (process.env.ERYNDOR_SECRET) {
    secret = Buffer.from(process.env.ERYNDOR_SECRET, "utf8");
    return secret;
  }
  try {
    secret = Buffer.from(fs.readFileSync(SECRET_FILE, "utf8").trim(), "hex");
    if (secret.length >= 16) return secret;
  } catch {
    /* fall through to generate */
  }
  secret = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  fs.writeFileSync(SECRET_FILE, secret.toString("hex"));
  return secret;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, "hex");
  return hash.length === expected.length && crypto.timingSafeEqual(hash, expected);
}

function sign(payload) {
  return crypto.createHmac("sha256", getSecret()).update(payload).digest("hex");
}

function signToken(userId, ttlMs = TOKEN_TTL_MS) {
  const expiry = Date.now() + ttlMs;
  const payload = `${userId}.${expiry}`;
  return `${payload}.${sign(payload)}`;
}

// Returns the userId for a valid, unexpired token, or null.
function verifyToken(token) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [userId, expiryStr, providedSig] = parts;
  const payload = `${userId}.${expiryStr}`;
  const expectedSig = sign(payload);
  const a = Buffer.from(providedSig, "hex");
  const b = Buffer.from(expectedSig, "hex");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (!Number(expiryStr) || Date.now() > Number(expiryStr)) return null;
  return userId;
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
