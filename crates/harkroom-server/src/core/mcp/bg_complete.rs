//! C4b ④-a(2/2) — MCP `bg.complete`(백그라운드 회차 닫기)의 **러너 길**만. 회차의 턴(`bg:<id>` cause)과 일반 턴은 TS 가 답한다.
//!
//! 약속(security 조건 셋):
//! 1. TS `/mcp/admit` 은 `bg.complete` 를 오퍼레이터를 거쳤고 cause·턴 id 헤더가 **아예 없는** 요청에만 받는다. 그 밖은 지금처럼
//!    400 `not_admissible` → Rust 는 확인을 못 했으니 TS 로 넘긴다.
//! 2. 러너 판정은 `bg.claim` 과 같은 [`super::bg_claim::runner`] 다. 러너가 아니면 TS 가 답한다.
//! 3. 닫기는 `account_id = me and status = 'running'` 범위이고, distill 이 `done` 이면 그 회차 입력 스레드의 **그 계정** 메모만
//!    보관한다 — 둘을 한 트랜잭션으로 묶는다. 그 사이 어디서 막혀도 되돌린 뒤 TS 로 넘긴다(TS 가 같은 요청을 다시 돈다).
//!    되돌릴 수 없는 것은 commit 실패뿐이다 — 그때는 `internal`(security W1).
use super::respond::text_result;
use super::tools::err;
use serde_json::Value;

/// `bg.complete` 쓰기 역할의 권한 — 닫는 칸 `UPDATE`, 회차 고르기·남은 회차 확인에 `SELECT`, 메모 보관 두 칸.
/// `thread_note` 의 where 칸(account_id·thread_root_id·archived_at)은 칸 `SELECT` 가 있어야 update 가 돈다.
pub const BG_COMPLETE_PRIVILEGES: &[(&str, &str)] = &[
    ("bg_job", "SELECT"),
    ("bg_job.status", "UPDATE"),
    ("bg_job.summary", "UPDATE"),
    ("bg_job.error", "UPDATE"),
    ("bg_job.tokens", "UPDATE"),
    ("bg_job.duration_ms", "UPDATE"),
    ("bg_job.finished_at", "UPDATE"),
    ("thread_note.account_id", "SELECT"),
    ("thread_note.thread_root_id", "SELECT"),
    ("thread_note.archived_at", "SELECT"),
    ("thread_note.archived_at", "UPDATE"),
    ("thread_note.archived_by_run", "UPDATE"),
];

/// TS `completeBgJob` 의 update — 자리표에 형만 붙였다.
const CLOSE_SQL: &str = "update bg_job set status = $3, summary = $4, error = $5, tokens = $6, duration_ms = $7, finished_at = now()
     where id = $1::uuid and account_id = $2::uuid and status = 'running'
     returning kind, input::text";
/// TS `completeBgJob` 의 메모 보관.
const ARCHIVE_SQL: &str = "update thread_note set archived_at = now(), archived_by_run = $3::uuid
          where account_id = $1::uuid and thread_root_id = any($2::uuid[]) and archived_at is null";
/// TS `completeBgJob` 의 남은 회차 확인.
const EXISTS_SQL: &str = "select 1 from bg_job where id = $1::uuid and account_id = $2::uuid";

/// JS `Number.MAX_SAFE_INTEGER`.
const JS_SAFE_INT: i64 = 9_007_199_254_740_991;

#[derive(Debug, PartialEq)]
pub struct Args {
    pub job_id: String,
    pub status: &'static str,
    pub summary: Option<String>,
    pub error: Option<String>,
    pub tokens: Option<i64>,
    pub duration_ms: Option<i64>,
}

