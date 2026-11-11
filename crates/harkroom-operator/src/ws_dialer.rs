//! 서버 링크의 실제 dialer(S2 s21a) — TS `nodeWsDialer` 자리.
//!
//! tungstenite(handshake 만)로 WS 를 열고, `wss` 면 rustls(ring·webpki-roots, ureq 와 같은 공급자)로 감싼다.
//! 토큰은 `authorization: Bearer` 머리로만 간다(URL·로그에 안 남는다). 읽기는 짧은 read timeout 으로 돌아
//! `ReadEvent::Idle` 을 내고, 링크 고리가 그 틈에 보낼 줄을 비운다. 닫힘은 `describe_close` 한 줄로 접는다.
use crate::server_link::{Conn, Dialer, ReadEvent, describe_close};
use std::io::{ErrorKind, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::http::HeaderValue;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::{Error as WsError, Message, WebSocket};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(500);
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

enum Stream {
    Plain(TcpStream),
    Tls(Box<rustls::StreamOwned<rustls::ClientConnection, TcpStream>>),
}

impl Stream {
    fn tcp(&self) -> &TcpStream {
        match self {
            Stream::Plain(s) => s,
            Stream::Tls(s) => s.get_ref(),
        }
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Stream::Plain(s) => s.read(buf),
            Stream::Tls(s) => s.read(buf),
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Stream::Plain(s) => s.write(buf),
            Stream::Tls(s) => s.write(buf),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Stream::Plain(s) => s.flush(),
            Stream::Tls(s) => s.flush(),
        }
    }
}

/// `ws://host[:port]/path` · `wss://…` 에서 (tls, host, port) 를 꺼낸다. 다른 꼴은 거절.
pub fn split_url(url: &str) -> Result<(bool, String, u16), String> {
    let (tls, rest) = if let Some(r) = url.strip_prefix("wss://") {
        (true, r)
    } else if let Some(r) = url.strip_prefix("ws://") {
        (false, r)
    } else {
        return Err("ws:// 나 wss:// 가 아니다".to_string());
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains('@') {
        return Err("주소의 호스트가 잘못됐다".to_string());
    }
    let default_port = if tls { 443 } else { 80 };
    // IPv6 `[::1]:port`
    let (host, port) = if let Some(v6) = authority.strip_prefix('[') {
        let (h, after) = v6.split_once(']').ok_or("주소의 호스트가 잘못됐다")?;
        let port = match after.strip_prefix(':') {
            Some(p) => p.parse().map_err(|_| "포트가 잘못됐다")?,
            None if after.is_empty() => default_port,
            None => return Err("주소의 호스트가 잘못됐다".to_string()),
        };
        (h.to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((h, p)) => (h.to_string(), p.parse().map_err(|_| "포트가 잘못됐다")?),
            None => (authority.to_string(), default_port),
        }
    };
    if host.is_empty() {
        return Err("주소의 호스트가 잘못됐다".to_string());
    }
    Ok((tls, host, port))
}

fn tls_config() -> Arc<rustls::ClientConfig> {
    let roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring 공급자는 기본 판을 지원한다")
        .with_root_certificates(roots)
        .with_no_client_auth();
    Arc::new(cfg)
}

fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    let addrs = (host, port)
        .to_socket_addrs()
        .map_err(|e| format!("주소 풀이 실패: {e}"))?;
    let mut last = "주소 없음".to_string();
    for a in addrs {
        match TcpStream::connect_timeout(&a, CONNECT_TIMEOUT) {
            Ok(s) => return Ok(s),
            Err(e) => last = e.to_string(),
        }
    }
    Err(format!("접속 실패: {last}"))
}

/// 실제 dialer.
#[derive(Default)]
pub struct WsDialer {
    tls: Option<Arc<rustls::ClientConfig>>,
}

