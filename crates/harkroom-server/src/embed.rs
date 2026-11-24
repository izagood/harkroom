//! 임베딩 클라이언트(기억 벡터 검색 V2) — OpenAI 호환 `POST <주소>/v1/embeddings` 하나와 `GET <주소>/health` 만 부른다.
//!
//! - 설정(`HARKROOM_EMBED_URL`)이 없거나 값이 틀리면 [`EmbedConfig::from_env`] 이 없음/오류를 주고 서버는 낱말 검색만 쓴다.
//! - 서비스가 준비되기 전([`Embedder::is_ready`] 가 false)이거나 질의가 [`QUERY_TIMEOUT`] 을 넘으면 질의는 `None` 이다 —
//!   부르는 쪽은 막히지 않고 낱말로 답한다.
//! - 보낸 글·받은 벡터는 로그에 남기지 않는다. 키(Authorization)도 없다 — 옆 컨테이너에 붙는 것이 전제다.
use crate::avcs_http::{AvcsClient, client};
use http_body_util::{BodyExt, Full, Limited};
use hyper::body::Bytes;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

pub const URL_ENV: &str = "HARKROOM_EMBED_URL";
pub const MODEL_ENV: &str = "HARKROOM_EMBED_MODEL";
pub const DIM_ENV: &str = "HARKROOM_EMBED_DIM";

pub const DEFAULT_MODEL: &str = "bge-m3";
pub const DEFAULT_DIM: usize = 1024;
/// 질의는 앞 500자만 보낸다 — 길수록 느려 시한을 넘긴다.
pub const QUERY_CHARS: usize = 500;
pub const QUERY_TIMEOUT: Duration = Duration::from_millis(300);
/// 일괄 색인 한 요청의 개수와 시한.
pub const BATCH_SIZE: usize = 16;
pub const BATCH_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(3);
const HEALTH_INTERVAL: Duration = Duration::from_secs(10);
/// 응답 본문 상한 — 1024차원 16개의 JSON 은 400KB 안팎이다.
const MAX_RESPONSE: usize = 4 * 1024 * 1024;
const MAX_DIM: usize = 2000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedConfig {
    /// 끝 `/` 를 뗀 주소.
    pub base: String,
    pub model: String,
    pub dim: usize,
}

impl EmbedConfig {
    /// `Ok(None)` 은 주소를 안 준 것(끔). 틀린 값은 `Err` — 주소 원문은 싣지 않는다.
    pub fn from_env(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let get = |k: &str| {
            get(k)
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let Some(raw) = get(URL_ENV) else {
            return Ok(None);
        };
        let url = url::Url::parse(&raw).map_err(|_| format!("{URL_ENV} is not a URL"))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(format!("{URL_ENV} must be http(s)://host"));
        }
        // 주소에 계정·질의를 싣지 않는다 — 로그나 오류 글로 샐 수 있다.
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(format!("{URL_ENV} must not carry credentials or a query"));
        }
        let model = get(MODEL_ENV).unwrap_or_else(|| DEFAULT_MODEL.to_owned());
        let dim = match get(DIM_ENV) {
            None => DEFAULT_DIM,
            Some(v) => v
                .parse()
                .ok()
                .filter(|d| (1..=MAX_DIM).contains(d))
                .ok_or_else(|| format!("{DIM_ENV} must be 1..{MAX_DIM}"))?,
        };
        Ok(Some(Self {
            base: url.as_str().trim_end_matches('/').to_owned(),
            model,
            dim,
        }))
    }
}

/// 실패 — 글 내용은 싣지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmbedError {
    Timeout,
    /// 연결·전송 실패.
    Transport,
    Status(u16),
    /// 모양·개수·차원이 다르거나 유한하지 않은 값.
    BadResponse,
    /// 빈 입력이거나 [`BATCH_SIZE`] 를 넘음.
    BadInput,
}

pub struct Embedder {
    cfg: EmbedConfig,
    http: AvcsClient,
    ready: AtomicBool,
}

impl Embedder {
    pub fn new(cfg: EmbedConfig) -> Self {
        Self {
            cfg,
            http: client(),
            ready: AtomicBool::new(false),
        }
    }

    pub fn config(&self) -> &EmbedConfig {
        &self.cfg
    }

    pub fn is_ready(&self) -> bool {
        self.ready.load(Ordering::Relaxed)
    }

    /// 헬스를 한 번 보고 준비 상태를 고쳐 쓴다.
    pub async fn check_health(&self) -> bool {
        let ok = matches!(
            tokio::time::timeout(HEALTH_TIMEOUT, self.get_health()).await,
            Ok(true)
        );
        self.ready.store(ok, Ordering::Relaxed);
        ok
    }

    async fn get_health(&self) -> bool {
        let Ok(req) =
            hyper::Request::get(format!("{}/health", self.cfg.base)).body(Full::new(Bytes::new()))
        else {
            return false;
        };
        match self.http.request(req).await {
            Ok(res) => res.status().is_success(),
            Err(_) => false,
        }
    }

