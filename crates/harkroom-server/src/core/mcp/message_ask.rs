//! MCP `message.ask` 의 거절 앞머리(대상 찾기 `unknown_handle` 까지, TS `mcpPlugin.ts` `message.ask`). TS 순서 그대로: zod 인자 → `planStepId` 인데 스레드
//! 없음(`bad_request`) → 채널 가시성(`forbidden`) → 선택지 id 겹침(`duplicate_option`) → 예약 id(`reserved_option_id`)
//! → 추천 둘 이상(`multiple_recommended`) → 머지 거절 카드에 `to`·`mirrorOf`(`merge_denial_audience`). 모두 지나면 `None`
//! (→ TS). 그 뒤 스레드 안의 사람 앞 카드는 [`answer_plain`] 이 열린 카드 검사(`open_card_in_thread`, `keepOpen` 반영)를 하고,
//! 평범한 카드(사람 앞·원인 헤더 없음, 스레드 안팎)는 글 올리기 풀로 세운다 — 대신하기(`supersedes`)는 새 카드를 세운 뒤
//! 옛 카드를 닫고, 계획 단계(`planStepId`)는 세운 뒤 그 단계에 카드를 잇는다(계획·단계가 없으면 그 거절을 `plan` 칸에 싣는다. 묶음에 담긴 옛 카드는 TS). 머지 거절 카드(`mergeDenialId`)는 거절 기록
//! 검사(`prepareDenialCard` 거절)와 같은 거절 기록의 기다리는 카드(`pending`)까지 읽기 풀로 답하고, 첫 부름(새 요청 줄·카드·잇기·푸시)도 세운다(위임 있는 턴은 위임장 칩·선택지까지 — P6-4c. 재생은 TS).
//! `to` 로 정한 받는 사람(사람이면 글 뒤 `enqueueAskPush`)도 세운다. 거울(`mirrorOf`)은 거절(`mirror_audience`·`checkAskMirror`)을 답하고, 평범한 거울과 권한 카드 거울(중립, 그리고 경고·파일·위임장 칩까지 싣는 같은 카드 꼴)을 원인 기반 차례 주인 푸시와 함께 세운다(꼴이 어긋난 권한 거울은 TS). 인자가 zod 를 못 지나거나 DB 오류여도 `None`.
use super::tools::err;
use crate::auth::Account;
use crate::core::ask::{ASK_MAX_OPTIONS, ASK_MIN_OPTIONS, ASK_TEXT_OPTION_ID, Ask, read_ask_meta};
use crate::core::cause_link::MODEL_ID_MAX;
use crate::core::channels::is_uuid;
use crate::core::msg_edit::MAX_MESSAGE_BODY_CHARS;
use serde_json::{Map, Value};
use sqlx::PgPool;
use std::collections::HashSet;

fn len_ok(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.encode_utf16().count())
}

/// zod `optional()` 칸 — 없으면 `Some(None)`, 있는데 `ok` 를 못 지나면 `None`.
fn opt<'a>(
    o: &'a Map<String, Value>,
    k: &str,
    ok: impl Fn(&Value) -> bool,
) -> Option<Option<&'a Value>> {
    match o.get(k) {
        None => Some(None),
        Some(v) if ok(v) => Some(Some(v)),
        _ => None,
    }
}

fn str_ok(max: usize) -> impl Fn(&Value) -> bool {
    move |v| v.as_str().is_some_and(|s| len_ok(s, max))
}

fn uuid_ok(v: &Value) -> bool {
    v.as_str().is_some_and(is_uuid)
}

/// `/^s[1-9][0-9]{0,3}$/`.
pub(super) fn plan_step_ok(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        let b = s.as_bytes();
        b.len() >= 2
            && b.len() <= 5
            && b[0] == b's'
            && (b'1'..=b'9').contains(&b[1])
            && b[2..].iter().all(u8::is_ascii_digit)
    })
}

struct Args<'a> {
    channel: &'a str,
    thread: bool,
    /// (id, recommended)
    options: Vec<(&'a str, bool)>,
    to: Option<&'a str>,
    mirror_of: Option<&'a str>,
    merge_denial: bool,
    plan_step: bool,
}

fn parse(args: &Value) -> Option<Args<'_>> {
    let Value::Object(o) = args else { return None };
    let channel = o.get("channelId")?.as_str().filter(|s| is_uuid(s))?;
    if !len_ok(o.get("body")?.as_str()?, MAX_MESSAGE_BODY_CHARS) {
        return None;
    }
    let thread = opt(o, "threadRootId", uuid_ok)?.is_some();
    let raw = o.get("options")?.as_array()?;
    if !(ASK_MIN_OPTIONS..=ASK_MAX_OPTIONS).contains(&raw.len()) {
        return None;
    }
    let mut options = Vec::with_capacity(raw.len());
    for x in raw {
        let x = x.as_object()?;
        let id = x.get("id")?.as_str().filter(|s| len_ok(s, 64))?;
        if !str_ok(200)(x.get("label")?) {
            return None;
        }
        opt(x, "hint", str_ok(200))?;
        let rec = opt(x, "recommended", Value::is_boolean)?.and_then(Value::as_bool) == Some(true);
        options.push((id, rec));
    }
    opt(o, "irreversible", Value::is_boolean)?;
    let to = opt(o, "to", str_ok(64))?.and_then(Value::as_str);
    opt(o, "prompt", str_ok(500))?;
    let mirror_of = opt(o, "mirrorOf", uuid_ok)?.and_then(Value::as_str);
    opt(o, "supersedes", |v| {
        uuid_ok(v)
            || v.as_array()
                .is_some_and(|a| !a.is_empty() && a.iter().all(uuid_ok))
    })?;
    opt(o, "keepOpen", |v| {
        v.as_array()
            .is_some_and(|a| a.len() <= 50 && a.iter().all(uuid_ok))
    })?;
    let merge_denial = opt(o, "mergeDenialId", uuid_ok)?.is_some();
    let plan_step = opt(o, "planStepId", plan_step_ok)?.is_some();
    opt(o, "model", str_ok(MODEL_ID_MAX))?;
    Some(Args {
        channel,
        thread,
        options,
        to,
        mirror_of,
        merge_denial,
        plan_step,
    })
}

/// 채널 가시성 뒤의 거절(순서가 TS 와 같다).
fn option_refusal(a: &Args<'_>) -> Option<String> {
    let ids: HashSet<&str> = a.options.iter().map(|(id, _)| *id).collect();
    if ids.len() != a.options.len() {
        return Some(err("duplicate_option", "option ids must be unique"));
    }
    if ids.contains(ASK_TEXT_OPTION_ID) {
        return Some(err(
            "reserved_option_id",
            &format!("option id {ASK_TEXT_OPTION_ID} is reserved"),
        ));
    }
    if a.options.iter().filter(|(_, r)| *r).count() > 1 {
        return Some(err(
            "multiple_recommended",
            "mark at most one option as recommended",
        ));
    }
    if a.merge_denial && (a.to.is_some() || a.mirror_of.is_some()) {
        return Some(err(
            "merge_denial_audience",
            "a merge-denial card is addressed to humans; omit `to` and `mirrorOf`",
        ));
    }
    None
}

pub async fn answer(read: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let a = parse(args)?;
    if a.plan_step && !a.thread {
        return Some(err(
            "bad_request",
            "planStepId 는 threadRootId 와 함께 준다(그 스레드의 계획 단계)",
        ));
    }
    if !crate::core::channels::visible(read, &me.id, a.channel)
        .await
        .ok()?
    {
        return Some(err("forbidden", "not a member of this dm channel"));
    }
    if let Some(r) = option_refusal(&a) {
        return Some(r);
    }
    // TS `to` 대상 찾기 — 없는 handle 이면 `unknown_handle`. 찾으면 그 뒤(사람 아닌 대상 카드)는 아직 TS 몫이다.
    if let Some(to) = a.to {
        let handle = to_handle(to);
        let found: Option<String> = sqlx::query_scalar(TO_SQL)
            .bind(&handle)
            .fetch_optional(read)
            .await
            .ok()?;
        if found.is_none() {
            return Some(err(
                "unknown_handle",
                &format!("no account with handle @{handle}"),
            ));
        }
    }
    // 거울 검사 — TS 순서대로 `to` 를 실었으면 `mirror_audience`, 그다음 `checkAskMirror`. 다 지난 거울은 평범한 카드처럼
    // 대신하기 검사로 이어진다.
    if let Some(root) = a.mirror_of {
        if a.to.is_some() {
            return Some(err(
                "mirror_audience",
                "a mirror card is always addressed to humans; omit `to`",
            ));
        }
        let row: Option<(Value, String)> = sqlx::query_as(MIRROR_ROOT_SQL)
            .bind(root)
            .fetch_optional(read)
            .await
            .ok()?;
        let visible = match &row {
            Some((_, ch)) => crate::core::channels::visible(read, &me.id, ch)
                .await
                .ok()?,
            None => false,
        };
        let ids: Vec<&str> = a.options.iter().map(|(id, _)| *id).collect();
        let ask = row.as_ref().and_then(|(m, _)| read_ask_meta(m));
        if let Some(code) = mirror_refusal(ask.as_ref(), visible, &ids) {
            return Some(err(code, mirror_message(code)));
        }
        // 거울도 TS 처럼 이어서 대신하기 검사를 한다.
    }
    let o = args.as_object()?;
    let olds = supersedes_list(o);
    if olds.len() > ASK_SUPERSEDES_MAX {
        return Some(err(
            "supersedes_too_many",
            "list at most 4 cards in supersedes",
        ));
    }
    let thread = o.get("threadRootId").and_then(Value::as_str);
    for old in olds {
        let row: Option<(Value, String, Option<String>, Option<String>)> =
            sqlx::query_as(SUPERSEDE_SQL)
                .bind(old)
                .fetch_optional(read)
                .await
                .ok()?;
        if let Some(code) = supersede_refusal(old, row, &me.id, a.channel, thread) {
            return Some(super::respond::text_result(
                &serde_json::json!({ "error": {
                    "code": code, "message": supersede_message(code), "supersedes": old,
                } })
                .to_string(),
            ));
        }
    }
    // 대신하기를 다 지난 카드는 [`answer_plain`] 이 세우고 옛 카드를 닫는다(묶음에 담긴 옛 카드·권한 없음은 TS).
    None
}

/// TS `readAskRow` 의 원본 읽기(읽기 풀의 `message` SELECT).
pub const MIRROR_ROOT_SQL: &str =
    "select meta, channel_id::text from message where id = $1::uuid and deleted_at is null";

/// TS `checkAskMirror` 의 판정 — `ask` 는 원본의 `readAskMeta`(없으면 `None`), `visible` 은 부른 쪽이 원본 채널을 보는가.
fn mirror_refusal(ask: Option<&Ask>, visible: bool, option_ids: &[&str]) -> Option<&'static str> {
    let Some(ask) = ask else {
        return Some("mirror_not_found");
    };
    if !visible {
        return Some("mirror_not_found");
    }
    if ask.mirror_of.is_some() {
        return Some("mirror_of_mirror");
    }
    if !ask.to_human() {
        return Some("mirror_not_human");
    }
    let mut root: Vec<&str> = ask.options.iter().map(String::as_str).collect();
    let mut ids = option_ids.to_vec();
    root.sort_unstable();
    ids.sort_unstable();
    if root != ids {
        return Some("mirror_options_mismatch");
    }
    if ask.answered || ask.closed {
        return Some("mirror_resolved");
    }
    None
}

