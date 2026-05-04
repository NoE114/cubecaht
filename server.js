const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.PORT || 3000);
const MAX_GLOBAL_MESSAGES = 300;
const DM_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const GLOBAL_MESSAGES_FILE = path.join(DATA_DIR, "global-messages.json");
const CUBE_IMAGE = path.join(ROOT_DIR, "..", "cube.png");

const users = new Map();
const sockets = new Map();
let globalMessages = loadGlobalMessages();
let dmMessages = [];

const nameLeft = [
  "Violet",
  "Cipher",
  "Obsidian",
  "Neon",
  "Hidden",
  "Arcane",
  "Nocturne",
  "Velvet",
  "Static",
  "Ghost",
  "Rune",
  "Signal"
];
const nameRight = [
  "Cube",
  "Node",
  "Echo",
  "Box",
  "Key",
  "Pulse",
  "Vault",
  "Shard",
  "Relay",
  "Glyph",
  "Frame",
  "Spark"
];
const colors = [
  "#b57cff",
  "#7dd3fc",
  "#f0abfc",
  "#34d399",
  "#f472b6",
  "#c4b5fd",
  "#a3e635",
  "#facc15"
];

fs.mkdirSync(DATA_DIR, { recursive: true });

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === "/cube.png" || requestUrl.pathname === "/favicon.ico") {
    return sendFile(res, CUBE_IMAGE, "image/png");
  }

  const safePath = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, safePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }

  const contentType = getContentType(filePath);
  sendFile(res, filePath, contentType);
});

server.on("upgrade", (req, socket) => {
  if (req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );

  const user = createUser();
  users.set(user.id, user);
  sockets.set(user.id, socket);
  socket.userId = user.id;
  socket.buffer = Buffer.alloc(0);

  send(socket, {
    type: "welcome",
    user,
    globalMessages,
    activeUsers: getActiveUsers(),
    dmPolicy: "Unviewed DMs are discarded when either participant disconnects. Viewed DMs expire after 24 hours."
  });
  broadcast({ type: "users", users: getActiveUsers() });
  broadcast({
    type: "system",
    message: `${user.name} joined the cube.`,
    createdAt: Date.now()
  });

  socket.on("data", (chunk) => {
    socket.buffer = Buffer.concat([socket.buffer, chunk]);
    parseFrames(socket);
  });

  socket.on("close", () => disconnect(user.id));
  socket.on("error", () => disconnect(user.id));
});

server.listen(PORT, () => {
  console.log(`Cubechat running at http://localhost:${PORT}`);
});

setInterval(cleanupExpiredDms, CLEANUP_INTERVAL_MS).unref();

function createUser() {
  const id = crypto.randomUUID();
  const name = `${pick(nameLeft)} ${pick(nameRight)} ${Math.floor(10 + Math.random() * 90)}`;
  const color = pick(colors);
  return { id, name, color };
}

function disconnect(userId) {
  const user = users.get(userId);
  const socket = sockets.get(userId);

  if (socket && !socket.destroyed) {
    socket.destroy();
  }

  users.delete(userId);
  sockets.delete(userId);

  dmMessages = dmMessages.filter((message) => {
    const fromId = getSenderId(message);
    const involvesUser = fromId === userId || message.to === userId;
    return !involvesUser || (message.viewedAt && message.expiresAt > Date.now());
  });

  if (user) {
    broadcast({ type: "users", users: getActiveUsers() });
    broadcast({
      type: "system",
      message: `${user.name} left the cube.`,
      createdAt: Date.now()
    });
  }
}

