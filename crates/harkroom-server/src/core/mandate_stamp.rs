//! S5.3 C1c-2a — 사람이 세션으로 쓴 **새 스레드 머리**의 위임(TS `services/mandates.ts::stampHumanMandate` 의 `threadRootId` 없는
//! 갈래)과 그 갈래가 부르는 `deciders.ts::mayDecideFor`. 답글 갈래(머리의 위임 잇기·`mandateForKeylessRoot`)는 C1c-3a 의
//! [`stamp_reply`] 다.
//!
//! - 받은 계정(`notified`) 중 작성자 소유 에이전트가 있으면 주인 = 작성자. 없으면 받은 에이전트 중 이 사람이 이 채널에서 카드를
//!   **정할 수 있는**(소유자 아님) 첫 에이전트의 소유자가 주인, 작성자는 맡긴 사람이다(C-3). 둘 다 아니면 위임이 없다.
//! - 문장은 전부 TS 상수를 골든으로 받는다(`mandate_*`·`message_set_mandate`·`decider_*`). 호출자의 트랜잭션 안에서 돈다.
//! - 새로 만든 위임은 [`Created`] 로 돌려준다 — 호출자가 **커밋 뒤** `mandate.created` 감사로 남긴다(TS `auditMandateCreated`).
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use std::sync::OnceLock;

struct Sql {
    own: String,
    root_insert: String,
    set_mandate: String,
    delegated: String,
    decider_row: String,
    decider_seen: String,
    decider_list: String,
    decider_channel: String,
    reply_continue: String,
    keyless_own: String,
    keyless_root: String,
    keyless_touch: String,
    keyless_insert: String,
    keyless_find: String,
    keyless_root_set: String,
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
            own: frag("mandate_own_agent"),
            root_insert: format!(
                "with r as ({}) select r.id::text, r.inserted from r",
                frag("mandate_root_insert")
            ),
            set_mandate: frag("message_set_mandate"),
            delegated: format!(
                "select d.id::text from ({}) d",
                frag("mandate_delegated_agents")
            ),
            decider_row: format!(
                "select d.\"ownerAccountId\"::text, d.scope, d.\"userDecide\", d.\"agentOff\", d.\"actorKind\", d.\"actorRole\", \
                 d.\"actorOff\" from ({}) d",
                frag("decider_row")
            ),
            decider_seen: frag("decider_seen"),
            decider_list: frag("decider_list"),
            decider_channel: frag("decider_channel"),
            // 고치는 문장의 `returning id`(uuid)는 글자로 받으려고 감싼다(데이터를 고치는 with 는 맨 위에서만 된다 — 여기가 맨 위다).
            reply_continue: format!(
                "with r as ({}) select r.id::text from r",
                frag("mandate_reply_continue")
            ),
            keyless_own: frag("mandate_keyless_own"),
            keyless_root: format!(
                "with r as ({}) select r.\"mandateId\"::text, r.\"ownAuthor\" from r",
                frag("mandate_keyless_root")
            ),
            keyless_touch: format!(
                "with r as ({}) select r.id::text from r",
                frag("mandate_keyless_touch")
            ),
            keyless_insert: format!(
                "with r as ({}) select r.id::text from r",
                frag("mandate_keyless_insert")
            ),
            keyless_find: format!(
                "select r.id::text from ({}) r",
                frag("mandate_keyless_find")
            ),
            keyless_root_set: frag("mandate_keyless_root_set"),
        }
    })
}

/// 새로 만든 위임 — TS `MandateCreated`(via 'root' 새 머리 · 'owner_reply' 키 없는 머리에 주인이 답함).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Created {
    pub mandate_id: String,
    pub owner_id: String,
    pub root_message_id: String,
    pub channel_id: String,
    pub delegator_id: Option<String>,
    pub via: &'static str,
}

impl Created {
    /// TS `auditMandateCreated` 의 `detail`(jsonb 칸이라 키 순서는 저장에서 없어진다).
    pub fn audit_detail(&self) -> Value {
        let mut d = Map::new();
        d.insert("mandateId".into(), json!(self.mandate_id));
        d.insert("rootMessageId".into(), json!(self.root_message_id));
        d.insert("channelId".into(), json!(self.channel_id));
        d.insert("threadRootId".into(), json!(self.root_message_id));
        d.insert("via".into(), json!(self.via));
        if let Some(del) = &self.delegator_id {
            d.insert("ownerId".into(), json!(self.owner_id));
            d.insert("delegatorId".into(), json!(del));
        }
        Value::Object(d)
    }

