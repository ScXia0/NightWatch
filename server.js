const fs = require("fs");
const http = require("http");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || (process.env.RENDER ? "0.0.0.0" : "127.0.0.1");
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const MAP_WIDTH = 1800;
const MAP_HEIGHT = 1200;
const CAMP_X = MAP_WIDTH / 2;
const CAMP_Y = MAP_HEIGHT / 2;
const DAY_MS = 40000;
const NIGHT_MS = 32000;
const TOTAL_NIGHTS = 3;
const MAX_PLAYERS = 4;
const PLAYER_RADIUS = 18;
const PLAYER_SPEED = 245;
const ATTACK_RANGE = 90;
const ATTACK_ARC = 1.1;
const ATTACK_COOLDOWN_MS = 380;
const PLAYER_MAX_HP = 100;
const CAMP_MAX_HP = 180;
const CAMP_MAX_SHIELD = 80;

const PLAYER_COLORS = ["#f6d365", "#84fab0", "#6ec3ff", "#ff9a9e"];

const rooms = new Map();
let nextPlayerId = 1;

const server = http.createServer((req, res) => {
  const rawPath = req.url === "/" ? "/index.html" : req.url;
  const safePath = path.normalize(rawPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500);
      res.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    });
    res.end(content);
  });
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.playerId = `p${nextPlayerId++}`;
  ws.roomCode = null;
  send(ws, { type: "hello", playerId: ws.playerId });

  ws.on("message", (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      send(ws, { type: "error", message: "Invalid message payload." });
      return;
    }

    handleMessage(ws, message);
  });

  ws.on("close", () => {
    removePlayerFromRoom(ws);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Server listening on http://${HOST}:${PORT}`);
});

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (room.state === "playing") {
      updateRoom(room, now);
      maybeBroadcast(room, now);
    } else if (room.state === "lobby") {
      maybeBroadcast(room, now);
    }
  }
}, 50);

function handleMessage(ws, message) {
  switch (message.type) {
    case "create_room":
      createRoom(ws, message.name);
      break;
    case "join_room":
      joinRoom(ws, message.roomCode, message.name);
      break;
    case "input":
      updateInput(ws, message.input || {});
      break;
    case "act":
      queueAction(ws, message.action);
      break;
    case "start_game":
      startGame(ws);
      break;
    default:
      send(ws, { type: "error", message: "Unknown message type." });
  }
}

function createRoom(ws, rawName) {
  removePlayerFromRoom(ws);

  const name = sanitizeName(rawName);
  const roomCode = makeRoomCode();
  const room = createEmptyRoom(roomCode);
  const player = createPlayer(ws.playerId, name, 0, ws);

  room.players.set(player.id, player);
  room.hostId = player.id;
  rooms.set(roomCode, room);
  ws.roomCode = roomCode;
  room.lastBroadcastAt = 0;
  broadcastRoomState(room);
}

function joinRoom(ws, rawRoomCode, rawName) {
  removePlayerFromRoom(ws);

  const roomCode = String(rawRoomCode || "").trim().toUpperCase();
  const room = rooms.get(roomCode);
  if (!room) {
    send(ws, { type: "error", message: "Room not found." });
    return;
  }
  if (room.state !== "lobby") {
    send(ws, { type: "error", message: "This room is already in a match." });
    return;
  }
  if (room.players.size >= MAX_PLAYERS) {
    send(ws, { type: "error", message: "This room is already full." });
    return;
  }

  const player = createPlayer(
    ws.playerId,
    sanitizeName(rawName),
    room.players.size,
    ws
  );
  room.players.set(player.id, player);
  ws.roomCode = roomCode;
  room.lastBroadcastAt = 0;
  broadcastRoomState(room);
}

function startGame(ws) {
  const room = getRoomForSocket(ws);
  if (!room) {
    send(ws, { type: "error", message: "Join a room first." });
    return;
  }
  if (room.hostId !== ws.playerId) {
    send(ws, { type: "error", message: "Only the host can start the match." });
    return;
  }

  initializeMatch(room);
  broadcastRoomState(room);
}

function updateInput(ws, nextInput) {
  const room = getRoomForSocket(ws);
  if (!room || room.state !== "playing") {
    return;
  }

  const player = room.players.get(ws.playerId);
  if (!player) {
    return;
  }

  player.input.up = Boolean(nextInput.up);
  player.input.down = Boolean(nextInput.down);
  player.input.left = Boolean(nextInput.left);
  player.input.right = Boolean(nextInput.right);
  if (Number.isFinite(nextInput.angle)) {
    player.input.angle = clamp(nextInput.angle, -Math.PI, Math.PI);
  }
}

