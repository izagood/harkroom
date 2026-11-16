//! 백스톱 카드(연쇄 한도 재설계 ③) — TS `services/chainBackstop.ts` `raiseChainBackstop` 을 옮긴 것(S5.3 C1c-4d-2).
//!
//! 사람 손길 없이 이어진 에이전트 사슬이 상한(홉 `chain_limit` 또는 24시간)에 닿아 동료를 못 부르면, 그 글이 **커밋된 뒤**
//! 그 스레드에 막힌 에이전트의 **소유자** 앞으로 [계속 — 예산 리셋]/[멈춤] 카드를 세운다. 한 스레드에 열린 백스톱 카드는 하나다 —
//! 이미 열려 있으면 그것을 돌려준다. 카드 글은 서버 알림 줄(`serverNotice`)이라 결과로 세지 않고(회신권·위임 의무를 건드리지 않는다),
//! 본문의 `@` 는 무력화해 누구도 부르지 않는다. 소유자에게 inbox 가 가지 않았으면 ask 푸시를 넣는다.
//!
//! 문장(소유자·열린 카드·ask 푸시)은 TS 상수를 골든으로 받는다(`golden/sql_fragments.json`).

use super::msg_post::{self, Origin, Outcome, PostBody, PostState};
use serde_json::{Map, Value, json};
use std::sync::OnceLock;

/// shared `CHAIN_BACKSTOP_CONTINUE`·`CHAIN_BACKSTOP_STOP`.
pub const CHAIN_BACKSTOP_CONTINUE: &str = "continue";
pub const CHAIN_BACKSTOP_STOP: &str = "stop";

struct Sql {
    owner: String,
    open: String,
    push: String,
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
            owner: frag("chain_backstop_owner"),
            open: frag("chain_backstop_open"),
            push: frag("enqueue_ask_push"),
        }
    })
}

/// TS `ChainBackstopInput`.
pub struct Input<'a> {
    pub agent_id: &'a str,
    pub channel_id: &'a str,
    pub thread_root_id: &'a str,
    /// 막힌 글.
    pub source_message_id: &'a str,
    pub capped_ids: &'a [String],
    pub limit: i64,
    /// `reason: 'age'`(아니면 `'hops'`).
    pub age: bool,
}

/// TS 카드 meta — `{ kind: 'ask', ask: {…}, chainBackstop: {…} }`.
fn card_meta(b: &Input<'_>, owner: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("kind".into(), json!("ask"));
    m.insert(
        "ask".into(),
        json!({
            "prompt": "사람 없이 이어진 연쇄를 계속할까?",
            "options": [
                { "id": CHAIN_BACKSTOP_CONTINUE, "label": "계속 — 예산 리셋", "hint": "홉 수와 24시간을 처음부터 다시 센다", "recommended": true },
                { "id": CHAIN_BACKSTOP_STOP, "label": "멈춤", "hint": "에이전트는 동료를 부르지 않는다" },
            ],
            "to": { "kind": "account", "accountId": owner },
            // 묶음 카드의 「추천대로 일괄」로 넘기지 않는다 — 사람이 직접 고르는 카드다.
            "irreversible": true,
        }),
    );
    m.insert(
        "chainBackstop".into(),
        json!({
            "agentId": b.agent_id,
            "sourceMessageId": b.source_message_id,
            "cappedIds": b.capped_ids,
            "limit": b.limit,
            "reason": if b.age { "age" } else { "hops" },
        }),
    );
    m
}

/// TS 본문 — 서버 값만 싣고 `@` 는 `＠` 로 무력화한다(이 카드가 누구를 부르면 안 된다).
fn card_body(handle: &str, b: &Input<'_>) -> String {
    let why = if b.age {
        "24시간".to_owned()
    } else {
        format!("{}홉", b.limit)
    };
    format!(
        "⏸ 사람 없이 이어진 연쇄가 백스톱({why})에 닿아 {handle} 의 부름을 멈췄다. 계속하려면 [계속 — 예산 리셋]을 누른다."
    )
    .replace('@', "＠")
}

