const tauriApi = window.__TAURI__ || {};
const invoke = tauriApi.core?.invoke || (async (command) => {
    if (command === "detect_mc_port") return 25565;
    if (command === "step1_get_ip") return "127.0.0.1:30000,127.0.0.1:30001";
    if (command === "diagnose_network") return "浏览器预览模式无法检测 NAT";
    return undefined;
});
const listen = tauriApi.event?.listen || (() => Promise.resolve(() => {}));

const SIGNAL_SERVER_URL = window.MC_P2P_CONFIG?.signalServerUrl || "wss://your-domain.com";
const MAX_RECONNECT_ATTEMPTS = 10;

let ws = null;
let currentRole = null;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pendingOnOpen = null;

let peerNegotiations = new Map();
let activeHostPeers = new Set();
let step1Done = false;
let pendingPeerIp = null;
let myStunIp = null;
let guestAutoPortAttempt = 0;

function normalizeCandidates(value) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).filter(Boolean);
    }
    return String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
}

function candidatesToWire(candidates) {
    return normalizeCandidates(candidates).join(",");
}

function primaryCandidate(candidates) {
    return normalizeCandidates(candidates)[0] || "";
}

const state = {
    activePanel: "host-panel",
    signal: "disconnected",
    lastLog: "等待操作",
    host: {
        port: "25565",
        roomCode: "",
        status: "idle",
        busy: false,
        connectedGuestCount: 0,
    },
    guest: {
        roomCode: "",
        localPort: "",
        hostPort: "",
        assignedPort: "",
        status: "idle",
        busy: false,
    },
};

const els = {
    statusBadge: document.getElementById("server-status"),
    tabs: document.querySelectorAll(".tab-btn"),
    panels: document.querySelectorAll(".panel"),
    btnCreate: document.getElementById("btn-create"),
    btnJoin: document.getElementById("btn-join"),
    btnReset: document.getElementById("btn-reset-connection"),
    btnNetworkTest: document.getElementById("btn-network-test"),
    btnClearLog: document.getElementById("btn-clear-log"),
    btnDetectPort: document.getElementById("btn-detect-port"),
    hostPort: document.getElementById("host-port"),
    guestCode: document.getElementById("guest-room-code"),
    guestLocalPort: document.getElementById("guest-local-port"),
    hostRoomCode: document.getElementById("host-room-code"),
    hostRoomHint: document.getElementById("host-room-hint"),
    hostGuestCount: document.getElementById("host-guest-count"),
    hostSessionState: document.getElementById("host-session-state"),
    guestSessionState: document.getElementById("guest-session-state"),
    guestLocalEndpoint: document.getElementById("guest-local-endpoint"),
    guestRoomHint: document.getElementById("guest-room-hint"),
    guestTunnelState: document.getElementById("guest-tunnel-state"),
    logOutput: document.getElementById("log-output"),
    logSummary: document.getElementById("log-summary"),
};

const statusText = {
    idle: "未开始",
    connecting: "连接中",
    waiting: "等待访客",
    pairing: "配对中",
    ready: "已就绪",
    error: "失败",
};

function parseValidPort(value) {
    const port = parseInt(value, 10);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
}

function getGuestAutoPort(hostPort) {
    const candidates = [];
    const pushPort = (port) => {
        if (port && !candidates.includes(port)) candidates.push(port);
    };

    pushPort(hostPort);
    pushPort(25565);
    for (let port = 25566; port <= 25575; port += 1) {
        pushPort(port);
    }

    return candidates[Math.min(guestAutoPortAttempt, candidates.length - 1)] || 25565;
}

function sendCreateRoomRequest() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "create_room" }));
}

function sendJoinRoomRequest(roomCode) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "join_room", roomCode }));
}

function buildSignalReconnectAction() {
    if (currentRole === "host") {
        return () => {
            peerNegotiations.clear();
            activeHostPeers.clear();
            setRoleState("host", {
                roomCode: "",
                status: "connecting",
                busy: true,
                connectedGuestCount: 0,
            });
            log("信令已重连，正在重新创建房间...", "info");
            sendCreateRoomRequest();
        };
    }

    if (currentRole === "guest") {
        const roomCode = state.guest.roomCode.trim().toUpperCase();
        if (roomCode.length !== 6) return null;

        return () => {
            step1Done = false;
            pendingPeerIp = null;
            myStunIp = null;
            setRoleState("guest", {
                roomCode,
                hostPort: "",
                assignedPort: "",
                status: "connecting",
                busy: true,
            });
            log(`信令已重连，正在重新加入房间 ${roomCode}...`, "info");
            sendJoinRoomRequest(roomCode);
        };
    }

    return null;
}