function queueAction(ws, action) {
  const room = getRoomForSocket(ws);
  if (!room || room.state !== "playing") {
    return;
  }
  const player = room.players.get(ws.playerId);
  if (!player) {
    return;
  }

  if (action === "attack") {
    player.attackQueued = true;
  } else if (action === "interact") {
    player.interactQueued = true;
  }
}

function createEmptyRoom(roomCode) {
  return {
    roomCode,
    hostId: null,
    players: new Map(),
    state: "lobby",
    phase: "day",
    phaseEndsAt: 0,
    completedNights: 0,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    camp: {
      x: CAMP_X,
      y: CAMP_Y,
      hp: CAMP_MAX_HP,
      maxHp: CAMP_MAX_HP,
      shield: 20,
      maxShield: CAMP_MAX_SHIELD,
      fuel: 0,
      ore: 0,
    },
    nodes: [],
    enemies: [],
    logs: ["Host can start when everyone is ready."],
    nextEntityId: 1,
    enemySpawnAt: 0,
    lastUpdateAt: Date.now(),
    lastBroadcastAt: 0,
    winner: null,
  };
}

function createPlayer(id, name, index, ws) {
  const spawn = getSpawnAroundCamp(index);
  return {
    id,
    ws,
    name,
    color: PLAYER_COLORS[index % PLAYER_COLORS.length],
    x: spawn.x,
    y: spawn.y,
    hp: PLAYER_MAX_HP,
    maxHp: PLAYER_MAX_HP,
    wood: 0,
    ore: 0,
    berries: 0,
    score: 0,
    input: {
      up: false,
      down: false,
      left: false,
      right: false,
      angle: 0,
    },
    attackQueued: false,
    interactQueued: false,
    lastAttackAt: 0,
    attackFlashUntil: 0,
    hurtFlashUntil: 0,
    invulnerableUntil: 0,
    downed: false,
  };
}

function initializeMatch(room) {
  room.state = "playing";
  room.phase = "day";
  room.phaseEndsAt = Date.now() + DAY_MS;
  room.completedNights = 0;
  room.lastUpdateAt = Date.now();
  room.lastBroadcastAt = 0;
  room.enemySpawnAt = 0;
  room.winner = null;
  room.nodes = [];
  room.enemies = [];
  room.logs = [
    "Day 1 begins. Gather wood and ore, then bring them back to camp with E.",
  ];
  room.camp.hp = CAMP_MAX_HP;
  room.camp.shield = 25;
  room.camp.fuel = 0;
  room.camp.ore = 0;

  let playerIndex = 0;
  for (const player of room.players.values()) {
    const spawn = getSpawnAroundCamp(playerIndex++);
    player.x = spawn.x;
    player.y = spawn.y;
    player.hp = PLAYER_MAX_HP;
    player.wood = 0;
    player.ore = 0;
    player.berries = 0;
    player.score = 0;
    player.downed = false;
    player.attackQueued = false;
    player.interactQueued = false;
    player.lastAttackAt = 0;
    player.attackFlashUntil = 0;
    player.hurtFlashUntil = 0;
    player.invulnerableUntil = 0;
    player.input = {
      up: false,
      down: false,
      left: false,
      right: false,
      angle: 0,
    };
  }

  seedNodes(room);
}

function seedNodes(room) {
  room.nodes = [];
  addResourceNodes(room, "wood", 15);
  addResourceNodes(room, "ore", 10);
  addResourceNodes(room, "berries", 8);
}

function addResourceNodes(room, type, count) {
  for (let i = 0; i < count; i += 1) {
    const point = findFreePoint(room);
    room.nodes.push({
      id: `n${room.nextEntityId++}`,
      type,
      x: point.x,
      y: point.y,
      hp: type === "berries" ? 1 : 2,
      reward: type === "wood" ? 2 : type === "ore" ? 1 : 1,
    });
  }
}

function updateRoom(room, now) {
  const dt = Math.min(100, now - room.lastUpdateAt);
  room.lastUpdateAt = now;

  for (const player of room.players.values()) {
    updatePlayer(room, player, dt, now);
  }

  if (room.phase === "night") {
    maybeSpawnEnemy(room, now);
  }

  updateEnemies(room, dt, now);
  room.enemies = room.enemies.filter((enemy) => enemy.hp > 0);
  room.nodes = room.nodes.filter((node) => node.hp > 0);

  if (room.camp.hp <= 0) {
    endMatch(room, "The camp collapsed before dawn.");
    return;
  }

  if (room.phase === "night" && everyoneDown(room)) {
    endMatch(room, "Everyone was downed in the night.");
    return;
  }

  if (now >= room.phaseEndsAt) {
    if (room.phase === "day") {
      startNight(room, now);
    } else {
      finishNight(room, now);
    }
  }
}

