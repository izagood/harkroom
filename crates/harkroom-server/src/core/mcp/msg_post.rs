//! S5.3 C1c-4c — MCP `message.post` 의 몸통. TS `mcp/mcpPlugin.ts` 의 같은 도구를 옮긴다: 채널 가시성 → 모델 신고 meta →
//! `postMessage`(원인 입력과 함께, [`crate::core::msg_post::post_in_tx`]) → `postedResult`.
//!
//! - **TS 로 넘기는 것**(`None` — 아무것도 쓰지 않았다): zod 가 받지 않을 인자(모양을 모르면 넘긴다) · 비지 않은 `agentModels` 중 고르기 쓰기 권한이
//!   없을 때(거절 갈래만 [`picks_refusal`] 이 답한다 — 권한이 있으면 [`answer_picks`] 가 글과 같은 tx 에서 `applyAgentPicks` 까지 맡는다) · 자른 자리가 서로게이트 쌍을 가르는 모델 신고([`cause_link::trimmed_model`]) · `post_in_tx` 가 TS 몫이라고 한
//!   글(상한에 막힌 부름·암묵 위임을 모르는 부름·TS 몫 스레드) · DB 오류(트랜잭션이 버려져 아무것도 남지 않았다 — TS 가 같은 요청을 다시 돈다).
//! - REST 와 다른 점(TS 와 같다): 보관된 채널도 막지 않는다(`assertChannelVisible` 만) · 링크 미리보기·글 승인이 없어 본문 가드가
//!   없다 — 그래서 메시지 링크가 든 글도 Rust 가 맡고, 정체 판정의 「같은 대화 링크」 갈래가 여기서 닿는다 · 재시도 키가 없다 ·
//!   본문 공백 거절(refine)이 없다(`min(1)` 만).
//! - 원인: `cause`(모양만 본 헤더)는 깊이에, 사슬 고리·principal·위임·`meta.turnId` 는 **오퍼레이터를 거친 요청**의 헤더만(TS
//!   `chainCause`·`storedTurnId`).
use super::tools::err;
use crate::auth::Account;
use crate::core::audience::audience_for;
use crate::core::cause_link;
use crate::core::msg_edit::MAX_MESSAGE_BODY_CHARS;
use crate::core::msg_post::{self, Origin, Outcome, PostBody, PostState};
use crate::core::msg_read::{channel_visible, is_uuid};
use serde_json::{Map, Value};

/// zod `attachmentIds.max(10)`.
const MAX_ATTACHMENTS: usize = 10;

/// TS `BAD_THREAD_MESSAGE`.
const BAD_THREAD: &str = "threadRootId must be a top-level message in this channel";

/// zod 가 받는 인자. 모르는 키는 zod 처럼 버린다.
#[derive(Debug, PartialEq, Eq)]
struct Args {
    channel: String,
    post: PostBody,
    /// 다듬은 모델 신고(빈 값이면 없음).
    model: Option<String>,
}

/// zod `inputSchema` 를 그대로 받는 인자만 `Some`. 틀린 꼴·비지 않은 `agentModels`·서로게이트 쌍이 갈리는 모델은 `None`(→ TS 가 검증 오류나 그 갈래를 낸다).
fn parse(args: &Value) -> Option<Args> {
    let Value::Object(o) = args else { return None };
    // 빈 `agentModels` 는 TS 에서도 고를 것이 없어(`cleanPicks([])` → `beforeCommit` 없음) 없는 것과 같다. 고르는 갈래만 TS 몫.
    match o.get("agentModels") {
        None => {}
        Some(Value::Array(a)) if a.is_empty() => {}
        Some(_) => return None,
    }
    let channel = o
        .get("channelId")?
        .as_str()
        .filter(|s| is_uuid(s))?
        .to_owned();
    let body = o.get("body")?.as_str()?;
    let n = body.encode_utf16().count();
    if n == 0 || n > MAX_MESSAGE_BODY_CHARS {
        return None;
    }
    let thread_root = match o.get("threadRootId") {
        None => None,
        Some(Value::String(r)) if is_uuid(r) => Some(r.clone()),
        _ => return None,
    };
    let also = match o.get("alsoInChannel") {
        None => false,
        Some(Value::Bool(b)) => *b,
        _ => return None,
    };
    let attachment_ids = match o.get("attachmentIds") {
        None => vec![],
        Some(Value::Array(a)) if a.len() <= MAX_ATTACHMENTS => {
            let mut ids = Vec::with_capacity(a.len());
            for x in a {
                ids.push(x.as_str().filter(|s| is_uuid(s))?.to_owned());
            }
            ids
        }
        _ => return None,
    };
    let model = match o.get("model") {
        None => None,
        Some(Value::String(m)) => {
            let n = m.encode_utf16().count();
            if n == 0 || n > cause_link::MODEL_ID_MAX {
                return None;
            }
            cause_link::trimmed_model(m)?
        }
        _ => return None,
    };
    Some(Args {
        channel,
        post: PostBody {
            body: body.to_owned(),
            attachment_ids,
            // TS `postMessage` — 머리가 없으면 false.
            also_in_channel: also && thread_root.is_some(),
            thread_root,
        },
        model,
    })
}

/// TS `postedResult` — 못 부른 이름(호출 범위 밖)을 앞세운다. 사슬 상한에 막힌 부름은 없다(O1).
fn posted_result(row: &str, notified: &[String], extra: &str) -> Option<String> {
    let v: Value = serde_json::from_str(row).ok()?;
    let handles = |key: &str| -> Vec<String> {
        v.pointer(key)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(|h| format!("@{h}"))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut warnings: Vec<String> = Vec::new();
    let denied = handles("/meta/mentionDenied");
    // 행 글자는 그대로 싣는다 — 키 순서가 TS `JSON.stringify(row)` 와 같다(REST 응답과 같은 글자).
    let notified = Value::from(notified.to_vec()).to_string();
    if !denied.is_empty() {
        warnings.push(format!(
            "{} 를 부르지 못했다: 너는 그 에이전트의 호출 범위(invokeScope) 밖이다. 사람에게 message.ask 로 넘기거나 소유자에게 호출 범위를 물어라.",
            denied.join(", ")
        ));
    }
    let inner = if warnings.is_empty() {
        format!("{{\"message\":{row},\"notified\":{notified}{extra}}}")
    } else {
        format!(
            "{{\"warnings\":{},\"message\":{row},\"notified\":{notified}{extra}}}",
            Value::from(warnings)
        )
    };
    Some(super::respond::text_result(&super::respond::minify(&inner)))
}

/// `message.post`. `operator` 는 이 요청이 오퍼레이터를 거쳤는가(TS `operatorId`).
pub async fn answer(
    st: &PostState,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    let a = parse(args)?;
    post(
        st,
        me,
        a,
        Map::new(),
        Kind::User,
        false,
        false,
        cause,
        turn,
        operator,
        None,
    )
    .await
}

/// MCP `artifact.publish` 의 게시([`super::artifact_publish::publish`]) — 페이지(·표지) 첨부를 붙인 글을 `artifact` 훅과 같은 tx 로 올린다.
#[allow(clippy::too_many_arguments)]
pub(super) async fn answer_artifact(
    st: &PostState,
    me: &Account,
    channel: &str,
    post_body: PostBody,
    model: Option<String>,
    hook: &super::artifact_write::NewArtifact,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    let a = Args {
        channel: channel.to_owned(),
        post: post_body,
        model,
    };
    post(
        st,
        me,
        a,
        Map::new(),
        Kind::User,
        false,
        false,
        cause,
        turn,
        operator,
        Some(hook),
    )
    .await
}

/// zod `AGENT_MODELS_ARG` 한 칸 — `{ agentId: uuid, model?: string(≤MODEL_ID_MAX)|null, effort?: string(≤64)|null }`.
pub(crate) type Pick = (String, Option<String>, Option<String>);

pub(crate) fn parse_picks(v: &Value) -> Option<Vec<Pick>> {
    let a = v.as_array()?;
    if a.len() > 8 {
        return None;
    }
    let axis = |o: &Map<String, Value>, k: &str, max: usize| -> Option<Option<String>> {
        match o.get(k) {
            None | Some(Value::Null) => Some(None),
            Some(Value::String(s)) if s.encode_utf16().count() <= max => Some(Some(s.clone())),
            _ => None,
        }
    };
    a.iter()
        .map(|p| {
            let o = p.as_object()?;
            let id = o
                .get("agentId")?
                .as_str()
                .filter(|s| is_uuid(s))?
                .to_owned();
            Some((
                id,
                axis(o, "model", cause_link::MODEL_ID_MAX)?,
                axis(o, "effort", 64)?,
            ))
        })
        .collect()
}

/// `message.post` 에 비지 않은 `agentModels` 가 왔을 때 TS `preparePicks` 까지의 거절(채널 가시성 → `cleanPicks` →
/// `axisValid`(`bad_model_value`) → `checkOffered`(`model_not_offered`·`effort_not_offered`))만 Rust 가 답한다. 모두 지나면 `None`
/// (→ TS 가 게시 트랜잭션 안의 `applyAgentPicks` 와 함께 처음부터 돈다 — 여기서는 읽기만 했다). 하네스 목록은 능력 스냅숏만 보므로
/// 오퍼레이터 코어가 Rust 일 때(`relay_moved`)만 부른다. 인자가 zod 를 못 지나거나 DB 오류여도 `None`.
pub async fn picks_refusal(st: &PostState, me: &Account, args: &Value) -> Option<String> {
    let picks = parse_picks(args.get("agentModels")?)?;
    if picks.is_empty() {
        return None;
    }
    let mut rest = args.clone();
    rest.as_object_mut()?.remove("agentModels");
    let a = parse(&rest)?;
    match channel_visible(&st.read, &me.id, &a.channel).await {
        Ok(true) => {}
        Ok(false) => return Some(err("forbidden", "not a member of this dm channel")),
        Err(_) => return None,
    }
    check_picks(st, &picks).await?
}

/// TS `preparePicks` 의 `axisValid`·`checkOffered` — `Some(Some(거절))`·`Some(None)`(지났다)·`None`(DB 오류).
/// `message.delegate` 도 같은 판정을 쓴다.
pub(crate) async fn check_picks(st: &PostState, picks: &[Pick]) -> Option<Option<String>> {
    use crate::core::thread_model_set::{axis_valid, check_offered, clean_axis};
    for (agent, model, effort) in picks {
        let model = clean_axis(model.as_deref(), cause_link::MODEL_ID_MAX);
        let effort = clean_axis(effort.as_deref(), 64);
        if model.is_none() && effort.is_none() {
            continue;
        }
        if !axis_valid(model.as_deref()) || !axis_valid(effort.as_deref()) {
            return Some(Some(err(
                "bad_model_value",
                "모델·effort 는 영숫자로 시작하고 영숫자·._:/[]- 만 쓴다",
            )));
        }
        if let Err((code, message)) =
            check_offered(&st.write, agent, model.as_deref(), effort.as_deref())
                .await
                .ok()?
        {
            return Some(Some(err(code, &message)));
        }
    }
    Some(None)
}

/// `message.post` + 비지 않은 `agentModels` — 거절 앞머리([`picks_refusal`]) 뒤 글과 같은 tx 에서 TS `applyAgentPicks` 를 돈다
/// ([`crate::core::agent_model_picks::AgentPicks`]). 바뀐 줄은 커밋 뒤 시스템 줄·이벤트. 인자가 zod 를 못 지나거나 DB 오류면 `None`(→ TS).
pub async fn answer_picks(
    st: &PostState,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    use crate::core::agent_model_picks::{AgentPicks, Pick};
    use crate::core::thread_model_set::clean_axis;
    if let Some(refused) = picks_refusal(st, me, args).await {
        return Some(refused);
    }
    let raw = parse_picks(args.get("agentModels")?)?;
    let mut rest = args.clone();
    rest.as_object_mut()?.remove("agentModels");
    let a = parse(&rest)?;
    let picks: Vec<Pick> = raw
        .into_iter()
        .map(|(agent_id, model, effort)| Pick {
            agent_id,
            model: clean_axis(model.as_deref(), cause_link::MODEL_ID_MAX),
            effort: clean_axis(effort.as_deref(), 64),
        })
        .collect();
    let hook = AgentPicks::new(&a.channel, a.post.thread_root.as_deref(), &me.id, picks);
    post_with(
        st,
        me,
        a,
        Map::new(),
        Kind::User,
        false,
        false,
        cause,
        turn,
        operator,
        None,
        &[],
        None,
        Some(&hook),
        None,
        None,
    )
    .await
}

/// 글 종류 — TS `postMessage` 의 `kind`·`serverNotice` 조합.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// `message.post`·`fail`·`report`.
    User,
    /// `message.progress` — `kind: 'progress'`.
    Progress,
    /// `message.notice` — `kind: 'system'` + `serverNotice`, 원인·턴·모델 신고 없음.
    Notice,
}