function setRoleState(role, patch) {
    Object.assign(state[role], patch);
    render();
}

function setSignal(status) {
    state.signal = status;
    render();
}

function setLastLog(text) {
    state.lastLog = text;
    els.logSummary.textContent = text;
}

function log(msg, type = "") {
    const div = document.createElement("div");
    if (type) div.className = `log-${type}`;
    const time = new Date().toLocaleTimeString();
    div.textContent = `[${time}] ${msg}`;
    els.logOutput.appendChild(div);

    while (els.logOutput.childElementCount > 500) {
        els.logOutput.removeChild(els.logOutput.firstChild);
    }

    els.logOutput.scrollTop = els.logOutput.scrollHeight;
    setLastLog(msg);
}

function renderStatusChip(el, status) {
    el.textContent = statusText[status] || statusText.idle;
    el.className = `state-chip ${status === "waiting" || status === "pairing" || status === "connecting" ? "busy" : status}`;
}

function render() {
    els.tabs.forEach((tab) => {
        const active = tab.dataset.target === state.activePanel;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", active ? "true" : "false");
    });

    els.panels.forEach((panel) => {
        panel.classList.toggle("active", panel.id === state.activePanel);
    });

    els.statusBadge.textContent = state.signal === "connected" ? "Signal: Connected" : "Signal: Disconnected";
    els.statusBadge.className = `status-badge ${state.signal === "connected" ? "connected" : "disconnected"}`;

    els.hostPort.value = state.host.port;
    els.guestCode.value = state.guest.roomCode;
    els.guestLocalPort.value = state.guest.localPort;

    renderStatusChip(els.hostSessionState, state.host.status);
    renderStatusChip(els.guestSessionState, state.guest.status);

    els.btnCreate.disabled = state.host.busy;
    els.btnCreate.textContent = state.host.roomCode ? "重新创建房间" : (state.host.busy ? "创建中..." : "创建联机房间");

    els.hostRoomCode.textContent = state.host.roomCode || "------";
    els.hostRoomHint.textContent = state.host.roomCode ? "房间码已缓存，切换标签不会清掉" : "创建后会显示房间码";
    els.hostGuestCount.textContent = `访客 ${state.host.connectedGuestCount}/7`;

    els.btnJoin.disabled = state.guest.busy;
    if (state.guest.status === "pairing") {
        els.btnJoin.textContent = "配对中...";
    } else if (state.guest.status === "ready") {
        els.btnJoin.textContent = "重新连接房间";
    } else {
        els.btnJoin.textContent = state.guest.busy ? "连接中..." : "连接房间";
    }

    els.guestLocalEndpoint.textContent = state.guest.assignedPort ? `127.0.0.1:${state.guest.assignedPort}` : "等待建立隧道";
    els.guestRoomHint.textContent = state.guest.roomCode ? `当前房间 ${state.guest.roomCode}` : "加入后会保留当前连接状态";
    els.guestTunnelState.textContent = state.guest.status === "ready" ? "Tunnel: Ready" : "Tunnel: Idle";
    els.logSummary.textContent = state.lastLog;
}

async function resetConnections() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (ws) {
        ws.close(1000);
        ws = null;
    }

    pendingOnOpen = null;
    reconnectAttempts = 0;
    currentRole = null;
    peerNegotiations.clear();
    activeHostPeers.clear();
    step1Done = false;
    pendingPeerIp = null;
    myStunIp = null;
    guestAutoPortAttempt = 0;

    setSignal("disconnected");
    setRoleState("host", {
        roomCode: "",
        status: "idle",
        busy: false,
        connectedGuestCount: 0,
    });
    setRoleState("guest", {
        assignedPort: "",
        status: "idle",
        busy: false,
    });

    await invoke("reset_connections").catch(() => {});
    log("连接状态已重置", "info");
}

async function closeCurrentSessionForNewAttempt() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    if (ws) {
        ws.close(1000);
        ws = null;
    }

    pendingOnOpen = null;
    reconnectAttempts = 0;
    peerNegotiations.clear();
    activeHostPeers.clear();
    step1Done = false;
    pendingPeerIp = null;
    myStunIp = null;
    setSignal("disconnected");
    await invoke("reset_connections").catch(() => {});
}

els.btnClearLog.addEventListener("click", () => {
    els.logOutput.innerHTML = "";
    log("[System] 日志已清空。");
});

els.btnReset.addEventListener("click", () => {
    resetConnections();
});

