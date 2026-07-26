const http = require("http");
const { WebSocketServer } = require("ws");
const store = require("./store");
const auth = require("./auth");

const port = Number(process.env.PORT) || 3000;

const NAME_RE = /^[A-Za-z0-9_ -]{3,20}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 200;
const MAX_BODY_BYTES = 512 * 1024; // a character save with full inventory, comfortably

// ── Phase 2: validation gate over the host relay ──
// Enemy AI/combat/loot still runs entirely client-side (the "host" simulates it and
// broadcasts enemy_sync; player_damage is likewise host-relayed) - porting that whole
// system (7 classes, gear/talent-dependent damage formulas, dungeon-specific boss
// mechanics) to the server is a much larger project. What this DOES close: a malicious
// host can no longer broadcast fabricated/god-mode/one-hp-piñata enemies, or deal
// arbitrary/negative damage to another player - the two concrete abuses named by the
// security review. Values outside these generous bounds are dropped rather than
// relayed; legitimate play is far inside them.
//
// Base (unscaled, level-0-offset) hp/power for every enemy type in eryndor/game.js's
// enemyTypes table - kept minimal (just what the bound formula needs) and deliberately
// duplicated: growing the roster requires updating both files, an acceptable cost for a
// real security boundary with no shared build step between client and server.
const ENEMY_BASE_STATS = {
  riftling: { hp: 72, power: 10 },
  forsworn: { hp: 95, power: 13 },
  ashfangRaider: { hp: 120, power: 16 },
  ashfangWarrior: { hp: 155, power: 19 },
  ashfangJailer: { hp: 145, power: 18 },
  ashfangElite: { hp: 220, power: 24 },
  sentinel: { hp: 125, power: 16 },
  harbinger: { hp: 520, power: 24 },
  hollowBoss: { hp: 430, power: 21 },
  abyssalBoss: { hp: 880, power: 30 },
  vorash: { hp: 560, power: 24 },
  krogath: { hp: 780, power: 29 },
  drakvorn: { hp: 1180, power: 36 },
  solmaw: { hp: 950, power: 30 },
  voidSpawn: { hp: 240, power: 26 },
  voidStalker: { hp: 320, power: 32 },
  voidWeaver: { hp: 420, power: 36 },
  nyxaroth: { hp: 2600, power: 44 },
  corruptedHusk: { hp: 380, power: 30 },
  blightHound: { hp: 260, power: 27 },
  blightheart: { hp: 1400, power: 38 },
  stoneShell: { hp: 140, power: 17 },
  earthenWarden: { hp: 210, power: 22 },
  coralGolem: { hp: 290, power: 26 },
  frozenSentinel: { hp: 130, power: 16 },
  depthCrystal: { hp: 175, power: 20 },
  glacialWraith: { hp: 155, power: 19 },
  emberstoke: { hp: 145, power: 20 },
  ventHowler: { hp: 110, power: 18 },
  scaldingBrute: { hp: 260, power: 27 },
  arcReaver: { hp: 120, power: 17 },
  stormDrifter: { hp: 160, power: 21 },
  conductorWraith: { hp: 195, power: 23 },
  lithvorn: { hp: 1800, power: 38 },
  vaelthas: { hp: 1600, power: 34 },
  ignivex: { hp: 1750, power: 40 },
  nexal: { hp: 1650, power: 36 },
  aquerath: { hp: 4800, power: 52 },
  emberReinforcement: { hp: 280, power: 24 },
  emberVoidAdd: { hp: 150, power: 22 },
  emberFireAdd: { hp: 135, power: 21 },
  emberFirePortal: { hp: 420, power: 0 },
  tPlusVoidPortalLord: { hp: 520, power: 34 },
  tPlusMoonknight: { hp: 480, power: 31 },
  tPlusLunarFragment: { hp: 95, power: 0 },
  tPlusLightBlob: { hp: 80, power: 0 },
  tPlusSpectralMimic: { hp: 560, power: 36 },
  tPlusVoidChampion: { hp: 760, power: 42 },
  raidBoss: { hp: 980, power: 33 },
  undervaultDrone: { hp: 110, power: 15 },
  busterMk1: { hp: 1400, power: 28 },
  moonknightSeeker: { hp: 800, power: 26 },
  moonknightWarden: { hp: 900, power: 30 },
  moonknightShade: { hp: 750, power: 27 },
  moonknightHigh: { hp: 1100, power: 32 },
  obliteratorMk10: { hp: 2200, power: 42 },
  ironSuitVanguard: { hp: 2600, power: 34 },
  ironSuitVanguard2: { hp: 900, power: 28 },
  ironSuitSentinel: { hp: 950, power: 26 },
  ironSuitSentinel2: { hp: 950, power: 26 },
  ironSuitInterceptor: { hp: 850, power: 30 },
  ironSuitInterceptor2: { hp: 850, power: 30 },
  ironSuitSiege: { hp: 1400, power: 38 },
  ironSuitSiege2: { hp: 1400, power: 38 },
  ironSuitWarlord: { hp: 1700, power: 44 },
  ironSuitWarlord2: { hp: 1700, power: 44 },
  api: { hp: 5500, power: 48 }
};

