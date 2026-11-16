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

/// 잠금 함수(마이그레이션 `173_permission_decide_lock.sql`, security A안). 쓰기 역할에 다섯 표의 UPDATE 칸을 주지 않고
/// SECURITY DEFINER 함수가 [`LOCK_ORDER`] 순으로 잠근다 — 문장과 순서는 함수 본문에 있고, 시험이 그 본문을 대조한다.
pub const LOCK_FN: &str = "select permission_decide_lock($1::uuid, $2::uuid, $3::uuid)";
/// 잠금 함수 서명 — `has_function_privilege` 로 쓰기 역할의 EXECUTE 를 본다.
pub const LOCK_FN_SIGNATURE: &str = "permission_decide_lock(uuid, uuid, uuid)";
/// 마이그레이션 본문(시험·골든용).
pub const LOCK_FN_MIGRATION: &str =
    include_str!("../../../../packages/server/src/db/migrations/173_permission_decide_lock.sql");

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

/// 판정 근거가 될 줄을 [`LOCK_ORDER`] 순으로 잠근다(잠금 함수 한 번). 호출자의 tx 안에서만 부른다.
pub async fn lock_basis(
    conn: &mut PgConnection,
    agent: &str,
    actor: &str,
    channel: Option<&str>,
) -> sqlx::Result<()> {
    sqlx::query(LOCK_FN)
        .bind(agent)
        .bind(actor)
        .bind(channel)
        .execute(&mut *conn)
        .await?;
    Ok(())
}

/// 쓰기 역할이 잠금 함수를 부를 수 있나(두 겹 권한 검사의 한 칸). 거짓이면 결정 풀을 `None` 으로 두어 TS 가 맡는다.
pub async fn has_lock_fn_privilege(pool: &sqlx::PgPool) -> sqlx::Result<bool> {
    let ok: Option<bool> = sqlx::query_scalar(
        "select case when to_regprocedure($1) is null then false \
                else has_function_privilege($1, 'EXECUTE') end",
    )
    .bind(LOCK_FN_SIGNATURE)
    .fetch_one(pool)
    .await?;
    Ok(ok == Some(true))
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

/// [`retry_lock_once`] 가 끝낸 꼴.
#[derive(Debug)]
pub enum LockRetryError {
    /// 두 번 다 40P01·55P03 — 호출자는 `internal` 로 끝낸다. **TS 로 넘기지 않는다**(넘기면 tx 밖 판정 틈이 돌아온다).
    Exhausted(sqlx::Error),
    /// 잠금 오류가 아닌 DB 오류 — 다시 하지 않는다. 쓰기 전이면 호출자가 TS 로 넘길 수 있고, 쓰기 뒤면 `internal`(W1).
    Other(sqlx::Error),
}

/// 판정·쓰기 tx 한 벌(`attempt`)을 돌리고, 교착(40P01)·잠금 실패(55P03)면 **한 번만** 새 tx 로 다시 돌린다(security C3b-3 ①-4).
/// `attempt` 는 부를 때마다 새 tx 를 열고, 앞 시도에서 읽은 값을 쓰지 않는다(판정에는 잠그는 select 가 돌려준 값만 쓴다).
pub async fn retry_lock_once<T, F, Fut>(mut attempt: F) -> Result<T, LockRetryError>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = sqlx::Result<T>>,
{
    match attempt().await {
        Ok(v) => Ok(v),
        Err(e) if is_retryable_lock_error(&e) => match attempt().await {
            Ok(v) => Ok(v),
            Err(e) if is_retryable_lock_error(&e) => Err(LockRetryError::Exhausted(e)),
            Err(e) => Err(LockRetryError::Other(e)),
        },
        Err(e) => Err(LockRetryError::Other(e)),
    }
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
pub const LOCK_REQUEST: &str = "select agent_id::text as agent_id, channel_id::text as channel_id, kind, status, \
     expires_at <= now() as expired, mandate_id::text as mandate_id, denial_id::text as denial_id, \
     card_message_id::text as card_message_id \
     from permission_request where id = $1::uuid for update";

/// [`LOCK_REQUEST`] 가 돌려준 줄.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LockedRequest {
    pub agent_id: String,
    pub channel_id: Option<String>,
    pub kind: String,
    pub status: String,
    pub expired: bool,
    pub mandate_id: Option<String>,
    pub denial_id: Option<String>,
    pub card_message_id: Option<String>,
}

type LockedRow = (
    String,
    Option<String>,
    String,
    String,
    bool,
    Option<String>,
    Option<String>,
    Option<String>,
);

/// 요청 줄을 [`LOCK_REQUEST`] 로 마지막에 잠그고 읽는다.
pub async fn lock_request(
    conn: &mut PgConnection,
    request_id: &str,
) -> sqlx::Result<Option<LockedRequest>> {
    let r: Option<LockedRow> = sqlx::query_as(LOCK_REQUEST)
        .bind(request_id)
        .fetch_optional(conn)
        .await?;
    Ok(r.map(
        |(agent_id, channel_id, kind, status, expired, mandate_id, denial_id, card_message_id)| {
            LockedRequest {
                agent_id,
                channel_id,
                kind,
                status,
                expired,
                mandate_id,
                denial_id,
                card_message_id,
            }
        },
    ))
}

/// 요청 줄을 잠근 뒤의 다시 대조(security C3b-3 조건 ①).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Recheck {
    /// 잠근 값으로도 같은 결정을 Rust 가 맡는다 — 쓰기로 간다.
    Go(Decision),
    /// agent·channel 이 처음 읽은 값과 다르다 — 판정을 **처음부터** 다시 한다(잠금도 다시).
    Restart,
    /// 잠근 값으로 보니 Rust 가 맡지 않는 꼴(kind·mandate·denial 이 바뀜) — tx 를 되돌리고 TS 로 넘긴다(쓰기 전).
    HandToTs,
    /// 요청 줄이 사라졌다.
    Gone,
}

