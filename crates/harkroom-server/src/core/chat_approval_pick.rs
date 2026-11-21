//! P3b-2b — 글 승인이 **어느 권한 카드를** 정하는가(TS `services/chatApproval.ts` `approveFromMessage` 의 카드 고르기 부분).
//!
//! 순수 판정([`super::chat_approval_parse`])이 낱말·링크를 읽은 뒤, 이 모듈이 DB 를 읽어 대상을 고른다:
//! - T1 — 본문의 카드 링크(1~5개). 거울은 서버가 세운 진짜 거울일 때만 원본으로 센다.
//! - T2 — 링크가 없으면 글이 선 스레드의 권한 카드(진짜 거울 포함) 가운데 글쓴이가 정할 수 있는 열린 카드가 하나일 때.
//! - T3 — 그 스레드에 권한 카드가 하나도 없으면 소유자의 에이전트가 글보다 먼저 낸 기다리는 요청이 하나일 때(소유자만).
//!
//! 결정(2c)·안내 줄(2d)은 이 결과([`Selection`])를 받아서 한다. 여기서는 아무것도 쓰지 않는다 — 읽기 풀에서 돈다.

use serde_json::Value;
use sqlx::PgConnection;

use super::chat_approval_parse::{
    CHAT_APPROVAL_MAX_CARDS, ChatAction, ChatApprovalParse, ChatBlock, is_explicit_approval,
};
use super::decide_core::{
    DecisionRef, is_genuine_permission_mirror, may_decide_for_unlocked, resolve_decision,
};

/// TS `ChatTarget` — 어떻게 가리켰나(감사에 남는다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChatTarget {
    T1,
    T2,
    T3,
}

impl ChatTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            ChatTarget::T1 => "T1",
            ChatTarget::T2 => "T2",
            ChatTarget::T3 => "T3",
        }
    }
}

/// TS `ChatRefusal` 가운데 권한 승인 쪽 까닭(`system.chatApproval.<key>`). 선택 카드(ask*) 까닭은 P5 답 쪽이 쓴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Block(ChatBlock),
    DenyNeedsLink,
    NeedsExplicit,
    NoWord,
    TooMany,
    NoCard,
    AskCard,
    AskMany,
    AskNoMatch,
    AskNoRecommended,
    AskIrreversible,
    AskAnswered,
    Hidden,
    HeadChanged,
    CiWord,
    /// TS `settled` — Rust 는 더 내지 않는다(열린 카드 없음 = 조용히). i18n·TS 키 대조에만 남긴다.
    #[allow(dead_code)]
    Settled,
    NoRequest,
    NotBefore,
    Decided,
    Expired,
    OnceOnCard,
    MergeNoMandate,
    Failed,
}

impl Refusal {
    /// i18n 키 끝(`system.chatApproval.<key>`)·meta `reason` 값 — TS `REASON_KO` 의 키와 같다.
    pub fn key(self) -> &'static str {
        match self {
            Refusal::Block(b) => match b {
                ChatBlock::Negated => "negated",
                ChatBlock::Question => "question",
                ChatBlock::Bypass => "bypass",
                ChatBlock::Conflict => "conflict",
                ChatBlock::NotFinal => "notFinal",
                ChatBlock::DenyNotFinal => "denyNotFinal",
            },
            Refusal::DenyNeedsLink => "denyNeedsLink",
            Refusal::NeedsExplicit => "needsExplicit",
            Refusal::NoWord => "noWord",
            Refusal::TooMany => "tooMany",
            Refusal::NoCard => "noCard",
            Refusal::AskCard => "askCard",
            Refusal::AskMany => "askMany",
            Refusal::AskNoMatch => "askNoMatch",
            Refusal::AskNoRecommended => "askNoRecommended",
            Refusal::AskIrreversible => "askIrreversible",
            Refusal::AskAnswered => "askAnswered",
            Refusal::Hidden => "hidden",
            Refusal::HeadChanged => "headChanged",
            Refusal::CiWord => "ciWord",
            Refusal::Settled => "settled",
            Refusal::NoRequest => "noRequest",
            Refusal::NotBefore => "notBefore",
            Refusal::Decided => "decided",
            Refusal::Expired => "expired",
            Refusal::OnceOnCard => "onceOnCard",
            Refusal::MergeNoMandate => "mergeNoMandate",
            Refusal::Failed => "failed",
        }
    }
}

