//! C4b B2-1 — `thread.note`(읽기·덮어쓰기·지우기)를 Rust 가 답한다. TS `mcpPlugin.ts` 의 그 도구와 `services/threadNote.ts`
//! (`threadRootChannel`·`getThreadNote`·`setThreadNote`)를 같은 글자로 옮긴다.
//!
//! - zod 가 거절할 인자(uuid 아님·본문 0자/4000자 넘음·날짜 꼴 아님)도 Rust 가 답한다 — SDK(1.30, zod 3.25)가 핸들러 앞에서 내는
//!   도구 오류 `MCP error -32602: Input validation error: Invalid arguments for tool thread.note: …`(`isError: true`)와 같은 글자.
//!   인자 자체가 객체가 아니면(없음·`null`·배열 — SDK 의 요청 꼴 검사에 먼저 걸린다) 지금처럼 `None`(TS).
//! - 쓰기 전 DB 오류(루트·채널·읽기)는 [`super::db_retry`] 와 같은 간격으로 다시 돌고, 끝내 안 되면 TS 로 넘기지 않고
//!   `temporarily_unavailable`(TS 가 꺼졌을 때 앞단이 내는 답과 같은 꼴). 쓰기 트랜잭션을 연 뒤의 오류는 `internal`(security W1).
//! - 쓰기 검사는 TS `scanWrite(body)` 와 같은 [`crate::core::content_scan::scan_write`]. 걸려도 저장하고 `flag_reason` 에 남긴다.
//! - 백그라운드 회차의 읽기 전용 관문(`bg_note_read_only`)은 TS `/mcp/admit` 이 이미 봤다([`super::route::serve`]).
use super::tools::err;
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

/// zod v3 `getParsedType` 의 이름 — JSON 이 낼 수 있는 값만(`undefined`·`nan` 은 오지 않는다).
fn zod_type(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn expected_string(v: &Value) -> String {
    format!("Expected string, received {}", zod_type(v))
}

/// `z.string().uuid()` — `Err` 는 zod 문구.
fn root_arg(o: &serde_json::Map<String, Value>) -> Result<&str, String> {
    match o.get("threadRootId") {
        None => Err("Required".into()),
        Some(Value::String(s)) if crate::core::channels::is_uuid(s) => Ok(s),
        Some(Value::String(_)) => Err("Invalid uuid".into()),
        Some(v) => Err(expected_string(v)),
    }
}

/// `z.string().min(1).max(4000).nullable().optional()` — 길이는 UTF-16. `Err` 는 zod 문구.
fn body_arg(o: &serde_json::Map<String, Value>) -> Result<BodyArg<'_>, String> {
    match o.get("body") {
        None => Ok(BodyArg::Read),
        Some(Value::Null) => Ok(BodyArg::Delete),
        Some(Value::String(s)) => match s.encode_utf16().count() {
            0 => Err("String must contain at least 1 character(s)".into()),
            n if n > MAX_THREAD_NOTE_LENGTH => Err(format!(
                "String must contain at most {MAX_THREAD_NOTE_LENGTH} character(s)"
            )),
            _ => Ok(BodyArg::Write(s)),
        },
        Some(v) => Err(expected_string(v)),
    }
}

/// `ifUpdatedAt` 이 고르는 판 검사.
#[derive(Debug, PartialEq, Eq)]
enum Guard {
    /// 없음 — 검사하지 않는다.
    Any,
    /// `null` = 아직 없어야 함, 날짜 = 그 판이어야 함.
    Expect(Option<String>),
    /// zod 는 통과하나 JS 가 `Invalid Date`(또는 ISO 로 못 적는 해)로 읽는 값 — TS 의 `getTime()` 비교는 늘 다르다 → 늘 `conflict`.
    Never,
}

/// `z.string().datetime({ offset: true }).nullable().optional()` — `Err` 는 zod 문구.
fn guard_arg(o: &serde_json::Map<String, Value>) -> Result<Guard, String> {
    match o.get("ifUpdatedAt") {
        None => Ok(Guard::Any),
        Some(Value::Null) => Ok(Guard::Expect(None)),
        Some(Value::String(s)) => match crate::write::zod_datetime_offset(s) {
            Ok(Some(iso)) => Ok(Guard::Expect(Some(iso))),
            Ok(None) => Ok(Guard::Never),
            Err(()) => Err("Invalid datetime".into()),
        },
        Some(v) => Err(expected_string(v)),
    }
}

