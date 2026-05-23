     1 const { WebSocketServer } = require('ws');
     2
     3 const wss = new WebSocketServer({ port: 3000 });
     4
     5 console.log('Eryndor Multiplayer Server running on port 3000');
     6
     7 const players = new Map();
     8 let hostId = null;
     9
    10 wss.on('connection', (ws) => {
    11   const playerId = Math.random().toString(36).substring(2, 9);
    12   console.log(`Player connected: ${playerId}`);
    13
    14   // Register player immediately
    15   players.set(playerId, { id: playerId, lastUpdate: Date.now() });
    16
    17   // Initial host assignment
    18   if (hostId === null) {
    19     hostId = playerId;
    20     ws.send(JSON.stringify({ type: 'host_assignment', isHost: true, yourId: playerId }));
    21   } else {
    22     ws.send(JSON.stringify({ type: 'host_assignment', isHost: false, yourId: playerId }));
    23   }
    24
    25   ws.on('message', (message) => {
    26     try {
    27       const data = JSON.parse(message);
    28
    29       if (data.type === 'player_update') {
    30         players.set(playerId, {
    31           ...data.player,
    32           id: playerId,
    33           lastUpdate: Date.now()
    34         });
    35
    36         const broadcastData = JSON.stringify({
    37           type: 'player_update',
    38           player: players.get(playerId)
    39         });
    40
    41         wss.clients.forEach((client) => {
    42           if (client !== ws && client.readyState === 1) {
    43             client.send(broadcastData);
    44           }
    45         });
    46       } else if (data.type === 'enemy_sync' && playerId === hostId) {
    47         // Only host can sync enemies
    48         const broadcastData = JSON.stringify({
    49           type: 'enemy_sync',
    50           enemies: data.enemies
    51         });
    52
    53         wss.clients.forEach((client) => {
    54           if (client !== ws && client.readyState === 1) {
    55             client.send(broadcastData);
    56           }
    57         });
    58       } else if (data.type === 'enemy_damage') {
    59         // Forward damage to host
    60         wss.clients.forEach((client) => {
    61           // Find host client
    62           if (hostId !== null && client !== ws && client.readyState === 1) {
    63             // We don't have a direct map of id -> ws, so we broadcast but host will check
    64             client.send(JSON.stringify(data));
    65           }
    66         });
    67       } else if (data.type === 'chat') {
    68         const broadcastData = JSON.stringify({
    69           type: 'chat',
    70           name: data.name,
    71           text: data.text
    72         });
    73
    74         wss.clients.forEach((client) => {
    75           if (client.readyState === 1) {
    76             client.send(broadcastData);
    77           }
    78         });
    79       }
    80     } catch (e) {
    81       console.error('Failed to parse message', e);
    82     }
    83   });
    84
    85   ws.on('close', () => {
    86     console.log(`Player disconnected: ${playerId}`);
    87     players.delete(playerId);
    88
    89     if (playerId === hostId) {
    90       hostId = null;
    91       // Assign new host
    92       const nextId = players.keys().next().value;
    93       if (nextId) {
    94         hostId = nextId;
    95         // Need to find the ws for nextId.
    96         // Let's broadcast host change and clients will check their own ID.
    97         wss.clients.forEach((client) => {
    98           if (client.readyState === 1) {
    99             client.send(JSON.stringify({ type: 'host_promotion', newHostId: hostId }));
   100           }
   101         });
   102       }
   103     }
   104
   105     // Notify others
   106     const disconnectData = JSON.stringify({
   107       type: 'disconnect',
   108       id: playerId
   109     });
   110
   111     wss.clients.forEach((client) => {
   112       if (client.readyState === 1) {
   113         client.send(disconnectData);
   114       }
   115     });
   116   });
   117
   118   ws.on('error', console.error);
   119 });
