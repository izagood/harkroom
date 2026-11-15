//! C4b — Rust 가 답하는 MCP **쓰기** 도구. 첫 묶음은 `message.react`·`message.unreact`(REST 리액션 쓰기 C3a-1 의 본체를 같이 쓴다).
//!
//! 약속은 읽기와 같다 — TS 와 **같은 글자**, zod 가 그대로 받는 인자만, DB 오류·모르는 꼴은 TS 로(`None`). 거기에 셋을 더한다:
//! - 쓰기 전에 TS `/mcp/admit`(leakGuard → 백그라운드 회차 관문)을 이미 지났다([`super::route::serve`]). 회차에서 막힌 도구는 거기서
//!   도구 답 모양의 거절로 끝나고 여기까지 오지 않는다.
//! - 쓰기 풀은 그 줄의 권한이 다 있을 때만 있다(`main.rs` 의 `react_write`). 없으면 `None` — TS 가 답한다.
//! - 쓰기 중 DB 오류로 `None` 을 내면 TS 가 같은 요청을 다시 돈다. 리액션은 같은 결과로 수렴한다(`on conflict` · 없는 것 떼기도 성공).
use super::respond::minify;
use super::tools::{err, uuid_arg};
use crate::auth::Account;
use crate::core::msg_react::{
    AddOutcome, MAX_REACTIONS_PER_ACTOR, add_reaction, is_emoji, remove_reaction,
};
use serde_json::Value;
use sqlx::PgPool;

/// 이 묶음에서 Rust 가 답하는 쓰기 도구.
pub const SERVED: &[&str] = &[
    "message.react",
    "message.unreact",
    "inbox.read",
    "bg.claim",
    // C4b-ask — 묶음 카드 한 줄 닫기. 선택 카드 쓰기 풀(`ASK_PRIVILEGES`)이 있을 때만.
    "message.askBundleResolve",
    "message.askBundle",
    "bg.complete",
    "delegation.close",
    "thread.note",
];

/// TS 가 조건부로 싣는 도구 — `/mcp/admit` 이 `registered: true` 라고 답했을 때만 Rust 가 답한다([`super::route::serve`]).
/// `delegation.close` 는 TS env `HARKROOM_DELEGATION_V2` 가 켜졌을 때만 실린다. 앞단은 그 env 를 읽지 않는다.
pub const NEEDS_REGISTERED: &[&str] = &["delegation.close"];

/// `delegation.close` 의 쓰기 권한(표, 권한) — 고치는 칸(UPDATE)과, update 의 where·set 식·returning 이 읽는 칸(SELECT)만(security W6).
/// SELECT 가 빠지면 풀은 켜지는데 거래 안에서 늘 실패해 `internal` 로만 답한다 — 그래서 SELECT 도 여기서 본다. 빠지면 `main.rs` 가
/// 이 도구를 켜지 않아 TS 에 남는다. 읽는 칸 목록은 [`CLOSE_ITEMS_SQL`]·[`NOTIFY_DELEGATIONS_SQL`] 에서 시험이 뽑아 맞춘다.
/// homelab 의 앞단 쓰기 역할 GRANT 와 같아야 한다.
pub const DELEGATION_CLOSE_PRIVILEGES: &[(&str, &str)] = &[
    ("team_delegation_item.outcome", "UPDATE"),
    ("team_delegation_item.closed_reason", "UPDATE"),
    ("team_delegation_item.closed_at", "UPDATE"),
    ("team_delegation_item.update_pending_message_id", "UPDATE"),
    ("team_delegation_item.update_pending_at", "UPDATE"),
    ("team_delegation.notified_at", "UPDATE"),
    ("team_delegation_item.delegation_id", "SELECT"),
    ("team_delegation_item.delegate_account_id", "SELECT"),
    ("team_delegation_item.outcome", "SELECT"),
    ("team_delegation_item.closed_at", "SELECT"),
    ("team_delegation.id", "SELECT"),
    ("team_delegation.lead_account_id", "SELECT"),
    ("team_delegation.thread_root_id", "SELECT"),
    ("team_delegation.notified_at", "SELECT"),
];