function updatePlayer(room, player, dt, now) {
  if (!player.downed) {
    let moveX = 0;
    let moveY = 0;
    if (player.input.left) moveX -= 1;
    if (player.input.right) moveX += 1;
    if (player.input.up) moveY -= 1;
    if (player.input.down) moveY += 1;

    if (moveX !== 0 || moveY !== 0) {
      const length = Math.hypot(moveX, moveY);
      player.x += (moveX / length) * PLAYER_SPEED * (dt / 1000);
      player.y += (moveY / length) * PLAYER_SPEED * (dt / 1000);
      player.x = clamp(player.x, PLAYER_RADIUS, room.mapWidth - PLAYER_RADIUS);
      player.y = clamp(player.y, PLAYER_RADIUS, room.mapHeight - PLAYER_RADIUS);
    }

    if (player.attackQueued && now - player.lastAttackAt >= ATTACK_COOLDOWN_MS) {
      player.lastAttackAt = now;
      player.attackFlashUntil = now + 120;
      performAttack(room, player);
    }
  }

  if (player.interactQueued) {
    performInteraction(room, player);
  }

  player.attackQueued = false;
  player.interactQueued = false;
}

function performAttack(room, player) {
  const hitEnemies = [];
  for (const enemy of room.enemies) {
    if (
      pointWithinAttackCone(
        player.x,
        player.y,
        player.input.angle,
        enemy.x,
        enemy.y,
        ATTACK_RANGE
      )
    ) {
      hitEnemies.push(enemy);
    }
  }

  if (hitEnemies.length > 0) {
    for (const enemy of hitEnemies) {
      enemy.hp -= 34;
      if (enemy.hp <= 0) {
        player.score += 25;
      }
    }
    return;
  }

  const node = room.nodes.find((candidate) =>
    pointWithinAttackCone(
      player.x,
      player.y,
      player.input.angle,
      candidate.x,
      candidate.y,
      ATTACK_RANGE
    )
  );

  if (!node) {
    return;
  }

  node.hp -= 1;
  if (node.hp <= 0) {
    if (node.type === "wood") {
      player.wood += node.reward;
      player.score += 6;
    } else if (node.type === "ore") {
      player.ore += node.reward;
      player.score += 8;
    } else {
      player.berries += node.reward;
      player.hp = Math.min(player.maxHp, player.hp + 18);
      player.score += 4;
    }
  }
}

function performInteraction(room, player) {
  if (player.downed) {
    return;
  }

  const reviveTarget = Array.from(room.players.values()).find(
    (other) =>
      other.id !== player.id &&
      other.downed &&
      distance(player.x, player.y, other.x, other.y) <= 60
  );

  if (reviveTarget) {
    reviveTarget.downed = false;
    reviveTarget.hp = 45;
    reviveTarget.invulnerableUntil = Date.now() + 1000;
    addLog(room, `${player.name} revived ${reviveTarget.name}.`);
    return;
  }

  if (distance(player.x, player.y, room.camp.x, room.camp.y) > 90) {
    return;
  }

  if (player.wood === 0 && player.ore === 0) {
    return;
  }

  const wood = player.wood;
  const ore = player.ore;
  room.camp.hp = Math.min(room.camp.maxHp, room.camp.hp + wood * 7);
  room.camp.shield = Math.min(room.camp.maxShield, room.camp.shield + ore * 12);
  room.camp.fuel += wood;
  room.camp.ore += ore;
  player.score += wood * 5 + ore * 7;
  player.wood = 0;
  player.ore = 0;
  addLog(room, `${player.name} reinforced the camp.`);
}

function maybeSpawnEnemy(room, now) {
  if (room.enemySpawnAt && now < room.enemySpawnAt) {
    return;
  }

  const tension = room.completedNights + 1;
  const packSize = Math.min(3 + tension, 6);
  const aliveEnemies = room.enemies.length;

  if (aliveEnemies > 16) {
    room.enemySpawnAt = now + 1200;
    return;
  }

  for (let i = 0; i < packSize; i += 1) {
    const spawn = spawnAtEdge(room);
    room.enemies.push({
      id: `e${room.nextEntityId++}`,
      x: spawn.x,
      y: spawn.y,
      hp: 54 + tension * 10,
      speed: 58 + tension * 7,
      damage: 12 + tension * 2,
      attackAt: 0,
      targetId: null,
    });
  }

  room.enemySpawnAt = now + Math.max(1100, 2400 - tension * 240);
}

