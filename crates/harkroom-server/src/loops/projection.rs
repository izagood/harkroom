//! avcs 투영 루프(decision 4) — TS `avcs/projection.ts`(`ProjectionWorker`)·`avcs/supervisor.ts`·`avcs/client.ts`(`httpAvcsClient`)·
//! `services/projectionConfig.ts`(`getProjectionConfig`)를 옮긴다.
//!
//! TS 와 다른 두 가지(결정된 설계):
//! - **사이클마다 `projection_config` 를 다시 읽는다.** TS 는 URL 교체를 슈퍼바이저 메모리에만 두었다(저장 → `reconfigure`).
//!   여기서는 캐시가 없다 — 저장한 값이 다음 사이클에 그대로 보인다. 같은 URL 이면 아무것도 다시 시작하지 않는다.
//! - **상태는 `projection_status` 한 줄에 둔다**(175). TS 의 `runtime` 객체와 같은 칸이다. 서버가 바뀌면(줄의 `avcs_base_url` 이
//!   다르면) 새 워커처럼 처음 상태에서 시작한다.
//!
//! 하는 일은 TS 와 같다: 채널에 바인딩된 repo 마다 `events` 로 변경을 기다리고, 바뀌었으면 `sync` → `objects/fetch` 로 로그를 받아
//! `lease` 만 `active_lease` 에 접고 `projection_cursor` 를 전진시킨다. lease 가 바뀌면 `lease.changed` 를 낸다.
//! 문지기 이름 `projection` — `server_loop` 에 줄이 없으면 `rust` 라 돈다(11-21 전에는 `ts` — 꺼짐).
//!
//! HTTP 는 `crate::avcs_http` 클라이언트를 쓴다 — 주소 scheme 으로 `http://`(평문)·`https://`(TLS, 묶인 Mozilla 루트)를 고른다.
use super::{GateResult, Side, run_gated};
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::HashMap;
use std::time::Duration;

/// TS `start(pollMs = 25_000)`.
pub const POLL: Duration = Duration::from_millis(25_000);
/// TS `FETCH_CHUNK`.
pub const FETCH_CHUNK: usize = 256;
/// TS `PROJECTED` — 페치 전에 oid 접두로 거른다.
pub(crate) const PROJECTED: [&str; 7] = [
    "intent",
    "operation",
    "decision",
    "evidence",
    "checkpoint",
    "release",
    "lease",
];

/// 이 루프가 쓰는 권한 — 운영 GRANT 와 같아야 한다. 하나라도 없으면 `main.rs` 가 루프를 띄우지 않는다(TS 에 남는다).
pub const PROJECTION_PRIVILEGES: &[(&str, &str)] = &[
    ("projection_config", "SELECT"),
    ("channel", "SELECT"),
    ("projection_cursor", "SELECT"),
    ("projection_cursor", "INSERT"),
    ("projection_cursor.last_log_index", "UPDATE"),
    ("active_lease", "SELECT"),
    ("active_lease", "INSERT"),
    ("active_lease.expires_at", "UPDATE"),
    ("active_lease", "DELETE"),
    ("projection_status", "SELECT"),
    ("projection_status", "INSERT"),
    ("projection_status.avcs_base_url", "UPDATE"),
    ("projection_status.configured", "UPDATE"),
    ("projection_status.connected", "UPDATE"),
    ("projection_status.repo", "UPDATE"),
    ("projection_status.last_log_index", "UPDATE"),
    ("projection_status.last_polled_at", "UPDATE"),
    ("projection_status.last_advanced_at", "UPDATE"),
    ("projection_status.last_error", "UPDATE"),
    ("projection_status.updated_at", "UPDATE"),
    ("event_outbox", "INSERT"),
];
pub const PROJECTION_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS `ProjectionWorkerStatus`(`ProjectionRuntime` + `connected`) — `projection_status` 한 줄.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Runtime {
    pub configured: bool,
    pub connected: bool,
    pub repo: Option<String>,
    pub last_log_index: i64,
    pub last_polled_at: Option<i64>,
    pub last_advanced_at: Option<i64>,
    pub last_error: Option<String>,
}

impl Runtime {
    /// `/projection/status` 의 원자료 — TS 와 같이 `connected` 는 싣지 않는다(`/healthz` 의 사실).
    pub fn to_json(&self) -> Value {
        json!({
            "configured": self.configured,
            "repo": self.repo,
            "lastLogIndex": self.last_log_index,
            "lastPolledAt": self.last_polled_at,
            "lastAdvancedAt": self.last_advanced_at,
            "lastError": self.last_error,
        })
    }
}