/// 처음 읽은 agent·channel 과 잠근 줄을 대조하고, 잠근 kind·mandate_id·denial_id 로 [`rust_takes`] 를 **다시** 돌린다.
/// status·만료는 이 뒤 쓰기 단계가 TS 와 같은 문구로 가른다(여기서 보지 않음).
pub fn recheck_locked(
    first_agent: &str,
    first_channel: Option<&str>,
    locked: Option<&LockedRequest>,
    shape: Shape<'_>,
) -> Recheck {
    let Some(r) = locked else {
        return Recheck::Gone;
    };
    if r.agent_id != first_agent || r.channel_id.as_deref() != first_channel {
        return Recheck::Restart;
    }
    let again = Shape {
        kind: r.kind.as_str(),
        has_mandate: r.mandate_id.is_some(),
        has_denial: r.denial_id.is_some(),
        ..shape
    };
    match rust_takes(again) {
        Some(d) => Recheck::Go(d),
        None => Recheck::HandToTs,
    }
}

/// 결정 감사(`permission.denied`·`permission.approved`)의 detail — TS `decidePermissionRequest` 의 `recordAudit` 와 같은 칸만 싣는다.
/// 3b·3c 는 이것을 결정과 **같은 tx** 에 INSERT 한다(감사가 실패하면 결정도 실패 → `internal`, TS 로 넘기지 않음).
/// 요청 줄의 `reason`·`warnings`·`file_digests`, 카드 본문, grant 토큰 같은 것은 싣지 않는다 — 칸 목록은 [`AUDIT_DETAIL_KEYS`] 골든.
pub struct AuditDetail<'a> {
    pub request_id: &'a str,
    pub kind: &'a str,
    pub target: &'a str,
    pub channel_id: Option<&'a str>,
    pub as_owner: bool,
    pub thread_root_id: Option<&'a str>,
    pub grant_expires_at: Option<&'a str>,
    /// (grantMode, commandGrantId)
    pub grant_mode: Option<(&'a str, &'a str)>,
    /// `via: { kind: 'bundle', bundleMessageId }` 이면 묶음, 없으면 `via: 'button'`(chat·mirror 는 처음부터 TS).
    pub bundle_message_id: Option<&'a str>,
}

/// detail 에 나올 수 있는 칸 전부(TS 와 같은 이름). 시험이 이 밖의 칸이 없는지·TS 원문에 이 이름들이 있는지 본다.
pub const AUDIT_DETAIL_KEYS: [&str; 11] = [
    "requestId",
    "kind",
    "target",
    "channelId",
    "asOwner",
    "threadRootId",
    "grantExpiresAt",
    "grantMode",
    "commandGrantId",
    "via",
    "bundleMessageId",
];