/// 위임 줄 닫기 — TS `closeDelegationByDelegator` 와 같은 문장(`$1::uuid` 만 더함).
pub const CLOSE_ITEMS_SQL: &str = "update team_delegation_item i \
            set outcome = 'closed', closed_reason = 'delegator_close', closed_at = coalesce(i.closed_at, now()), \
                update_pending_message_id = null, update_pending_at = null \
           from team_delegation d \
          where d.id = i.delegation_id and d.lead_account_id = $1::uuid and d.thread_root_id = $2::uuid \
            and ($3::uuid is null or d.id = $3::uuid) \
            and ($4::uuid is null or i.delegate_account_id = $4::uuid) \
            and (i.outcome is null or i.outcome = 'reported') \
          returning i.delegation_id::text";

/// 다 닫힌 위임 묶음에 알림 처리 — TS `markSettledQuietly` 와 같은 문장.
pub const NOTIFY_DELEGATIONS_SQL: &str = "update team_delegation d set notified_at = now() \
              where d.id = any($1::uuid[]) and d.notified_at is null \
                and not exists (select 1 from team_delegation_item i where i.delegation_id = d.id and i.outcome is null)";

/// `inbox.read`(C4b ④-a) 쓰기 역할의 권한 — 읽음 시각 칸 하나만 고친다. 없으면 `main.rs` 가 풀을 비워 TS 가 답한다.
pub const INBOX_READ_PRIVILEGES: &[(&str, &str)] = &[("inbox.read_at", "UPDATE")];

/// 도구 묶음마다의 쓰기 풀 — 그 묶음의 권한이 다 있을 때만 `Some`. 없는 묶음의 도구는 TS 가 답한다.
#[derive(Clone, Default)]
pub struct McpWrites {
    /// `message.react`·`unreact` — `msg_react::MESSAGE_REACTION_PRIVILEGES`.
    pub react: Option<PgPool>,
    /// `inbox.read` — [`INBOX_READ_PRIVILEGES`].
    pub inbox: Option<PgPool>,
    /// `bg.claim` — [`super::bg_claim::BG_CLAIM_PRIVILEGES`].
    pub bg: Option<PgPool>,
    /// `message.askBundleResolve` — C3b-1 `ASK_PRIVILEGES`.
    pub ask: Option<PgPool>,
    /// `message.askBundle` 있던 묶음에 줄 더하기(C3b-2b-2) — `ask_bundle_add::ASK_BUNDLE_ADD_PRIVILEGES`.
    pub bundle: Option<PgPool>,
    /// `bg.complete`(러너 길) — [`super::bg_complete::BG_COMPLETE_PRIVILEGES`].
    pub bg_complete: Option<PgPool>,
    /// `delegation.close` — [`DELEGATION_CLOSE_PRIVILEGES`].
    pub delegation: Option<PgPool>,
    /// `grant.revoke`·`permission.revoke` — `grant_writes::GRANT_REVOKE_PRIVILEGES`.
    pub grant: Option<PgPool>,
    /// `thread.note`(B2-1) — `note::THREAD_NOTE_PRIVILEGES`.
    pub note: Option<PgPool>,
    /// 기억 쓰기(C4b B1a) — [`super::mem_writes::MEMORY_WRITE_PRIVILEGES`]. [`super::mem_writes::answer`] 가 본다.
    pub memory: Option<PgPool>,
}

/// JS `Number.MAX_SAFE_INTEGER` — 이 밖의 수는 TS 에서 값이 뭉개진다. Rust 는 같은 결과를 낼 수 없으니 TS 로 넘긴다.
const JS_SAFE_INT: i64 = 9_007_199_254_740_991;

/// TS `{ emoji }`·`{ ok: true }` 와 같은 글자.
fn ok_text(v: &str) -> String {
    super::respond::text_result(v)
}

/// 쓰기를 시작한 뒤의 DB 오류(security W1). 사유를 되비추지 않는 고정 문장이다.
fn internal() -> String {
    err("internal", "the write failed; it was not retried")
}

/// `emoji: z.string().min(1).max(32)` — UTF-16 길이.
fn emoji_arg(args: &Value) -> Option<&str> {
    args.get("emoji")?.as_str().filter(|e| {
        let n = e.encode_utf16().count();
        (1..=32).contains(&n)
    })
}