/// TS `MIRROR_REFUSAL_MESSAGE`.
fn mirror_message(code: &str) -> &'static str {
    match code {
        "mirror_not_found" => "no choice request with that id that you can see",
        "mirror_of_mirror" => "that card is itself a mirror; point mirrorOf at its original",
        "mirror_not_human" => "only a card addressed to humans can be mirrored",
        "mirror_options_mismatch" => "options must carry exactly the original card's option ids",
        _ => "the original card is already answered or closed",
    }
}

/// TS `ASK_SUPERSEDES_MAX`.
const ASK_SUPERSEDES_MAX: usize = 4;

/// TS `checkAskSupersede` 의 옛 카드 읽기(읽기 풀의 `message` SELECT).
const SUPERSEDE_SQL: &str = "select meta, channel_id::text, thread_root_id::text, author_id::text
       from message where id = $1::uuid and deleted_at is null";

/// TS `[...new Set(typeof s === 'string' ? [s] : s)]` — 차례를 지키며 겹침을 뺀다.
fn supersedes_list(o: &Map<String, Value>) -> Vec<&str> {
    let raw: Vec<&str> = match o.get("supersedes") {
        Some(Value::String(s)) => vec![s.as_str()],
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).collect(),
        _ => Vec::new(),
    };
    let mut seen = HashSet::new();
    raw.into_iter().filter(|x| seen.insert(*x)).collect()
}

/// JS 참값.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `x != null` (undefined·null 이 아님).
fn present(v: Option<&Value>) -> bool {
    !matches!(v, None | Some(Value::Null))
}

/// TS `checkAskSupersede` 판정 차례 그대로.
fn supersede_refusal(
    old: &str,
    row: Option<(Value, String, Option<String>, Option<String>)>,
    caller: &str,
    channel: &str,
    thread: Option<&str>,
) -> Option<&'static str> {
    let Some((meta, ch, root, author)) = row else {
        return Some("supersedes_not_found");
    };
    if crate::core::ask::read_ask_meta(&meta).is_none() {
        return Some("supersedes_not_found");
    }
    if author.as_deref() != Some(caller) {
        return Some("supersedes_not_yours");
    }
    if truthy(meta.get("permissionRequest")) || truthy(meta.get("chainBackstop")) {
        return Some("supersedes_permission_card");
    }
    let old_root = root.as_deref().unwrap_or(old);
    if ch != channel || thread.is_none_or(|t| t != old_root) {
        return Some("supersedes_other_thread");
    }
    let ask = meta.get("ask");
    let f = |k: &str| ask.and_then(|a| a.get(k));
    if present(f("answeredWith"))
        || (present(f("closedAt")) && f("closedReason") != Some(&Value::from("replied")))
    {
        return Some("supersedes_resolved");
    }
    None
}

/// TS `SUPERSEDE_REFUSAL_MESSAGE`.
fn supersede_message(code: &str) -> &'static str {
    match code {
        "supersedes_not_found" => "no choice request with that id",
        "supersedes_not_yours" => "you can only replace a card you posted",
        "supersedes_other_thread" => {
            "the new card must go in the same thread as the card it replaces"
        }
        "supersedes_resolved" => "that card is already answered, declined, or replaced",
        "supersedes_permission_card" => {
            "a permission-request card ends only by the owner approving or denying it"
        }
        _ => "list at most 4 cards in supersedes",
    }
}

/// TS `select id from account where lower(handle) = $1` — `to` 대상 찾기(읽기 풀의 `account` SELECT).
const TO_SQL: &str = "select id::text from account where lower(handle) = $1";

/// TS `to.replace(/^@/, '').toLowerCase()`.
fn to_handle(to: &str) -> String {
    to.strip_prefix('@').unwrap_or(to).to_lowercase()
}

/// 평범한 카드의 TS `AskMeta` — `{kind:'ask', ask:{options, to:{kind:'human'}, prompt?, irreversible?}}`. 칸 차례는 DB(jsonb)가 다시 짓는다.
fn plain_meta(o: &Map<String, Value>, to: Value) -> Option<Map<String, Value>> {
    let mut options = Vec::new();
    for x in o.get("options")?.as_array()? {
        let x = x.as_object()?;
        let mut m = Map::new();
        m.insert("id".into(), x.get("id")?.clone());
        m.insert("label".into(), x.get("label")?.clone());
        if let Some(h) = x.get("hint") {
            m.insert("hint".into(), h.clone());
        }
        if x.get("recommended") == Some(&Value::Bool(true)) {
            m.insert("recommended".into(), Value::Bool(true));
        }
        options.push(Value::Object(m));
    }
    let mut ask = Map::new();
    ask.insert("options".into(), Value::Array(options));
    ask.insert("to".into(), to);
    if let Some(p) = o.get("prompt") {
        ask.insert("prompt".into(), p.clone());
    }
    if o.get("irreversible") == Some(&Value::Bool(true)) {
        ask.insert("irreversible".into(), Value::Bool(true));
    }
    let mut meta = Map::new();
    meta.insert("kind".into(), Value::from("ask"));
    meta.insert("ask".into(), Value::Object(ask));
    Some(meta)
}

/// `to` 로 대상을 정한 카드 — 거울·대신하기·머지 거절·계획 단계가 없을 때만 Rust 가 세운다. 원인 헤더는 상관없다(TS 의 원인 기반
/// 푸시는 사람 앞 카드만 쓴다).
fn addressed(o: &Map<String, Value>) -> bool {
    ["mirrorOf", "mergeDenialId"]
        .iter()
        .all(|k| !o.contains_key(*k))
}

/// `to` 대상 찾기에 종류까지 — 사람이면 TS `enqueueAskPush` 가 `push_job` 을 넣을 수 있다.
const TO_KIND_SQL: &str = "select id::text, kind::text from account where lower(handle) = $1";

/// 찾은 대상의 TS `AskAudience` — `{kind:'account', accountId}`. 사람이든 에이전트든 세우고, 글 뒤 `enqueueAskPush` 는
/// [`super::msg_post::answer_ask`] 가 한다(에이전트면 그 문장의 `kind = 'human'` 조건 때문에 아무것도 넣지 않는다).
fn account_audience((id, _kind): (String, String)) -> Option<Value> {
    Some(serde_json::json!({ "kind": "account", "accountId": id }))
}

/// Rust 가 세우는 카드 — 사람 앞(`to` 없음), 거울·머지 거절 없음. 원인 헤더가 있으면 거울처럼 차례 주인 푸시
/// (`gateAwaitingAccount`→`enqueueAskPush`, [`human_ask_push`])까지 Rust 가 한다. 스레드 안이면 열린 카드 검사
/// ([`open_card_refusal`])를 이미 지났어야 한다 — `keepOpen` 은 그 검사에만 쓰인다. 그 밖은 `false`(→ TS).
fn plain(o: &Map<String, Value>) -> bool {
    ["to", "mirrorOf", "mergeDenialId"]
        .iter()
        .all(|k| !o.contains_key(*k))
}

/// TS 사람 앞 푸시(security G4) — 원인 헤더가 있으면 그 턴의 차례 주인(`gateAwaitingAccount`)에게 글 뒤
/// `enqueueAskPush`(이 글로 inbox 를 받았으면 넣지 않는다). 차례 주인 찾기는 새 글과 상관없어 글 앞에 읽는다.
/// 원인이 없으면 `Some(None)`. 푸시 job 쓰기 칸이 없으면(→ TS) 또는 DB 오류면 `None`.
async fn human_ask_push(
    read: &PgPool,
    st: &crate::core::msg_post::PostState,
    me: &Account,
    channel: &str,
    cause: Option<&str>,
) -> Option<Option<String>> {
    let Some(c) = cause else {
        return Some(None);
    };
    if !crate::write::missing_in(
        &st.write,
        crate::core::permission_card::LINK_PUSH_PRIVILEGES,
        &[],
    )
    .await
    .ok()?
    .is_empty()
    {
        return None;
    }
    sqlx::query_scalar(gate_awaiting_sql())
        .bind(&me.id)
        .bind(c)
        .bind(channel)
        .fetch_optional(read)
        .await
        .ok()
}

/// Rust 가 세우는 거울 카드 — `mirrorOf` 가 있고, `to`·머지 거절이 없을 때만([`answer`] 의 거울·대신하기 검사를 이미
/// 지났다). `supersedes`·`planStepId` 는 평범한 카드와 같은 길(닫기·계획 잇기)로 간다. 원인 헤더가 있으면 차례 주인 푸시도 한다.
fn mirror_plain(o: &Map<String, Value>) -> bool {
    o.get("mirrorOf").is_some_and(Value::is_string)
        && ["to", "mergeDenialId"].iter().all(|k| !o.contains_key(*k))
}

/// TS `GATE_AWAITING_SQL`(`gateAwaitingAccount`) — $1 에이전트, $2 원인 멘션, $3 채널.
pub(super) fn gate_awaiting_sql() -> &'static str {
    static S: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        v["gate_awaiting"]
            .as_str()
            .expect("golden fragment gate_awaiting")
            .to_owned()
    })
}

/// TS `renderPermissionMirror` 의 원본 찾기 — 지우지 않은 원본이 권한 요청 카드인가. 참이면(또는 못 찾으면) TS.
pub const MIRROR_PERMISSION_SQL: &str =
    "select meta ? 'permissionRequest' from message where id = $1::uuid and deleted_at is null";

/// TS `renderPermissionMirror` 의 원본 읽기 — 권한 요청 카드의 meta·채널·작성자 handle.
pub const PERMISSION_MIRROR_ROOT_SQL: &str = "select m.meta, m.channel_id::text, a.handle
       from message m left join account a on a.id = m.author_id
      where m.id = $1::uuid and m.deleted_at is null and m.meta ? 'permissionRequest'";

/// [`PERMISSION_MIRROR_ROOT_SQL`]·받는 사람 판정이 읽는 칸 — 읽기 풀의 기존 SELECT 뿐이다(새 GRANT 없음).
pub const PERMISSION_MIRROR_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("message", "SELECT"),
    ("account", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("permission_request.card_message_id", "SELECT"),
    ("permission_request.agent_id", "SELECT"),
    ("agent_config", "SELECT"),
    // 위임장 칩(`cardMandateMeta`) — 원본 요청에 위임장이 있을 때만 읽는다.
    ("mandate", "SELECT"),
    ("work_item", "SELECT"),
];

/// 중립 권한 거울의 다시 쓴 본문·선택지·질문·`permissionMirror` 칸.
#[derive(Debug, PartialEq)]
struct NeutralMirror {
    body: String,
    options: Value,
    prompt: Option<Value>,
    mirror: Value,
}

/// TS `renderPermissionMirror` 의 중립 가지(순수 부분). 원본 `ask.options` 가 배열이 아니면(TS `permissionCardOptions` 로
/// 채움) `None` → TS.
fn neutral_mirror_render(root: &str, meta: &Value, handle: Option<&str>) -> Option<NeutralMirror> {
    let ask = meta.get("ask");
    let mut options = Vec::new();
    for x in ask?.get("options")?.as_array()? {
        let mut m = Map::new();
        // TS `{ id: o.id, label: o.label }` — undefined 칸은 JSON 에서 빠진다.
        for k in ["id", "label"] {
            if let Some(v) = x.as_object()?.get(k) {
                m.insert(k.into(), v.clone());
            }
        }
        options.push(Value::Object(m));
    }
    let prompt = ask
        .and_then(|a| a.get("prompt"))
        .filter(|p| p.as_str().is_some_and(|s| !s.is_empty()))
        .cloned();
    let handle = format!("@{}", handle.unwrap_or("agent"));
    Some(NeutralMirror {
        body: format!(
            "권한 요청 · {handle}\n원래 카드가 있는 채널에서 내용을 확인하고 정해 주세요.\nharkroom://message/{root}"
        ),
        options: Value::Array(options),
        prompt,
        mirror: serde_json::json!({ "rootId": root, "neutral": true }),
    })
}

