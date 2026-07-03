const http = require("http");
const { WebSocketServer } = require("ws");
const store = require("./store");
const auth = require("./auth");

const port = Number(process.env.PORT) || 3000;

store.init();

const NAME_RE = /^[A-Za-z0-9_ -]{3,20}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 200;
const MAX_BODY_BYTES = 512 * 1024; // a character save with full inventory, comfortably

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
    if (store.getUserByName(name)) return sendJson(res, 409, { error: "name_taken" });
    const { salt, hash } = auth.hashPassword(password);
    const user = store.createUser({ name, salt, hash });
    return sendJson(res, 200, { token: auth.signToken(user.id), name: user.name });
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const body = await readJsonBody(req);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const user = store.getUserByName(name);
    // Always run a verify to keep timing similar whether or not the user exists.
    const ok = user
      ? auth.verifyPassword(password, user.salt, user.hash)
      : auth.verifyPassword(password, "00000000000000000000000000000000", "00");
    if (!user || !ok) return sendJson(res, 401, { error: "bad_credentials" });
    return sendJson(res, 200, { token: auth.signToken(user.id), name: user.name });
  }

  if (req.method === "GET" && url.pathname === "/api/characters") {
    const userId = authUserId(req);
    if (!userId) return sendJson(res, 401, { error: "unauthorized" });
    return sendJson(res, 200, { characters: store.listCharacters(userId), name: store.getUserById(userId).name });
  }

  if (req.method === "POST" && url.pathname === "/api/character") {
    const userId = authUserId(req);
    if (!userId) return sendJson(res, 401, { error: "unauthorized" });
    const body = await readJsonBody(req);
    const slot = Number(body.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) return sendJson(res, 400, { error: "invalid_slot" });
    if (!body.data || typeof body.data !== "object") return sendJson(res, 400, { error: "invalid_data" });
    store.saveCharacter(userId, slot, body.data);
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "DELETE" && url.pathname === "/api/character") {
    const userId = authUserId(req);
    if (!userId) return sendJson(res, 401, { error: "unauthorized" });
    const slot = Number(url.searchParams.get("slot"));
    if (!Number.isInteger(slot) || slot < 0 || slot > 9) return sendJson(res, 400, { error: "invalid_slot" });
    store.deleteCharacter(userId, slot);
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

const wss = new WebSocketServer({ server });

server.listen(port, () => {
  console.log(`Eryndor Multiplayer Server running on port ${port}`);
});

const players = new Map();
const clients = new Map();
const parties = new Map();
let hostId = null;

wss.on("connection", (ws) => {
  const playerId = Math.random().toString(36).substring(2, 9);
  console.log(`Player connected: ${playerId}`);

  clients.set(playerId, ws);
  players.set(playerId, { id: playerId, lastUpdate: Date.now() });

  if (hostId === null) {
    hostId = playerId;
    ws.send(JSON.stringify({ type: "host_assignment", isHost: true, yourId: playerId }));
  } else {
    ws.send(JSON.stringify({ type: "host_assignment", isHost: false, yourId: playerId }));
  }

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === "player_update") {
        players.set(playerId, {
          ...data.player,
          id: playerId,
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
        const broadcastData = JSON.stringify({
          type: "enemy_sync",
          enemies: data.enemies
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
        const targetClient = clients.get(data.targetId);
        if (targetClient && targetClient.readyState === 1) {
          targetClient.send(JSON.stringify({
            type: "player_damage",
            targetId: data.targetId,
            damage: data.damage
          }));
        }
      } else if (data.type === "chat") {
        const broadcastData = JSON.stringify({
          type: "chat",
          name: data.name,
          text: data.text
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
            targetWs.send(JSON.stringify({
              type: "party_invite",
              fromId: playerId,
              fromName: players.get(playerId).name
            }));
          }
        }
      } else if (data.type === "party_accept") {
        const senderId = data.fromId;
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
          if (party.members.length < limit) {
            party.members.push(playerId);
          }
        }

        broadcastPartyUpdate(party);
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