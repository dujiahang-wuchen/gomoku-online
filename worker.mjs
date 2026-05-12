const contentTypeByExt = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function normalizeName(name) {
  return String(name || "").replace(/\s+/g, " ").trim().slice(0, 16);
}

function isPlayerActive(player, now = Date.now()) {
  return !player.left && (player.online || now - (player.lastSeen || 0) < 12_000);
}

function randomId(bytes = 4) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function parseJson(request) {
  const text = await request.text();
  return text ? JSON.parse(text) : {};
}

function roomStub(env, roomId) {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

function roomRequest(request, roomId, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.searchParams.set("roomId", roomId);
  return new Request(url, request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      return json({ id: randomId(4) });
    }

    const joinMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
    if (joinMatch) {
      return roomStub(env, joinMatch[1]).fetch(roomRequest(request, joinMatch[1], "/join"));
    }

    const eventsMatch = url.pathname.match(/^\/api\/rooms\/([^/]+)\/events$/);
    if (eventsMatch) {
      return roomStub(env, eventsMatch[1]).fetch(roomRequest(request, eventsMatch[1], "/events"));
    }

    if (url.pathname === "/ws") {
      const roomId = url.searchParams.get("room");
      if (!roomId) return json({ error: "missing room" }, 400);
      return roomStub(env, roomId).fetch(request);
    }

    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(request);
      if (response.status !== 404) {
        const ext = url.pathname.match(/\.[^.]+$/)?.[0];
        if (!ext || !contentTypeByExt[ext]) return response;
        const headers = new Headers(response.headers);
        headers.set("content-type", contentTypeByExt[ext]);
        headers.set("cache-control", "no-store");
        return new Response(response.body, { status: response.status, headers });
      }
    }

    return new Response("Not found", { status: 404 });
  },
};

export class Room {
  constructor(state) {
    this.state = state;
    this.room = null;
  }

  async fetch(request) {
    await this.loadRoom();
    const url = new URL(request.url);

    if (url.pathname === "/join" && request.method === "POST") {
      return this.join(request);
    }

    if (url.pathname === "/events") {
      if (request.method === "POST") return this.postEvent(request);
      if (request.method === "GET") return this.getEvents(url);
    }

    if (url.pathname === "/ws") {
      return this.connectSocket(url);
    }

    return json({ error: "not found" }, 404);
  }

  async loadRoom() {
    if (this.room) return;
    this.room =
      (await this.state.storage.get("room")) || {
        id: "",
        players: {},
        events: [],
        seq: 0,
        state: null,
        chat: [],
        firstColor: Math.random() < 0.5 ? "black" : "white",
      };
    this.sockets = new Map();
  }

  async saveRoom() {
    const room = {
      ...this.room,
      events: this.room.events.slice(-300),
      chat: this.room.chat.slice(-80),
    };
    await this.state.storage.put("room", room);
  }

  playerCount() {
    return Object.keys(this.room.players).length;
  }

  activePlayerCount() {
    const now = Date.now();
    return Object.values(this.room.players).filter((player) => isPlayerActive(player, now)).length;
  }

  playerName(clientId) {
    return normalizeName(this.room.players[clientId]?.name) || "玩家";
  }

  nextPlayerColor() {
    const colors = new Set(Object.values(this.room.players).map((player) => player.color));
    if (!colors.size) return this.room.firstColor;
    return colors.has("black") ? "white" : "black";
  }

  touchPlayer(clientId) {
    if (!this.room.players[clientId]) return;
    this.room.players[clientId].lastSeen = Date.now();
    this.room.players[clientId].left = false;
  }

  markPlayerLeft(clientId) {
    const player = this.room.players[clientId];
    if (!player) return;
    player.online = false;
    player.left = true;
    player.lastSeen = 0;
    const socket = this.sockets.get(clientId);
    if (socket) {
      this.sockets.delete(clientId);
      socket.close(1000, "left");
    }
  }

  normalizeRoomEvent(event) {
    if (event.type !== "chat") return event;
    const text = String(event.text || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!text) return null;
    return {
      type: "chat",
      id: String(event.id || randomId(6)).slice(0, 80),
      senderId: event.senderId,
      senderName: this.playerName(event.senderId),
      text,
    };
  }

  applyRoomEvent(event) {
    if (event.type !== "rematch-accepted" || !event.swapColors) return;
    for (const player of Object.values(this.room.players)) {
      player.color = player.color === "black" ? "white" : "black";
    }
  }

  rememberState(event) {
    if (!event || !event.board) return;
    this.room.state = {
      board: event.board,
      current: event.current,
      winner: event.winner,
      scores: event.scores,
      undoQuota: event.undoQuota,
      moves: event.moves,
      lastMove: event.lastMove,
      winningLine: event.winningLine || [],
    };
  }

  rememberChat(event) {
    if (event.type !== "chat") return;
    this.room.chat.push({
      id: event.id,
      senderId: event.senderId,
      senderName: event.senderName,
      text: event.text,
      at: event.at,
    });
    this.room.chat = this.room.chat.slice(-80);
  }

