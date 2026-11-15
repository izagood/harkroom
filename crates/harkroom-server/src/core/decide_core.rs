//! S5.3 C3b-3a — 권한·머지 카드 결정의 **판정 코어**(붙는 길 없음: 라우트·MCP 등록 0개).
//!
//! TS `services/deciders.ts::mayDecideFor` 를 **결정을 쓰는 tx 안에서**, 판정 근거가 된 줄을 잠근 뒤 하는 판이다. TS 는
//! `decide` 가 판정을 tx 밖 pool 에서 하므로, 판정과 커밋 사이에 명단 빼기·게스트 강등·비활성·채널 비공개 전환이 끼어들 수 있다.
//!
//! ## 잠금 순서(하나로 고정 — 바꾸면 `tests/decide_core.rs` 의 순서 시험이 빨개진다)
//! 1. 요청 줄은 **잠그지 않고** 읽어 agent·channel id 를 얻는다(호출자 몫).
//! 2. `channel` `for share` — 채널 삭제(channel `for update` 먼저)와 같은 방향.
//! 3. `account`(에이전트·행위자) `for share`, **id 순** — 에이전트 삭제(account `for update` 먼저)와 같은 방향.
//! 4. `agent_config` `for share`.
//! 5. `agent_invoker`·`channel_member`(행위자 줄) `for key share` — 이 둘은 DELETE 로만 빠지므로 key share 로 충분하다.
//!    account·channel·agent_config 는 키 아닌 칸(role·disabled_at·visibility·user_decide·invoke_scope)을 UPDATE 로 바꾸므로
//!    `for share` 여야 한다(security C3b-3 ①-2).
//! 6. 요청 줄 `for update` 는 **마지막**(호출자 몫) — 그 뒤 요청 줄의 agent·channel·status 를 다시 대조한다.
//!
//! 판정 문장은 TS 상수를 골든으로 받는다(`decider_*`). 잠근 뒤에 읽으므로 READ COMMITTED 에서도 잠근 줄의 값은 커밋까지 그대로다.
//! 교착(40P01)·잠금 실패(55P03)는 호출자가 한 번 다시 하고, 그래도 안 되면 `internal` — **TS 로 넘기지 않는다**(C3b-3 ①-4).
use super::ask::{read_ask_meta, read_ask_row};
use super::msg_read::is_uuid;
use serde_json::Value;
use sqlx::PgConnection;
use std::sync::OnceLock;

struct Sql {
    row: String,
    seen: String,
    list: String,
    channel: String,
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        Sql {
            row: format!(
                "select d.\"ownerAccountId\"::text, d.scope, d.\"userDecide\", d.\"agentOff\", d.\"actorKind\", d.\"actorRole\", \
                 d.\"actorOff\" from ({}) d",
                frag("decider_row")
            ),
            seen: frag("decider_seen"),
            list: frag("decider_list"),
            channel: frag("decider_channel"),
        }
    })
}

/// 잠그는 문장들 — 순서는 [`LOCK_ORDER`] 그대로 [`lock_basis`] 가 부른다.
pub const LOCK_CHANNEL: &str = "select id from channel where id = $1::uuid for share";
pub const LOCK_ACCOUNTS: &str =
    "select id from account where id = any($1::uuid[]) order by id for share";
pub const LOCK_AGENT_CONFIG: &str =
    "select account_id from agent_config where account_id = $1::uuid for share";
pub const LOCK_INVOKER: &str =
    "select 1 from agent_invoker where agent_id = $1::uuid and account_id = $2::uuid for key share";
pub const LOCK_MEMBER: &str = "select 1 from channel_member where channel_id = $1::uuid and account_id = $2::uuid for key share";

/// 시험이 대조하는 잠금 순서(표 이름). 요청 줄은 호출자가 이 뒤에 `for update` 한다.
pub const LOCK_ORDER: [&str; 5] = [
    "channel",
    "account",
    "agent_config",
    "agent_invoker",
    "channel_member",
];

/// 화면 문구용 범위(TS `DecideScope`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecideScope {
    Owner,
    List,
    Channel,
    Community,
    SwitchOff,
    /// TS 는 모르는 scope 문자열을 그대로 싣는다.
    Other(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    /// `Some(as_owner)` 면 정할 수 있다.
    pub ok: Option<bool>,
    pub owner: Option<String>,
    pub scope: Option<DecideScope>,
}

