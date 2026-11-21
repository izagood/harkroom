//! S5.4 통합 — MCP `pr.watch`. TS `mcpPlugin.ts` 의 같은 도구와 `services/prWatch.ts::createWatch`(도구 길, `source: manual`)를 옮긴다:
//! 스위치 → 인자 → 채널 멤버·스레드 머리 → 머지 grant(`repoGrantFor('repo.merge', …, { channelId })`) → 위임 → 계정 잠금 안에서
//! 상한(20)·감시 넣기(같은 키면 만료만 늘림)·구독자 넣기(같은 키면 위임만 채움).
//!
//! - 문장은 전부 TS 정본을 골든(`golden/sql_fragments.json` — `repo_grant_for`·`pr_watch_*`)으로 받아 그대로 쓴다. 저장소 키는 TS
//!   `repoScope` 처럼 trim·소문자로 맞춘 뒤 비교·저장한다(대소문자가 달라도 같은 감시·같은 grant).
//! - **TS 로 넘기는 것**(`None` — 아무것도 쓰지 않았다): 스위치(`HARKROOM_DELEGATION_V2`)를 모름 · zod 가 받지 않을 인자 · `number`
//!   가 `integer` 칸 밖 · 커밋 전 DB 오류(거래째 버려짐). 커밋이 실패하면(쓰였는지 모름) `internal` 로 답한다.
//! - 거절 글자는 TS 와 같다: `{ error: { code, message: "pr watch not created: <code>" } }`. `not_granted` 는 TS 처럼 감사 줄
//!   (`pr.status.denied`, `via: pr.watch`)을 남긴다.
use super::tools::{err, opt_uuid, uuid_arg};
use crate::auth::Account;
use serde_json::{Value, json};
use sqlx::{PgPool, Row};
use std::sync::OnceLock;

/// TS `PR_WATCH_TTL_SEC`·`PR_WATCH_OPEN_PER_ACCOUNT`.
pub const PR_WATCH_TTL_SEC: i32 = 6 * 60 * 60;
pub const PR_WATCH_OPEN_PER_ACCOUNT: i32 = 20;

/// 쓰기 풀에 이 권한이 다 있을 때만 Rust 가 답한다(`main.rs`). 판정·상한이 읽는 표의 SELECT 도 본다 — 빠지면 거래 안에서 늘
/// 실패해 TS 로만 넘어가므로 처음부터 켜지 않는다. 운영 GRANT: `grant select, insert on pr_watch, pr_watch_subscriber` ·
/// `grant update (expires_at) on pr_watch` · `grant update (delegation_id) on pr_watch_subscriber`(나머지 SELECT·audit_log INSERT 는
/// 앞 묶음에서 이미 받았다).
pub const PR_WATCH_PRIVILEGES: &[(&str, &str)] = &[
    ("pr_watch", "SELECT"),
    ("pr_watch", "INSERT"),
    ("pr_watch.expires_at", "UPDATE"),
    ("pr_watch_subscriber", "SELECT"),
    ("pr_watch_subscriber", "INSERT"),
    ("pr_watch_subscriber.delegation_id", "UPDATE"),
    ("account_grant", "SELECT"),
    ("agent_config", "SELECT"),
    ("agent_invoker", "SELECT"),
    ("account", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("message", "SELECT"),
    ("team_delegation", "SELECT"),
    ("team_delegation_item", "SELECT"),
    ("audit_log", "INSERT"),
];

struct Sql {
    grant: String,
    member: String,
    delegation: String,
    lock: String,
    count: String,
    insert: String,
    subscribe: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        Sql {
            grant: frag("repo_grant_for"),
            member: frag("pr_watch_member"),
            delegation: frag("pr_watch_delegation"),
            lock: frag("pr_watch_lock"),
            count: frag("pr_watch_count"),
            // 넣은 행의 `expires_at` 을 ms 로 받는다(node-pg 의 `Date` 처럼 μs 는 버린다) — 문장 자체는 정본 그대로.
            insert: format!(
                "with r as ({}) select r.id::text as id, floor(extract(epoch from r.expires_at) * 1000)::bigint as exp_ms, r.created from r",
                frag("pr_watch_insert")
            ),
            subscribe: frag("pr_watch_subscribe"),
        }
    })
}