/// TS `mirrorAudienceSeesRoot` — 거울 채널의 받는 사람이 모두 원본 채널도 보는가.
pub(crate) fn audience_sees_root(
    same: bool,
    root: &crate::core::audience::Audience,
    mirror: &crate::core::audience::Audience,
) -> bool {
    use crate::core::audience::Audience;
    if same {
        return true;
    }
    match (root, mirror) {
        (Audience::All, _) => true,
        (_, Audience::All) => false,
        (Audience::Accounts(r), Audience::Accounts(m)) => m.iter().all(|id| r.contains(id)),
    }
}

/// 권한 카드 거울 — 중립이면 중립 꼴, 원본을 볼 수 있으면 같은 카드 꼴([`full_mirror_render`]). 못 고르는 꼴·못 읽으면 `None` → TS.
async fn neutral_mirror(read: &PgPool, root: &str, channel: &str) -> Option<NeutralMirror> {
    let row: Option<(Value, String, Option<String>)> = sqlx::query_as(PERMISSION_MIRROR_ROOT_SQL)
        .bind(root)
        .fetch_optional(read)
        .await
        .ok()?;
    let (meta, root_channel, handle) = row?;
    let same = root_channel == channel;
    let sees = same || {
        let ra = crate::core::audience::audience_for(read, &root_channel)
            .await
            .ok()?;
        let ma = crate::core::audience::audience_for(read, channel)
            .await
            .ok()?;
        audience_sees_root(same, &ra, &ma)
    };
    if !sees {
        return neutral_mirror_render(root, &meta, handle.as_deref());
    }
    // 같은 카드를 그리는 거울 — 읽을 수 없는 꼴이면 먼저 `None`(→ TS), 소유자·위임장 칩 읽기는 그다음.
    full_mirror_render(root, &meta, handle.as_deref(), None, None)?;
    let owner: Option<Option<String>> = sqlx::query_scalar(MIRROR_OWNER_SQL)
        .bind(root)
        .fetch_optional(read)
        .await
        .ok()?;
    // 칩은 거울 채널을 기준으로 다시 만든다(TS F1) — 원본 카드의 칩 이름을 옮기지 않는다.
    let chip = match mirror_mandate_id(&meta)? {
        Some(m) => Some(super::permission_request::card_mandate_meta(read, m, channel).await?),
        None => None,
    };
    full_mirror_render(
        root,
        &meta,
        handle.as_deref(),
        owner.flatten().as_deref(),
        chip,
    )
}

/// 원본 요청의 위임장(`permissionRequest.mandate.id`). 없으면 `Some(None)`, 꼴이 어긋나면 `None`(→ TS).
fn mirror_mandate_id(meta: &Value) -> Option<Option<&str>> {
    match meta.get("permissionRequest")?.get("mandate") {
        None | Some(Value::Null) => Some(None),
        Some(m) => Some(Some(m.get("id")?.as_str()?)),
    }
}

/// 원본 요청의 경고 — 문자열만(TS `Set.has` 는 문자열 아닌 값과 맞지 않는다). 배열이 아니면 `None`(→ TS).
fn mirror_warnings(pr: &Map<String, Value>) -> Option<Vec<&str>> {
    match pr.get("warnings") {
        None | Some(Value::Null) => Some(Vec::new()),
        Some(w) => Some(w.as_array()?.iter().filter_map(Value::as_str).collect()),
    }
}

/// 원본 요청의 파일(`permissionRequest.files`) — 카드 meta 의 꼴 그대로 읽는다. 꼴이 어긋나면 `None`(→ TS).
fn mirror_files(
    pr: &Map<String, Value>,
) -> Option<Vec<crate::core::permission_command::MatchedFile>> {
    let Some(f) = pr.get("files").filter(|v| !v.is_null()) else {
        return Some(Vec::new());
    };
    f.as_array()?
        .iter()
        .map(|x| {
            let sha256 = x.get("sha256")?.as_str()?;
            // TS `sha256.slice(0, 12)` — 짧거나 ASCII 가 아니면 글자 단위가 어긋날 수 있어 TS.
            if sha256.len() < 12 || !sha256.is_ascii() {
                return None;
            }
            Some(crate::core::permission_command::MatchedFile {
                path: x.get("path")?.as_str()?.into(),
                size: x.get("size")?.as_u64()?,
                sha256: sha256.into(),
                secret: x.get("secret")?.as_bool()?,
                preview: match x.get("preview") {
                    None => None,
                    Some(p) => Some(p.as_str()?.into()),
                },
            })
        })
        .collect()
}

/// TS `renderPermissionMirror` 의 소유자 읽기(같은 카드를 그리는 거울) — 원본 요청 행의 에이전트 소유자.
pub const MIRROR_OWNER_SQL: &str = "select c.owner_account_id::text from permission_request p \
     join agent_config c on c.account_id = p.agent_id where p.card_message_id = $1::uuid limit 1";

/// TS `permissionBodyTargetLine`.
fn body_target_line(kind: &str, target: &str, ci: bool) -> Option<String> {
    match kind {
        "tool" => Some(format!("명령 허용 `{target}`")),
        "merge" if !ci => Some(format!("머지 `{target}`")),
        _ => None,
    }
}

/// TS `permissionCardBody` — 경고 줄은 tool·merge·command 에(CI 거절 카드 빼고), 파일 블록은 command 에만.
#[allow(clippy::too_many_arguments)]
fn permission_body(
    kind: &str,
    target: &str,
    once: Option<&Once>,
    line: bool,
    handle: &str,
    reason: &str,
    warnings: &[&str],
    files: &[crate::core::permission_command::MatchedFile],
) -> Option<String> {
    let r = crate::core::permission_card::one_line_reason(reason);
    let warn = crate::core::permission_card::body_warning_line(warnings)
        .map_or(String::new(), |l| format!("\n{l}"));
    if kind == "command" {
        let fb = crate::core::permission_command::files_block(files);
        return Some(format!(
            "권한 요청 · {handle}\n정확히 이 명령 하나 `{target}` — 이 스레드에서만 · 「이번 한 번」{warn}{fb}\n이유: {r}"
        ));
    }
    if kind == "merge" && once.is_some_and(Once::ci) {
        return Some(crate::core::permission_card::merge_card_body(
            target, once, handle, reason,
        ));
    }
    let ci = once.is_some_and(Once::ci);
    if line && let Some(t) = body_target_line(kind, target, ci) {
        return Some(format!("권한 요청 · {handle}\n{t}{warn}\n이유: {r}"));
    }
    let what = match kind {
        "tool" => format!("명령 허용 `{target}` — 이 채널의 모든 대화에서"),
        "merge" => format!("머지 권한 `{target}`"),
        _ => return None,
    };
    Some(format!(
        "권한 요청 · {handle}\n{what} · 승인하면 7일{warn}\n이유: {r}"
    ))
}

use crate::core::permission_card::Once;

/// 원본 `permissionRequest.once` 읽기.
fn once_of(v: &Value) -> Option<Once> {
    Some(Once {
        number: v.get("number")?.as_i64()?,
        head_sha: v.get("headSha")?.as_str()?.into(),
        reason: v.get("reason")?.as_str()?.into(),
        failed_checks: match v.get("failedChecks") {
            None => Vec::new(),
            Some(f) => f
                .as_array()?
                .iter()
                .map(|x| x.as_str().map(String::from))
                .collect::<Option<_>>()?,
        },
    })
}

/// TS `renderPermissionMirror` 의 같은 카드 가지(순수 부분) — 원본을 볼 수 있는 거울. 경고(코드·본문 줄)·파일 블록·위임장 칩(`chip`,
/// 거울 채널 기준으로 다시 만든 것)을 싣는다. 경고·파일·위임장의 꼴이 어긋난 요청, `ask.options` 가 배열이 아닌 원본은 `None` → TS.
fn full_mirror_render(
    root: &str,
    meta: &Value,
    handle: Option<&str>,
    owner: Option<&str>,
    chip: Option<Value>,
) -> Option<NeutralMirror> {
    let pr = meta.get("permissionRequest")?.as_object()?;
    let warnings = mirror_warnings(pr)?;
    let files = mirror_files(pr)?;
    mirror_mandate_id(meta)?;
    let kind = pr.get("kind")?.as_str()?;
    if !["tool", "merge", "command"].contains(&kind) {
        return None;
    }
    let target = pr.get("target")?.as_str()?;
    let reason = pr.get("reason")?.as_str()?;
    let once_v = pr.get("once").filter(|v| !v.is_null());
    let once = match once_v {
        Some(v) => Some(once_of(v)?),
        None => None,
    };
    let line = pr.get("line").filter(|v| !v.is_null());
    let base = neutral_mirror_render(root, meta, handle)?;
    let h = format!("@{}", handle.unwrap_or("agent"));
    let body = permission_body(
        kind,
        target,
        once.as_ref(),
        line.is_some(),
        &h,
        reason,
        &warnings,
        &files,
    )?;
    let mut m = Map::new();
    m.insert("rootId".into(), Value::from(root));
    m.insert("neutral".into(), Value::Bool(false));
    m.insert("kind".into(), Value::from(kind));
    if let Some(o) = owner {
        m.insert("ownerAccountId".into(), Value::from(o));
    }
    if let (Some(o), Some(v)) = (&once, once_v) {
        let mut x = Map::new();
        x.insert("number".into(), serde_json::json!(o.number));
        x.insert("headSha".into(), Value::from(o.head_sha.clone()));
        x.insert("reason".into(), Value::from(o.reason.clone()));
        if v.get("failedChecks").is_some() {
            x.insert("failedChecks".into(), serde_json::json!(o.failed_checks));
        }
        m.insert("once".into(), Value::Object(x));
    }
    if let Some(l) = line {
        m.insert("line".into(), l.clone());
        if let Some(t) = body_target_line(kind, target, once.as_ref().is_some_and(Once::ci)) {
            m.insert("bodyTargetLine".into(), Value::from(t));
        }
    }
    // H4: 같은 카드를 그리도록 경고 코드(그리는 순서)와 본문 경고 줄도 옮긴다.
    let ordered: Vec<&str> = crate::core::permission_card::TOOL_RULE_WARNING_HEAD_KO
        .iter()
        .map(|(w, _)| *w)
        .filter(|w| warnings.contains(w))
        .collect();
    // TS `pr.warnings?.length` — 원래 배열의 길이로 정한다(문자열 아닌 값만 있어도 빈 `warnings` 를 싣는다).
    if pr
        .get("warnings")
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty())
    {
        m.insert("warnings".into(), serde_json::json!(ordered));
    }
    if let Some(l) = crate::core::permission_card::body_warning_line(&warnings) {
        m.insert("bodyWarningLine".into(), Value::from(l));
    }
    if let Some(c) = chip {
        m.insert("mandate".into(), c);
    }
    Some(NeutralMirror {
        body,
        options: base.options,
        prompt: base.prompt,
        mirror: Value::Object(m),
    })
}

/// 열린 카드 검사를 Rust 가 할 수 있는 꼴 — TS 의 `audience.kind === 'human' && !mirrorOf && !mergeDenialId && threadRootId`.
/// `supersedes` 의 id 는 밝힌 카드로 센다(TS `declared`). 고르면 스레드 머리 id.
fn open_card_thread(o: &Map<String, Value>) -> Option<&str> {
    if ["to", "mirrorOf", "mergeDenialId"]
        .iter()
        .any(|k| o.contains_key(*k))
    {
        return None;
    }
    o.get("threadRootId")?.as_str()
}