function updateEnemies(room, dt, now) {
  for (const enemy of room.enemies) {
    const target = chooseEnemyTarget(room, enemy);
    enemy.targetId = target.type === "player" ? target.player.id : null;

    const angle = Math.atan2(target.y - enemy.y, target.x - enemy.x);
    enemy.x += Math.cos(angle) * enemy.speed * (dt / 1000);
    enemy.y += Math.sin(angle) * enemy.speed * (dt / 1000);

    if (target.type === "player") {
      const player = target.player;
      if (
        !player.downed &&
        distance(enemy.x, enemy.y, player.x, player.y) <= PLAYER_RADIUS + 18
      ) {
        if (now >= enemy.attackAt && now >= player.invulnerableUntil) {
          player.hp -= enemy.damage;
          player.hurtFlashUntil = now + 140;
          player.invulnerableUntil = now + 600;
          enemy.attackAt = now + 900;
          if (player.hp <= 0) {
            player.hp = 0;
            player.downed = true;
            addLog(room, `${player.name} was downed.`);
          }
        }
      }
    } else if (distance(enemy.x, enemy.y, room.camp.x, room.camp.y) <= 70) {
      if (now >= enemy.attackAt) {
        enemy.attackAt = now + 900;
        if (room.camp.shield > 0) {
          room.camp.shield = Math.max(0, room.camp.shield - enemy.damage);
        } else {
          room.camp.hp -= enemy.damage;
        }
      }
    }
  }
}

function startNight(room, now) {
  room.phase = "night";
  room.phaseEndsAt = now + NIGHT_MS;
  room.enemySpawnAt = now + 300;
  addLog(room, `Night ${room.completedNights + 1} has begun. Defend the camp.`);
}

function finishNight(room, now) {
  room.completedNights += 1;
  if (room.completedNights >= TOTAL_NIGHTS) {
    endMatch(room, "Dawn breaks. You survived the final night.", true);
    return;
  }

  room.phase = "day";
  room.phaseEndsAt = now + DAY_MS;
  room.enemySpawnAt = 0;
  room.enemies = [];
  refillNodes(room);
  room.camp.shield = Math.min(room.camp.maxShield, room.camp.shield + 15);
  for (const player of room.players.values()) {
    if (player.downed) {
      player.downed = false;
      player.hp = 60;
    } else {
      player.hp = Math.min(player.maxHp, player.hp + 18);
    }
  }
  addLog(room, `Day ${room.completedNights + 1} begins. Scavenge quickly.`);
}

function refillNodes(room) {
  const woodCount = room.nodes.filter((node) => node.type === "wood").length;
  const oreCount = room.nodes.filter((node) => node.type === "ore").length;
  const berryCount = room.nodes.filter((node) => node.type === "berries").length;
  addResourceNodes(room, "wood", Math.max(0, 12 - woodCount));
  addResourceNodes(room, "ore", Math.max(0, 8 - oreCount));
  addResourceNodes(room, "berries", Math.max(0, 6 - berryCount));
}

function endMatch(room, message, didWin = false) {
  room.state = "ended";
  room.winner = didWin ? "victory" : "defeat";
  room.phaseEndsAt = 0;
  room.enemies = [];
  addLog(room, message);
  broadcastRoomState(room);
}

function maybeBroadcast(room, now) {
  if (now - room.lastBroadcastAt < 90) {
    return;
  }

  room.lastBroadcastAt = now;
  broadcastRoomState(room);
}

function broadcastRoomState(room) {
  const snapshot = buildRoomSnapshot(room);
  for (const player of room.players.values()) {
    send(player.ws, {
      type: "room_state",
      snapshot,
      selfId: player.id,
    });
  }
}

function buildRoomSnapshot(room) {
  return {
    roomCode: room.roomCode,
    hostId: room.hostId,
    state: room.state,
    phase: room.phase,
    phaseEndsAt: room.phaseEndsAt,
    completedNights: room.completedNights,
    totalNights: TOTAL_NIGHTS,
    mapWidth: room.mapWidth,
    mapHeight: room.mapHeight,
    camp: { ...room.camp },
    winner: room.winner,
    logs: room.logs,
    players: Array.from(room.players.values()).map((player) => ({
      id: player.id,
      name: player.name,
      color: player.color,
      x: round(player.x),
      y: round(player.y),
      hp: player.hp,
      maxHp: player.maxHp,
      wood: player.wood,
      ore: player.ore,
      berries: player.berries,
      score: player.score,
      angle: player.input.angle,
      downed: player.downed,
      attackFlashUntil: player.attackFlashUntil,
      hurtFlashUntil: player.hurtFlashUntil,
    })),
    nodes: room.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      x: round(node.x),
      y: round(node.y),
      hp: node.hp,
    })),
    enemies: room.enemies.map((enemy) => ({
      id: enemy.id,
      x: round(enemy.x),
      y: round(enemy.y),
      hp: enemy.hp,
    })),
  };
}