/// zod `message.progress` 의 `inputSchema`(channelId·body·threadRootId·model). 모르는 키는 zod 처럼 버린다 — `attachmentIds`·
/// `alsoInChannel`·`agentModels` 도 이 도구에는 없는 키라 버린다(첨부를 붙이거나 채널에 올리지 않는다).
fn parse_progress(args: &Value) -> Option<Args> {
    let Value::Object(o) = args else { return None };
    let kept: Map<String, Value> = o
        .iter()
        .filter(|(k, _)| matches!(k.as_str(), "channelId" | "body" | "threadRootId" | "model"))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    parse(&Value::Object(kept))
}

/// S5.4 A1 — `message.progress`. 결과가 아닌 진행 한 줄([`Origin::progress`]).
pub async fn answer_progress(
    st: &PostState,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    let a = parse_progress(args)?;
    post(
        st,
        me,
        a,
        Map::new(),
        Kind::Progress,
        false,
        false,
        cause,
        turn,
        operator,
        None,
    )
    .await
}

/// TS `RUNNER_NOTICE_MAX_PENDING`.
const NOTICE_MAX_PENDING: i64 = 9999;
/// TS `SYSTEM_I18N_MAX_ARG_LENGTH` — `systemI18n` 이 글자 인자를 자르는 길이(UTF-16).
const I18N_MAX_ARG: usize = 200;

/// zod `message.notice` 의 인자.
#[derive(Debug, PartialEq, Eq)]
struct NoticeArgs {
    channel: String,
    thread_root: Option<String>,
    key: String,
    handle: Option<String>,
    pending: Option<i64>,
}

/// zod `message.notice` 의 `inputSchema`. 틀린 꼴이면 `None`(→ TS 가 검증 오류를 낸다).
fn parse_notice(args: &Value) -> Option<NoticeArgs> {
    let Value::Object(o) = args else { return None };
    let channel = o
        .get("channelId")?
        .as_str()
        .filter(|s| is_uuid(s))?
        .to_owned();
    let thread_root = match o.get("threadRootId") {
        None => None,
        Some(Value::String(r)) if is_uuid(r) => Some(r.clone()),
        _ => return None,
    };
    let key = o
        .get("key")?
        .as_str()
        .filter(|k| matches!(*k, "blocked_by_turn" | "fenced" | "controlled"))?
        .to_owned();
    let handle = match o.get("handle") {
        None => None,
        Some(Value::String(h)) if h.encode_utf16().count() <= 64 => Some(h.clone()),
        _ => return None,
    };
    // zod `int().min(1).max(9999)` — `3.0` 처럼 JS 에서 정수인 소수도 받는다.
    let pending = match o.get("pending") {
        None => None,
        Some(v) => Some(super::tools::js_int(v).filter(|n| (1..=NOTICE_MAX_PENDING).contains(n))?),
    };
    Some(NoticeArgs {
        channel,
        thread_root,
        key,
        handle,
        pending,
    })
}

/// TS `HANDLE_RE` `/^[A-Za-z0-9_.-]{1,64}$/`.
fn notice_handle(h: Option<&str>) -> Option<&str> {
    h.filter(|h| {
        (1..=64).contains(&h.len())
            && h.bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b'-'))
    })
}

/// TS `runnerNotice(key, agentId, { handle, pending })` — 본문과 `meta.i18n`. 서버가 짓는다(자유 본문을 받지 않는다).
fn runner_notice(n: &NoticeArgs, agent: &str) -> (String, Value) {
    let clip = |s: &str| -> String {
        // TS `slice(0, 200)` 은 UTF-16 단위 — handle 은 ASCII 라 바이트와 같다. agentId 는 uuid 다.
        s.chars().take(I18N_MAX_ARG).collect()
    };
    match n.key.as_str() {
        "blocked_by_turn" => (
            "(이 스레드에서 앞 턴이 아직 돌고 있습니다 — 이 글은 그 턴이 끝나면 읽습니다. 바로 멈추려면 도는 턴 목록이나 그 턴의 터미널 창에서 「멈추기」를 누르세요)".to_owned(),
            serde_json::json!({ "key": "system.runner.blockedByTurn", "args": { "agentId": clip(agent) } }),
        ),
        "fenced" => (
            "(다른 러너가 이 스레드를 넘겨받아 이 턴을 접었다 — 이 러너가 서버와 끊긴 사이 스레드 임대가 만료됐다. 남은 일은 넘겨받은 쪽이 잇는다)".to_owned(),
            serde_json::json!({ "key": "system.runner.fenced", "args": { "agentId": clip(agent) } }),
        ),
        _ => {
            let handle = notice_handle(n.handle.as_deref());
            let pending = n.pending.unwrap_or(1).clamp(1, NOTICE_MAX_PENDING);
            let body = format!(
                "(지금 {} 이(가) 직접 조종 중입니다 — 이 멘션은 대기 {pending}건째입니다. 조종이 끝나면 처리합니다: 터미널에서 하네스를 종료하거나, Agents 탭에서 「조종 끝내기」)",
                handle.unwrap_or("소유자")
            );
            let i18n = match handle {
                Some(h) => serde_json::json!({ "key": "system.runner.controlled", "args": { "agentId": clip(agent), "handle": clip(h), "pending": pending } }),
                None => serde_json::json!({ "key": "system.runner.controlledByOwner", "args": { "agentId": clip(agent), "pending": pending } }),
            };
            (body, i18n)
        }
    }
}