/// TS `listOpenHumanAsks` — 이 작성자가 이 스레드(머리 포함)에 열어 둔 사람 앞 카드. 서버가 세운 카드·거울은 뺀다.
pub const OPEN_CARD_SQL: &str = "select id::text from message
      where channel_id = $2::uuid and (id = $3::uuid or thread_root_id = $3::uuid)
        and author_id = $1::uuid and deleted_at is null
        and meta->>'kind' = 'ask'
        and meta->'ask'->>'answeredWith' is null
        and meta->'ask'->>'closedAt' is null
        and meta->'ask'->'to'->>'kind' = 'human'
        and meta->'ask'->>'mirrorOf' is null
        and not (meta ? 'permissionRequest') and not (meta ? 'chainBackstop') and not (meta ? 'mergeDenial')
      order by seq";

/// [`OPEN_CARD_SQL`] 이 읽는 칸 — 읽기 풀의 기존 `message` SELECT 뿐이다(새 GRANT 없음).
pub const OPEN_CARD_READ_PRIVILEGES: &[(&str, &str)] = &[("message", "SELECT")];

/// TS `open_card_in_thread` 거절 — `supersedes`·`keepOpen` 에 밝히지 않은 열린 카드가 있으면 그 id 들을 싣는다.
fn open_card_refusal(open: Vec<String>, keep: &HashSet<&str>) -> Option<String> {
    let undeclared: Vec<String> = open
        .into_iter()
        .filter(|id| !keep.contains(id.as_str()))
        .collect();
    if undeclared.is_empty() {
        return None;
    }
    Some(super::respond::text_result(
        &serde_json::json!({ "error": {
            "code": "open_card_in_thread",
            "message": "you already have open card(s) in this thread — pass each id in `supersedes` (this card replaces or merges them) or in `keepOpen` (a separate decision that stays open)",
            "openCardIds": undeclared,
        } })
        .to_string(),
    ))
}

/// 거절 앞머리([`answer`])를 다 지난 카드 — 스레드 안이면 먼저 열린 카드 검사(`open_card_in_thread`, 읽기 풀)를 하고, 평범한
/// 카드면 세운다. 고를 수 없는 꼴·쓰기 풀 없음·DB 오류는 `None`(→ TS).
pub async fn answer_plain(
    read: &PgPool,
    st: Option<&crate::core::msg_post::PostState>,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    let a = parse(args)?;
    let o = args.as_object()?;
    if let Some(thread) = open_card_thread(o) {
        let open: Vec<String> = sqlx::query_scalar(OPEN_CARD_SQL)
            .bind(&me.id)
            .bind(a.channel)
            .bind(thread)
            .fetch_all(read)
            .await
            .ok()?;
        // TS `declared = new Set([...supersedes, ...keepOpen])`.
        let mut keep: HashSet<&str> = o
            .get("keepOpen")
            .and_then(Value::as_array)
            .map(|v| v.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        keep.extend(supersedes_list(o));
        if let Some(r) = open_card_refusal(open, &keep) {
            return Some(r);
        }
    }
    if let Some(denial) = o.get("mergeDenialId").and_then(Value::as_str) {
        return merge_denial_answer(
            read,
            st,
            me,
            o,
            a.channel,
            o.get("threadRootId").and_then(Value::as_str),
            denial,
            (cause, turn, operator),
        )
        .await;
    }
    let st = st?;
    let push_to: Option<String>;
    let mut mirror_render: Option<NeutralMirror> = None;
    let audience = match o.get("to").and_then(Value::as_str) {
        Some(to) => {
            if !addressed(o) {
                return None;
            }
            let row: Option<(String, String)> = sqlx::query_as(TO_KIND_SQL)
                .bind(to_handle(to))
                .fetch_optional(read)
                .await
                .ok()?;
            let row = row?;
            // 글 뒤 푸시 job 쓰기 칸이 없으면 TS.
            if !crate::write::missing_in(
                &st.write,
                crate::core::permission_card::LINK_PUSH_PRIVILEGES,
                &[],
            )
            .await
            .ok()?
            .is_empty()
            {
                return None;
            }
            push_to = Some(row.0.clone());
            account_audience(row)?
        }
        None if plain(o) => {
            push_to = human_ask_push(read, st, me, a.channel, cause).await?;
            serde_json::json!({ "kind": "human" })
        }
        None if mirror_plain(o) => {
            // 권한 카드의 거울은 원본 요청으로 Rust 가 다시 쓴다(중립·같은 카드 꼴). 글 뒤 `syncAskMirrors` 쓰기 칸이 없어도 TS.
            let root = o.get("mirrorOf")?.as_str()?;
            let perm: Option<bool> = sqlx::query_scalar(MIRROR_PERMISSION_SQL)
                .bind(root)
                .fetch_optional(read)
                .await
                .ok()?;
            match perm {
                Some(false) => {}
                // 중립 거울과 같은 카드 거울(경고·파일·위임장 칩 포함)을 Rust 가 다시 쓴다. 꼴이 어긋나면 TS.
                Some(true) => mirror_render = Some(neutral_mirror(read, root, a.channel).await?),
                None => return None,
            }
            use crate::core::ask::{ASK_PRIVILEGES, ASK_SEQUENCE_PRIVILEGES};
            if !crate::write::missing_in(&st.write, ASK_PRIVILEGES, ASK_SEQUENCE_PRIVILEGES)
                .await
                .ok()?
                .is_empty()
            {
                return None;
            }
            push_to = human_ask_push(read, st, me, a.channel, cause).await?;
            serde_json::json!({ "kind": "human" })
        }
        None => return None,
    };
    let olds = supersedes_list(o);
    if !olds.is_empty() && !supersede_ready(st).await? {
        return None;
    }
    let plan_step = o.get("planStepId").and_then(Value::as_str);
    if plan_step.is_some() && !plan_step_ready(st).await? {
        return None;
    }
    let mut meta = plain_meta(o, audience)?;
    if let Some(root) = o.get("mirrorOf").and_then(Value::as_str) {
        meta.get_mut("ask")?
            .as_object_mut()?
            .insert("mirrorOf".into(), Value::from(root));
    }
    if let Some(r) = &mirror_render {
        let ask = meta.get_mut("ask")?.as_object_mut()?;
        ask.insert("options".into(), r.options.clone());
        match &r.prompt {
            Some(p) => ask.insert("prompt".into(), p.clone()),
            None => ask.remove("prompt"),
        };
        meta.insert("permissionMirror".into(), r.mirror.clone());
    }
    let mut sub = Map::new();
    for k in ["channelId", "body", "threadRootId", "model"] {
        if let Some(v) = o.get(k) {
            sub.insert(k.into(), v.clone());
        }
    }
    if let Some(r) = &mirror_render {
        sub.insert("body".into(), Value::from(r.body.clone()));
    }
    super::msg_post::answer_ask(
        st,
        me,
        &Value::Object(sub),
        meta,
        cause,
        turn,
        operator,
        &olds,
        plan_step,
        push_to.as_deref(),
    )
    .await
}

/// TS `readDenial`(잠금 없음) — `now` 는 DB `now()` 로 잰다.
pub const DENIAL_READ_SQL: &str = "select agent_id::text, scope, channel_id::text, thread_root_id::text,
            expires_at <= now() as expired, used_at is not null as used, obsoleted_at is not null as obsolete,
            (obsoleted_at is not null and exists (
              select 1 from merge_denial n
               where n.agent_id = d.agent_id and n.scope = d.scope and n.channel_id = d.channel_id and n.thread_root_id = d.thread_root_id
                 and n.pr_number = d.pr_number and n.head_sha <> d.head_sha and n.created_at > d.created_at)) as head_moved
       from merge_denial d where id = $1::uuid";

/// TS `openPermissionRequest` 의 `not_agent` 검사.
const DENIAL_AGENT_SQL: &str = "select c.owner_account_id::text from account a join agent_config c on c.account_id = a.id \
     where a.id = $1::uuid and a.kind = 'agent'";

/// TS `openPermissionRequest` 의 기다리는 카드 찾기(거절에서 온 요청 — `denial_id` 가 같은 것만).
pub const DENIAL_PENDING_SQL: &str = "select id::text, card_message_id::text from permission_request
      where agent_id = $1::uuid and kind = 'merge' and target = $2 and thread_root_id = $3::uuid and channel_id = $4::uuid
        and status = 'pending' and expires_at > now() and denial_id = $5::uuid
      order by created_at desc limit 1";

/// 머지 거절 카드의 읽기 풀 칸 — [`DENIAL_READ_SQL`]·[`DENIAL_AGENT_SQL`]·[`DENIAL_PENDING_SQL`]. 하나라도 없으면 TS.
pub const MERGE_DENIAL_ASK_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("merge_denial.id", "SELECT"),
    ("merge_denial.agent_id", "SELECT"),
    ("merge_denial.scope", "SELECT"),
    ("merge_denial.pr_number", "SELECT"),
    ("merge_denial.head_sha", "SELECT"),
    ("merge_denial.channel_id", "SELECT"),
    ("merge_denial.thread_root_id", "SELECT"),
    ("merge_denial.expires_at", "SELECT"),
    ("merge_denial.used_at", "SELECT"),
    ("merge_denial.obsoleted_at", "SELECT"),
    ("merge_denial.created_at", "SELECT"),
    ("merge_denial.reason", "SELECT"),
    ("merge_denial.failed_checks", "SELECT"),
    ("account", "SELECT"),
    ("agent_config", "SELECT"),
    ("permission_request.id", "SELECT"),
    ("permission_request.card_message_id", "SELECT"),
    ("permission_request.agent_id", "SELECT"),
    ("permission_request.kind", "SELECT"),
    ("permission_request.target", "SELECT"),
    ("permission_request.thread_root_id", "SELECT"),
    ("permission_request.channel_id", "SELECT"),
    ("permission_request.status", "SELECT"),
    ("permission_request.expires_at", "SELECT"),
    ("permission_request.denial_id", "SELECT"),
    ("permission_request.created_at", "SELECT"),
];

/// TS `readDenial` 의 카드 칸(PR·head·사유·실패 체크).
const DENIAL_ONCE_SQL: &str = "select pr_number::bigint, head_sha, reason, failed_checks from merge_denial where id = $1::uuid";

type DenialRow = (String, String, String, String, bool, bool, bool, bool);

/// TS `prepareDenialCard` 의 거절 차례 그대로. 통과면 `Ok(scope)`.
fn denial_refusal(
    row: Option<DenialRow>,
    me: &str,
    channel: &str,
    thread: Option<&str>,
) -> Result<String, &'static str> {
    let Some((agent, scope, ch, root, expired, used, obsolete, head_moved)) = row else {
        return Err("denial_not_found");
    };
    if agent != me {
        return Err("denial_other_agent");
    }
    if ch != channel || root != thread.unwrap_or("") {
        return Err("denial_other_thread");
    }
    if used {
        return Err("denial_used");
    }
    if expired {
        return Err("denial_expired");
    }
    if obsolete {
        return Err(if head_moved {
            "head_moved"
        } else {
            "pr_closed"
        });
    }
    Ok(scope)
}

/// TS `DENIAL_CARD_REFUSAL_MESSAGE`.
fn denial_message(code: &str) -> &'static str {
    match code {
        "denial_not_found" => "no such merge denial — use the denialId the merge wrapper returned",
        "denial_other_agent" => "that merge denial belongs to another agent",
        "denial_other_thread" => {
            "that merge denial happened in another thread; post the card in the thread where the merge was refused"
        }
        "denial_used" => "that merge denial was already used to grant permission",
        "denial_expired" => "that merge denial expired; ask the wrapper again",
        "pr_closed" => "that pull request was already merged or closed — no card is needed",
        _ => {
            "that pull request got a new head after this refusal — call the merge wrapper again and use the new denialId"
        }
    }
}

