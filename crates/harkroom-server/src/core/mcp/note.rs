//! C4b B2-1 — `thread.note`(읽기·덮어쓰기·지우기)를 Rust 가 답한다. TS `mcpPlugin.ts` 의 그 도구와 `services/threadNote.ts`
//! (`threadRootChannel`·`getThreadNote`·`setThreadNote`)를 같은 글자로 옮긴다.
//!
//! - zod 가 거절할 인자(uuid 아님·본문 0자/4000자 넘음·날짜 꼴 아님)는 `None` — TS 가 같은 검증 오류로 답한다.
//! - 쓰기 전 DB 오류는 `None`(TS 가 다시 돈다 — 아직 아무것도 안 썼다). 쓰기 트랜잭션을 연 뒤의 오류는 `internal`(security W1).
//! - 쓰기 검사는 TS `scanWrite(body)` 와 같은 [`crate::core::content_scan::scan_write`]. 걸려도 저장하고 `flag_reason` 에 남긴다.
//! - 백그라운드 회차의 읽기 전용 관문(`bg_note_read_only`)은 TS `/mcp/admit` 이 이미 봤다([`super::route::serve`]).
use super::tools::{err, uuid_arg};
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// TS `MAX_THREAD_NOTE_LENGTH`.
pub const MAX_THREAD_NOTE_LENGTH: usize = 4000;

/// 쓰기 풀에 있어야 하는 권한 — 없으면 `main.rs` 가 이 도구를 TS 에 둔다.
pub const THREAD_NOTE_PRIVILEGES: &[(&str, &str)] = &[
    ("thread_note", "SELECT"),
    ("thread_note", "INSERT"),
    ("thread_note", "UPDATE"),
    ("thread_note", "DELETE"),
];

/// timestamptz → JS `toISOString()` 꼴(밀리초 버림). `thread.note.list`(reads2)와 같은 식.
macro_rules! iso {
    () => {
        "to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')"
    };
}

/// 인자 `body`: 없음 = 읽기, `null` = 지우기, 문자열 = 덮어쓰기.
#[derive(Debug, PartialEq, Eq)]
enum BodyArg<'a> {
    Read,
    Delete,
    Write(&'a str),
}

/// `z.string().min(1).max(4000).nullable().optional()` — 길이는 UTF-16.
fn body_arg(o: &serde_json::Map<String, Value>) -> Option<BodyArg<'_>> {
    match o.get("body") {
        None => Some(BodyArg::Read),
        Some(Value::Null) => Some(BodyArg::Delete),
        Some(Value::String(s)) => {
            let n = s.encode_utf16().count();
            (1..=MAX_THREAD_NOTE_LENGTH)
                .contains(&n)
                .then_some(BodyArg::Write(s))
        }
        Some(_) => None,
    }
}

/// `ifUpdatedAt`: 없음 = 검사 없음(`None`), `null` = 아직 없어야 함(`Some(None)`), 날짜 = 그 판이어야 함.
/// zod 는 통과하나 JS 가 `Invalid Date` 로 읽는 값은 TS 로 넘긴다(바깥 `None`).
#[allow(clippy::option_option)]
fn guard_arg(o: &serde_json::Map<String, Value>) -> Option<Option<Option<String>>> {
    match o.get("ifUpdatedAt") {
        None => Some(None),
        Some(Value::Null) => Some(Some(None)),
        Some(Value::String(s)) => match crate::write::zod_datetime_offset(s) {
            Ok(Some(iso)) => Some(Some(Some(iso))),
            _ => None,
        },
        Some(_) => None,
    }
}

fn json(v: Value) -> String {
    super::respond::text_result(&v.to_string())
}

fn internal() -> String {
    err("internal", "the write failed; it was not retried")
}

/// TS `threadRootChannel` — `Err(code)` 는 `not_found`·`not_root`.
async fn root_channel(
    read: &PgPool,
    root: &str,
) -> Result<Result<String, &'static str>, sqlx::Error> {
    let row: Option<(String, Option<String>)> = sqlx::query_as(
        "select channel_id::text, thread_root_id::text from message where id = $1::uuid and deleted_at is null",
    )
    .bind(root)
    .fetch_optional(read)
    .await?;
    Ok(match row {
        None => Err("not_found"),
        Some((_, Some(_))) => Err("not_root"),
        Some((c, None)) => Ok(c),
    })
}