    /// 질의 하나 — 준비 전·시한 초과·실패면 `None`(낱말만 쓴다).
    pub async fn query(&self, text: &str) -> Option<Vec<f32>> {
        if !self.is_ready() {
            return None;
        }
        let cut: String = text.trim().chars().take(QUERY_CHARS).collect();
        self.embed(&[cut.as_str()], QUERY_TIMEOUT).await.ok()?.pop()
    }

    /// 색인용 일괄(최대 [`BATCH_SIZE`] 개) — 자르지 않는다. 결과 순서는 입력 순서다.
    pub async fn batch(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.embed(texts, BATCH_TIMEOUT).await
    }

    async fn embed(&self, texts: &[&str], limit: Duration) -> Result<Vec<Vec<f32>>, EmbedError> {
        if texts.is_empty() || texts.len() > BATCH_SIZE || texts.iter().any(|t| t.trim().is_empty())
        {
            return Err(EmbedError::BadInput);
        }
        tokio::time::timeout(limit, self.post(texts))
            .await
            .unwrap_or(Err(EmbedError::Timeout))
    }

    async fn post(&self, texts: &[&str]) -> Result<Vec<Vec<f32>>, EmbedError> {
        let body = json!({ "model": self.cfg.model, "input": texts }).to_string();
        let req = hyper::Request::post(format!("{}/v1/embeddings", self.cfg.base))
            .header("content-type", "application/json")
            .body(Full::new(Bytes::from(body)))
            .map_err(|_| EmbedError::BadInput)?;
        let res = self
            .http
            .request(req)
            .await
            .map_err(|_| EmbedError::Transport)?;
        if !res.status().is_success() {
            return Err(EmbedError::Status(res.status().as_u16()));
        }
        let bytes = Limited::new(res.into_body(), MAX_RESPONSE)
            .collect()
            .await
            .map_err(|_| EmbedError::BadResponse)?
            .to_bytes();
        parse(&bytes, texts.len(), self.cfg.dim).ok_or(EmbedError::BadResponse)
    }
}

/// 응답을 입력 순서(`index`)대로 놓고 길이 1 로 정규화한다. 하나라도 어긋나면 전부 버린다.
fn parse(bytes: &[u8], count: usize, dim: usize) -> Option<Vec<Vec<f32>>> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    let data = v.get("data")?.as_array()?;
    if data.len() != count {
        return None;
    }
    let mut out: Vec<Option<Vec<f32>>> = vec![None; count];
    for row in data {
        let i = usize::try_from(row.get("index")?.as_u64()?).ok()?;
        let vec = row
            .get("embedding")?
            .as_array()?
            .iter()
            .map(|x| x.as_f64().map(|f| f as f32).filter(|f| f.is_finite()))
            .collect::<Option<Vec<f32>>>()?;
        let slot = out.get_mut(i)?;
        if vec.len() != dim || slot.is_some() {
            return None;
        }
        *slot = Some(normalize(vec)?);
    }
    out.into_iter().collect()
}

fn normalize(mut v: Vec<f32>) -> Option<Vec<f32>> {
    let norm = v
        .iter()
        .map(|x| f64::from(*x) * f64::from(*x))
        .sum::<f64>()
        .sqrt();
    if norm < 1e-6 {
        return None;
    }
    for x in &mut v {
        *x = (f64::from(*x) / norm) as f32;
    }
    Some(v)
}