/// 저장된 거절 scope 를 TS `repoScope(scope.slice('repo:'.length))` 로 다시 정한 요청 target. 못 지나면 `None`(→ TS: `bad_repo` 등).
fn denial_target(scope: &str) -> Option<String> {
    crate::core::merge_approval_peek::repo_scope(scope.strip_prefix("repo:")?)
}

/// 머지 거절 카드(`mergeDenialId`) — TS `prepareDenialCard` 의 거절과, `openPermissionRequest` 가 같은 거절 기록의 기다리는 카드를
/// 찾아 주는 `pending` 답까지 Rust 가 답한다. 첫 부름은 [`open_denial_card`]. 읽기 칸이 없거나 DB 오류도 `None`.
#[allow(clippy::too_many_arguments)]
async fn merge_denial_answer(
    read: &PgPool,
    st: Option<&crate::core::msg_post::PostState>,
    me: &Account,
    o: &Map<String, Value>,
    channel: &str,
    thread: Option<&str>,
    denial: &str,
    (cause, turn, operator): (Option<&str>, Option<&str>, bool),
) -> Option<String> {
    let missing = crate::write::missing_in(read, MERGE_DENIAL_ASK_READ_PRIVILEGES, &[])
        .await
        .ok()?;
    if !missing.is_empty() {
        return None;
    }
    let row: Option<DenialRow> = sqlx::query_as(DENIAL_READ_SQL)
        .bind(denial)
        .fetch_optional(read)
        .await
        .ok()?;
    let scope = match denial_refusal(row, &me.id, channel, thread) {
        Ok(s) => s,
        Err(code) => return Some(err(code, denial_message(code))),
    };
    let target = denial_target(&scope)?;
    let owner: Option<Option<String>> = sqlx::query_scalar(DENIAL_AGENT_SQL)
        .bind(&me.id)
        .fetch_optional(read)
        .await
        .ok()?;
    let owner = owner?; // `not_agent` 는 TS 가 답한다.
    let pending: Option<(String, Option<String>)> = sqlx::query_as(DENIAL_PENDING_SQL)
        .bind(&me.id)
        .bind(&target)
        .bind(thread?)
        .bind(channel)
        .bind(denial)
        .fetch_optional(read)
        .await
        .ok()?;
    let Some((request_id, card)) = pending else {
        return open_denial_card(
            read,
            st?,
            me,
            o,
            channel,
            thread?,
            denial,
            &target,
            owner.as_deref(),
            (cause, turn, operator),
        )
        .await;
    };
    // TS `jsonResult` 칸 차례(requestId·cardMessageId·pending·message).
    Some(super::respond::text_result(&format!(
        "{{\"requestId\":{},\"cardMessageId\":{},\"pending\":true,\"message\":{}}}",
        Value::from(request_id),
        card.map_or(Value::Null, Value::from),
        Value::from("the same request is already waiting for the owner in this thread"),
    )))
}

/// TS `raisePermission`(merge · 거절에서 온 요청)의 첫 부름 — 요청 줄 세우기(하루 상한 → insert → supersede → 감사)를 tx 로 열어 둔 채
/// 카드를 세우고, 카드가 섰으면 커밋한 뒤 잇기·푸시. 위임 있는 턴은 그 위임을 요청 줄·카드에 싣는다(P6-4c). 쓰기 칸 없음·재생·TS 로 넘길 글은 tx 를 되돌리고 `None`(→ TS).
#[allow(clippy::too_many_arguments)]
async fn open_denial_card(
    read: &PgPool,
    st: &crate::core::msg_post::PostState,
    me: &Account,
    o: &Map<String, Value>,
    channel: &str,
    thread: &str,
    denial: &str,
    target: &str,
    owner: Option<&str>,
    (cause, turn, operator): (Option<&str>, Option<&str>, bool),
) -> Option<String> {
    use crate::core::msg_post::{iso_ms, now_ms};
    use crate::core::permission_card as pc;
    let mut privs = pc::REQUEST_WRITE_PRIVILEGES.to_vec();
    privs.extend_from_slice(pc::LINK_PUSH_PRIVILEGES);
    privs.extend_from_slice(DENIAL_CARD_PATCH_PRIVILEGES);
    if !crate::write::missing_in(&st.write, &privs, &[])
        .await
        .ok()?
        .is_empty()
    {
        return None;
    }
    let (number, head_sha, reason, failed): (i64, Option<String>, Option<String>, Vec<String>) =
        sqlx::query_as(DENIAL_ONCE_SQL)
            .bind(denial)
            .fetch_optional(read)
            .await
            .ok()??;
    let once = pc::Once {
        number,
        head_sha: head_sha.unwrap_or_default(),
        reason: reason.unwrap_or_else(|| "not_granted".into()),
        failed_checks: failed,
    };
    let body = o.get("body")?.as_str()?;
    let why = pc::merge_denial_reason(number, Some(once.reason.as_str()), body);
    let now = now_ms();
    let (now_iso, expires_iso) = (iso_ms(now), iso_ms(now + pc::PERMISSION_REQUEST_TTL_MS));
    // W4(P6-4c): 요청을 낸 턴의 위임 — 그 원인으로 받은 살아 있는 턴 임대의 것(TS `mandateForAgentPost`). 오퍼레이터를 거치지 않은 부름이면 없다.
    // 있으면 요청 줄의 `mandate_id`·카드 meta 의 `mandateId`·위임장 칩(`cardMandateMeta`)·[이 위임장 동안] 선택지·`line` 한도가 그것을 따른다.
    let mandate: Option<String> = match cause.filter(|_| operator) {
        Some(c) => {
            let mut conn = st.write.acquire().await.ok()?;
            crate::core::cause_link::mandate_for_agent_post(&mut conn, &me.id, c, now, iso_ms)
                .await
                .ok()?
        }
        None => None,
    };
    let chip = match mandate.as_deref() {
        Some(m) => Some((
            m,
            super::permission_request::card_mandate_meta(read, m, channel).await?,
        )),
        None => None,
    };
    let short = target.strip_prefix("repo:").unwrap_or(target);
    // 요청 id 는 카드와 같은 tx 의 훅이 세운 뒤 meta 에 박는다 — 여기서는 빈 자리.
    let pr_meta = pc::merge_request_meta(
        "",
        &me.id,
        owner,
        target,
        &why,
        &once,
        &now_iso,
        &expires_iso,
        chip,
    );
    let mut meta = pc::merge_card_meta(pr_meta, once.ci());
    // 위임장 없는 턴이면 [이 스레드로 위임장 만들고 더하기]가 서는데, 이 스레드의 머리 글이 소유자·소유자 에이전트 글이 아니면 그 버튼은
    // 늘 409 `mandate_unavailable` 이다 — 세우지 않고 [이번 한 번]을 주 버튼으로 둔다.
    if mandate.is_none() && !once.ci() {
        let open: bool = match owner {
            Some(ow) => sqlx::query_scalar(pc::CARD_THREAD_OPEN_SQL)
                .bind(thread)
                .bind(channel)
                .bind(ow)
                .fetch_one(read)
                .await
                .ok()?,
            None => false,
        };
        if !open {
            pc::drop_new_mandate(&mut meta);
        }
    }
    let card_body = pc::merge_card_body(short, Some(&once), &format!("@{}", me.handle), &why);
    let mut sub = Map::new();
    sub.insert("channelId".into(), Value::from(channel));
    sub.insert("body".into(), Value::from(card_body));
    sub.insert("threadRootId".into(), Value::from(thread));
    if let Some(m) = o.get("model") {
        sub.insert("model".into(), m.clone());
    }
    let hook = DenialRequestHook {
        agent: &me.id,
        target,
        why: &why,
        channel,
        thread,
        denial,
        number,
        now: &now_iso,
        expires: &expires_iso,
        owner,
        mandate: mandate.as_deref(),
        request_id: std::sync::OnceLock::new(),
    };
    let posted = super::msg_post::post_card(
        st,
        me,
        &Value::Object(sub),
        meta,
        cause,
        turn,
        operator,
        Some(&hook),
    )
    .await?;
    let (card_id, _notified) = match posted {
        Ok(p) => p,
        Err(answer) => return Some(answer),
    };
    let request_id = hook.request_id.get()?;
    Some(super::respond::text_result(&pc::created_result(
        request_id,
        &card_id,
        &expires_iso,
    )))
}

/// 카드 meta 의 `permissionRequest.requestId` 를 훅 안에서 채운다.
pub(super) const DENIAL_CARD_PATCH_SQL: &str = "update message set meta = jsonb_set(meta, '{permissionRequest,requestId}', to_jsonb($2::text)) \
     where id = $1::uuid";

/// [`DENIAL_CARD_PATCH_SQL`] 의 쓰기 풀 칸.
pub(super) const DENIAL_CARD_PATCH_PRIVILEGES: &[(&str, &str)] = &[
    ("message.id", "SELECT"),
    ("message.meta", "SELECT"),
    ("message.meta", "UPDATE"),
];

/// 머지 거절 카드의 요청 줄(하루 상한 → insert → supersede → 감사) → meta 의 requestId → 잇기 → 푸시를 **카드 글과 같은 tx** 에서 한다.
/// 예전에는 요청 tx 를 열어 둔 채 카드를 따로 커밋해서, 요청 커밋이 실패하면 카드만 남고(→ TS 로 넘겨 또 카드) 재시도마다 카드가 늘었다.
#[derive(Debug)]
struct DenialRequestHook<'a> {
    agent: &'a str,
    target: &'a str,
    why: &'a str,
    channel: &'a str,
    thread: &'a str,
    denial: &'a str,
    number: i64,
    now: &'a str,
    expires: &'a str,
    owner: Option<&'a str>,
    mandate: Option<&'a str>,
    request_id: std::sync::OnceLock<String>,
}

/// 하루 상한이면 카드를 되돌리는 거절(TS `too_many`).
pub(super) fn denial_hook_outcome(
    opened: crate::core::permission_card::Opened,
) -> Result<String, crate::core::msg_post::Rejection> {
    use crate::core::permission_card as pc;
    match opened {
        pc::Opened::Created { request_id } => Ok(request_id),
        pc::Opened::TooMany => Err(crate::core::msg_post::Rejection {
            status: 429,
            code: "too_many".into(),
            message: pc::too_many_message(),
        }),
    }
}

/// 소유자가 inbox 로 알림받지 않았으면 푸시(TS `raisePermission` 글 뒤).
pub(super) fn denial_needs_push(owner: Option<&str>, notified: &HashSet<String>) -> bool {
    owner.is_some_and(|o| !notified.contains(o))
}

impl crate::core::msg_post::BeforeCommit for DenialRequestHook<'_> {
    fn run<'b>(
        &'b self,
        tx: &'b mut sqlx::Transaction<'static, sqlx::Postgres>,
        message_id: &'b str,
        notified: &'b HashSet<String>,
    ) -> crate::core::msg_post::BeforeCommitFuture<'b> {
        use crate::core::permission_card as pc;
        Box::pin(async move {
            let opened = pc::open_request(
                tx,
                &pc::NewRequest {
                    kind: "merge",
                    agent: self.agent,
                    target: self.target,
                    reason: self.why,
                    warnings: &[],
                    channel: self.channel,
                    thread: self.thread,
                    denial: Some((self.denial, self.number)),
                    mandate: self.mandate,
                    now: self.now,
                    expires: self.expires,
                },
            )
            .await?;
            let request_id = match denial_hook_outcome(opened) {
                Ok(id) => id,
                Err(rej) => return Ok(Some(rej)),
            };
            sqlx::query(DENIAL_CARD_PATCH_SQL)
                .bind(message_id)
                .bind(&request_id)
                .execute(&mut **tx)
                .await?;
            sqlx::query(pc::LINK_CARD_SQL)
                .bind(&request_id)
                .bind(message_id)
                .execute(&mut **tx)
                .await?;
            if denial_needs_push(self.owner, notified) {
                sqlx::query(pc::enqueue_ask_push_sql())
                    .bind(self.owner)
                    .bind(message_id)
                    .execute(&mut **tx)
                    .await?;
            }
            let _ = self.request_id.set(request_id);
            Ok(None)
        })
    }
}