pub async fn answer(
    read: &PgPool,
    writes: &McpWrites,
    me: &Account,
    tool: &str,
    args: &Value,
    runner: bool,
    cause: Option<&str>,
) -> Option<Option<String>> {
    if !SERVED.contains(&tool) {
        return None;
    }
    if tool == "bg.claim" {
        // 러너가 아니면(`runner_only`) TS 가 답한다. 켜짐은 `route::serve` 가 admit 값으로 이미 걸렀다.
        let Some(write) = writes.bg.as_ref().filter(|_| runner) else {
            return Some(None);
        };
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_millis() as i64;
        return Some(super::bg_claim::claim(read, write, &me.id, now_ms).await);
    }
    if tool == "message.askBundle" {
        let Some(write) = writes.bundle.as_ref() else {
            return Some(None);
        };
        return Some(bundle_add(read, write, me, args, cause).await);
    }
    if tool == "bg.complete" {
        // 러너 길만 — 회차의 턴·일반 턴은 TS 가 답한다(admit 도 러너 꼴만 받는다).
        let Some(write) = writes.bg_complete.as_ref().filter(|_| runner) else {
            return Some(None);
        };
        return Some(super::bg_complete::complete(write, &me.id, args).await);
    }
    // B2-1 — 메모는 자기 권한 묶음(`note::THREAD_NOTE_PRIVILEGES`)의 풀로만.
    if tool == "thread.note" {
        let Some(w) = writes.note.as_ref() else {
            return Some(None);
        };
        return Some(super::note::answer(read, w, me, args).await);
    }
    if tool == "inbox.read" {
        let Some(write) = writes.inbox.as_ref() else {
            return Some(None);
        };
        return Some(inbox_read(write, me, args).await);
    }
    if tool == "message.askBundleResolve" {
        let Some(write) = writes.ask.as_ref() else {
            return Some(None);
        };
        return Some(bundle_resolve(read, write, me, args).await);
    }
    if tool == "delegation.close" {
        let Some(write) = writes.delegation.as_ref() else {
            return Some(None);
        };
        return Some(delegation_close(write, me, args).await);
    }
    let Some(write) = writes.react.as_ref() else {
        return Some(None);
    };
    Some(react(read, write, me, tool, args).await)
}

/// `message.askBundle` 있던 묶음에 줄 더하기(C3b-2b-2) — 본체는 [`crate::core::ask_bundle_add`]. 새 묶음·넘길 원본·쓰기 전 DB 오류는
/// `None`(→ TS).
async fn bundle_add(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
) -> Option<String> {
    use crate::core::ask_bundle_add::{Added, add, parse_args, refusal_message};
    let a = parse_args(args)?;
    match add(read, write, me, &a, cause).await {
        Ok(Added::Handoff) => None,
        Ok(Added::Forbidden) => Some(err("forbidden", "not a member of this dm channel")),
        Ok(Added::Refused(code, root)) => Some(ok_text(&match root {
            Some(r) => format!(
                "{{\"error\":{{\"code\":{},\"message\":{},\"rootId\":{}}}}}",
                Value::from(code),
                Value::from(refusal_message(code)),
                Value::from(r)
            ),
            None => format!(
                "{{\"error\":{{\"code\":{},\"message\":{}}}}}",
                Value::from(code),
                Value::from(refusal_message(code))
            ),
        })),
        Ok(Added::Bundle(row)) => Some(ok_text(&format!(
            "{{\"message\":{},\"updated\":true}}",
            super::respond::minify(&row)
        ))),
        Err(_) => Some(internal()),
    }
}

/// `ids: z.array(z.number().int()).min(1).max(200)` 중 Rust 가 같은 값으로 읽는 것 — JSON 정수이고 JS 안전 범위 안.
/// `1.0` 같은 실수 꼴·안전 범위 밖·다른 꼴은 `None`(TS 로 — zod 가 받든 거절하든 TS 의 답이 정본이다).
fn inbox_ids(args: &Value) -> Option<Vec<i64>> {
    let a = args.get("ids")?.as_array()?;
    if !(1..=200).contains(&a.len()) {
        return None;
    }
    a.iter()
        .map(|v| {
            v.as_i64()
                .filter(|n| (-JS_SAFE_INT..=JS_SAFE_INT).contains(n))
        })
        .collect()
}

/// TS `markInboxRead` — 자기 inbox 의 아직 안 읽은 항목만 읽음으로. 같은 요청을 두 번 돌아도 두 번째는 0 이라 결과가 수렴하지만,
/// 답의 `read` 수가 달라지므로 쓰기 오류는 TS 로 넘기지 않고 `internal` 로 답한다(security W1).
async fn inbox_read(write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let ids = inbox_ids(args)?;
    Some(
        match sqlx::query(
            "update inbox set read_at = now() where account_id = $1::uuid and id = any($2) and read_at is null",
        )
        .bind(&me.id)
        .bind(&ids)
        .execute(write)
        .await
        {
            Ok(r) => ok_text(&format!("{{\"read\":{}}}", r.rows_affected())),
            Err(_) => internal(),
        },
    )
}