// Enemy level tracks nearby player level (spawnEnemy's getMaxPlayerLevelNear), and player
// level caps at 60 (the same clamp the client's save-load applies) - 100 is a generous
// headroom above any legitimate value, chosen so a claimed level itself can't be used to
// smuggle an arbitrary hp/power ceiling through the formula below.
const MAX_PLAUSIBLE_ENEMY_LEVEL = 100;

// World-zone enemies use the exact formula from spawnEnemy/levelUpEnemy with no T+/
// difficulty multiplier (those only apply in dungeon:/raid: areas): hp = base + level*18,
// power = base + level*2. A [0.3x, 4x] band absorbs rounding/legacy variance without
// letting through an order-of-magnitude fabrication.
const WORLD_HP_CEILING_MULT = 4;
const WORLD_POWER_CEILING_MULT = 4;

// Dungeon/raid/T+ zones layer a MUCH wider, content-specific multiplier on top of that
// same base formula (getTPlusStaticEnemyMultipliers): tier scales up to 1+100*0.15=16x hp
// / 1+100*0.12=13x power at the max tier (TPLUS_MAX_TIER=100), and at high tier ALL 24
// affixes in the pool are simultaneously active (getTPlusAffixCount caps at 24, the full
// pool size) - including both HP-scaling affixes (voidAnnihilation, lightPower, each
// hp*=3) and all four power-scaling ones (+ moonEclipse *1.5, lightHope *1.35). Worst
// case: 16 * 3*3 = 144x hp, 13 * 3*3*1.5*1.35 ≈ 237x power. The server has no reliable way
// to know which tier/affixes a given run actually used (that seed includes the player's
// local hero name, never sent to the server - see eryndor-server-security-review memory),
// so rather than guess, this uses the maximum ANY legitimate combination could ever
// produce as a hard ceiling, with headroom for rounding/future content growth.
const DUNGEON_HP_CEILING_MULT = 180;
const DUNGEON_POWER_CEILING_MULT = 300;
const FLOOR_MULT = 0.3; // same floor as the world zone: catches "1-hp piñata" fabrication

function isPlausibleEnemy(enemy) {
  const base = ENEMY_BASE_STATS[enemy.type];
  if (!base) return true; // unknown type: not this check's job, pass through
  const level = Number.isFinite(enemy.level) ? Math.max(1, Math.min(MAX_PLAUSIBLE_ENEMY_LEVEL, enemy.level)) : 1;
  const expectedHp = base.hp + level * 18;
  const expectedPower = base.power + level * 2;
  const isWorld = (enemy.area || "world") === "world";
  const hpCeilingMult = isWorld ? WORLD_HP_CEILING_MULT : DUNGEON_HP_CEILING_MULT;
  const powerCeilingMult = isWorld ? WORLD_POWER_CEILING_MULT : DUNGEON_POWER_CEILING_MULT;
  if (!Number.isFinite(enemy.maxHp) || enemy.maxHp < expectedHp * FLOOR_MULT || enemy.maxHp > expectedHp * hpCeilingMult) return false;
  if (!Number.isFinite(enemy.hp) || enemy.hp > enemy.maxHp * 1.05) return false;
  if (enemy.power != null && (!Number.isFinite(enemy.power) || enemy.power < expectedPower * FLOOR_MULT || enemy.power > expectedPower * powerCeilingMult)) return false;
  return true;
}