pub fn audit_detail(a: &AuditDetail<'_>) -> Value {
    let mut o = serde_json::json!({
        "requestId": a.request_id, "kind": a.kind, "target": a.target, "channelId": a.channel_id,
    });
    if !a.as_owner {
        o["asOwner"] = Value::Bool(false);
    }
    if a.kind == "command" {
        o["threadRootId"] = serde_json::json!(a.thread_root_id);
    }
    if let Some(t) = a.grant_expires_at {
        o["grantExpiresAt"] = serde_json::json!(t);
    }
    if let Some((mode, id)) = a.grant_mode {
        o["grantMode"] = serde_json::json!(mode);
        o["commandGrantId"] = serde_json::json!(id);
    }
    // TS: `via` 는 언제나 실린다(`args.via ? { via: args.via.kind } : {}` — 입구가 늘 넘긴다). Rust 가 맡는 길은 button·bundle 뿐이다
    // (chat·mirror 는 처음부터 TS). 3b 는 button 을 빠뜨렸다 — 3c 대조 시험(rustFrontDb)이 잡았다.
    if let Some(b) = a.bundle_message_id {
        o["via"] = serde_json::json!("bundle");
        o["bundleMessageId"] = serde_json::json!(b);
    } else {
        o["via"] = serde_json::json!("button");
    }
    o
}

// ───────────────────────── C3b-3b 거절(deny) — 쓰기 · 두 겹 검사 · 입구(붙는 길 없음) ─────────────────────────

/// 거절 쓰기 역할의 표·칸 권한 — 요청 줄의 결정 칸 `UPDATE`, 카드 글 `meta` `UPDATE`, 감사 `INSERT`.
/// 이것과 [`has_lock_fn_privilege`] 가 **둘 다** 참일 때만 [`deny_pool`] 이 풀을 준다(두 겹 검사).
pub const DENY_PRIVILEGES: &[(&str, &str)] = &[
    ("permission_request.status", "UPDATE"),
    ("permission_request.decided_at", "UPDATE"),
    ("permission_request.decided_by", "UPDATE"),
    ("permission_request.grant_expires_at", "UPDATE"),
    ("permission_request.grant_mode", "UPDATE"),
    ("message.meta", "UPDATE"),
    ("audit_log", "INSERT"),
];

/// 두 겹 검사: 표·칸 권한([`DENY_PRIVILEGES`]) **그리고** 잠금 함수 EXECUTE([`has_lock_fn_privilege`]). 하나라도 없거나
/// 검사가 실패하면 `None` — 거절은 TS 가 맡는다(잠금 없는 판정 길로 Rust 가 결정하는 일은 없다).
pub async fn deny_pool(pool: &sqlx::PgPool) -> Option<sqlx::PgPool> {
    match crate::write::missing_in(pool, DENY_PRIVILEGES, &[]).await {
        Ok(m) if m.is_empty() => {}
        Ok(m) => {
            eprintln!("front: permission deny core off — missing privileges {m:?}");
            return None;
        }
        Err(e) => {
            eprintln!(
                "front: permission deny core off — privilege check failed ({})",
                e.as_database_error().map_or("io", |_| "db")
            );
            return None;
        }
    }
    match has_lock_fn_privilege(pool).await {
        Ok(true) => Some(pool.clone()),
        Ok(false) => {
            eprintln!("front: permission deny core off — no EXECUTE on {LOCK_FN_SIGNATURE}");
            None
        }
        Err(e) => {
            eprintln!(
                "front: permission deny core off — lock fn check failed ({})",
                e.as_database_error().map_or("io", |_| "db")
            );
            None
        }
    }
}

/// [`Recheck::Restart`] 로 판정을 처음부터 다시 하는 횟수의 상한. 넘기면 `internal`(TS 로 넘기지 않음 — C3b-3 ①-4 와 같은 까닭).
pub const MAX_RESTARTS: usize = 2;

/// 거절 입구의 인자. `agent_id` 는 경로의 에이전트, `actor_id` 는 누른 사람.
#[derive(Debug, Clone, Copy)]
pub struct DenyArgs<'a> {
    pub agent_id: &'a str,
    pub request_id: &'a str,
    pub actor_id: &'a str,
    /// `via: { kind: 'bundle' }` 로 왔으면 그 묶음 글 id. chat·mirror 는 처음부터 TS([`rust_takes`]).
    pub bundle_message_id: Option<&'a str>,
}

