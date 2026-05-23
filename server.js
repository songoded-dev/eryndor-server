const { WebSocketServer } = require('ws');

const wss = new WebSocketServer({ port: 3000 });

console.log('Eryndor Multiplayer Server running on port 3000');

const players = new Map();
let hostId = null;

wss.on('connection', (ws) => {
  const playerId = Math.random().toString(36).substring(2, 9);
  console.log(`Player connected: ${playerId}`);

  players.set(playerId, { id: playerId, lastUpdate: Date.now() });

  if (hostId === null) {
    hostId = playerId;
    ws.send(JSON.stringify({ type: 'host_assignment', isHost: true, yourId: playerId }));
  } else {
    ws.send(JSON.stringify({ type: 'host_assignment', isHost: false, yourId: playerId }));
  }

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'player_update') {
        players.set(playerId, {
          ...data.player,
          id: playerId,
          lastUpdate: Date.now()
        });

        const broadcastData = JSON.stringify({
          type: 'player_update',
          player: players.get(playerId)
        });

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === 1) {
            client.send(broadcastData);
          }
        });
      } else if (data.type === 'enemy_sync' && playerId === hostId) {
        const broadcastData = JSON.stringify({
          type: 'enemy_sync',
          enemies: data.enemies
        });

        wss.clients.forEach((client) => {
          if (client !== ws && client.readyState === 1) {
            client.send(broadcastData);
          }
        });
      } else if (data.type === 'enemy_damage') {
        wss.clients.forEach((client) => {
          if (hostId !== null && client !== ws && client.readyState === 1) {
            client.send(JSON.stringify(data));
          }
        });
      } else if (data.type === 'chat') {
        const broadcastData = JSON.stringify({
          type: 'chat',
          name: data.name,
          text: data.text
        });

        wss.clients.forEach((client) => {
          if (client.readyState === 1) {
            client.send(broadcastData);
          }
        });
      }
    } catch (e) {
      console.error('Failed to parse message', e);
    }
  });

  ws.on('close', () => {
    console.log(`Player disconnected: ${playerId}`);
    players.delete(playerId);

    if (playerId === hostId) {
      hostId = null;
      const nextId = players.keys().next().value;
      if (nextId) {
        hostId = nextId;
        wss.clients.forEach((client) => {
          if (client.readyState === 1) {
            client.send(JSON.stringify({ type: 'host_promotion', newHostId: hostId }));
          }
        });
      }
    }

    const disconnectData = JSON.stringify({
      type: 'disconnect',
      id: playerId
    });

    wss.clients.forEach((client) => {
      if (client.readyState === 1) {
        client.send(disconnectData);
      }
    });
  });

  ws.on('error', console.error);
});
