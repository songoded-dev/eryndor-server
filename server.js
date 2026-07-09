const http = require("http");
const { WebSocketServer } = require("ws");
const store = require("./store");
const auth = require("./auth");

const port = Number(process.env.PORT) || 3000;

const NAME_RE = /^[A-Za-z0-9_ -]{3,20}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 200;
const MAX_BODY_BYTES = 512 * 1024; // a character save with full inventory, comfortably

// ── Phase 2 Slice 1: validation gate over the host relay ──
// Enemy AI/combat/loot still runs entirely client-side (the "host" simulates it and
// broadcasts enemy_sync; player_damage is likewise host-relayed) - porting that whole
// system (7 classes, gear/talent-dependent damage formulas, dungeon-specific boss
// mechanics) to the server is a much larger project or a future slice. What this DOES
// close: a malicious host can no longer broadcast fabricated/god-mode/one-hp-piñata
// enemies in the open world, or deal arbitrary/negative damage to another player -
// the two concrete abuses named by the security review. Values outside these generous
// bounds are dropped rather than relayed; legitimate play is far inside them.
//
// Base hp/power for the open-world roster only (mirrors eryndor/game.js enemyTypes for
// exactly the types spawnInitialEnemies places in "world"). Dungeon/raid/T+ zones use
// much wider, content-specific multipliers this slice doesn't attempt to characterize,
// so entries outside "world" are passed through unvalidated, same as before.
const WORLD_ENEMY_BASE = {
  riftling: { hp: 72, power: 10 },
  forsworn: { hp: 95, power: 13 },
  sentinel: { hp: 125, power: 16 },
  corruptedHusk: { hp: 380, power: 30 },
  blightHound: { hp: 260, power: 27 },
  harbinger: { hp: 520, power: 24 },
  blightheart: { hp: 1400, power: 38 },
  solmaw: { hp: 950, power: 30 }
};

// Mirrors the scaling in spawnEnemy/levelUpEnemy for the world zone specifically, where
// no T+/difficulty multiplier applies (those are dungeon/raid-only): hp = base + level*18,
// power = base + level*2. A wide [0.3x, 4x] band absorbs any rounding/legacy variance
// without letting through an order-of-magnitude fabrication (a 1-hp piñata or a
// invincible/one-shot "enemy").
function isPlausibleWorldEnemy(enemy) {
  const base = WORLD_ENEMY_BASE[enemy.type];
  if (!base) return true; // unknown/non-world type: not this slice's job, pass through
  const level = Number.isFinite(enemy.level) ? enemy.level : 1;
  const expectedHp = base.hp + level * 18;
  const expectedPower = base.power + level * 2;
  if (!Number.isFinite(enemy.maxHp) || enemy.maxHp < expectedHp * 0.3 || enemy.maxHp > expectedHp * 4) return false;
  if (!Number.isFinite(enemy.hp) || enemy.hp > enemy.maxHp * 1.05) return false;
  if (enemy.power != null && (!Number.isFinite(enemy.power) || enemy.power < expectedPower * 0.3 || enemy.power > expectedPower * 4)) return false;
  return true;
}

function sanitizeEnemySync(enemies, onDropped) {
  if (!Array.isArray(enemies)) return [];
  return enemies.filter((enemy) => {
    if (!enemy || typeof enemy !== "object" || (enemy.area || "world") !== "world") return true;
    const ok = isPlausibleWorldEnemy(enemy);
    if (!ok) onDropped(enemy);
    return ok;
  });
}

// A ceiling no legitimate single hit should approach even with high-end gear/crit/talent
// stacking (per the enemy power scale, world/dungeon content deals tens to low hundreds
// per hit at max level) - this only catches fabricated/absurd values, not fine-tuned
// balance, which would need per-class formula data this slice doesn't have.
const MAX_PLAUSIBLE_HIT = 100000;
function isPlausibleDamage(amount) {
  return Number.isFinite(amount) && amount >= 0 && amount <= MAX_PLAUSIBLE_HIT;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS"
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("bad_json"));
      }
    });
    req.on("error", reject);
  });
}