/// 거절 입구가 끝낸 꼴.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DenyOutcome {
    /// 쓰고 커밋했다. 카드 답(에이전트 깨우기)·`message.updated` 는 커밋 뒤 호출자 몫(TS `recordAskAnswer` 와 같은 자리).
    Denied {
        card_message_id: Option<String>,
        as_owner: bool,
    },
    /// TS 와 같은 거절(상태 코드·code·문구).
    Refused {
        status: u16,
        code: &'static str,
        message: String,
    },
    /// 쓰기 전에 TS 로 넘긴다(되돌렸음) — 만료 카드 닫기·Rust 가 맡지 않는 꼴로 바뀐 요청.
    HandToTs,
}

/// 거절 입구가 실패한 꼴 — 둘 다 호출자는 `internal`(쓰기 tx 안에서 났으므로 TS 로 넘기지 않음).
#[derive(Debug)]
pub enum DenyError {
    Lock(LockRetryError),
    /// [`MAX_RESTARTS`] 번 다시 해도 요청 줄의 agent·channel 이 잠그는 사이에 바뀌었다.
    RestartsExhausted,
}

fn refused(status: u16, code: &'static str, message: impl Into<String>) -> DenyOutcome {
    DenyOutcome::Refused {
        status,
        code,
        message: message.into(),
    }
}

fn not_found() -> DenyOutcome {
    refused(
        404,
        "not_found",
        "no such permission request for this agent",
    )
}