impl Dialer for WsDialer {
    fn dial(&mut self, url: &str, token: &str) -> Result<Box<dyn Conn>, String> {
        let (tls, host, port) = split_url(url)?;
        let tcp = connect_tcp(&host, port)?;
        let _ = tcp.set_nodelay(true);
        tcp.set_read_timeout(Some(HANDSHAKE_TIMEOUT))
            .and_then(|_| tcp.set_write_timeout(Some(WRITE_TIMEOUT)))
            .map_err(|e| e.to_string())?;
        let stream = if tls {
            let cfg = self.tls.get_or_insert_with(tls_config).clone();
            let name = rustls::pki_types::ServerName::try_from(host.clone())
                .map_err(|_| "TLS 이름이 잘못됐다".to_string())?;
            let conn = rustls::ClientConnection::new(cfg, name).map_err(|e| e.to_string())?;
            Stream::Tls(Box::new(rustls::StreamOwned::new(conn, tcp)))
        } else {
            Stream::Plain(tcp)
        };
        let mut req = url.into_client_request().map_err(|e| e.to_string())?;
        let auth = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| "토큰에 머리에 못 넣는 글자가 있다".to_string())?;
        req.headers_mut().insert("authorization", auth);
        let (socket, _resp) = tungstenite::client::client(req, stream).map_err(|e| match e {
            tungstenite::HandshakeError::Failure(WsError::Http(resp)) => {
                // 본문은 적지 않는다(무엇이 들었을지 모른다). 상태만.
                format!("업그레이드 거절 HTTP {}", resp.status().as_u16())
            }
            tungstenite::HandshakeError::Failure(other) => format!("핸드셰이크 실패: {other}"),
            tungstenite::HandshakeError::Interrupted(_) => "핸드셰이크 시간 초과".to_string(),
        })?;
        socket
            .get_ref()
            .tcp()
            .set_read_timeout(Some(POLL))
            .map_err(|e| e.to_string())?;
        Ok(Box::new(WsConn {
            socket,
            last_ping: None,
        }))
    }
}

struct WsConn {
    socket: WebSocket<Stream>,
    last_ping: Option<Instant>,
}

impl WsConn {
    fn since_ping_ms(&self) -> Option<u64> {
        self.last_ping.map(|t| t.elapsed().as_millis() as u64)
    }
}

fn is_timeout(e: &std::io::Error) -> bool {
    matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
}

impl Conn for WsConn {
    fn read(&mut self) -> ReadEvent {
        match self.socket.read() {
            Ok(Message::Text(t)) => ReadEvent::Text(t.as_str().to_string()),
            Ok(Message::Ping(_)) => {
                self.last_ping = Some(Instant::now());
                // tungstenite 가 pong 을 줄 세웠다 — 바로 내보낸다(못 보내면 다음 read 가 다시 민다).
                let _ = self.socket.flush();
                ReadEvent::Ping
            }
            Ok(Message::Close(frame)) => {
                // tungstenite 가 줄 세운 close 응답을 내보낸다 — 안 하면 서버가 응답을 기다리다 시간 초과로 끊는다.
                let _ = self.socket.flush();
                let (code, reason) = frame
                    .map(|f| (u16::from(f.code), f.reason.as_str().to_string()))
                    .unwrap_or((u16::from(CloseCode::Status), String::new()));
                ReadEvent::Closed(describe_close(code, &reason, self.since_ping_ms(), None))
            }
            Ok(_) => ReadEvent::Idle,
            Err(WsError::Io(e)) if is_timeout(&e) => ReadEvent::Idle,
            Err(WsError::ConnectionClosed | WsError::AlreadyClosed) => {
                ReadEvent::Closed(describe_close(1005, "", self.since_ping_ms(), None))
            }
            Err(e) => ReadEvent::Closed(describe_close(
                1006,
                "",
                self.since_ping_ms(),
                Some(&e.to_string()),
            )),
        }
    }

    fn send(&mut self, text: &str) -> Result<(), String> {
        self.socket
            .send(Message::text(text))
            .map_err(|e| format!("보내기 실패: {e}"))
    }