/// shared `canonicalAvcsBaseUrl`.
pub fn canonical_base_url(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw).ok()?;
    if u.scheme() != "http" && u.scheme() != "https" {
        return None;
    }
    let host = u.host_str()?;
    let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some(format!(
        "{}://{host}{port}{}",
        u.scheme(),
        u.path().trim_end_matches('/')
    ))
}

/// shared `resolveProjectionUrl` — 앱(DB)이 이기고, 없으면 env.
pub fn resolve_url(env: Option<&str>, app: Option<&str>) -> Option<String> {
    app.and_then(canonical_base_url)
        .or_else(|| env.and_then(canonical_base_url))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// TS 의 `err.message.slice(0, 200)`.
fn cut(msg: String) -> String {
    msg.chars().take(200).collect()
}

// ---- 상태 줄 ----

pub async fn read_status(pool: &PgPool) -> Result<Option<(Option<String>, Runtime)>, sqlx::Error> {
    type Row = (
        Option<String>,
        bool,
        bool,
        Option<String>,
        i64,
        Option<i64>,
        Option<i64>,
        Option<String>,
    );
    let row: Option<Row> = sqlx::query_as(
        "select avcs_base_url, configured, connected, repo, last_log_index, last_polled_at, last_advanced_at, last_error \
         from projection_status where id = true",
    )
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| {
        (
            r.0,
            Runtime {
                configured: r.1,
                connected: r.2,
                repo: r.3,
                last_log_index: r.4,
                last_polled_at: r.5,
                last_advanced_at: r.6,
                last_error: r.7,
            },
        )
    }))
}

async fn write_status(pool: &PgPool, url: Option<&str>, r: &Runtime) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into projection_status (id, avcs_base_url, configured, connected, repo, last_log_index, last_polled_at, last_advanced_at, last_error, updated_at) \
         values (true, $1, $2, $3, $4, $5, $6, $7, $8, now()) \
         on conflict (id) do update set avcs_base_url = excluded.avcs_base_url, configured = excluded.configured, \
         connected = excluded.connected, repo = excluded.repo, last_log_index = excluded.last_log_index, \
         last_polled_at = excluded.last_polled_at, last_advanced_at = excluded.last_advanced_at, \
         last_error = excluded.last_error, updated_at = excluded.updated_at",
    )
    .bind(url)
    .bind(r.configured)
    .bind(r.connected)
    .bind(&r.repo)
    .bind(r.last_log_index)
    .bind(r.last_polled_at)
    .bind(r.last_advanced_at)
    .bind(&r.last_error)
    .execute(pool)
    .await
    .map(|_| ())
}

// ---- avcs 클라이언트(TS `client.ts`) ----

/// TS `AvcsLogEntry` 중 이 루프가 쓰는 것 — lease 만 접으므로 lease 칸만 둔다.
#[derive(Debug, Clone, PartialEq)]
pub struct LeaseEntry {
    pub actor_key_id: Option<String>,
    pub path: String,
    pub expires_at: String,
    pub released: bool,
}

struct Avcs {
    base: String,
    client: crate::avcs_http::AvcsClient,
}

pub(crate) fn repo_path(repo: &str) -> String {
    repo.split('/')
        .filter(|s| !s.is_empty())
        .map(encode_uri_component)
        .collect::<Vec<_>>()
        .join("/")
}

/// JS `encodeURIComponent` — 남기는 글자가 같아야 같은 경로가 된다.
fn encode_uri_component(seg: &str) -> String {
    let mut out = String::new();
    for b in seg.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

fn type_of_oid(oid: &str) -> &str {
    match oid.find('_') {
        Some(i) if i > 0 => &oid[..i],
        _ => "",
    }
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn actor_id(v: &Value) -> Option<String> {
    let id = s(v.get("id")?);
    (!id.is_empty()).then(|| id.to_owned())
}

/// TS `toEntries` 의 `lease` 갈래 — 스코프마다 하나. 다른 타입은 엔트리는 되지만 아무것도 남기지 않으므로 빈 배열로 접는다.
pub fn lease_entries(obj: &Value) -> Vec<LeaseEntry> {
    if s(&obj["type"]) != "lease" {
        return vec![];
    }
    let expires_at = s(&obj["expiresAt"]).to_owned();
    let released = !s(&obj["releasedAt"]).is_empty();
    let actor = actor_id(&obj["actor"]);
    obj["writeScopes"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|path| LeaseEntry {
                    actor_key_id: actor.clone(),
                    path: path.to_owned(),
                    expires_at: expires_at.clone(),
                    released,
                })
                .collect()
        })
        .unwrap_or_default()
}