#[derive(Debug, PartialEq)]
struct Args {
    /// `repoScope` 로 맞춘 `owner/name`(소문자).
    repo: String,
    number: i32,
    head: String,
    until: &'static str,
    channel: String,
    thread: String,
    delegation: Option<String>,
}

/// zod `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$`.
fn repo_ok(s: &str) -> bool {
    let tail = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-');
    let Some((owner, name)) = s.split_once('/') else {
        return false;
    };
    let (ob, nb) = (owner.as_bytes(), name.as_bytes());
    !ob.is_empty()
        && ob.len() <= 100
        && ob[0].is_ascii_alphanumeric()
        && ob[1..].iter().all(|&c| tail(c))
        && (1..=100).contains(&nb.len())
        && nb.iter().all(|&c| tail(c))
}

/// zod 가 받는 모양만. `number` 는 `integer` 칸이라 i32 밖이면 TS 로(TS 는 넣다가 DB 오류로 던진다).
fn parse(args: &Value) -> Option<Args> {
    let o = args.as_object()?;
    let repo = o.get("repo")?.as_str().filter(|s| repo_ok(s))?;
    let number = o
        .get("number")?
        .as_u64()
        .filter(|n| *n > 0 && *n <= i32::MAX as u64)? as i32;
    let head = o
        .get("head")?
        .as_str()
        .filter(|h| h.len() == 40 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')))?;
    let until = match o.get("until")?.as_str()? {
        "checks" => "checks",
        "merged" => "merged",
        _ => return None,
    };
    let channel = uuid_arg(args, "channelId")?;
    let thread = uuid_arg(args, "threadRootId")?;
    let delegation = opt_uuid(args, "delegationId")?;
    Some(Args {
        repo: repo.trim().to_lowercase(),
        number,
        head: head.to_owned(),
        until,
        channel: channel.to_owned(),
        thread: thread.to_owned(),
        delegation,
    })
}

fn denied(code: &str) -> String {
    err(code, &format!("pr watch not created: {code}"))
}

/// TS `orgScopeOf` — `repo:<owner>/*`.
fn scopes(repo: &str) -> (String, String) {
    let scope = format!("repo:{repo}");
    let owner = repo.split_once('/').map_or(repo, |(o, _)| o);
    (scope, format!("repo:{owner}/*"))
}

enum Pre {
    Go,
    Refuse(String),
}

/// 쓰기 전 판정(멤버 → grant → 위임). DB 오류는 `Err` — 호출부가 TS 로 넘긴다.
async fn pre_checks(pool: &PgPool, me: &str, a: &Args) -> Result<Pre, sqlx::Error> {
    let s = sql();
    let member = sqlx::query(s.member.as_str())
        .bind(&a.channel)
        .bind(me)
        .bind(&a.thread)
        .fetch_optional(pool)
        .await?;
    if member.is_none() {
        return Ok(Pre::Refuse(denied("forbidden")));
    }
    let (scope, org) = scopes(&a.repo);
    let grant = sqlx::query(s.grant.as_str())
        .bind(me)
        .bind(vec![scope.clone(), org])
        .bind(&scope)
        .bind(&a.channel)
        .bind("repo.merge")
        .fetch_optional(pool)
        .await?;
    if grant.is_none() {
        crate::write::record_audit(
            pool,
            crate::write::AuditEntry {
                action: "pr.status.denied",
                actor_id: Some(me),
                actor_handle: None,
                target: Some(&scope),
                ip: None,
                detail: json!({ "number": a.number, "code": "not_granted", "via": "pr.watch" }),
            },
        )
        .await;
        return Ok(Pre::Refuse(denied("not_granted")));
    }
    if let Some(d) = &a.delegation {
        let held = sqlx::query(s.delegation.as_str())
            .bind(d)
            .bind(&a.thread)
            .bind(me)
            .fetch_optional(pool)
            .await?;
        if held.is_none() {
            return Ok(Pre::Refuse(denied("delegation_not_found")));
        }
    }
    Ok(Pre::Go)
}

enum Written<'c> {
    /// 커밋만 남았다.
    Ready {
        tx: sqlx::Transaction<'c, sqlx::Postgres>,
        id: String,
        created: bool,
        exp_ms: i64,
    },
    TooMany,
}