/// `planStepId` 를 Rust 가 맡을 수 있나 — 쓰기 풀에 계획 쓰기 권한([`super::plan_write::PLAN_WRITE_PRIVILEGES`])이 다 있을 때만.
/// 계획이 없거나(`no_plan`) 그 단계가 없으면(`unknown_item`) TS `linkPlanCard` 처럼 카드는 세우고 그 거절을 답의 `plan` 칸에 싣는다
/// ([`super::plan_write::link_plan_card`] 가 잠근 판에서 판정한다). 권한이 모자라면 `Some(false)`(→ TS), DB 오류는 `None`.
pub(super) async fn plan_step_ready(st: &crate::core::msg_post::PostState) -> Option<bool> {
    use super::plan_write::{PLAN_WRITE_PRIVILEGES, PLAN_WRITE_SEQUENCE_PRIVILEGES};
    let missing = crate::write::missing_in(
        &st.write,
        PLAN_WRITE_PRIVILEGES,
        PLAN_WRITE_SEQUENCE_PRIVILEGES,
    )
    .await
    .ok()?;
    Some(missing.is_empty())
}

/// 대신하기를 Rust 가 맡을 수 있나 — 쓰기 풀에 C3b-1 [`ASK_PRIVILEGES`](글 `meta` UPDATE·inbox·outbox)가 다 있을 때만.
/// 아니면 `Some(false)`(→ TS), DB 오류는 `None`(→ TS). 옛 카드가 묶음에 담겨 있어도(P6-4b) 묶음 줄 옮기기는 같은 권한으로 Rust 가 한다.
async fn supersede_ready(st: &crate::core::msg_post::PostState) -> Option<bool> {
    use crate::core::ask::{ASK_PRIVILEGES, ASK_SEQUENCE_PRIVILEGES};
    let missing = crate::write::missing_in(&st.write, ASK_PRIVILEGES, ASK_SEQUENCE_PRIVILEGES)
        .await
        .ok()?;
    Some(missing.is_empty())
}

/// TS `supersedeAsk` 의 닫기 문장 그대로 — 열렸거나 글 답으로 닫힌 것만 `superseded` 로 닫는다.
pub const SUPERSEDE_ASK_SQL: &str = "update message
        set meta = jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(meta::jsonb, '{ask,closedAt}', to_jsonb(coalesce(meta->'ask'->>'closedAt', now()::text))),
                  '{ask,closedBy}', to_jsonb($3::text)),
                '{ask,closedReason}', to_jsonb('superseded'::text)),
              '{ask,supersededBy}', to_jsonb($2::text))
      where id = $1::uuid
        and deleted_at is null
        and meta->'ask'->>'answeredWith' is null
        and (meta->'ask'->>'closedAt' is null or meta->'ask'->>'closedReason' = 'replied')
        and not (meta ? 'permissionRequest')
      returning id::text";