/// `note: z.string().min(1).max(1000).optional()` — UTF-16 길이. 칸이 있는데 꼴이 틀리면 zod 오류라 TS 로(`Err`).
fn note_arg(args: &Value) -> Result<Option<&str>, ()> {
    match args.get("note") {
        None => Ok(None),
        Some(v) => v
            .as_str()
            .filter(|s| (1..=1000).contains(&s.encode_utf16().count()))
            .map(Some)
            .ok_or(()),
    }
}

/// `message.askBundleResolve` — TS `resolveBundleItem`([`crate::core::ask_bundle_resolve`]).
async fn bundle_resolve(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    args: &Value,
) -> Option<String> {
    use crate::core::ask_bundle_resolve::{Resolved, refusal_message, resolve};
    let bundle = uuid_arg(args, "bundleId")?;
    let root = uuid_arg(args, "rootId")?;
    let reply = uuid_arg(args, "replyMessageId")?;
    let note = note_arg(args).ok()?;
    match resolve(read, write, &me.id, bundle, root, reply, note)
        .await
        .ok()?
    {
        Resolved::Refused(code) => Some(err(code, refusal_message(code))),
        Resolved::Bundle(row) => {
            // 행은 Postgres `json` 글자 — 공백만 지운다(읽기 도구와 같다). meta 의 수 표기가 JS 와 갈릴 수 있으면 `jsonb_as_js` 가 None
            // 이지만, 쓰기는 이미 끝났으니 TS 로 넘기지 않고 공백만 지운 글자로 답한다(묶음 meta 에는 수가 없다).
            let row = minify(&row);
            let row = super::reads2::jsonb_as_js(&row).unwrap_or(row);
            Some(ok_text(&format!("{{\"message\":{row}}}")))
        }
        Resolved::Failed => Some(internal()),
        // 원본을 Rust 가 정하지 않는다(권한 거울·백스톱 등) — 쓰기 전이라 TS 가 답한다.
        Resolved::Handoff => None,
    }
}

/// zod `z.string().min(1).max(100)` — UTF-16 길이. 없으면 `Some(None)`, 꼴이 틀리면 `None`(→ TS).
fn opt_str_arg(args: &Value, key: &str, max: usize) -> Option<Option<String>> {
    match args.get(key) {
        None => Some(None),
        Some(Value::String(s)) => {
            let n = s.encode_utf16().count();
            (1..=max).contains(&n).then(|| Some(s.clone()))
        }
        Some(_) => None,
    }
}

/// `delegation.close`(TS mcpPlugin 의 같은 도구 + `closeDelegationByDelegator`·`markSettledQuietly`) — 위임자가 이 스레드에서 낸 열린·보고된
/// 의무를 닫는다. 아무도 깨우지 않고 이벤트·감사도 없다(TS 와 같다). 남의 위임은 `lead_account_id = 나` 조건에 걸려 닫히지 않는다(`closed: 0`).
async fn delegation_close(write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    args.as_object()?;
    let thread = uuid_arg(args, "threadRootId")?;
    let delegation = super::tools::opt_uuid(args, "delegationId")?;
    let delegate = opt_str_arg(args, "delegate", 100)?;
    // 쓰기 전 읽기 — 실패하면 TS 로 넘겨도 된다(아직 아무것도 쓰지 않았다).
    let delegate_id: Option<String> = match delegate {
        None => None,
        Some(h) => {
            // TS `delegate.replace(/^@/, '')` — 맨 앞 `@` 하나만 뗀다.
            let handle = h.strip_prefix('@').unwrap_or(&h);
            let found: Option<String> = sqlx::query_scalar(
                "select id::text from account where handle = $1 and deleted_at is null",
            )
            .bind(handle)
            .fetch_optional(write)
            .await
            .ok()?;
            match found {
                Some(id) => Some(id),
                None => return Some(err("not_found", "unknown delegate")),
            }
        }
    };
    // 여기부터 쓰기다(security W1) — 한 트랜잭션. 오류가 나면 되돌리고 TS 로 넘기지 않는다(넘기면 TS 가 다시 닫는다).
    match close_tx(
        write,
        &me.id,
        thread,
        delegation.as_deref(),
        delegate_id.as_deref(),
    )
    .await
    {
        Ok(n) => Some(ok_text(&format!("{{\"closed\":{n}}}"))),
        Err(_) => Some(internal()),
    }
}

