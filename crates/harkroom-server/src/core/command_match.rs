//! S5.3 C3b B1 — `POST /agent/command-grants/match`. 오퍼레이터 hook 이 도구 호출 하나를 열지 물을 때, 정확한 명령 grant 하나를
//! **쓰고**(`use_count`·`used_at`·`bound_cwd` UPDATE) 감사 `permission.command_used` 를 남긴다. TS `permissionRequestRoutes.ts`
//! (`matchBody`·라우트)와 `matchCommandGrant` 와 같은 상태·헤더·본문·DB 결과를 낸다.
//!
//! 약속:
//! - **fail-closed:** 쓰기 풀에 [`MATCH_PRIVILEGES`] 가 다 있을 때만 라우트를 붙인다(`main.rs`). 없으면 경로가 표에 없어 TS 가 받는다.
//! - 문장은 TS 정본(`READ_LEASE_SQL`·`MATCH_COMMAND_GRANT_SQL`)을 `golden/sql_fragments.json` 에서 읽는다. 판정은 그 문장 안의
//!   `mayDecideSql`(준 사람이 **지금도** 정할 수 있는지)과 `file_digests` 같음(security ②-5 — 승인 때 잰 파일 해시와 지금 잰 것이
//!   같아야 연다)이다. Rust 가 판정을 따로 하지 않는다.
//! - 명령 판정은 TS 골든으로 고정한 `harkroom_proto::tool_rules::validate_exact_command`. 파일 자리 경로 집합이 오퍼레이터가 잰
//!   것과 같아야 하고(크기·겹침·밖의 경로), 해시는 TS `canonicalDigests` 와 같은 꼴(경로 UTF-16 순, `{path, sha256}`)로 비교한다.
//! - 감사는 grant 쓰기와 **같은 tx** 다. TS 는 커밋 뒤 따로 쓰고 실패를 삼키지만, 여기서는 감사가 실패하면 grant 도 쓰지 않는다
//!   (`internal`) — 덜 여는 쪽이다.
//! - 오퍼레이터를 거친 에이전트만(사람·에이전트 PAT 는 403). 403·400 은 DB 를 읽기 전에 낸다. `cache-control: no-store` 는
//!   200(`lease_invalid` 포함)에만 붙는다 — TS 가 zod 뒤에 헤더를 단다.
use super::grant_reads::{ok_no_store, through_operator};
use super::msg_read::is_uuid;
use crate::auth::{Account, Auth, RequireAccount};
use crate::directory::{internal, json_err};
use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use harkroom_proto::tool_rules::{ExactCommandVerdict, validate_exact_command};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::collections::HashSet;
use std::sync::Arc;

const FORBIDDEN: &str = "only an agent through its operator can do this";
const BAD: &str = "leaseId, token and command are required";

/// 쓰기 풀에 있어야 하는 권한 — grant 의 세 칸 UPDATE 와 감사 INSERT. 하나라도 없으면 라우트를 붙이지 않는다(TS 가 받음).
pub const MATCH_PRIVILEGES: &[(&str, &str)] = &[
    ("command_grant.use_count", "UPDATE"),
    ("command_grant.used_at", "UPDATE"),
    ("command_grant.bound_cwd", "UPDATE"),
    ("audit_log", "INSERT"),
];

/// 감사 — TS `recordAudit` 와 같은 칸(actor_handle·ip 는 null).
pub const MATCH_AUDIT: &str = "insert into audit_log (action, actor_id, target, detail) \
     values ('permission.command_used', $1::uuid, $1::text, $2::jsonb)";

fn frag(k: &str) -> &'static str {
    crate::core::channels::frag(k)
}

struct Sql {
    lease: String,
    update: String,
}