// Returns the authenticated userId from the Bearer token, or null.
function authUserId(req) {
  const header = req.headers["authorization"] || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return null;
  const userId = auth.verifyToken(match[1]);
  return userId && store.getUserById(userId) ? userId : null;
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") return sendJson(res, 204, {});

  if (req.method === "POST" && url.pathname === "/api/register") {
    const body = await readJsonBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!NAME_RE.test(name)) return sendJson(res, 400, { error: "invalid_name" });
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) return sendJson(res, 400, { error: "invalid_password" });
    const { salt, hash } = await auth.hashPassword(password);
    // createUser does its own (race-safe) duplicate check and returns null instead
    // of throwing, so this is the only duplicate-name check needed - no separate
    // pre-check here, which would otherwise leave a window for two concurrent
    // registrations to both pass a pre-check before either actually reserves the name.
    const user = await store.createUser({ name, salt, hash });
    if (!user) return sendJson(res, 409, { error: "name_taken" });
    return sendJson(res, 200, { token: auth.signToken(user.id), name: user.name });
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJsonBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const user = store.getUserByName(name);
    // Always run a verify to keep timing similar whether or not the user exists.
    // The dummy hash MUST be the same byte length as a real one (auth.DUMMY_HASH_HEX
    // is 64 bytes hex-encoded) - a shorter dummy makes verifyPassword's length check
    // short-circuit before timingSafeEqual runs, which would make the nonexistent-user
    // path measurably faster than the wrong-password path, reintroducing the exact
    // timing side-channel this dummy call exists to prevent.
    const ok = user
      ? await auth.verifyPassword(password, user.salt, user.hash)
      : await auth.verifyPassword(password, "dummy-salt", auth.DUMMY_HASH_HEX);
    if (!user || !ok) return sendJson(res, 401, { error: "bad_credentials" });
    return sendJson(res, 200, { token: auth.signToken(user.id), name: user.name });
  }

  if (req.method === "GET" && url.pathname === "/api/characters") {
    const userId = authUserId(req);
    if (!userId) return sendJson(res, 401, { error: "unauthorized" });
    return sendJson(res, 200, { characters: await store.listCharacters(userId), name: store.getUserById(userId).name });
  }

  if (req.method === "POST" && url.pathname === "/api/character") {
    const userId = authUserId(req);
    if (!userId) return sendJson(res, 401, { error: "unauthorized" });
    const body = await readJsonBody(req);
    const slot = Number(body.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) return sendJson(res, 400, { error: "invalid_slot" });
    if (!body.data || typeof body.data !== "object") return sendJson(res, 400, { error: "invalid_data" });
    await store.saveCharacter(userId, slot, body.data);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "DELETE" && url.pathname === "/api/character") {
    const userId = authUserId(req);
    if (!userId) return sendJson(res, 401, { error: "unauthorized" });
    // Check the param is actually present BEFORE coercing: Number(null) === 0, so a
    // missing ?slot= would otherwise silently validate as "delete slot 0" instead of
    // being rejected as a malformed request.
    if (!url.searchParams.has("slot")) return sendJson(res, 400, { error: "invalid_slot" });
    const slot = Number(url.searchParams.get("slot"));
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) return sendJson(res, 400, { error: "invalid_slot" });
    await store.deleteCharacter(userId, slot);
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: "not_found" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url).catch((err) => {
      const status = err.message === "body_too_large" ? 413 : err.message === "bad_json" ? 400 : 500;
      sendJson(res, status, { error: err.message || "server_error" });
    });
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Eryndor multiplayer server");
});

// maxPayload caps a single WS frame (anti-amplification): the HTTP body limit doesn't
// apply to WS, and ws otherwise allows ~100MB frames a client could broadcast to everyone.
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

// store.init() is async (it reads users.json off disk) and this file is CommonJS,
// so there's no top-level await - listening must wait inside a .then() instead of
// running store.init() fire-and-forget, otherwise a request could arrive and read
// the in-memory `users` map before the file finished loading into it.
store.init().then(() => {
  server.listen(port, () => {
    console.log(`Eryndor Multiplayer Server running on port ${port}`);
  });
}).catch((err) => {
  console.error("Failed to initialize store:", err);
  process.exit(1);
});

const players = new Map();
const clients = new Map();
const parties = new Map();
const pendingInvites = new Map(); // invitedId -> Set<inviterId>: invites we've actually relayed
let hostId = null;