/// 계정 잠금 → 상한 → 감시 → 구독자. 커밋은 호출부가 한다 — 그 전 오류는 거래째 버려진다(아무것도 안 쓰임).
async fn write<'c>(
    pool: &'c PgPool,
    me: &str,
    a: &Args,
    source: &str,
) -> Result<Written<'c>, sqlx::Error> {
    let s = sql();
    let mut tx = pool.begin().await?;
    sqlx::query(s.lock.as_str())
        .bind(me)
        .execute(&mut *tx)
        .await?;
    let c = sqlx::query(s.count.as_str())
        .bind(me)
        .bind(&a.repo)
        .bind(a.number)
        .bind(&a.head)
        .bind(a.until)
        .fetch_one(&mut *tx)
        .await?;
    let n: i32 = c.try_get("n")?;
    let already: Option<bool> = c.try_get("already")?;
    if !already.unwrap_or(false) && n >= PR_WATCH_OPEN_PER_ACCOUNT {
        tx.rollback().await?;
        return Ok(Written::TooMany);
    }
    let w = sqlx::query(s.insert.as_str())
        .bind(&a.repo)
        .bind(a.number)
        .bind(&a.head)
        .bind(a.until)
        .bind(PR_WATCH_TTL_SEC)
        .fetch_one(&mut *tx)
        .await?;
    let id: String = w.try_get("id")?;
    let exp_ms: i64 = w.try_get("exp_ms")?;
    let created: bool = w.try_get("created")?;
    sqlx::query(s.subscribe.as_str())
        .bind(&id)
        .bind(me)
        .bind(&a.channel)
        .bind(&a.thread)
        .bind(a.delegation.as_deref())
        .bind(source)
        .execute(&mut *tx)
        .await?;
    Ok(Written::Ready {
        tx,
        id,
        created,
        exp_ms,
    })
}

/// `pr.watch` 하나의 답. `None` 이면 TS 가 답한다.
pub async fn answer(pool: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let v2 = crate::core::msg_post::delegation_v2(crate::env_once::get(
        &crate::env_once::DELEGATION_V2,
    ))?;
    let a = parse(args)?;
    if !v2 {
        return Some(denied("disabled"));
    }
    match pre_checks(pool, &me.id, &a).await.ok()? {
        Pre::Refuse(r) => return Some(r),
        Pre::Go => {}
    }
    match write(pool, &me.id, &a, "manual").await.ok()? {
        Written::TooMany => Some(denied("too_many")),
        Written::Ready {
            tx,
            id,
            created,
            exp_ms,
        } => {
            // 커밋이 실패하면 쓰였는지 모른다 — TS 로 넘기지 않는다(넘기면 두 번 걸 수 있다).
            if tx.commit().await.is_err() {
                return Some(err("internal", "the write failed; it was not retried"));
            }
            Some(super::respond::text_result(&answer_text(
                &id,
                created,
                &crate::core::msg_post::iso_ms(exp_ms),
            )))
        }
    }
}

/// TS `autoWatchOnQueued` — 머지 래퍼가 `queued` 를 보고했을 때 머지한 에이전트 이름으로 그 머지 스레드에 `until: merged` 감시를
/// 건다(`source: merge_queue`). 스위치 판정은 호출부(`merge_checks`)가 한다. TS `createWatch(…, { skipGrant: true })` 처럼 grant 는
/// 다시 보지 않는다(방금 N1 관문이 봤다) — 모양(저장소·head·번호)과 채널 멤버·스레드 머리, 계정 상한만 본다.
/// `Ok(Some(id))` 면 감시를 걸었다, `Ok(None)` 이면 TS 가 `{ ok: false }` 로 아무것도 안 쓰는 갈래(bad_request·forbidden·too_many)다.
/// 오류는 호출부가 삼킨다(TS 의 `.catch(() => null)` — 실패해도 보고는 남는다).
pub async fn auto_watch_on_queued(
    pool: &PgPool,
    agent: &str,
    repo: &str,
    number: i64,
    head: &str,
    channel: &str,
    thread: &str,
) -> Result<Option<String>, sqlx::Error> {
    let repo = repo.trim().to_lowercase();
    let head_ok = head.len() == 40 && head.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'));
    let Ok(number) = i32::try_from(number) else {
        return Ok(None);
    };
    if !repo_ok(&repo) || !head_ok || number <= 0 {
        return Ok(None);
    }
    let a = Args {
        repo,
        number,
        head: head.to_owned(),
        until: "merged",
        channel: channel.to_owned(),
        thread: thread.to_owned(),
        delegation: None,
    };
    let member = sqlx::query(sql().member.as_str())
        .bind(&a.channel)
        .bind(agent)
        .bind(&a.thread)
        .fetch_optional(pool)
        .await?;
    if member.is_none() {
        return Ok(None);
    }
    match write(pool, agent, &a, "merge_queue").await? {
        Written::TooMany => Ok(None),
        Written::Ready { tx, id, .. } => {
            tx.commit().await?;
            Ok(Some(id))
        }
    }
}