fn sql() -> &'static Sql {
    static S: std::sync::OnceLock<Sql> = std::sync::OnceLock::new();
    S.get_or_init(|| Sql {
        lease: format!(
            "select t.\"agentId\"::text, t.\"operatorId\"::text, t.\"channelId\"::text, t.\"threadRootId\"::text, \
             t.expired, t.ended from ({}) t",
            frag("grant_read_lease")
        ),
        // 데이터를 고치는 문장은 from 절·안쪽 CTE 에 못 둔다 — 맨 위 CTE 로 감싼다.
        update: format!(
            "with t as ({}) select t.id::text, t.\"singleUse\" from t",
            frag("grant_match_command")
        ),
    })
}

/// TS `sha256(token)`.
fn sha256_hex(s: &str) -> String {
    hex::encode(Sha256::digest(s.as_bytes()))
}

/// zod `.string().min(a).max(b)` — 길이는 UTF-16 코드 단위.
fn str_len_ok(v: &Value, min: usize, max: usize) -> Option<&str> {
    let s = v.as_str()?;
    let n = s.encode_utf16().count();
    (min..=max).contains(&n).then_some(s)
}

/// 파일 하나 — zod `{ path: string(1..1024), sha256: /^[0-9a-f]{64}$/ }`(모르는 키는 버린다).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDigest {
    pub path: String,
    pub sha256: String,
}

/// zod `matchBody` 를 통과한 본문.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchBody {
    pub lease_id: String,
    pub token: String,
    pub command: String,
    pub tool_use_id: Option<String>,
    pub files: Vec<FileDigest>,
    pub cwd: Option<String>,
}

fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

/// zod `matchBody.safeParse(req.body ?? {})`. 객체가 아니면(없는 본문·문자열·배열 포함) 실패. `optional()` 은 키가 없을 때만이고
/// JSON `null` 은 실패다(zod 와 같다).
pub fn parse_body(body: Option<&Value>) -> Option<MatchBody> {
    let empty = Map::new();
    let o = match body {
        None => &empty,
        Some(v) => v.as_object()?,
    };
    let lease_id = o.get("leaseId")?.as_str()?;
    if !is_uuid(lease_id) {
        return None;
    }
    let token = str_len_ok(o.get("token")?, 1, 200)?;
    let command = str_len_ok(o.get("command")?, 1, 2000)?;
    let tool_use_id = match o.get("toolUseId") {
        None => None,
        Some(v) => Some(str_len_ok(v, 0, 200)?.to_owned()),
    };
    let files = match o.get("files") {
        None => vec![],
        Some(v) => {
            let a = v.as_array()?;
            if a.len() > 16 {
                return None;
            }
            let mut out = Vec::with_capacity(a.len());
            for f in a {
                let f = f.as_object()?;
                let path = str_len_ok(f.get("path")?, 1, 1024)?;
                let sha = f.get("sha256")?.as_str()?;
                if !is_hex64(sha) {
                    return None;
                }
                out.push(FileDigest {
                    path: path.to_owned(),
                    sha256: sha.to_owned(),
                });
            }
            out
        }
    };
    let cwd = match o.get("cwd") {
        None => None,
        Some(v) => Some(str_len_ok(v, 0, 4096)?.to_owned()),
    };
    Some(MatchBody {
        lease_id: lease_id.to_owned(),
        token: token.to_owned(),
        command: command.to_owned(),
        tool_use_id,
        files,
        cwd,
    })
}

/// TS `canonicalDigests` — `{path, sha256}` 만, 경로 순(JS `<` = UTF-16 코드 단위). 정렬이 안정이라 같은 경로는 들어온 순서.
pub fn canonical_digests(files: &[FileDigest]) -> Value {
    let mut v: Vec<&FileDigest> = files.iter().collect();
    v.sort_by(|a, b| a.path.encode_utf16().cmp(b.path.encode_utf16()));
    Value::Array(
        v.into_iter()
            .map(|f| json!({ "path": f.path, "sha256": f.sha256 }))
            .collect(),
    )
}

