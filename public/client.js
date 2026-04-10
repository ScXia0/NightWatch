const state = {
  socket: null,
  connected: false,
  selfId: null,
  snapshot: null,
  input: {
    up: false,
    down: false,
    left: false,
    right: false,
    angle: 0,
  },
  mouseWorld: { x: 0, y: 0 },
};

const canvas = document.querySelector("#gameCanvas");
const ctx = canvas.getContext("2d");

const connectionStatus = document.querySelector("#connectionStatus");
const nameInput = document.querySelector("#nameInput");
const roomCodeInput = document.querySelector("#roomCodeInput");
const createRoomButton = document.querySelector("#createRoomButton");
const joinRoomButton = document.querySelector("#joinRoomButton");
const copyRoomButton = document.querySelector("#copyRoomButton");
const startGameButton = document.querySelector("#startGameButton");
const lobbyCard = document.querySelector("#lobbyCard");
const entryCard = document.querySelector("#entryCard");
const roomCodeDisplay = document.querySelector("#roomCodeDisplay");
const hostHint = document.querySelector("#hostHint");
const playerList = document.querySelector("#playerList");
const logList = document.querySelector("#logList");
const phaseLabel = document.querySelector("#phaseLabel");
const timerLabel = document.querySelector("#timerLabel");
const campLabel = document.querySelector("#campLabel");
const inventoryLabel = document.querySelector("#inventoryLabel");
const overlay = document.querySelector("#overlay");
const overlayTitle = document.querySelector("#overlayTitle");
const overlayText = document.querySelector("#overlayText");

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${protocol}://${window.location.host}`);

  state.socket.addEventListener("open", () => {
    state.connected = true;
    connectionStatus.textContent = "已连接";
    connectionStatus.style.color = "#8ee6b7";
  });

  state.socket.addEventListener("close", () => {
    state.connected = false;
    connectionStatus.textContent = "连接断开";
    connectionStatus.style.color = "#ff7d73";
  });

  state.socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    handleMessage(message);
  });
}

function handleMessage(message) {
  if (message.type === "hello") {
    state.selfId = message.playerId;
    return;
  }

  if (message.type === "room_state") {
    state.selfId = message.selfId;
    state.snapshot = message.snapshot;
    renderLobby();
    renderHud();
    renderLogs();
    renderOverlay();
    return;
  }

  if (message.type === "error") {
    window.alert(message.message);
  }
}

function send(payload) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    return;
  }
  state.socket.send(JSON.stringify(payload));
}

function getSelfPlayer() {
  return state.snapshot?.players.find((player) => player.id === state.selfId) || null;
}

function renderLobby() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    lobbyCard.classList.add("hidden");
    entryCard.classList.remove("hidden");
    return;
  }

  entryCard.classList.add("hidden");
  lobbyCard.classList.remove("hidden");
  roomCodeDisplay.textContent = snapshot.roomCode;

  const isHost = snapshot.hostId === state.selfId;
  hostHint.textContent = isHost
    ? "你是房主，可以开始这一局。"
    : "等待房主开始。";
  startGameButton.disabled = !isHost || snapshot.state !== "lobby";
  startGameButton.textContent = snapshot.state === "lobby" ? "开始守夜" : "对局进行中";

  playerList.innerHTML = snapshot.players
    .map((player) => {
      const label = player.id === snapshot.hostId ? "房主" : "队友";
      return `<li><span style="color:${player.color}">${player.name}</span> · ${label}</li>`;
    })
    .join("");
}

function renderHud() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    phaseLabel.textContent = "大厅";
    timerLabel.textContent = "--";
    campLabel.textContent = "HP --";
    inventoryLabel.textContent = "木 0 / 矿 0";
    return;
  }

  const player = getSelfPlayer();
  if (snapshot.state === "lobby") {
    phaseLabel.textContent = "大厅";
    timerLabel.textContent = "--";
  } else if (snapshot.state === "ended") {
    phaseLabel.textContent = snapshot.winner === "victory" ? "胜利" : "失败";
    timerLabel.textContent = "--";
  } else {
    const stage = snapshot.phase === "day" ? "白天搜刮" : `夜袭 ${snapshot.completedNights + 1}`;
    phaseLabel.textContent = stage;
    timerLabel.textContent = `${Math.max(
      0,
      Math.ceil((snapshot.phaseEndsAt - Date.now()) / 1000)
    )}s`;
  }

  campLabel.textContent = `HP ${snapshot.camp.hp}/${snapshot.camp.maxHp} · 盾 ${snapshot.camp.shield}`;
  inventoryLabel.textContent = player
    ? `木 ${player.wood} / 矿 ${player.ore} / 生命 ${player.hp}`
    : "木 0 / 矿 0";
}