wss.on("connection", (ws, req) => {
  // Authenticate the socket from the token in the query string (?token=...). Only a valid
  // account may join multiplayer; the resolved name is then the ONLY identity trusted for
  // this connection's messages, so a client can no longer impersonate anyone by asserting
  // a name/id in the payload.
  let authName = null;
  try {
    const url = new URL(req.url, "http://localhost");
    const uid = auth.verifyToken(url.searchParams.get("token") || "");
    const user = uid && store.getUserById(uid);
    if (user) authName = user.name;
  } catch { /* fall through to reject */ }
  if (!authName) {
    ws.close(4001, "unauthorized");
    return;
  }

  const playerId = Math.random().toString(36).substring(2, 9);
  console.log(`Player connected: ${playerId} (${authName})`);

  clients.set(playerId, ws);
  players.set(playerId, { id: playerId, name: authName, lastUpdate: Date.now() });

  // Per-connection rate limit: drop anything past the cap in a rolling 1s window.
  let msgCount = 0;
  let windowStart = Date.now();

  if (hostId === null) {
    hostId = playerId;
    ws.send(JSON.stringify({ type: "host_assignment", isHost: true, yourId: playerId }));
  } else {
    ws.send(JSON.stringify({ type: "host_assignment", isHost: false, yourId: playerId }));
  }

  ws.on("message", (message) => {
    // Rate limit before doing any work: ~200 messages/sec/connection is far above normal
    // play but stops a client from flooding the relay.
    const now = Date.now();
    if (now - windowStart >= 1000) { windowStart = now; msgCount = 0; }
    if (++msgCount > 200) return;
    try {
      const data = JSON.parse(message);

      if (data.type === "player_update") {
        players.set(playerId, {
          ...data.player,
          id: playerId,
          name: authName, // force the authenticated name; ignore any client-supplied name
          lastUpdate: Date.now()
        });

        const broadcastData = JSON.stringify({
          type: "player_update",
          player: players.get(playerId)
        });

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === 1) {
            client.send(broadcastData);
          }
        });
      } else if (data.type === "enemy_sync" && playerId === hostId) {
        const enemies = sanitizeEnemySync(data.enemies, (dropped) => {
          console.warn(`Dropped implausible world enemy from host ${playerId}:`, dropped.type, dropped.hp, dropped.maxHp, dropped.power);
        });
        const broadcastData = JSON.stringify({
          type: "enemy_sync",
          enemies
        });

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === 1) {
            client.send(broadcastData);
          }
        });
      } else if (data.type === "enemy_damage" || data.type === "instance_spawn") {
        const hostClient = clients.get(hostId);
        if (hostClient && hostClient.readyState === 1) {
          hostClient.send(JSON.stringify(data));
        }
      } else if (data.type === "player_damage" && playerId === hostId) {
        if (!isPlausibleDamage(data.damage)) {
          console.warn(`Dropped implausible player_damage from host ${playerId}:`, data.damage);
          return;
        }
        const targetClient = clients.get(data.targetId);
        if (targetClient && targetClient.readyState === 1) {
          targetClient.send(JSON.stringify({
            type: "player_damage",
            targetId: data.targetId,
            damage: data.damage
          }));
        }
      } else if (data.type === "player_heal" && playerId === hostId) {
        // Mirror of player_damage: only the host may heal a player, relayed to the target.
        // Previously unhandled, so cross-player healing (healRemotePlayer) silently did nothing.
        const targetClient = clients.get(data.targetId);
        if (targetClient && targetClient.readyState === 1) {
          targetClient.send(JSON.stringify({
            type: "player_heal",
            targetId: data.targetId,
            heal: data.heal
          }));
        }
      } else if (data.type === "chat") {
        const text = typeof data.text === "string" ? data.text.slice(0, 500) : "";
        if (!text) return;
        const broadcastData = JSON.stringify({
          type: "chat",
          name: authName, // trusted server-bound name, never the client-supplied one
          text
        });

        wss.clients.forEach((client) => {
          if (client.readyState === 1) {
            client.send(broadcastData);
          }
        });
      } else if (data.type === "party_invite") {
        let targetId = null;
        for (const [id, p] of players.entries()) {
          if (p.name === data.targetName && id !== playerId) {
            targetId = id;
            break;
          }
        }

        if (targetId) {
          const targetWs = clients.get(targetId);
          if (targetWs && targetWs.readyState === 1) {
            // Record the invite so a later party_accept can be validated against it.
            if (!pendingInvites.has(targetId)) pendingInvites.set(targetId, new Set());
            pendingInvites.get(targetId).add(playerId);
            targetWs.send(JSON.stringify({
              type: "party_invite",
              fromId: playerId,
              fromName: players.get(playerId).name
            }));
          }
        }
      } else if (data.type === "party_accept") {
        const senderId = data.fromId;
        // Only honor an accept that matches an invite we actually relayed to THIS player.
        // Without this a client could forge membership (or force a victim into a party)
        // just by sending a spoofed fromId it never received an invite from.
        const invitesForMe = pendingInvites.get(playerId);
        if (invitesForMe && invitesForMe.has(senderId)) {
          invitesForMe.delete(senderId);
          let party = null;

          for (const p of parties.values()) {
            if (p.members.includes(senderId)) {
              party = p;
              break;
            }
          }

          if (!party) {
            const partyId = Math.random().toString(36).substring(2, 9);
            party = {
              id: partyId,
              members: [senderId, playerId],
              leader: senderId,
              isRaid: false
            };
            parties.set(partyId, party);
          } else {
            const limit = party.isRaid ? 30 : 10;
            if (party.members.length < limit && !party.members.includes(playerId)) {
              party.members.push(playerId);
            }
          }

          broadcastPartyUpdate(party);
        }
      } else if (data.type === "party_leave") {
        handlePartyLeave(playerId);
      } else if (data.type === "party_kick") {
        const party = getPlayerParty(playerId);
        if (party && party.leader === playerId) {
          handlePartyLeave(data.targetId);
        }
      }
    } catch (e) {
      console.error("Failed to parse message", e);
    }
  });

  ws.on("close", () => {
    console.log(`Player disconnected: ${playerId}`);
    handlePartyLeave(playerId);
    players.delete(playerId);
    clients.delete(playerId);
    // Drop any invites to or from this player so they can't be accepted after they leave.
    pendingInvites.delete(playerId);
    for (const inviters of pendingInvites.values()) inviters.delete(playerId);

    if (playerId === hostId) {
      hostId = null;
      const nextId = players.keys().next().value;
      if (nextId) {
        hostId = nextId;
        wss.clients.forEach((client) => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: "host_promotion", newHostId: hostId }));
          }
        });
      }
    }

    const disconnectData = JSON.stringify({
      type: "disconnect",
      id: playerId
    });

    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(disconnectData);
      }
    });
  });

  ws.on("error", console.error);
});

