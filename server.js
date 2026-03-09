const WebSocket = require("ws");
const express = require("express");
const path = require("path");

const app = express();
const PORT = 8080;

app.use(express.static(__dirname));
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

const server = app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});

const wss = new WebSocket.Server({ server });

let players = {}; 
let activePowerUps = [];

// Banned IPs: si un jugador se queda sin vidas, su IP queda prohibida
const bannedIPs = new Set();
// Mantener referencia a sockets por playerId para cerrar conexiones si es necesario
const playerSockets = {};

const Phaser = {
    Math: {
        Between: (min, max) => Math.floor(Math.random() * (max - min + 1) + min)
    }
};

// Tamaño del mapa (ajusta según el tamaño que uses en el cliente)
const MAP_WIDTH = 1600;   // aumentado para mapa más grande
const MAP_HEIGHT = 900;  // aumentado para mapa más grande

// Generar algunos power-ups iniciales basados en el tamaño del mapa
function randBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1) + min);
}

function generateInitialPowerUps(count = 8) {
    const types = ['shield', 'speed'];
    for (let i = 0; i < count; i++) {
        const type = types[Math.floor(Math.random() * types.length)];
        const x = randBetween(100, MAP_WIDTH - 100);
        const y = randBetween(100, MAP_HEIGHT - 100);
        activePowerUps.push({ type, x, y });
    }
}
generateInitialPowerUps(12);

const cols = 8; // aumentado para más muros
const rows = 6; // aumentado para más muros
const marginX = 60;
const marginY = 60;
const spacingX = (MAP_WIDTH - 2 * marginX) / (cols - 1);
const spacingY = (MAP_HEIGHT - 2 * marginY) / (rows - 1);

let wallsData = [];
for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
        // Alterna orientación: horizontal o vertical
        const isHorizontal = (i + j) % 2 === 0;
        const wallWidth = isHorizontal ? 100 : 20;
        const wallHeight = isHorizontal ? 20 : 100;
        const x = Math.round(marginX + j * spacingX);
        const y = Math.round(marginY + i * spacingY);
        wallsData.push({ x, y, width: wallWidth, height: wallHeight });
    }
}

wss.on("connection", (ws, req) => {
    // Obtener IP remota simple (si hay proxy, considerar X-Forwarded-For)
    const ip = req && req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : null;
    if (ip && bannedIPs.has(ip)) {
        ws.send(JSON.stringify({ type: "banned" }));
        ws.close();
        return;
    }

    if (Object.keys(players).length >= 25) {
        ws.send(JSON.stringify({ type: "full" }));
        ws.close();
        return;
    }

    const playerId = Date.now().toString() + Math.floor(Math.random() * 10000);
    players[playerId] = {
        id: playerId,
        color: 0x00aa00,
        nick: "Jugador", // se actualizará al recibir el mensaje "color"
    position: { x: Phaser.Math.Between(50, MAP_WIDTH - 50), y: Phaser.Math.Between(50, MAP_HEIGHT - 50) },
        rotation: 0,
        health: 100,
        lives: 3,
        isShielded: false,      // <-- Nuevo: flag de escudo
        shieldHits: 0           // <-- Nuevo: contador de impactos
    };

    // vincular IP y socket
    if (ip) players[playerId].ip = ip;
    playerSockets[playerId] = ws;

    ws.send(JSON.stringify({
        type: "init",
        id: playerId,
        players: Object.values(players),
        walls: wallsData,
        powerUps: activePowerUps
    }));

    broadcast({
        type: "newPlayer",
        player: players[playerId]
    }, ws);

    ws.on("message", (msg) => {
        let data;
        try { data = JSON.parse(msg); } catch (e) { return; }
        if (!players[playerId]) return;

        switch (data.type) {
            case "color":
                players[playerId].color = data.color;
                players[playerId].nick = data.nick || "Jugador";
                broadcast({ type: "color", id: playerId, color: data.color, nick: players[playerId].nick });
                break;
            case "move":
                players[playerId].position = data.position;
                players[playerId].rotation = data.rotation;
                broadcast({
                    type: "move", id: playerId, position: data.position, rotation: data.rotation
                }, ws);
                break;
            case "shoot":
                // CORRECCIÓN: Usamos la posición inicial exacta que envía el cliente que disparó
                broadcast({
                    type: "shoot",
                    id: playerId,
                    position: data.startPos, // <-- CAMBIO AQUÍ: Se usa 'startPos' en lugar de la posición del jugador
                    direction: data.direction
                }, ws);
                break;
            case "collectPowerUp":
                activePowerUps = activePowerUps.filter(pu =>
                    !(pu.type === data.powerUp.type && pu.x === data.powerUp.x && pu.y === data.powerUp.y)
                );
                // Aplica el escudo en el servidor
                if (data.powerUp.type === "shield") {
                    players[data.playerId].isShielded = true;
                    players[data.playerId].shieldHits = 2;
                }
                broadcast({
                    type: "powerUpCollected",
                    powerUp: data.powerUp,
                    playerId: data.playerId
                });
                break;

            case "hit":
                const targetPlayer = players[data.targetId];
                if (targetPlayer) {
                    // Si tiene escudo, resta impactos
                    if (targetPlayer.isShielded && targetPlayer.shieldHits > 0) {
                        targetPlayer.shieldHits--;
                        if (targetPlayer.shieldHits <= 0) {
                            targetPlayer.isShielded = false;
                        }
                        // No reducir vida si el escudo bloquea el golpe
                    } else {
                        targetPlayer.health -= 25;
                        if (targetPlayer.health <= 0) {
                            targetPlayer.lives--;
                            if (targetPlayer.lives > 0) {
                                targetPlayer.health = 100;
                            } else {
                                targetPlayer.health = 0;
                                // Si se queda sin vidas, banear por IP
                                if (targetPlayer.ip) {
                                    bannedIPs.add(targetPlayer.ip);
                                    console.log(`Baneado por IP: ${targetPlayer.ip} (player ${data.targetId})`);
                                    const sock = playerSockets[data.targetId];
                                    if (sock && sock.readyState === WebSocket.OPEN) {
                                        try {
                                            sock.send(JSON.stringify({ type: "banned" }));
                                            sock.close();
                                        } catch (e) {}
                                    }
                                }
                            }
                        }
                    }
                    broadcast({
                        type: "healthUpdate",
                        id: data.targetId,
                        health: targetPlayer.health,
                        lives: targetPlayer.lives
                    });
                }
                break;
        }
    });

    ws.on("close", () => {
        delete players[playerId];
        if (playerSockets[playerId]) delete playerSockets[playerId];
        broadcast({ type: "remove", id: playerId });
    });
});

function broadcast(data, excludeWs) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN && client !== excludeWs) {
            client.send(JSON.stringify(data));
        }
    });
}

let powerUpInterval = setInterval(() => {
    const types = ['shield', 'speed'];
    const type = types[Math.floor(Math.random() * types.length)];
    const x = Phaser.Math.Between(100, MAP_WIDTH - 100);
    const y = Phaser.Math.Between(100, MAP_HEIGHT - 100);
    const newPowerUp = { type, x, y };
    activePowerUps.push(newPowerUp);
    broadcast({
        type: "powerUp",
        powerUp: newPowerUp
    });
}, 6000); // menor intervalo para más densidad

console.log("Servidor WebSocket iniciado.");