function renderLogs() {
  const logs = state.snapshot?.logs || ["创建房间后就能开始。"];
  logList.innerHTML = logs
    .map((line) => `<div class="log-item">${escapeHtml(line)}</div>`)
    .join("");
}

function renderOverlay() {
  const snapshot = state.snapshot;
  if (!snapshot) {
    overlay.classList.remove("hidden");
    overlayTitle.textContent = "创建房间后邀请朋友加入";
    overlayText.textContent = "这个版本支持 1 到 4 人联机。主机开始后立即进入一局制守夜。";
    return;
  }

  if (snapshot.state === "lobby") {
    overlay.classList.remove("hidden");
    overlayTitle.textContent = "大厅已就绪";
    overlayText.textContent = "先创建或加入房间。房主点击“开始守夜”后开局。";
    return;
  }

  if (snapshot.state === "ended") {
    overlay.classList.remove("hidden");
    overlayTitle.textContent =
      snapshot.winner === "victory" ? "这一夜扛住了" : "营地失守";
    overlayText.textContent =
      snapshot.winner === "victory"
        ? "三次夜袭全部守住了，刷新页面可以再开一局。"
        : "可以刷新页面重新开房，再试一轮更稳的资源分配。";
    return;
  }

  overlay.classList.add("hidden");
}

function startInputLoop() {
  setInterval(() => {
    send({
      type: "input",
      input: state.input,
    });
    renderHud();
  }, 50);
}

function bindEvents() {
  createRoomButton.addEventListener("click", () => {
    send({ type: "create_room", name: nameInput.value });
  });

  joinRoomButton.addEventListener("click", () => {
    send({
      type: "join_room",
      name: nameInput.value,
      roomCode: roomCodeInput.value.toUpperCase(),
    });
  });

  copyRoomButton.addEventListener("click", async () => {
    const code = state.snapshot?.roomCode;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      copyRoomButton.textContent = "已复制";
      window.setTimeout(() => {
        copyRoomButton.textContent = "复制";
      }, 1000);
    } catch (error) {
      window.alert("复制失败，可以手动复制房间码。");
    }
  });

  startGameButton.addEventListener("click", () => {
    send({ type: "start_game" });
  });

  window.addEventListener("keydown", (event) => {
    if (event.repeat && (event.key === " " || event.key.toLowerCase() === "e")) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "w" || event.key === "ArrowUp") state.input.up = true;
    if (key === "s" || event.key === "ArrowDown") state.input.down = true;
    if (key === "a" || event.key === "ArrowLeft") state.input.left = true;
    if (key === "d" || event.key === "ArrowRight") state.input.right = true;

    if (key === "e") {
      send({ type: "act", action: "interact" });
    }
    if (event.key === " ") {
      event.preventDefault();
      send({ type: "act", action: "attack" });
    }
  });

  window.addEventListener("keyup", (event) => {
    const key = event.key.toLowerCase();
    if (key === "w" || event.key === "ArrowUp") state.input.up = false;
    if (key === "s" || event.key === "ArrowDown") state.input.down = false;
    if (key === "a" || event.key === "ArrowLeft") state.input.left = false;
    if (key === "d" || event.key === "ArrowRight") state.input.right = false;
  });

  canvas.addEventListener("mousemove", (event) => {
    const point = screenToWorld(event.clientX, event.clientY);
    state.mouseWorld = point;
    const player = getSelfPlayer();
    if (!player) {
      return;
    }
    state.input.angle = Math.atan2(point.y - player.y, point.x - player.x);
  });

  canvas.addEventListener("mousedown", () => {
    send({ type: "act", action: "attack" });
  });
}

function screenToWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (clientX - rect.left) * scaleX;
  const y = (clientY - rect.top) * scaleY;
  const camera = getCamera();
  return {
    x: camera.x + x,
    y: camera.y + y,
  };
}

function getCamera() {
  const snapshot = state.snapshot;
  const player = getSelfPlayer();
  if (!snapshot || !player) {
    return { x: 0, y: 0 };
  }

  const halfW = canvas.width / 2;
  const halfH = canvas.height / 2;
  const x = clamp(player.x - halfW, 0, snapshot.mapWidth - canvas.width);
  const y = clamp(player.y - halfH, 0, snapshot.mapHeight - canvas.height);
  return { x, y };
}

function gameLoop() {
  draw();
  window.requestAnimationFrame(gameLoop);
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackground();

  const snapshot = state.snapshot;
  if (!snapshot) {
    return;
  }

  const camera = getCamera();
  ctx.save();
  ctx.translate(-camera.x, -camera.y);

  drawMap(snapshot);
  drawNodes(snapshot);
  drawCamp(snapshot);
  drawEnemies(snapshot);
  drawPlayers(snapshot);

  ctx.restore();
}