/// SDK `validateToolInput` 의 거절 — `McpError(InvalidParams)` 를 `createToolError` 로 싼 결과. 이슈는 스키마 키 순서, 한 줄에 하나
/// (`<문구> at <키>`).
fn invalid(issues: &[(&str, String)]) -> String {
    let lines: Vec<String> = issues.iter().map(|(k, m)| format!("{m} at {k}")).collect();
    let text = format!(
        "MCP error -32602: Input validation error: Invalid arguments for tool thread.note: {}",
        lines.join("\n")
    );
    format!(
        "{{\"content\":[{{\"type\":\"text\",\"text\":{}}}],\"isError\":true}}",
        Value::String(text)
    )
}

/// 인자 셋. `Err(None)` = 객체가 아님(TS), `Err(Some(답))` = zod 거절.
fn parse(args: &Value) -> Result<(&str, BodyArg<'_>, Guard), Option<String>> {
    let o = args.as_object().ok_or(None)?;
    let (root, body, guard) = (root_arg(o), body_arg(o), guard_arg(o));
    let mut issues = Vec::new();
    if let Err(m) = &root {
        issues.push(("threadRootId", m.clone()));
    }
    if let Err(m) = &body {
        issues.push(("body", m.clone()));
    }
    if let Err(m) = &guard {
        issues.push(("ifUpdatedAt", m.clone()));
    }
    match (root, body, guard) {
        (Ok(r), Ok(b), Ok(g)) => Ok((r, b, g)),
        _ => Err(Some(invalid(&issues))),
    }
}

fn json(v: Value) -> String {
    super::respond::text_result(&v.to_string())
}

/// 키 순서를 TS 객체 리터럴 그대로 둔 JSON 객체 글자 — `serde_json::Map` 은 키를 abc 순으로 늘어놓는다.
fn obj(pairs: &[(&str, String)]) -> String {
    let body: Vec<String> = pairs
        .iter()
        .map(|(k, v)| format!("{}:{v}", Value::from(*k)))
        .collect();
    format!("{{{}}}", body.join(","))
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
    // SDK 는 핸들러 앞에서 인자를 검사한다 — 사람 계정 거절보다 먼저.
    let (root, body, guard) = match parse(args) {
        Ok(p) => p,
        Err(reply) => return reply,
    };
    // 사람 계정에는 실어 줄 러너가 없다(TS 와 같은 첫 거절).
    if me.kind != "agent" {
        return Some(err("agents_only", "스레드 메모는 에이전트만 쓴다"));
    }
    // 쓰기 전 DB 오류만 `Err` 로 온다(아직 아무것도 안 썼다) — 다시 돈다. TS 로는 넘기지 않는다.
    for n in 0..super::db_retry::ATTEMPTS {
        if let Ok(r) = attempt(read, write, me, root, &body, &guard).await {
            return Some(r);
        }
        if let Some(ms) = super::db_retry::GAPS_MS.get(n) {
            tokio::time::sleep(std::time::Duration::from_millis(*ms)).await;
        }
    }
    Some(super::db_retry::unavailable("thread.note"))
}

/// 한 번 답해 본다. `Err` 는 쓰기 트랜잭션을 열기 전의 DB 오류뿐이다.
async fn attempt(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    root: &str,
    body: &BodyArg<'_>,
    guard: &Guard,
) -> Result<String, sqlx::Error> {
    match root_channel(read, root).await? {
        Err("not_found") => return Ok(err("not_found", "그런 글이 없다")),
        Err(_) => {
            return Ok(err(
                "not_root",
                "스레드 루트 글의 id 를 줘라(대화 프롬프트 맨 위의 threadRootId)",
            ));
        }
        Ok(channel) => {
            if !crate::core::channels::visible(read, &me.id, &channel).await? {
                return Ok(err("forbidden", "not a member of this channel"));
            }
        }
    }
    let text = match body {
        BodyArg::Read => return read_note(read, &me.id, root).await,
        BodyArg::Delete => None,
        BodyArg::Write(s) => Some(*s),
    };
    let flag = text.and_then(|t| crate::core::content_scan::scan_write(&[Some(t)]));
    // 여기부터 쓰기다(security W1) — 오류가 나도 다시 돌거나 TS 로 넘기지 않는다.
    Ok(
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
                // TS `{ ok, updatedAt, ...(flag ? { flagged: { reason, rules }, notice } : {}) }` — 그 키 순서.
                let mut pairs = vec![
                    ("ok", "true".to_string()),
                    ("updatedAt", Value::from(at).to_string()),
                ];
                if let Some(f) = flag {
                    pairs.push((
                        "flagged",
                        obj(&[
                            ("reason", Value::from(f.reason.as_str()).to_string()),
                            ("rules", serde_json::json!(f.rules).to_string()),
                        ]),
                    ));
                    pairs.push((
                        "notice",
                        Value::from(format!(
                            "저장했지만 쓰기 검사에 걸렸다({}) — 다음 턴에 싣지 않는다. 남의 글을 옮겼거나 비밀 값을 넣었다면 빼고 다시 써라.",
                            f.reason
                        ))
                        .to_string(),
                    ));
                }
                super::respond::text_result(&obj(&pairs))
            }
            Err(_) => internal(),
        },
    )
}