function handleMessage(userId, rawMessage) {
  const sender = users.get(userId);
  if (!sender) return;

  let payload;
  try {
    payload = JSON.parse(rawMessage);
  } catch {
    return;
  }

  if (payload.type === "global-message") {
    const text = cleanText(payload.text);
    if (!text) return;

    const message = {
      id: crypto.randomUUID(),
      text,
      from: sender,
      createdAt: Date.now()
    };
    globalMessages.push(message);
    globalMessages = globalMessages.slice(-MAX_GLOBAL_MESSAGES);
    saveGlobalMessages();
    broadcast({ type: "global-message", message });
    return;
  }

  if (payload.type === "dm-message") {
    const text = cleanText(payload.text);
    const recipient = users.get(payload.to);
    if (!text || !recipient || recipient.id === userId) return;

    const message = {
      id: crypto.randomUUID(),
      text,
      from: sender,
      to: recipient.id,
      createdAt: Date.now(),
      viewedAt: null,
      expiresAt: null
    };
    dmMessages.push(message);
    sendTo(sender.id, { type: "dm-message", message: decorateDm(message) });
    sendTo(recipient.id, { type: "dm-message", message: decorateDm(message) });
    return;
  }

  if (payload.type === "dm-opened") {
    const peerId = payload.peerId;
    const now = Date.now();
    dmMessages.forEach((message) => {
      if (getSenderId(message) === peerId && message.to === userId && !message.viewedAt) {
        message.viewedAt = now;
        message.expiresAt = now + DM_TTL_MS;
      }
    });
    sendTo(userId, {
      type: "dm-history",
      peerId,
      messages: dmMessages
        .filter((message) => isDmVisibleTo(message, userId, peerId))
        .map(decorateDm)
    });
  }
}

function isDmVisibleTo(message, userId, peerId) {
  const fromId = getSenderId(message);
  return (
    ((fromId === userId && message.to === peerId) ||
      (fromId === peerId && message.to === userId)) &&
    (!message.expiresAt || message.expiresAt > Date.now())
  );
}

function decorateDm(message) {
  const from = typeof message.from === "string" ? users.get(message.from) : message.from;
  return {
    ...message,
    from,
    expiresAt: message.expiresAt
  };
}

function getSenderId(message) {
  return typeof message.from === "string" ? message.from : message.from.id;
}

function cleanupExpiredDms() {
  const now = Date.now();
  dmMessages = dmMessages.filter((message) => !message.expiresAt || message.expiresAt > now);
}

function parseFrames(socket) {
  while (socket.buffer.length >= 2) {
    const firstByte = socket.buffer[0];
    const secondByte = socket.buffer[1];
    const opcode = firstByte & 0x0f;
    const masked = Boolean(secondByte & 0x80);
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (socket.buffer.length < offset + 2) return;
      payloadLength = socket.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (socket.buffer.length < offset + 8) return;
      const highBits = socket.buffer.readUInt32BE(offset);
      if (highBits !== 0) {
        socket.destroy();
        return;
      }
      payloadLength = socket.buffer.readUInt32BE(offset + 4);
      offset += 8;
    }

    if (!masked) {
      socket.destroy();
      return;
    }

    if (socket.buffer.length < offset + 4 + payloadLength) return;

    const mask = socket.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = socket.buffer.subarray(offset, offset + payloadLength);
    socket.buffer = socket.buffer.subarray(offset + payloadLength);

    if (opcode === 0x8) {
      socket.end();
      return;
    }

    if (opcode !== 0x1) continue;

    const decoded = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      decoded[index] = payload[index] ^ mask[index % 4];
    }
    handleMessage(socket.userId, decoded.toString("utf8"));
  }
}

function sendTo(userId, payload) {
  const socket = sockets.get(userId);
  if (socket) send(socket, payload);
}

function broadcast(payload) {
  sockets.forEach((socket) => send(socket, payload));
}

function send(socket, payload) {
  if (socket.destroyed) return;
  const data = Buffer.from(JSON.stringify(payload));
  const header = [];

  header.push(0x81);
  if (data.length < 126) {
    header.push(data.length);
  } else if (data.length < 65536) {
    header.push(126, (data.length >> 8) & 0xff, data.length & 0xff);
  } else {
    header.push(127, 0, 0, 0, 0, (data.length >>> 24) & 0xff, (data.length >>> 16) & 0xff, (data.length >>> 8) & 0xff, data.length & 0xff);
  }

  socket.write(Buffer.concat([Buffer.from(header), data]));
}

function getActiveUsers() {
  return [...users.values()];
}

function cleanText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 1000);
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function loadGlobalMessages() {
  try {
    const messages = JSON.parse(fs.readFileSync(GLOBAL_MESSAGES_FILE, "utf8"));
    return Array.isArray(messages) ? messages.slice(-MAX_GLOBAL_MESSAGES) : [];
  } catch {
    return [];
  }
}

function saveGlobalMessages() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GLOBAL_MESSAGES_FILE, JSON.stringify(globalMessages, null, 2));
}

function sendFile(res, filePath, contentType) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": contentType.startsWith("image/") ? "public, max-age=86400" : "no-cache"
    });
    res.end(content);
  });
}

function getContentType(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".png") return "image/png";
  return "text/plain; charset=utf-8";
}