/// TS `Candidate` — 권한 요청 하나와 그 카드.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub card_message_id: String,
    pub request_id: String,
    pub agent_id: String,
    pub agent_handle: String,
    pub kind: String,
    pub target: String,
    pub channel_id: String,
    pub channel_name: Option<String>,
    pub status: String,
    pub expired: bool,
    pub denial_id: Option<String>,
    pub owner_account_id: Option<String>,
    pub card_seq: i64,
    /// 카드 글 시각(ms) — TS 는 `Date` 로 견준다(ms 단위).
    pub card_created_ms: i64,
    /// 카드 meta `permissionRequest.once`(머지 거절 카드의 PR·head·까닭).
    pub once: Option<Value>,
    /// 글쓴이가 이 카드를 정할 수 있나(TS `withDeciders` → `mayDecideFor`).
    pub can_decide: bool,
}

impl Candidate {
    pub fn is_open(&self) -> bool {
        self.status == "pending" && !self.expired
    }
}

type CandidateRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    bool,
    Option<String>,
    Option<String>,
    i64,
    i64,
    Option<Value>,
);

/// TS `CANDIDATE_SQL` 뒤에 조건을 붙인다(정적 문자열 — sqlx `SqlSafeStr`).
macro_rules! candidate_sql {
    ($tail:literal) => {
        concat!("select p.card_message_id::text, p.id::text, p.agent_id::text, a.handle, \
       p.kind, p.target, p.channel_id::text, ch.name, p.status, p.expires_at <= now(), \
       p.denial_id::text, c.owner_account_id::text, m.seq, floor(extract(epoch from m.created_at) * 1000)::bigint, \
       m.meta->'permissionRequest'->'once' \
  from permission_request p \
  join message m on m.id = p.card_message_id and m.deleted_at is null \
  join account a on a.id = p.agent_id \
  left join agent_config c on c.account_id = p.agent_id \
  left join channel ch on ch.id = p.channel_id ", $tail)
    };
}

fn to_candidate(r: CandidateRow) -> Candidate {
    Candidate {
        card_message_id: r.0,
        request_id: r.1,
        agent_id: r.2,
        agent_handle: r.3,
        kind: r.4,
        target: r.5,
        channel_id: r.6,
        channel_name: r.7,
        status: r.8,
        expired: r.9,
        denial_id: r.10,
        owner_account_id: r.11,
        card_seq: r.12,
        card_created_ms: r.13,
        once: r.14,
        can_decide: false,
    }
}

/// 판정할 글(이미 커밋됐다).
#[derive(Debug, Clone)]
pub struct PostedMsg {
    pub id: String,
    pub channel_id: String,
    pub thread_root_id: Option<String>,
    pub seq: i64,
    pub created_ms: i64,
}

impl PostedMsg {
    pub fn thread_root(&self) -> &str {
        self.thread_root_id.as_deref().unwrap_or(&self.id)
    }
}

/// 카드 고르기의 결말.
#[derive(Debug, Clone)]
pub enum Selection {
    /// 아무 줄도 달지 않는다.
    Silent,
    /// 「승인 안 됨: <까닭>」 한 줄(TS `refuse`).
    Refuse(Refusal),
    /// 후보가 여럿이라 고르지 못했다 — 링크 목록 줄(TS `notice`). `count` 는 문구의 n 장/개.
    Ambiguous {
        in_thread: bool,
        count: usize,
        card_ids: Vec<String>,
    },
    /// 이 카드들을 정한다(2c).
    Decide {
        targets: Vec<Candidate>,
        target: ChatTarget,
    },
}

async fn with_deciders(
    conn: &mut PgConnection,
    actor: &str,
    rows: Vec<Candidate>,
) -> sqlx::Result<Vec<Candidate>> {
    let mut out = Vec::with_capacity(rows.len());
    for mut c in rows {
        c.can_decide = may_decide_for_unlocked(conn, &c.agent_id, actor, Some(&c.channel_id))
            .await?
            .ok
            .is_some();
        out.push(c);
    }
    Ok(out)
}

/// TS `ownsPendingRequest`.
pub async fn owns_pending_request(conn: &mut PgConnection, actor: &str) -> sqlx::Result<bool> {
    let r: Option<i32> = sqlx::query_scalar(
        "select 1 from permission_request p join agent_config c on c.account_id = p.agent_id \
          where c.owner_account_id = $1::uuid and p.status = 'pending' and p.expires_at > now() limit 1",
    )
    .bind(actor)
    .fetch_optional(conn)
    .await?;
    Ok(r.is_some())
}

