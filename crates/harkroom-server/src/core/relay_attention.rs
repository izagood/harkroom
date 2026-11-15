//! S5.3 C6c-3 — 릴레이 허브가 내는 관문 알림을 이벤트로(TS `agentRelayRoutes.ts` 의 `onAttention`·`onAttentionCleared`).
//!
//! - 허브는 세션 좌표만 준다. 소유자(`agent_config.owner_account_id`)와 handle 은 여기서 붙인다.
//! - **소유자에게만 간다**(`audience: [owner]`). 소유자를 모르면 조용히 버린다 — 전원에게 뿌리지 않는다.
//! - 이벤트는 outbox 한 줄(자동 커밋)로 나간다. 실패는 로그(종류만)로 끝낸다 — 알림 하나로 릴레이를 흔들지 않는다.
//! - presence 가 되살아났을 때의 `presence.changed online`(TS `mark` 의 online 전환)도 같은 길로 낸다.
use super::relay::{Attention, AttentionHook};
use super::relay_live::OnlineHook;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::sync::Arc;

/// 이벤트 본문. `owner`·`handle` 은 조회한 값(cleared 는 handle 을 싣지 않는다 — TS 와 같다).
pub fn attention_event(a: &Attention, owner: &str, handle: &str) -> Value {
    match a {
        Attention::Raised {
            session_id,
            channel_id,
            thread_root_id,
            agent_account_id,
            claude_pool_rank,
            claude_account_rank,
        } => {
            let mut m = Map::new();
            m.insert("type".into(), json!("agent.attention"));
            m.insert("sessionId".into(), json!(session_id));
            m.insert("channelId".into(), json!(channel_id));
            m.insert("threadRootId".into(), json!(thread_root_id));
            m.insert("agentAccountId".into(), json!(agent_account_id));
            m.insert("agentHandle".into(), json!(handle));
            if let Some(r) = claude_pool_rank {
                m.insert("claudePoolRank".into(), json!(r));
            }
            if let Some(r) = claude_account_rank {
                m.insert("claudeAccountRank".into(), json!(r));
            }
            m.insert("audience".into(), json!([owner]));
            Value::Object(m)
        }
        Attention::Cleared {
            session_id,
            channel_id,
            thread_root_id,
            agent_account_id,
        } => json!({
            "type": "agent.attention.cleared",
            "sessionId": session_id,
            "channelId": channel_id,
            "threadRootId": thread_root_id,
            "agentAccountId": agent_account_id,
            "audience": [owner],
        }),
    }
}

fn agent_of(a: &Attention) -> &str {
    match a {
        Attention::Raised {
            agent_account_id, ..
        }
        | Attention::Cleared {
            agent_account_id, ..
        } => agent_account_id,
    }
}

/// 소유자를 찾아 이벤트를 낸다. 소유자를 모르면(설정 없음·uuid 아님) 아무것도 안 낸다 — `Ok(false)`.
pub async fn emit_attention(
    read: &PgPool,
    write: &PgPool,
    a: &Attention,
) -> Result<bool, sqlx::Error> {
    let agent = agent_of(a);
    if !super::msg_read::is_uuid(agent) {
        return Ok(false);
    }
    let row: Option<(String, String)> = sqlx::query_as(
        "select c.owner_account_id::text, a.handle
           from agent_config c join account a on a.id = c.account_id
          where c.account_id = $1::uuid",
    )
    .bind(agent)
    .fetch_optional(read)
    .await?;
    let Some((owner, handle)) = row else {
        return Ok(false);
    };
    let mut conn = write.acquire().await?;
    crate::write::emit_event(&mut conn, &attention_event(a, &owner, &handle)).await?;
    Ok(true)
}

/// 허브의 관문 훅 — 기다리지 않는다(띄운다).
pub fn attention_hook(read: PgPool, write: PgPool) -> AttentionHook {
    Arc::new(move |a: Attention| {
        let (read, write) = (read.clone(), write.clone());
        tokio::spawn(async move {
            if let Err(e) = emit_attention(&read, &write, &a).await {
                eprintln!(
                    "front: relay attention event failed ({})",
                    e.as_database_error().map_or("io", |_| "db")
                );
            }
        });
    })
}

/// presence 가 만료(또는 처음)에서 살아났을 때, 스윕이 만료를 찾았을 때 — TS `presence.changed { online }`.
pub fn online_hook(write: PgPool) -> OnlineHook {
    Arc::new(move |agent: &str, online: bool| {
        let write = write.clone();
        let ev = json!({ "type": "presence.changed", "accountId": agent, "online": online });
        tokio::spawn(async move {
            let r = async {
                let mut conn = write.acquire().await?;
                crate::write::emit_event(&mut conn, &ev).await
            };
            if let Err(e) = r.await {
                eprintln!(
                    "front: relay presence event failed ({})",
                    e.as_database_error().map_or("io", |_| "db")
                );
            }
        });
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raised_matches_ts_shape() {
        let a = Attention::Raised {
            session_id: "s1".into(),
            channel_id: "c".into(),
            thread_root_id: None,
            agent_account_id: "ag".into(),
            claude_pool_rank: Some(2),
            claude_account_rank: Some(None),
        };
        assert_eq!(
            attention_event(&a, "own", "bot"),
            json!({
                "type": "agent.attention", "sessionId": "s1", "channelId": "c", "threadRootId": null,
                "agentAccountId": "ag", "agentHandle": "bot", "claudePoolRank": 2, "claudeAccountRank": null,
                "audience": ["own"],
            })
        );
        // 안 실린 순위는 칸이 없다(TS 의 조건부 펼침).
        let b = Attention::Raised {
            session_id: "s1".into(),
            channel_id: "c".into(),
            thread_root_id: Some("t".into()),
            agent_account_id: "ag".into(),
            claude_pool_rank: None,
            claude_account_rank: None,
        };
        let e = attention_event(&b, "own", "bot");
        assert!(e.get("claudePoolRank").is_none() && e.get("claudeAccountRank").is_none());
    }

    #[test]
    fn cleared_goes_to_owner_only_without_handle() {
        let a = Attention::Cleared {
            session_id: "s1".into(),
            channel_id: "c".into(),
            thread_root_id: Some("t".into()),
            agent_account_id: "ag".into(),
        };
        let e = attention_event(&a, "own", "bot");
        assert_eq!(e["type"], "agent.attention.cleared");
        assert_eq!(e["audience"], json!(["own"]));
        assert!(e.get("agentHandle").is_none());
    }
}
