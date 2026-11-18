//! S5.3 C1c-4c — MCP `message.post` 의 몸통. TS `mcp/mcpPlugin.ts` 의 같은 도구를 옮긴다: 채널 가시성 → 모델 신고 meta →
//! `postMessage`(원인 입력과 함께, [`crate::core::msg_post::post_in_tx`]) → `postedResult`.
//!
//! - **TS 로 넘기는 것**(`None` — 아무것도 쓰지 않았다): zod 가 받지 않을 인자(모양을 모르면 넘긴다) · `agentModels`(모델 지정은
//!   `applyAgentPicks`, TS 몫) · 자른 자리가 서로게이트 쌍을 가르는 모델 신고([`cause_link::trimmed_model`]) · `post_in_tx` 가 TS 몫이라고 한
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

/// zod `inputSchema` 를 그대로 받는 인자만 `Some`. 틀린 꼴·`agentModels`·서로게이트 쌍이 갈리는 모델은 `None`(→ TS 가 검증 오류나 그 갈래를 낸다).
fn parse(args: &Value) -> Option<Args> {
    let Value::Object(o) = args else { return None };
    if o.contains_key("agentModels") {
        return None;
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

/// TS `postedResult` — 못 부른 이름을 앞세운다(상한에 막힌 부름 → 호출 범위 밖 순서).
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
    let capped = handles("/meta/mentionChainCapped");
    let mut warnings: Vec<String> = Vec::new();
    // TS `postedResult` — 상한에 막힌 부름이 먼저(C1c-4d-2 부터 Rust 가 맡는다). 백스톱 카드는 서버가 세웠다.
    if !capped.is_empty() {
        let why = if v
            .pointer("/meta/mentionChainReason")
            .and_then(Value::as_str)
            == Some("age")
        {
            "사람 손길 뒤 24시간이 지났다".to_owned()
        } else {
            // TS `String(meta.mentionChainLimit)` — 숫자 그대로(없으면 undefined).
            let limit = match v.pointer("/meta/mentionChainLimit") {
                Some(Value::Number(n)) => n.to_string(),
                Some(Value::String(t)) => t.clone(),
                None => "undefined".to_owned(),
                Some(other) => other.to_string(),
            };
            format!("멘션 연쇄 상한 {limit} 홉에 닿았다")
        };
        warnings.push(format!(
            "{} 를 부르지 못했다: {why} (사람 없이 에이전트끼리 이어진 부름이 너무 길다). 서버가 네 소유자에게 [계속 — 예산 리셋]/[멈춤] 카드를 세웠다 — 따로 message.ask 를 세우지 말고 지금 아는 것을 정리한 뒤 턴을 끝내라. 「계속」이면 다시 깨어난다.",
            capped.join(", ")
        ));
    }
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
    // zod `int().min(1).max(9999)` — 소수 꼴(3.0)은 TS 에 맡긴다.
    let pending = match o.get("pending") {
        None => None,
        Some(v) => Some(
            v.as_i64()
                .filter(|n| (1..=NOTICE_MAX_PENDING).contains(n))?,
        ),
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
}

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

/// zod `message.fail` 의 `inputSchema`. **TS 로 넘기는 것**(fail-closed): 표지 칸(`code`·`laneCode`)·차례 주인 재료(`mentionId`·
/// `claudePoolRank`·`claudeAccountRank`)가 하나라도 있으면 — `thread_model_rejected` 의 keepCode(스레드 모델 지정의 stale 판정)·
/// `account_gate` 의 차례 주인·inbox·`provider_lane` 의 까닭 코드 허용 목록은 아직 TS 몫이다. 옛 러너의 `account` 는 zod 처럼 받고 버린다.
fn parse_fail(args: &Value) -> Option<FailArgs> {
    let Value::Object(o) = args else { return None };
    for k in [
        "code",
        "laneCode",
        "mentionId",
        "claudePoolRank",
        "claudeAccountRank",
    ] {
        if o.contains_key(k) {
            return None;
        }
    }
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
    })
}

/// TS `FailureMeta` 의 `failure` — `{ retryable, what?, reason? }`(표지 없는 갈래).
fn failure_meta(f: &FailArgs) -> Map<String, Value> {
    let mut failure = Map::new();
    failure.insert("retryable".into(), Value::Bool(f.retryable));
    if let Some(w) = &f.what {
        failure.insert("what".into(), Value::String(w.clone()));
    }
    if let Some(r) = &f.reason {
        failure.insert("reason".into(), Value::String(r.clone()));
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
    let meta = failure_meta(&f);
    post(
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
    )
    .await
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
    if o.contains_key("planStepId") {
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
    post(
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
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn post(
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
) -> Option<String> {
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
        Outcome::ToTs | Outcome::Replayed(_) | Outcome::ChainLimit => None,
        Outcome::BadThread => Some(err("bad_thread", BAD_THREAD)),
        Outcome::BadAttachment => Some(err(
            "bad_attachment",
            "attachments must be your own, unused uploads",
        )),
        // 에이전트 글은 새 위임을 만들지 않는다(`mandate` 는 사람 글만) — 감사 줄이 없다.
        Outcome::Posted { row, notified, .. } => {
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
                _ => String::new(),
            };
            posted_result(&row, &notified, &extra)
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
            json!({ "channelId": C, "body": "a", "agentModels": [] }),
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
        for bad in [
            json!({ "channelId": C, "body": "x", "checks": ["c"], "planStepId": "s1" }),
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
        let m = Value::Object(failure_meta(&f));
        assert_eq!(
            m,
            json!({ "kind": "failure", "failure": { "retryable": true, "what": "w" } })
        );
        for bad in [
            // 표지·차례 주인 재료는 TS 로(fail-closed).
            json!({ "channelId": C, "body": "x", "retryable": true, "code": "account_gate" }),
            json!({ "channelId": C, "body": "x", "retryable": true, "code": "thread_model_rejected" }),
            json!({ "channelId": C, "body": "x", "retryable": true, "laneCode": "unknown" }),
            json!({ "channelId": C, "body": "x", "retryable": true, "mentionId": R }),
            json!({ "channelId": C, "body": "x", "retryable": true, "claudePoolRank": 1 }),
            json!({ "channelId": C, "body": "x", "retryable": true, "claudeAccountRank": 1 }),
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
        let w = inner["warnings"].as_array().unwrap();
        assert_eq!(w.len(), 2);
        assert!(
            w[0].as_str()
                .unwrap()
                .starts_with("@b2 를 부르지 못했다: 멘션 연쇄 상한 8 홉에 닿았다 (사람 없이")
        );
        assert!(
            w[1].as_str()
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
