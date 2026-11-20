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
    // C1c-4c — 글 올리기. 글 쓰기 풀([`McpWrites::post`])이 있을 때만 답한다(없으면 TS).
    "message.post",
    // C3b-2c-1 — 표지 없는 실패. 글 쓰기 풀이 있을 때만(`message.post` 와 같은 권한).
    "message.fail",
    // C3b-2c-4a — 위임의 게이트·상한 거절만(읽기만 한다). 지나면 TS.
    "message.delegate",
    // C3b-2c-3 — 완료 보고(`planStepId` 없는 것). 같은 글 쓰기 풀이다 — 예약 접기 칸(`agent_wake.canceled_at`·대기 줄 meta)도 그 묶음에 있다.
    "message.report",
    // S5.4 A1 — 진행 한 줄·러너 알림 줄. 같은 글 쓰기 풀이다(`message.post` 와 같은 칸).
    "message.progress",
    "message.notice",
    // S5.4 A3 — 다시 부르기 예약. 글 쓰기 풀에 더해 agent_wake 칸이 있을 때만([`McpWrites::wake`]).
    "turn.wake",
    // S5.4 A2a — 보드 항목 떼기. 작업 항목 쓰기 풀(`workitem::WORK_ITEM_REMOVE_PRIVILEGES`)이 있을 때만.
    "workitem.remove",
    // S5.4 A2a — 보드 항목 걸기. `workitem::WORK_ITEM_UPSERT_PRIVILEGES` 가 있을 때만, `state: done`+스레드는 TS.
    "workitem.upsert",
    // S5.4 A4a — 계획판 읽기(`plan` 인자 없음). 읽기 풀에 `THREAD_PLAN_READ_PRIVILEGES` 가 있을 때만([`McpWrites::plan_read`]).
    // S5.4 A4b2 — 쓰기(`plan` 객체·null)는 [`McpWrites::plan_write`] 가 있을 때만.
    "thread.plan",
    // S5.4 A4b2 — 단계·그룹 하나 고치기(`auto` 칸 없는 것). [`McpWrites::plan_write`] 가 있을 때만, 자동 진행은 TS.
    "thread.plan.item",
    // S5.4 MCP 2 — PR 감시 걸기. 감시 쓰기 풀(`pr_watch::PR_WATCH_PRIVILEGES`)이 있고 위임 스위치를 알 때만.
    "pr.watch",
    // S5.4 MCP 3 — 스킬 제안(행·시스템 글·이벤트). 제안 행 칸이 있는 글 쓰기 풀(`writes.skill`)일 때만.
    "skill.propose",
    // S5.4 MCP 4 — 자동화 제안(행 하나, 글·이벤트 없음). 제안 칸이 있는 쓰기 풀(`writes.automation`)일 때만.
    "automation.propose",
    // S5.4 MCP 5 — 에이전트의 「지금 한 번」(회차 INSERT 만). 회차 칸이 있는 쓰기 풀(`writes.automation_run`)일 때만.
    "automation.run",
    // S5.4 MCP 6 — API 권한 다시 주기의 거절 전부·같은 위임 다시 오기·원인 없는 새 위임(대기 줄; 원인이 확인된 새 위임은 TS). `writes.grant_delegate` 일 때만.
    "grant.delegate",
    // S5.4 — 권한 요청의 거절 앞머리(인자 짝·채널·규칙 모양·저장소 모양). 읽기만 한다 — 받아들여지는 요청(요청 줄·카드)은 TS.
    "permission.request",
    // 아티팩트 올리기의 거절 앞머리(채널 가시성·html/attachmentId 짝). 읽기만 한다 — 올리기는 TS.
    "artifact.publish",
    // 선택 카드의 거절 앞머리(계획 단계·채널 가시성·선택지 모양·머지 거절 대상). 읽기만 한다 — 카드 쓰기는 TS.
    "message.ask",
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
    /// `workitem.remove`(S5.4 A2a) — `workitem::WORK_ITEM_REMOVE_PRIVILEGES`.
    pub work_item: Option<PgPool>,
    /// `workitem.upsert`(S5.4 A2a) — `workitem::WORK_ITEM_UPSERT_PRIVILEGES`.
    pub work_item_upsert: Option<PgPool>,
    /// `thread.note`(B2-1) — `note::THREAD_NOTE_PRIVILEGES`.
    pub note: Option<PgPool>,
    /// `thread.plan` 읽기(S5.4 A4a) — 읽기 풀에 `thread_plan_read::THREAD_PLAN_READ_PRIVILEGES` 가 다 있을 때만 참. 쓰기 풀은 쓰지 않는다.
    pub plan_read: bool,
    /// `thread.plan` 쓰기·`thread.plan.item`(S5.4 A4b2) — `plan_read` 에 더해 `plan_write::PLAN_WRITE_PRIVILEGES`.
    pub plan_write: Option<PgPool>,
    /// MCP 계획 쓰기에서 관리자가 바뀌어 자동 진행을 끌 때의 알림 글 경로(S5.4 TP3 끄기 칸 권한 + 글 올리기). 없으면 그 갈래는 TS 로.
    pub plan_auto_off: Option<std::sync::Arc<crate::core::msg_post::PostState>>,
    /// `pr.watch`(S5.4 MCP 2) — `pr_watch::PR_WATCH_PRIVILEGES`.
    pub pr_watch: Option<PgPool>,
    /// `automation.propose`(S5.4 MCP 4) — `automation_propose::AUTOMATION_PROPOSE_PRIVILEGES`.
    pub automation: Option<PgPool>,
    /// `automation.run`(S5.4 MCP 5) — `automation_run::AUTOMATION_RUN_PRIVILEGES`.
    pub automation_run: Option<PgPool>,
    /// `inbox.poll` 의 `version` 기록 — `inbox_poll::RUNNER_VERSION_PRIVILEGES`. 없으면 `version` 이 온 폴은 TS.
    pub runner_version: Option<PgPool>,
    /// `inbox.poll` 의 `lease` 임대 — `inbox_poll::INBOX_LEASE_PRIVILEGES`. 없으면 `lease` 가 온 폴은 TS.
    pub inbox_lease: Option<PgPool>,
    /// `inbox.poll` 의 옛 러너 접기·종료 요청 수령(P6-1) — `inbox_poll::INBOX_POLL_WRITE_PRIVILEGES`. 없으면 그 둘은 TS.
    pub inbox_poll_write: Option<PgPool>,
    /// `inbox.poll` 긴 폴의 깨움 — 코어 이벤트 허브(outbox LISTEN 이 채운다). 없으면 `timeoutMs > 0` 폴은 TS.
    pub inbox_hub: Option<crate::core::events::Hub>,
    /// `grant.delegate`(S5.4 MCP 6) — `grant_delegate::GRANT_DELEGATE_PRIVILEGES`.
    pub grant_delegate: Option<PgPool>,
    /// 기억 쓰기(C4b B1a) — [`super::mem_writes::MEMORY_WRITE_PRIVILEGES`]. [`super::mem_writes::answer`] 가 본다.
    pub memory: Option<PgPool>,
    /// 기억 본문 쓰기(C4b B1b: set·merge·restore) — B1a 권한 + [`super::mem_body::MEMORY_BODY_PRIVILEGES`]. [`super::mem_body::answer`] 가 본다.
    pub memory_body: Option<PgPool>,
    /// `message.post`(C1c-4c) — `msg_post::MESSAGE_POST_PRIVILEGES` + `MCP_POST_EXTRA_PRIVILEGES`. [`super::msg_post::answer`] 가 본다.
    pub post: Option<std::sync::Arc<crate::core::msg_post::PostState>>,
    /// `message.delegate` 쓰기(C3b-2c-4b) — `post` 에 더해 `delegate_write::DELEGATE_WRITE_PRIVILEGES`. 없으면 게이트를 지난 위임은 TS 로.
    pub delegate: Option<std::sync::Arc<crate::core::msg_post::PostState>>,
    /// `turn.wake`(S5.4 A3) — `post` 에 더해 `turn_wake::TURN_WAKE_PRIVILEGES`. 없으면 TS 로(게시 전에).
    pub wake: Option<std::sync::Arc<crate::core::msg_post::PostState>>,
    /// `artifact.publish` 새 안(v1) 게시 — `post` 에 더해 `artifact_write::ARTIFACT_PUBLISH_PRIVILEGES`·업로드 권한·첨부 저장소.
    /// 없으면 거절 앞머리만 Rust, 게시는 TS.
    pub artifact: Option<std::sync::Arc<super::artifact_publish::ArtifactWrite>>,
    /// `skill.propose`(S5.4 MCP 3) — `post` 에 더해 `skill_propose::SKILL_PROPOSE_PRIVILEGES`.
    pub skill: Option<std::sync::Arc<crate::core::msg_post::PostState>>,
    /// `message.post` 의 비지 않은 `agentModels`(S5.4 lane c) — `post` 에 더해 `agent_model_picks::AGENT_MODEL_PICKS_PRIVILEGES`.
    /// 없으면 거절 앞머리만 Rust, 고르기 쓰기는 TS.
    pub agent_picks: Option<std::sync::Arc<crate::core::msg_post::PostState>>,
    /// AC5 안전판 — 릴레이가 Rust 오퍼레이터 코어와 함께 옮겨졌다. 그 동안 TS 의 릴레이 허브는 비어 있어 `turn.cancel` 이
    /// 아무 턴도 못 찾고 성공처럼 답하므로, Rust 가 `operator_core_moved` 로 거절한다([`super::route::TURN_CANCEL`]).
    pub relay_moved: bool,
    /// `/mcp` 입장 확인의 비밀 값 검사(TS `/mcp/admit` 의 leakGuard) — 업로드 검사와 같은 판정·권한(`leak_guard::privileges`).
    /// 없으면(권한·키 env 가 안 맞음) 그 검사는 TS `/mcp/admit` 이 한다.
    pub leak: Option<std::sync::Arc<crate::core::leak_guard::LeakGuard>>,
    /// `turn.cancel` 을 Rust 허브로 답할 릴레이 코어. 릴레이 줄이 `McpWrites` 뒤에 서므로 그때 채운다. 비어 있으면
    /// (`relay_moved` 인데 아직 안 채워짐) 옛 안전판처럼 `operator_core_moved` 로 거절한다.
    pub relay:
        std::sync::Arc<std::sync::OnceLock<std::sync::Arc<crate::core::relay_routes::RelayCore>>>,
    /// P2 — `/mcp` 요청을 생존 신호로 쓰는 presence(릴레이 줄이 만드는 것과 같은 [`crate::core::relay_live::PresenceMark`]).
    /// 릴레이 줄이 `McpWrites` 뒤에 서므로 그때 채운다. 비어 있으면 입장 확인은 TS `/mcp/admit` 이 한다(그쪽이 mark 한다).
    pub presence:
        std::sync::Arc<std::sync::OnceLock<std::sync::Arc<crate::core::relay_live::PresenceMark>>>,
    /// P2 — 입장 확인 답의 조건부 칸(TS `toolRegisteredNow`·`backgroundEnabled`)을 Rust env 로 정한다. env 가 없으면 `None` 이고 그 도구는
    /// TS `/mcp/admit` 에 묻는다(앞단과 TS 의 env 가 갈릴 수 있으니 값이 있을 때만 믿는다).
    pub switches: super::route::AdmitSwitches,
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
    if tool == "inbox.poll" {
        let versioned = args.get("version").is_some();
        let waiting = args
            .get("timeoutMs")
            .is_some_and(|v| v.as_f64() != Some(0.0));
        let leasing = args.get("lease").is_some();
        // 접기·수령 풀이 있으면 빈 즉답 폴도 여기서 — `tools::answer` 는 쓰지 않는다.
        if versioned || waiting || leasing || writes.inbox_poll_write.is_some() {
            let write = match (versioned, writes.runner_version.as_ref()) {
                (false, _) => None,
                (true, Some(w)) => Some(w),
                (true, None) => return Some(None),
            };
            let hub = match (waiting, writes.inbox_hub.as_ref()) {
                (false, _) => None,
                (true, Some(h)) => Some(h),
                (true, None) => return Some(None),
            };
            let lease = match (leasing, writes.inbox_lease.as_ref()) {
                (false, _) => None,
                (true, Some(w)) => Some(w),
                (true, None) => return Some(None),
            };
            let fold = writes.inbox_poll_write.as_ref();
            return Some(
                super::inbox_poll::answer_full(read, write, hub, lease, fold, me, args).await,
            );
        }
    }
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
    if tool == "thread.plan" {
        if !writes.plan_read {
            return Some(None);
        }
        if args.get("plan").is_some() {
            let Some(w) = writes.plan_write.as_ref() else {
                return Some(None);
            };
            return Some(
                super::plan_write::answer_set(read, w, writes.plan_auto_off.as_deref(), me, args)
                    .await,
            );
        }
        return Some(super::plan_read::answer(read, me, args).await);
    }
    if tool == "thread.plan.item" {
        let Some(w) = writes.plan_write.as_ref().filter(|_| writes.plan_read) else {
            return Some(None);
        };
        return Some(
            super::plan_write::answer_item(read, w, writes.plan_auto_off.as_deref(), me, args)
                .await,
        );
    }
    if tool == "workitem.remove" {
        let Some(write) = writes.work_item.as_ref() else {
            return Some(None);
        };
        return Some(super::workitem::remove(read, write, me, args).await);
    }
    if tool == "skill.propose" {
        let Some(st) = writes.skill.as_ref() else {
            return Some(None);
        };
        return Some(super::skill_propose::answer(st, me, args).await);
    }
    if tool == "message.ask" {
        return Some(super::message_ask::answer(read, me, args).await);
    }
    if tool == "artifact.publish" {
        return Some(super::artifact_publish::answer(read, me, args).await);
    }
    if tool == "permission.request" {
        return Some(super::permission_request::answer(read, me, args).await);
    }
    if tool == "grant.delegate" {
        let Some(write) = writes.grant_delegate.as_ref() else {
            return Some(None);
        };
        return Some(super::grant_delegate::answer(read, write, me, args, cause).await);
    }
    if tool == "automation.run" {
        let Some(write) = writes.automation_run.as_ref() else {
            return Some(None);
        };
        return Some(super::automation_run::answer(read, write, me, args, cause).await);
    }
    if tool == "automation.propose" {
        let Some(write) = writes.automation.as_ref() else {
            return Some(None);
        };
        return Some(super::automation_propose::answer(read, write, me, args).await);
    }
    if tool == "pr.watch" {
        let Some(write) = writes.pr_watch.as_ref() else {
            return Some(None);
        };
        return Some(super::pr_watch::answer(write, me, args).await);
    }
    if tool == "workitem.upsert" {
        let Some(write) = writes.work_item_upsert.as_ref() else {
            return Some(None);
        };
        return Some(super::workitem::upsert(read, write, me, args).await);
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
    use crate::core::ask_bundle_add::{Added, add, parse_args, refusal_json};
    let a = parse_args(args)?;
    // 새 묶음은 글 올리기 풀로([`super::msg_post::answer_bundle_new`]) — 여기 왔으면 그 풀이 없다는 뜻이라 TS.
    a.bundle?;
    match add(read, write, me, &a, cause).await {
        Ok(Added::Handoff) => None,
        Ok(Added::Forbidden) => Some(err("forbidden", "not a member of this dm channel")),
        Ok(Added::Refused(code, root)) => Some(ok_text(&refusal_json(code, root.as_deref()))),
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
        .map(|v| super::tools::js_int(v).filter(|n| (-JS_SAFE_INT..=JS_SAFE_INT).contains(n)))
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
            // `thread.note`·`thread.plan` 은 인자에 따라 읽기·쓰기가 갈리는 도구(Access 표의 ReadSide)다.
            let want = if *n == "thread.note" || *n == "thread.plan" {
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
        assert_eq!(inbox_ids(&json!({"ids": [1.0]})), Some(vec![1]));
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
            // C3b-2c-4b 부터 `MARK_SETTLED_QUIETLY_SQL` 상수다(문장은 그대로).
            "`update team_delegation d set notified_at = now()\n      where d.id = any($1::uuid[]) and d.notified_at is null\n        and not exists (select 1 from team_delegation_item i where i.delegation_id = d.id and i.outcome is null)`;",
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
