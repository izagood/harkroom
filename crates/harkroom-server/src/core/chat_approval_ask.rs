//! P3c — 사람이 선택 카드에 **글로** 답한다(TS `chatApproval.ts::answerAskFromMessage`, P5).
//!
//! 글 승인 입구([`super::chat_approval_apply::apply`])가 권한 판정보다 **먼저** 부른다. 다룬 글이면 true(답했거나 안내 줄을 달았다),
//! 가리킨 선택 카드가 없으면 false — 그때 권한 승인 판정으로 넘어간다(TS `applyChatApproval` 순서).
//!
//! - 어느 카드인지: 본문의 카드 링크 **하나**(T1), 링크가 없으면 같은 스레드에 글보다 먼저 선, 이 사람이 답할 수 있는 열린 선택 카드가
//!   **딱 하나**일 때 그 카드(T2). 진짜 거울 판정은 [`resolve_decision`] 으로 한다(권한 카드 거울은 선택 카드가 아니다).
//! - 답할 수 있는가(수신자·사람만·권한 카드 불가·거울 원본 채널)는 [`record_chat_answer`] 가 버튼과 같이 본다.
//! - 답에는 `answeredVia: 'chat'` 을 단다. 물어본 에이전트가 이 글로 이미 깨었으면 다시 깨우지 않는다(`skipWakeIfInboxFor`).
//! - 글은 이미 커밋됐다. 카드 `replied` 닫기는 이 판정 **뒤에** 부르는 쪽이 한다(TS 라우트 순서: 답 → `inbox.updated` → `closeAsksByReply`).
use super::ask::{Outcome, read_ask_meta};
use super::ask_bundle::is_irreversible;
use super::chat_approval_notice::{notice_line, post_line, refuse_line};
use super::chat_approval_parse::{
    AskNoPick, AskOptionRef, AskPick, AskPickParse, ChatApprovalParse, match_ask_pick,
};
use super::chat_approval_pick::{PostedMsg, Refusal};
use super::decide_core::{DecisionRef, channel_visible_conn, resolve_decision};
use super::msg_post::PostState;
use serde_json::{Value, json};
use sqlx::PgConnection;

/// TS `AskCard`.
struct AskCard {
    id: String,
    meta: Value,
    body: String,
    channel_id: String,
    seq: i64,
    created_ms: i64,
}

type CardRow = (String, Value, String, String, i64, i64);

macro_rules! card_cols {
    () => {
        "select id::text, meta, body, channel_id::text, seq, floor(extract(epoch from created_at) * 1000)::bigint from message "
    };
}
const READ_CARD_SQL: &str = concat!(card_cols!(), "where id = $1::uuid and deleted_at is null");

fn card(r: CardRow) -> AskCard {
    AskCard {
        id: r.0,
        meta: r.1,
        body: r.2,
        channel_id: r.3,
        seq: r.4,
        created_ms: r.5,
    }
}

/// TS `readAskCard`.
async fn read_ask_card(conn: &mut PgConnection, id: &str) -> sqlx::Result<Option<AskCard>> {
    let r: Option<CardRow> = sqlx::query_as(READ_CARD_SQL)
        .bind(id)
        .fetch_optional(conn)
        .await?;
    Ok(r.map(card))
}

/// TS T2 — 같은 스레드에 글보다 먼저 선, 이 사람이 답할 수 있는 열린 선택 카드(권한·머지 거절 카드 빼고).
const OPEN_IN_THREAD_SQL: &str = concat!(
    card_cols!(),
    "where channel_id = $1::uuid and (id = $2::uuid or thread_root_id = $2::uuid) and seq < $3 and deleted_at is null \
      and meta->>'kind' = 'ask' \
      and meta->'ask'->>'answeredWith' is null and meta->'ask'->>'closedAt' is null \
      and not (meta ? 'permissionRequest') and not (meta ? 'mergeDenial') \
      and (meta->'ask'->'to'->>'kind' = 'human' or (meta->'ask'->'to'->>'kind' = 'account' and meta->'ask'->'to'->>'accountId' = $4)) \
    order by seq"
);

/// TS `ownsOpenPermissionCardInThread`.
const OWNS_PERMISSION_IN_THREAD_SQL: &str = "select exists(select 1 from permission_request p \
       join message m on m.id = p.card_message_id and m.deleted_at is null \
       join agent_config c on c.account_id = p.agent_id \
      where m.channel_id = $1::uuid and (m.id = $2::uuid or m.thread_root_id = $2::uuid) and m.seq < $3 \
        and c.owner_account_id = $4::uuid and p.status = 'pending' and p.expires_at > now())";

fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

/// 카드 meta 의 선택지(TS `AskOption` — id·label·recommended). `read_ask_meta` 가 모양을 이미 확인했다.
fn options(meta: &Value) -> Vec<AskOptionRef<'_>> {
    meta["ask"]["options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|o| {
            Some(AskOptionRef {
                id: o.get("id")?.as_str()?,
                label: o.get("label")?.as_str()?,
                recommended: js_truthy(o.get("recommended")),
            })
        })
        .collect()
}

/// TS `matchAskPick(readAskMeta(meta).options, pick)` — 못 읽는 카드는 맞지 않는다.
fn pick_of(meta: &Value, pick: &AskPick) -> Result<String, Refusal> {
    if read_ask_meta(meta).is_none() {
        return Err(Refusal::AskNoMatch);
    }
    match_ask_pick(&options(meta), pick)
        .map(str::to_owned)
        .map_err(|e| match e {
            AskNoPick::NoMatch => Refusal::AskNoMatch,
            AskNoPick::NoRecommended => Refusal::AskNoRecommended,
        })
}

/// TS `matchesAny`.
fn matches_any(cards: &[AskCard], pick: &AskPick) -> bool {
    cards.iter().any(|c| pick_of(&c.meta, pick).is_ok())
}

/// 답할 카드를 고른 결말.
enum Found {
    /// 가리킨 선택 카드가 없다 — 권한 판정으로 넘긴다.
    None,
    /// 다뤘지만 답하지 않았다 — 안내 줄(있으면)을 달고 끝낸다.
    Handled(Option<(String, serde_json::Map<String, Value>)>),
    Card {
        card: AskCard,
        via_link: bool,
    },
}

async fn find(
    conn: &mut PgConnection,
    msg: &PostedMsg,
    actor: &str,
    p: &AskPickParse,
    approval: Option<&ChatApprovalParse>,
) -> sqlx::Result<Found> {
    let explicit = p.pick.explicit();
    if !p.card_ids.is_empty() {
        let mut asks: Vec<&str> = Vec::new();
        let mut perms = 0usize;
        for id in &p.card_ids {
            match resolve_decision(conn, id).await? {
                Some(DecisionRef::Ask { .. }) => asks.push(id),
                Some(DecisionRef::Permission { .. }) => perms += 1,
                None => {}
            }
        }
        if asks.is_empty() {
            return Ok(Found::None);
        }
        if perms > 0 || asks.len() > 1 {
            return Ok(if explicit {
                Found::Handled(Some(refuse_line(&msg.id, Refusal::AskMany)))
            } else {
                Found::None
            });
        }
        return Ok(match read_ask_card(conn, asks[0]).await? {
            Some(card) => Found::Card {
                card,
                via_link: true,
            },
            None => Found::None,
        });
    }
    let Some(root) = msg.thread_root_id.as_deref() else {
        return Ok(Found::None);
    };
    let rows: Vec<CardRow> = sqlx::query_as(OPEN_IN_THREAD_SQL)
        .bind(&msg.channel_id)
        .bind(root)
        .bind(msg.seq)
        .bind(actor)
        .fetch_all(&mut *conn)
        .await?;
    // 권한 카드의 거울은 선택 카드가 아니다 — 권한 판정으로 넘긴다.
    let mut open = Vec::new();
    for r in rows {
        if matches!(
            resolve_decision(conn, &r.0).await?,
            Some(DecisionRef::Ask { .. })
        ) {
            open.push(card(r));
        }
    }
    if open.is_empty() {
        return Ok(Found::None);
    }
    let ids = || open.iter().map(|c| c.id.clone()).collect::<Vec<_>>();
    // 승인 낱말이 든 글인데 이 스레드에 내 권한 카드도 열려 있으면 어느 쪽인지 모른다 — 둘 다 정하지 않는다.
    if approval.is_some_and(|a| a.action.is_some()) {
        let owns: bool = sqlx::query_scalar(OWNS_PERMISSION_IN_THREAD_SQL)
            .bind(&msg.channel_id)
            .bind(root)
            .bind(msg.seq)
            .bind(actor)
            .fetch_one(&mut *conn)
            .await?;
        if owns {
            return Ok(Found::Handled(Some(notice_line(
                &msg.id,
                "답 안 됨: 이 스레드에 선택 카드와 권한 카드가 함께 기다린다. 정할 카드의 링크를 붙여 다시 쓴다:",
                &ids(),
            ))));
        }
    }
    if open.len() > 1 {
        if !explicit && !matches_any(&open, &p.pick) {
            return Ok(Found::None);
        }
        let text = format!(
            "답 안 됨: 이 스레드에 기다리는 선택 카드가 {}장이라 어느 것인지 모른다. 답할 카드의 링크를 붙여 다시 쓴다:",
            open.len()
        );
        return Ok(Found::Handled(Some(notice_line(&msg.id, &text, &ids()))));
    }
    Ok(Found::Card {
        card: open.remove(0),
        via_link: false,
    })
}