/// TS `getThreadNote` + 답 모양. 보관된 메모는 없는 것으로 본다.
async fn read_note(read: &PgPool, me: &str, root: &str) -> Result<String, sqlx::Error> {
    let row: Option<(String, String, Option<String>)> = sqlx::query_as(concat!(
        "select body, ",
        iso!(),
        ", flag_reason from thread_note \
          where account_id = $1::uuid and thread_root_id = $2::uuid and archived_at is null"
    ))
    .bind(me)
    .bind(root)
    .fetch_optional(read)
    .await?;
    let Some((body, at, flag)) = row else {
        return Ok(json(serde_json::json!({ "note": null })));
    };
    // TS `{ body, updatedAt, ...(note.flagReason ? { flagged: { reason } } : {}) }` — 그 키 순서. 빈 문자열은 거짓이다.
    let mut pairs = vec![
        ("body", Value::from(body).to_string()),
        ("updatedAt", Value::from(at).to_string()),
    ];
    if let Some(r) = flag.filter(|r| !r.is_empty()) {
        pairs.push(("flagged", obj(&[("reason", Value::from(r).to_string())])));
    }
    Ok(super::respond::text_result(&obj(&[("note", obj(&pairs))])))
}

enum Set {
    Done(Option<String>),
    Conflict(Option<String>),
}