/// S5.4 A1 — `message.notice`(러너 알림 줄). `runner` 는 [`super::bg_claim::runner`](오퍼레이터를 거쳤고 원인·턴 헤더가 원시값으로도
/// 없다). 오퍼레이터를 안 거쳤으면 TS 와 같이 `runner_only` 다. 거쳤는데 헤더가 있으면(꼴이 틀린 헤더는 TS 가 「없음」으로 볼 수 있다)
/// TS 에 넘긴다 — 좁히는 쪽으로만 틀린다.
pub async fn answer_notice(
    st: &PostState,
    me: &Account,
    args: &Value,
    operator: bool,
    runner: bool,
) -> Option<String> {
    let n = parse_notice(args)?;
    if !operator {
        return Some(err("runner_only", "message.notice 는 러너만 부른다"));
    }
    if !runner {
        return None;
    }
    let (body, i18n) = runner_notice(&n, &me.id);
    let mut meta = Map::new();
    meta.insert("i18n".into(), i18n);
    let a = Args {
        channel: n.channel,
        post: PostBody {
            body,
            attachment_ids: Vec::new(),
            also_in_channel: false,
            thread_root: n.thread_root,
        },
        model: None,
    };
    post(
        st,
        me,
        a,
        meta,
        Kind::Notice,
        false,
        false,
        None,
        None,
        operator,
        None,
    )
    .await
}

/// `message.fail` 의 zod 인자 중 Rust 가 맡는 것 — 표지(`code`) 없는 실패만(C3b-2c-1).
#[derive(Debug, PartialEq, Eq)]
struct FailArgs {
    args: Args,
    retryable: bool,
    what: Option<String>,
    reason: Option<String>,
    /// zod `z.enum(FAILURE_CODES)` — 넷 다 Rust 가 맡는다(`account_gate` 는 차례 주인·inbox 까지, [`GateNotify`]).
    code: Option<&'static str>,
    /// `account_gate` 의 차례 주인 재료 — 그 턴을 띄운 멘션과 관문이 선 풀·계정 순번. 다른 표지에서는 읽고 버린다.
    mention_id: Option<String>,
    pool_rank: Option<i64>,
    account_rank: Option<i64>,
    /// zod `z.enum(PROVIDER_LANE_FAILURE_CODES)` — `code` 와 상관없이 받되 meta 에는 `provider_lane` 일 때만 붙는다.
    lane_code: Option<&'static str>,
}

/// TS `FAILURE_CODES` 중 Rust 가 답하는 것 — 전부.
const RUST_FAILURE_CODES: &[&str] = &[
    "thread_model_rejected",
    "provider_lane",
    "inject_unconfirmed",
    "account_gate",
];

/// TS `getThreadAgentModel(...)?.stale` — 그 스레드에 이 에이전트의 모델 지정이 있으면 `Some(stale)`.
const THREAD_AGENT_MODEL_STALE_SQL: &str = "select (t.harness is distinct from coalesce(c.harness, 'claude-code')) \
     from thread_agent_model t left join agent_config c on c.account_id = t.agent_id \
     where t.thread_root_id = $1::uuid and t.agent_id = $2::uuid";

/// 문자열 칸 `z.string().min(1).max(n).optional()` — 없으면 `Some(None)`, 틀린 꼴이면 `None`(→ TS 가 검증 오류를 낸다).
fn opt_str(o: &Map<String, Value>, key: &str, max: usize) -> Option<Option<String>> {
    match o.get(key) {
        None => Some(None),
        Some(Value::String(v)) => {
            let n = v.encode_utf16().count();
            (n >= 1 && n <= max).then(|| Some(v.clone()))
        }
        _ => None,
    }
}

/// zod `message.fail` 의 `inputSchema`. 표지(`code`) 넷을 모두 Rust 가 맡는다.
/// **TS 로 넘기는 것**: 목록 밖 `code`·`laneCode`(zod 오류 글자).
/// 차례 주인 재료(`mentionId`·`claudePoolRank`·`claudeAccountRank`)는 `account_gate` 일 때만 쓴다 — 그 밖에는 zod 꼴만
/// 보고 버린다(러너의 침묵·혼자 꺼짐·보고 누락 통지가 `mentionId` 만 싣는다). 꼴이 틀리면 zod 오류 글자를 위해 TS 로 넘긴다.
/// 옛 러너의 `account` 도 zod 처럼 받고 버린다.
fn parse_fail(args: &Value) -> Option<FailArgs> {
    let Value::Object(o) = args else { return None };
    let code = match o.get("code") {
        None => None,
        Some(Value::String(c)) => Some(*RUST_FAILURE_CODES.iter().find(|k| **k == c)?),
        _ => return None,
    };
    let lane_code = match o.get("laneCode") {
        None => None,
        Some(Value::String(c)) => Some(
            *harkroom_proto::p1::PROVIDER_LANE_FAILURE_CODES
                .iter()
                .find(|k| **k == c)?,
        ),
        _ => return None,
    };
    let mention_id = match o.get("mentionId") {
        None => None,
        Some(Value::String(m)) if is_uuid(m) => Some(m.clone()),
        _ => return None,
    };
    for k in ["claudePoolRank", "claudeAccountRank"] {
        if o.get(k).is_some_and(|v| !zod_rank(v)) {
            return None;
        }
    }
    let rank = |k: &str| o.get(k).and_then(Value::as_f64).map(|f| f as i64);
    let (pool_rank, account_rank) = (rank("claudePoolRank"), rank("claudeAccountRank"));
    let retryable = match o.get("retryable") {
        Some(Value::Bool(b)) => *b,
        _ => return None,
    };
    let what = opt_str(o, "what", 500)?;
    let reason = opt_str(o, "reason", 1000)?;
    match o.get("account") {
        None => {}
        Some(Value::String(a)) if a.encode_utf16().count() <= 80 => {}
        _ => return None,
    }
    // 글 칸(채널·본문·머리·모델)은 `message.post` 와 같은 zod 다. fail 에 없는 칸은 zod 가 버리므로 걸러 낸 뒤 넘긴다.
    let mut base = Map::new();
    for k in ["channelId", "body", "threadRootId", "model"] {
        if let Some(v) = o.get(k) {
            base.insert(k.to_owned(), v.clone());
        }
    }
    let args = parse(&Value::Object(base))?;
    Some(FailArgs {
        args,
        retryable,
        what,
        reason,
        code,
        mention_id,
        pool_rank,
        account_rank,
        lane_code,
    })
}

/// zod `z.number().int().min(1).max(99)` — JSON 수 중 소수부 없는 1~99(`3.0` 도 int 로 받는다).
fn zod_rank(v: &Value) -> bool {
    v.as_f64()
        .is_some_and(|f| f.fract() == 0.0 && (1.0..=99.0).contains(&f))
}

/// TS `FailureMeta` 의 `failure` — `{ retryable, what?, reason?, code?, awaitingAccountId?, claudePoolRank?, claudeAccountRank?, laneCode? }`.
/// `keep_code` 는 TS `keepCode`(`thread_model_rejected` 는 살아 있는 스레드 모델 지정이 있을 때만, 다른 표지는 늘 참).
/// 차례 주인·순번은 `account_gate` 에만, `laneCode` 는 `provider_lane` 에만 붙는다.
fn failure_meta(f: &FailArgs, keep_code: bool, awaiting: Option<&str>) -> Map<String, Value> {
    let mut failure = Map::new();
    failure.insert("retryable".into(), Value::Bool(f.retryable));
    if let Some(w) = &f.what {
        failure.insert("what".into(), Value::String(w.clone()));
    }
    if let Some(r) = &f.reason {
        failure.insert("reason".into(), Value::String(r.clone()));
    }
    if let Some(c) = f.code.filter(|_| keep_code) {
        failure.insert("code".into(), Value::String(c.into()));
        if c == "account_gate" {
            if let Some(a) = awaiting {
                failure.insert("awaitingAccountId".into(), Value::String(a.into()));
            }
            if let Some(r) = f.pool_rank {
                failure.insert("claudePoolRank".into(), Value::from(r));
            }
            if let Some(r) = f.account_rank {
                failure.insert("claudeAccountRank".into(), Value::from(r));
            }
        }
        if let Some(l) = f.lane_code.filter(|_| c == "provider_lane") {
            failure.insert("laneCode".into(), Value::String(l.into()));
        }
    }
    let mut meta = Map::new();
    meta.insert("kind".into(), Value::String("failure".into()));
    meta.insert("failure".into(), Value::Object(failure));
    meta
}