/// 요청 줄을 잠근 **뒤**, 같은 tx 안에서 거절을 쓴다: 상태 대조 → 요청 줄 → 카드 글 → 감사(security 조건: 한 tx).
/// 상태 대조 문구·순서는 TS `decidePermissionRequest` 와 같다. 만료는 카드를 닫는 일이 TS 에 있으므로 쓰기 전에 넘긴다.
pub async fn deny_write(
    conn: &mut PgConnection,
    locked: &LockedRequest,
    args: DenyArgs<'_>,
    as_owner: bool,
) -> sqlx::Result<DenyOutcome> {
    match locked.status.as_str() {
        "obsolete" => {
            return Ok(refused(
                409,
                "pr_closed",
                "that pull request was already merged or closed — this card is closed",
            ));
        }
        "superseded" => {
            return Ok(refused(
                409,
                "superseded",
                "the agent asked again — decide on the newer card",
            ));
        }
        "pending" => {}
        s => {
            return Ok(refused(
                409,
                "already_decided",
                format!("this request is already {s}"),
            ));
        }
    }
    if locked.expired {
        return Ok(DenyOutcome::HandToTs);
    }
    let (target, channel_id, thread_root_id, now): (
        String,
        Option<String>,
        Option<String>,
        String,
    ) = sqlx::query_as(DENY_UPDATE_REQUEST)
        .bind(args.request_id)
        .bind(args.actor_id)
        .fetch_one(&mut *conn)
        .await?;
    if let Some(card) = locked.card_message_id.as_deref() {
        let mut patch = serde_json::json!({
            "status": "denied", "decidedAt": now, "decidedBy": args.actor_id,
        });
        if let Some(b) = args.bundle_message_id {
            patch["decidedVia"] = serde_json::json!({ "kind": "bundle", "bundleMessageId": b });
        }
        patch["decidedByOwner"] = Value::Bool(as_owner);
        sqlx::query(DENY_UPDATE_CARD)
            .bind(card)
            .bind(patch.to_string())
            .execute(&mut *conn)
            .await?;
    }
    let detail = audit_detail(&AuditDetail {
        request_id: args.request_id,
        kind: locked.kind.as_str(),
        target: target.as_str(),
        channel_id: channel_id.as_deref(),
        as_owner,
        thread_root_id: thread_root_id.as_deref(),
        grant_expires_at: None,
        grant_mode: None,
        bundle_message_id: args.bundle_message_id,
    });
    sqlx::query(DENY_AUDIT)
        .bind(args.actor_id)
        .bind(args.agent_id)
        .bind(detail.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(DenyOutcome::Denied {
        card_message_id: locked.card_message_id.clone(),
        as_owner,
    })
}

/// 요청 줄 결정 칸 — TS 와 같은 칸(`grant_expires_at`·`grant_mode` 는 null). 시각은 DB `now()` 하나를 카드에도 쓴다.
pub const DENY_UPDATE_REQUEST: &str = "update permission_request set status = 'denied', decided_at = now(), \
     decided_by = $2::uuid, grant_expires_at = null, grant_mode = null where id = $1::uuid \
     returning target, channel_id::text, thread_root_id::text, \
     to_char(now() at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";
/// 카드 글 meta — TS 와 같은 jsonb_set.
pub const DENY_UPDATE_CARD: &str = "update message set meta = jsonb_set(meta, '{permissionRequest}', \
     (meta->'permissionRequest') || $2::jsonb) where id = $1::uuid and meta ? 'permissionRequest'";
/// 감사 — 같은 tx 에 넣는다(실패하면 결정도 되돌림 → `internal`).
pub const DENY_AUDIT: &str = "insert into audit_log (action, actor_id, target, detail) \
     values ('permission.denied', $1::uuid, $2, $3::jsonb)";

/// 요청 줄을 잠그지 않고 읽는다(잠금 순서 1단계).
const PEEK_REQUEST: &str =
    "select agent_id::text, channel_id::text from permission_request where id = $1::uuid";

/// 한 시도(새 tx): 엿보기 → 근거 잠금·판정 → 요청 줄 잠금·다시 대조 → 쓰기 → 커밋. `None` = [`Recheck::Restart`].
async fn deny_attempt(
    pool: &sqlx::PgPool,
    args: DenyArgs<'_>,
) -> sqlx::Result<Option<DenyOutcome>> {
    if !is_uuid(args.request_id) || !is_uuid(args.agent_id) || !is_uuid(args.actor_id) {
        return Ok(Some(not_found()));
    }
    let mut tx = pool.begin().await?;
    let first: Option<(String, Option<String>)> = sqlx::query_as(PEEK_REQUEST)
        .bind(args.request_id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some((agent, channel)) = first else {
        return Ok(Some(not_found()));
    };
    if agent != args.agent_id {
        return Ok(Some(not_found()));
    }
    let v = may_decide_for_locked(&mut tx, &agent, args.actor_id, channel.as_deref()).await?;
    let locked = lock_request(&mut tx, args.request_id).await?;
    let shape = Shape {
        option: "deny",
        kind: "",
        has_mandate: false,
        has_denial: false,
        has_once: false,
        via_chat: false,
        via_mirror: false,
    };
    let d = match recheck_locked(&agent, channel.as_deref(), locked.as_ref(), shape) {
        Recheck::Go(d) => d,
        Recheck::Restart => return Ok(None),
        Recheck::HandToTs => return Ok(Some(DenyOutcome::HandToTs)),
        Recheck::Gone => return Ok(Some(not_found())),
    };
    let as_owner = match after_verdict(&v, d) {
        AfterVerdict::Forbidden => return Ok(Some(refused(403, "forbidden", FORBIDDEN_MESSAGE))),
        AfterVerdict::HandToTs => return Ok(Some(DenyOutcome::HandToTs)),
        AfterVerdict::Go { as_owner } => as_owner,
    };
    let Some(locked) = locked else {
        return Ok(Some(not_found()));
    };
    let out = deny_write(&mut tx, &locked, args, as_owner).await?;
    if matches!(out, DenyOutcome::Denied { .. }) {
        tx.commit().await?;
    }
    Ok(Some(out))
}

/// 거절 입구(붙는 길 없음 — 라우트·MCP 연결은 다음 조각). 시도마다 새 tx 이고, 40P01·55P03 은 [`retry_lock_once`] 로 한 번,
/// [`Recheck::Restart`] 는 [`MAX_RESTARTS`] 번까지 다시 한다. 둘 다 넘기면 [`DenyError`] → 호출자 `internal`.
pub async fn decide_deny(
    pool: &sqlx::PgPool,
    args: DenyArgs<'_>,
) -> Result<DenyOutcome, DenyError> {
    for _ in 0..=MAX_RESTARTS {
        match retry_lock_once(|| deny_attempt(pool, args)).await {
            Ok(Some(out)) => return Ok(out),
            Ok(None) => continue,
            Err(e) => return Err(DenyError::Lock(e)),
        }
    }
    Err(DenyError::RestartsExhausted)
}