/// TS `approveFromMessage` 의 카드 고르기. `parsed` 는 `parse_chat_approval` 결과(Some 일 때만 부른다).
pub async fn select(
    conn: &mut PgConnection,
    msg: &PostedMsg,
    body: &str,
    actor: &str,
    parsed: &ChatApprovalParse,
) -> sqlx::Result<Selection> {
    let decisive = parsed.action.is_some() && parsed.block.is_none();
    if !parsed.card_ids.is_empty() {
        if parsed.card_ids.len() > CHAT_APPROVAL_MAX_CARDS {
            return Ok(Selection::Refuse(Refusal::TooMany));
        }
        let mut resolved: Vec<String> = Vec::new();
        let mut ask_cards = 0usize;
        for id in &parsed.card_ids {
            match resolve_decision(conn, id).await? {
                Some(DecisionRef::Permission {
                    card_message_id: Some(card),
                    mirror_message_id,
                    agent_id,
                    ..
                }) => {
                    if let Some(mirror) = mirror_message_id
                        && !is_genuine_permission_mirror(conn, &mirror, &card, &agent_id).await?
                    {
                        continue;
                    }
                    resolved.push(card);
                }
                Some(DecisionRef::Ask { .. }) => ask_cards += 1,
                _ => {}
            }
        }
        let rows: Vec<Candidate> = if resolved.is_empty() {
            Vec::new()
        } else {
            sqlx::query_as::<_, CandidateRow>(candidate_sql!(
                "where p.card_message_id = any($1::uuid[])"
            ))
            .bind(&resolved)
            .fetch_all(&mut *conn)
            .await?
            .into_iter()
            .map(to_candidate)
            .collect()
        };
        let mut uniq: Vec<String> = Vec::new();
        for id in resolved {
            if !uniq.contains(&id) {
                uniq.push(id);
            }
        }
        let ordered: Vec<Candidate> = uniq
            .iter()
            .filter_map(|id| rows.iter().find(|r| &r.card_message_id == id).cloned())
            .collect();
        let targets = with_deciders(conn, actor, ordered).await?;
        if targets.is_empty() {
            if ask_cards > 0 && decisive {
                return Ok(Selection::Refuse(Refusal::AskCard));
            }
            if decisive && owns_pending_request(conn, actor).await? {
                return Ok(Selection::Refuse(Refusal::NoCard));
            }
            return Ok(Selection::Silent);
        }
        let mine_any = targets.iter().any(|c| c.can_decide);
        if !mine_any {
            return Ok(Selection::Silent);
        }
        if let Some(b) = parsed.block {
            return Ok(Selection::Refuse(Refusal::Block(b)));
        }
        if parsed.action.is_none() {
            if targets.iter().any(|c| c.can_decide && c.is_open()) {
                return Ok(Selection::Refuse(Refusal::NoWord));
            }
            return Ok(Selection::Silent);
        }
        return Ok(Selection::Decide {
            targets,
            target: ChatTarget::T1,
        });
    }

    if parsed.action.is_none() && parsed.block != Some(ChatBlock::Bypass) {
        return Ok(Selection::Silent);
    }
    if parsed.action == Some(ChatAction::Deny) {
        if owns_pending_request(conn, actor).await? {
            return Ok(Selection::Refuse(
                parsed
                    .block
                    .map(Refusal::Block)
                    .unwrap_or(Refusal::DenyNeedsLink),
            ));
        }
        return Ok(Selection::Silent);
    }
    // T2 — 글이 선 스레드의 권한 카드(상태와 관계없이). 하나라도 있으면 T3 로 넘기지 않는다(security F3).
    let root = msg.thread_root();
    let direct: Vec<Candidate> = sqlx::query_as::<_, CandidateRow>(candidate_sql!(
        "where m.channel_id = $1::uuid and (m.id = $2::uuid or m.thread_root_id = $2::uuid) \
           and m.seq < $3 order by m.created_at"
    ))
    .bind(&msg.channel_id)
    .bind(root)
    .bind(msg.seq)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .map(to_candidate)
    .collect();
    let mirrors: Vec<(String, Option<String>)> = sqlx::query_as(
        "select mm.id::text, mm.meta->'ask'->>'mirrorOf' from message mm \
          where mm.channel_id = $1::uuid and (mm.id = $2::uuid or mm.thread_root_id = $2::uuid) and mm.seq < $3 \
            and mm.deleted_at is null and mm.meta->'ask' ? 'mirrorOf'",
    )
    .bind(&msg.channel_id)
    .bind(root)
    .bind(msg.seq)
    .fetch_all(&mut *conn)
    .await?;
    let roots: Vec<String> = mirrors.iter().filter_map(|m| m.1.clone()).collect();
    let mirrored: Vec<Candidate> = if mirrors.is_empty() {
        Vec::new()
    } else {
        sqlx::query_as::<_, CandidateRow>(candidate_sql!(
            "where p.card_message_id::text = any($1::text[]) order by m.created_at"
        ))
        .bind(&roots)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .map(to_candidate)
        .collect()
    };
    let mut genuine: Vec<Candidate> = Vec::new();
    let mut fake_mirror = false;
    for c in mirrored {
        let mut ok = false;
        for (mid, r) in &mirrors {
            if r.as_deref() != Some(c.card_message_id.as_str()) {
                continue;
            }
            if is_genuine_permission_mirror(conn, mid, &c.card_message_id, &c.agent_id).await? {
                ok = true;
                break;
            }
        }
        if ok {
            genuine.push(c);
        } else {
            fake_mirror = true;
        }
    }
    let mut all: Vec<Candidate> = direct.into_iter().chain(genuine).collect();
    // TS `Array.sort` 는 안정 정렬 — 같은 시각이면 들어온 차례(직접 → 거울)를 지킨다.
    all.sort_by_key(|c| c.card_created_ms);
    let mut seen: Vec<String> = Vec::new();
    all.retain(|c| {
        if seen.contains(&c.request_id) {
            false
        } else {
            seen.push(c.request_id.clone());
            true
        }
    });
    let in_thread = with_deciders(conn, actor, all).await?;
    if in_thread.is_empty() && fake_mirror {
        return Ok(Selection::Silent);
    }
    if !in_thread.is_empty() {
        let mine: Vec<&Candidate> = in_thread.iter().filter(|c| c.can_decide).collect();
        if mine.is_empty() {
            return Ok(Selection::Silent);
        }
        if let Some(b) = parsed.block {
            return Ok(Selection::Refuse(Refusal::Block(b)));
        }
        let open: Vec<Candidate> = mine.into_iter().filter(|c| c.is_open()).cloned().collect();
        if open.len() > 1 {
            return Ok(Selection::Ambiguous {
                in_thread: true,
                count: open.len(),
                card_ids: open.into_iter().map(|c| c.card_message_id).collect(),
            });
        }
        // 열린 카드가 하나도 없으면 줄을 달지 않는다(소유자 결정 2026-11-20 B안). TS 는 `settled` 거절 줄을 단다 —
        // 에이전트에게 머지를 시키는 글이 정해진 카드 스레드에 서면 그 줄이 곧 설 새 카드 위에 붙어 카드 오류처럼 보였다.
        if open.is_empty() {
            return Ok(Selection::Silent);
        }
        if !is_explicit_approval(body) {
            return Ok(Selection::Refuse(Refusal::NeedsExplicit));
        }
        return Ok(Selection::Decide {
            targets: open,
            target: ChatTarget::T2,
        });
    }
    // T3 — 카드 없는 스레드의 맨 글. 부정·물음·끝맺지 않은 꼴·명시적이지 않은 승인은 조용히 넘긴다(A안·n15).
    if parsed.block.is_some() || !is_explicit_approval(body) {
        return Ok(Selection::Silent);
    }
    let mine: Vec<Candidate> = sqlx::query_as::<_, CandidateRow>(candidate_sql!(
        "where c.owner_account_id = $1::uuid and p.status = 'pending' and p.expires_at > now() \
           and m.created_at < to_timestamp($2::float8 / 1000) order by m.created_at"
    ))
    .bind(actor)
    .bind(msg.created_ms as f64)
    .fetch_all(&mut *conn)
    .await?
    .into_iter()
    .map(to_candidate)
    .collect();
    if mine.is_empty() {
        if owns_pending_request(conn, actor).await? {
            return Ok(Selection::Refuse(Refusal::NoRequest));
        }
        return Ok(Selection::Silent);
    }
    if mine.len() > 1 {
        return Ok(Selection::Ambiguous {
            in_thread: false,
            count: mine.len(),
            card_ids: mine.into_iter().map(|c| c.card_message_id).collect(),
        });
    }
    // T3 는 소유자만 — 후보가 소유자 요청뿐이라 정할 수 있다.
    Ok(Selection::Decide {
        targets: mine
            .into_iter()
            .map(|mut c| {
                c.can_decide = true;
                c
            })
            .collect(),
        target: ChatTarget::T3,
    })
}
