# MC P2P

一个用于 Minecraft 局域网联机的 P2P 启动器实验项目。

项目由两部分组成：

- `launcher/`：Tauri 桌面启动器，负责创建/加入房间、UDP 打洞、QUIC 隧道和本地 TCP 代理。
- `signal-server/`：Node.js WebSocket 信令服务器，只负责房间管理和双方信令转发。

## 当前状态

- 支持房主创建 6 位房间码。
- 支持访客通过房间码加入。
- 支持 STUN 探测公网地址。
- 支持 UDP 打洞后建立 QUIC 加密隧道。
- 支持访客本地代理端口自动分配。
- 支持本地私有信令地址配置，不需要把真实域名提交到仓库。

注意：纯 P2P UDP 打洞不保证所有网络都成功。对称 NAT、校园网、公司网、运营商 CGNAT 或严格防火墙环境可能无法连接，后续可加入服务器中继模式作为兜底。

## 目录结构

```txt
.
├─ launcher/        # Tauri 桌面端
└─ signal-server/   # WebSocket 信令服务器
```

## 信令服务器

进入信令服务器目录：

```bash
cd signal-server
npm install
npm start
```

默认端口：

```txt
WebSocket: 9090
Health:    9091
```

正式部署建议使用域名、HTTPS 和反向代理，并开启 WebSocket 支持。

## 启动器配置

公开仓库中的默认配置位于：

```txt
launcher/src/config.js
```

本地私有配置文件位于：

```txt
launcher/src/config.local.js
```

`config.local.js` 已被 `.gitignore` 忽略，不会上传到 GitHub。可以在本地写入自己的信令服务器地址：

```js
window.MC_P2P_CONFIG = {
    signalServerUrl: 'wss://your-domain.com'
};
```

启动器会优先读取 `config.local.js`，没有本地配置时使用 `config.js` 里的占位配置。

## 开发运行

进入启动器目录：

```bash
cd launcher
npm install
npx tauri dev
```

## 正式打包

```bash
cd launcher
npx tauri build --bundles nsis
```

打包后的安装程序通常位于：

```txt
launcher/src-tauri/target/release/bundle/nsis/
```

## 使用方式

房主：

1. 在 Minecraft 中打开「对局域网开放」。
2. 在启动器中选择「我是房主」。
3. 填写或自动侦测本地 MC 端口。
4. 创建房间并把房间码发给访客。

访客：

1. 在启动器中选择「我是访客」。
2. 输入房主提供的 6 位房间码。
3. 等待打洞和隧道建立完成。
4. 在 Minecraft 局域网列表中进入房间，或直接连接日志显示的本地代理端口。

## 版权协议

本项目采用 ARR（All Rights Reserved，保留所有权利）协议。

未经作者明确书面许可，不得复制、分发、修改、再发布、商用或用于衍生项目。详见 [LICENSE](LICENSE)。