    pub fn actor_id(&self) -> &str {
        self.delegator_id.as_deref().unwrap_or(&self.owner_id)
    }
}

type DeciderRow = (
    Option<String>,
    String,
    bool,
    bool,
    Option<String>,
    Option<String>,
    Option<bool>,
);

/// TS `mayDecideFor` 중 위임이 보는 것 — 정할 수 있고 소유자가 **아니면** 그 소유자를 돌려준다(`v.ok && !v.asOwner && v.ownerAccountId`).
async fn decides_as_user(
    conn: &mut PgConnection,
    agent: &str,
    actor: &str,
    channel: &str,
) -> Result<Option<String>, sqlx::Error> {
    let s = sql();
    let row: Option<DeciderRow> = sqlx::query_as(s.decider_row.as_str())
        .bind(agent)
        .bind(actor)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((owner, scope, user_decide, agent_off, actor_kind, actor_role, actor_off)) = row
    else {
        return Ok(None);
    };
    if actor_kind.as_deref() != Some("human") || actor_off != Some(false) {
        return Ok(None);
    }
    if owner.as_deref() == Some(actor) {
        return Ok(None);
    }
    if !user_decide || agent_off || actor_role.as_deref() == Some("guest") {
        return Ok(None);
    }
    let seen: Option<Option<bool>> = sqlx::query_scalar(s.decider_seen.as_str())
        .bind(channel)
        .bind(actor)
        .fetch_optional(&mut *conn)
        .await?;
    if seen.flatten() != Some(true) {
        return Ok(None);
    }
    let passes = match scope.as_str() {
        "community" => true,
        "list" => sqlx::query(s.decider_list.as_str())
            .bind(agent)
            .bind(actor)
            .fetch_optional(&mut *conn)
            .await?
            .is_some(),
        "channel" => sqlx::query(s.decider_channel.as_str())
            .bind(channel)
            .bind(actor)
            .fetch_optional(&mut *conn)
            .await?
            .is_some(),
        _ => false,
    };
    Ok(if passes { owner } else { None })
}

/// TS `stampHumanMandate` 의 새 머리 갈래. `notified` 는 넣은 순서 그대로(TS `[...notified]`).
pub async fn stamp_root(
    conn: &mut PgConnection,
    message_id: &str,
    author: &str,
    channel: &str,
    notified: &[String],
) -> Result<Option<Created>, sqlx::Error> {
    if notified.is_empty() {
        return Ok(None);
    }
    let s = sql();
    let own = sqlx::query(s.own.as_str())
        .bind(notified)
        .bind(author)
        .fetch_optional(&mut *conn)
        .await?
        .is_some();
    let owner = if own {
        Some(author.to_owned())
    } else {
        let agents: Vec<String> = sqlx::query_scalar(s.delegated.as_str())
            .bind(notified)
            .fetch_all(&mut *conn)
            .await?;
        let mut found = None;
        for a in &agents {
            if let Some(o) = decides_as_user(conn, a, author, channel).await? {
                found = Some(o);
                break;
            }
        }
        found
    };
    let Some(owner) = owner else { return Ok(None) };
    let (mandate_id, inserted): (String, bool) = sqlx::query_as(s.root_insert.as_str())
        .bind(&owner)
        .bind(message_id)
        .bind(channel)
        .bind(super::operator_hub::now_iso())
        .bind(author)
        .fetch_one(&mut *conn)
        .await?;
    sqlx::query(s.set_mandate.as_str())
        .bind(message_id)
        .bind(&mandate_id)
        .execute(&mut *conn)
        .await?;
    Ok(inserted.then(|| Created {
        delegator_id: (owner != author).then(|| author.to_owned()),
        mandate_id,
        owner_id: owner,
        root_message_id: message_id.to_owned(),
        channel_id: channel.to_owned(),
        via: "root",
    }))
}