els.btnNetworkTest.addEventListener("click", async () => {
    els.btnNetworkTest.disabled = true;
    els.btnNetworkTest.textContent = "检测中";
    log("开始 NAT/UDP 网络检测...", "info");
    try {
        const report = await invoke("diagnose_network");
        String(report).split(/\r?\n/).filter(Boolean).forEach((line) => {
            const isBad = line.includes("失败") || line.includes("超时") || line.includes("疑似") || line.includes("不可用");
            const isGood = line.includes("稳定") || line.includes("友好");
            log(`[Network] ${line}`, isBad ? "error" : (isGood ? "success" : "info"));
        });
    } catch (err) {
        log(`网络检测失败: ${err}`, "error");
    } finally {
        els.btnNetworkTest.disabled = false;
        els.btnNetworkTest.textContent = "NAT检测";
    }
});

els.hostPort.addEventListener("input", () => {
    state.host.port = els.hostPort.value;
});

els.guestCode.addEventListener("input", () => {
    state.guest.roomCode = els.guestCode.value.trim().toUpperCase();
    els.guestCode.value = state.guest.roomCode;
});

els.guestLocalPort.addEventListener("input", () => {
    state.guest.localPort = els.guestLocalPort.value;
});

els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
        state.activePanel = tab.dataset.target;
        render();
    });
});

els.btnDetectPort.addEventListener("click", async () => {
    els.btnDetectPort.disabled = true;
    els.btnDetectPort.textContent = "侦测中";
    try {
        const port = await invoke("detect_mc_port");
        setRoleState("host", { port: String(port) });
        log(`自动侦测到 MC 局域网端口: ${port}`, "success");
    } catch (err) {
        log(`侦测失败: ${err}`, "error");
    } finally {
        els.btnDetectPort.disabled = false;
        els.btnDetectPort.textContent = "侦测";
    }
});

listen("log", (event) => {
    const msg = String(event.payload || "");
    log(`[Rust] ${msg}`, "info");

    const portMatch = msg.match(/本地代理端口:\s*(\d+)/);
    if (portMatch) {
        setRoleState("guest", {
            assignedPort: portMatch[1],
            status: "ready",
            busy: false,
        });
    }

    if (msg.includes("联机准备完毕")) {
        setRoleState("guest", {
            status: "ready",
            busy: false,
        });
        log("隧道已建立，可以进入 Minecraft。", "success");
    }
});

function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        log(`已尝试 ${MAX_RECONNECT_ATTEMPTS} 次重连，放弃。请检查网络后手动重试。`, "error");
        if (currentRole === "host") setRoleState("host", { busy: false, status: "error" });
        if (currentRole === "guest") setRoleState("guest", { busy: false, status: "error" });
        return;
    }

    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 16000);
    reconnectAttempts++;
    log(`${(delay / 1000).toFixed(0)} 秒后第 ${reconnectAttempts} 次重连...`, "info");
    reconnectTimer = setTimeout(() => {
        connectSignalServer(pendingOnOpen || (() => {}));
    }, delay);
}

function connectSignalServer(onOpen) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        onOpen();
        return;
    }

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    pendingOnOpen = onOpen;
    log(`连接信令服务器 (${SIGNAL_SERVER_URL})...`);

    try {
        ws = new WebSocket(SIGNAL_SERVER_URL);
    } catch (err) {
        log(`WebSocket 创建失败: ${err.message}`, "error");
        scheduleReconnect();
        return;
    }

    const socket = ws;

    socket.onopen = () => {
        if (ws !== socket) return;
        reconnectAttempts = 0;
        setSignal("connected");
        log("信令服务器已连接", "success");
        if (pendingOnOpen) {
            pendingOnOpen();
            pendingOnOpen = null;
        }
    };

    socket.onclose = (event) => {
        if (ws !== socket) return;
        setSignal("disconnected");
        if (event.code !== 1000) {
            pendingOnOpen = buildSignalReconnectAction();
            log("信令连接断开，准备自动重连并恢复房间状态...", "error");
            scheduleReconnect();
        } else {
            log("信令连接已关闭", "info");
        }
    };

    socket.onerror = () => {
        if (ws !== socket) return;
        log("信令服务器连接错误", "error");
    };

    socket.onmessage = async (e) => {
        if (ws !== socket) return;
        let msg;
        try {
            msg = JSON.parse(e.data);
        } catch {
            log("收到非 JSON 信令数据，已忽略", "error");
            return;
        }

        switch (msg.type) {
            case "room_created":
                activeHostPeers.clear();
                setRoleState("host", {
                    roomCode: msg.roomCode,
                    status: "waiting",
                    busy: false,
                    connectedGuestCount: 0,
                });
                log(`房间已创建: ${msg.roomCode}，等待访客加入`, "success");
                break;

            case "room_joined":
                setRoleState("guest", {
                    roomCode: msg.roomCode,
                    status: "pairing",
                    busy: true,
                });
                log(`成功加入房间 ${msg.roomCode}，等待配对`, "success");
                break;

            case "peer_ready":
                await handlePeerReady(msg.peerId, msg.roomCode);
                break;

            case "signal":
                await handleSignal(msg);
                break;

            case "peer_disconnected":
                log(`${msg.peerId || "对方"} 已断线`, "error");
                if (currentRole === "host") {
                    if (msg.peerId && msg.peerId !== "host") {
                        activeHostPeers.delete(msg.peerId);
                        peerNegotiations.delete(msg.peerId);
                    }
                    setRoleState("host", {
                        status: "waiting",
                        connectedGuestCount: activeHostPeers.size,
                    });
                }
                if (currentRole === "guest") setRoleState("guest", { status: "error", busy: false });
                break;

            case "error":
                log(`Server Error: ${msg.message}`, "error");
                if (currentRole === "host") setRoleState("host", { status: "error", busy: false });
                if (currentRole === "guest") setRoleState("guest", { status: "error", busy: false });
                break;

            default:
                log(`未知信令类型: ${msg.type}`, "info");
        }
    };
}