pub async fn answer(read: &PgPool, write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let root = uuid_arg(args, "threadRootId")?;
    let o = args.as_object()?;
    let body = body_arg(o)?;
    let guard = guard_arg(o)?;
    // 사람 계정에는 실어 줄 러너가 없다(TS 와 같은 첫 거절).
    if me.kind != "agent" {
        return Some(err("agents_only", "스레드 메모는 에이전트만 쓴다"));
    }
    match root_channel(read, root).await.ok()? {
        Err("not_found") => return Some(err("not_found", "그런 글이 없다")),
        Err(_) => {
            return Some(err(
                "not_root",
                "스레드 루트 글의 id 를 줘라(대화 프롬프트 맨 위의 threadRootId)",
            ));
        }
        Ok(channel) => {
            if !crate::core::channels::visible(read, &me.id, &channel)
                .await
                .ok()?
            {
                return Some(err("forbidden", "not a member of this channel"));
            }
        }
    }
    let text = match body {
        BodyArg::Read => return read_note(read, &me.id, root).await,
        BodyArg::Delete => None,
        BodyArg::Write(s) => Some(s),
    };
    let flag = text.and_then(|t| crate::core::content_scan::scan_write(&[Some(t)]));
    // 여기부터 쓰기다(security W1) — 오류가 나도 TS 로 넘기지 않는다.
    Some(
        match set_note(
            write,
            &me.id,
            root,
            text,
            guard,
            flag.as_ref().map(|f| f.reason.as_str()),
        )
        .await
        {
            Ok(Set::Conflict(now)) => conflict(now),
            Ok(Set::Done(at)) => {
                let mut v = serde_json::json!({ "ok": true, "updatedAt": at });
                if let Some(f) = flag {
                    let m = v.as_object_mut().expect("object");
                    m.insert(
                        "flagged".into(),
                        serde_json::json!({ "reason": f.reason, "rules": f.rules }),
                    );
                    m.insert(
                        "notice".into(),
                        Value::from(format!(
                            "저장했지만 쓰기 검사에 걸렸다({}) — 다음 턴에 싣지 않는다. 남의 글을 옮겼거나 비밀 값을 넣었다면 빼고 다시 써라.",
                            f.reason
                        )),
                    );
                }
                json(v)
            }
            Err(_) => internal(),
        },
    )
}

/// TS `getThreadNote` + 답 모양. 보관된 메모는 없는 것으로 본다.
async fn read_note(read: &PgPool, me: &str, root: &str) -> Option<String> {
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(concat!(
        "select body, ",
        iso!(),
        ", flag_reason from thread_note \
          where account_id = $1::uuid and thread_root_id = $2::uuid and archived_at is null"
    ))
    .bind(me)
    .bind(root)
    .fetch_optional(read)
    .await
    .ok()?;
    let Some((body, at, flag)) = row else {
        return Some(json(serde_json::json!({ "note": null })));
    };
    let mut note = serde_json::json!({ "body": body, "updatedAt": at });
    // TS `note.flagReason ? … : {}` — 빈 문자열은 거짓이다.
    if let Some(r) = flag.filter(|r| !r.is_empty()) {
        note.as_object_mut()
            .expect("object")
            .insert("flagged".into(), serde_json::json!({ "reason": r }));
    }
    Some(json(serde_json::json!({ "note": note })))
}

enum Set {
    Done(Option<String>),
    Conflict(Option<String>),
}

/// TS `setThreadNote` — 같은 잠금(`for update`)·같은 비교(밀리초)·같은 문장.
#[allow(clippy::option_option)]
async fn set_note(
    write: &PgPool,
    me: &str,
    root: &str,
    body: Option<&str>,
    guard: Option<Option<String>>,
    flag_reason: Option<&str>,
) -> Result<Set, sqlx::Error> {
    let mut tx = write.begin().await?;
    let cur: Option<(String, bool)> = sqlx::query_as(concat!(
        "select ",
        iso!(),
        ", archived_at is not null from thread_note \
          where account_id = $1::uuid and thread_root_id = $2::uuid for update"
    ))
    .bind(me)
    .bind(root)
    .fetch_optional(&mut *tx)
    .await?;
    // 보관된 메모는 없는 것과 같다.
    let now = cur.and_then(|(at, archived)| (!archived).then_some(at));
    if let Some(want) = guard
        && want != now
    {
        tx.rollback().await?;
        return Ok(Set::Conflict(now));
    }
    let Some(body) = body else {
        sqlx::query(
            "delete from thread_note where account_id = $1::uuid and thread_root_id = $2::uuid",
        )
        .bind(me)
        .bind(root)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(Set::Done(None));
    };
    let at: String = sqlx::query_scalar(concat!(
        "insert into thread_note (account_id, thread_root_id, body, flag_reason) values ($1::uuid, $2::uuid, $3, $4) \
         on conflict (account_id, thread_root_id) do update \
           set body = excluded.body, flag_reason = excluded.flag_reason, archived_at = null, archived_by_run = null, \
               updated_at = greatest(now(), thread_note.updated_at + interval '1 millisecond') \
         returning ",
        iso!()
    ))
    .bind(me)
    .bind(root)
    .bind(body)
    .bind(flag_reason)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Set::Done(Some(at)))
}

