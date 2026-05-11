const boardCanvas = document.querySelector("#board");
const ctx = boardCanvas.getContext("2d");
const statusText = document.querySelector("#statusText");
const turnStone = document.querySelector("#turnStone");
const playerBadge = document.querySelector("#playerBadge");
const themeToggleButton = document.querySelector("#themeToggle");
const newGameButton = document.querySelector("#newGame");
const undoButton = document.querySelector("#undo");
const aiToggle = document.querySelector("#aiToggle");
const aiLevelSelect = document.querySelector("#aiLevel");
const playerColorSelect = document.querySelector("#playerColor");
const blackScoreText = document.querySelector("#blackScore");
const whiteScoreText = document.querySelector("#whiteScore");
const moveList = document.querySelector("#moveList");
const createInviteButton = document.querySelector("#createInvite");
const joinInviteButton = document.querySelector("#joinInvite");
const copyInviteButton = document.querySelector("#copyInvite");
const leaveRoomButton = document.querySelector("#leaveRoom");
const acceptAnswerButton = document.querySelector("#acceptAnswer");
const inviteCode = document.querySelector("#inviteCode");
const answerCode = document.querySelector("#answerCode");
const connectionText = document.querySelector("#connectionText");
const roomMeta = document.querySelector("#roomMeta");
const winnerDialog = document.querySelector("#winnerDialog");
const winnerTitle = document.querySelector("#winnerTitle");
const winnerMessage = document.querySelector("#winnerMessage");
const winnerRematchButton = document.querySelector("#winnerRematch");
const winnerCloseButton = document.querySelector("#winnerClose");

const size = 15;
const cell = boardCanvas.width / (size + 1);
const origin = cell;
const empty = 0;
const black = 1;
const white = 2;
const winnerPromptDelay = 2200;
const activeRoomKey = "gomokuActiveRoom";
const roomStatePrefix = "gomokuRoomState:";
const localSnapshotKey = "gomokuLocalGame";

let board = createBoard();
let current = black;
let winner = empty;
let moves = [];
let scores = { [black]: 0, [white]: 0 };
let undoQuota = { [black]: 3, [white]: 3 };
let lastMove = null;
let winningLine = [];
let aiThinking = false;
let peer = null;
let channel = null;
let localRemoteColor = null;
let connectionRole = null;
let connectionFailed = false;
let connectionState = "未连接";
let serverRoom = null;
let serverSeq = 0;
let serverPolling = false;
let serverSocket = null;
let serverPlayers = 0;
let serverOnline = 0;
let undoRequestId = null;
let undoPending = false;
let rematchRequestId = null;
let rematchPending = false;
let winnerPromptDismissed = false;
let winnerPromptReady = false;
let winnerPromptTimer = null;
let serverClientId = sessionStorage.getItem("gomokuClientId");
let themeMode = localStorage.getItem("gomokuTheme") || "auto";

if (!serverClientId) {
  serverClientId = createClientId();
  sessionStorage.setItem("gomokuClientId", serverClientId);
}

applyTheme();

function createClientId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }
  const randomPart =
    window.crypto && typeof window.crypto.getRandomValues === "function"
      ? Array.from(window.crypto.getRandomValues(new Uint32Array(4)), (value) =>
          value.toString(16).padStart(8, "0")
        ).join("")
      : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `client-${randomPart}`;
}

function createBoard() {
  return Array.from({ length: size }, () => Array(size).fill(empty));
}

function applyTheme() {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = themeMode === "dark" || (themeMode === "auto" && prefersDark);
  document.documentElement.dataset.theme = isDark ? "dark" : "light";
  themeToggleButton.textContent = isDark ? "浅色" : "黑色";
  themeToggleButton.setAttribute("aria-label", isDark ? "切换浅色模式" : "切换黑色模式");
}

function toggleTheme() {
  const isDark = document.documentElement.dataset.theme === "dark";
  themeMode = isDark ? "light" : "dark";
  localStorage.setItem("gomokuTheme", themeMode);
  applyTheme();
  render();
}

function colorName(color) {
  return color === black ? "黑棋" : "白棋";
}

function opponent(color) {
  return color === black ? white : black;
}

function playerColor() {
  return playerColorSelect.value === "black" ? black : white;
}

function aiColor() {
  return opponent(playerColor());
}

function isAiTurn() {
  return aiToggle.checked && !isServerGame() && current === aiColor() && !winner;
}

function pointToText(row, col) {
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawBoard() {
  const w = boardCanvas.width;
  ctx.clearRect(0, 0, w, w);

  ctx.fillStyle = cssVar("--board") || "#d9ad63";
  ctx.fillRect(0, 0, w, w);

  ctx.strokeStyle = cssVar("--board-line") || "rgba(41, 28, 16, 0.72)";
  ctx.lineWidth = 2;
  for (let i = 0; i < size; i += 1) {
    const p = origin + i * cell;
    ctx.beginPath();
    ctx.moveTo(origin, p);
    ctx.lineTo(origin + (size - 1) * cell, p);
    ctx.moveTo(p, origin);
    ctx.lineTo(p, origin + (size - 1) * cell);
    ctx.stroke();
  }

  drawStar(3, 3);
  drawStar(3, 11);
  drawStar(7, 7);
  drawStar(11, 3);
  drawStar(11, 11);

  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if (board[row][col]) drawStone(row, col, board[row][col]);
    }
  }

  if (winningLine.length) drawWinningLine();
  if (lastMove) drawLastMove(lastMove.row, lastMove.col);
}

function drawStar(row, col) {
  const x = origin + col * cell;
  const y = origin + row * cell;
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = cssVar("--board-star") || "rgba(35, 24, 15, 0.86)";
  ctx.fill();
}

