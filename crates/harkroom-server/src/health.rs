//! S5.4 H1 — `GET /healthz`·`GET /readyz`·`GET /metrics` 를 앞단이 답한다(TS `buildServer.ts` 와 같은 경로·꼴·코드·인증).
//!
//! - `/healthz`·`/readyz` 는 인증 **앞**(TS 와 같다 — 배포가 낡았는지는 로그인 전에도 물어야 한다). `routes::OPEN` 참고.
//! - `/healthz` 의 `version`·`commit`·`startedAt` 은 **답하는 프로세스(앞단)** 의 것이다(env `HARKROOM_VERSION`·`HARKROOM_COMMIT`,
//!   TS `version.ts` 와 같은 이름). 앞단 env 에 없으면 TS 가 낸 값을 그대로 싣는다 — 지어내지 않는다.
//!   `avcs`·`push`·`mail` 은 TS 프로세스 안 상태(소켓·푸시 worker·SMTP)라 TS `/healthz` 를 1초 안에 물어 옮겨 싣는다.
//!   TS 가 답하지 않으면 TS 의 기본값(`avcs: { connected: false }`)만 싣고 선택 필드(`push`·`mail`)는 뺀다.
//! - `/metrics` 는 계정 인증(TS `requireAccount`). DB 로 셀 수 있는 게이지만 같은 이름으로 낸다 — 빠진 것은 PR 본문 참고.
//! - `/projection/status` 는 여기 없다: Rust 투영 루프가 쓰는 `projection_status` 줄을 `directory::projection_status` 가 읽는다.
use crate::auth::RequireAccount;
use crate::routes::AppState;
use axum::body::Body;
use axum::extract::State;
use axum::http::{Request, StatusCode, header};
use axum::response::Response;
use http_body_util::BodyExt;
use serde_json::{Map, Value, json};
use std::fmt::Write as _;
use std::sync::LazyLock;
use std::time::Duration;

/// 앞단이 뜬 시각 — `routes::router` 가 기동 때 한 번 건드린다(요청마다 재면 「지금」이 된다).
pub static STARTED_AT: LazyLock<String> = LazyLock::new(now_iso);

fn now_iso() -> String {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64);
    // JS `toISOString()` 꼴(UTC, 밀리초). 날짜 계산은 civil-from-days(Howard Hinnant).
    let (secs, milli) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{milli:03}Z",
        sod / 3600,
        sod % 3600 / 60,
        sod % 60
    )
}

fn env_str(k: &str) -> Option<String> {
    std::env::var(k)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn json_reply(status: StatusCode, v: &Value) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(Body::from(v.to_string()))
        .expect("고정 응답")
}

async fn ts_health(state: &AppState) -> Option<Map<String, Value>> {
    let uri = format!("{}/healthz", state.up.base);
    let req = Request::get(uri).body(Body::empty()).ok()?;
    let res = tokio::time::timeout(Duration::from_secs(1), state.up.client.request(req))
        .await
        .ok()?
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let bytes = res.into_body().collect().await.ok()?.to_bytes();
    match serde_json::from_slice(&bytes).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

/// TS `GET /healthz` — `ServerHealth`.
pub async fn healthz(State(state): State<AppState>) -> Response {
    let ts = ts_health(&state).await.unwrap_or_default();
    let mut out = Map::new();
    out.insert("ok".into(), Value::Bool(true));
    out.insert(
        "avcs".into(),
        ts.get("avcs")
            .cloned()
            .unwrap_or_else(|| json!({ "connected": false })),
    );
    for k in ["push", "mail"] {
        if let Some(v) = ts.get(k) {
            out.insert(k.into(), v.clone());
        }
    }
    for (k, env) in [
        ("version", "HARKROOM_VERSION"),
        ("commit", "HARKROOM_COMMIT"),
    ] {
        let v =
            env_str(env).map_or_else(|| ts.get(k).cloned().unwrap_or(Value::Null), Value::String);
        out.insert(k.into(), v);
    }
    out.insert("startedAt".into(), Value::String(STARTED_AT.clone()));
    json_reply(StatusCode::OK, &Value::Object(out))
}

/// TS `GET /readyz` — `select 1` 이 되면 `{ ok: true }`, 안 되면 TS 오류 처리기와 같은 500.
pub async fn readyz(State(state): State<AppState>) -> Response {
    match sqlx::query("select 1").execute(&state.pool).await {
        Ok(_) => json_reply(StatusCode::OK, &json!({ "ok": true })),
        Err(_) => json_reply(
            StatusCode::INTERNAL_SERVER_ERROR,
            &json!({ "error": { "code": "internal", "message": "internal error" } }),
        ),
    }
}

/// TS `escapeLabel`.
fn escape_label(v: &str) -> String {
    v.replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

fn gauge(out: &mut String, name: &str, help: &str, v: impl std::fmt::Display) {
    let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} gauge\n{name} {v}");
}

fn labeled(out: &mut String, name: &str, help: &str, label: &str, rows: &[(String, i64)]) {
    let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} gauge");
    for (l, v) in rows {
        let _ = writeln!(out, "{name}{{{label}=\"{}\"}} {v}", escape_label(l));
    }
}

