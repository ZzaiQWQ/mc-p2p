const { WebSocketServer } = require("ws");

// ======================== 配置 ========================
const PORT = Number.parseInt(process.env.PORT || "9090", 10);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65534) {
  throw new Error("PORT 必须是 1-65534 之间的端口号");
}
const MAX_MESSAGE_SIZE = 4096;
const MAX_CONNECTIONS = 10000;
const MAX_CONNECTIONS_PER_IP = 10;       // 8人房需要更多连接空间
const HEARTBEAT_INTERVAL_MS = 30000;
const ROOM_TTL_MS = 60 * 60 * 1000;
const RATE_LIMIT_PER_SEC = 10;
const MAX_ROOM_SIZE = 8;                 // 每个房间最多 8 人
// ======================================================

const wss = new WebSocketServer({ port: PORT, maxPayload: MAX_MESSAGE_SIZE });

// 房间管理: roomCode -> { host: ws, guests: Map<peerId, ws>, createdAt: number }
const rooms = new Map();
const ipConnCount = new Map();
let totalConnections = 0;
let peerIdCounter = 0;

function generateRoomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

function safeSend(client, data) {
  try {
    if (client.readyState === 1) {
      client.send(typeof data === "string" ? data : JSON.stringify(data));
    }
  } catch (err) {
    console.error("[安全发送] 失败:", err.message);
  }
}

function cleanupRoom(code) {
  const room = rooms.get(code);
  if (room && !room.host && room.guests.size === 0) {
    rooms.delete(code);
    console.log(`[房间] ${code} 已销毁（无人）`);
  }
}

function getClientIp(ws, req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function checkRateLimit(ws) {
  const now = Date.now();
  if (!ws._rateLimitWindow || now - ws._rateLimitWindow > 1000) {
    ws._rateLimitWindow = now;
    ws._rateLimitCount = 1;
    return true;
  }
  ws._rateLimitCount++;
  return ws._rateLimitCount <= RATE_LIMIT_PER_SEC;
}

// 获取房间总人数
function getRoomSize(room) {
  return (room.host ? 1 : 0) + room.guests.size;
}

// ======================== 心跳检测 ========================
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws._isAlive === false) {
      console.log("[心跳] 客户端无响应，踢掉");
      return ws.terminate();
    }
    ws._isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL_MS);

// ======================== 房间过期清理 ========================
const roomCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      if (room.host) {
        safeSend(room.host, { type: "error", message: "房间已过期（超过1小时），请重新创建" });
      }
      for (const [, client] of room.guests) {
        safeSend(client, { type: "error", message: "房间已过期（超过1小时），请重新创建" });
      }
      rooms.delete(code);
      console.log(`[房间] ${code} 已过期销毁`);
    }
  }
}, 60000);

