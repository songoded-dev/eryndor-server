const http = require("http");
const { WebSocketServer } = require("ws");

const port = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
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