    fn close(&mut self) {
        let _ = self.socket.close(None);
        let _ = self.socket.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn split_url_shapes() {
        assert_eq!(
            split_url("wss://a.example.com/operator").unwrap(),
            (true, "a.example.com".into(), 443)
        );
        assert_eq!(
            split_url("ws://127.0.0.1:8080/operator").unwrap(),
            (false, "127.0.0.1".into(), 8080)
        );
        assert_eq!(
            split_url("ws://[::1]:9/operator").unwrap(),
            (false, "::1".into(), 9)
        );
        assert!(split_url("http://a/operator").is_err());
        assert!(split_url("wss://user@a/operator").is_err());
        assert!(split_url("wss://a:x/operator").is_err());
        assert!(split_url("wss:///operator").is_err());
    }

    /// 손으로 짠 아주 작은 WS 서버로: Bearer 머리 확인 → 텍스트 왕복 → ping(→ pong 이 돌아옴) → close 4401 한 줄.
    #[test]
    #[allow(clippy::result_large_err)] // accept_hdr 콜백의 꼴이 tungstenite 것이다.
    fn plain_ws_roundtrip_ping_pong_and_close_line() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (tcp, _) = listener.accept().unwrap();
            let mut seen_auth = None;
            let cb = |req: &tungstenite::handshake::server::Request,
                      resp: tungstenite::handshake::server::Response| {
                seen_auth = req
                    .headers()
                    .get("authorization")
                    .map(|v| v.to_str().unwrap().to_string());
                Ok(resp)
            };
            let mut ws = tungstenite::accept_hdr(tcp, cb).unwrap();
            let hello = ws.read().unwrap();
            ws.send(Message::Ping(Vec::new().into())).unwrap();
            ws.send(Message::text(r#"{"type":"x"}"#)).unwrap();
            let got_pong = loop {
                if let Message::Pong(_) = ws.read().unwrap() {
                    break true;
                }
            };
            ws.close(Some(tungstenite::protocol::CloseFrame {
                code: CloseCode::from(4401),
                reason: "bad token".into(),
            }))
            .unwrap();
            let _ = ws.flush();
            // 상대 close 응답까지 읽어 소켓이 정리되게 둔다.
            while ws.read().is_ok() {}
            (seen_auth, hello, got_pong)
        });
        let mut d = WsDialer::default();
        let mut c = d
            .dial(&format!("ws://127.0.0.1:{port}/operator"), "tok-abc")
            .unwrap();
        c.send(r#"{"type":"hello"}"#).unwrap();
        let mut events = Vec::new();
        for _ in 0..40 {
            let e = c.read();
            let done = matches!(e, ReadEvent::Closed(_));
            if e != ReadEvent::Idle {
                events.push(e);
            }
            if done {
                break;
            }
        }
        let (auth, hello, got_pong) = server.join().unwrap();
        assert_eq!(auth.as_deref(), Some("Bearer tok-abc"));
        assert_eq!(hello, Message::text(r#"{"type":"hello"}"#));
        assert!(got_pong);
        assert_eq!(events[0], ReadEvent::Ping);
        assert_eq!(events[1], ReadEvent::Text(r#"{"type":"x"}"#.into()));
        match &events[2] {
            ReadEvent::Closed(line) => {
                assert!(
                    line.starts_with("close 4401, bad token, 마지막 서버 ping "),
                    "{line}"
                )
            }
            e => panic!("{e:?}"),
        }
    }

    #[test]
    fn upgrade_refusal_reports_status_only() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut tcp, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = tcp.read(&mut buf);
            tcp.write_all(
                b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 11\r\nconnection: close\r\n\r\nsecret-body",
            )
            .unwrap();
        });
        let mut d = WsDialer::default();
        let err = match d.dial(&format!("ws://127.0.0.1:{port}/operator"), "t") {
            Err(e) => e,
            Ok(_) => panic!("열리면 안 된다"),
        };
        server.join().unwrap();
        assert_eq!(err, "업그레이드 거절 HTTP 401");
    }
}
