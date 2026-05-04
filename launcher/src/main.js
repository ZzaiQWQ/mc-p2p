const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let ws = null;
let currentRole = null; // 'host' or 'guest'

// ========== 信令服务器地址（部署后改为你的域名，必须用 wss://） ==========
const SIGNAL_SERVER_URL = 'wss://your-domain.com';

// ========== 自动重连配置 ==========
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
let reconnectTimer = null;
let pendingOnOpen = null;

// ========== 多访客配对状态 ==========
// 房主模式下：每个访客独立配对，用 peerId 区分
// peerNegotiations: Map<peerId, { step1Done, pendingPeerIp }>
let peerNegotiations = new Map();

// 访客模式下的简单状态
let step1Done = false;
let pendingPeerIp = null;
let myStunIp = null; // 访客的 STUN 地址（用于取回 socket）
let connectedGuestCount = 0;

// UI Elements
const els = {
    statusBadge: document.getElementById('server-status'),
    tabs: document.querySelectorAll('.tab-btn'),
    panels: document.querySelectorAll('.panel'),
    btnCreate: document.getElementById('btn-create'),
    btnJoin: document.getElementById('btn-join'),
    hostPort: document.getElementById('host-port'),
    guestCode: document.getElementById('guest-room-code'),
    hostRoomDisplay: document.getElementById('host-room-display'),
    hostRoomCode: document.getElementById('host-room-code'),
    logOutput: document.getElementById('log-output'),
    btnClearLog: document.getElementById('btn-clear-log'),
    btnDetectPort: document.getElementById('btn-detect-port'),
    guestLocalPort: document.getElementById('guest-local-port')
};

// Logging System
function log(msg, type = '') {
    const div = document.createElement('div');
    if (type) div.className = `log-${type}`;
    const time = new Date().toLocaleTimeString();
    div.textContent = `[${time}] ${msg}`;
    els.logOutput.appendChild(div);
    while (els.logOutput.childElementCount > 500) {
        els.logOutput.removeChild(els.logOutput.firstChild);
    }
    els.logOutput.scrollTop = els.logOutput.scrollHeight;
}

els.btnClearLog.addEventListener('click', () => { els.logOutput.innerHTML = ''; });

// 自动侦测 MC 局域网端口
els.btnDetectPort.addEventListener('click', async () => {
    els.btnDetectPort.disabled = true;
    els.btnDetectPort.textContent = '侦测中...';
    try {
        const port = await invoke('detect_mc_port');
        els.hostPort.value = port;
        log(`自动侦测到 MC 局域网端口: ${port}`, 'success');
    } catch (err) {
        log(`侦测失败: ${err}`, 'error');
    } finally {
        els.btnDetectPort.disabled = false;
        els.btnDetectPort.textContent = '侦测';
    }
});

listen('log', (event) => {
    log(`[Rust] ${event.payload}`, 'info');
});

// Tab Switching
els.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        // 重置所有状态
        if (ws) ws.close();
        step1Done = false;
        pendingPeerIp = null;
        peerNegotiations.clear();
        connectedGuestCount = 0;
        els.hostRoomDisplay.classList.add('hidden');
        els.btnCreate.disabled = false;
        els.btnCreate.textContent = '创建联机房间';
        els.btnJoin.disabled = false;
        els.btnJoin.textContent = '连接房间';

        // 通知后端清理所有连接
        invoke('reset_connections').catch(() => {});

        els.tabs.forEach(t => t.classList.remove('active'));
        els.panels.forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.target).classList.add('active');
    });
});