/// `message.fail`(C3b-2c-1) — TS 와 같이 채널 가시성 → 실패 meta + 모델 신고 → `postMessage` → `postedResult`. 작성자가 담당인 안 닫힌
/// 위임 항목이 이 스레드에 있으면(실패가 그 항목을 닫는다) 코어가 TS 로 넘긴다([`Origin::closes_delegation`]).
pub async fn answer_fail(
    st: &PostState,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    let f = parse_fail(args)?;
    let keep_code = match f.code {
        Some("thread_model_rejected") => match &f.args.post.thread_root {
            None => false,
            Some(root) => sqlx::query_scalar::<_, bool>(THREAD_AGENT_MODEL_STALE_SQL)
                .bind(root)
                .bind(&me.id)
                .fetch_optional(&st.read)
                .await
                .ok()?
                .is_some_and(|stale| !stale),
        },
        _ => true,
    };
    // TS: `account_gate` 의 차례 주인은 서버가 정한다 — 그 턴을 띄운 멘션(`mentionId`, 없으면 원인 헤더)이 이 에이전트를 실제로
    // 깨웠고 작성자가 그 채널을 볼 수 있는 사람일 때만(`gateAwaitingAccount`). 못 정해도 표지는 남긴다.
    let gate = keep_code && f.code == Some("account_gate");
    let awaiting: Option<String> = match f.mention_id.as_deref().or(cause) {
        Some(source) if gate => sqlx::query_scalar(super::message_ask::gate_awaiting_sql())
            .bind(&me.id)
            .bind(source)
            .bind(&f.args.channel)
            .fetch_optional(&st.read)
            .await
            .ok()?,
        _ => None,
    };
    let meta = failure_meta(&f, keep_code, awaiting.as_deref());
    let hook = awaiting.map(|account| GateNotify { account });
    post_with(
        st,
        me,
        f.args,
        meta,
        Kind::User,
        true,
        false,
        cause,
        turn,
        operator,
        None,
        &[],
        None,
        None,
        None,
        hook.as_ref(),
    )
    .await
}

/// TS `notifyGateAwaiting` — 차례 주인이 이 글로 알림을 못 받는 자리(남이 세운 스레드에서 불렀다 등)면 같은 tx 에서
/// inbox 에 `thread_reply` 로 넣는다(숨긴 채널도 다시 보이는 사유). 이미 받았으면 두 번 넣지 않는다.
#[derive(Debug)]
pub(super) struct GateNotify {
    account: String,
}

impl msg_post::BeforeCommit for GateNotify {
    fn run<'a>(
        &'a self,
        tx: &'a mut sqlx::Transaction<'static, sqlx::Postgres>,
        message_id: &'a str,
        notified: &'a std::collections::HashSet<String>,
    ) -> msg_post::BeforeCommitFuture<'a> {
        Box::pin(async move {
            if notified.contains(&self.account) {
                return Ok(None);
            }
            let mut seen = notified.clone();
            crate::core::mention_fanout::insert_inbox_many(
                tx,
                std::slice::from_ref(&self.account),
                message_id,
                "thread_reply",
                &mut seen,
                None,
            )
            .await?;
            Ok(None)
        })
    }
}

/// `message.ask` 의 평범한 카드(사람 앞·거울/머지 거절 없음, `supersedes` 는 글이 선 뒤 닫는다) — [`super::message_ask::answer_plain`] 이 고른 인자와 ask meta 로
/// `message.post` 와 같은 길(가시성 → 모델 신고 → `postMessage` → `postedResult`)을 탄다. `sub` 는 `channelId`·`body`·`model`·`threadRootId` 만.
#[allow(clippy::too_many_arguments)]
pub(super) async fn answer_ask(
    st: &PostState,
    me: &Account,
    sub: &Value,
    meta: Map<String, Value>,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
    supersedes: &[&str],
    plan_step: Option<&str>,
    push_to: Option<&str>,
) -> Option<String> {
    let a = parse(sub)?;
    post_with(
        st,
        me,
        a,
        meta,
        Kind::User,
        false,
        false,
        cause,
        turn,
        operator,
        None,
        supersedes,
        plan_step.map(PlanHook::LinkCard),
        None,
        push_to,
        None,
    )
    .await
}

/// 권한 카드 글([`super::message_ask`] 의 머지 거절 카드) — 세운 글의 id·`notified` 를 돌려준다. 거절(`forbidden`·`bad_thread` 등)은
/// `Err(답)`, 재생·TS 로 넘길 꼴·DB 오류는 `None`(→ TS: 재생이면 TS 가 같은 키로 답한다).
#[allow(clippy::too_many_arguments)]
pub(super) async fn post_card(
    st: &PostState,
    me: &Account,
    sub: &Value,
    meta: Map<String, Value>,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
    before_commit: Option<&dyn msg_post::BeforeCommit>,
) -> Option<Result<(String, Vec<String>), String>> {
    Some(
        match post_service(st, me, sub, meta, cause, turn, operator, before_commit).await? {
            Ok((row, notified)) => Ok((
                serde_json::from_str::<Value>(&row)
                    .ok()?
                    .get("id")?
                    .as_str()?
                    .to_owned(),
                notified,
            )),
            Err(e) => Err(e),
        },
    )
}

/// P6-4e — MCP `message.askBundle` 의 새 묶음(`bundleId` 없음). TS `upsertAskBundle` 의 새 묶음 갈래 + 핸들러:
/// 가시성 → 줄 준비(거울 검사) → `postMessage`(서비스 호출, meta `{...모델 신고, kind: 'askBundle', askBundle: { items }}`)
/// → 커밋 뒤 담긴 원본 알림·묶음 푸시([`crate::core::ask_bundle_add::after_new`]) → `postedResult`.
/// 넘길 원본(권한 거울)·같은 글자를 못 내는 사본·재생·쓰기 전 DB 오류는 `None`(→ TS). `bundle` 은 묶음 권한 풀
/// (`ASK_BUNDLE_ADD_PRIVILEGES`) — 커밋 뒤 알림·푸시를 거기서 쓴다.
#[allow(clippy::too_many_arguments)]
pub(super) async fn answer_bundle_new(
    st: &PostState,
    bundle: &sqlx::PgPool,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    use crate::core::ask_bundle_add::{Added, after_new, parse_args, prepare_new, refusal_json};
    let a = parse_args(args)?;
    if a.bundle.is_some() {
        return None;
    }
    let items = match prepare_new(&st.read, &me.id, &a).await.ok()? {
        Ok(items) => items,
        Err(Added::Forbidden) => return Some(err("forbidden", "not a member of this dm channel")),
        Err(Added::Refused(code, root)) => {
            return Some(super::respond::text_result(&refusal_json(
                code,
                root.as_deref(),
            )));
        }
        Err(Added::Handoff | Added::Bundle(_)) => return None,
    };
    let mut sub = Map::new();
    for k in ["channelId", "threadRootId", "body", "model"] {
        if let Some(v) = args.get(k) {
            sub.insert(k.into(), v.clone());
        }
    }
    let mut meta = Map::new();
    meta.insert("kind".into(), Value::from("askBundle"));
    meta.insert("askBundle".into(), serde_json::json!({ "items": items }));
    let (row, notified) = match post_service(
        st,
        me,
        &Value::Object(sub),
        meta,
        cause,
        turn,
        operator,
        None,
    )
    .await?
    {
        Ok(v) => v,
        Err(e) => return Some(e),
    };
    let id = serde_json::from_str::<Value>(&row)
        .ok()
        .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_owned));
    // 다름(기록): TS 는 알림·푸시 DB 오류를 도구 오류로 던진다. Rust 는 묶음 글이 이미 섰으므로 기록만 하고 글 답을 낸다.
    if let Some(id) = id
        && let Err(e) = after_new(bundle, &me.id, a.channel, &id, &a.roots, &notified, cause).await
    {
        eprintln!("message.askBundle: announce/push for {id} failed: {e}");
    }
    posted_result(&row, &notified, "")
}

/// 서비스 `postMessage` 를 바로 부르는 카드 글(권한 카드·묶음 카드) — 커밋된 글(JSON)과 `notified`. 거절은 `Err(답)`,
/// 재생·TS 로 넘길 꼴·DB 오류는 `None`(→ TS).
#[allow(clippy::too_many_arguments)]
async fn post_service(
    st: &PostState,
    me: &Account,
    sub: &Value,
    mut meta: Map<String, Value>,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
    before_commit: Option<&dyn msg_post::BeforeCommit>,
) -> Option<Result<(String, Vec<String>), String>> {
    let a = parse(sub)?;
    match channel_visible(&st.read, &me.id, &a.channel).await {
        Ok(true) => {}
        Ok(false) => return Some(Err(err("forbidden", "not a member of this dm channel"))),
        Err(_) => return None,
    }
    cause_link::reported_model_meta(
        &st.read,
        &me.id,
        a.model.as_deref(),
        a.post.thread_root.as_deref(),
        &mut meta,
    )
    .await
    .ok()?;
    let is_dm = msg_post::channel_is_dm(&st.read, &a.channel).await.ok()?;
    let audience = audience_for(&st.read, &a.channel).await.ok()?.to_json();
    let origin = Origin {
        plan_auto_stamp: None,
        defer_inbox_events: false,
        chat_ask_rust: false,
        close_asks_after_commit: false,
        cause,
        chain_cause: cause.filter(|_| operator),
        turn_id: turn.filter(|_| operator),
        meta,
        server_notice: false,
        closes_delegation: false,
        delegation: None,
        system: false,
        progress: false,
        wake: false,
        no_mentions: false,
        before_commit,
        // TS 권한 카드(`permissionRequests.ts`)·묶음 카드(`askBundles.ts`)는 서비스 `postMessage` 를 바로 부른다 — 라우트 몫인 글로 카드 고르기
        // (`applyChatApproval`)가 없다. 꺼 두면 스레드에 열린 옛 카드(대체될 권한 카드 등)가 있을 때 [`TS_THREAD_SQL`] 의
        // ask 갈래가 참이 돼 까닭 없이 TS 로 넘어간다(P6-2b bus-e2e 「옛 요청에 카드 → 옛 카드 닫기」).
        service_call: true,
        chain_depth: None,
    };
    let out = msg_post::post_in_tx(
        st,
        &a.channel,
        &me.id,
        me.kind == "agent",
        &a.post,
        None,
        &audience,
        is_dm,
        &origin,
    )
    .await
    .ok()?;
    match out {
        Outcome::ToTs | Outcome::Replayed(_) => None,
        Outcome::Rejected(r) => Some(Err(err(&r.code, &r.message))),
        Outcome::BadThread => Some(Err(err("bad_thread", BAD_THREAD))),
        Outcome::BadAttachment => Some(Err(err(
            "bad_attachment",
            "attachments must be your own, unused uploads",
        ))),
        Outcome::Posted { row, notified, .. } => Some(Ok((row, notified))),
    }
}