function sanitizeEnemySync(enemies, onDropped) {
  if (!Array.isArray(enemies)) return [];
  return enemies.filter((enemy) => {
    if (!enemy || typeof enemy !== "object") return true;
    const ok = isPlausibleEnemy(enemy);
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

// apply_buff lets any client apply a specific, allowlisted buff to another specific
// player (e.g. Druid's Nature Protection cast on an ally, Knight's Divine Substitution) -
// unlike player_damage/player_heal this isn't host-gated, since it's a caster-to-target
// buff application rather than combat resolution. The allowlist plus a bounded duration
// keeps a compromised/modified client from applying an arbitrary effect for an arbitrary
// length of time.
const ALLOWED_BUFF_TYPES = new Set(["nature_protection", "divine_substitution"]);
function isPlausibleBuff(data) {
  return ALLOWED_BUFF_TYPES.has(data.buff) && Number.isFinite(data.duration) && data.duration >= 0 && data.duration <= 60;
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
const duels = new Map(); // duelId -> {id, a, b}: active 1v1 duels
const pendingDuelInvites = new Map(); // invitedId -> Set<inviterId>: duel challenges we've actually relayed
let hostId = null;

// ── Dungeon Finder matchmaking ──
// Server has no access to the client's contentDefs, so the queueable ids are duplicated
// here - same tradeoff already accepted for ENEMY_BASE_STATS above.
const ONLINE_QUEUEABLE_IDS = new Set(["dungeon", "emberGates", "abyssalConvergence", "veiledExpanse", "voidPortal", "raid", "undervault"]);
const TPLUS_QUEUEABLE_IDS = new Set(["dungeonTPlus", "emberGatesTPlus", "abyssalConvergenceTPlus", "veiledExpanseTPlus", "raidTPlus", "undervaultTPlus"]);
const ROLES = new Set(["tank", "dps", "heal"]);
const dungeonQueues = new Map(); // queueKey -> { tank: [playerId], dps: [playerId], heal: [playerId] }
const queuedPlayers = new Map(); // playerId -> { queueKey, role, contentId, tier }

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
      } else if (data.type === "apply_buff") {
        if (!isPlausibleBuff(data)) {
          console.warn(`Dropped implausible apply_buff from ${playerId}:`, data.buff, data.duration);
          return;
        }
        const targetClient = clients.get(data.targetId);
        if (targetClient && targetClient.readyState === 1) {
          targetClient.send(JSON.stringify({
            type: "apply_buff",
            targetId: data.targetId,
            buff: data.buff,
            duration: data.duration,
            casterId: playerId,
            casterName: players.get(playerId)?.name || null
          }));
        }
      } else if (data.type === "redirect_damage" && isPlausibleDamage(data.damage)) {
        // Knight's Divine Substitution: the ally being substituted for sends this instead
        // of taking the damage themselves. Not host-gated - the sender is redirecting their
        // OWN incoming hit, not asserting authority over someone else's combat outcome.
        const targetClient = clients.get(data.targetId);
        if (targetClient && targetClient.readyState === 1) {
          targetClient.send(JSON.stringify({
            type: "redirect_damage",
            targetId: data.targetId,
            damage: data.damage
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
        // Case-insensitive: players.get(id).name is the authenticated account name (Phase
        // 1 forces it), and a friend typing it from memory shouldn't have to match casing
        // exactly. This also works for ANY connected player, not just ones the inviter has
        // seen on their canvas - the "click a player" UI restriction was purely client-side.
        const targetName = typeof data.targetName === "string" ? data.targetName.trim().toLowerCase() : "";
        let targetId = null;
        if (targetName) {
          for (const [id, p] of players.entries()) {
            if (id !== playerId && typeof p.name === "string" && p.name.toLowerCase() === targetName) {
              targetId = id;
              break;
            }
          }
        }

        const targetWs = targetId && clients.get(targetId);
        if (targetWs && targetWs.readyState === 1) {
          // Record the invite so a later party_accept can be validated against it.
          if (!pendingInvites.has(targetId)) pendingInvites.set(targetId, new Set());
          pendingInvites.get(targetId).add(playerId);
          targetWs.send(JSON.stringify({
            type: "party_invite",
            fromId: playerId,
            fromName: players.get(playerId).name
          }));
          ws.send(JSON.stringify({ type: "party_invite_sent", targetName: players.get(targetId).name }));
        } else {
          // Silent failure is a real problem for a type-a-name invite flow: the sender has
          // no way to tell "not online" from "worked, just waiting." Report it back.
          ws.send(JSON.stringify({ type: "party_invite_failed", targetName: data.targetName }));
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
            party = createParty([senderId, playerId], senderId);
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
      } else if (data.type === "duel_challenge") {
        // Mirrors party_invite exactly - same case-insensitive global name lookup, same
        // pending-ledger anti-spoof pattern, same sent/failed feedback.
        const targetName = typeof data.targetName === "string" ? data.targetName.trim().toLowerCase() : "";
        let targetId = null;
        if (targetName) {
          for (const [id, p] of players.entries()) {
            if (id !== playerId && typeof p.name === "string" && p.name.toLowerCase() === targetName) {
              targetId = id;
              break;
            }
          }
        }

        const targetWs = targetId && clients.get(targetId);
        if (targetWs && targetWs.readyState === 1 && !getPlayerDuel(playerId) && !getPlayerDuel(targetId)) {
          if (!pendingDuelInvites.has(targetId)) pendingDuelInvites.set(targetId, new Set());
          pendingDuelInvites.get(targetId).add(playerId);
          targetWs.send(JSON.stringify({
            type: "duel_challenge",
            fromId: playerId,
            fromName: players.get(playerId).name
          }));
          ws.send(JSON.stringify({ type: "duel_challenge_sent", targetName: players.get(targetId).name }));
        } else {
          ws.send(JSON.stringify({ type: "duel_challenge_failed", targetName: data.targetName }));
        }
      } else if (data.type === "duel_accept") {
        const senderId = data.fromId;
        const invitesForMe = pendingDuelInvites.get(playerId);
        if (invitesForMe && invitesForMe.has(senderId) && !getPlayerDuel(playerId) && !getPlayerDuel(senderId)) {
          invitesForMe.delete(senderId);
          const duelId = Math.random().toString(36).substring(2, 9);
          const duel = { id: duelId, a: senderId, b: playerId };
          duels.set(duelId, duel);

          const startData = (opponentId, opponentName) => JSON.stringify({
            type: "duel_start", duelId, opponentId, opponentName: players.get(opponentId)?.name || "?"
          });
          const senderWs = clients.get(senderId);
          if (senderWs && senderWs.readyState === 1) senderWs.send(startData(playerId, players.get(playerId).name));
          ws.send(startData(senderId, players.get(senderId).name));
        }
      } else if (data.type === "duel_decline") {
        const senderId = data.fromId;
        const invitesForMe = pendingDuelInvites.get(playerId);
        if (invitesForMe) invitesForMe.delete(senderId);
      } else if (data.type === "duel_damage" && isPlausibleDamage(data.damage)) {
        // Not host-gated - this is a self-reported outgoing hit, same trust model as
        // redirect_damage. What guards against abuse is the active-duel-pair check below:
        // a message can only land if the server itself recorded these two as duelling.
        const duel = getPlayerDuel(playerId);
        const targetId = data.targetId;
        if (duel && (duel.a === targetId || duel.b === targetId)) {
          const targetClient = clients.get(targetId);
          if (targetClient && targetClient.readyState === 1) {
            targetClient.send(JSON.stringify({ type: "duel_damage", damage: data.damage }));
          }
        }
      } else if (data.type === "duel_end") {
        const duel = getPlayerDuel(playerId);
        if (duel) {
          const opponentId = duel.a === playerId ? duel.b : duel.a;
          const opponentWs = clients.get(opponentId);
          if (opponentWs && opponentWs.readyState === 1) {
            opponentWs.send(JSON.stringify({ type: "duel_end", result: data.result === "forfeit" ? "opponent_forfeited" : "won" }));
          }
          duels.delete(duel.id);
        }
      } else if (data.type === "queue_join") {
        const contentId = data.contentId;
        const role = data.role;
        const isTPlus = TPLUS_QUEUEABLE_IDS.has(contentId);
        const isOnline = ONLINE_QUEUEABLE_IDS.has(contentId);
        const tier = isTPlus ? Math.min(100, Math.max(1, Math.floor(Number(data.tier)) || 1)) : null;

        if (!ROLES.has(role) || (!isTPlus && !isOnline)) {
          ws.send(JSON.stringify({ type: "queue_join_failed", reason: "invalid" }));
        } else if (queuedPlayers.has(playerId)) {
          ws.send(JSON.stringify({ type: "queue_join_failed", reason: "already_queued" }));
        } else if (getPlayerParty(playerId)) {
          ws.send(JSON.stringify({ type: "queue_join_failed", reason: "in_party" }));
        } else {
          const queueKey = queueKeyFor(contentId, tier);
          if (!dungeonQueues.has(queueKey)) dungeonQueues.set(queueKey, { tank: [], dps: [], heal: [] });
          dungeonQueues.get(queueKey)[role].push(playerId);
          queuedPlayers.set(playerId, { queueKey, role, contentId, tier });
          ws.send(JSON.stringify({ type: "queue_joined", contentId, role, tier }));
          tryFormMatch(queueKey, contentId, tier);
        }
      } else if (data.type === "queue_leave") {
        removeFromQueue(playerId);
        ws.send(JSON.stringify({ type: "queue_left" }));
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
    pendingDuelInvites.delete(playerId);
    for (const inviters of pendingDuelInvites.values()) inviters.delete(playerId);

    // A disconnect mid-duel is a forfeit - the opponent is declared the winner rather than
    // being left stuck with a duel that can never end.
    const activeDuel = getPlayerDuel(playerId);
    if (activeDuel) {
      const opponentId = activeDuel.a === playerId ? activeDuel.b : activeDuel.a;
      const opponentWs = clients.get(opponentId);
      if (opponentWs && opponentWs.readyState === 1) {
        opponentWs.send(JSON.stringify({ type: "duel_end", result: "opponent_disconnected" }));
      }
      duels.delete(activeDuel.id);
    }

    removeFromQueue(playerId);

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

function getPlayerDuel(playerId) {
  for (const duel of duels.values()) {
    if (duel.a === playerId || duel.b === playerId) return duel;
  }
  return null;
}

function createParty(memberIds, leaderId = memberIds[0]) {
  const partyId = Math.random().toString(36).substring(2, 9);
  const party = { id: partyId, members: [...memberIds], leader: leaderId, isRaid: false };
  parties.set(partyId, party);
  return party;
}

function queueKeyFor(contentId, tier) {
  return tier != null ? `${contentId}:T${tier}` : contentId;
}

function removeFromQueue(playerId) {
  const entry = queuedPlayers.get(playerId);
  if (!entry) return;
  const bucket = dungeonQueues.get(entry.queueKey);
  if (bucket) {
    const arr = bucket[entry.role];
    const idx = arr.indexOf(playerId);
    if (idx !== -1) arr.splice(idx, 1);
    if (bucket.tank.length === 0 && bucket.dps.length === 0 && bucket.heal.length === 0) {
      dungeonQueues.delete(entry.queueKey);
    }
  }
  queuedPlayers.delete(playerId);
}

// Forms as many complete 1 tank / 4 dps / 1 heal groups as the bucket currently supports.
// Tank is shifted first so it becomes the party leader for free.
function tryFormMatch(queueKey, contentId, tier) {
  const bucket = dungeonQueues.get(queueKey);
  if (!bucket) return;
  while (bucket.tank.length >= 1 && bucket.dps.length >= 4 && bucket.heal.length >= 1) {
    const tankId = bucket.tank.shift();
    const dpsIds = bucket.dps.splice(0, 4);
    const healId = bucket.heal.shift();
    const roleById = new Map([[tankId, "tank"], [healId, "heal"], ...dpsIds.map((id) => [id, "dps"])]);
    const memberIds = [tankId, ...dpsIds, healId];
    for (const id of memberIds) queuedPlayers.delete(id);

    const party = createParty(memberIds, tankId);
    broadcastPartyUpdate(party);
    for (const id of memberIds) {
      const memberWs = clients.get(id);
      if (memberWs && memberWs.readyState === 1) {
        memberWs.send(JSON.stringify({ type: "dungeon_queue_matched", contentId, tier, role: roleById.get(id), partyId: party.id }));
      }
    }
  }
  if (bucket.tank.length === 0 && bucket.dps.length === 0 && bucket.heal.length === 0) {
    dungeonQueues.delete(queueKey);
  }
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