function drawStone(row, col, color) {
  const x = origin + col * cell;
  const y = origin + row * cell;
  const radius = cell * 0.38;

  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.28)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 5;
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  const gradient = ctx.createRadialGradient(
    x - radius * 0.35,
    y - radius * 0.42,
    radius * 0.12,
    x,
    y,
    radius
  );
  if (color === black) {
    gradient.addColorStop(0, "#72777b");
    gradient.addColorStop(0.38, "#282d31");
    gradient.addColorStop(1, "#07090b");
  } else {
    gradient.addColorStop(0, "#ffffff");
    gradient.addColorStop(0.54, "#f1f1eb");
    gradient.addColorStop(1, "#c7c7bd");
  }
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.strokeStyle = color === black
    ? cssVar("--black-stone-ring") || "rgba(255, 255, 255, 0.1)"
    : cssVar("--white-stone-ring") || "rgba(26, 31, 35, 0.18)";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawLastMove(row, col) {
  const x = origin + col * cell;
  const y = origin + row * cell;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.strokeStyle = board[row][col] === black
    ? cssVar("--last-black") || "#f4d35e"
    : cssVar("--last-white") || "#2f7d68";
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawWinningLine() {
  const first = winningLine[0];
  const last = winningLine[winningLine.length - 1];
  if (!first || !last) return;

  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(244, 211, 94, 0.92)";
  ctx.lineWidth = 10;
  ctx.shadowColor = "rgba(244, 211, 94, 0.5)";
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.moveTo(origin + first.col * cell, origin + first.row * cell);
  ctx.lineTo(origin + last.col * cell, origin + last.row * cell);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(244, 211, 94, 0.95)";
  for (const point of winningLine) {
    ctx.beginPath();
    ctx.arc(origin + point.col * cell, origin + point.row * cell, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function getCell(event) {
  const rect = boardCanvas.getBoundingClientRect();
  const scale = boardCanvas.width / rect.width;
  const x = (event.clientX - rect.left) * scale;
  const y = (event.clientY - rect.top) * scale;
  const col = Math.round((x - origin) / cell);
  const row = Math.round((y - origin) / cell);
  if (row < 0 || row >= size || col < 0 || col >= size) return null;

  const px = origin + col * cell;
  const py = origin + row * cell;
  const tolerance = window.matchMedia("(pointer: coarse)").matches ? 0.58 : 0.45;
  if (Math.hypot(x - px, y - py) > cell * tolerance) return null;
  return { row, col };
}

function place(row, col, color, options = {}) {
  if (board[row][col] !== empty || winner) return false;
  board[row][col] = color;
  moves.push({ row, col, color });
  lastMove = { row, col };

  if (hasFive(row, col, color)) {
    winner = color;
    winningLine = findWinningLine(row, col, color);
    scores[color] += 1;
    prepareWinnerPrompt();
  } else if (moves.length === size * size) {
    winner = -1;
    prepareWinnerPrompt();
  } else {
    current = opponent(current);
  }

  render();
  saveRoomSnapshot();
  if (!options.remote) {
    sendServerEvent({ type: "move", row, col, color });
    sendServerState();
    sendPeerMessage({ type: "move", row, col, color });
  }
  return true;
}

function hasFive(row, col, color) {
  return [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ].some(([dr, dc]) => countLine(row, col, dr, dc, color) >= 5);
}

function findWinningLine(row, col, color) {
  const directions = [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of directions) {
    const line = [
      ...collectDirection(row, col, -dr, -dc, color).reverse(),
      { row, col },
      ...collectDirection(row, col, dr, dc, color),
    ];
    if (line.length >= 5) return line;
  }
  return [];
}

function collectDirection(row, col, dr, dc, color) {
  const points = [];
  let r = row + dr;
  let c = col + dc;
  while (r >= 0 && r < size && c >= 0 && c < size && board[r][c] === color) {
    points.push({ row: r, col: c });
    r += dr;
    c += dc;
  }
  return points;
}

function countLine(row, col, dr, dc, color) {
  return (
    1 +
    countDirection(row, col, dr, dc, color) +
    countDirection(row, col, -dr, -dc, color)
  );
}

function countDirection(row, col, dr, dc, color) {
  let total = 0;
  let r = row + dr;
  let c = col + dc;
  while (r >= 0 && r < size && c >= 0 && c < size && board[r][c] === color) {
    total += 1;
    r += dr;
    c += dc;
  }
  return total;
}

function render() {
  drawBoard();
  updateStatus();
  updateMoves();
  blackScoreText.textContent = scores[black];
  whiteScoreText.textContent = scores[white];
  newGameButton.disabled = aiThinking || rematchPending;
  newGameButton.textContent = rematchPending ? "等待回应" : "新局";
  undoButton.disabled = moves.length === 0 || aiThinking || undoPending || !canUndoNow();
  undoButton.textContent = undoButtonText();
  winnerRematchButton.disabled = rematchPending;
  winnerRematchButton.textContent = rematchPending ? "等待回应" : "再来一局";
  copyInviteButton.disabled = !inviteCode.value.trim();
  leaveRoomButton.disabled = !isServerGame() && !isRemoteGame();
  acceptAnswerButton.disabled =
    isServerPage() ||
    connectionRole !== "host" ||
    !answerCode.value.trim() ||
    isRemoteGame() ||
    !peer ||
    peer.signalingState !== "have-local-offer";
  connectionText.textContent = connectionState;
  roomMeta.textContent = roomMetaText();
  updatePlayerBadge();
  updateWinnerPrompt();
}

function undoButtonText() {
  if (undoPending) return "等待回应";
  if (isServerGame() || isRemoteGame()) return "申请悔棋";
  return "悔棋";
}

function canUndoNow() {
  if (isServerGame() || isRemoteGame()) return hasMoveByColor(localRemoteColor);
  return true;
}

function roomMetaText() {
  if (isServerGame()) {
    return `房间 ${serverRoom} · 在线 ${serverOnline}/${Math.max(serverPlayers, 2)} · 悔棋 ${undoQuota[localRemoteColor]}/3`;
  }
  if (isRemoteGame()) return `点对点连接 · 你执${colorName(localRemoteColor)} · 悔棋 ${undoQuota[localRemoteColor]}/3`;
  return isServerPage() ? "创建邀请后可复制链接发给好友" : "本地模式可使用邀请码连接";
}

function updatePlayerBadge() {
  const color = localPlayerColor();
  if (!color) {
    playerBadge.hidden = true;
    return;
  }
  const isTurn = !winner && current === color;
  playerBadge.hidden = false;
  playerBadge.textContent = isTurn ? `轮到你下${colorName(color)}` : `你执${colorName(color)}`;
  playerBadge.classList.toggle("white", color === white);
}

function localPlayerColor() {
  if (isServerGame() || isRemoteGame()) return localRemoteColor;
  if (aiToggle.checked) return playerColor();
  return null;
}

function updateWinnerPrompt() {
  if (!winner || winnerPromptDismissed) {
    winnerDialog.hidden = true;
    return;
  }

  if (!winnerPromptReady) {
    winnerDialog.hidden = true;
    scheduleWinnerPrompt();
    return;
  }

  const title = winner === -1 ? "平局" : `${colorName(winner)}胜利`;
  winnerTitle.textContent = title;
  winnerMessage.textContent = isServerGame() || isRemoteGame()
    ? "棋盘已保留，双方都能看到最后局面。点“再来一局”会同步开启新局。"
    : "棋盘已保留，方便复盘最后局面。点“再来一局”即可重新开始。";
  winnerDialog.hidden = false;
}

function dismissWinnerPrompt() {
  winnerPromptDismissed = true;
  winnerDialog.hidden = true;
  clearWinnerPromptTimer();
}

function prepareWinnerPrompt() {
  winnerPromptDismissed = false;
  winnerPromptReady = false;
  clearWinnerPromptTimer();
}

function scheduleWinnerPrompt() {
  if (winnerPromptTimer) return;
  winnerPromptTimer = window.setTimeout(() => {
    winnerPromptTimer = null;
    if (!winner || winnerPromptDismissed) return;
    winnerPromptReady = true;
    render();
  }, winnerPromptDelay);
}

function clearWinnerPromptTimer() {
  if (!winnerPromptTimer) return;
  window.clearTimeout(winnerPromptTimer);
  winnerPromptTimer = null;
}

function updateStatus() {
  turnStone.classList.toggle("black", current === black);
  turnStone.classList.toggle("white", current === white);

  if (winner === -1) {
    statusText.textContent = "平局";
    return;
  }
  if (winner) {
    statusText.textContent = `${colorName(winner)}获胜`;
    return;
  }
  if (isServerGame() && current !== localRemoteColor) {
    statusText.textContent = `等待${colorName(current)}`;
    return;
  }
  if (isRemoteGame() && current !== localRemoteColor) {
    statusText.textContent = `等待${colorName(current)}`;
    return;
  }
  statusText.textContent = aiThinking ? "电脑思考中" : `${colorName(current)}落子`;
}

function updateMoves() {
  moveList.innerHTML = "";
  const recent = moves.slice(-12);
  for (const move of recent) {
    const item = document.createElement("li");
    item.textContent = `${colorName(move.color)} ${pointToText(move.row, move.col)}`;
    moveList.appendChild(item);
  }
}

function resetGame(keepScore = true) {
  board = createBoard();
  current = black;
  winner = empty;
  moves = [];
  undoQuota = { [black]: 3, [white]: 3 };
  lastMove = null;
  winningLine = [];
  aiThinking = false;
  undoPending = false;
  undoRequestId = null;
  rematchPending = false;
  rematchRequestId = null;
  winnerPromptDismissed = false;
  winnerPromptReady = false;
  clearWinnerPromptTimer();
  if (!keepScore) scores = { [black]: 0, [white]: 0 };
  render();
  saveRoomSnapshot();
  queueAiMove();
}

function resetAndShare() {
  resetGame(true);
  sendServerEvent({ type: "reset" });
  sendServerState();
  sendPeerMessage({ type: "reset" });
}

function swapLocalColor() {
  if (!localRemoteColor) return;
  localRemoteColor = opponent(localRemoteColor);
}

function newGameAction() {
  if (isServerGame() || isRemoteGame()) {
    requestRematch();
    return;
  }
  resetAndShare();
}

function requestRematch() {
  if (rematchPending) return;
  if (isServerGame() && serverPlayers < 2) {
    resetAndShare();
    connectionState = "已开始新局";
    render();
    return;
  }
  rematchRequestId = `${serverClientId}-rematch-${Date.now()}`;
  rematchPending = true;
  connectionState = "已发送再来一局申请";
  dismissWinnerPrompt();
  const message = { type: "rematch-request", requestId: rematchRequestId };
  sendServerEvent(message);
  sendPeerMessage(message);
  render();
}

function undoMove() {
  if (aiThinking || moves.length === 0) return;
  if (isServerGame() || isRemoteGame()) {
    requestRemoteUndo();
    return;
  }
  undoLocalMoves(aiToggle.checked && moves.length > 1 ? 2 : 1);
  queueAiMove();
}

function undoLocalMoves(count = 1) {
  for (let i = 0; i < count; i += 1) {
    const move = moves.pop();
    if (!move) break;
    board[move.row][move.col] = empty;
  }
  winner = empty;
  current = moves.length ? opponent(moves[moves.length - 1].color) : black;
  lastMove = moves.at(-1) ? { row: moves.at(-1).row, col: moves.at(-1).col } : null;
  winningLine = [];
  winnerPromptReady = false;
  clearWinnerPromptTimer();
  render();
}

function requestRemoteUndo() {
  if (moves.length === 0 || undoPending) return;
  if (!hasMoveByColor(localRemoteColor)) {
    connectionState = "你还没有可悔的棋";
    render();
    return;
  }
  if (undoQuota[localRemoteColor] <= 0) {
    connectionState = "本局悔棋次数已用完";
    render();
    return;
  }
  undoRequestId = `${serverClientId}-${Date.now()}`;
  undoPending = true;
  connectionState = "已发送悔棋申请";
  const message = {
    type: "undo-request",
    requestId: undoRequestId,
    requestedByColor: localRemoteColor,
    moveText: undoPreviewText(localRemoteColor),
  };
  sendServerEvent(message);
  sendPeerMessage(message);
  render();
}

function latestMoveText() {
  const move = moves.at(-1);
  return move ? `${colorName(move.color)} ${pointToText(move.row, move.col)}` : "最近一步";
}

function hasMoveByColor(color) {
  return moves.some((move) => move.color === color);
}

function undoPreviewText(color) {
  const index = latestMoveIndexByColor(color);
  if (index < 0) return "没有可悔的棋";
  const move = moves[index];
  const count = moves.length - index;
  return `撤回到${colorName(color)} ${pointToText(move.row, move.col)}之前，重新由${colorName(color)}落子（撤销${count}步）`;
}

function latestMoveIndexByColor(color) {
  for (let i = moves.length - 1; i >= 0; i -= 1) {
    if (moves[i].color === color) return i;
  }
  return -1;
}

function undoRemoteMoves(requestedColor) {
  const index = latestMoveIndexByColor(requestedColor);
  if (index < 0) return false;
  const count = moves.length - index;
  undoLocalMoves(count);
  current = requestedColor;
  winner = empty;
  render();
  return true;
}

function approveRemoteUndo(requestId, options = {}) {
  const requestedColor = options.requestedColor || opponent(localRemoteColor);
  if (!undoRemoteMoves(requestedColor)) {
    rejectRemoteUndo(requestId);
    return;
  }
  undoQuota[requestedColor] = Math.max(0, undoQuota[requestedColor] - 1);
  winner = empty;
  undoPending = false;
  undoRequestId = null;
  connectionState = "悔棋已同意";
  winnerPromptDismissed = false;
  render();
  if (!options.remote) {
    const message = {
      type: "undo-accepted",
      requestId,
      board,
      current,
      winner,
      scores,
      undoQuota,
      moves,
      lastMove,
      winningLine,
    };
    sendServerEvent(message);
    sendServerState();
    sendPeerMessage(message);
  }
}

function rejectRemoteUndo(requestId, options = {}) {
  undoPending = false;
  if (undoRequestId === requestId) undoRequestId = null;
  connectionState = "悔棋已拒绝";
  render();
  if (!options.remote) {
    const message = { type: "undo-rejected", requestId };
    sendServerEvent(message);
    sendPeerMessage(message);
  }
}

function queueAiMove() {
  if (isRemoteGame() || !isAiTurn()) return;
  aiThinking = true;
  render();
  window.setTimeout(() => {
    const move = bestAiMove(aiColor());
    aiThinking = false;
    if (move) place(move.row, move.col, aiColor());
  }, aiDelay());
}

function bestAiMove(color) {
  if (moves.length === 0) return { row: 7, col: 7 };

  let best = null;
  const candidates = candidateCells();
  for (const cellPoint of candidates) {
    const attack = scorePoint(cellPoint.row, cellPoint.col, color, aiLevelSelect.value);
    const defense = scorePoint(cellPoint.row, cellPoint.col, opponent(color), aiLevelSelect.value);
    const centerBias = 14 - Math.abs(cellPoint.row - 7) - Math.abs(cellPoint.col - 7);
    const score = aiMoveScore(attack, defense, centerBias);
    if (!best || score > best.score) best = { ...cellPoint, score };
  }
  return best;
}

function aiDelay() {
  return { easy: 160, normal: 260, hard: 360 }[aiLevelSelect.value] || 260;
}

function aiMoveScore(attack, defense, centerBias) {
  if (attack >= 100000) return attack;
  if (defense >= 100000) return defense * 1.08;
  if (aiLevelSelect.value === "easy") {
    return Math.max(attack * 0.86, defense * 0.72) + centerBias + Math.random() * 220;
  }
  if (aiLevelSelect.value === "hard") {
    return Math.max(attack * 1.08, defense * 1.04) + centerBias * 1.6;
  }
  return Math.max(attack, defense * 0.92) + centerBias;
}

function candidateCells() {
  const seen = new Set();
  const cells = [];
  for (const move of moves) {
    for (let dr = -2; dr <= 2; dr += 1) {
      for (let dc = -2; dc <= 2; dc += 1) {
        const row = move.row + dr;
        const col = move.col + dc;
        const key = `${row},${col}`;
        if (
          row >= 0 &&
          row < size &&
          col >= 0 &&
          col < size &&
          board[row][col] === empty &&
          !seen.has(key)
        ) {
          seen.add(key);
          cells.push({ row, col });
        }
      }
    }
  }
  return cells.length ? cells : [{ row: 7, col: 7 }];
}

function scorePoint(row, col, color, level = "normal") {
  return [
    [1, 0],
    [0, 1],
    [1, 1],
    [1, -1],
  ].reduce((sum, [dr, dc]) => sum + scoreLine(row, col, dr, dc, color, level), 0);
}

function scoreLine(row, col, dr, dc, color, level = "normal") {
  const forward = scan(row, col, dr, dc, color);
  const backward = scan(row, col, -dr, -dc, color);
  const stones = 1 + forward.stones + backward.stones;
  const openEnds = Number(forward.open) + Number(backward.open);
  const hard = level === "hard";
  const easy = level === "easy";

  if (stones >= 5) return 100000;
  if (stones === 4 && openEnds === 2) return hard ? 32000 : easy ? 12000 : 20000;
  if (stones === 4 && openEnds === 1) return hard ? 14000 : easy ? 5200 : 9000;
  if (stones === 3 && openEnds === 2) return hard ? 6200 : easy ? 1600 : 3000;
  if (stones === 3 && openEnds === 1) return hard ? 1600 : easy ? 460 : 900;
  if (stones === 2 && openEnds === 2) return hard ? 620 : easy ? 180 : 320;
  if (stones === 2 && openEnds === 1) return hard ? 150 : easy ? 48 : 90;
  return (easy ? 8 : 12) + stones * (hard ? 11 : 8) + openEnds * (hard ? 9 : 6);
}

function scan(row, col, dr, dc, color) {
  let stones = 0;
  let r = row + dr;
  let c = col + dc;
  while (r >= 0 && r < size && c >= 0 && c < size && board[r][c] === color) {
    stones += 1;
    r += dr;
    c += dc;
  }
  return {
    stones,
    open: r >= 0 && r < size && c >= 0 && c < size && board[r][c] === empty,
  };
}

boardCanvas.addEventListener("click", (event) => {
  if (aiThinking || undoPending || isAiTurn()) return;
  if (isRemoteGame() && current !== localRemoteColor) return;
  if (isServerGame() && current !== localRemoteColor) return;
  const cellPoint = getCell(event);
  if (!cellPoint) return;
  if (place(cellPoint.row, cellPoint.col, current)) queueAiMove();
});

function isRemoteGame() {
  return Boolean(channel && channel.readyState === "open" && localRemoteColor);
}

function isServerPage() {
  return location.protocol === "http:" || location.protocol === "https:";
}

function isServerGame() {
  return Boolean(serverRoom && localRemoteColor);
}

function roomStorageKey(roomId = serverRoom) {
  return roomId ? `${roomStatePrefix}${roomId}` : "";
}

function currentGameState() {
  return { board, current, winner, scores, undoQuota, moves, lastMove, winningLine };
}

function currentLocalState() {
  return {
    ...currentGameState(),
    aiEnabled: aiToggle.checked,
    aiLevel: aiLevelSelect.value,
    playerColorValue: playerColorSelect.value,
  };
}

function rememberActiveRoom(roomId) {
  if (!roomId) return;
  localStorage.setItem(activeRoomKey, roomId);
  sessionStorage.setItem(activeRoomKey, roomId);
  if (!isServerPage()) return;
  const url = new URL(location.href);
  url.searchParams.set("room", roomId);
  history.replaceState(null, "", url);
}

function forgetActiveRoom() {
  localStorage.removeItem(activeRoomKey);
  sessionStorage.removeItem(activeRoomKey);
}

function saveRoomSnapshot() {
  const key = roomStorageKey();
  if (!key) {
    saveLocalSnapshot();
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(currentGameState()));
  } catch {
    // Storage can be unavailable in some private browser modes.
  }
}

function saveLocalSnapshot() {
  if (localRemoteColor || peer || channel) return;
  try {
    localStorage.setItem(localSnapshotKey, JSON.stringify(currentLocalState()));
  } catch {
    // Storage can be unavailable in some private browser modes.
  }
}

function loadRoomSnapshot(roomId) {
  const key = roomStorageKey(roomId);
  if (!key) return null;
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function loadLocalSnapshot() {
  try {
    return JSON.parse(localStorage.getItem(localSnapshotKey));
  } catch {
    return null;
  }
}

function restoreLocalSnapshot() {
  const snapshot = loadLocalSnapshot();
  if (!snapshot || !snapshot.board || !Array.isArray(snapshot.moves)) return false;
  aiToggle.checked = Boolean(snapshot.aiEnabled);
  aiLevelSelect.value = snapshot.aiLevel || "normal";
  playerColorSelect.value = snapshot.playerColorValue || "black";
  setGameState(snapshot);
  connectionState = "已恢复本地棋局";
  render();
  if (aiToggle.checked && !winner && isAiTurn()) queueAiMove();
  return true;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}

async function createServerInvite() {
  const room = await api("/api/rooms", { method: "POST", body: "{}" });
  const joinUrl = new URL(location.href);
  joinUrl.searchParams.set("room", room.id);
  inviteCode.value = joinUrl.href;
  answerCode.value = "";
  connectionRole = "host";
  await joinServerRoom(room.id);
  connectionState = "链接已生成，发给好友";
  resetGame(false);
  sendServerState();
}

async function joinServerRoom(roomId) {
  const joined = await api(`/api/rooms/${roomId}/join`, {
    method: "POST",
    body: JSON.stringify({ clientId: serverClientId }),
  });
  serverRoom = joined.roomId;
  rememberActiveRoom(serverRoom);
  serverSeq = joined.seq;
  serverPlayers = joined.players;
  serverOnline = joined.online || 0;
  localRemoteColor = joined.color === "black" ? black : white;
  if (joined.state) {
    setGameState(joined.state);
  } else {
    const snapshot = loadRoomSnapshot(serverRoom);
    if (snapshot) {
      setGameState(snapshot);
      window.setTimeout(sendServerState, 0);
    }
  }
  aiToggle.checked = false;
  connectionState =
    joined.players > 1
      ? `已连接，你执${colorName(localRemoteColor)}`
      : `房间已创建，你执${colorName(localRemoteColor)}`;
  render();
  connectServerSocket();
  window.setTimeout(() => {
    if (!isServerSocketOpen()) pollServer();
  }, 900);
}

async function pollServer() {
  if (serverPolling || !serverRoom) return;
  serverPolling = true;
  while (serverRoom) {
    if (isServerSocketOpen()) break;
    try {
      const data = await api(
        `/api/rooms/${serverRoom}/events?since=${serverSeq}&wait=0&client=${encodeURIComponent(serverClientId)}`
      );
      for (const event of data.events) {
        serverSeq = Math.max(serverSeq, event.seq);
        if (event.senderId === serverClientId) continue;
        handleServerEvent(event);
      }
      if (typeof data.players === "number") {
        serverPlayers = data.players;
        serverOnline = data.online ?? serverOnline;
        if (serverOnline > 1) {
          connectionState = `已连接，你执${colorName(localRemoteColor)}`;
        } else if (connectionState !== "好友已退出房间") {
          connectionState = `等待好友重连，你执${colorName(localRemoteColor)}`;
        }
        render();
      }
      await new Promise((resolve) => setTimeout(resolve, pollDelay(data.events.length)));
    } catch (error) {
      connectionState = `服务器连接中断：${error.message}`;
      render();
      await new Promise((resolve) => setTimeout(resolve, 1600));
    }
  }
  serverPolling = false;
}

function connectServerSocket() {
  if (!("WebSocket" in window) || !serverRoom) return;
  if (serverSocket) serverSocket.close();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socketUrl = `${protocol}//${location.host}/ws?room=${encodeURIComponent(serverRoom)}&client=${encodeURIComponent(serverClientId)}`;
  serverSocket = new WebSocket(socketUrl);

  serverSocket.addEventListener("open", () => {
    connectionState = `实时连接中，你执${colorName(localRemoteColor)}`;
    render();
  });

  serverSocket.addEventListener("message", (event) => {
    handleServerSocketMessage(event.data);
  });

  serverSocket.addEventListener("close", () => {
    if (!serverRoom) return;
    connectionState = "实时连接断开，使用备用同步";
    render();
    pollServer();
  });

  serverSocket.addEventListener("error", () => {
    if (!serverRoom) return;
    connectionState = "实时连接异常，使用备用同步";
    render();
  });
}

function isServerSocketOpen() {
  return Boolean(serverSocket && serverSocket.readyState === 1);
}

function handleServerSocketMessage(raw) {
  const message = JSON.parse(raw);
  if (message.type === "hello") {
    serverSeq = Math.max(serverSeq, message.seq || 0);
    serverPlayers = message.players ?? serverPlayers;
    serverOnline = message.online ?? serverOnline;
    if (message.state) setGameState(message.state);
    connectionState =
      message.players > 1
        ? `实时连接中，你执${colorName(localRemoteColor)}`
        : `房间已创建，你执${colorName(localRemoteColor)}`;
    render();
    return;
  }
  if (message.type !== "events") return;
  serverPlayers = message.players ?? serverPlayers;
  serverOnline = message.online ?? serverOnline;
  for (const event of message.events) {
    serverSeq = Math.max(serverSeq, event.seq);
    if (event.senderId === serverClientId) continue;
    handleServerEvent(event);
  }
}

function pollDelay(eventCount) {
  if (document.hidden) return 1000;
  return eventCount ? 80 : 180;
}

function handleServerEvent(event) {
  if (handleRematchEvent(event)) return;
  if (handleUndoEvent(event)) return;
  if (event.type === "move") place(event.row, event.col, event.color, { remote: true });
  if (event.type === "reset") resetGame(true);
  if (event.type === "state") applyServerState(event);
  if (event.type === "leave") {
    serverPlayers = event.players ?? serverPlayers;
    serverOnline = event.online ?? serverOnline;
    connectionState = "好友已退出房间";
    render();
  }
  if (event.type === "presence") {
    serverPlayers = event.players || serverPlayers;
    serverOnline = event.online ?? serverOnline;
    connectionState = event.players > 1
      ? `${event.online > 1 ? "实时连接中" : "等待好友重连"}，你执${colorName(localRemoteColor)}`
      : connectionState;
    render();
  }
}

function handleRematchEvent(event) {
  if (event.type === "rematch-request") {
    receiveRematchRequest(event);
    return true;
  }
  if (event.type === "rematch-accepted") {
    rematchPending = false;
    rematchRequestId = null;
    if (event.swapColors) swapLocalColor();
    applyServerState(event);
    connectionState = "对方同意再来一局";
    render();
    return true;
  }
  if (event.type === "rematch-rejected") {
    rematchPending = false;
    if (rematchRequestId === event.requestId) rematchRequestId = null;
    connectionState = "对方暂时不想重开";
    render();
    return true;
  }
  return false;
}

function receiveRematchRequest(event) {
  if (rematchPending) {
    rejectRematch(event.requestId);
    return;
  }
  const ok = window.confirm("对方想再来一局，是否同意？同意后双方会交换黑白。");
  if (ok) {
    approveRematch(event.requestId);
  } else {
    rejectRematch(event.requestId);
  }
}

function approveRematch(requestId) {
  swapLocalColor();
  resetGame(true);
  connectionState = "已同意再来一局";
  const message = {
    type: "rematch-accepted",
    requestId,
    swapColors: true,
    board,
    current,
    winner,
    scores,
    undoQuota,
    moves,
    lastMove,
    winningLine,
  };
  sendServerEvent(message);
  sendPeerMessage(message);
  render();
}

function rejectRematch(requestId) {
  connectionState = "已拒绝再来一局";
  const message = { type: "rematch-rejected", requestId };
  sendServerEvent(message);
  sendPeerMessage(message);
  render();
}

function handleUndoEvent(event) {
  if (event.type === "undo-request") {
    receiveUndoRequest(event);
    return true;
  }
  if (event.type === "undo-accepted") {
    undoPending = false;
    undoRequestId = null;
    applyServerState(event);
    connectionState = "对方同意悔棋";
    render();
    return true;
  }
  if (event.type === "undo-rejected") {
    undoPending = false;
    if (undoRequestId === event.requestId) undoRequestId = null;
    connectionState = "对方拒绝悔棋";
    render();
    return true;
  }
  return false;
}

function receiveUndoRequest(event) {
  if (undoPending || !hasMoveByColor(event.requestedByColor)) {
    rejectRemoteUndo(event.requestId);
    return;
  }
  const requester = event.requestedByColor ? colorName(event.requestedByColor) : "对方";
  const ok = window.confirm(`${requester}申请悔棋：${event.moveText || undoPreviewText(event.requestedByColor)}。是否同意？`);
  if (ok) {
    approveRemoteUndo(event.requestId, { requestedColor: event.requestedByColor });
  } else {
    rejectRemoteUndo(event.requestId);
  }
}

function applyServerState(event) {
  setGameState(event);
  render();
}

function setGameState(state) {
  const previousWinner = winner;
  board = state.board;
  current = state.current;
  winner = state.winner;
  scores = state.scores;
  if (state.undoQuota) undoQuota = state.undoQuota;
  moves = state.moves;
  lastMove = state.lastMove;
  winningLine = state.winningLine || [];
  if (winner && winner !== previousWinner) prepareWinnerPrompt();
  if (!winner) {
    winnerPromptDismissed = false;
    winnerPromptReady = false;
    clearWinnerPromptTimer();
  }
  saveRoomSnapshot();
}

function sendServerEvent(message) {
  if (!serverRoom) return;
  const payload = JSON.stringify({ ...message, senderId: serverClientId });
  if (isServerSocketOpen()) {
    serverSocket.send(payload);
    return;
  }
  api(`/api/rooms/${serverRoom}/events`, {
    method: "POST",
    body: payload,
  }).catch((error) => {
    connectionState = `发送失败：${error.message}`;
    render();
  });
}

function notifyServerLeave(options = {}) {
  if (!serverRoom) return;
  const payload = JSON.stringify({ type: "leave", senderId: serverClientId });
  if (options.beacon && navigator.sendBeacon) {
    navigator.sendBeacon(`/api/rooms/${serverRoom}/events`, payload);
    return;
  }
  if (options.keepalive && "fetch" in window) {
    fetch(`/api/rooms/${serverRoom}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {});
    return;
  }
  if (isServerSocketOpen()) {
    serverSocket.send(payload);
    return;
  }
  api(`/api/rooms/${serverRoom}/events`, {
    method: "POST",
    body: payload,
  }).catch(() => {});
}

function notifyPageClosing() {
  if (!isServerGame()) return;
  notifyServerLeave({ beacon: true, keepalive: true });
}

function sendServerState() {
  saveRoomSnapshot();
  sendServerEvent({ type: "state", ...currentGameState() });
}

function leaveServerRoom(message = "未连接") {
  const socket = serverSocket;
  notifyServerLeave();
  if (socket) window.setTimeout(() => socket.close(), 60);
  serverSocket = null;
  serverRoom = null;
  serverSeq = 0;
  serverPolling = false;
  serverPlayers = 0;
  serverOnline = 0;
  localRemoteColor = null;
  connectionRole = null;
  connectionState = message;
  forgetActiveRoom();
  if (isServerPage()) {
    const url = new URL(location.href);
    url.searchParams.delete("room");
    history.replaceState(null, "", url);
  }
  render();
}

async function copyInviteLink() {
  const value = inviteCode.value.trim();
  if (!value) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
    } else {
      inviteCode.focus();
      inviteCode.select();
      document.execCommand("copy");
    }
    connectionState = "邀请链接已复制";
  } catch {
    connectionState = "复制失败，请手动复制";
  }
  render();
}

function createPeer() {
  closePeer();
  const nextPeer = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ],
  });
  nextPeer.addEventListener("connectionstatechange", () => {
    if (nextPeer.connectionState === "connected") {
      connectionFailed = false;
      connectionState = `已连接，你执${colorName(localRemoteColor)}`;
    } else if (nextPeer.connectionState === "failed") {
      connectionFailed = true;
      connectionState = "直连失败，请重新创建邀请";
    } else if (["closed", "disconnected"].includes(nextPeer.connectionState)) {
      connectionState = "连接已断开";
    }
    render();
  });
  nextPeer.addEventListener("iceconnectionstatechange", () => {
    if (["failed", "disconnected"].includes(nextPeer.iceConnectionState) && !isRemoteGame()) {
      connectionFailed = true;
      connectionState = "网络无法直连，换网络后重试";
      render();
    }
  });
  peer = nextPeer;
  return nextPeer;
}

function closePeer() {
  if (channel) channel.close();
  if (peer) peer.close();
  channel = null;
  peer = null;
  connectionFailed = false;
}

function setupChannel(nextChannel) {
  channel = nextChannel;
  channel.addEventListener("open", () => {
    connectionState = `已连接，你执${colorName(localRemoteColor)}`;
    aiToggle.checked = false;
    render();
    if (localRemoteColor === black) {
      sendPeerMessage({ type: "sync", board, current, winner, scores, undoQuota, moves, lastMove, winningLine });
    }
  });
  channel.addEventListener("close", () => {
    connectionState = "连接已断开";
    render();
  });
  channel.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (handleRematchEvent(message)) return;
    if (handleUndoEvent(message)) return;
    if (message.type === "move") place(message.row, message.col, message.color, { remote: true });
    if (message.type === "reset") resetGame(true);
    if (message.type === "sync") applyPeerSync(message);
  });
}

function applyPeerSync(message) {
  board = message.board;
  current = message.current;
  winner = message.winner;
  scores = message.scores;
  if (message.undoQuota) undoQuota = message.undoQuota;
  moves = message.moves;
  lastMove = message.lastMove;
  winningLine = message.winningLine || [];
  render();
}

function sendPeerMessage(message) {
  if (!channel || channel.readyState !== "open") return;
  channel.send(JSON.stringify(message));
}

async function waitForIce(peerConnection) {
  if (peerConnection.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    peerConnection.addEventListener("icegatheringstatechange", () => {
      if (peerConnection.iceGatheringState === "complete") resolve();
    });
  });
}

function encodeSignal(description) {
  const bytes = new TextEncoder().encode(JSON.stringify(description));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeSignal(code) {
  const binary = atob(code.trim());
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function createInvite() {
  if (isServerPage()) {
    await createServerInvite();
    return;
  }
  if (!("RTCPeerConnection" in window)) {
    connectionState = "浏览器不支持好友对决";
    render();
    return;
  }
  const nextPeer = createPeer();
  connectionRole = "host";
  connectionFailed = false;
  localRemoteColor = black;
  setupChannel(nextPeer.createDataChannel("gomoku"));
  const offer = await nextPeer.createOffer();
  await nextPeer.setLocalDescription(offer);
  await waitForIce(nextPeer);
  inviteCode.value = encodeSignal(nextPeer.localDescription);
  answerCode.value = "";
  aiToggle.checked = false;
  connectionState = "把邀请码发给好友";
  resetGame(false);
}

async function joinInvite() {
  if (isServerPage()) {
    const value = inviteCode.value.trim();
    const roomId = value.startsWith("http") ? new URL(value).searchParams.get("room") : value;
    if (roomId) await joinServerRoom(roomId);
    return;
  }
  if (!inviteCode.value.trim()) return;
  const nextPeer = createPeer();
  connectionRole = "guest";
  connectionFailed = false;
  localRemoteColor = white;
  nextPeer.addEventListener("datachannel", (event) => setupChannel(event.channel));
  await nextPeer.setRemoteDescription(decodeSignal(inviteCode.value));
  const answer = await nextPeer.createAnswer();
  await nextPeer.setLocalDescription(answer);
  await waitForIce(nextPeer);
  answerCode.value = encodeSignal(nextPeer.localDescription);
  aiToggle.checked = false;
  connectionState = "把回应码发回房主";
  resetGame(false);
}

async function acceptAnswer() {
  if (connectionRole !== "host") {
    connectionState = "只有房主需要确认回应";
    render();
    return;
  }
  if (!peer || !answerCode.value.trim()) return;
  if (connectionFailed) {
    connectionState = "旧回应码已失效，请重新创建邀请";
    render();
    return;
  }
  if (peer.signalingState === "stable") {
    connectionState = isRemoteGame() ? `已连接，你执${colorName(localRemoteColor)}` : "回应码已经确认过，请重开邀请";
    render();
    return;
  }
  if (peer.signalingState !== "have-local-offer") {
    connectionState = "请先创建邀请，再确认回应";
    render();
    return;
  }
  await peer.setRemoteDescription(decodeSignal(answerCode.value));
  connectionState = "正在连接";
  render();
}

themeToggleButton.addEventListener("click", toggleTheme);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (themeMode !== "auto") return;
  applyTheme();
  render();
});
newGameButton.addEventListener("click", newGameAction);
undoButton.addEventListener("click", undoMove);
winnerRematchButton.addEventListener("click", newGameAction);
winnerCloseButton.addEventListener("click", dismissWinnerPrompt);
winnerDialog.addEventListener("click", (event) => {
  if (event.target === winnerDialog) dismissWinnerPrompt();
});
aiToggle.addEventListener("change", () => {
  if (aiToggle.checked && isServerGame()) leaveServerRoom("已退出好友房间");
  resetGame(true);
});
playerColorSelect.addEventListener("change", () => {
  if (isServerGame()) leaveServerRoom("已退出好友房间");
  resetGame(true);
});
aiLevelSelect.addEventListener("change", () => {
  saveRoomSnapshot();
  if (aiToggle.checked && !winner && isAiTurn()) queueAiMove();
});
createInviteButton.addEventListener("click", () => createInvite().catch((error) => {
  connectionState = `邀请失败：${error.message}`;
  render();
}));
copyInviteButton.addEventListener("click", () => copyInviteLink());
leaveRoomButton.addEventListener("click", () => {
  if (isServerGame()) leaveServerRoom("已退出好友房间");
  if (isRemoteGame()) {
    closePeer();
    localRemoteColor = null;
    connectionState = "已断开连接";
  }
  render();
});
joinInviteButton.addEventListener("click", () => joinInvite().catch((error) => {
  connectionState = `加入失败：${error.message}`;
  render();
}));
acceptAnswerButton.addEventListener("click", () => acceptAnswer().catch((error) => {
  connectionState = `连接失败：${error.message}`;
  render();
}));
answerCode.addEventListener("input", render);
inviteCode.addEventListener("input", render);
window.addEventListener("pagehide", notifyPageClosing);

const initialRoom =
  new URLSearchParams(location.search).get("room") ||
  localStorage.getItem(activeRoomKey) ||
  sessionStorage.getItem(activeRoomKey);
if (isServerPage() && initialRoom) {
  joinServerRoom(initialRoom).catch((error) => {
    connectionState = `加入失败：${error.message}`;
    render();
  });
} else {
  if (!restoreLocalSnapshot()) resetGame();
}
