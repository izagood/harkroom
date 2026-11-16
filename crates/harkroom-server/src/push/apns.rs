//! APNs 전송부(S5.3 C5e-1, Rust 전환) — TS `packages/server/src/services/push/apns.ts` 를 옮긴다(토큰 인증 .p8).
//!
//! - JWT 는 ES256 이고 서명은 **고정 길이(r‖s, P1363)** 다. DER 로 서명하면 APNs 는 InvalidProviderToken(403)으로 거절한다
//!   → ring `ECDSA_P256_SHA256_FIXED_SIGNING`.
//! - JWT 는 50분마다 새로 만든다. 20분보다 자주 바꾸면 TooManyProviderTokenUpdates, 60분이 넘으면 ExpiredProviderToken.
//! - TLS 검증을 끄는 길은 없다. 시험은 [`ApnsTransport::with_origins`] 로 로컬 h2c(평문 HTTP/2) 서버를 가리킬 뿐이다 —
//!   env 로는 origin 을 못 바꾼다([`load_apns_config`] 는 늘 [`APNS_ORIGINS`]).
//! - 로그·오류에 기기 토큰은 앞 8자만([`redact_token`]), JWT·키는 남기지 않는다. 키 값은 `Debug` 에도 안 나온다.
//!
//! 이 모듈은 전송만 한다. 보낼 job 을 집고 결과를 정리하는 루프는 C5e-2 다.
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::client::conn::http2::SendRequest;
use hyper_util::rt::{TokioExecutor, TokioIo};
use ring::rand::SystemRandom;
use ring::signature::{ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ApnsEnv {
    Production,
    Sandbox,
}

impl ApnsEnv {
    /// `push_device.apns_env` 값.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "production" => Some(Self::Production),
            "sandbox" => Some(Self::Sandbox),
            _ => None,
        }
    }
}

/// 실제 APNs origin. TS `APNS_ORIGINS` 와 같다.
pub const APNS_ORIGINS: [(ApnsEnv, &str); 2] = [
    (ApnsEnv::Production, "https://api.push.apple.com"),
    (ApnsEnv::Sandbox, "https://api.sandbox.push.apple.com"),
];

/// JWT 를 새로 만드는 주기(ms). TS `APNS_JWT_TTL_MS`.
pub const APNS_JWT_TTL_MS: u64 = 50 * 60_000;
/// 응답 본문은 이만큼만 읽는다(reason 한 줄이면 충분하다).
const BODY_LIMIT: usize = 4096;
/// env 이름 — 넷 다 있거나 넷 다 없어야 한다.
pub const APNS_ENV_NAMES: [&str; 4] = ["APNS_KEY_ID", "APNS_TEAM_ID", "APNS_KEY_P8", "APNS_TOPIC"];

/// 기기 토큰을 로그에 남길 때. TS `redactToken` 과 같다(앞 8자 + …).
pub fn redact_token(token: &str) -> String {
    let head: String = token.chars().take(8).collect();
    format!("{head}…")
}

#[derive(Clone)]
pub struct ApnsConfig {
    pub key_id: String,
    pub team_id: String,
    /// `.p8` 파일 내용(PEM). `Debug` 에 안 나온다.
    pub key_pem: String,
    /// 번들 id.
    pub topic: String,
}

impl std::fmt::Debug for ApnsConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ApnsConfig")
            .field("key_id", &self.key_id)
            .field("team_id", &self.team_id)
            .field("key_pem", &"<redacted>")
            .field("topic", &self.topic)
            .finish()
    }
}