async fn close_tx(
    write: &PgPool,
    me: &str,
    thread: &str,
    delegation: Option<&str>,
    delegate: Option<&str>,
) -> Result<u64, sqlx::Error> {
    let mut tx = write.begin().await?;
    let ids: Vec<String> = sqlx::query_scalar(CLOSE_ITEMS_SQL)
        .bind(me)
        .bind(thread)
        .bind(delegation)
        .bind(delegate)
        .fetch_all(&mut *tx)
        .await?;
    if !ids.is_empty() {
        sqlx::query(NOTIFY_DELEGATIONS_SQL)
            .bind(&ids)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(ids.len() as u64)
}

async fn react(
    read: &PgPool,
    write: &PgPool,
    me: &Account,
    tool: &str,
    args: &Value,
) -> Option<String> {
    let channel = uuid_arg(args, "channelId")?;
    let message = uuid_arg(args, "messageId")?;
    let emoji = emoji_arg(args)?;
    if tool == "message.react" && !is_emoji(emoji) {
        return Some(err("bad_request", "a reaction must be a single emoji"));
    }
    if !crate::core::channels::visible(read, &me.id, channel)
        .await
        .ok()?
    {
        return Some(err("forbidden", "not a member of this dm channel"));
    }
    // 여기부터 쓰기다(security W1) — 오류가 나도 TS 로 넘기지 않는다(넘기면 TS 가 같은 쓰기를 한 번 더 한다). 도구 오류로 답한다.
    if tool == "message.unreact" {
        return Some(
            match remove_reaction(read, write, &me.id, channel, message, emoji).await {
                Ok(()) => ok_text("{\"ok\":true}"),
                Err(_) => internal(),
            },
        );
    }
    let added = match add_reaction(read, write, &me.id, channel, message, emoji).await {
        Ok(v) => v,
        Err(_) => return Some(internal()),
    };
    match added {
        AddOutcome::Added => Some(ok_text(&format!("{{\"emoji\":{}}}", Value::from(emoji)))),
        AddOutcome::NotFound => Some(err("not_found", "no such message in this channel")),
        AddOutcome::TooMany => Some(err(
            "too_many_reactions",
            &format!("at most {MAX_REACTIONS_PER_ACTOR} reactions per message"),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn served_are_writes_in_registry() {
        for n in SERVED {
            let s = super::super::find(n).expect(n);
            // `thread.note` 는 body 에 따라 읽기·쓰기가 갈리는 도구(Access 표의 ReadSide)다.
            let want = if *n == "thread.note" {
                super::super::Access::ReadSide
            } else {
                super::super::Access::Write
            };
            assert_eq!(s.access, want, "{n}");
        }
    }

    #[test]
    fn inbox_ids_takes_safe_integers_only() {
        use serde_json::json;
        assert_eq!(inbox_ids(&json!({"ids": [1, 2]})), Some(vec![1, 2]));
        assert_eq!(
            inbox_ids(&json!({"ids": [-9_007_199_254_740_991_i64]})),
            Some(vec![-JS_SAFE_INT])
        );
        assert_eq!(inbox_ids(&json!({"ids": []})), None);
        assert_eq!(inbox_ids(&json!({"ids": [1.0]})), None);
        assert_eq!(
            inbox_ids(&json!({"ids": [9_007_199_254_740_992_i64]})),
            None
        );
        assert_eq!(inbox_ids(&json!({"ids": ["1"]})), None);
        assert_eq!(inbox_ids(&json!({"ids": vec![1; 201]})), None);
        assert_eq!(inbox_ids(&json!({})), None);
    }

    #[test]
    fn inbox_sql_follows_ts_source() {
        let svc = include_str!("../../../../../packages/server/src/services/messages.ts");
        assert!(svc.contains(
            "`update inbox set read_at = now() where account_id = $1 and id = any($2) and read_at is null`,"
        ));
    }

    /// `delegation.close` 의 문장·문구를 TS 원본과 맞춘다(값 비교는 대조 시험이 한다).
    #[test]
    fn delegation_close_follows_ts_source() {
        let dl = include_str!("../../../../../packages/server/src/services/delegations.ts");
        for want in [
            "set outcome = 'closed', closed_reason = 'delegator_close', closed_at = coalesce(i.closed_at, now()),\n            update_pending_message_id = null, update_pending_at = null",
            "where d.id = i.delegation_id and d.lead_account_id = $1 and d.thread_root_id = $2",
            "and ($3::uuid is null or d.id = $3::uuid)\n        and ($4::uuid is null or i.delegate_account_id = $4::uuid)\n        and (i.outcome is null or i.outcome = 'reported')",
            "`update team_delegation d set notified_at = now()\n      where d.id = any($1::uuid[]) and d.notified_at is null\n        and not exists (select 1 from team_delegation_item i where i.delegation_id = d.id and i.outcome is null)`,",
        ] {
            assert!(dl.contains(want), "{want}");
        }
        let mcp = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        for want in [
            "`select id from account where handle = $1 and deleted_at is null`, [delegate.replace(/^@/, '')]);",
            "if (!r.rowCount) return jsonResult({ error: { code: 'not_found', message: 'unknown delegate' } });",
            "return jsonResult({ closed });",
            "delegate: z.string().min(1).max(100).optional(),",
            "if (tool === 'delegation.close') return delegationV2Enabled();",
        ] {
            assert!(mcp.contains(want), "{want}");
        }
    }

    /// 두 update 가 읽는 칸(별칭 `i.`·`d.` 로 쓴 것 = where·set 식·returning)마다 SELECT 가, 고치는 칸마다 UPDATE 가 목록에 있다.
    /// 문장에 칸을 더하고 목록을 안 고치면 빨개진다 — 운영 역할에 SELECT 가 없을 때 풀이 켜져 늘 `internal` 이 되는 것을 막는다.
    #[test]
    fn delegation_close_privileges_cover_sql() {
        let has = |t: &str, p: &str| DELEGATION_CLOSE_PRIVILEGES.contains(&(t, p));
        let mut read = vec![];
        for sql in [CLOSE_ITEMS_SQL, NOTIFY_DELEGATIONS_SQL] {
            let b = sql.as_bytes();
            for (k, w) in sql.char_indices() {
                if !(w == 'i' || w == 'd') || b.get(k + 1) != Some(&b'.') {
                    continue;
                }
                if k > 0 && (b[k - 1].is_ascii_alphanumeric() || b[k - 1] == b'_') {
                    continue;
                }
                let col: String = sql[k + 2..]
                    .chars()
                    .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
                    .collect();
                let table = if w == 'i' {
                    "team_delegation_item"
                } else {
                    "team_delegation"
                };
                read.push(format!("{table}.{col}"));
            }
        }
        read.sort();
        read.dedup();
        assert_eq!(
            read,
            [
                "team_delegation.id",
                "team_delegation.lead_account_id",
                "team_delegation.notified_at",
                "team_delegation.thread_root_id",
                "team_delegation_item.closed_at",
                "team_delegation_item.delegate_account_id",
                "team_delegation_item.delegation_id",
                "team_delegation_item.outcome",
            ],
            "칸 뽑기가 문장을 다 읽었다"
        );
        for c in &read {
            assert!(has(c, "SELECT"), "SELECT on {c}");
        }
        for c in [
            "outcome",
            "closed_reason",
            "closed_at",
            "update_pending_message_id",
            "update_pending_at",
        ] {
            assert!(CLOSE_ITEMS_SQL.contains(&format!("{c} = ")), "{c}");
            assert!(
                has(&format!("team_delegation_item.{c}"), "UPDATE"),
                "UPDATE on {c}"
            );
        }
        assert!(has("team_delegation.notified_at", "UPDATE"));
        assert_eq!(
            DELEGATION_CLOSE_PRIVILEGES.len(),
            read.len() + 6,
            "목록에 남는 칸이 없다"
        );
    }

    /// 거절 문구·답 모양을 TS 원본과 맞춘다.
    #[test]
    fn texts_follow_ts_source() {
        let mcp = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        for want in [
            "return jsonResult({ error: { code: 'bad_request', message: 'a reaction must be a single emoji' } });",
            "return jsonResult({ error: { code: 'forbidden', message: 'not a member of this dm channel' } });",
            "return jsonResult({ error: { code: 'not_found', message: 'no such message in this channel' } });",
            "error: { code: 'too_many_reactions', message: `at most ${MAX_REACTIONS_PER_ACTOR} reactions per message` },",
            "return jsonResult({ emoji });",
            "if (removed === 'status_kept') return jsonResult({ ok: true });",
            "emoji: z.string().min(1).max(32),",
            "inputSchema: { ids: z.array(z.number().int()).min(1).max(200) },",
            "return jsonResult({ read });",
        ] {
            assert!(mcp.contains(want), "{want}");
        }
    }
}