impl Verdict {
    fn no(owner: Option<String>, scope: Option<DecideScope>) -> Self {
        Self {
            ok: None,
            owner,
            scope,
        }
    }
}

/// 판정을 끄는 스위치 — 망가뜨리기 시험 전용. cargo feature `breakage-tests`(기본 꺼짐)일 때만 밖에 보인다.
/// 운영 빌드에서는 [`may_decide_for_locked`] 가 늘 전부 켠 값으로만 부른다.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(not(feature = "breakage-tests"), allow(dead_code))]
pub struct Checks {
    pub scope: bool,
    pub guest: bool,
    pub switch: bool,
    pub lock: bool,
}

impl Default for Checks {
    fn default() -> Self {
        Self {
            scope: true,
            guest: true,
            switch: true,
            lock: true,
        }
    }
}

/// 판정 근거가 될 줄을 [`LOCK_ORDER`] 순으로 잠근다. 호출자의 tx 안에서만 부른다.
pub async fn lock_basis(
    conn: &mut PgConnection,
    agent: &str,
    actor: &str,
    channel: Option<&str>,
) -> sqlx::Result<()> {
    if let Some(ch) = channel {
        sqlx::query(LOCK_CHANNEL)
            .bind(ch)
            .fetch_optional(&mut *conn)
            .await?;
    }
    let mut ids = vec![agent.to_owned(), actor.to_owned()];
    ids.sort();
    ids.dedup();
    sqlx::query(LOCK_ACCOUNTS)
        .bind(&ids)
        .fetch_all(&mut *conn)
        .await?;
    sqlx::query(LOCK_AGENT_CONFIG)
        .bind(agent)
        .fetch_optional(&mut *conn)
        .await?;
    sqlx::query(LOCK_INVOKER)
        .bind(agent)
        .bind(actor)
        .fetch_optional(&mut *conn)
        .await?;
    if let Some(ch) = channel {
        sqlx::query(LOCK_MEMBER)
            .bind(ch)
            .bind(actor)
            .fetch_optional(&mut *conn)
            .await?;
    }
    Ok(())
}

type Row = (
    Option<String>,
    String,
    bool,
    bool,
    Option<String>,
    Option<String>,
    Option<bool>,
);

/// TS `mayDecideFor` 와 같은 판정 — 근거 줄을 먼저 잠근다.
pub async fn may_decide_for_locked(
    conn: &mut PgConnection,
    agent: &str,
    actor: &str,
    channel: Option<&str>,
) -> sqlx::Result<Verdict> {
    decide_with(conn, agent, actor, channel, Checks::default()).await
}

#[cfg(feature = "breakage-tests")]
pub async fn may_decide_for_with(
    conn: &mut PgConnection,
    agent: &str,
    actor: &str,
    channel: Option<&str>,
    checks: Checks,
) -> sqlx::Result<Verdict> {
    decide_with(conn, agent, actor, channel, checks).await
}

async fn decide_with(
    conn: &mut PgConnection,
    agent: &str,
    actor: &str,
    channel: Option<&str>,
    checks: Checks,
) -> sqlx::Result<Verdict> {
    if checks.lock {
        lock_basis(conn, agent, actor, channel).await?;
    }
    let s = sql();
    let row: Option<Row> = sqlx::query_as(s.row.as_str())
        .bind(agent)
        .bind(actor)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((owner, scope, user_decide, agent_off, actor_kind, actor_role, actor_off)) = row
    else {
        return Ok(Verdict::no(None, None));
    };
    let shown = if user_decide {
        match scope.as_str() {
            "owner" => DecideScope::Owner,
            "list" => DecideScope::List,
            "channel" => DecideScope::Channel,
            "community" => DecideScope::Community,
            o => DecideScope::Other(o.to_owned()),
        }
    } else {
        DecideScope::SwitchOff
    };
    let no = || Ok(Verdict::no(owner.clone(), Some(shown.clone())));
    if actor_kind.as_deref() != Some("human") || actor_off != Some(false) {
        return no();
    }
    if owner.as_deref() == Some(actor) {
        return Ok(Verdict {
            ok: Some(true),
            owner,
            scope: Some(shown),
        });
    }
    let switch_off = checks.switch && !user_decide;
    let guest = checks.guest && actor_role.as_deref() == Some("guest");
    let Some(ch) = channel else { return no() };
    if switch_off || agent_off || guest {
        return no();
    }
    let seen: Option<Option<bool>> = sqlx::query_scalar(s.seen.as_str())
        .bind(ch)
        .bind(actor)
        .fetch_optional(&mut *conn)
        .await?;
    if seen.flatten() != Some(true) {
        return no();
    }
    let passes = if !checks.scope {
        true
    } else {
        match scope.as_str() {
            "community" => true,
            "list" => sqlx::query(s.list.as_str())
                .bind(agent)
                .bind(actor)
                .fetch_optional(&mut *conn)
                .await?
                .is_some(),
            "channel" => sqlx::query(s.channel.as_str())
                .bind(ch)
                .bind(actor)
                .fetch_optional(&mut *conn)
                .await?
                .is_some(),
            _ => false,
        }
    };
    if passes {
        Ok(Verdict {
            ok: Some(false),
            owner,
            scope: Some(shown),
        })
    } else {
        no()
    }
}

