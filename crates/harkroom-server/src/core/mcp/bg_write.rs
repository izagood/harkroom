//! 백그라운드 회차의 기억 쓰기(`memory.set`·`memory.archive`·`memory.merge`) — 옛 TS `mcpPlugin` 의 회차 감싸기를 옮긴다.
//! 회차 상태(running·같은 계정)와 허용 도구는 [`super::route`] 의 앞부분이 이미 봤다. 여기서는:
//! - core 쓰기·지우기를 거절한다(보관을 쓴다).
//! - 회차당 쓰기 [`MAX_WRITES`] 건을 원자적으로 예약한다. 실패한 쓰기는 예약을 돌려준다.
//! - 바뀐 것을 `bg_job_change` 에 남긴다(에이전트 기억 화면의 기록·「이 회차 되돌리기」의 재료).
use super::mem_body::Origin;
use super::tools::err;
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// TS `BG_MAX_WRITES`.
pub const MAX_WRITES: i32 = 20;

/// 이 몫이 기억 쓰기 권한 위에 더 쓰는 것.
pub const BG_WRITE_PRIVILEGES: &[(&str, &str)] = &[
    ("bg_job", "SELECT"),
    ("bg_job.writes", "UPDATE"),
    ("bg_job_change", "INSERT"),
    ("agent_memory", "SELECT"),
];
pub const BG_WRITE_SEQUENCES: &[(&str, &str)] = &[("bg_job_change_id_seq", "USAGE")];

pub fn is_write(tool: &str) -> bool {
    matches!(tool, "memory.set" | "memory.archive" | "memory.merge")
}

const RESERVE_SQL: &str = "update bg_job set writes = writes + $3 \
     where id = $1::uuid and account_id = $4::uuid and status = 'running' and writes + $3 <= $2";

/// 쓰기 n 건을 한 번에 예약한다 — running 이 아니거나 상한을 넘으면 거짓이고 아무것도 안 센다.
pub async fn reserve(pool: &PgPool, me: &str, job: &str, n: i32) -> Result<bool, sqlx::Error> {
    Ok(sqlx::query(RESERVE_SQL)
        .bind(job)
        .bind(MAX_WRITES)
        .bind(n)
        .bind(me)
        .execute(pool)
        .await?
        .rows_affected()
        > 0)
}

async fn release(pool: &PgPool, job: &str, n: i32) {
    if let Err(e) =
        sqlx::query("update bg_job set writes = greatest(writes - $2, 0) where id = $1::uuid")
            .bind(job)
            .bind(n)
            .execute(pool)
            .await
    {
        eprintln!("bg write: release failed: {e}");
    }
}

async fn exists(pool: &PgPool, me: &str, slug: &str) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "select exists(select 1 from agent_memory where account_id = $1::uuid and slug = $2)",
    )
    .bind(me)
    .bind(slug)
    .fetch_one(pool)
    .await
}

async fn record(
    pool: &PgPool,
    me: &str,
    job: &str,
    slug: &str,
    op: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into bg_job_change (run_id, slug, op, after_updated_at) \
         values ($1::uuid, $2, $3, (select updated_at from agent_memory where account_id = $4::uuid and slug = $2))",
    )
    .bind(job)
    .bind(slug)
    .bind(op)
    .bind(me)
    .execute(pool)
    .await
    .map(|_| ())
}

/// 합치는 from(into·겹친 것 빼고) — 합치기가 아니면 `None`.
fn merge_from<'a>(tool: &str, args: &'a Value, into: &str) -> Option<Vec<&'a str>> {
    if tool != "memory.merge" {
        return None;
    }
    let mut out: Vec<&str> = vec![];
    for f in args
        .get("from")?
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
    {
        if f != into && !out.contains(&f) {
            out.push(f);
        }
    }
    Some(out)
}

/// 쓰기 전에 막는 것 — core·지우기.
fn refused(tool: &str, args: &Value) -> Option<String> {
    let is_core = |v: &Value| v.as_str() == Some("core");
    let core = ["slug", "into"]
        .iter()
        .any(|k| args.get(k).is_some_and(is_core))
        || args
            .get("from")
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(is_core));
    if core {
        return Some(err(
            "bg_core_forbidden",
            "백그라운드 회차는 core 를 쓰지 못한다 — 매 턴 실리는 자리다",
        ));
    }
    if tool == "memory.set" && args.get("value").is_some_and(Value::is_null) {
        return Some(err(
            "bg_delete_forbidden",
            "백그라운드 회차는 기억을 지우지 않는다 — memory.archive 로 보관해라",
        ));
    }
    None
}