/// TS `jsonResult({ watchId, created, expiresAt })` 와 **키 순서까지** 같은 글자. 이 크레이트의 serde_json 은
/// `preserve_order` 가 없어 `json!` 이 키를 가나다순으로 늘어놓는다(대조 시험이 글자로 비교해 갈렸다).
fn answer_text(id: &str, created: bool, expires_at: &str) -> String {
    format!(
        "{{\"watchId\":{},\"created\":{created},\"expiresAt\":{}}}",
        Value::from(id),
        Value::from(expires_at)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answer_keeps_ts_key_order() {
        assert_eq!(
            answer_text("u-1", true, "2026-01-01T00:00:00.000Z"),
            r#"{"watchId":"u-1","created":true,"expiresAt":"2026-01-01T00:00:00.000Z"}"#
        );
    }

    fn ok() -> Value {
        json!({
            "repo": "IzaGood/Harkroom",
            "number": 2353,
            "head": "71c117108b064ac51d6d1c6d20138c21794a367f",
            "until": "checks",
            "channelId": "0b5c2a1e-7d34-4f6a-9e81-3c2d4b5a6f70",
            "threadRootId": "4e8d1f20-9a3b-4c5e-8f12-7a6b5c4d3e21",
        })
    }

    #[test]
    fn parses_like_zod_and_normalises_repo() {
        let a = parse(&ok()).unwrap();
        assert_eq!(a.repo, "izagood/harkroom");
        assert_eq!(a.number, 2353);
        assert_eq!(a.delegation, None);
        let mut d = ok();
        d["delegationId"] = json!("4e8d1f20-9a3b-4c5e-8f12-7a6b5c4d3e21");
        d["extra"] = json!(1);
        assert!(parse(&d).unwrap().delegation.is_some());
    }

    #[test]
    fn hands_bad_shapes_to_ts() {
        for (k, v) in [
            ("repo", json!("-x/y")),
            ("repo", json!("a/b/c")),
            ("number", json!(0)),
            ("number", json!(-1)),
            ("number", json!(1.5)),
            ("number", json!(2_147_483_648u64)),
            ("head", json!("71C117108B064AC51D6D1C6D20138C21794A367F")),
            ("head", json!("71c1171")),
            ("until", json!("closed")),
            ("channelId", json!("nope")),
            ("threadRootId", Value::Null),
            ("delegationId", Value::Null),
        ] {
            let mut a = ok();
            a[k] = v.clone();
            assert!(parse(&a).is_none(), "{k}={v}");
        }
        for k in [
            "repo",
            "number",
            "head",
            "until",
            "channelId",
            "threadRootId",
        ] {
            let mut a = ok();
            a.as_object_mut().unwrap().remove(k);
            assert!(parse(&a).is_none(), "missing {k}");
        }
    }

    #[test]
    fn org_scope_like_ts() {
        assert_eq!(
            scopes("izagood/harkroom"),
            ("repo:izagood/harkroom".into(), "repo:izagood/*".into())
        );
    }

    #[test]
    fn denial_text_matches_ts() {
        let r = denied("too_many");
        assert!(r.contains(r#"\"code\":\"too_many\""#), "{r}");
        assert!(r.contains("pr watch not created: too_many"));
    }

    #[test]
    fn golden_fragments_load() {
        let s = sql();
        assert!(s.grant.contains("capability = $5::text"));
        assert!(s.lock.contains("pg_advisory_xact_lock"));
        assert!(s.insert.starts_with("with r as (insert into pr_watch"));
        assert!(
            s.subscribe
                .contains("on conflict (watch_id, account_id, thread_root_id)")
        );
    }
}