/// shared `canonicalAvcsBaseUrl` 의 근사 — http(s) 만, 끝 `/` 를 뗀다.
pub fn canonical_avcs(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw.trim()).ok()?;
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

const OLDEST_UNREAD: &str = "select a.handle, round(extract(epoch from (now() - min(i.created_at))))::bigint \
     from inbox i join account a on a.id = i.account_id \
     join agent_config ac on ac.account_id = a.id \
     join message m on m.id = i.message_id join channel ch on ch.id = m.channel_id \
     where i.read_at is null and a.kind = 'agent' \
       and ((ch.kind = 'standard' and ch.visibility = 'public') \
         or exists (select 1 from channel_member cm_vis where cm_vis.channel_id = ch.id and cm_vis.account_id = i.account_id)) \
     group by a.handle";

/// TS `GET /metrics`(Prometheus 텍스트 0.0.4). 게이지 하나가 실패하면 그 지표만 뺀다(TS 와 같다).
pub async fn metrics(State(state): State<AppState>, _: RequireAccount) -> Response {
    let pool = &state.pool;
    // TS 는 카운터·히스토그램 머리를 늘 먼저 싣는다. 앞단은 아직 요청을 세지 않으므로 머리만(빈 계열).
    let mut out = String::from(
        "# HELP harkroom_http_requests_total total http requests\n# TYPE harkroom_http_requests_total counter\n\
         # HELP harkroom_http_request_duration_seconds request duration\n# TYPE harkroom_http_request_duration_seconds histogram\n",
    );
    let size = pool.size();
    let idle = pool.num_idle() as u32;
    gauge(
        &mut out,
        "harkroom_db_pool_total",
        "db pool clients (in use + idle)",
        size,
    );
    gauge(
        &mut out,
        "harkroom_db_pool_idle",
        "db pool idle clients",
        idle,
    );
    // `avcs_base_url` 은 null 일 수 있다(「앱에서 정한 것이 없다」 → env).
    let app: Result<Option<Option<String>>, _> =
        sqlx::query_scalar("select avcs_base_url from projection_config where id = true")
            .fetch_optional(pool)
            .await;
    if let Ok(app) = app {
        let url = app
            .flatten()
            .as_deref()
            .and_then(canonical_avcs)
            .or_else(|| env_str("AVCS_BASE_URL").as_deref().and_then(canonical_avcs));
        let rows: Result<Vec<(String, i64)>, _> =
            match &url {
                None => Ok(Vec::new()),
                Some(u) => sqlx::query_as(
                    "select repo, last_log_index from projection_cursor where avcs_base_url = $1",
                )
                .bind(u)
                .fetch_all(pool)
                .await,
            };
        if let Ok(rows) = rows {
            labeled(
                &mut out,
                "harkroom_projection_cursor",
                "last projected avcs log index per repo",
                "repo",
                &rows,
            );
        }
    }
    if let Ok(rows) = sqlx::query_as::<_, (String, i64)>(OLDEST_UNREAD)
        .fetch_all(pool)
        .await
    {
        labeled(
            &mut out,
            "harkroom_agent_oldest_unread_seconds",
            "age of the oldest unhandled inbox entry per agent — a dead runner shows up here",
            "handle",
            &rows,
        );
    }
    Response::builder()
        .header(
            header::CONTENT_TYPE,
            "text/plain; version=0.0.4; charset=utf-8",
        )
        .body(Body::from(out))
        .expect("고정 응답")
}