/// env 에서 설정을 읽는다(TS `loadApnsConfig`). **넷 다 없으면 `Ok(None)`**(푸시를 끈다). 일부만 있거나 키가 PEM 개인키로
/// 안 읽히면 `Err` — "켰다고 생각했는데 조용히 꺼져 있다"가 가장 찾기 어렵다. 오류 문구에는 값이 아니라 **이름**만 싣는다.
pub fn load_apns_config(
    get: impl Fn(&str) -> Option<String>,
) -> Result<Option<ApnsConfig>, String> {
    let val = |n: &str| get(n).filter(|v| !v.trim().is_empty());
    let present: Vec<&str> = APNS_ENV_NAMES
        .iter()
        .copied()
        .filter(|n| val(n).is_some())
        .collect();
    if present.is_empty() {
        return Ok(None);
    }
    if present.len() != APNS_ENV_NAMES.len() {
        let missing: Vec<&str> = APNS_ENV_NAMES
            .iter()
            .copied()
            .filter(|n| !present.contains(n))
            .collect();
        return Err(format!(
            "push: {} is missing (set all of {} or none)",
            missing.join(", "),
            APNS_ENV_NAMES.join(", ")
        ));
    }
    let cfg = ApnsConfig {
        key_id: val("APNS_KEY_ID").unwrap_or_default().trim().to_string(),
        team_id: val("APNS_TEAM_ID").unwrap_or_default().trim().to_string(),
        key_pem: val("APNS_KEY_P8").unwrap_or_default(),
        topic: val("APNS_TOPIC").unwrap_or_default().trim().to_string(),
    };
    signing_key(&cfg.key_pem)
        .map_err(|_| "push: APNS_KEY_P8 is not a readable PEM private key".to_string())?;
    Ok(Some(cfg))
}

/// PEM(PKCS#8 개인키 머리·꼬리 줄) → P-256 서명 키. 실패 까닭은 밖으로 내지 않는다(값이 섞일 수 있다).
fn signing_key(pem: &str) -> Result<EcdsaKeyPair, ()> {
    use base64::Engine;
    let b64: String = pem
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with("-----"))
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|_| ())?;
    EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &der, &SystemRandom::new())
        .map_err(|_| ())
}