function getPlayerParty(playerId) {
  for (const party of parties.values()) {
    if (party.members.includes(playerId)) return party;
  }
  return null;
}

function handlePartyLeave(playerId) {
  const party = getPlayerParty(playerId);
  if (!party) return;

  party.members = party.members.filter(id => id !== playerId);

  // Tell the departing member (voluntary leave OR kick) so their client clears its party
  // UI. Previously only the remaining members were updated, leaving a kicked/left player's
  // panel frozen with a party they're no longer in.
  const leaverWs = clients.get(playerId);
  if (leaverWs && leaverWs.readyState === 1) {
    leaverWs.send(JSON.stringify({ type: "party_update", party: null }));
  }

  if (party.members.length < 2) {
    if (party.members.length === 1) {
      const lastWs = clients.get(party.members[0]);
      if (lastWs && lastWs.readyState === 1) {
        lastWs.send(JSON.stringify({ type: "party_update", party: null }));
      }
    }
    parties.delete(party.id);
  } else {
    if (party.leader === playerId) {
      party.leader = party.members[0];
    }
    broadcastPartyUpdate(party);
  }
}

function broadcastPartyUpdate(party) {
  const updateData = JSON.stringify({
    type: "party_update",
    party: party
  });

  party.members.forEach(memberId => {
    const ws = clients.get(memberId);
    if (ws && ws.readyState === 1) {
      ws.send(updateData);
    }
  });
}