/// 답하기 전 판정의 결말.
enum Verdict {
    /// 조용히 넘긴다(TS `return false`).
    Pass,
    /// 다뤘다 — 줄(있으면)을 달고 끝낸다.
    Done(Option<Refusal>),
    Answer(String),
}

/// TS 의 카드 고른 뒤 판정(받는 쪽·먼저 섰나·이미 답했나·맞는 선택지·되돌릴 수 없는 카드).
fn verdict(
    card: &AskCard,
    msg: &PostedMsg,
    actor: &str,
    p: &AskPickParse,
    via_link: bool,
) -> Verdict {
    let Some(ask) = read_ask_meta(&card.meta) else {
        return Verdict::Pass;
    };
    // 남에게 간 카드에는 아무 줄도 남기지 않는다.
    if let super::ask::To::Account(a) = &ask.to
        && a != actor
    {
        return Verdict::Pass;
    }
    let before = if card.channel_id == msg.channel_id {
        card.seq < msg.seq
    } else {
        card.created_ms <= msg.created_ms
    };
    let matched = pick_of(&card.meta, &p.pick);
    if matched.is_err() && !p.pick.explicit() {
        return Verdict::Pass;
    }
    if !before {
        return Verdict::Done(Some(Refusal::NotBefore));
    }
    if ask.answered {
        return Verdict::Done(Some(Refusal::AskAnswered));
    }
    let option = match matched {
        Ok(o) => o,
        Err(why) => return Verdict::Done(Some(why)),
    };
    // 「추천대로」·링크 없는 번호는 되돌릴 수 없는 카드에 쓰지 않는다(security n19).
    let loose = matches!(p.pick, AskPick::Recommended)
        || (matches!(p.pick, AskPick::Index(_)) && !via_link);
    if loose && is_irreversible(&card.meta, &card.body) {
        return Verdict::Done(Some(Refusal::AskIrreversible));
    }
    Verdict::Answer(option)
}

