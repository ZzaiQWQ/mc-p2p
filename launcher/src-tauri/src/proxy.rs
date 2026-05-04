use quinn::{Connection, Endpoint};
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};

/// 双向搬运字节：TCP ↔ QUIC，任一方向结束即正确关闭另一方向
async fn bridge_streams(
    mut quic_send: quinn::SendStream,
    mut quic_recv: quinn::RecvStream,
    tcp_stream: TcpStream,
) {
    let (mut tcp_read, mut tcp_write) = tcp_stream.into_split();

    tokio::select! {
        // TCP → QUIC 方向先结束（玩家断开 TCP）
        result = tokio::io::copy(&mut tcp_read, &mut quic_send) => {
            match result {
                Ok(bytes) => println!("[TCP代理] TCP→QUIC 传输完成 ({} bytes)", bytes),
                Err(e) => println!("[TCP代理] TCP→QUIC 传输错误: {}", e),
            }
            // 关键：通知对端 QUIC 流结束
            let _ = quic_send.finish();
            // 等待反方向排空剩余数据（最多 5 秒）
            let drain = tokio::io::copy(&mut quic_recv, &mut tcp_write);
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), drain).await;
            let _ = tcp_write.shutdown().await;
        }
        // QUIC → TCP 方向先结束（远端关闭了流）
        result = tokio::io::copy(&mut quic_recv, &mut tcp_write) => {
            match result {
                Ok(bytes) => println!("[TCP代理] QUIC→TCP 传输完成 ({} bytes)", bytes),
                Err(e) => println!("[TCP代理] QUIC→TCP 传输错误: {}", e),
            }
            let _ = tcp_write.shutdown().await;
            // 等待反方向排空剩余数据（最多 5 秒）
            let drain = tokio::io::copy(&mut tcp_read, &mut quic_send);
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), drain).await;
            let _ = quic_send.finish();
        }
    }
}

// ============== 房主端：接收 QUIC 连接，转发至本地真正的 MC 端口 ==============
pub async fn start_host_proxy(endpoint: Endpoint, mc_port: u16) -> Result<(), String> {
    println!("[TCP代理] 房主端等待远端访客的 QUIC 连接...");

    loop {
        if let Some(incoming) = endpoint.accept().await {
            tokio::spawn(async move {
                match incoming.await {
                    Ok(connection) => {
                        println!("[TCP代理] 新访客已连入 QUIC 隧道，客户端地址: {}", connection.remote_address());
                        println!("[TCP代理] 开始监听该访客的数据流，目标本地 MC 端口: {}", mc_port);
                        
                        loop {
                            // 接受该访客发起的一个双向流（对应 MC 的每一次 TCP 连接尝试）
                            match connection.accept_bi().await {
                                Ok((quic_send, quic_recv)) => {
                                    println!("[TCP代理] 收到访客发来的 TCP 握手映射请求");
                                    
                                    // 连接本机的真实 MC 服务端
                                    match TcpStream::connect(format!("127.0.0.1:{}", mc_port)).await {
                                        Ok(tcp_stream) => {
                                            tokio::spawn(async move {
                                                bridge_streams(quic_send, quic_recv, tcp_stream).await;
                                                println!("[TCP代理] 一条玩家数据流已结束 (Player Disconnected)");
                                            });
                                        }
                                        Err(e) => {
                                            println!("[TCP代理] 拒绝访客流量：无法连接到本地内网 MC 端口: {}", e);
                                        }
                                    }
                                }
                                Err(e) => {
                                    println!("[TCP代理] 接受双向流失败 (该访客可能已退出游戏或掉线): {:?}", e);
                                    break; // 退出该访客的监听循环
                                }
                            }
                        }
                    }
                    Err(e) => {
                        println!("[TCP代理] QUIC 连接握手建立失败: {}", e);
                    }
                }
            });
        } else {
            // endpoint 被主动关闭时跳出循环
            break;
        }
    }
    
    Ok(())
}

// ============== 访客端：绑定本地端口 ==============
// preferred_port: 用户自定义端口，0 表示自动查找
pub async fn bind_guest_listener(preferred_port: u16) -> Result<(TcpListener, u16), String> {
    // 如果用户指定了端口，优先尝试
    if preferred_port > 0 {
        match TcpListener::bind(format!("0.0.0.0:{}", preferred_port)).await {
            Ok(listener) => {
                println!("[TCP代理] 访客端绑定用户指定端口: {}", preferred_port);
                return Ok((listener, preferred_port));
            }
            Err(e) => {
                return Err(format!("无法绑定端口 {} (被占用): {}", preferred_port, e));
            }
        }
    }

    // 自动模式：从 25565 开始扫描
    for port in 25565..=25575 {
        match TcpListener::bind(format!("0.0.0.0:{}", port)).await {
            Ok(listener) => {
                println!("[TCP代理] 访客端自动绑定端口: {}", port);
                return Ok((listener, port));
            }
            Err(_) => continue,
        }
    }
    Err("无法绑定本地端口 25565-25575（全部被占用）".to_string())
}

// ============== 访客端：运行代理循环 ==============
pub async fn run_guest_proxy(listener: TcpListener, connection: Connection) {
    println!("[TCP代理] 访客端代理已启动！");

    loop {
        match listener.accept().await {
            Ok((tcp_stream, _addr)) => {
                println!("[TCP代理] 检测到游戏客户端连入，正在打通 QUIC 隧道...");

                let connection_clone = connection.clone();
                tokio::spawn(async move {
                    match connection_clone.open_bi().await {
                        Ok((quic_send, quic_recv)) => {
                            bridge_streams(quic_send, quic_recv, tcp_stream).await;
                            println!("[TCP代理] 一条游戏连接已结束");
                        }
                        Err(e) => {
                            println!("[TCP代理] 无法打开 QUIC 双向流: {}", e);
                        }
                    }
                });
            }
            Err(e) => {
                println!("[TCP代理] 接受游戏本地 TCP 连接失败: {}", e);
            }
        }
    }
}