/// zod `{ jobId: uuid, status: enum, summary?: ≤500, error?: ≤200, tokens?: int ≥0, durationMs?: int ≥0 }` 중 Rust 가 **같은 값으로**
/// 읽는 것만. 모르는 키·`null`·실수 꼴·안전 범위 밖·다른 꼴은 `None`(TS 로 — zod 가 받든 거절하든 TS 의 답이 정본이다).
pub fn parse(args: &Value) -> Option<Args> {
    let o = args.as_object()?;
    const KEYS: &[&str] = &[
        "jobId",
        "status",
        "summary",
        "error",
        "tokens",
        "durationMs",
    ];
    if o.keys().any(|k| !KEYS.contains(&k.as_str())) {
        return None;
    }
    let job_id = o
        .get("jobId")?
        .as_str()
        .filter(|s| crate::core::msg_read::is_uuid(s))?
        .to_owned();
    let status = match o.get("status")?.as_str()? {
        "done" => "done",
        "skipped" => "skipped",
        "failed" => "failed",
        _ => return None,
    };
    // 있으면 글자여야 하고(없음은 `None`), UTF-16 길이 상한 안.
    let text = |k: &str, max: usize| -> Option<Option<String>> {
        match o.get(k) {
            None => Some(None),
            Some(v) => {
                let s = v.as_str()?;
                (s.encode_utf16().count() <= max).then(|| Some(s.to_owned()))
            }
        }
    };
    let int = |k: &str| -> Option<Option<i64>> {
        match o.get(k) {
            None => Some(None),
            Some(v) => {
                let n = v.as_i64()?;
                (0..=JS_SAFE_INT).contains(&n).then_some(Some(n))
            }
        }
    };
    Some(Args {
        job_id,
        status,
        summary: text("summary", 500)?,
        error: text("error", 200)?,
        tokens: int("tokens")?,
        duration_ms: int("durationMs")?,
    })
}

/// TS 가 메모를 보관하는 스레드 — `Array.isArray(threadIds) && threadIds.length`. 배열인데 uuid 글자가 아닌 것이 섞이면 TS 는
/// `$2::uuid[]` 에서 던진다 — Rust 는 같은 결과를 낼 수 없으니 `None`(→ 되돌리고 TS 로).
pub fn archive_threads(input: &Value) -> Option<Vec<String>> {
    let Some(a) = input.get("threadIds").and_then(Value::as_array) else {
        return Some(vec![]);
    };
    a.iter()
        .map(|t| {
            t.as_str()
                .filter(|s| crate::core::msg_read::is_uuid(s))
                .map(str::to_owned)
        })
        .collect()
}