// ========== 收到对方 IP 后触发 step2 ==========
async function executeStep2(peerIp, peerId) {
    if (currentRole === 'host') {
        try {
            const port = parseInt(els.hostPort.value);
            if (isNaN(port) || port < 1 || port > 65535) {
                log("请输入有效的端口号（1-65535）", "error");
                return;
            }
            // 从 per-peer 状态取出该访客对应的 stunAddr
            const state = peerNegotiations.get(peerId);
            const stunAddr = state ? state.myStunIp : '';
            if (!stunAddr) {
                log(`[${peerId}] 无法找到 STUN 地址，跳过`, "error");
                return;
            }
            log(`[${peerId}] 正在召唤底层 Tauri Rust 引擎打洞...`);
            await invoke('host_step2_connect', { guestIp: peerIp, mcPort: port, stunAddr: stunAddr });
            connectedGuestCount++;
            log(`第 ${connectedGuestCount} 个访客隧道已建立！`, "success");
        } catch(err) {
            log(`[${peerId}] 打洞失败: ${err}`, "error");
            log(`[${peerId}] 可重新创建房间或让访客重试`, "info");
        }
    } else if (currentRole === 'guest') {
        try {
            log("正在召唤底层 Tauri Rust 引擎打洞...");
            const localPort = parseInt(els.guestLocalPort.value) || 0;
            await invoke('guest_step2_connect', { hostIp: peerIp, localPort: localPort, stunAddr: myStunIp });
        } catch (err) {
            log(`打洞失败: ${err}`, "error");
            els.btnJoin.disabled = false;
            els.btnJoin.textContent = '连接房间';
        }
    }
}

// ========== 自动重连（指数退避） ==========
function scheduleReconnect() {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        log(`已尝试 ${MAX_RECONNECT_ATTEMPTS} 次重连，放弃。请检查网络后手动重试。`, 'error');
        els.btnCreate.disabled = false;
        els.btnCreate.textContent = '创建联机房间';
        els.btnJoin.disabled = false;
        els.btnJoin.textContent = '连接房间';
        return;
    }
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 16000);
    reconnectAttempts++;
    log(`${(delay / 1000).toFixed(0)} 秒后第 ${reconnectAttempts} 次重连...`, 'info');
    reconnectTimer = setTimeout(() => {
        connectSignalServer(pendingOnOpen || (() => {}));
    }, delay);
}

// WebSocket Signal Server connection (with auto-reconnect)
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
        log(`WebSocket 创建失败: ${err.message}`, 'error');
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        reconnectAttempts = 0;
        els.statusBadge.textContent = 'Signal: Connected';
        els.statusBadge.className = 'status-badge connected';
        log('信令服务器已连接', 'success');
        if (pendingOnOpen) {
            pendingOnOpen();
            pendingOnOpen = null;
        }
    };

    ws.onclose = (event) => {
        els.statusBadge.textContent = 'Signal: Disconnected';
        els.statusBadge.className = 'status-badge disconnected';
        if (event.code !== 1000) {
            log('信令连接断开，准备自动重连...', 'error');
            scheduleReconnect();
        } else {
            log('信令连接已关闭', 'error');
        }
    };

    ws.onerror = () => {
        log('信令服务器连接错误', 'error');
    };

    ws.onmessage = async (e) => {
        let msg;
        try {
            msg = JSON.parse(e.data);
        } catch {
            log('收到非 JSON 信令数据，已忽略', 'error');
            return;
        }
        
        switch (msg.type) {
            case 'room_created':
                els.hostRoomCode.textContent = msg.roomCode;
                els.hostRoomDisplay.classList.remove('hidden');
                log(`房间已创建: ${msg.roomCode}，等待访客加入（最多7人）`);
                break;
                
            case 'room_joined':
                log(`成功加入房间 ${msg.roomCode}`);
                els.btnJoin.textContent = "等待配对...";
                break;

            case 'peer_ready': {
                const peerId = msg.peerId;
                log(`与 ${peerId} 开始配对，交换打洞 IP...`, "success");
                
                if (currentRole === 'host') {
                    // 房主：为每个访客独立配对
                    peerNegotiations.set(peerId, { step1Done: false, pendingPeerIp: null });
                    await startP2PNegotiationForPeer(peerId);
                } else {
                    // 访客：与房主配对
                    step1Done = false;
                    pendingPeerIp = null;
                    await startP2PNegotiation();
                }
                break;
            }

            case 'signal': {
                if (!msg.data || !msg.data.ip) {
                    log('收到无效的 signal 数据，已忽略', 'error');
                    break;
                }
                const peerIp = msg.data.ip;
                const peerId = msg.peerId;
                log(`收到 ${peerId} 的打洞地址: ${peerIp}`);
                
                if (currentRole === 'host') {
                    // 房主收到某个访客的 IP
                    const state = peerNegotiations.get(peerId);
                    if (state && state.step1Done) {
                        await executeStep2(peerIp, peerId);
                    } else if (state) {
                        state.pendingPeerIp = peerIp;
                        log(`等待与 ${peerId} 的 STUN 探测完成...`, "info");
                    }
                } else {
                    // 访客收到房主的 IP
                    if (step1Done) {
                        await executeStep2(peerIp, peerId);
                    } else {
                        log("等待自身 STUN 探测完成...", "info");
                        pendingPeerIp = peerIp;
                    }
                }
                break;
            }
                
            case 'peer_disconnected':
                log(`${msg.peerId || '对方'} 已断线`, "error");
                break;
                
            case 'error':
                log(`Server Error: ${msg.message}`, "error");
                els.btnCreate.disabled = false;
                els.btnJoin.disabled = false;
                break;

            default:
                log(`未知信令类型: ${msg.type}`, 'info');
        }
    };
}

