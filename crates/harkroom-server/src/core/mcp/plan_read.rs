//! S5.4 A4a — MCP `thread.plan` **읽기**(`plan` 인자 없음)를 Rust 가 답한다. TS `mcpPlugin.ts` 의 `thread.plan` 첫 갈래를 옮긴다.
//!
//! - 판정 순서는 TS 와 같다: 루트 글이 없거나 지웠음(`not_found`) → 답글(`not_root`) → 그 채널을 못 봄(`forbidden`) →
//!   `{ plan: view | null }`. REST `GET /threads/{rootId}/plan` 과 달리 거절을 코드별로 가른다(TS 도구가 그렇다).
//! - 보기 몸통은 REST 와 같은 [`crate::core::thread_plan_read::plan_view_json`] — 연결 그룹 진행률은 **부른 계정 기준**이다.
//! - 쓰기(`plan` 키가 있음 — 객체·null 모두)는 TS 로 넘긴다(`None`). `ifUpdatedAt` 이 실려 와도 zod 검증을 TS 에 맡기려고 넘긴다.
//!   모르는 키는 zod 처럼 버린다.
//! - 읽기 풀만 쓰고 새 GRANT 가 없다. 필요한 SELECT 는 `thread_plan_read::THREAD_PLAN_READ_PRIVILEGES` — 없으면 `main.rs` 가
//!   [`super::writes::McpWrites::plan_read`] 를 끄고 TS 가 답한다. DB 오류도 TS 로 넘긴다(읽기라 다시 돌아도 같다).
use super::respond::text_result;
use super::tools::{err, uuid_arg};
use crate::auth::Account;
use crate::core::thread_plan_read::{ROOT_SQL, plan_view_json};
use serde_json::Value;
use sqlx::PgPool;

/// TS `PLAN_ERROR_MESSAGES` 의 읽기 갈래 셋.
const NOT_FOUND: &str = "그런 글이 없다";
const NOT_ROOT: &str = "스레드 루트 글의 id 를 줘라(대화 프롬프트 맨 위의 threadRootId)";
const FORBIDDEN: &str = "not a member of this channel";

/// Rust 가 답할 인자인지 — `threadRootId` 가 zod uuid 이고 `plan`·`ifUpdatedAt` 이 없을 때만.
fn read_root(args: &Value) -> Option<&str> {
    let o = args.as_object()?;
    if o.contains_key("plan") || o.contains_key("ifUpdatedAt") {
        return None;
    }
    uuid_arg(args, "threadRootId").filter(|r| crate::lists::is_zod_uuid(r))
}

pub async fn answer(read: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let root = read_root(args)?;
    let row: Option<(String, bool)> = sqlx::query_as(ROOT_SQL)
        .bind(root)
        .fetch_optional(read)
        .await
        .ok()?;
    let channel = match row {
        None => return Some(err("not_found", NOT_FOUND)),
        Some((_, false)) => return Some(err("not_root", NOT_ROOT)),
        Some((c, true)) => c,
    };
    if !crate::core::msg_read::channel_visible(read, &me.id, &channel)
        .await
        .ok()?
    {
        return Some(err("forbidden", FORBIDDEN));
    }
    let body = plan_view_json(read, &me.id, root).await.ok()?;
    Some(text_result(&body))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_plain_reads_are_served() {
        let r = "6ef97871-80a1-43d3-b232-22152fe9d226";
        assert_eq!(read_root(&json!({ "threadRootId": r })), Some(r));
        assert_eq!(read_root(&json!({ "threadRootId": r, "x": 1 })), Some(r));
        for a in [
            json!({ "threadRootId": r, "plan": null }),
            json!({ "threadRootId": r, "plan": {} }),
            json!({ "threadRootId": r, "ifUpdatedAt": null }),
            json!({ "threadRootId": "x" }),
            json!({ "threadRootId": 1 }),
            json!({}),
            json!([]),
        ] {
            assert_eq!(read_root(&a), None, "{a}");
        }
    }

    /// 거절 문구·읽기 갈래를 TS 원본과 맞춘다(값은 rustFrontDb 대조 시험이 본다).
    #[test]
    fn texts_follow_ts_source() {
        let mcp = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        for want in [
            "    not_found: '그런 글이 없다',",
            "    not_root: '스레드 루트 글의 id 를 줘라(대화 프롬프트 맨 위의 threadRootId)',",
            "    forbidden: 'not a member of this channel',",
            "      plan: planDocSchema.nullable().optional(),",
            "    if (plan === undefined) {\n      const root = await threadRootChannel(pool, threadRootId);\n      if (root === 'not_found' || root === 'not_root') return planError({ code: root });\n      if (!(await assertChannelVisible(pool, root.channelId, account.id))) return planError({ code: 'forbidden' });\n      const row = await getThreadPlan(pool, threadRootId);\n      return jsonResult({ plan: row ? await threadPlanView(pool, row, account.id) : null });",
            "  const planError = (error: { code: string }) =>\n    jsonResult({ error: { ...error, message: PLAN_ERROR_MESSAGES[error.code] ?? error.code } });",
        ] {
            assert!(mcp.contains(want), "{want}");
        }
        assert_eq!(err("not_root", NOT_ROOT).matches("not_root").count(), 1);
    }
}