impl Avcs {
    fn new(base_url: &str) -> Self {
        Self {
            base: base_url.trim_end_matches('/').to_owned(),
            client: crate::avcs_http::client(),
        }
    }

    async fn call(
        &self,
        method: hyper::Method,
        url: String,
        body: Option<Value>,
        timeout: Duration,
        what: &str,
    ) -> Result<Value, String> {
        let mut req = hyper::Request::builder().method(method).uri(url);
        let payload = match body {
            Some(b) => {
                req = req.header("content-type", "application/json");
                Bytes::from(b.to_string())
            }
            None => Bytes::new(),
        };
        let req = req.body(Full::new(payload)).map_err(|e| e.to_string())?;
        let work = async {
            let res = self.client.request(req).await.map_err(|e| e.to_string())?;
            let status = res.status();
            if !status.is_success() {
                return Err(format!("avcs {what} failed: {}", status.as_u16()));
            }
            let bytes = res
                .into_body()
                .collect()
                .await
                .map_err(|e| e.to_string())?
                .to_bytes();
            serde_json::from_slice::<Value>(&bytes).map_err(|e| e.to_string())
        };
        tokio::time::timeout(timeout, work)
            .await
            .map_err(|_| "The operation was aborted due to timeout".to_owned())?
    }

    async fn wait_for_change(
        &self,
        repo: &str,
        since: i64,
        timeout: Duration,
    ) -> Result<bool, String> {
        let ms = timeout.as_millis();
        let url = format!(
            "{}/{}/events?since={since}&timeoutMs={ms}",
            self.base,
            repo_path(repo)
        );
        let body = self
            .call(
                hyper::Method::GET,
                url,
                None,
                timeout + Duration::from_secs(10),
                "events",
            )
            .await?;
        // 서버는 타임아웃에도 200 + 빈 oids로 답한다. 변경 신호는 상태코드가 아니라 oids다.
        Ok(body["oids"].as_array().is_some_and(|a| !a.is_empty()))
    }

    async fn fetch_objects(
        &self,
        repo: &str,
        oids: &[String],
    ) -> Result<HashMap<String, Value>, String> {
        let mut out = HashMap::new();
        for chunk in oids.chunks(FETCH_CHUNK) {
            let url = format!("{}/{}/objects/fetch", self.base, repo_path(repo));
            let body = self
                .call(
                    hyper::Method::POST,
                    url,
                    Some(json!({ "oids": chunk })),
                    Duration::from_secs(30),
                    "objects/fetch",
                )
                .await?;
            for o in body["objects"].as_array().into_iter().flatten() {
                if let Some(oid) = o["oid"].as_str() {
                    out.insert(oid.to_owned(), o.clone());
                }
            }
            // 바이트 한도로 잘렸다면 그 구멍 뒤로는 커서가 못 간다.
            if body["truncated"].as_bool() == Some(true) {
                break;
            }
        }
        Ok(out)
    }