/// TS: 잰 파일의 경로 집합이 명령이 읽는 경로 집합과 **같은가**(개수·겹침·밖의 경로).
pub fn files_match(want: &[String], measured: &[FileDigest]) -> bool {
    let want: HashSet<&str> = want.iter().map(String::as_str).collect();
    let got: HashSet<&str> = measured.iter().map(|f| f.path.as_str()).collect();
    measured.len() == want.len() && got.len() == want.len() && got.iter().all(|p| want.contains(p))
}

/// TS: `typeof cwd === 'string' && cwd.startsWith('/') ? cwd : null`.
pub fn bound_cwd(cwd: Option<&str>) -> Option<&str> {
    cwd.filter(|c| c.starts_with('/'))
}

/// 라우트 상태: 읽기 풀(임대 읽기)과 [`MATCH_PRIVILEGES`] 를 확인한 쓰기 풀.
pub struct MatchState {
    pub read: PgPool,
    pub write: PgPool,
}

type LeaseRow = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    bool,
);

async fn db_now(pool: &PgPool) -> sqlx::Result<String> {
    sqlx::query_scalar(
        "select to_char(date_trunc('milliseconds', clock_timestamp()) at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')",
    )
    .fetch_one(pool)
    .await
}

/// TS `matchCommandGrant` — `{ allow: true, grantId, singleUse }` 또는 `{ allow: false }`.
async fn match_grant(
    st: &MatchState,
    agent: &str,
    channel: Option<&str>,
    thread: Option<&str>,
    b: &MatchBody,
    now: &str,
) -> sqlx::Result<Value> {
    let ExactCommandVerdict::Ok { command, files, .. } = validate_exact_command(&b.command) else {
        return Ok(json!({ "allow": false }));
    };
    let want: Vec<String> = files.into_iter().map(|f| f.path).collect();
    if !files_match(&want, &b.files) {
        return Ok(json!({ "allow": false }));
    }
    let digests = canonical_digests(&b.files).to_string();
    let cwd = bound_cwd(b.cwd.as_deref());
    let mut tx = st.write.begin().await?;
    let hit: Option<(String, bool)> = sqlx::query_as(sql().update.as_str())
        .bind(agent)
        .bind(channel)
        .bind(thread)
        .bind(&command)
        .bind(now)
        .bind(&digests)
        .bind(cwd)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((grant_id, single_use)) = hit else {
        return Ok(json!({ "allow": false }));
    };
    let detail = json!({
        "grantId": grant_id, "singleUse": single_use, "channelId": channel, "threadRootId": thread,
        "commandSha256": sha256_hex(&command), "toolUseId": b.tool_use_id,
    });
    sqlx::query(MATCH_AUDIT)
        .bind(agent)
        .bind(detail.to_string())
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(json!({ "allow": true, "grantId": grant_id, "singleUse": single_use }))
}

async fn run(st: &MatchState, me: &Account, auth: &Auth, b: &MatchBody) -> sqlx::Result<Value> {
    let operator = auth
        .operator
        .as_ref()
        .map(|o| o.id.as_str())
        .unwrap_or_default();
    let now = db_now(&st.read).await?;
    let lease: Option<LeaseRow> = sqlx::query_as(sql().lease.as_str())
        .bind(&b.lease_id)
        .bind(sha256_hex(&b.token))
        .bind(&now)
        .fetch_optional(&st.read)
        .await?;
    let ok = matches!(&lease, Some((a, o, _, _, expired, ended))
        if *a == me.id && o.as_deref() == Some(operator) && !expired && !ended);
    let (Some((_, _, channel, thread, _, _)), true) = (&lease, ok) else {
        return Ok(json!({ "allow": false, "reason": "lease_invalid" }));
    };
    // 채널·스레드가 빈 임대는 TS 처럼 null 을 그대로 묶는다 — 같음 비교가 어떤 줄에도 맞지 않아 `{ allow: false }` 다.
    match_grant(st, &me.id, channel.as_deref(), thread.as_deref(), b, &now).await
}