/// shared `REPORT_MAX_ITEMS`·`REPORT_MAX_NEXT`.
const REPORT_MAX_ITEMS: usize = 20;
const REPORT_MAX_NEXT: usize = 4;

/// `z.array(z.string().min(1).max(max)).max(REPORT_MAX_ITEMS)` — 없으면 빈 목록, 틀린 꼴이면 `None`.
fn str_list(o: &Map<String, Value>, key: &str, max: usize) -> Option<Vec<String>> {
    match o.get(key) {
        None => Some(Vec::new()),
        Some(Value::Array(a)) if a.len() <= REPORT_MAX_ITEMS => a
            .iter()
            .map(|x| {
                let t = x.as_str()?;
                let n = t.encode_utf16().count();
                (n >= 1 && n <= max).then(|| t.to_owned())
            })
            .collect(),
        _ => None,
    }
}

/// zod `message.report` 의 `inputSchema` → (글 인자, `report` meta). **TS 로 넘기는 것**(fail-closed): `planStepId` 가 있으면(계획 단계
/// 갱신·머리 없음 `bad_request` 는 TS 몫) · zod 가 받지 않을 꼴 · 안전한 정수가 아닌 `durationMs`.
fn parse_report(args: &Value) -> Option<(Args, Map<String, Value>)> {
    let Value::Object(o) = args else { return None };
    // `planStepId` 는 [`answer_report`] 가 따로 읽는다 — 여기서는 zod 꼴만 본다.
    if o.get("planStepId")
        .is_some_and(|v| !super::message_ask::plan_step_ok(v))
    {
        return None;
    }
    let checks = match o.get("checks") {
        Some(_) => str_list(o, "checks", 300).filter(|c| !c.is_empty())?,
        None => return None,
    };
    let files = str_list(o, "files", 400)?;
    let remaining = str_list(o, "remaining", 300)?;
    let duration = match o.get("durationMs") {
        None => None,
        // `int().nonnegative()` — JS 안전 정수 안의 u64 만 맡는다(소수점·큰 수는 TS 가 판정).
        Some(Value::Number(n)) => Some(n.as_u64().filter(|v| *v < (1u64 << 53))?),
        _ => return None,
    };
    let next = match o.get("next") {
        None => Vec::new(),
        Some(Value::Array(a)) if a.len() <= REPORT_MAX_NEXT => {
            let mut out = Vec::with_capacity(a.len());
            for x in a {
                let Value::Object(n) = x else { return None };
                let id = opt_str(n, "id", 64)??;
                let label = opt_str(n, "label", 200)??;
                // z.object 는 모르는 키를 버린다.
                let mut item = Map::new();
                item.insert("id".into(), Value::String(id));
                item.insert("label".into(), Value::String(label));
                out.push(Value::Object(item));
            }
            out
        }
        _ => return None,
    };
    let mut base = Map::new();
    for k in ["channelId", "body", "threadRootId", "model"] {
        if let Some(v) = o.get(k) {
            base.insert(k.to_owned(), v.clone());
        }
    }
    let a = parse(&Value::Object(base))?;
    let mut report = Map::new();
    report.insert("checks".into(), Value::from(checks));
    if !files.is_empty() {
        report.insert("files".into(), Value::from(files));
    }
    if !remaining.is_empty() {
        report.insert("remaining".into(), Value::from(remaining));
    }
    if let Some(d) = duration {
        report.insert("durationMs".into(), Value::from(d));
    }
    if !next.is_empty() {
        report.insert("next".into(), Value::Array(next));
    }
    let mut meta = Map::new();
    meta.insert("kind".into(), Value::String("report".into()));
    meta.insert("report".into(), Value::Object(report));
    Some((a, meta))
}

/// `message.report`(C3b-2c-3) — TS 와 같이 채널 가시성 → 보고 meta + 모델 신고 → `postMessage`(작성자가 담당인 안 닫힌 위임 항목을
/// 같은 tx 에서 닫는다 — C3b-2c-2 코어) → 커밋 뒤 예약 접기 → `postedResult`(+ `foldedWakes`).
pub async fn answer_report(
    st: &PostState,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    let (a, meta) = parse_report(args)?;
    let step = args.get("planStepId").and_then(Value::as_str);
    if step.is_some() {
        // TS 순서: 채널 가시성 → `planStepId` 인데 스레드 없음 `bad_request`.
        if a.post.thread_root.is_none() {
            return match channel_visible(&st.read, &me.id, &a.channel).await {
                Ok(true) => Some(err(
                    "bad_request",
                    "planStepId 는 threadRootId 와 함께 준다(그 스레드의 계획 단계)",
                )),
                Ok(false) => Some(err("forbidden", "not a member of this dm channel")),
                Err(_) => None,
            };
        }
        // 계획 쓰기 권한이 모자란 풀이면 지금처럼 TS(`message.ask` 의 `planStepId` 와 같은 관문).
        if !super::message_ask::plan_step_ready(st).await? {
            return None;
        }
    }
    post_with(
        st,
        me,
        a,
        meta,
        Kind::User,
        true,
        true,
        cause,
        turn,
        operator,
        None,
        &[],
        step.map(PlanHook::Complete),
        None,
        None,
        None,
    )
    .await
}