    /// TS `fetchSince` — lease 엔트리와 다음 커서. 엔트리 수(투영 대상 객체 수)도 함께 준다.
    /// decision·evidence 의 intent 되짚기는 메시지 투영용이라 lease 만 접는 지금은 하지 않는다.
    async fn fetch_since(
        &self,
        repo: &str,
        since: i64,
    ) -> Result<(Vec<LeaseEntry>, usize, i64), String> {
        let url = format!("{}/{}/sync?since={since}", self.base, repo_path(repo));
        let body = self
            .call(
                hyper::Method::GET,
                url,
                None,
                Duration::from_secs(30),
                "sync",
            )
            .await?;
        let cursor = body["cursor"].as_i64().unwrap_or(0);
        let oids: Vec<&str> = body["oids"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        // logIndex는 필터 전 objlog 위치다.
        let wanted: Vec<(String, i64)> = oids
            .iter()
            .enumerate()
            .map(|(i, o)| ((*o).to_owned(), since + i as i64 + 1))
            .filter(|(o, _)| PROJECTED.contains(&type_of_oid(o)))
            .collect();
        if wanted.is_empty() {
            return Ok((vec![], 0, cursor));
        }
        let want_oids: Vec<String> = wanted.iter().map(|(o, _)| o.clone()).collect();
        let objects = self.fetch_objects(repo, &want_oids).await?;
        let mut entries = vec![];
        let mut count = 0usize;
        let mut next = cursor;
        for (oid, log_index) in &wanted {
            let Some(obj) = objects.get(oid) else {
                // 배치가 실어오지 못한 객체 — 커서를 이 앞에 세워 다음 폴에서 다시 받는다.
                next = next.min(log_index - 1);
                break;
            };
            let leases = lease_entries(obj);
            count += if s(&obj["type"]) == "lease" {
                leases.len()
            } else {
                1
            };
            entries.extend(leases);
        }
        Ok((entries, count, next))
    }
}

// ---- 워커(TS `projection.ts`) ----

async fn cursor_of(pool: &PgPool, repo: &str, base: &str) -> Result<i64, sqlx::Error> {
    let v: Option<i64> = sqlx::query_scalar(
        "select last_log_index from projection_cursor where repo = $1 and avcs_base_url = $2",
    )
    .bind(repo)
    .bind(base)
    .fetch_optional(pool)
    .await?;
    Ok(v.unwrap_or(0))
}

/// TS `runOnce` — 읽은 엔트리 수.
async fn run_once(
    pool: &PgPool,
    avcs: &Avcs,
    rt: &mut Runtime,
    repo: &str,
) -> Result<usize, String> {
    let base = avcs.base.as_str();
    // 아웃바운드 HTTP는 트랜잭션 밖에서 수행한다.
    let since = cursor_of(pool, repo, base)
        .await
        .map_err(|e| e.to_string())?;
    let (entries, count, next) = avcs.fetch_since(repo, since).await?;
    // 투영할 게 없어도 커서는 전진해야 한다. next === since면 진짜 새 게 없다.
    if count == 0 && next <= since {
        return Ok(0);
    }
    let r: Result<Option<bool>, sqlx::Error> = async {
        let mut tx = pool.begin().await?;
        let current: Option<i64> = sqlx::query_scalar(
            "select last_log_index from projection_cursor where repo = $1 and avcs_base_url = $2 for update",
        )
        .bind(repo)
        .bind(base)
        .fetch_optional(&mut *tx)
        .await?;
        if current.unwrap_or(0) != since {
            // 다른 실행이 이미 커서를 전진시켰다 — 이번 배치는 폐기한다.
            tx.rollback().await?;
            return Ok(None);
        }
        let mut lease_changed = false;
        // `lease` 만 접는다 — 나머지 타입은 의도적으로 지나친다.
        for e in &entries {
            let actor = e.actor_key_id.as_deref().unwrap_or("");
            if e.released {
                sqlx::query("delete from active_lease where repo = $1 and avcs_base_url = $2 and path = $3 and actor_key_id = $4")
                    .bind(repo).bind(base).bind(&e.path).bind(actor)
                    .execute(&mut *tx).await?;
            } else {
                sqlx::query(
                    "insert into active_lease (repo, avcs_base_url, path, actor_key_id, expires_at) \
                     values ($1, $2, $3, $4, $5::timestamptz) \
                     on conflict (repo, avcs_base_url, path, actor_key_id) do update set expires_at = excluded.expires_at",
                )
                .bind(repo).bind(base).bind(&e.path).bind(actor).bind(&e.expires_at)
                .execute(&mut *tx).await?;
            }
            lease_changed = true;
        }
        sqlx::query(
            "insert into projection_cursor (repo, avcs_base_url, last_log_index) values ($1, $2, $3) \
             on conflict (repo, avcs_base_url) do update set last_log_index = excluded.last_log_index",
        )
        .bind(repo)
        .bind(base)
        .bind(next)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(Some(lease_changed))
    }
    .await;
    let Some(lease_changed) = r.map_err(|e| e.to_string())? else {
        return Ok(0);
    };
    // 커서가 전진했다 — 살아 있음의 신호가 아니라 기록이다.
    rt.last_advanced_at = Some(now_ms());
    rt.last_log_index = next;
    if lease_changed {
        let ev = json!({ "type": "lease.changed", "repo": repo });
        let sent = async {
            let mut conn = pool.acquire().await?;
            crate::write::emit_event(&mut conn, &ev).await
        }
        .await;
        if let Err(e) = sent {
            eprintln!("loop projection: lease.changed emit failed: {e}");
        }
    }
    Ok(count)
}

/// 사이클 하나(TS `start` 의 while 몸통 한 번 + 슈퍼바이저의 URL 판정). 실패가 있었는가를 돌려준다.
pub async fn cycle(pool: &PgPool, env_url: Option<&str>) -> Result<bool, sqlx::Error> {
    let app: Option<String> =
        sqlx::query_scalar("select avcs_base_url from projection_config where id = true")
            .fetch_optional(pool)
            .await?
            .flatten();
    let Some(url) = resolve_url(env_url, app.as_deref()) else {
        // 워커가 없을 때의 상태 — TS `DISABLED_PROJECTION_STATUS`.
        write_status(pool, None, &Runtime::default()).await?;
        tokio::time::sleep(POLL).await;
        return Ok(false);
    };
    // 같은 서버면 이어서, 다르면 새 워커처럼 처음부터(TS `swap`).
    let mut rt = match read_status(pool).await? {
        Some((Some(prev), r)) if prev == url => r,
        _ => Runtime::default(),
    };
    rt.configured = true;
    let avcs = Avcs::new(&url);

    let mut had_failure = false;
    let mut last_repo_error: Option<String> = None;
    // 사이클마다 한 번, repo 목록을 보기 전에 찍는다(#267).
    rt.last_polled_at = Some(now_ms());
    write_status(pool, Some(&url), &rt).await?;
    let bound: Result<Vec<String>, sqlx::Error> =
        sqlx::query_scalar("select repo from channel where repo is not null and kind = 'standard'")
            .fetch_all(pool)
            .await;
    match bound {
        Ok(bound) => {
            for repo in &bound {
                rt.repo = Some(repo.clone());
                let r: Result<(), String> = async {
                    let since = cursor_of(pool, repo, &url)
                        .await
                        .map_err(|e| e.to_string())?;
                    let changed = avcs.wait_for_change(repo, since, POLL).await?;
                    rt.connected = true;
                    if changed {
                        run_once(pool, &avcs, &mut rt, repo).await?;
                    }
                    Ok(())
                }
                .await;
                if let Err(e) = r {
                    rt.connected = false;
                    had_failure = true;
                    last_repo_error = Some(cut(e));
                }
            }
            if bound.is_empty() {
                tokio::time::sleep(POLL).await;
            }
        }
        Err(e) => {
            // listBoundRepos 자체 실패 — 사이클 전체 실패.
            rt.connected = false;
            had_failure = true;
            last_repo_error = Some(cut(e.to_string()));
        }
    }
    // 사이클이 끝날 때 lastError 를 덮어쓴다 — 실패면 메시지, 성공이면 null.
    rt.last_error = last_repo_error;
    write_status(pool, Some(&url), &rt).await?;
    Ok(had_failure)
}

/// 루프를 띄운다. 주인이 `rust` 일 때만 실제로 돈다(기본 꺼짐). `gate` 는 문지기 연결 전용 풀, `pool` 은 작업 풀이다.
pub fn spawn(gate: PgPool, pool: PgPool) -> tokio::task::JoinHandle<()> {
    let env_url = std::env::var("AVCS_BASE_URL")
        .ok()
        .filter(|v| !v.is_empty());
    tokio::spawn(async move {
        let mut backoff = Duration::from_secs(1);
        loop {
            let (p, env) = (&pool, env_url.as_deref());
            let mut failed = false;
            let f = &mut failed;
            match run_gated(&gate, "projection", Side::Rust, || async move {
                *f = cycle(p, env).await?;
                Ok::<(), sqlx::Error>(())
            })
            .await
            {
                GateResult::Ran => {}
                GateResult::Gate(e) => {
                    eprintln!("loop projection: gate failed: {e}");
                    failed = true;
                }
                GateResult::Sweep(e) => {
                    eprintln!("loop projection: sweep failed: {e}");
                    failed = true;
                }
                // 주인이 아니거나 잠금을 못 잡았다 — 한 주기 쉬고 다시 본다.
                GateResult::Locked | GateResult::NotOwner => tokio::time::sleep(POLL).await,
            }
            if failed {
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(60));
            } else {
                backoff = Duration::from_secs(1);
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_matches_shared() {
        assert_eq!(
            canonical_base_url("http://a:8080/x//").as_deref(),
            Some("http://a:8080/x")
        );
        assert_eq!(
            canonical_base_url("https://a/").as_deref(),
            Some("https://a")
        );
        assert_eq!(canonical_base_url("ftp://a"), None);
        assert_eq!(
            resolve_url(Some("http://e"), Some("http://a")).as_deref(),
            Some("http://a")
        );
        assert_eq!(
            resolve_url(Some("http://e"), None).as_deref(),
            Some("http://e")
        );
    }

    #[test]
    fn lease_scopes_and_paths() {
        let o = json!({"type":"lease","expiresAt":"2026-01-01T00:00:00Z","actor":{"id":"k"},"writeScopes":["a","b"]});
        let e = lease_entries(&o);
        assert_eq!(e.len(), 2);
        assert!(!e[0].released);
        assert_eq!(e[1].actor_key_id.as_deref(), Some("k"));
        assert_eq!(repo_path("org/re po"), "org/re%20po");
        assert_eq!(type_of_oid("lease_abc"), "lease");
    }
}