/// TS `raiseChainBackstop`. 세운(또는 이미 열린) 카드 id — 소유자가 없거나 글이 실패하면 `None`.
/// 원본 글이 커밋된 **뒤에만** 부른다([`msg_post::post_in_tx`]).
pub async fn raise(
    st: &PostState,
    b: &Input<'_>,
    audience: &Value,
    is_dm: bool,
) -> Result<Option<String>, sqlx::Error> {
    let s = sql();
    let owner: Option<(String, String)> = sqlx::query_as(s.owner.as_str())
        .bind(b.agent_id)
        .fetch_optional(&st.write)
        .await?;
    // 소유자가 없으면 누를 사람이 없다 — 막힘 표시(`mentionChainCapped`)만 남는다.
    let Some((owner, handle)) = owner else {
        return Ok(None);
    };
    let open: Option<String> = sqlx::query_scalar(s.open.as_str())
        .bind(b.channel_id)
        .bind(b.thread_root_id)
        .fetch_optional(&st.write)
        .await?;
    if let Some(id) = open {
        return Ok(Some(id));
    }
    let post = PostBody {
        body: card_body(&handle, b),
        attachment_ids: Vec::new(),
        thread_root: Some(b.thread_root_id.to_owned()),
        also_in_channel: false,
    };
    let origin = Origin {
        meta: card_meta(b, &owner),
        server_notice: true,
        ..Origin::default()
    };
    let (out, _) = msg_post::post_tx(
        st,
        b.channel_id,
        b.agent_id,
        true,
        &post,
        None,
        audience,
        is_dm,
        &origin,
    )
    .await?;
    let Outcome::Posted { row, notified, .. } = out else {
        return Ok(None);
    };
    let row: Value = serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
    let Some(id) = row.get("id").and_then(Value::as_str).map(str::to_owned) else {
        return Err(sqlx::Error::RowNotFound);
    };
    // TS 와 같이 커밋 뒤 — 소유자에게 inbox 가 안 갔으면 ask 푸시(사람·기기 있음·차단 아님은 문장이 거른다).
    if !notified.iter().any(|a| a == &owner) {
        sqlx::query(s.push.as_str())
            .bind(&owner)
            .bind(&id)
            .execute(&st.write)
            .await?;
    }
    Ok(Some(id))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input<'a>(ids: &'a [String], age: bool) -> Input<'a> {
        Input {
            agent_id: "A",
            channel_id: "C",
            thread_root_id: "R",
            source_message_id: "S",
            capped_ids: ids,
            limit: 8,
            age,
        }
    }

    #[test]
    fn golden_loads() {
        let s = sql();
        assert!(s.owner.contains("agent_config"));
        assert!(s.open.contains("chainBackstop"));
        assert!(s.push.contains("'ask'"));
    }

    #[test]
    fn body_like_ts() {
        let ids = vec!["B".to_owned()];
        assert_eq!(
            card_body("b@t", &input(&ids, false)),
            "⏸ 사람 없이 이어진 연쇄가 백스톱(8홉)에 닿아 b＠t 의 부름을 멈췄다. 계속하려면 [계속 — 예산 리셋]을 누른다."
        );
        assert!(card_body("bot", &input(&ids, true)).contains("백스톱(24시간)"));
    }

    #[test]
    fn meta_goes_to_owner() {
        let ids = vec!["B".to_owned(), "B2".to_owned()];
        let m = Value::Object(card_meta(&input(&ids, true), "O"));
        assert_eq!(
            m["ask"]["to"],
            json!({ "kind": "account", "accountId": "O" })
        );
        assert_eq!(m["ask"]["irreversible"], json!(true));
        assert_eq!(
            m["chainBackstop"],
            json!({ "agentId": "A", "sourceMessageId": "S", "cappedIds": ["B", "B2"], "limit": 8, "reason": "age" })
        );
    }
}