/// TS `answerAskFromMessage`. 던지지 않는 쪽은 부르는 쪽이다(글은 이미 커밋됐다).
pub async fn answer_from_message(
    ask: &super::ask::AskState,
    post: &PostState,
    msg: &PostedMsg,
    actor: &str,
    p: &AskPickParse,
    approval: Option<&ChatApprovalParse>,
) -> sqlx::Result<bool> {
    let (card, via_link) = {
        let mut conn = ask.read.acquire().await?;
        match find(&mut conn, msg, actor, p, approval).await? {
            Found::None => return Ok(false),
            Found::Handled(line) => {
                drop(conn);
                if let Some((b, m)) = line {
                    post_line(post, msg, actor, b, m).await?;
                }
                return Ok(true);
            }
            Found::Card { card, via_link } => {
                if !channel_visible_conn(&mut conn, &card.channel_id, actor).await? {
                    return Ok(true);
                }
                (card, via_link)
            }
        }
    };
    let option = match verdict(&card, msg, actor, p, via_link) {
        Verdict::Pass => return Ok(false),
        Verdict::Done(why) => {
            if let Some(why) = why {
                let (b, m) = refuse_line(&msg.id, why);
                post_line(post, msg, actor, b, m).await?;
            }
            return Ok(true);
        }
        Verdict::Answer(o) => o,
    };
    let out = {
        let mut tx = ask.write.begin().await?;
        let out =
            super::ask::record_chat_answer(&ask.read, &mut tx, &card.id, actor, &option, &msg.id)
                .await?;
        if let Outcome::Row(row) = &out {
            let row: Value =
                serde_json::from_str(row).map_err(|e| sqlx::Error::Decode(e.into()))?;
            let channel = row
                .get("channelId")
                .and_then(Value::as_str)
                .unwrap_or(&card.channel_id)
                .to_owned();
            let audience = super::audience::audience_on(&mut tx, &channel)
                .await?
                .to_json();
            crate::write::emit_event(
                &mut tx,
                &json!({ "type": "message.updated", "message": row, "audience": audience }),
            )
            .await?;
        }
        // 거절도 커밋한다 — 거울 경로는 진 경합에서도 거울을 맞춘다(버튼 답과 같다).
        tx.commit().await?;
        out
    };
    let why = match out {
        Outcome::Row(_) => None,
        Outcome::AlreadyAnswered => Some(Refusal::AskAnswered),
        // 답할 수 없는 카드(남에게 간 것·권한 카드 거울)는 조용히 둔다.
        Outcome::Forbidden | Outcome::NotFound => None,
        Outcome::UnknownOption => Some(Refusal::Failed),
    };
    if let Some(why) = why {
        let (b, m) = refuse_line(&msg.id, why);
        post_line(post, msg, actor, b, m).await?;
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::super::chat_approval_parse::parse_ask_pick;
    use super::*;

    fn msg() -> PostedMsg {
        PostedMsg {
            id: "m".into(),
            channel_id: "c".into(),
            thread_root_id: Some("r".into()),
            seq: 10,
            created_ms: 1000,
        }
    }

    fn card_with(meta: Value, seq: i64) -> AskCard {
        AskCard {
            id: "k".into(),
            meta,
            body: "고를까".into(),
            channel_id: "c".into(),
            seq,
            created_ms: 0,
        }
    }

    fn ask_meta(to: Value, irreversible: bool) -> Value {
        json!({ "kind": "ask", "ask": {
            "prompt": "어느 쪽", "to": to, "irreversible": irreversible,
            "options": [ { "id": "a", "label": "사과" }, { "id": "b", "label": "배", "recommended": true } ]
        }})
    }

    fn v(card: &AskCard, body: &str, via_link: bool) -> Verdict {
        verdict(card, &msg(), "me", &parse_ask_pick(body).unwrap(), via_link)
    }

    #[test]
    fn answers_by_index_name_and_recommended() {
        let c = card_with(ask_meta(json!({ "kind": "human" }), false), 3);
        assert!(matches!(v(&c, "2번", false), Verdict::Answer(o) if o == "b"));
        assert!(matches!(v(&c, "사과", false), Verdict::Answer(o) if o == "a"));
        assert!(matches!(v(&c, "추천대로", false), Verdict::Answer(o) if o == "b"));
    }

    #[test]
    fn name_without_match_passes_but_explicit_refuses() {
        let c = card_with(ask_meta(json!({ "kind": "human" }), false), 3);
        assert!(matches!(v(&c, "점심 먹자", false), Verdict::Pass));
        assert!(matches!(
            v(&c, "5번", false),
            Verdict::Done(Some(Refusal::AskNoMatch))
        ));
    }

    #[test]
    fn later_card_and_others_card() {
        let later = card_with(ask_meta(json!({ "kind": "human" }), false), 11);
        assert!(matches!(
            v(&later, "1번", false),
            Verdict::Done(Some(Refusal::NotBefore))
        ));
        let others = card_with(
            ask_meta(json!({ "kind": "account", "accountId": "you" }), false),
            3,
        );
        assert!(matches!(v(&others, "1번", false), Verdict::Pass));
    }

    #[test]
    fn irreversible_needs_link_for_index_and_never_recommended() {
        let c = card_with(ask_meta(json!({ "kind": "human" }), true), 3);
        assert!(matches!(
            v(&c, "1번", false),
            Verdict::Done(Some(Refusal::AskIrreversible))
        ));
        assert!(matches!(v(&c, "1번", true), Verdict::Answer(_)));
        assert!(matches!(
            v(&c, "추천대로", true),
            Verdict::Done(Some(Refusal::AskIrreversible))
        ));
        assert!(matches!(v(&c, "사과", false), Verdict::Answer(_)));
    }

    #[test]
    fn answered_card_refuses() {
        let mut m = ask_meta(json!({ "kind": "human" }), false);
        m["ask"]["answeredWith"] = json!("a");
        let c = card_with(m, 3);
        assert!(matches!(
            v(&c, "1번", false),
            Verdict::Done(Some(Refusal::AskAnswered))
        ));
    }
}