/// 교착·잠금 실패면 한 번 다시 할 오류인가(40P01 deadlock_detected · 55P03 lock_not_available).
pub fn is_retryable_lock_error(e: &sqlx::Error) -> bool {
    matches!(
        e.as_database_error().and_then(|d| d.code()).as_deref(),
        Some("40P01") | Some("55P03")
    )
}

// ───────────────────────── 카드 → 무엇을 정하나(TS `decisions.ts`) ─────────────────────────

/// TS `DecisionRef`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecisionRef {
    Permission {
        request_id: String,
        agent_id: String,
        card_message_id: Option<String>,
        /// 거울 카드에서 왔으면 그 거울 글 id(`card_message_id` 는 원본).
        mirror_message_id: Option<String>,
        owner_account_id: Option<String>,
    },
    Ask {
        card_message_id: String,
        mirror_message_id: Option<String>,
    },
}

async fn read_meta(conn: &mut PgConnection, id: &str) -> sqlx::Result<Option<Value>> {
    sqlx::query_scalar("select meta from message where id = $1::uuid and deleted_at is null")
        .bind(id)
        .fetch_optional(conn)
        .await
        .map(Option::flatten)
}

async fn resolve_card(
    conn: &mut PgConnection,
    id: &str,
    meta: Option<Value>,
) -> sqlx::Result<Option<DecisionRef>> {
    let Some(meta) = meta else { return Ok(None) };
    let p: Option<(String, String, Option<String>)> = sqlx::query_as(
        "select p.id::text, p.agent_id::text, c.owner_account_id::text \
           from permission_request p join agent_config c on c.account_id = p.agent_id \
          where p.card_message_id = $1::uuid",
    )
    .bind(id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some((request_id, agent_id, owner)) = p {
        return Ok(Some(DecisionRef::Permission {
            request_id,
            agent_id,
            card_message_id: Some(id.to_owned()),
            mirror_message_id: None,
            owner_account_id: owner,
        }));
    }
    Ok(read_ask_meta(&meta).map(|_| DecisionRef::Ask {
        card_message_id: id.to_owned(),
        mirror_message_id: None,
    }))
}

/// TS `resolveDecision` — 카드 글 id → 무엇을 정하는 카드인가. 잠그지 않고 읽는다(잠금 순서 1단계).
/// 권한 카드인지는 카드 meta 가 아니라 **요청 줄**(`permission_request.card_message_id`)로 정한다. 거울이면 원본으로 따라가고,
/// 원본이 지워졌거나 결정 카드가 아니면 거울 혼자 물음이다.
pub async fn resolve_decision(
    conn: &mut PgConnection,
    message_id: &str,
) -> sqlx::Result<Option<DecisionRef>> {
    let Some(meta) = read_meta(conn, message_id).await? else {
        return Ok(None);
    };
    if let Some(root) = read_ask_meta(&meta).and_then(|a| a.mirror_of) {
        // 거울 표지가 uuid 가 아니면 TS(pg)는 22P02 로 500 이다 — 여기서는 원본 없음으로 읽지 않고 호출자가 TS 로 넘긴다.
        if !is_uuid(&root) {
            return Err(sqlx::Error::Protocol("mirrorOf is not a uuid".into()));
        }
        let root_meta = read_meta(conn, &root).await?;
        return Ok(match resolve_card(conn, &root, root_meta).await? {
            Some(DecisionRef::Permission {
                request_id,
                agent_id,
                card_message_id,
                owner_account_id,
                ..
            }) => Some(DecisionRef::Permission {
                request_id,
                agent_id,
                card_message_id,
                mirror_message_id: Some(message_id.to_owned()),
                owner_account_id,
            }),
            Some(DecisionRef::Ask {
                card_message_id, ..
            }) => Some(DecisionRef::Ask {
                card_message_id,
                mirror_message_id: Some(message_id.to_owned()),
            }),
            None => Some(DecisionRef::Ask {
                card_message_id: message_id.to_owned(),
                mirror_message_id: None,
            }),
        });
    }
    resolve_card(conn, message_id, Some(meta)).await
}

/// (meta, 작성자, 작성자 kind, 작성자 에이전트의 소유자).
type MirrorRow = (Value, Option<String>, Option<String>, Option<String>);

/// TS `isGenuinePermissionMirror`(security n2) — 서버가 받아 세운 거울인가. 거짓이면 TS 는 물음 길(`recordAskAnswer`)로 가서
/// 거절된다. **그 물음 길은 Rust 가 맡지 않는다**(3b 입구가 TS 로 넘긴다 — 거울·원본이 권한 카드라 C3b-1 의 `hand_to_ts` 도 넘긴다).
pub async fn is_genuine_permission_mirror(
    conn: &mut PgConnection,
    mirror: &str,
    root: &str,
    request_agent: &str,
) -> sqlx::Result<bool> {
    let m: Option<MirrorRow> = sqlx::query_as(
        "select m.meta, m.author_id::text, a.kind, c.owner_account_id::text \
           from message m left join account a on a.id = m.author_id left join agent_config c on c.account_id = m.author_id \
          where m.id = $1::uuid and m.deleted_at is null",
    )
    .bind(mirror)
    .fetch_optional(&mut *conn)
    .await?;
    let Some((meta, Some(author), Some(kind), Some(mirror_owner))) = m else {
        return Ok(false);
    };
    if kind != "agent" {
        return Ok(false);
    }
    // TS: `m.meta.kind !== 'ask' || m.meta.permissionRequest !== undefined` — 값이 null 이어도 칸이 있으면 거짓.
    if meta.get("kind").and_then(Value::as_str) != Some("ask")
        || meta.get("permissionRequest").is_some()
    {
        return Ok(false);
    }
    let Some(ask) = read_ask_meta(&meta) else {
        return Ok(false);
    };
    if ask.mirror_of.as_deref() != Some(root) || !ask.to_human() {
        return Ok(false);
    }
    let Some((root_ask, root_channel, _)) = read_ask_row(conn, root).await? else {
        return Ok(false);
    };
    if root_ask.mirror_of.is_some() || !root_ask.to_human() {
        return Ok(false);
    }
    let mut a = ask.options.clone();
    let mut b = root_ask.options.clone();
    a.sort();
    b.sort();
    if a != b {
        return Ok(false);
    }
    if !channel_visible_conn(conn, &root_channel, &author).await? {
        return Ok(false);
    }
    let owner: Option<Option<String>> = sqlx::query_scalar(
        "select owner_account_id::text from agent_config where account_id = $1::uuid",
    )
    .bind(request_agent)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(owner.flatten().as_deref() == Some(mirror_owner.as_str()))
}

/// TS `assertChannelVisible` 의 tx 판 — 없는 채널은 막지 않는다. 문장은 `decider_seen` 골든(같은 `channelVisibleSql`).
pub async fn channel_visible_conn(
    conn: &mut PgConnection,
    channel: &str,
    account: &str,
) -> sqlx::Result<bool> {
    let v: Option<Option<bool>> = sqlx::query_scalar(sql().seen.as_str())
        .bind(channel)
        .bind(account)
        .fetch_optional(conn)
        .await?;
    Ok(match v {
        None => true,
        Some(ok) => ok == Some(true),
    })
}

// ───────────────────────── 선택지 → 결정 · 누가 맡나 ─────────────────────────

/// TS `PermissionDecision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Approve,
    ApproveMandate,
    ApproveNewMandate,
    ApproveOnce,
    ApproveHour,
    ApproveTurn,
    Deny,
}