function removePlayerFromRoom(ws) {
  if (!ws.roomCode) {
    return;
  }

  const room = rooms.get(ws.roomCode);
  ws.roomCode = null;
  if (!room) {
    return;
  }

  const player = room.players.get(ws.playerId);
  room.players.delete(ws.playerId);

  if (player && room.state === "playing") {
    addLog(room, `${player.name} disconnected.`);
  }

  if (room.players.size === 0) {
    rooms.delete(room.roomCode);
    return;
  }

  if (room.hostId === ws.playerId) {
    room.hostId = room.players.values().next().value.id;
  }

  if (room.state === "playing" && everyoneDown(room)) {
    endMatch(room, "The last survivor disconnected.");
  } else {
    room.lastBroadcastAt = 0;
    broadcastRoomState(room);
  }
}

function getRoomForSocket(ws) {
  if (!ws.roomCode) {
    return null;
  }
  return rooms.get(ws.roomCode) || null;
}

function chooseEnemyTarget(room, enemy) {
  let bestPlayer = null;
  let bestDistance = Infinity;
  for (const player of room.players.values()) {
    if (player.downed) {
      continue;
    }
    const d = distance(enemy.x, enemy.y, player.x, player.y);
    if (d < bestDistance) {
      bestDistance = d;
      bestPlayer = player;
    }
  }

  if (bestPlayer && bestDistance < 260) {
    return { type: "player", player: bestPlayer, x: bestPlayer.x, y: bestPlayer.y };
  }

  return { type: "camp", x: room.camp.x, y: room.camp.y };
}

function everyoneDown(room) {
  return Array.from(room.players.values()).every((player) => player.downed);
}

function findFreePoint(room) {
  for (let i = 0; i < 30; i += 1) {
    const x = 120 + Math.random() * (room.mapWidth - 240);
    const y = 120 + Math.random() * (room.mapHeight - 240);
    if (distance(x, y, room.camp.x, room.camp.y) < 180) {
      continue;
    }
    const overlaps = room.nodes.some(
      (node) => distance(x, y, node.x, node.y) < 55
    );
    if (!overlaps) {
      return { x, y };
    }
  }

  return {
    x: 120 + Math.random() * (room.mapWidth - 240),
    y: 120 + Math.random() * (room.mapHeight - 240),
  };
}

function spawnAtEdge(room) {
  const edge = Math.floor(Math.random() * 4);
  if (edge === 0) {
    return { x: Math.random() * room.mapWidth, y: 20 };
  }
  if (edge === 1) {
    return { x: room.mapWidth - 20, y: Math.random() * room.mapHeight };
  }
  if (edge === 2) {
    return { x: Math.random() * room.mapWidth, y: room.mapHeight - 20 };
  }
  return { x: 20, y: Math.random() * room.mapHeight };
}

function getSpawnAroundCamp(index) {
  const angle = (Math.PI * 2 * index) / MAX_PLAYERS;
  const radius = 58;
  return {
    x: CAMP_X + Math.cos(angle) * radius,
    y: CAMP_Y + Math.sin(angle) * radius,
  };
}

function pointWithinAttackCone(originX, originY, facing, x, y, range) {
  const dx = x - originX;
  const dy = y - originY;
  const length = Math.hypot(dx, dy);
  if (length > range) {
    return false;
  }
  const angle = Math.atan2(dy, dx);
  return Math.abs(normalizeAngle(angle - facing)) <= ATTACK_ARC / 2;
}

function send(ws, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(payload));
  }
}

function addLog(room, message) {
  room.logs = [message, ...room.logs].slice(0, 5);
}

function sanitizeName(name) {
  const trimmed = String(name || "").trim().slice(0, 18);
  return trimmed || "Survivor";
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let roomCode = "";
  do {
    roomCode = "";
    for (let i = 0; i < 5; i += 1) {
      roomCode += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
  } while (rooms.has(roomCode));
  return roomCode;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function normalizeAngle(angle) {
  let nextAngle = angle;
  while (nextAngle > Math.PI) nextAngle -= Math.PI * 2;
  while (nextAngle < -Math.PI) nextAngle += Math.PI * 2;
  return nextAngle;
}

function round(value) {
  return Math.round(value * 10) / 10;
}