fn b64url(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// TS `signApnsJwt` 와 같은 꼴: 머리 `{"alg":"ES256","kid":…}`, 본문 `{"iss":…,"iat":…}`, 서명 P1363.
/// 실패 까닭은 싣지 않는다(키 값이 섞일 수 있다).
#[allow(clippy::result_unit_err)]
pub fn sign_apns_jwt(
    key_id: &str,
    team_id: &str,
    key: &EcdsaKeyPair,
    now_sec: u64,
) -> Result<String, ()> {
    let head = format!(
        r#"{{"alg":"ES256","kid":{}}}"#,
        serde_json::to_string(key_id).map_err(|_| ())?
    );
    let claims = format!(
        r#"{{"iss":{},"iat":{now_sec}}}"#,
        serde_json::to_string(team_id).map_err(|_| ())?
    );
    let input = format!("{}.{}", b64url(head.as_bytes()), b64url(claims.as_bytes()));
    let sig = key
        .sign(&SystemRandom::new(), input.as_bytes())
        .map_err(|_| ())?;
    Ok(format!("{input}.{}", b64url(sig.as_ref())))
}

/// 기기 토큰 꼴 — TS 등록(`pushRoutes.ts`)의 `/^[0-9a-fA-F]{64,200}$/` 와 같다.
pub fn valid_device_token(token: &str) -> bool {
    (64..=200).contains(&token.len()) && token.bytes().all(|b| b.is_ascii_hexdigit())
}

pub struct ApnsSendInput<'a> {
    pub token: &'a str,
    pub env: ApnsEnv,
    pub payload: &'a serde_json::Value,
    pub collapse_id: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApnsResult {
    /// HTTP 상태. 네트워크 오류는 0.
    pub status: u16,
    /// APNs 가 준 `reason`(BadDeviceToken 등). 성공이면 없다. 네트워크 오류면 `connect_failed`·`timeout`·`stream_error`.
    pub reason: Option<String>,
}

impl ApnsResult {
    fn net(reason: &str) -> Self {
        Self {
            status: 0,
            reason: Some(reason.to_string()),
        }
    }
}

type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

struct Origin {
    tls: bool,
    host: String,
    port: u16,
    authority: String,
}

fn parse_origin(s: &str) -> Result<Origin, String> {
    let u = url::Url::parse(s).map_err(|e| format!("push: bad origin: {e}"))?;
    let tls = match u.scheme() {
        "https" => true,
        "http" => false,
        other => return Err(format!("push: bad origin scheme {other}")),
    };
    let host = u.host_str().ok_or("push: origin has no host")?.to_string();
    let port = u
        .port_or_known_default()
        .ok_or("push: origin has no port")?;
    let authority = match u.port() {
        Some(p) => format!("{host}:{p}"),
        None => host.clone(),
    };
    Ok(Origin {
        tls,
        host,
        port,
        authority,
    })
}

/// 환경마다 HTTP/2 연결 하나를 이어 쓴다(APNs 권장). 닫히거나 오류가 나면 다음 요청이 새로 연다.
pub struct ApnsTransport {
    cfg: ApnsConfig,
    key: EcdsaKeyPair,
    origins: HashMap<ApnsEnv, Origin>,
    tls: Arc<rustls::ClientConfig>,
    now_ms: Clock,
    timeout: Duration,
    jwt: Mutex<Option<(String, u64)>>,
    sessions: tokio::sync::Mutex<HashMap<ApnsEnv, SendRequest<Full<Bytes>>>>,
}

impl ApnsTransport {
    /// 실제 APNs 로. 키를 못 읽으면 `Err`(값은 싣지 않는다).
    pub fn new(cfg: ApnsConfig) -> Result<Self, String> {
        Self::build(cfg, &APNS_ORIGINS, None, Duration::from_secs(10))
    }

    /// origin·시계·시한을 바꿔 연다 — 시험용 길. `http://` origin 은 TLS 없는 h2c 다(로컬 가짜 서버).
    /// cargo feature `test-origins`(기본 꺼짐, 시험 빌드의 dev-dependency 만 켠다)일 때만 있다 — 운영 빌드에서는 APNs 밖으로
    /// 보낼 길이 없다(security C5e-1 권고).
    #[cfg(feature = "test-origins")]
    #[doc(hidden)]
    pub fn with_origins(
        cfg: ApnsConfig,
        origins: &[(ApnsEnv, &str)],
        now_ms: Option<Clock>,
        timeout: Duration,
    ) -> Result<Self, String> {
        Self::build(cfg, origins, now_ms, timeout)
    }

    fn build(
        cfg: ApnsConfig,
        origins: &[(ApnsEnv, &str)],
        now_ms: Option<Clock>,
        timeout: Duration,
    ) -> Result<Self, String> {
        let key = signing_key(&cfg.key_pem)
            .map_err(|_| "push: APNS_KEY_P8 is not a readable PEM private key".to_string())?;
        let mut map = HashMap::new();
        for (env, o) in origins {
            map.insert(*env, parse_origin(o)?);
        }
        let roots = rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        };
        let mut tls = rustls::ClientConfig::builder_with_provider(Arc::new(
            rustls::crypto::ring::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("push: tls: {e}"))?
        .with_root_certificates(roots)
        .with_no_client_auth();
        tls.alpn_protocols = vec![b"h2".to_vec()];
        let now_ms = now_ms.unwrap_or_else(|| {
            Arc::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            })
        });
        Ok(Self {
            cfg,
            key,
            origins: map,
            tls: Arc::new(tls),
            now_ms,
            timeout,
            jwt: Mutex::new(None),
            sessions: tokio::sync::Mutex::new(HashMap::new()),
        })
    }

    /// 50분 안이면 앞 JWT 를 그대로 쓴다.
    fn token(&self) -> Result<String, ()> {
        let t = (self.now_ms)();
        let mut g = self.jwt.lock().map_err(|_| ())?;
        if let Some((v, at)) = g.as_ref()
            && t.saturating_sub(*at) < APNS_JWT_TTL_MS
        {
            return Ok(v.clone());
        }
        let v = sign_apns_jwt(&self.cfg.key_id, &self.cfg.team_id, &self.key, t / 1000)?;
        *g = Some((v.clone(), t));
        Ok(v)
    }

    async fn connect(&self, env: ApnsEnv) -> Result<SendRequest<Full<Bytes>>, ()> {
        let o = self.origins.get(&env).ok_or(())?;
        let tcp = tokio::net::TcpStream::connect((o.host.as_str(), o.port))
            .await
            .map_err(|_| ())?;
        let _ = tcp.set_nodelay(true);
        if o.tls {
            let name = rustls::pki_types::ServerName::try_from(o.host.clone()).map_err(|_| ())?;
            let stream = tokio_rustls::TlsConnector::from(self.tls.clone())
                .connect(name, tcp)
                .await
                .map_err(|_| ())?;
            // ALPN 이 h2 가 아니면 HTTP/2 로 말할 수 없다.
            if stream.get_ref().1.alpn_protocol() != Some(b"h2") {
                return Err(());
            }
            self.handshake(TokioIo::new(stream)).await
        } else {
            self.handshake(TokioIo::new(tcp)).await
        }
    }

    async fn handshake<I>(&self, io: I) -> Result<SendRequest<Full<Bytes>>, ()>
    where
        I: hyper::rt::Read + hyper::rt::Write + Unpin + Send + 'static,
    {
        let (send, conn) = hyper::client::conn::http2::handshake(TokioExecutor::new(), io)
            .await
            .map_err(|_| ())?;
        tokio::spawn(async move {
            let _ = conn.await;
        });
        Ok(send)
    }

    async fn session(&self, env: ApnsEnv) -> Result<SendRequest<Full<Bytes>>, ()> {
        let mut g = self.sessions.lock().await;
        if let Some(s) = g.get(&env)
            && !s.is_closed()
        {
            return Ok(s.clone());
        }
        g.remove(&env);
        let s = self.connect(env).await?;
        g.insert(env, s.clone());
        Ok(s)
    }

    /// 하나 보낸다. 실패해도 `Err` 가 아니라 상태 0 의 [`ApnsResult`] 다(TS 와 같다 — 재시도 판정은 루프 몫).
    pub async fn send(&self, input: ApnsSendInput<'_>) -> ApnsResult {
        // 토큰은 요청 경로(`/3/device/<token>`)에 들어간다 — 등록이 hex 만 받지만 보내기 직전에도 다시 본다(security C5e-1 권고).
        // 틀리면 보내지 않고 APNs 의 `BadDeviceToken` 과 같게 돌려준다(루프가 그 기기를 지운다).
        if !valid_device_token(input.token) {
            return ApnsResult {
                status: 400,
                reason: Some("BadDeviceToken".to_string()),
            };
        }
        match tokio::time::timeout(self.timeout, self.send_inner(&input)).await {
            Ok(r) => r,
            Err(_) => {
                // 시한을 넘긴 연결은 버린다 — 다음 요청이 새로 연다.
                self.sessions.lock().await.remove(&input.env);
                ApnsResult::net("timeout")
            }
        }
    }

    async fn send_inner(&self, input: &ApnsSendInput<'_>) -> ApnsResult {
        let Ok(mut s) = self.session(input.env).await else {
            return ApnsResult::net("connect_failed");
        };
        let Some(o) = self.origins.get(&input.env) else {
            return ApnsResult::net("connect_failed");
        };
        let Ok(jwt) = self.token() else {
            return ApnsResult::net("stream_error");
        };
        let Ok(body) = serde_json::to_vec(input.payload) else {
            return ApnsResult::net("stream_error");
        };
        let scheme = if o.tls { "https" } else { "http" };
        let req = hyper::Request::post(format!(
            "{scheme}://{}/3/device/{}",
            o.authority, input.token
        ))
        .header("authorization", format!("bearer {jwt}"))
        .header("apns-topic", &self.cfg.topic)
        .header("apns-push-type", "alert")
        .header("apns-priority", "10")
        .header("apns-collapse-id", input.collapse_id)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(body)));
        let Ok(req) = req else {
            return ApnsResult::net("stream_error");
        };
        if s.ready().await.is_err() {
            self.sessions.lock().await.remove(&input.env);
            return ApnsResult::net("stream_error");
        }
        let res = match s.send_request(req).await {
            Ok(r) => r,
            Err(_) => {
                self.sessions.lock().await.remove(&input.env);
                return ApnsResult::net("stream_error");
            }
        };
        let status = res.status().as_u16();
        if status == 200 {
            return ApnsResult {
                status,
                reason: None,
            };
        }
        let reason = match Limited::new(res.into_body(), BODY_LIMIT).collect().await {
            Ok(b) => serde_json::from_slice::<serde_json::Value>(&b.to_bytes())
                .ok()
                .and_then(|v| v.get("reason").and_then(|r| r.as_str()).map(str::to_string)),
            Err(_) => None,
        };
        ApnsResult { status, reason }
    }

    /// 열린 연결을 모두 놓는다.
    pub async fn close(&self) {
        self.sessions.lock().await.clear();
    }
}
