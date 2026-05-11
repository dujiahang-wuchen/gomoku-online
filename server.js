const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { WebSocketServer } = require("ws");

const root = __dirname;
const port = Number(process.env.PORT || 5173);
const rooms = new Map();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function json(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(data));
}

function getRoom(id) {
  if (!rooms.has(id)) {
    rooms.set(id, { id, players: {}, events: [], seq: 0, waiters: [], sockets: new Map() });
  }
  return rooms.get(id);
}

function publish(room, event) {
  const next = { ...event, seq: ++room.seq, at: Date.now() };
  room.events.push(next);
  room.events = room.events.slice(-300);
  for (const waiter of room.waiters.splice(0)) waiter();
  broadcast(room, { type: "events", events: [next], seq: room.seq, players: playerCount(room), online: activePlayerCount(room) });
  return next;
}

function broadcast(room, payload) {
  const data = JSON.stringify(payload);
  for (const socket of room.sockets.values()) {
    if (socket.readyState === 1) socket.send(data);
  }
}

function playerCount(room) {
  return Object.keys(room.players).length;
}

function activePlayerCount(room) {
  return Object.values(room.players).filter((player) => player.online).length;
}

function localUrls() {
  const urls = [`http://localhost:${port}`];
  for (const entry of Object.values(os.networkInterfaces()).flat()) {
    if (entry && entry.family === "IPv4" && !entry.internal) {
      urls.push(`http://${entry.address}:${port}`);
    }
  }
  return urls;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      const id = crypto.randomBytes(4).toString("hex");
      getRoom(id);
      json(res, 200, { id });
      return;
    }

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
    if (req.method === "POST" && joinMatch) {
      const room = getRoom(joinMatch[1]);
      const body = await readBody(req);
      const clientId = String(body.clientId || "");
      if (!clientId) {
        json(res, 400, { error: "missing clientId" });
        return;
      }

      if (!room.players[clientId]) {
        if (playerCount(room) >= 2) {
          json(res, 403, { error: "room is full" });
          return;
        }
        const colors = new Set(Object.values(room.players).map((player) => player.color));
        room.players[clientId] = { color: colors.has("black") ? "white" : "black", online: false };
        publish(room, {
          type: "presence",
          senderId: clientId,
          players: playerCount(room),
          online: activePlayerCount(room),
        });
      }

      json(res, 200, {
        roomId: room.id,
        color: room.players[clientId].color,
        players: playerCount(room),
        online: activePlayerCount(room),
        seq: room.seq,
      });
      return;
    }

    const eventsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/events$/);
    if (eventsMatch) {
      const room = getRoom(eventsMatch[1]);

      if (req.method === "POST") {
        const body = await readBody(req);
        if (!body.senderId || !room.players[body.senderId]) {
          json(res, 403, { error: "not in room" });
          return;
        }
        publish(room, body);
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET") {
        const since = Number(url.searchParams.get("since") || 0);
        const shouldWait = url.searchParams.get("wait") !== "0";
        let events = room.events.filter((event) => event.seq > since);
        if (shouldWait && !events.length) {
          await new Promise((resolve) => {
            const timer = setTimeout(resolve, 25000);
            room.waiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });
          events = room.events.filter((event) => event.seq > since);
        }
        json(res, 200, { events, seq: room.seq, players: playerCount(room), online: activePlayerCount(room) });
        return;
      }
    }

    if (req.method !== "GET") {
      json(res, 405, { error: "method not allowed" });
      return;
    }

    const relativePath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.resolve(root, relativePath);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.readFile(file, (error, data) => {
      if (error) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "content-type": contentTypes[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      res.end(data);
    });
  } catch (error) {
    json(res, 500, { error: error.message });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const roomId = url.searchParams.get("room");
  const clientId = url.searchParams.get("client");
  const room = roomId ? rooms.get(roomId) : null;
  if (!room || !clientId || !room.players[clientId]) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.roomId = roomId;
    ws.clientId = clientId;
    wss.emit("connection", ws);
  });
});

wss.on("connection", (ws) => {
  const room = getRoom(ws.roomId);
  const player = room.players[ws.clientId];
  if (room.sockets.has(ws.clientId)) room.sockets.get(ws.clientId).close();
  room.sockets.set(ws.clientId, ws);
  player.online = true;

  ws.send(
    JSON.stringify({
      type: "hello",
      seq: room.seq,
      players: playerCount(room),
      online: activePlayerCount(room),
    })
  );
  publish(room, {
    type: "presence",
    senderId: ws.clientId,
    players: playerCount(room),
    online: activePlayerCount(room),
  });

  ws.on("message", (raw) => {
    try {
      const message = JSON.parse(raw.toString());
      if (message.senderId !== ws.clientId || !room.players[ws.clientId]) return;
      publish(room, message);
    } catch {
      ws.send(JSON.stringify({ type: "error", error: "invalid message" }));
    }
  });

  ws.on("close", () => {
    if (room.sockets.get(ws.clientId) !== ws) return;
    room.sockets.delete(ws.clientId);
    if (room.players[ws.clientId]) room.players[ws.clientId].online = false;
    publish(room, {
      type: "presence",
      senderId: ws.clientId,
      players: playerCount(room),
      online: activePlayerCount(room),
    });
  });
});

server.listen(port, () => {
  console.log("五子棋服务器已启动：");
  for (const url of localUrls()) console.log(`  ${url}`);
});