/// TS `stampHumanMandate` 의 답글 갈래. 머리의 위임을 그 주인·맡긴 사람이 답하면 잇고, 없으면 [`keyless_root`].
/// 돌려주는 것은 (이 글에 적은 위임 id, 새로 만든 위임).
pub async fn stamp_reply(
    conn: &mut PgConnection,
    message_id: &str,
    author: &str,
    channel: &str,
    root_id: &str,
    notified: &[String],
) -> Result<Option<Created>, sqlx::Error> {
    let s = sql();
    let now = super::operator_hub::now_iso();
    let mut created = None;
    let mut mandate: Option<String> = sqlx::query_scalar(s.reply_continue.as_str())
        .bind(root_id)
        .bind(author)
        .bind(&now)
        .fetch_optional(&mut *conn)
        .await?;
    if mandate.is_none() {
        (mandate, created) = keyless_root(conn, author, channel, root_id, notified, &now).await?;
    }
    let Some(mandate) = mandate else {
        return Ok(None);
    };
    sqlx::query(s.set_mandate.as_str())
        .bind(message_id)
        .bind(&mandate)
        .execute(&mut *conn)
        .await?;
    Ok(created)
}

/// TS `mandateForKeylessRoot` — 위임 키가 없는 머리(키 이전 글·자기 에이전트를 안 부른 머리)에 주인이 자기 에이전트를 부르며 답하면
/// 머리를 뿌리로 위임을 만든다. 머리 행을 잠가 같은 머리의 동시 답글을 줄 세운다.
async fn keyless_root(
    conn: &mut PgConnection,
    author: &str,
    channel: &str,
    root_id: &str,
    notified: &[String],
    now: &str,
) -> Result<(Option<String>, Option<Created>), sqlx::Error> {
    if notified.is_empty() {
        return Ok((None, None));
    }
    let s = sql();
    let own = sqlx::query(s.keyless_own.as_str())
        .bind(notified)
        .bind(author)
        .fetch_optional(&mut *conn)
        .await?
        .is_some();
    if !own {
        return Ok((None, None));
    }
    let root: Option<(Option<String>, Option<bool>)> = sqlx::query_as(s.keyless_root.as_str())
        .bind(root_id)
        .bind(channel)
        .bind(author)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((root_mandate, Some(true))) = root else {
        return Ok((None, None));
    };
    if let Some(m) = root_mandate {
        let id: Option<String> = sqlx::query_scalar(s.keyless_touch.as_str())
            .bind(&m)
            .bind(author)
            .bind(now)
            .fetch_optional(&mut *conn)
            .await?;
        return Ok((id, None));
    }
    let inserted: Option<String> = sqlx::query_scalar(s.keyless_insert.as_str())
        .bind(author)
        .bind(root_id)
        .bind(channel)
        .bind(now)
        .fetch_optional(&mut *conn)
        .await?;
    let made: Option<String> = sqlx::query_scalar(s.keyless_find.as_str())
        .bind(root_id)
        .bind(author)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(made) = made else {
        return Ok((None, None));
    };
    let created = (inserted.as_deref() == Some(made.as_str())).then(|| Created {
        mandate_id: made.clone(),
        owner_id: author.to_owned(),
        root_message_id: root_id.to_owned(),
        channel_id: channel.to_owned(),
        delegator_id: None,
        via: "owner_reply",
    });
    sqlx::query(s.keyless_root_set.as_str())
        .bind(root_id)
        .bind(&made)
        .execute(&mut *conn)
        .await?;
    Ok((Some(made), created))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_loads() {
        let s = sql();
        assert!(s.root_insert.contains("insert into mandate"));
        assert!(s.decider_seen.contains("$2::uuid"));
    }

    #[test]
    fn audit_detail_like_ts() {
        let mut c = Created {
            mandate_id: "m".into(),
            owner_id: "o".into(),
            root_message_id: "r".into(),
            channel_id: "c".into(),
            delegator_id: None,
            via: "root",
        };
        assert_eq!(
            c.audit_detail(),
            json!({"mandateId":"m","rootMessageId":"r","channelId":"c","threadRootId":"r","via":"root"})
        );
        assert_eq!(c.actor_id(), "o");
        c.delegator_id = Some("d".into());
        assert_eq!(
            c.audit_detail(),
            json!({"mandateId":"m","rootMessageId":"r","channelId":"c","threadRootId":"r","via":"root","ownerId":"o","delegatorId":"d"})
        );
        assert_eq!(c.actor_id(), "d");
    }
}