async function handlePeerReady(peerId, roomCode) {
    log(`与 ${peerId} 开始配对，交换打洞 IP...`, "success");

    if (currentRole === "host") {
        setRoleState("host", { status: "pairing" });
        peerNegotiations.set(peerId, { step1Done: false, pendingPeerIp: null });
        await startP2PNegotiationForPeer(peerId);
        return;
    }

    setRoleState("guest", {
        roomCode: roomCode || state.guest.roomCode,
        status: "pairing",
        busy: true,
    });
    step1Done = false;
    pendingPeerIp = null;
    await startP2PNegotiation();
}

async function handleSignal(msg) {
    const peerCandidates = normalizeCandidates(msg.data?.ips || msg.data?.ip);
    if (!msg.data || peerCandidates.length === 0) {
        log("收到无效的 signal 数据，已忽略", "error");
        return;
    }

    const peerId = msg.peerId;
    log(`收到 ${peerId} 的 ${peerCandidates.length} 个打洞候选: ${peerCandidates.join(", ")}`);

    if (currentRole === "host") {
        const peerState = peerNegotiations.get(peerId);
        if (peerState && peerState.step1Done) {
            await executeStep2(peerCandidates, peerId);
        } else if (peerState) {
            peerState.pendingPeerIp = peerCandidates;
            log(`等待与 ${peerId} 的 STUN 探测完成...`, "info");
        }
        return;
    }

    const hostPort = parseValidPort(msg.data.hostPort);
    if (hostPort) {
        const shouldLog = state.guest.hostPort !== String(hostPort);
        setRoleState("guest", { hostPort: String(hostPort) });
        if (shouldLog && !state.guest.localPort) {
            log(`收到房主 MC 端口: ${hostPort}，连接端将优先使用同端口`, "info");
        }
    }

    if (step1Done) {
        await executeStep2(peerCandidates, peerId);
    } else {
        pendingPeerIp = peerCandidates;
        log("等待自身 STUN 探测完成...", "info");
    }
}

async function executeStep2(peerCandidates, peerId) {
    const peerIp = candidatesToWire(peerCandidates);
    if (currentRole === "host") {
        try {
            const port = parseInt(state.host.port, 10);
            if (Number.isNaN(port) || port < 1 || port > 65535) {
                log("请输入有效的端口号（1-65535）", "error");
                setRoleState("host", { status: "error", busy: false });
                return;
            }

            const peerState = peerNegotiations.get(peerId);
            const stunAddr = peerState ? primaryCandidate(peerState.myStunIp) : "";
            if (!stunAddr) {
                log(`[${peerId}] 无法找到 STUN 地址，跳过`, "error");
                setRoleState("host", { status: "error", busy: false });
                return;
            }

            log(`[${peerId}] 正在打洞并建立隧道...`);
            await invoke("host_step2_connect", { guestIp: peerIp, mcPort: port, stunAddr });
            activeHostPeers.add(peerId);
            setRoleState("host", {
                status: "waiting",
                busy: false,
                connectedGuestCount: activeHostPeers.size,
            });
            log(`访客 ${peerId} 隧道已建立，当前在线 ${activeHostPeers.size}/7`, "success");
        } catch (err) {
            log(`[${peerId}] 打洞失败: ${err}`, "error");
            setRoleState("host", { status: "error", busy: false });
        }
        return;
    }

    try {
        log("正在打洞并建立本地代理...");
        const manualPort = parseValidPort(state.guest.localPort);
        const hostPort = parseValidPort(state.guest.hostPort);
        const localPort = manualPort || getGuestAutoPort(hostPort);
        if (!manualPort) {
            const autoLabel = guestAutoPortAttempt === 0 && hostPort
                ? "跟随房主端口"
                : `自动候选 ${guestAutoPortAttempt + 1}`;
            log(`连接端代理端口选择: ${localPort} (${autoLabel})`, "info");
        }
        await invoke("guest_step2_connect", { hostIp: peerIp, localPort, stunAddr: primaryCandidate(myStunIp) });
        setRoleState("guest", { status: "ready", busy: false });
        log("隧道已建立，可以进入 Minecraft。", "success");
    } catch (err) {
        log(`打洞失败: ${err}`, "error");
        setRoleState("guest", { status: "error", busy: false });
    }
}