fn conflict(now: Option<String>) -> String {
    let message = match &now {
        Some(at) => format!(
            "그 사이 다른 턴이 이 메모를 고쳤다(지금 판 {at}). thread.note 로 다시 읽고 합쳐서 그 updatedAt 으로 써라."
        ),
        None => "그 사이 메모가 지워졌거나 아직 없다. 새로 쓸 거면 ifUpdatedAt: null 로 써라."
            .to_string(),
    };
    json(serde_json::json!({
        "error": { "code": "conflict", "updatedAt": now, "message": message }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn o(v: Value) -> serde_json::Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn body_follows_zod() {
        assert_eq!(body_arg(&o(json!({}))), Some(BodyArg::Read));
        assert_eq!(body_arg(&o(json!({"body": null}))), Some(BodyArg::Delete));
        let m = o(json!({"body": "x"}));
        assert_eq!(body_arg(&m), Some(BodyArg::Write("x")));
        assert_eq!(body_arg(&o(json!({"body": ""}))), None);
        assert_eq!(body_arg(&o(json!({"body": 1}))), None);
        // 4000 은 UTF-16 길이다 — BMP 밖 글자 하나는 둘로 센다.
        let edge = o(json!({ "body": "a".repeat(3998) + "😀" }));
        assert!(matches!(body_arg(&edge), Some(BodyArg::Write(_))));
        assert_eq!(
            body_arg(&o(json!({ "body": "a".repeat(3999) + "😀" }))),
            None
        );
    }

    #[test]
    fn guard_follows_zod() {
        assert_eq!(guard_arg(&o(json!({}))), Some(None));
        assert_eq!(
            guard_arg(&o(json!({"ifUpdatedAt": null}))),
            Some(Some(None))
        );
        assert_eq!(
            guard_arg(&o(
                json!({"ifUpdatedAt": "2026-11-16T02:00:00.123456+09:00"})
            )),
            Some(Some(Some("2026-11-15T17:00:00.123Z".into())))
        );
        assert_eq!(guard_arg(&o(json!({"ifUpdatedAt": "yesterday"}))), None);
        assert_eq!(guard_arg(&o(json!({"ifUpdatedAt": 1}))), None);
    }

    /// 거절 문구·답 모양·문장을 TS 원본과 맞춘다(값은 rustFrontDb 대조 시험이 본다).
    #[test]
    fn texts_follow_ts_source() {
        let mcp = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        for want in [
            "return jsonResult({ error: { code: 'agents_only', message: '스레드 메모는 에이전트만 쓴다' } });",
            "if (root === 'not_found') return jsonResult({ error: { code: 'not_found', message: '그런 글이 없다' } });",
            "return jsonResult({ error: { code: 'not_root', message: '스레드 루트 글의 id 를 줘라(대화 프롬프트 맨 위의 threadRootId)' } });",
            "return jsonResult({ error: { code: 'forbidden', message: 'not a member of this channel' } });",
            "body: z.string().min(1).max(MAX_THREAD_NOTE_LENGTH).nullable().optional(),",
            "ifUpdatedAt: z.string().datetime({ offset: true }).nullable().optional(),",
            "const flag = body === null ? null : scanWrite(body);",
            "? `그 사이 다른 턴이 이 메모를 고쳤다(지금 판 ${now.toISOString()}). thread.note 로 다시 읽고 합쳐서 그 updatedAt 으로 써라.`",
            ": '그 사이 메모가 지워졌거나 아직 없다. 새로 쓸 거면 ifUpdatedAt: null 로 써라.',",
            "notice: `저장했지만 쓰기 검사에 걸렸다(${flag.reason}) — 다음 턴에 싣지 않는다. 남의 글을 옮겼거나 비밀 값을 넣었다면 빼고 다시 써라.`,",
        ] {
            assert!(mcp.contains(want), "{want}");
        }
        let svc = include_str!("../../../../../packages/server/src/services/threadNote.ts");
        for want in [
            "export const MAX_THREAD_NOTE_LENGTH = 4000;",
            "`select channel_id, thread_root_id from message where id = $1 and deleted_at is null`,",
            "`select body, updated_at, flag_reason from thread_note where account_id = $1 and thread_root_id = $2 and archived_at is null`,",
            "`select updated_at, archived_at from thread_note where account_id = $1 and thread_root_id = $2 for update`,",
            "await client.query(`delete from thread_note where account_id = $1 and thread_root_id = $2`, [accountId, threadRootId]);",
            "set body = excluded.body, flag_reason = excluded.flag_reason, archived_at = null, archived_by_run = null,\n             updated_at = greatest(now(), thread_note.updated_at + interval '1 millisecond')",
        ] {
            assert!(svc.contains(want), "{want}");
        }
    }
}