/// TS `OPTION_DECISION`(`Object.hasOwn` — 정확히 같은 글자만). 없으면 TS 는 400 `unknown_option`.
pub fn option_decision(option: &str) -> Option<Decision> {
    Some(match option {
        "approve" => Decision::Approve,
        "approve_mandate" => Decision::ApproveMandate,
        "approve_new_mandate" => Decision::ApproveNewMandate,
        "approve_once" => Decision::ApproveOnce,
        "approve_hour" => Decision::ApproveHour,
        "approve_turn" => Decision::ApproveTurn,
        "deny" => Decision::Deny,
        _ => return None,
    })
}

/// 들어온 결정의 겉모습 — 요청 줄(잠그지 않고 읽은 값, 잠근 뒤 다시 대조)과 본문에서.
#[derive(Debug, Clone, Copy)]
pub struct Shape<'a> {
    pub option: &'a str,
    /// 요청 줄 `kind`.
    pub kind: &'a str,
    pub has_mandate: bool,
    pub has_denial: bool,
    /// 본문에 `once` 가 있다.
    pub has_once: bool,
    /// `via: chat`(글 승인 — C1c 쪽).
    pub via_chat: bool,
    /// 거울 카드에서 왔다.
    pub via_mirror: bool,
}

/// Rust 가 맡는가. `None` = 처음부터 TS(쓰기 전이라 넘겨도 된다).
/// - 허용 목록 방식: 아래에 적힌 꼴만 Rust, 나머지는 전부 TS(security ②-1·②-2).
/// - 위임장(`mandate_id`)·위임장 선택지·`once`·글 승인·거울·모르는 선택지는 처음부터 TS — Rust 에서 반쯤 하다 넘기는 길은 없다.
/// - deny 는 kind 와 관계없이 Rust(머지 거절 카드의 deny 포함, grant 를 쓰지 않음). 같은 카드의 approve_once·approve 는 TS(②-6).
/// - 승인은 `tool`→approve, `command`→approve_once·approve_hour 만. 소유자가 아닌 승인(asOwner=false)은 판정 뒤
///   [`after_verdict`] 가 TS 로 돌린다.
pub fn rust_takes(s: Shape<'_>) -> Option<Decision> {
    if s.has_mandate || s.has_once || s.via_chat || s.via_mirror {
        return None;
    }
    let d = option_decision(s.option)?;
    let ok = match (d, s.kind) {
        (Decision::Deny, _) => true,
        (Decision::Approve, "tool") => !s.has_denial,
        (Decision::ApproveOnce | Decision::ApproveHour, "command") => !s.has_denial,
        _ => false,
    };
    ok.then_some(d)
}