/// 도구 답이 거절·오류인가. 모양을 모르면 실패로 본다.
fn failed(result: &str) -> bool {
    serde_json::from_str::<Value>(result)
        .ok()
        .and_then(|v| {
            let t = v.pointer("/content/0/text")?.as_str()?.to_owned();
            serde_json::from_str::<Value>(&t).ok()
        })
        .is_none_or(|v| v.get("error").is_some_and(|e| !e.is_null()))
}

#[allow(clippy::too_many_arguments)]
/// 회차 안 기억 쓰기 하나. `job` 은 cause 헤더의 회차 id(uuid 꼴 확인됨).
pub async fn answer(
    read: &PgPool,
    mem: &PgPool,
    body: &PgPool,
    bg: &PgPool,
    me: &Account,
    job: &str,
    turn: Option<&str>,
    tool: &str,
    args: &Value,
) -> Option<String> {
    if let Some(r) = refused(tool, args) {
        return Some(r);
    }
    let key = if tool == "memory.merge" {
        "into"
    } else {
        "slug"
    };
    let slug = args.get(key)?.as_str()?;
    let kind: String =
        sqlx::query_scalar("select kind from bg_job where id = $1::uuid and account_id = $2::uuid")
            .bind(job)
            .bind(&me.id)
            .fetch_optional(bg)
            .await
            .ok()??;
    let before = exists(bg, &me.id, slug).await.ok()?;
    let from = merge_from(tool, args, slug);
    // 합치기는 into 하나 + 보관하는 from 수. organize 의 이름 바꾸기(없는 into ← from 하나)는 1건이다.
    let cost = match &from {
        Some(f) if kind == "organize" && f.len() == 1 && !before => 1,
        Some(f) => 1 + i32::try_from(f.len()).ok()?,
        None => 1,
    };
    if !reserve(bg, &me.id, job, cost).await.ok()? {
        return Some(err(
            "bg_write_limit",
            &format!(
                "이 회차의 기억 쓰기 상한({MAX_WRITES})에 닿았다 — 남은 것은 다음 회차에 맡기고 끝내라"
            ),
        ));
    }
    let origin = Origin {
        turn,
        run: Some(job),
    };
    let res = if tool == "memory.archive" {
        super::mem_writes::answer(read, Some(mem), me, tool, args).await
    } else {
        super::mem_body::answer(read, Some(body), me, origin, tool, args).await
    }
    .flatten();
    if res.as_deref().is_none_or(failed) {
        release(bg, job, cost).await;
        return res;
    }
    let op = match tool {
        "memory.archive" => "archive",
        "memory.merge" => "merge",
        _ if before => "update",
        _ => "create",
    };
    let mut rec = record(bg, &me.id, job, slug, op).await;
    // 합치기는 from 을 보관한다 — 되돌리기가 그것도 되살리도록 따로 적는다.
    for f in from.unwrap_or_default() {
        rec = rec.and(record(bg, &me.id, job, f, "archive").await);
    }
    if let Err(e) = rec {
        // 쓰기는 이미 됐다 — 기록만 빠졌다.
        eprintln!("bg write: change record failed: {e}");
    }
    res
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn core_and_delete_are_refused() {
        assert!(refused("memory.set", &json!({"slug":"core","value":"x"})).is_some());
        assert!(refused("memory.merge", &json!({"into":"mem/a","from":["core"]})).is_some());
        assert!(refused("memory.merge", &json!({"into":"core","from":["mem/a"]})).is_some());
        assert!(refused("memory.archive", &json!({"slug":"core"})).is_some());
        assert!(refused("memory.set", &json!({"slug":"mem/a","value":null})).is_some());
        assert!(refused("memory.set", &json!({"slug":"mem/a","value":"v"})).is_none());
    }

    #[test]
    fn merge_from_drops_into_and_duplicates() {
        let a = json!({"from":["mem/a","mem/b","mem/a","mem/c"]});
        assert_eq!(
            merge_from("memory.merge", &a, "mem/c"),
            Some(vec!["mem/a", "mem/b"])
        );
        assert_eq!(merge_from("memory.set", &a, "mem/c"), None);
    }

    #[test]
    fn failed_reads_the_tool_text() {
        use super::super::respond::text_result;
        assert!(!failed(&text_result("{\"ok\":true}")));
        assert!(failed(&err("conflict", "x")));
        assert!(failed("nope"));
    }
}