/// 준비 상태를 10초마다 다시 본다. 바뀔 때만 한 줄 적는다(주소는 적지 않는다).
pub fn spawn_health(embedder: Arc<Embedder>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut last = None;
        let mut every = tokio::time::interval(HEALTH_INTERVAL);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            every.tick().await;
            let now = embedder.check_health().await;
            if last != Some(now) {
                eprintln!(
                    "front: embed {}",
                    if now {
                        "ready"
                    } else {
                        "not ready — word search only"
                    }
                );
                last = Some(now);
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn cfg(pairs: &[(&str, &str)]) -> Result<Option<EmbedConfig>, String> {
        EmbedConfig::from_env(|k| {
            pairs
                .iter()
                .find(|(n, _)| *n == k)
                .map(|(_, v)| (*v).to_owned())
        })
    }

    #[test]
    fn config_off_defaults_and_refusals() {
        assert_eq!(cfg(&[]), Ok(None));
        assert_eq!(cfg(&[(URL_ENV, "  ")]), Ok(None));
        assert_eq!(
            cfg(&[(URL_ENV, "http://embed:8080/")]),
            Ok(Some(EmbedConfig {
                base: "http://embed:8080".into(),
                model: DEFAULT_MODEL.into(),
                dim: 1024,
            }))
        );
        for bad in [
            "embed",
            "ftp://embed",
            "http://u:p@embed",
            "http://embed/?k=v",
            "http://embed/#f",
        ] {
            let e = cfg(&[(URL_ENV, bad)]).unwrap_err();
            assert!(!e.contains("u:p"), "{e}");
        }
        for bad in ["0", "2001", "x", "-1"] {
            assert!(cfg(&[(URL_ENV, "http://embed"), (DIM_ENV, bad)]).is_err());
        }
    }

    #[test]
    fn parse_orders_normalizes_and_refuses() {
        let ok = br#"{"data":[{"index":1,"embedding":[0,2]},{"index":0,"embedding":[3,4]}]}"#;
        assert_eq!(
            parse(ok, 2, 2).unwrap(),
            vec![vec![0.6, 0.8], vec![0.0, 1.0]]
        );
        assert!(parse(ok, 1, 2).is_none(), "개수");
        assert!(parse(ok, 2, 3).is_none(), "차원");
        for bad in [
            &br#"{"data":[{"index":0,"embedding":[1,0]},{"index":0,"embedding":[1,0]}]}"#[..],
            br#"{"data":[{"index":0,"embedding":[1,0]},{"index":9,"embedding":[1,0]}]}"#,
            br#"{"data":[{"index":0,"embedding":[1,0]},{"index":1,"embedding":[0,0]}]}"#,
            br#"{"data":[{"index":0,"embedding":[1,0]},{"index":1,"embedding":[1e300,0]}]}"#,
            br#"{"data":[{"index":0,"embedding":[1,0]},{"index":1,"embedding":["1",0]}]}"#,
            b"not json",
        ] {
            assert!(parse(bad, 2, 2).is_none());
        }
    }

    /// 요청 하나마다 `status`·`body` 로 답하는 가짜 서비스. 받은 요청 본문을 돌려준다.
    async fn fake(
        delay: Duration,
        status: &'static str,
        body: &'static str,
    ) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", l.local_addr().unwrap());
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = l.accept().await {
                let tx = tx.clone();
                tokio::spawn(async move {
                    let mut buf = vec![];
                    let mut chunk = [0u8; 4096];
                    loop {
                        let n = s.read(&mut chunk).await.unwrap_or(0);
                        buf.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&buf).into_owned();
                        if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                            let want = head
                                .lines()
                                .find_map(|l| {
                                    l.to_lowercase()
                                        .strip_prefix("content-length: ")?
                                        .parse()
                                        .ok()
                                })
                                .unwrap_or(0usize);
                            if rest.len() >= want {
                                tx.send(rest.to_owned()).ok();
                                break;
                            }
                        }
                        if n == 0 {
                            return;
                        }
                    }
                    tokio::time::sleep(delay).await;
                    let res = format!(
                        "HTTP/1.1 {status}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    s.write_all(res.as_bytes()).await.ok();
                    s.shutdown().await.ok();
                });
            }
        });
        (base, rx)
    }

    fn embedder(base: String) -> Embedder {
        Embedder::new(EmbedConfig {
            base,
            model: DEFAULT_MODEL.into(),
            dim: 2,
        })
    }

    const ONE: &str = r#"{"data":[{"index":0,"embedding":[3,4]}]}"#;

    #[tokio::test]
    async fn query_waits_for_health_and_cuts_to_500_chars() {
        let (base, mut rx) = fake(Duration::ZERO, "200 OK", ONE).await;
        let e = embedder(base);
        assert_eq!(e.query("가").await, None, "준비 전에는 묻지 않는다");
        assert!(rx.try_recv().is_err());
        assert!(e.check_health().await);
        rx.recv().await.unwrap();
        assert_eq!(e.query(&"가".repeat(600)).await, Some(vec![0.6, 0.8]));
        let sent: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
        assert_eq!(sent["model"], DEFAULT_MODEL);
        assert_eq!(sent["input"][0], "가".repeat(QUERY_CHARS));
    }

    #[tokio::test]
    async fn slow_query_gives_up_at_300ms() {
        let (base, _rx) = fake(Duration::from_secs(2), "200 OK", ONE).await;
        let e = embedder(base);
        e.ready.store(true, Ordering::Relaxed);
        let t = std::time::Instant::now();
        assert_eq!(e.query("a").await, None);
        assert!(t.elapsed() < Duration::from_millis(1500));
    }

    #[tokio::test]
    async fn failures_are_errors_not_panics() {
        let (base, _rx) = fake(Duration::ZERO, "503 Busy", "{}").await;
        let e = embedder(base);
        assert!(!e.check_health().await);
        assert_eq!(e.batch(&["a"]).await, Err(EmbedError::Status(503)));
        assert_eq!(e.batch(&[]).await, Err(EmbedError::BadInput));
        assert_eq!(e.batch(&["a"; 17]).await, Err(EmbedError::BadInput));
        assert_eq!(e.batch(&["a", " "]).await, Err(EmbedError::BadInput));
        // 리다이렉트는 따라가지 않는다 — 글이 다른 주소로 나가지 않게.
        let (base, _rx) = fake(
            Duration::ZERO,
            "307 Temporary Redirect\r\nlocation: http://127.0.0.1:1/",
            "",
        )
        .await;
        assert_eq!(
            embedder(base).batch(&["a"]).await,
            Err(EmbedError::Status(307))
        );
        let closed = embedder("http://127.0.0.1:1".into());
        assert!(!closed.check_health().await);
        assert_eq!(closed.batch(&["a"]).await, Err(EmbedError::Transport));
    }
}