/// 판정(잠근 뒤) 다음의 갈림. 쓰기 전이므로 TS 로 넘겨도 W1(쓰기 시작 뒤 오류는 TS 로 안 넘김)에 걸리지 않는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AfterVerdict {
    /// TS `forbidden`(403).
    Forbidden,
    /// 소유자가 아닌 사람의 승인 — 소유자 알림 글을 에이전트 이름으로 쓰므로 TS(C1c-4 뒤 다시).
    HandToTs,
    Go {
        as_owner: bool,
    },
}

pub fn after_verdict(v: &Verdict, d: Decision) -> AfterVerdict {
    match v.ok {
        None => AfterVerdict::Forbidden,
        Some(false) if d != Decision::Deny => AfterVerdict::HandToTs,
        Some(as_owner) => AfterVerdict::Go { as_owner },
    }
}

/// TS 거절 문구(골든 — `tests/decide_core.rs` 가 TS 원문과 대조한다).
pub const FORBIDDEN_MESSAGE: &str =
    "only someone who may invoke this agent here can decide its permission requests";
pub const UNKNOWN_OPTION_MESSAGE: &str = "a permission card takes approve_mandate, approve_new_mandate, approve_once, approve_turn, approve, approve_hour or deny";

/// 요청 줄을 **마지막에** `for update` 로 잠그고 다시 읽는다(잠금 순서 6단계). 호출자는 돌려받은 agent·channel 을 처음 읽은
/// 값과 대조해 다르면 판정을 다시 한다(잠그기 전 읽은 값으로 판정하지 않는다).
pub const LOCK_REQUEST: &str = "select agent_id::text, channel_id::text, kind, status, \
     expires_at <= now() as expired, mandate_id::text, denial_id::text, card_message_id::text \
     from permission_request where id = $1::uuid for update";