// ======================== 主逻辑 ========================
wss.on("connection", (ws, req) => {
  const clientIp = getClientIp(ws, req);

  if (totalConnections >= MAX_CONNECTIONS) {
    ws.close(1013, "服务器已满");
    return;
  }
  const ipCount = ipConnCount.get(clientIp) || 0;
  if (ipCount >= MAX_CONNECTIONS_PER_IP) {
    ws.close(1013, "同一 IP 连接数过多");
    return;
  }

  totalConnections++;
  ipConnCount.set(clientIp, ipCount + 1);

  ws._isAlive = true;
  ws.on("pong", () => { ws._isAlive = true; });

  let currentRoom = null;
  let role = null;     // "host" | "guest"
  let myPeerId = null; // 每个连接的唯一 ID

  console.log(`[连接] 新玩家连入 (${clientIp}), 在线: ${totalConnections}`);

  // 从旧房间移除自己
  function leaveCurrentRoom() {
    if (!currentRoom || !rooms.has(currentRoom)) return;
    const room = rooms.get(currentRoom);

    if (role === "host") {
      room.host = null;
      // 房主离开，通知所有访客
      for (const [, client] of room.guests) {
        safeSend(client, { type: "peer_disconnected", peerId: "host" });
      }
    } else if (role === "guest" && myPeerId) {
      room.guests.delete(myPeerId);
      // 访客离开，通知房主
      if (room.host) {
        safeSend(room.host, { type: "peer_disconnected", peerId: myPeerId });
      }
    }

    cleanupRoom(currentRoom);
  }

  ws.on("message", (raw) => {
    if (!checkRateLimit(ws)) {
      safeSend(ws, { type: "error", message: "消息频率过高，请稍后再试" });
      return;
    }

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      safeSend(ws, { type: "error", message: "无效的 JSON" });
      return;
    }

    switch (msg.type) {
      // ========== 房主：创建房间 ==========
      case "create_room": {
        leaveCurrentRoom();

        let code = generateRoomCode();
        while (rooms.has(code)) code = generateRoomCode();

        rooms.set(code, {
          host: ws,
          guests: new Map(),
          createdAt: Date.now(),
        });
        currentRoom = code;
        role = "host";
        myPeerId = "host";

        console.log(`[房间] ${code} 由 ${clientIp} 创建, 总房间: ${rooms.size}`);
        safeSend(ws, { type: "room_created", roomCode: code });
        break;
      }

      // ========== 访客：加入房间 ==========
      case "join_room": {
        const code = (msg.roomCode || "").toUpperCase().trim();
        if (!rooms.has(code)) {
          safeSend(ws, { type: "error", message: `房间 ${code} 不存在` });
          return;
        }

        const room = rooms.get(code);
        if (getRoomSize(room) >= MAX_ROOM_SIZE) {
          safeSend(ws, { type: "error", message: `房间已满（最多${MAX_ROOM_SIZE}人）` });
          return;
        }

        if (!room.host) {
          safeSend(ws, { type: "error", message: "房主不在房间中" });
          return;
        }

        leaveCurrentRoom();

        // 分配唯一 peerId
        peerIdCounter++;
        myPeerId = `g${peerIdCounter}`;
        room.guests.set(myPeerId, ws);
        currentRoom = code;
        role = "guest";

        console.log(`[房间] ${code} 访客 ${myPeerId} 加入 (${clientIp}), 房间 ${getRoomSize(room)}/${MAX_ROOM_SIZE}`);

        // 通知访客加入成功
        safeSend(ws, { type: "room_joined", roomCode: code, peerId: myPeerId });

        // 通知房主和这个访客：准备好配对了
        // 只通知这一对人，不影响已连接的其他访客
        safeSend(room.host, { type: "peer_ready", peerId: myPeerId, roomCode: code });
        safeSend(ws, { type: "peer_ready", peerId: "host", roomCode: code });

        console.log(`[房间] ${code} 房主 ↔ 访客 ${myPeerId} 开始配对！`);
        break;
      }

      // ========== 信令转发（定向路由） ==========
      case "signal": {
        if (!currentRoom || !rooms.has(currentRoom)) {
          safeSend(ws, { type: "error", message: "你不在任何房间里" });
          return;
        }

        const room = rooms.get(currentRoom);
        const targetPeerId = msg.targetPeerId;

        if (role === "host") {
          // 房主发给指定访客
          const targetGuest = room.guests.get(targetPeerId);
          if (targetGuest) {
            safeSend(targetGuest, {
              type: "signal",
              from: "host",
              peerId: "host",
              data: msg.data,
            });
          }
        } else if (role === "guest") {
          // 访客发给房主
          if (room.host) {
            safeSend(room.host, {
              type: "signal",
              from: "guest",
              peerId: myPeerId,
              data: msg.data,
            });
          }
        }
        break;
      }

      default:
        safeSend(ws, { type: "error", message: `未知消息类型: ${msg.type}` });
    }
  });

  ws.on("close", () => {
    totalConnections--;
    const ic = ipConnCount.get(clientIp) || 1;
    if (ic <= 1) ipConnCount.delete(clientIp);
    else ipConnCount.set(clientIp, ic - 1);

    console.log(`[断开] ${clientIp} (${myPeerId}) 离开${currentRoom ? ` (房间 ${currentRoom})` : ""}, 在线: ${totalConnections}`);
    leaveCurrentRoom();
  });

  ws.on("error", (err) => {
    console.error(`[错误] ${clientIp}:`, err.message);
  });
});

wss.on("close", () => {
  clearInterval(heartbeatInterval);
  clearInterval(roomCleanupInterval);
});

// ======================== HTTP 健康检查 ========================
const http = require("http");
const healthServer = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      connections: totalConnections,
      rooms: rooms.size,
      uptime: process.uptime(),
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
healthServer.listen(PORT + 1, () => {
  console.log(`[健康检查] HTTP 端点: http://0.0.0.0:${PORT + 1}/health`);
});

console.log(`
╔══════════════════════════════════════════════╗
║   MC P2P 信令服务器 (Production)             ║
║   WebSocket 端口: ${PORT}                       ║
║   每房间最大人数: ${MAX_ROOM_SIZE}                        ║
║   最大连接数: ${MAX_CONNECTIONS}                       ║
╚══════════════════════════════════════════════╝
`);