/// TS `setThreadNote` — 같은 잠금(`for update`)·같은 비교(밀리초)·같은 문장.
async fn set_note(
    write: &PgPool,
    me: &str,
    root: &str,
    body: Option<&str>,
    guard: &Guard,
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
    let differs = match guard {
        Guard::Any => false,
        Guard::Expect(want) => *want != now,
        Guard::Never => true,
    };
    if differs {
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
    // TS `{ error: { code, updatedAt, message } }` — 그 키 순서.
    let inner = obj(&[
        ("code", Value::from("conflict").to_string()),
        ("updatedAt", Value::from(now).to_string()),
        ("message", Value::from(message).to_string()),
    ]);
    super::respond::text_result(&obj(&[("error", inner)]))
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
        assert_eq!(body_arg(&o(json!({}))), Ok(BodyArg::Read));
        assert_eq!(body_arg(&o(json!({"body": null}))), Ok(BodyArg::Delete));
        let m = o(json!({"body": "x"}));
        assert_eq!(body_arg(&m), Ok(BodyArg::Write("x")));
        assert_eq!(
            body_arg(&o(json!({"body": ""}))),
            Err("String must contain at least 1 character(s)".into())
        );
        assert_eq!(
            body_arg(&o(json!({"body": 1}))),
            Err("Expected string, received number".into())
        );
        assert_eq!(
            body_arg(&o(json!({"body": [] }))),
            Err("Expected string, received array".into())
        );
        // 4000 은 UTF-16 길이다 — BMP 밖 글자 하나는 둘로 센다.
        let edge = o(json!({ "body": "a".repeat(3998) + "😀" }));
        assert!(matches!(body_arg(&edge), Ok(BodyArg::Write(_))));
        assert_eq!(
            body_arg(&o(json!({ "body": "a".repeat(3999) + "😀" }))),
            Err("String must contain at most 4000 character(s)".into())
        );
    }

    #[test]
    fn guard_follows_zod() {
        assert_eq!(guard_arg(&o(json!({}))), Ok(Guard::Any));
        assert_eq!(
            guard_arg(&o(json!({"ifUpdatedAt": null}))),
            Ok(Guard::Expect(None))
        );
        assert_eq!(
            guard_arg(&o(
                json!({"ifUpdatedAt": "2026-11-16T02:00:00.123456+09:00"})
            )),
            Ok(Guard::Expect(Some("2026-11-15T17:00:00.123Z".into())))
        );
        assert_eq!(
            guard_arg(&o(json!({"ifUpdatedAt": "yesterday"}))),
            Err("Invalid datetime".into())
        );
        assert_eq!(
            guard_arg(&o(json!({"ifUpdatedAt": 1}))),
            Err("Expected string, received number".into())
        );
        // zod 는 받지만 JS 가 Invalid Date 로 읽는 오프셋(시 > 23) — TS 는 늘 conflict 로 답한다.
        assert_eq!(
            guard_arg(&o(json!({"ifUpdatedAt": "2026-11-16T02:00:00+24:00"}))),
            Ok(Guard::Never)
        );
    }

    /// SDK 의 검증 오류 글자 — 키 순서대로 한 줄씩, 결과는 `isError: true`. 인자가 객체가 아니면 TS.
    #[test]
    fn invalid_args_follow_sdk() {
        let text = |r: String| {
            let v: Value = serde_json::from_str(&r).unwrap();
            assert_eq!(v["isError"], json!(true), "{r}");
            assert!(r.ends_with(",\"isError\":true}"), "{r}");
            v["content"][0]["text"].as_str().unwrap().to_owned()
        };
        const HEAD: &str =
            "MCP error -32602: Input validation error: Invalid arguments for tool thread.note: ";
        assert_eq!(
            text(parse(&json!({})).unwrap_err().unwrap()),
            format!("{HEAD}Required at threadRootId")
        );
        assert_eq!(
            text(
                parse(&json!({"threadRootId": "x", "body": "", "ifUpdatedAt": "y"}))
                    .unwrap_err()
                    .unwrap()
            ),
            format!(
                "{HEAD}Invalid uuid at threadRootId\nString must contain at least 1 character(s) at body\nInvalid datetime at ifUpdatedAt"
            )
        );
        assert_eq!(
            text(parse(&json!({"threadRootId": null})).unwrap_err().unwrap()),
            format!("{HEAD}Expected string, received null at threadRootId")
        );
        for v in [Value::Null, json!([]), json!("x")] {
            assert_eq!(parse(&v).unwrap_err(), None, "{v}");
        }
        let ok = json!({"threadRootId": "11111111-1111-4111-8111-111111111111", "x": 1});
        assert!(parse(&ok).is_ok());
        // 글자는 SDK 원본과 맞춘다.
        let sdk = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        assert!(sdk.contains("threadRootId: z.string().uuid(),\n      body: z.string().min(1)"));
    }

    fn agent() -> Account {
        Account {
            id: "11111111-1111-4111-8111-111111111111".into(),
            handle: "a".into(),
            display_name: "a".into(),
            kind: "agent".into(),
            is_admin: false,
            role: "member".into(),
            status: "active".into(),
            status_text: None,
            avatar_attachment_id: None,
        }
    }

    /// 쓰기 전 DB 오류 — 다시 돌다가 TS 로 넘기지 않고 `temporarily_unavailable`. 검증 거절은 DB 없이 먼저 답한다.
    #[tokio::test]
    async fn db_down_answers_unavailable_not_ts() {
        let dead = sqlx::postgres::PgPoolOptions::new()
            .acquire_timeout(std::time::Duration::from_millis(100))
            .connect_lazy("postgres://nobody@127.0.0.1:1/none")
            .unwrap();
        let root = json!({"threadRootId": "22222222-2222-4222-8222-222222222222"});
        for args in [
            root.clone(),
            json!({"threadRootId": root["threadRootId"], "body": null}),
            json!({"threadRootId": root["threadRootId"], "body": "x"}),
        ] {
            let r = answer(&dead, &dead, &agent(), &args)
                .await
                .expect("answered");
            assert!(r.contains("temporarily_unavailable"), "{r}");
        }
        let r = answer(&dead, &dead, &agent(), &json!({"threadRootId": "x"}))
            .await
            .expect("answered");
        assert!(r.contains("Invalid uuid at threadRootId"), "{r}");
        assert_eq!(answer(&dead, &dead, &agent(), &Value::Null).await, None);
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