/// 글이 선 뒤 계획판을 고치는 갈래(TS `threadPlanHooks.ts`).
#[derive(Clone, Copy)]
pub(super) enum PlanHook<'a> {
    /// `message.ask` 의 `planStepId` — 그 단계에 카드를 잇는다.
    LinkCard(&'a str),
    /// `message.report` 의 `planStepId` — 그 단계를 done 으로.
    Complete(&'a str),
}

#[allow(clippy::too_many_arguments)]
async fn post(
    st: &PostState,
    me: &Account,
    a: Args,
    meta: Map<String, Value>,
    kind: Kind,
    closes_delegation: bool,
    fold: bool,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
    artifact: Option<&super::artifact_write::NewArtifact>,
) -> Option<String> {
    post_with(
        st,
        me,
        a,
        meta,
        kind,
        closes_delegation,
        fold,
        cause,
        turn,
        operator,
        artifact,
        &[],
        None,
        None,
        None,
        None,
    )
    .await
}

/// [`post`] 에 `message.ask` 의 대신하기(`supersedes`)를 더한 것 — 새 카드가 선 **뒤**(커밋 뒤, 재생이 아닐 때) TS `supersedeAsk` 처럼
/// 옛 카드를 하나씩 닫는다([`super::message_ask::supersede_ask`]).
#[allow(clippy::too_many_arguments)]
async fn post_with(
    st: &PostState,
    me: &Account,
    a: Args,
    mut meta: Map<String, Value>,
    kind: Kind,
    closes_delegation: bool,
    fold: bool,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
    artifact: Option<&super::artifact_write::NewArtifact>,
    supersedes: &[&str],
    plan_hook: Option<PlanHook<'_>>,
    picks: Option<&crate::core::agent_model_picks::AgentPicks>,
    push_to: Option<&str>,
    gate: Option<&GateNotify>,
) -> Option<String> {
    // TS `if (mirrorOf) await syncAskMirrors(pool, mirrorOf)` — 검사와 발행 사이에 원본이 정해졌으면 새 거울을 곧바로 닫는다.
    let mirror_root = meta
        .get("ask")
        .and_then(|x| x.get("mirrorOf"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    match channel_visible(&st.read, &me.id, &a.channel).await {
        Ok(true) => {}
        Ok(false) => return Some(err("forbidden", "not a member of this dm channel")),
        Err(_) => return None,
    }
    // TS `message.notice` 는 모델 신고를 싣지 않는다(meta 는 `i18n` 하나).
    if kind != Kind::Notice {
        cause_link::reported_model_meta(
            &st.read,
            &me.id,
            a.model.as_deref(),
            a.post.thread_root.as_deref(),
            &mut meta,
        )
        .await
        .ok()?;
    }
    let is_dm = msg_post::channel_is_dm(&st.read, &a.channel).await.ok()?;
    let audience = audience_for(&st.read, &a.channel).await.ok()?.to_json();
    let origin = Origin {
        plan_auto_stamp: None,
        defer_inbox_events: false,
        // 대신하기 카드(P6-4b) — 스레드에 옛 카드가 열려 있으니 [`msg_post::post_in_tx`] 의 카드 답 갈래(`TS_THREAD_SQL`)가 TS 로 넘긴다.
        // 그러나 TS `closeAsksByReply` 는 REST 라우트의 사람 글에서만 불리고(MCP `message.ask` 는 닿지 않는다), 에이전트 글은 Rust 도
        // 카드를 닫지 않는다 — 그래서 에이전트의 대신하기 카드만 그 갈래를 끈다(사람 작성자는 지금처럼 TS).
        chat_ask_rust: !supersedes.is_empty() && me.kind == "agent",
        close_asks_after_commit: false,
        cause,
        chain_cause: cause.filter(|_| operator),
        turn_id: turn.filter(|_| operator),
        meta,
        server_notice: kind == Kind::Notice,
        closes_delegation,
        delegation: None,
        system: kind == Kind::Notice,
        progress: kind == Kind::Progress,
        wake: false,
        no_mentions: false,
        before_commit: artifact
            .map(|h| h as &dyn msg_post::BeforeCommit)
            .or(picks.map(|h| h as &dyn msg_post::BeforeCommit))
            .or(gate.map(|h| h as &dyn msg_post::BeforeCommit)),
        service_call: false,
        chain_depth: None,
    };
    let out = msg_post::post_in_tx(
        st,
        &a.channel,
        &me.id,
        me.kind == "agent",
        &a.post,
        None,
        &audience,
        is_dm,
        &origin,
    )
    .await
    .ok()?;
    match out {
        Outcome::ToTs | Outcome::Replayed(_) => None,
        // TS `failure === 'rejected'` — `{ error: { code, message } }`.
        Outcome::Rejected(r) => Some(err(&r.code, &r.message)),
        Outcome::BadThread => Some(err("bad_thread", BAD_THREAD)),
        Outcome::BadAttachment => Some(err(
            "bad_attachment",
            "attachments must be your own, unused uploads",
        )),
        // 에이전트 글은 새 위임을 만들지 않는다(`mandate` 는 사람 글만) — 감사 줄이 없다.
        Outcome::Posted { row, notified, .. } => {
            // TS: 지정이 바뀌었으면 커밋 뒤 시스템 줄(`byKind: 'agent'`)·`thread.agent_model.changed`. 행은 이미 커밋됐다.
            if let Some((root, changes)) = picks.and_then(|h| h.changes()) {
                for (agent, axes) in &changes {
                    if let Err(e) = crate::core::thread_model_set::announce_agent_pick(
                        st,
                        &a.channel,
                        &root,
                        &me.id,
                        agent,
                        axes.as_ref(),
                    )
                    .await
                    {
                        eprintln!("message.post: agent pick announce failed: {e}");
                    }
                }
            }
            let new_id = serde_json::from_str::<Value>(&row)
                .ok()
                .and_then(|v| v.get("id").and_then(Value::as_str).map(str::to_owned));
            let mut plan_extra = String::new();
            if let Some(new_id) = new_id.clone() {
                if let Some(root) = &mirror_root {
                    let r: Result<(), sqlx::Error> = async {
                        let mut conn = st.write.acquire().await?;
                        crate::core::ask_sync::sync_ask_mirrors(
                            &mut conn,
                            "message.ask mirrorOf",
                            root,
                        )
                        .await
                    }
                    .await;
                    if let Err(e) = r {
                        eprintln!("message.ask: mirror sync for {root} failed: {e}");
                    }
                }
                for old in supersedes {
                    super::message_ask::supersede_ask(&st.write, old, &new_id, &me.id).await;
                }
                // TS: 이름으로 정한 받는 사람이 이 글로 inbox 를 받지 않았으면 `enqueueAskPush`(에이전트면 문장이 아무것도 넣지 않는다).
                if let Some(to) = push_to.filter(|t| !notified.iter().any(|n| n == t))
                    && let Err(e) =
                        sqlx::query(crate::core::permission_card::enqueue_ask_push_sql())
                            .bind(to)
                            .bind(&new_id)
                            .execute(&st.write)
                            .await
                {
                    eprintln!("message.ask: ask push for {new_id} failed: {e}");
                }
            }
            // TS `message.report` — 보고가 선 **뒤**(커밋 뒤) 따로 예약을 접는다. 접기가 막혀도 보고는 되돌리지 않는다(TS `.catch(() => [])`).
            let extra = match (fold, a.post.thread_root.as_deref()) {
                (true, Some(root)) => {
                    let folded = fold_wakes_on_report(&st.write, &me.id, root, origin.turn_id)
                        .await
                        .unwrap_or_default();
                    if folded.is_empty() {
                        String::new()
                    } else {
                        format!(",\"foldedWakes\":[{}]", folded.join(","))
                    }
                }
                _ => match artifact.and_then(|h| h.published()) {
                    // TS `postedResult(message, notified, { artifact: published })`.
                    Some((id, version)) => format!(
                        ",\"artifact\":{{\"artifactId\":{},\"version\":{version}}}",
                        Value::from(id)
                    ),
                    None => String::new(),
                },
            };
            // 계획 단계 갱신은 보고·예약 접기 **뒤**(TS 순서). 답 칸 순서도 TS `{ plan, ...foldedExtra }` 대로 plan 이 먼저다.
            // 재생이 아닐 때만(재생은 TS 가 답한다).
            if let (Some(hook), Some(root), Some(new_id)) =
                (plan_hook, a.post.thread_root.as_deref(), new_id.as_deref())
            {
                let r = match hook {
                    // TS `linkPlanCard`(`message.ask` 의 `planStepId`).
                    PlanHook::LinkCard(step) => {
                        super::plan_write::link_plan_card(
                            &st.write, &me.id, root, &a.channel, step, new_id,
                        )
                        .await
                    }
                    // TS `completePlanStep`(`message.report` 의 `planStepId`).
                    PlanHook::Complete(step) => {
                        super::plan_write::complete_plan_step(
                            &st.write, &me.id, root, &a.channel, step,
                        )
                        .await
                    }
                };
                match r {
                    Ok(plan) => plan_extra = format!(",\"plan\":{plan}"),
                    // 다름(기록): TS 는 이 DB 오류를 도구 오류로 던진다. Rust 는 글이 이미 섰으므로 기록만 하고 `plan` 칸 없이 답한다.
                    Err(e) => eprintln!("mcp: plan hook failed: {e}"),
                }
            }
            posted_result(&row, &notified, &format!("{plan_extra}{extra}"))
        }
    }
}

/// 골든 문장 — TS `FOLD_WAKES_ON_REPORT_SQL`·`STAMP_WAKE_CLOSED_SQL`.
pub(super) fn fold_sql() -> &'static (String, String) {
    static S: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        (frag("fold_wakes_on_report"), frag("stamp_wake_closed"))
    })
}

/// 접힌 예약 한 줄 — TS `closedWatchView` 의 키 순서(`id`·`reason`·`wakeAt`·`messageId`·`threadRootId`·`reportTo?`).
pub(super) fn closed_watch_view(
    id: &str,
    wake_at: &str,
    message_id: &str,
    body: Option<&str>,
    deleted: bool,
    report: Option<&(String, String)>,
    thread_root: &str,
) -> String {
    let s = |x: &str| Value::from(x).to_string();
    let reason = match (deleted, body) {
        (false, Some(b)) => s(b),
        _ => "null".to_owned(),
    };
    let report = report
        .map(|(c, t)| {
            format!(
                ",\"reportTo\":{{\"channelId\":{},\"threadRootId\":{}}}",
                s(c),
                s(t)
            )
        })
        .unwrap_or_default();
    format!(
        "{{\"id\":{},\"reason\":{reason},\"wakeAt\":{},\"messageId\":{},\"threadRootId\":{}{report}}}",
        s(id),
        s(wake_at),
        s(message_id),
        s(thread_root)
    )
}

pub(super) type FoldRow = (
    String,
    String,
    String,
    Option<String>,
    bool,
    Option<Value>,
    String,
);