  async publish(event) {
    const cleanEvent = this.normalizeRoomEvent(event);
    if (!cleanEvent) return null;
    this.applyRoomEvent(cleanEvent);
    this.rememberState(cleanEvent);
    const next = {
      ...cleanEvent,
      players: this.playerCount(),
      online: this.activePlayerCount(),
      seq: ++this.room.seq,
      at: Date.now(),
    };
    this.rememberChat(next);
    this.room.events.push(next);
    this.room.events = this.room.events.slice(-300);
    await this.saveRoom();
    this.broadcast({ type: "events", events: [next], seq: this.room.seq, players: this.playerCount(), online: this.activePlayerCount() });
    return next;
  }

  broadcast(payload) {
    const data = JSON.stringify(payload);
    for (const socket of this.sockets.values()) {
      try {
        socket.send(data);
      } catch {}
    }
  }

  async join(request) {
    const body = await parseJson(request);
    const clientId = String(body.clientId || "");
    const name = normalizeName(body.name) || `玩家${clientId.slice(-4)}`;
    if (!clientId) return json({ error: "missing clientId" }, 400);

    if (!this.room.players[clientId]) {
      if (this.playerCount() >= 2) {
        const now = Date.now();
        const offlineClientId =
          Object.keys(this.room.players).find((id) => !isPlayerActive(this.room.players[id], now) && this.room.players[id].color === "white") ||
          Object.keys(this.room.players).find((id) => !isPlayerActive(this.room.players[id], now));
        if (!offlineClientId) {
          return json({ error: "房间已有两位在线玩家，请让房主重新创建邀请" }, 403);
        }
        this.room.players[clientId] = { ...this.room.players[offlineClientId], name, online: false, left: false, lastSeen: Date.now() };
        this.sockets.delete(offlineClientId);
        delete this.room.players[offlineClientId];
      } else {
        this.room.players[clientId] = { color: this.nextPlayerColor(), name, online: false, left: false, lastSeen: Date.now() };
      }
      await this.publish({ type: "presence", senderId: clientId, senderName: name, players: this.playerCount(), online: this.activePlayerCount() });
    } else {
      this.room.players[clientId].name = name;
    }

    this.touchPlayer(clientId);
    await this.saveRoom();
    return json({
      roomId: this.room.id,
      color: this.room.players[clientId].color,
      name: this.room.players[clientId].name,
      players: this.playerCount(),
      online: this.activePlayerCount(),
      seq: this.room.seq,
      state: this.room.state,
      chat: this.room.chat,
    });
  }

  async postEvent(request) {
    const body = await parseJson(request);
    if (!body.senderId || !this.room.players[body.senderId]) {
      return json({ error: "not in room" }, 403);
    }
    if (body.type === "leave") this.markPlayerLeft(body.senderId);
    else this.touchPlayer(body.senderId);
    await this.publish(body);
    return json({ ok: true });
  }

  async getEvents(url) {
    const since = Number(url.searchParams.get("since") || 0);
    const clientId = String(url.searchParams.get("client") || "");
    this.touchPlayer(clientId);
    await this.saveRoom();
    return json({
      events: this.room.events.filter((event) => event.seq > since),
      seq: this.room.seq,
      players: this.playerCount(),
      online: this.activePlayerCount(),
      state: this.room.state,
      chat: this.room.chat,
    });
  }

  async connectSocket(url) {
    if (url.searchParams.get("room")) this.room.id = url.searchParams.get("room");
    const clientId = url.searchParams.get("client");
    if (!clientId || !this.room.players[clientId]) {
      return new Response("Forbidden", { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    if (this.sockets.has(clientId)) this.sockets.get(clientId).close(1000, "replaced");
    this.sockets.set(clientId, server);
    this.room.players[clientId].online = true;
    this.touchPlayer(clientId);

    server.send(
      JSON.stringify({
        type: "hello",
        seq: this.room.seq,
        players: this.playerCount(),
        online: this.activePlayerCount(),
        state: this.room.state,
        chat: this.room.chat,
      })
    );
    await this.publish({ type: "presence", senderId: clientId, players: this.playerCount(), online: this.activePlayerCount() });

    server.addEventListener("message", async (event) => {
      try {
        const message = JSON.parse(event.data);
        if (message.senderId !== clientId || !this.room.players[clientId]) return;
        if (message.type === "leave") this.markPlayerLeft(clientId);
        else this.touchPlayer(clientId);
        await this.publish(message);
      } catch {
        server.send(JSON.stringify({ type: "error", error: "invalid message" }));
      }
    });

    server.addEventListener("close", async () => {
      if (this.sockets.get(clientId) !== server) return;
      this.sockets.delete(clientId);
      if (this.room.players[clientId]) {
        this.room.players[clientId].online = false;
        this.room.players[clientId].left = true;
        this.room.players[clientId].lastSeen = 0;
      }
      await this.publish({ type: "leave", reason: "close", senderId: clientId, players: this.playerCount(), online: this.activePlayerCount() });
    });

    return new Response(null, { status: 101, webSocket: client });
  }
}