/// TS `bg.complete` 의 러너 길 본체. `None` 이면 TS 가 답한다.
pub async fn complete(write: &sqlx::PgPool, me: &str, args: &Value) -> Option<String> {
    let a = parse(args)?;
    let mut tx = write.begin().await.ok()?;
    let row: Option<(String, String)> = sqlx::query_as(CLOSE_SQL)
        .bind(&a.job_id)
        .bind(me)
        .bind(a.status)
        .bind(&a.summary)
        .bind(&a.error)
        .bind(a.tokens)
        .bind(a.duration_ms)
        .fetch_optional(&mut *tx)
        .await
        .ok()?;
    let text = match row {
        Some((kind, input)) => {
            if a.status == "done" && kind == "distill" {
                let input: Value = serde_json::from_str(&input).ok()?;
                let threads = archive_threads(&input)?; // None 이면 tx 가 떨어지며 되돌려진다
                if !threads.is_empty() {
                    sqlx::query(ARCHIVE_SQL)
                        .bind(me)
                        .bind(&threads)
                        .bind(&a.job_id)
                        .execute(&mut *tx)
                        .await
                        .ok()?;
                }
            }
            text_result("{\"ok\":true}")
        }
        None => {
            let exists: Option<i32> = sqlx::query_scalar(EXISTS_SQL)
                .bind(&a.job_id)
                .bind(me)
                .fetch_optional(&mut *tx)
                .await
                .ok()?;
            if exists.is_some() {
                err("not_running", "이미 닫힌 회차다")
            } else {
                err("not_found", "그런 회차가 없다")
            }
        }
    };
    if tx.commit().await.is_err() {
        return Some(err("internal", "the write failed; it was not retried"));
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const J: &str = "0b9c6f2e-1d4a-4c8b-9e2f-3a4b5c6d7e8f";

    #[test]
    fn parse_takes_what_zod_takes_the_same_way() {
        assert_eq!(
            parse(&json!({"jobId": J, "status": "done"})),
            Some(Args {
                job_id: J.into(),
                status: "done",
                summary: None,
                error: None,
                tokens: None,
                duration_ms: None
            })
        );
        let a = parse(
            &json!({"jobId": J.to_uppercase(), "status": "failed", "summary": "가".repeat(500),
            "error": "e", "tokens": 0, "durationMs": JS_SAFE_INT}),
        )
        .unwrap();
        assert_eq!(
            (a.status, a.tokens, a.duration_ms),
            ("failed", Some(0), Some(JS_SAFE_INT))
        );
        // UTF-16 길이 — 이모지 하나는 2 단위.
        assert!(
            parse(&json!({"jobId": J, "status": "done", "summary": "😀".repeat(250)})).is_some()
        );
        assert!(
            parse(
                &json!({"jobId": J, "status": "done", "summary": format!("{}a", "😀".repeat(250))})
            )
            .is_none()
        );
    }

    #[test]
    fn parse_hands_odd_forms_to_ts() {
        for v in [
            json!(null),
            json!({}),
            json!({"jobId": J}),
            json!({"jobId": "x", "status": "done"}),
            json!({"jobId": J, "status": "running"}),
            json!({"jobId": J, "status": "done", "summary": null}),
            json!({"jobId": J, "status": "done", "summary": "a".repeat(501)}),
            json!({"jobId": J, "status": "done", "error": "a".repeat(201)}),
            json!({"jobId": J, "status": "done", "tokens": -1}),
            json!({"jobId": J, "status": "done", "tokens": 1.5}),
            json!({"jobId": J, "status": "done", "tokens": 1.0}),
            json!({"jobId": J, "status": "done", "durationMs": JS_SAFE_INT + 1}),
            json!({"jobId": J, "status": "done", "extra": 1}),
        ] {
            assert_eq!(parse(&v), None, "{v}");
        }
    }

    #[test]
    fn archive_threads_follows_ts_array_check() {
        assert_eq!(archive_threads(&json!({})), Some(vec![]));
        assert_eq!(archive_threads(&json!({"threadIds": "x"})), Some(vec![]));
        assert_eq!(archive_threads(&json!({"threadIds": []})), Some(vec![]));
        assert_eq!(
            archive_threads(&json!({"threadIds": [J]})),
            Some(vec![J.to_owned()])
        );
        assert_eq!(archive_threads(&json!({"threadIds": [J, "nope"]})), None);
        assert_eq!(archive_threads(&json!({"threadIds": [1]})), None);
    }

    #[test]
    fn sql_and_answers_follow_ts_source() {
        let ts = include_str!("../../../../../packages/server/src/services/bgJobs.ts");
        let squash = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        let ts = squash(ts);
        let strip = |s: &str| {
            squash(
                &s.replace("::uuid[]", "@@")
                    .replace("::uuid", "")
                    .replace("::text", "")
                    .replace("@@", "::uuid[]"),
            )
        };
        assert!(ts.contains(&strip(CLOSE_SQL)), "close");
        assert!(ts.contains(&strip(ARCHIVE_SQL)), "archive");
        assert!(ts.contains(&strip(EXISTS_SQL)), "exists");
        assert!(ts.contains("if (c.status === 'done' && row.kind === 'distill' && Array.isArray(row.input.threadIds) && row.input.threadIds.length)"));
        let plugin = squash(include_str!(
            "../../../../../packages/server/src/mcp/mcpPlugin.ts"
        ));
        assert!(plugin.contains("if (r !== 'ok') return jsonResult({ error: { code: r, message: r === 'not_running' ? '이미 닫힌 회차다' : '그런 회차가 없다' } }); return jsonResult({ ok: true });"));
        assert!(plugin.contains("summary: z.string().max(500).optional(), error: z.string().max(200).optional(), tokens: z.number().int().min(0).optional(), durationMs: z.number().int().min(0).optional(),"));
        assert!(
            plugin.contains(
                "jobId: z.string().uuid(), status: z.enum(['done', 'skipped', 'failed']),"
            )
        );
    }
}