function drawBackground() {
  const snapshot = state.snapshot;
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  if (!snapshot || snapshot.phase === "day") {
    gradient.addColorStop(0, "#264f46");
    gradient.addColorStop(1, "#10251e");
  } else {
    gradient.addColorStop(0, "#101a2f");
    gradient.addColorStop(1, "#04070f");
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawMap(snapshot) {
  ctx.fillStyle = snapshot.phase === "day" ? "rgba(173, 221, 172, 0.05)" : "rgba(255,255,255,0.03)";
  for (let x = 0; x < snapshot.mapWidth; x += 120) {
    ctx.fillRect(x, 0, 2, snapshot.mapHeight);
  }
  for (let y = 0; y < snapshot.mapHeight; y += 120) {
    ctx.fillRect(0, y, snapshot.mapWidth, 2);
  }
}

function drawNodes(snapshot) {
  for (const node of snapshot.nodes) {
    if (node.type === "wood") {
      ctx.fillStyle = "#53834c";
      ctx.beginPath();
      ctx.arc(node.x, node.y, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#8cd46d";
      ctx.beginPath();
      ctx.arc(node.x, node.y - 10, 11, 0, Math.PI * 2);
      ctx.fill();
    } else if (node.type === "ore") {
      ctx.fillStyle = "#7fa0b8";
      ctx.beginPath();
      ctx.moveTo(node.x - 16, node.y + 12);
      ctx.lineTo(node.x - 6, node.y - 14);
      ctx.lineTo(node.x + 16, node.y - 4);
      ctx.lineTo(node.x + 8, node.y + 15);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = "#cc5266";
      ctx.beginPath();
      ctx.arc(node.x, node.y, 10, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#6ea84f";
      ctx.fillRect(node.x - 2, node.y + 8, 4, 8);
    }
  }
}

function drawCamp(snapshot) {
  const camp = snapshot.camp;
  const glow = ctx.createRadialGradient(camp.x, camp.y, 18, camp.x, camp.y, 95);
  glow.addColorStop(0, "rgba(255, 195, 106, 0.95)");
  glow.addColorStop(1, snapshot.phase === "day" ? "rgba(255, 195, 106, 0.06)" : "rgba(255, 195, 106, 0.18)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(camp.x, camp.y, 95, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#3d2b1f";
  ctx.beginPath();
  ctx.arc(camp.x, camp.y, 34, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#ffd37e";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(camp.x, camp.y, 28, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "#ffcc75";
  ctx.beginPath();
  ctx.arc(camp.x, camp.y, 12, 0, Math.PI * 2);
  ctx.fill();
}

function drawEnemies(snapshot) {
  for (const enemy of snapshot.enemies) {
    ctx.fillStyle = "#ff7d73";
    ctx.beginPath();
    ctx.arc(enemy.x, enemy.y, 16, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#3c0f1a";
    ctx.beginPath();
    ctx.arc(enemy.x - 5, enemy.y - 3, 2.5, 0, Math.PI * 2);
    ctx.arc(enemy.x + 5, enemy.y - 3, 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawPlayers(snapshot) {
  for (const player of snapshot.players) {
    const isSelf = player.id === state.selfId;
    const alpha = player.downed ? 0.48 : 1;

    if (player.attackFlashUntil > Date.now() && !player.downed) {
      ctx.fillStyle = "rgba(255, 230, 168, 0.18)";
      ctx.beginPath();
      ctx.moveTo(player.x, player.y);
      ctx.arc(player.x, player.y, 78, player.angle - 0.5, player.angle + 0.5);
      ctx.closePath();
      ctx.fill();
    }

    ctx.globalAlpha = alpha;
    ctx.fillStyle = player.color;
    ctx.beginPath();
    ctx.arc(player.x, player.y, 18, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = isSelf ? "#ffffff" : "rgba(255,255,255,0.35)";
    ctx.lineWidth = isSelf ? 3 : 2;
    ctx.beginPath();
    ctx.arc(player.x, player.y, 21, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = "#162026";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(player.x, player.y);
    ctx.lineTo(player.x + Math.cos(player.angle) * 20, player.y + Math.sin(player.angle) * 20);
    ctx.stroke();

    ctx.globalAlpha = 1;

    const barWidth = 42;
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(player.x - barWidth / 2, player.y - 34, barWidth, 6);
    ctx.fillStyle = player.downed ? "#ff7d73" : "#8ee6b7";
    ctx.fillRect(
      player.x - barWidth / 2,
      player.y - 34,
      barWidth * Math.max(0, player.hp) / player.maxHp,
      6
    );

    ctx.fillStyle = "#f3faf5";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(player.name, player.x, player.y - 42);

    if (player.downed) {
      ctx.fillStyle = "#ffd37e";
      ctx.fillText("待救援", player.x, player.y + 34);
    }
  }
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

bindEvents();
connect();
startInputLoop();
gameLoop();