/// TS `foldWakesOnReport` → `announceReportWakes` → `announceWakeRows` — 작성자의 열린 예약 중 이 스레드에 걸렸거나 이 스레드로 보고하는
/// 것을 접는다(같은 턴이 건 것은 남김). 한 tx 로 접고·닫힌 시각을 적고·신호를 outbox 에 낸다. 돌려주는 것은 `foldedWakes` 의 JSON 조각들.
async fn fold_wakes_on_report(
    write: &sqlx::PgPool,
    account: &str,
    root: &str,
    turn: Option<&str>,
) -> Result<Vec<String>, sqlx::Error> {
    use crate::core::{turn_settle, wake_preempt};
    let (fold, stamp) = fold_sql();
    let mut tx = write.begin().await?;
    let rows: Vec<FoldRow> = sqlx::query_as(fold.as_str())
        .bind(root)
        .bind(account)
        .bind(root)
        .bind(turn)
        .fetch_all(&mut *tx)
        .await?;
    if rows.is_empty() {
        tx.commit().await?;
        return Ok(Vec::new());
    }
    let ids: Vec<String> = rows.iter().map(|r| r.2.clone()).collect();
    let at = turn_settle::now_iso(&mut tx).await?;
    sqlx::query(stamp.as_str())
        .bind(&ids)
        .bind(at)
        .bind("canceledAt")
        .execute(&mut *tx)
        .await?;
    let mut signal = wake_preempt::Preempted::default();
    let mut views = Vec::with_capacity(rows.len());
    for (id, wake_at, message_id, body, deleted, report_to, thread_root) in rows {
        let report = report_to.as_ref().and_then(turn_settle::report_to);
        views.push(closed_watch_view(
            &id,
            &wake_at,
            &message_id,
            body.as_deref(),
            deleted,
            report.as_ref(),
            &thread_root,
        ));
        if let Some(r) = report {
            signal.report.push(r);
        }
        signal.rows.push(message_id);
    }
    wake_preempt::announce(&mut tx, &signal).await?;
    tx.commit().await?;
    Ok(views)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const C: &str = "11111111-1111-1111-1111-111111111111";
    const R: &str = "22222222-2222-2222-2222-222222222222";

    #[test]
    fn parse_like_zod() {
        let a = parse(&json!({ "channelId": C, "body": " ", "extra": 1 })).expect("min(1) only");
        assert_eq!(a.post.body, " ");
        assert!(!a.post.also_in_channel);
        let a = parse(&json!({ "channelId": C, "body": "x", "threadRootId": R, "alsoInChannel": true, "model": " opus " }))
            .expect("full");
        assert!(a.post.also_in_channel);
        assert_eq!(a.model.as_deref(), Some("opus"));
        // 공백뿐인 모델은 zod 를 지나고 meta 가 없다.
        assert_eq!(
            parse(&json!({ "channelId": C, "body": "x", "model": "  " })).map(|a| a.model),
            Some(None)
        );
        assert_eq!(
            parse_picks(&json!([{ "agentId": C, "model": "m", "effort": null }])),
            Some(vec![(C.to_owned(), Some("m".to_owned()), None)])
        );
        assert!(parse_picks(&json!([{ "agentId": "x" }])).is_none());
        assert!(parse_picks(&json!([{ "agentId": C, "effort": "e".repeat(65) }])).is_none());
        assert!(parse_picks(&json!(vec![json!({ "agentId": C }); 9])).is_none());
        // 빈 agentModels 는 고를 것이 없어 없는 것과 같다.
        assert!(parse(&json!({ "channelId": C, "body": "x", "agentModels": [] })).is_some());
        // ASCII 밖 모델도 JS `trim` 처럼 다듬어 Rust 가 맡는다.
        assert_eq!(
            parse(&json!({ "channelId": C, "body": "x", "model": "\u{3000}오푸스 " }))
                .map(|a| a.model),
            Some(Some("오푸스".into()))
        );
        for bad in [
            json!({ "channelId": C, "body": "" }),
            json!({ "channelId": "x", "body": "a" }),
            json!({ "channelId": C, "body": "a", "threadRootId": null }),
            json!({ "channelId": C, "body": "a", "alsoInChannel": "yes" }),
            json!({ "channelId": C, "body": "a", "attachmentIds": [1] }),
            json!({ "channelId": C, "body": "a", "attachmentIds": vec![C; 11] }),
            json!({ "channelId": C, "body": "a", "model": "" }),
            json!({ "channelId": C, "body": "a", "model": "x".repeat(121) }),
            json!({ "channelId": C, "body": "a", "model": format!("{}😀", "a".repeat(119)) }),
            json!({ "channelId": C, "body": "a", "agentModels": null }),
            json!({ "channelId": C, "body": "a", "agentModels": [{ "agentId": C }] }),
            json!({ "channelId": C, "body": "a".repeat(8001) }),
        ] {
            assert!(parse(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn report_parse_like_zod() {
        let (a, m) = parse_report(&json!({ "channelId": C, "body": "x", "threadRootId": R, "checks": ["c"], "files": [],
            "remaining": ["r"], "durationMs": 5, "next": [{ "id": "n", "label": "l", "x": 1 }], "alsoInChannel": true }))
        .expect("report");
        // report 에 없는 칸(alsoInChannel)은 zod 가 버린다.
        assert!(!a.post.also_in_channel);
        assert_eq!(
            Value::Object(m),
            json!({ "kind": "report", "report": { "checks": ["c"], "remaining": ["r"], "durationMs": 5, "next": [{ "id": "n", "label": "l" }] } })
        );
        // `planStepId` 는 Rust 가 맡는다(계획 단계 done) — 꼴만 zod 와 같이 본다.
        assert!(
            parse_report(&json!({ "channelId": C, "body": "x", "threadRootId": R, "checks": ["c"], "planStepId": "s33" }))
                .is_some()
        );
        for bad in [
            json!({ "channelId": C, "body": "x", "checks": ["c"], "planStepId": "s0" }),
            json!({ "channelId": C, "body": "x", "checks": ["c"], "planStepId": "s12345" }),
            json!({ "channelId": C, "body": "x", "checks": ["c"], "planStepId": 1 }),
            json!({ "channelId": C, "body": "x", "checks": [] }),
            json!({ "channelId": C, "body": "x" }),
            json!({ "channelId": C, "body": "x", "checks": [""] }),
            json!({ "channelId": C, "body": "x", "checks": ["c"], "durationMs": 1.5 }),
            json!({ "channelId": C, "body": "x", "checks": ["c"], "durationMs": -1 }),
            json!({ "channelId": C, "body": "x", "checks": ["c"], "next": [{ "id": "n" }] }),
            json!({ "channelId": C, "body": "x", "checks": ["c"], "next": [{ "id": "a", "label": "l" }, { "id": "b", "label": "l" }, { "id": "c", "label": "l" }, { "id": "d", "label": "l" }, { "id": "e", "label": "l" }] }),
        ] {
            assert!(parse_report(&bad).is_none(), "{bad}");
        }
        // agentModels 는 report 에 없는 칸 — zod 처럼 버린다.
        assert!(
            parse_report(
                &json!({ "channelId": C, "body": "x", "checks": ["c"], "agentModels": [] })
            )
            .is_some()
        );
    }

    #[test]
    fn closed_watch_view_like_ts() {
        let r = ("c".to_owned(), "t".to_owned());
        assert_eq!(
            closed_watch_view(
                "i",
                "2030-01-02T03:04:05.678Z",
                "m",
                Some("why"),
                false,
                Some(&r),
                "h"
            ),
            r#"{"id":"i","reason":"why","wakeAt":"2030-01-02T03:04:05.678Z","messageId":"m","threadRootId":"h","reportTo":{"channelId":"c","threadRootId":"t"}}"#
        );
        assert_eq!(
            closed_watch_view("i", "w", "m", Some("why"), true, None, "h"),
            r#"{"id":"i","reason":null,"wakeAt":"w","messageId":"m","threadRootId":"h"}"#
        );
    }

    #[test]
    fn fail_parse_like_zod() {
        let f = parse_fail(&json!({ "channelId": C, "body": "x", "retryable": true, "what": "w", "account": "old", "alsoInChannel": true }))
            .expect("plain fail");
        assert!(f.retryable);
        assert_eq!(f.what.as_deref(), Some("w"));
        assert_eq!(f.reason, None);
        // fail 에 없는 칸(alsoInChannel)은 zod 가 버린다.
        assert!(!f.args.post.also_in_channel);
        let m = Value::Object(failure_meta(&f, true, None));
        assert_eq!(
            m,
            json!({ "kind": "failure", "failure": { "retryable": true, "what": "w" } })
        );
        for bad in [
            // 목록 밖 표지·까닭 코드는 zod 오류 글자를 위해 TS 로.
            json!({ "channelId": C, "body": "x", "retryable": true, "code": "nope" }),
            json!({ "channelId": C, "body": "x", "retryable": true, "code": null }),
            json!({ "channelId": C, "body": "x", "retryable": true, "code": "provider_lane", "laneCode": "nope" }),
            json!({ "channelId": C, "body": "x", "retryable": true, "laneCode": 1 }),
            // 차례 주인 재료의 zod 꼴 오류는 TS 가 낸다.
            json!({ "channelId": C, "body": "x", "retryable": true, "mentionId": "not-a-uuid" }),
            json!({ "channelId": C, "body": "x", "retryable": true, "mentionId": null }),
            json!({ "channelId": C, "body": "x", "retryable": true, "claudePoolRank": 0 }),
            json!({ "channelId": C, "body": "x", "retryable": true, "claudePoolRank": 100 }),
            json!({ "channelId": C, "body": "x", "retryable": true, "claudeAccountRank": 1.5 }),
            json!({ "channelId": C, "body": "x", "retryable": true, "claudeAccountRank": "1" }),
            // zod 오류는 TS 가 낸다.
            json!({ "channelId": C, "body": "x" }),
            json!({ "channelId": C, "body": "x", "retryable": "yes" }),
            json!({ "channelId": C, "body": "x", "retryable": true, "what": "" }),
            json!({ "channelId": C, "body": "x", "retryable": true, "reason": "r".repeat(1001) }),
            json!({ "channelId": C, "body": "x", "retryable": true, "account": "a".repeat(81) }),
            json!({ "channelId": C, "body": "", "retryable": true }),
            json!({ "channelId": "x", "body": "x", "retryable": true }),
        ] {
            assert!(parse_fail(&bad).is_none(), "{bad}");
        }
        // 표지 없는 차례 주인 재료(러너의 침묵·혼자 꺼짐·보고 누락 통지)는 zod 꼴만 보고 버린다 — meta 는 표지 없는 실패와 같다.
        let f = parse_fail(&json!({
            "channelId": C, "body": "x", "retryable": false, "what": "w",
            "mentionId": R, "claudePoolRank": 1, "claudeAccountRank": 99.0
        }))
        .expect("mentionId without code");
        assert_eq!(
            Value::Object(failure_meta(&f, true, None)),
            json!({ "kind": "failure", "failure": { "retryable": false, "what": "w" } })
        );
        // account_gate — 차례 주인·순번은 이 표지에만 붙는다. 차례 주인을 못 정하면 그 칸만 빠진다.
        let gate = parse_fail(&json!({
            "channelId": C, "body": "x", "retryable": true, "code": "account_gate",
            "mentionId": R, "claudePoolRank": 1, "claudeAccountRank": 3.0, "laneCode": "lane_unset"
        }))
        .expect("account_gate is rust");
        assert_eq!(
            Value::Object(failure_meta(&gate, true, Some(R))),
            json!({ "kind": "failure", "failure": {
                "retryable": true, "code": "account_gate", "awaitingAccountId": R, "claudePoolRank": 1, "claudeAccountRank": 3
            } })
        );
        assert_eq!(
            Value::Object(failure_meta(&gate, true, None)),
            json!({ "kind": "failure", "failure": { "retryable": true, "code": "account_gate", "claudePoolRank": 1, "claudeAccountRank": 3 } })
        );
        // Rust 가 맡는 다른 표지. keepCode 가 참이면 붙고, laneCode 는 provider_lane 에만 따라 붙는다.
        let meta = |v: Value, keep: bool| {
            Value::Object(failure_meta(&parse_fail(&v).expect("code"), keep, None))
        };
        assert_eq!(
            meta(
                json!({ "channelId": C, "body": "x", "retryable": true, "code": "inject_unconfirmed", "mentionId": R, "claudePoolRank": 2 }),
                true
            ),
            json!({ "kind": "failure", "failure": { "retryable": true, "code": "inject_unconfirmed" } })
        );
        assert_eq!(
            meta(
                json!({ "channelId": C, "body": "x", "retryable": true, "code": "provider_lane", "laneCode": "unknown" }),
                true
            ),
            json!({ "kind": "failure", "failure": { "retryable": true, "code": "provider_lane", "laneCode": "unknown" } })
        );
        assert_eq!(
            meta(
                json!({ "channelId": C, "body": "x", "retryable": true, "code": "inject_unconfirmed", "laneCode": "unknown" }),
                true
            ),
            json!({ "kind": "failure", "failure": { "retryable": true, "code": "inject_unconfirmed" } })
        );
        assert_eq!(
            meta(
                json!({ "channelId": C, "body": "x", "retryable": true, "laneCode": "unknown" }),
                true
            ),
            json!({ "kind": "failure", "failure": { "retryable": true } })
        );
        // thread_model_rejected 인데 살아 있는 지정이 없으면(keepCode 거짓) 글은 올리고 표지만 뺀다.
        assert_eq!(
            meta(
                json!({ "channelId": C, "body": "x", "retryable": false, "code": "thread_model_rejected" }),
                false
            ),
            json!({ "kind": "failure", "failure": { "retryable": false } })
        );
        assert_eq!(
            meta(
                json!({ "channelId": C, "body": "x", "retryable": false, "code": "thread_model_rejected" }),
                true
            ),
            json!({ "kind": "failure", "failure": { "retryable": false, "code": "thread_model_rejected" } })
        );
        // agentModels 는 fail 에 없는 칸 — zod 처럼 버린다.
        assert!(
            parse_fail(
                &json!({ "channelId": C, "body": "x", "retryable": false, "agentModels": [] })
            )
            .is_some()
        );
    }

    #[test]
    fn result_shape_like_ts() {
        let row = r#"{"id":"m","meta":{"mentionDenied":["bot","b2"]},"body":"x"}"#;
        let t = posted_result(row, &["a".into()], "").unwrap();
        let v: Value = serde_json::from_str(&t).unwrap();
        let inner = v
            .pointer("/content/0/text")
            .and_then(Value::as_str)
            .unwrap();
        assert!(
            inner.starts_with(r#"{"warnings":["@bot, @b2 를 부르지 못했다"#),
            "{inner}"
        );
        assert!(inner.ends_with(r#""message":{"id":"m","meta":{"mentionDenied":["bot","b2"]},"body":"x"},"notified":["a"]}"#));
        let t = posted_result(
            r#"{"id":"m","meta":{"mentionChainCapped":["b2"],"mentionChainLimit":8,"mentionDenied":["x"]}}"#,
            &[],
            "",
        )
        .unwrap();
        let v: Value = serde_json::from_str(&t).unwrap();
        let inner: Value = serde_json::from_str(
            v.pointer("/content/0/text")
                .and_then(Value::as_str)
                .unwrap(),
        )
        .unwrap();
        // 옛 글에 남은 상한 meta 는 경고가 되지 않는다 — 호출 범위 밖만 알린다.
        let w = inner["warnings"].as_array().unwrap();
        assert_eq!(w.len(), 1);
        assert!(
            w[0].as_str()
                .unwrap()
                .starts_with("@x 를 부르지 못했다: 너는")
        );
        let t = posted_result(r#"{"id":"m","meta":{}}"#, &[], "").unwrap();
        assert!(
            t.contains(r#"{\"message\":{\"id\":\"m\",\"meta\":{}},\"notified\":[]}"#),
            "{t}"
        );
    }

    #[test]
    fn progress_drops_post_only_keys() {
        // zod `message.progress` 에는 첨부·채널 올리기·모델 지정 키가 없다 — 버리고 받는다.
        let a = parse_progress(&json!({
            "channelId": C, "body": "x", "threadRootId": R,
            "alsoInChannel": true, "attachmentIds": ["bad"], "agentModels": {}
        }))
        .expect("unknown keys stripped");
        assert!(a.post.attachment_ids.is_empty());
        assert!(!a.post.also_in_channel);
        assert_eq!(a.post.thread_root.as_deref(), Some(R));
        assert!(parse_progress(&json!({ "channelId": C, "body": "" })).is_none());
        assert!(parse_progress(&json!({ "channelId": "x", "body": "a" })).is_none());
    }

    #[test]
    fn notice_args_like_zod() {
        let n = parse_notice(&json!({ "channelId": C, "key": "fenced", "body": "ignored" }))
            .expect("ok");
        assert_eq!(n.key, "fenced");
        assert!(parse_notice(&json!({ "channelId": C, "key": "other" })).is_none());
        assert!(
            parse_notice(&json!({ "channelId": C, "key": "controlled", "pending": 0 })).is_none()
        );
        assert!(
            parse_notice(&json!({ "channelId": C, "key": "controlled", "pending": 10000 }))
                .is_none()
        );
        assert!(
            parse_notice(&json!({ "channelId": C, "key": "controlled", "pending": 2.5 })).is_none()
        );
        assert!(
            parse_notice(&json!({ "channelId": C, "key": "controlled", "handle": "a".repeat(65) }))
                .is_none()
        );
        assert!(
            parse_notice(&json!({ "channelId": C, "key": "fenced", "threadRootId": "x" }))
                .is_none()
        );
    }

    #[test]
    fn runner_notice_like_ts() {
        let n = |key: &str, handle: Option<&str>, pending: Option<i64>| NoticeArgs {
            channel: C.into(),
            thread_root: None,
            key: key.into(),
            handle: handle.map(str::to_owned),
            pending,
        };
        let (b, i) = runner_notice(&n("blocked_by_turn", None, None), R);
        assert!(b.starts_with("(이 스레드에서 앞 턴이"));
        assert_eq!(
            i,
            json!({ "key": "system.runner.blockedByTurn", "args": { "agentId": R } })
        );
        let (_, i) = runner_notice(&n("fenced", None, None), R);
        assert_eq!(i["key"], "system.runner.fenced");
        let (b, i) = runner_notice(&n("controlled", Some("bob.x-1"), Some(3)), R);
        assert!(
            b.contains("지금 bob.x-1 이(가)") && b.contains("대기 3건째"),
            "{b}"
        );
        assert_eq!(
            i,
            json!({ "key": "system.runner.controlled", "args": { "agentId": R, "handle": "bob.x-1", "pending": 3 } })
        );
        // HANDLE_RE 밖이면 「소유자」 + controlledByOwner, pending 없으면 1.
        let (b, i) = runner_notice(&n("controlled", Some("bad handle"), None), R);
        assert!(
            b.contains("지금 소유자 이(가)") && b.contains("대기 1건째"),
            "{b}"
        );
        assert_eq!(
            i,
            json!({ "key": "system.runner.controlledByOwner", "args": { "agentId": R, "pending": 1 } })
        );
    }
}