async function startP2PNegotiationForPeer(peerId) {
    try {
        log(`[${peerId}] 调用 Rust 底层探测自身公网 IP...`);
        const peerStunIp = await invoke("step1_get_ip");
        const peerStunIps = normalizeCandidates(peerStunIp);
        log(`[${peerId}] 自身探测到 ${peerStunIps.length} 个公网候选: ${peerStunIps.join(", ")}`);

        const peerState = peerNegotiations.get(peerId);
        if (peerState) {
            peerState.step1Done = true;
            peerState.myStunIp = peerStunIps;
        }

        const hostPort = parseValidPort(state.host.port);
        ws.send(JSON.stringify({
            type: "signal",
            targetPeerId: peerId,
            data: { ip: primaryCandidate(peerStunIps), ips: peerStunIps, hostPort },
        }));

        if (peerState && peerState.pendingPeerIp) {
            const ip = peerState.pendingPeerIp;
            peerState.pendingPeerIp = null;
            log(`[${peerId}] 检测到缓存的对方 IP，开始打洞...`, "success");
            await executeStep2(ip, peerId);
        }
    } catch (err) {
        log(`[${peerId}] 获取 IP 失败: ${err}`, "error");
        setRoleState("host", { status: "error", busy: false });
    }
}

async function startP2PNegotiation() {
    try {
        log("调用 Rust 底层探测自身公网 IP...");
        myStunIp = await invoke("step1_get_ip");
        myStunIp = normalizeCandidates(myStunIp);
        log(`自身探测到 ${myStunIp.length} 个公网候选: ${myStunIp.join(", ")}`);

        step1Done = true;

        ws.send(JSON.stringify({
            type: "signal",
            data: { ip: primaryCandidate(myStunIp), ips: myStunIp },
        }));

        if (pendingPeerIp) {
            const ip = pendingPeerIp;
            pendingPeerIp = null;
            log("检测到缓存的对方 IP，开始打洞...", "success");
            await executeStep2(ip, "host");
        }
    } catch (err) {
        log(`获取 IP 失败: ${err}`, "error");
        setRoleState("guest", { status: "error", busy: false });
    }
}

els.btnCreate.addEventListener("click", async () => {
    await closeCurrentSessionForNewAttempt();
    currentRole = "host";
    peerNegotiations.clear();
    activeHostPeers.clear();
    setRoleState("host", {
        roomCode: "",
        status: "connecting",
        busy: true,
        connectedGuestCount: 0,
    });

    connectSignalServer(() => {
        sendCreateRoomRequest();
    });
});

els.btnJoin.addEventListener("click", async () => {
    const code = state.guest.roomCode.trim().toUpperCase();
    if (code.length !== 6) {
        log("请输入正确的 6 位房间码", "error");
        setRoleState("guest", { status: "error", busy: false });
        return;
    }

    const useAutoPort = !parseValidPort(state.guest.localPort);
    const retrySameRoom = currentRole === "guest" && state.guest.roomCode === code;
    if (useAutoPort && retrySameRoom) {
        guestAutoPortAttempt += 1;
        log(`自动端口切换到下一候选（第 ${guestAutoPortAttempt + 1} 个）`, "info");
    } else if (!retrySameRoom) {
        guestAutoPortAttempt = 0;
    }

    await closeCurrentSessionForNewAttempt();
    currentRole = "guest";
    step1Done = false;
    pendingPeerIp = null;
    myStunIp = null;
    setRoleState("guest", {
        roomCode: code,
        hostPort: "",
        assignedPort: "",
        status: "connecting",
        busy: true,
    });

    connectSignalServer(() => {
        sendJoinRoomRequest(code);
    });
});

render();