/// TS `supersedeAsk` — 옛 카드를 닫고, `message.updated` 를 알리고, 거울을 따라 닫는다(`syncAskMirrors`, [`crate::core::ask_sync`]).
/// 새 카드는 이미 섰으므로 실패는 기록만 한다. 옛 카드를 담은 묶음에는 새 카드를 줄로 옮긴다(`carryBundleItem`,
/// [`crate::core::ask_bundle_add::carry_bundle_item`]) — TS 처럼 그 실패는 삼키고 거울 닫기로 간다.
pub(super) async fn supersede_ask(write: &PgPool, old: &str, new_id: &str, actor: &str) {
    let r: Result<(), sqlx::Error> = async {
        let mut conn = write.acquire().await?;
        let closed: Option<String> = sqlx::query_scalar(SUPERSEDE_ASK_SQL)
            .bind(old)
            .bind(new_id)
            .bind(actor)
            .fetch_optional(&mut *conn)
            .await?;
        if closed.is_none() {
            return Ok(());
        }
        crate::core::ask_sync::announce_updated(&mut conn, old).await?;
        if let Err(e) = crate::core::ask_bundle_add::carry_bundle_item(&mut conn, old, new_id).await
        {
            eprintln!("message.ask: carry bundle item {old} -> {new_id} failed: {e}");
        }
        crate::core::ask_sync::sync_ask_mirrors(&mut conn, "message.ask supersedes", old).await
    }
    .await;
    // 다름(기록): TS `supersedeAsk` 의 실패는 도구 오류로 올라간다(새 카드는 이미 섰는데도). Rust 는 기록만 하고 새 카드의
    // 성공 답을 돌려준다 — 옛 카드는 열린 채 남을 수 있다.
    if let Err(e) = r {
        eprintln!("message.ask: supersede {old} failed: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const C: &str = "0b7f3f92-3fa6-494a-8ab3-76d0d2a6a1c0";

    /// 머지 거절 카드: 요청 줄·잇기·푸시는 카드와 같은 tx 의 훅에서 — 하루 상한이면 카드까지 되돌리고(`too_many`), 카드만 남는 길이 없다.
    #[test]
    fn denial_card_request_is_written_in_the_card_tx() {
        use crate::core::permission_card::Opened;
        assert_eq!(
            denial_hook_outcome(Opened::Created {
                request_id: "r".into()
            }),
            Ok("r".into())
        );
        let rej = denial_hook_outcome(Opened::TooMany).unwrap_err();
        assert_eq!(rej.code, "too_many");
        assert_eq!(
            rej.message,
            crate::core::permission_card::too_many_message()
        );
        let notified: HashSet<String> = ["o".to_string()].into();
        assert!(!denial_needs_push(Some("o"), &notified));
        assert!(denial_needs_push(Some("p"), &notified));
        assert!(!denial_needs_push(None, &notified));
        assert!(DENIAL_CARD_PATCH_SQL.contains("'{permissionRequest,requestId}'"));
        assert!(DENIAL_CARD_PATCH_PRIVILEGES.contains(&("message.meta", "UPDATE")));
    }

    #[test]
    fn full_mirror_render_tool_with_line() {
        let meta = json!({
            "permissionRequest": { "kind": "tool", "target": "Bash(npm test:*)", "reason": "테스트\n돌림", "warnings": [], "line": { "cap": "x" } },
            "ask": { "options": [{ "id": "a", "label": "A", "hint": "h" }], "prompt": "p" }
        });
        let r = full_mirror_render(C, &meta, Some("bot"), Some(C), None).unwrap();
        assert_eq!(
            r.body,
            "권한 요청 · @bot\n명령 허용 `Bash(npm test:*)`\n이유: 테스트 돌림"
        );
        assert_eq!(r.options, json!([{ "id": "a", "label": "A" }]));
        assert_eq!(r.prompt, Some(json!("p")));
        assert_eq!(
            r.mirror,
            json!({ "rootId": C, "neutral": false, "kind": "tool", "ownerAccountId": C,
                    "line": { "cap": "x" }, "bodyTargetLine": "명령 허용 `Bash(npm test:*)`" })
        );
    }

    #[test]
    fn full_mirror_render_bodies_and_fallbacks() {
        let mk = |pr: Value| json!({ "permissionRequest": pr, "ask": { "options": [] } });
        let tool = full_mirror_render(
            C,
            &mk(json!({ "kind": "tool", "target": "t", "reason": "r" })),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            tool.body,
            "권한 요청 · @agent\n명령 허용 `t` — 이 채널의 모든 대화에서 · 승인하면 7일\n이유: r"
        );
        assert_eq!(
            tool.mirror,
            json!({ "rootId": C, "neutral": false, "kind": "tool" })
        );
        let merge = full_mirror_render(
            C,
            &mk(json!({ "kind": "merge", "target": "o/n", "reason": "r" })),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            merge.body,
            "권한 요청 · @agent\n머지 권한 `o/n` · 승인하면 7일\n이유: r"
        );
        let cmd = full_mirror_render(
            C,
            &mk(json!({ "kind": "command", "target": "ls", "reason": "r" })),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            cmd.body,
            "권한 요청 · @agent\n정확히 이 명령 하나 `ls` — 이 스레드에서만 · 「이번 한 번」\n이유: r"
        );
        let ci = full_mirror_render(
            C,
            &mk(json!({ "kind": "merge", "target": "o/n", "reason": "r", "line": {},
                        "once": { "number": 3, "headSha": "abcdef0123456", "reason": "ci_not_green", "failedChecks": [] } })),
            None,
            None,
            None,
        )
        .unwrap();
        assert!(ci.body.starts_with(
            "권한 요청 · @agent\nCI 실패 무시하고 이번 한 번 머지 `o/n` PR #3 · head abcdef012"
        ));
        assert_eq!(
            ci.mirror,
            json!({ "rootId": C, "neutral": false, "kind": "merge", "line": {},
                    "once": { "number": 3, "headSha": "abcdef0123456", "reason": "ci_not_green", "failedChecks": [] } })
        );
        // 꼴이 어긋난 경고·파일·위임장, 모르는 종류는 TS.
        for pr in [
            json!({ "kind": "tool", "target": "t", "reason": "r", "warnings": "w" }),
            json!({ "kind": "command", "target": "t", "reason": "r", "files": [{}] }),
            json!({ "kind": "command", "target": "t", "reason": "r",
                    "files": [{ "path": "a", "size": 1, "sha256": "short", "secret": false }] }),
            json!({ "kind": "tool", "target": "t", "reason": "r", "mandate": { "name": "x" } }),
            json!({ "kind": "other", "target": "t", "reason": "r" }),
        ] {
            assert!(full_mirror_render(C, &mk(pr), None, None, None).is_none());
        }
        assert!(
            full_mirror_render(
                C,
                &json!({ "permissionRequest": { "kind": "tool", "target": "t", "reason": "r" } }),
                None,
                None,
                None
            )
            .is_none()
        );
    }

    /// P6-4d — 경고·파일·위임장이 실린 요청의 같은 카드 거울(TS `renderPermissionMirror`·`permissionCardBody`).
    #[test]
    fn full_mirror_render_warnings_files_mandate() {
        let mk = |pr: Value| json!({ "permissionRequest": pr, "ask": { "options": [] } });
        // 경고: 본문 경고 줄(그리는 순서), meta 에는 순서대로 고른 코드와 `bodyWarningLine`. 모르는 코드는 버린다.
        let tool = full_mirror_render(
            C,
            &mk(
                json!({ "kind": "tool", "target": "t", "reason": "r", "line": {},
                        "warnings": ["short_prefix", "zzz", "runs_arbitrary"] }),
            ),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            tool.body,
            "권한 요청 · @agent\n명령 허용 `t`\n⚠ 무엇이든 돌릴 수 있다 · 접두가 짧다\n이유: r"
        );
        assert_eq!(
            tool.mirror,
            json!({ "rootId": C, "neutral": false, "kind": "tool", "line": {}, "bodyTargetLine": "명령 허용 `t`",
                    "warnings": ["runs_arbitrary", "short_prefix"], "bodyWarningLine": "⚠ 무엇이든 돌릴 수 있다 · 접두가 짧다" })
        );
        // 줄 없는 옛 카드에도 경고 줄.
        let old = full_mirror_render(
            C,
            &mk(json!({ "kind": "merge", "target": "o/n", "reason": "r", "warnings": ["uses_github_account"] })),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            old.body,
            "권한 요청 · @agent\n머지 권한 `o/n` · 승인하면 7일\n⚠ GitHub 계정으로 돈다\n이유: r"
        );
        // 문자열 아닌 경고만 있으면 빈 `warnings` 를 싣고 줄은 없다(TS `pr.warnings?.length`).
        let odd = full_mirror_render(
            C,
            &mk(json!({ "kind": "tool", "target": "t", "reason": "r", "warnings": [1] })),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            odd.mirror,
            json!({ "rootId": C, "neutral": false, "kind": "tool", "warnings": [] })
        );
        // 파일: command 본문에 파일 블록(미리 보기 무력화), meta 에는 옮기지 않는다(TS 와 같다).
        let cmd = full_mirror_render(
            C,
            &mk(json!({ "kind": "command", "target": "cat a", "reason": "r", "warnings": ["reads_file"],
                        "files": [{ "path": "a", "size": 3, "sha256": "0123456789abcdef", "secret": false, "preview": "@x" },
                                  { "path": "b", "size": 9, "sha256": "fedcba9876543210", "secret": true }] })),
            None,
            None,
            None,
        )
        .unwrap();
        assert_eq!(
            cmd.body,
            "권한 요청 · @agent\n정확히 이 명령 하나 `cat a` — 이 스레드에서만 · 「이번 한 번」\n⚠ 파일을 읽는다\n파일 2개 — 내용은 요청 시점에 고정됨(바뀌면 열리지 않는다):\n· a (3B, sha256 0123456789ab…)\n```\n＠x\n```\n· b (9B, sha256 fedcba987654…) — 내용 비공개\n이유: r"
        );
        assert!(cmd.mirror.get("files").is_none());
        // CI 거절 카드는 경고 줄을 본문에 싣지 않는다(meta 에는 싣는다).
        let ci = full_mirror_render(
            C,
            &mk(json!({ "kind": "merge", "target": "o/n", "reason": "r", "warnings": ["uses_github_account"],
                        "once": { "number": 3, "headSha": "abcdef0123456", "reason": "ci_not_green" } })),
            None,
            None,
            None,
        )
        .unwrap();
        assert!(!ci.body.contains('⚠'));
        assert_eq!(
            ci.mirror["bodyWarningLine"],
            json!("⚠ GitHub 계정으로 돈다")
        );
        // 위임장: 받은 칩(거울 채널 기준)을 `mandate` 로. 원본의 칩·`mandateId` 는 옮기지 않는다.
        let chip = json!({ "id": C, "name": "거울 쪽 이름", "ownerId": C, "startedAt": "2026-11-19T00:00:00.000Z" });
        let man = full_mirror_render(
            C,
            &mk(
                json!({ "kind": "tool", "target": "t", "reason": "r", "mandateId": C,
                        "mandate": { "id": C, "name": "원본 쪽 이름" } }),
            ),
            None,
            None,
            Some(chip.clone()),
        )
        .unwrap();
        assert_eq!(man.mirror["mandate"], chip);
        assert!(man.mirror.get("mandateId").is_none());
        assert_eq!(
            mirror_mandate_id(&mk(json!({ "kind": "tool", "mandate": { "id": C } }))),
            Some(Some(C))
        );
        assert_eq!(
            mirror_mandate_id(&mk(json!({ "kind": "tool" }))),
            Some(None)
        );
    }

    #[test]
    fn mirror_plain_only_for_bare_mirrors() {
        let base = json!({ "channelId": C, "body": "b", "options": [], "mirrorOf": C });
        let o = base.as_object().unwrap();
        assert!(mirror_plain(o));
        // 원인 헤더가 있어도 Rust 가 한다(차례 주인 푸시).
        for k in ["to", "mergeDenialId"] {
            let mut m = o.clone();
            m.insert(k.into(), json!("x"));
            assert!(!mirror_plain(&m), "{k}");
        }
        // 대신하기·계획 단계는 평범한 카드와 같은 길로 Rust 가 한다.
        for k in ["supersedes", "planStepId"] {
            let mut m = o.clone();
            m.insert(k.into(), json!("x"));
            assert!(mirror_plain(&m), "{k}");
        }
        let mut m = o.clone();
        m.remove("mirrorOf");
        assert!(!mirror_plain(&m));
        assert!(!plain(o));
        assert!(MIRROR_PERMISSION_SQL.contains("deleted_at is null"));
        assert!(
            gate_awaiting_sql().contains("i.message_id = $2::uuid and m.channel_id = $3::uuid")
        );
    }

    #[test]
    fn mirror_refusal_follows_check_ask_mirror_order() {
        use crate::core::ask::To;
        let root = |to: To, mirror: Option<&str>, answered: bool, closed: bool| Ask {
            options: vec!["a".into(), "b".into()],
            to,
            mirror_of: mirror.map(str::to_owned),
            answered,
            closed,
        };
        let open = root(To::Human, None, false, false);
        assert_eq!(
            mirror_refusal(None, true, &["a", "b"]),
            Some("mirror_not_found")
        );
        assert_eq!(
            mirror_refusal(Some(&open), false, &["a", "b"]),
            Some("mirror_not_found")
        );
        let m = root(To::Human, Some(C), false, false);
        assert_eq!(
            mirror_refusal(Some(&m), true, &["a", "b"]),
            Some("mirror_of_mirror")
        );
        let ag = root(To::Account(C.into()), None, false, false);
        assert_eq!(
            mirror_refusal(Some(&ag), true, &["a", "b"]),
            Some("mirror_not_human")
        );
        assert_eq!(
            mirror_refusal(Some(&open), true, &["a"]),
            Some("mirror_options_mismatch")
        );
        assert_eq!(
            mirror_refusal(Some(&open), true, &["a", "c"]),
            Some("mirror_options_mismatch")
        );
        // 차례는 달라도 된다(TS 는 정렬해 견준다).
        assert_eq!(mirror_refusal(Some(&open), true, &["b", "a"]), None);
        let done = root(To::Human, None, true, false);
        assert_eq!(
            mirror_refusal(Some(&done), true, &["a", "b"]),
            Some("mirror_resolved")
        );
        // 선택지가 달라도 정해진 원본보다 먼저 걸린다(TS 순서).
        assert_eq!(
            mirror_refusal(Some(&done), true, &["a"]),
            Some("mirror_options_mismatch")
        );
        let closed = root(To::Human, None, false, true);
        assert_eq!(
            mirror_refusal(Some(&closed), true, &["a", "b"]),
            Some("mirror_resolved")
        );
        for c in [
            "mirror_not_found",
            "mirror_of_mirror",
            "mirror_not_human",
            "mirror_options_mismatch",
            "mirror_resolved",
        ] {
            assert!(!mirror_message(c).is_empty());
        }
        assert!(MIRROR_ROOT_SQL.contains("deleted_at is null"));
    }

    fn ask(extra: Value) -> Value {
        let mut v = json!({ "channelId": C, "body": "b",
            "options": [{ "id": "a", "label": "A" }, { "id": "b", "label": "B", "hint": "h", "recommended": false }] });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    fn code(r: Option<String>) -> Option<String> {
        let v: Value = serde_json::from_str(&r?).ok()?;
        let inner: Value = serde_json::from_str(v.pointer("/content/0/text")?.as_str()?).ok()?;
        Some(inner.pointer("/error/code")?.as_str()?.to_owned())
    }

    #[test]
    fn denial_once_columns_are_granted() {
        for c in ["pr_number", "head_sha", "reason", "failed_checks"] {
            assert!(DENIAL_ONCE_SQL.contains(c));
            let col = format!("merge_denial.{c}");
            assert!(
                MERGE_DENIAL_ASK_READ_PRIVILEGES
                    .iter()
                    .any(|(k, p)| *k == col && *p == "SELECT"),
                "{col}"
            );
        }
        assert!(DENIAL_AGENT_SQL.contains("owner_account_id"));
    }

    #[test]
    fn parse_like_zod() {
        assert!(parse(&ask(json!({}))).is_some());
        assert!(
            parse(&ask(
                json!({ "supersedes": C, "keepOpen": [], "planStepId": "s1234" })
            ))
            .is_some()
        );
        assert!(parse(&ask(json!({ "supersedes": [C] }))).is_some());
        for bad in [
            json!({ "supersedes": [] }),
            json!({ "supersedes": "x" }),
            json!({ "planStepId": "s0" }),
            json!({ "planStepId": "s12345" }),
            json!({ "options": [{ "id": "a", "label": "A" }] }),
            json!({ "options": [{ "id": "", "label": "A" }, { "id": "b", "label": "B" }] }),
            json!({ "options": [{ "id": "a", "label": "A", "recommended": 1 }, { "id": "b", "label": "B" }] }),
            json!({ "to": "" }),
            json!({ "prompt": null }),
            json!({ "irreversible": "yes" }),
            json!({ "keepOpen": ["x"] }),
            json!({ "body": "" }),
            json!({ "model": "" }),
        ] {
            assert!(parse(&ask(bad.clone())).is_none(), "{bad}");
        }
    }

    #[test]
    fn neutral_permission_mirror_like_ts() {
        let meta = json!({ "permissionRequest": {}, "ask": { "options": [{ "id": "a", "label": "A", "hint": "h" }], "prompt": "p" } });
        let r = neutral_mirror_render(C, &meta, Some("bot")).unwrap();
        assert_eq!(
            r.body,
            format!(
                "권한 요청 · @bot\n원래 카드가 있는 채널에서 내용을 확인하고 정해 주세요.\nharkroom://message/{C}"
            )
        );
        assert_eq!(r.options, json!([{ "id": "a", "label": "A" }]));
        assert_eq!(r.prompt, Some(json!("p")));
        assert_eq!(r.mirror, json!({ "rootId": C, "neutral": true }));
        let r = neutral_mirror_render(C, &json!({ "ask": { "options": [], "prompt": "" } }), None)
            .unwrap();
        assert!(r.body.starts_with("권한 요청 · @agent\n"));
        assert_eq!(r.prompt, None);
        // 원본 선택지가 없으면 TS(`permissionCardOptions`).
        assert!(neutral_mirror_render(C, &json!({ "permissionRequest": {} }), None).is_none());
    }

    #[test]
    fn audience_sees_root_like_ts() {
        use crate::core::audience::Audience::{Accounts, All};
        let ids = |v: &[&str]| Accounts(v.iter().map(|s| s.to_string()).collect());
        assert!(audience_sees_root(true, &ids(&[]), &All));
        assert!(audience_sees_root(false, &All, &ids(&["x"])));
        assert!(!audience_sees_root(false, &ids(&["x"]), &All));
        assert!(audience_sees_root(false, &ids(&["x", "y"]), &ids(&["y"])));
        assert!(!audience_sees_root(false, &ids(&["x"]), &ids(&["x", "z"])));
    }

    #[test]
    fn plain_meta_like_ts() {
        let v = ask(json!({ "prompt": "p", "irreversible": false }));
        let m = plain_meta(v.as_object().unwrap(), json!({ "kind": "human" })).unwrap();
        assert_eq!(
            Value::Object(m),
            json!({ "kind": "ask", "ask": { "options": [{ "id": "a", "label": "A" }, { "id": "b", "label": "B", "hint": "h" }],
                "to": { "kind": "human" }, "prompt": "p" } })
        );
        let o = ask(json!({}));
        // 원인 헤더가 있어도 Rust 가 세운다(차례 주인 푸시는 `human_ask_push`).
        assert!(plain(o.as_object().unwrap()));
        assert!(plain(
            ask(json!({ "threadRootId": C, "keepOpen": [C] }))
                .as_object()
                .unwrap()
        ));
        for k in ["to", "mirrorOf", "mergeDenialId"] {
            assert!(!plain(ask(json!({ k: C })).as_object().unwrap()), "{k}");
        }
        // 대신하기는 Rust 가 세운 뒤 닫는다.
        let sup = ask(json!({ "supersedes": C, "threadRootId": C }));
        assert!(plain(sup.as_object().unwrap()));
        assert!(addressed(sup.as_object().unwrap()));
        assert_eq!(open_card_thread(sup.as_object().unwrap()), Some(C));
        // 계획 단계 잇기도 Rust 가 세운 뒤 한다(계획·단계·권한이 있을 때).
        let step = ask(json!({ "planStepId": "s1", "threadRootId": C }));
        assert!(plain(step.as_object().unwrap()));
        assert!(addressed(step.as_object().unwrap()));
    }

    #[test]
    fn supersede_sql_like_ts() {
        for frag in [
            "'{ask,closedReason}', to_jsonb('superseded'::text)",
            "'{ask,supersededBy}', to_jsonb($2::text)",
            "coalesce(meta->'ask'->>'closedAt', now()::text)",
            "meta->'ask'->>'closedReason' = 'replied'",
            "not (meta ? 'permissionRequest')",
        ] {
            assert!(SUPERSEDE_ASK_SQL.contains(frag), "{frag}");
        }
    }

    #[test]
    fn supersede_refusal_like_ts() {
        const D: &str = "1b7f3f92-3fa6-494a-8ab3-76d0d2a6a1c0";
        let me = "me";
        let card = |extra: Value| {
            let mut m = json!({ "kind": "ask", "ask": { "options": [{ "id": "a", "label": "A" }, { "id": "b", "label": "B" }],
                "to": { "kind": "human" } } });
            for (k, x) in extra.as_object().unwrap() {
                m["ask"][k] = x.clone();
            }
            m
        };
        let row = |m: Value, author: &str, root: Option<&str>| {
            Some((
                m,
                C.to_owned(),
                root.map(str::to_owned),
                Some(author.to_owned()),
            ))
        };
        let r = |row, thread| supersede_refusal(D, row, me, C, thread);
        assert_eq!(r(None, Some(D)), Some("supersedes_not_found"));
        assert_eq!(
            r(row(json!({ "kind": "post" }), me, None), Some(D)),
            Some("supersedes_not_found")
        );
        assert_eq!(
            r(row(card(json!({})), "x", None), Some(D)),
            Some("supersedes_not_yours")
        );
        let mut perm = card(json!({}));
        perm["chainBackstop"] = json!({});
        assert_eq!(
            r(row(perm, me, None), Some(D)),
            Some("supersedes_permission_card")
        );
        assert_eq!(
            r(row(card(json!({})), me, None), None),
            Some("supersedes_other_thread")
        );
        assert_eq!(
            r(row(card(json!({})), me, Some(C)), Some(D)),
            Some("supersedes_other_thread")
        );
        assert_eq!(r(row(card(json!({})), me, Some(C)), Some(C)), None);
        assert_eq!(r(row(card(json!({})), me, None), Some(D)), None);
        assert_eq!(
            r(row(card(json!({ "answeredWith": "a" })), me, None), Some(D)),
            Some("supersedes_resolved")
        );
        assert_eq!(
            r(
                row(
                    card(json!({ "closedAt": "t", "closedReason": "declined" })),
                    me,
                    None
                ),
                Some(D)
            ),
            Some("supersedes_resolved")
        );
        assert_eq!(
            r(
                row(
                    card(json!({ "closedAt": "t", "closedReason": "replied" })),
                    me,
                    None
                ),
                Some(D)
            ),
            None
        );
        let o = ask(json!({ "supersedes": [C, D, C] }));
        assert_eq!(supersedes_list(o.as_object().unwrap()), vec![C, D]);
        assert_eq!(
            supersedes_list(ask(json!({ "supersedes": C })).as_object().unwrap()),
            vec![C]
        );
        let ts = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        for code in [
            "supersedes_not_found",
            "supersedes_not_yours",
            "supersedes_other_thread",
            "supersedes_resolved",
            "supersedes_permission_card",
            "supersedes_too_many",
        ] {
            assert!(
                ts.contains(&format!("{code}: '{}'", supersede_message(code))),
                "{code}"
            );
        }
        let ms = include_str!("../../../../../packages/server/src/services/messages.ts");
        assert!(ms.contains("export const ASK_SUPERSEDES_MAX = 4;"));
    }

    #[test]
    fn addressed_card_for_humans_and_agents() {
        assert_eq!(
            account_audience((C.into(), "human".into())),
            Some(json!({ "kind": "account", "accountId": C }))
        );
        assert_eq!(
            account_audience((C.into(), "agent".into())),
            Some(json!({ "kind": "account", "accountId": C }))
        );
        assert!(addressed(
            ask(json!({ "to": "@a", "threadRootId": C, "keepOpen": [C] }))
                .as_object()
                .unwrap()
        ));
        for k in ["mirrorOf", "mergeDenialId"] {
            assert!(
                !addressed(ask(json!({ "to": "@a", k: C })).as_object().unwrap()),
                "{k}"
            );
        }
        let ts = include_str!("../../../../../packages/server/src/services/push/pushJobs.ts");
        assert!(ts.contains(
            "where exists (select 1 from account where id = $1::uuid and kind = 'human')"
        ));
        assert_eq!(
            TO_KIND_SQL.replace("id::text, kind::text", "id"),
            TO_SQL.replace("id::text", "id")
        );
    }

    #[test]
    fn open_card_check_only_for_human_thread_cards() {
        let t = |v: Value| open_card_thread(v.as_object().unwrap()).map(str::to_owned);
        assert_eq!(t(ask(json!({}))), None);
        assert_eq!(t(ask(json!({ "threadRootId": C }))).as_deref(), Some(C));
        assert_eq!(
            t(ask(
                json!({ "threadRootId": C, "keepOpen": [C], "planStepId": "s1" })
            ))
            .as_deref(),
            Some(C)
        );
        for k in ["to", "mirrorOf", "mergeDenialId"] {
            assert_eq!(t(ask(json!({ "threadRootId": C, k: C }))), None, "{k}");
        }
    }

    #[test]
    fn open_card_refusal_like_ts() {
        const D: &str = "1b7f3f92-3fa6-494a-8ab3-76d0d2a6a1c0";
        assert_eq!(open_card_refusal(vec![], &HashSet::new()), None);
        let keep: HashSet<&str> = [C].into_iter().collect();
        assert_eq!(open_card_refusal(vec![C.into()], &keep), None);
        let r = open_card_refusal(vec![C.into(), D.into()], &keep).unwrap();
        let v: Value = serde_json::from_str(&r).unwrap();
        let text = v.pointer("/content/0/text").unwrap().as_str().unwrap();
        assert!(text.starts_with(
            r#"{"error":{"code":"open_card_in_thread","message":"you already have open card(s)"#
        ));
        let inner: Value = serde_json::from_str(text).unwrap();
        assert_eq!(inner["error"]["openCardIds"], json!([D]));
    }

    #[test]
    fn open_card_sql_follows_ts_source() {
        let ts = include_str!("../../../../../packages/server/src/services/messages.ts");
        let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        let body = norm(OPEN_CARD_SQL)
            .replace("select id::text from", "select id from")
            .replace("::uuid", "");
        assert!(norm(ts).contains(&body));
        assert_eq!(OPEN_CARD_READ_PRIVILEGES, &[("message", "SELECT")]);
    }

    #[test]
    fn to_handle_like_ts() {
        assert_eq!(to_handle("@Alice"), "alice");
        assert_eq!(to_handle("Bob"), "bob");
        assert_eq!(to_handle("@@x"), "@x");
        let ts = include_str!("../../../../../packages/server/src/mcp/mcpPlugin.ts");
        assert!(ts.contains("select id from account where lower(handle) = $1"));
        assert!(ts.contains("no account with handle @${handle}"));
        assert_eq!(
            TO_SQL.replace("id::text", "id"),
            "select id from account where lower(handle) = $1"
        );
        assert_eq!(parse(&ask(json!({ "to": "@a" }))).unwrap().to, Some("@a"));
    }

    #[test]
    fn option_refusals_in_ts_order() {
        let r = |v: Value| code(option_refusal(&parse(&v).unwrap()));
        assert_eq!(r(ask(json!({}))), None);
        assert_eq!(
            r(ask(
                json!({ "options": [{ "id": "a", "label": "A" }, { "id": "a", "label": "B" }] })
            ))
            .as_deref(),
            Some("duplicate_option")
        );
        assert_eq!(
            r(ask(json!({ "options": [{ "id": "__text__", "label": "A" }, { "id": "a", "label": "B" }] }))).as_deref(),
            Some("reserved_option_id")
        );
        assert_eq!(
            r(ask(json!({ "options": [{ "id": "a", "label": "A", "recommended": true }, { "id": "b", "label": "B", "recommended": true }] }))).as_deref(),
            Some("multiple_recommended")
        );
        assert_eq!(
            r(ask(json!({ "mergeDenialId": C, "to": "x" }))).as_deref(),
            Some("merge_denial_audience")
        );
        assert_eq!(
            r(ask(json!({ "mergeDenialId": C, "mirrorOf": C }))).as_deref(),
            Some("merge_denial_audience")
        );
        assert_eq!(r(ask(json!({ "mergeDenialId": C }))), None);
    }

    #[test]
    fn denial_refusals_follow_prepare_denial_card_order() {
        let row = |agent: &str, ch: &str, root: &str, e: bool, u: bool, o: bool, h: bool| {
            Some((
                agent.to_owned(),
                "repo:o/r".to_owned(),
                ch.to_owned(),
                root.to_owned(),
                e,
                u,
                o,
                h,
            ))
        };
        assert_eq!(
            denial_refusal(None, "a", "c", Some("t")),
            Err("denial_not_found")
        );
        assert_eq!(
            denial_refusal(
                row("b", "c", "t", true, true, true, true),
                "a",
                "c",
                Some("t")
            ),
            Err("denial_other_agent")
        );
        assert_eq!(
            denial_refusal(row("a", "c", "t", true, true, true, true), "a", "c", None),
            Err("denial_other_thread")
        );
        assert_eq!(
            denial_refusal(
                row("a", "c", "t", true, true, true, true),
                "a",
                "c",
                Some("t")
            ),
            Err("denial_used")
        );
        assert_eq!(
            denial_refusal(
                row("a", "c", "t", true, false, true, true),
                "a",
                "c",
                Some("t")
            ),
            Err("denial_expired")
        );
        assert_eq!(
            denial_refusal(
                row("a", "c", "t", false, false, true, true),
                "a",
                "c",
                Some("t")
            ),
            Err("head_moved")
        );
        assert_eq!(
            denial_refusal(
                row("a", "c", "t", false, false, true, false),
                "a",
                "c",
                Some("t")
            ),
            Err("pr_closed")
        );
        assert_eq!(
            denial_refusal(
                row("a", "c", "t", false, false, false, false),
                "a",
                "c",
                Some("t")
            ),
            Ok("repo:o/r".to_owned())
        );
        assert_eq!(
            denial_message("head_moved"),
            "that pull request got a new head after this refusal — call the merge wrapper again and use the new denialId"
        );
        assert_eq!(denial_target("repo:O/R").as_deref(), Some("repo:o/r"));
        assert_eq!(denial_target("repo:o/*"), None);
        assert!(DENIAL_PENDING_SQL.contains("denial_id = $5::uuid"));
        assert!(
            MERGE_DENIAL_ASK_READ_PRIVILEGES.contains(&("permission_request.denial_id", "SELECT"))
        );
    }
}