/// `POST /agent/command-grants/match`.
pub async fn match_route(
    State(st): State<Arc<MatchState>>,
    RequireAccount(me, auth): RequireAccount,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let parsed = match super::ask::read_bytes(&parts.headers, body).await {
        Ok((_, v)) => v,
        Err(r) => return r,
    };
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    let Some(b) = parse_body(parsed.as_ref()) else {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD);
    };
    match run(&st, &me, &auth, &b).await {
        Ok(v) => ok_no_store(&v),
        Err(e) => internal(e),
    }
}

/// 코어 라우터에 합칠 줄 — `grant_reads.rs` 와 같은 길(인증은 `route_layer`, CORS 는 `layer`).
pub fn routes(
    st: MatchState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<MatchState>>::new()
        .post("/agent/command-grants/match", match_route)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(st)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const L: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn body_like_zod() {
        let ok = json!({ "leaseId": L, "token": "t", "command": "ls", "x": 1 });
        let b = parse_body(Some(&ok)).expect("ok");
        assert_eq!(b.tool_use_id, None);
        assert!(b.files.is_empty());
        assert_eq!(parse_body(None), None);
        assert_eq!(parse_body(Some(&json!([]))), None);
        assert_eq!(parse_body(Some(&json!("s"))), None);
        for bad in [
            json!({ "leaseId": "x", "token": "t", "command": "ls" }),
            json!({ "leaseId": L, "token": "", "command": "ls" }),
            json!({ "leaseId": L, "token": "t", "command": "" }),
            json!({ "leaseId": L, "token": "t", "command": "ls", "toolUseId": null }),
            json!({ "leaseId": L, "token": "t", "command": "ls", "cwd": 1 }),
            json!({ "leaseId": L, "token": "t", "command": "ls", "files": [{ "path": "a", "sha256": "A".repeat(64) }] }),
            json!({ "leaseId": L, "token": "t", "command": "ls", "files": [{ "path": "", "sha256": "a".repeat(64) }] }),
            json!({ "leaseId": L, "token": "t".repeat(201), "command": "ls" }),
        ] {
            assert_eq!(parse_body(Some(&bad)), None, "{bad}");
        }
        let many: Vec<Value> = (0..17)
            .map(|i| json!({ "path": format!("p{i}"), "sha256": "a".repeat(64) }))
            .collect();
        assert_eq!(
            parse_body(Some(
                &json!({ "leaseId": L, "token": "t", "command": "ls", "files": many })
            )),
            None
        );
        // UTF-16 길이: 이모지 100개 = 200 단위(통과), 101개 = 202(실패).
        let e100 = "😀".repeat(100);
        assert!(
            parse_body(Some(
                &json!({ "leaseId": L, "token": e100, "command": "ls" })
            ))
            .is_some()
        );
        let e101 = "😀".repeat(101);
        assert!(
            parse_body(Some(
                &json!({ "leaseId": L, "token": e101, "command": "ls" })
            ))
            .is_none()
        );
    }

    #[test]
    fn digests_and_paths_like_ts() {
        let f = |p: &str| FileDigest {
            path: p.into(),
            sha256: "a".repeat(64),
        };
        assert_eq!(
            canonical_digests(&[f("b"), f("a")]).to_string(),
            json!([{ "path": "a", "sha256": "a".repeat(64) }, { "path": "b", "sha256": "a".repeat(64) }]).to_string()
        );
        let want = vec!["a".to_string(), "b".to_string()];
        assert!(files_match(&want, &[f("b"), f("a")]));
        assert!(!files_match(&want, &[f("a")]));
        assert!(!files_match(&want, &[f("a"), f("a")]));
        assert!(!files_match(&want, &[f("a"), f("c")]));
        assert!(files_match(&[], &[]));
        assert_eq!(bound_cwd(Some("/x")), Some("/x"));
        assert_eq!(bound_cwd(Some("x")), None);
        assert_eq!(bound_cwd(None), None);
    }
}