// 房主为每个访客独立做 STUN + 信令交换
async function startP2PNegotiationForPeer(peerId) {
    try {
        log(`[${peerId}] 调用 Rust 底层探测自身公网 IP...`);
        const peerStunIp = await invoke('step1_get_ip');
        log(`[${peerId}] 自身探测到的公网地址: ${peerStunIp}`);
        
        const state = peerNegotiations.get(peerId);
        if (state) {
            state.step1Done = true;
            state.myStunIp = peerStunIp; // 存到 per-peer 状态，不再用全局变量
        }
        
        // 发给这个特定的访客
        ws.send(JSON.stringify({
            type: 'signal',
            targetPeerId: peerId,
            data: { ip: peerStunIp }
        }));
        
        // 检查这个访客的 IP 是不是已经到了
        if (state && state.pendingPeerIp) {
            log(`[${peerId}] 检测到缓存的对方 IP，开始打洞...`, "success");
            const ip = state.pendingPeerIp;
            state.pendingPeerIp = null;
            await executeStep2(ip, peerId);
        }
    } catch (err) {
        log(`[${peerId}] 获取 IP 失败: ${err}`, "error");
    }
}

// 访客的 STUN + 信令交换
async function startP2PNegotiation() {
    try {
        log("调用 Rust 底层探测自身公网 IP...");
        myStunIp = await invoke('step1_get_ip');
        log(`自身探测到的公网地址: ${myStunIp}`);
        
        step1Done = true;
        
        // 发给房主（不需要 targetPeerId，服务器会路由到房主）
        ws.send(JSON.stringify({
            type: 'signal',
            data: { ip: myStunIp }
        }));
        
        if (pendingPeerIp) {
            log("检测到缓存的对方 IP，开始打洞...", "success");
            const ip = pendingPeerIp;
            pendingPeerIp = null;
            await executeStep2(ip, 'host');
        }
    } catch (err) {
        log(`获取 IP 失败: ${err}`, "error");
    }
}

// Actions
els.btnCreate.addEventListener('click', () => {
    currentRole = 'host';
    peerNegotiations.clear();
    connectedGuestCount = 0;
    els.btnCreate.disabled = true;
    els.btnCreate.textContent = '等待访客...';
    
    connectSignalServer(() => {
        ws.send(JSON.stringify({ type: 'create_room' }));
    });
});

els.btnJoin.addEventListener('click', () => {
    const code = els.guestCode.value.trim().toUpperCase();
    if (code.length !== 6) {
        log("请输入正确的 6 位房间码", "error");
        return;
    }

    currentRole = 'guest';
    step1Done = false;
    pendingPeerIp = null;
    els.btnJoin.disabled = true;
    els.btnJoin.textContent = '连接中...';

    connectSignalServer(() => {
        ws.send(JSON.stringify({ type: 'join_room', roomCode: code }));
    });
});
