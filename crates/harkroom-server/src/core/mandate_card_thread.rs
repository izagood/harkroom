//! S5.3 C2 — [이 스레드로 위임장 만들고 더하기](`approve_new_mandate`)의 위임장 세우기(TS `mandateForCardThread`).
//!
//! 승인 tx(요청 줄을 잠근 뒤, 잠금 순서 6단계 다음) 안에서 부른다(P3 B4a — 소유자가 아닌 사람이면 맡긴 사람으로). 순서:
//! 7. 카드 스레드의 **머리 글을 `for update of m`** 으로 잠근다 — 이 채널의 지워지지 않은 글이고, 자동화 글이 아니며, 소유자 본인이나
//!    그 소유자의 에이전트가 쓴 글이어야 한다(W1 불변식: 위임 키는 그런 글에만). 아니면 `None`(→ `mandate_unavailable`).
//! 8. 머리에 위임장이 있으면 그것이 지금 유효하고(`grant_valid_mandate_owner`) 주인·맡긴 사람이 같을 때만 활동 시각을 밀어 잇는다.
//!    없으면 위임장을 upsert(`root_message_id` 충돌이면 활동만 민다)하고 주인·맡긴 사람·끝남을 대조한 뒤 머리 글에 키를 적는다.
//!
//! 새로 만든 위임장은 [`Made::inserted`] 로 돌려준다 — 호출자가 같은 tx 에 `mandate.created` 감사를 쓴다(TS 는 커밋 뒤에 쓰고 실패를 삼킨다).
//! 문장은 모두 TS 상수의 골든이다(`packages/server/test/rustSqlFragments.test.ts`).
use super::channels::frag;
use serde_json::{Value, json};
use sqlx::PgConnection;

/// TS `MANDATE_IDLE_MS`(7일).
const MANDATE_IDLE: &str = "7 days";

struct Sql {
    root: String,
    delegator: String,
    touch: &'static str,
    insert: String,
    root_stamp: &'static str,
    valid_owner: String,
}

fn sql() -> &'static Sql {
    static S: std::sync::OnceLock<Sql> = std::sync::OnceLock::new();
    S.get_or_init(|| Sql {
        // 머리 글 잠금(`for update of m`)은 FROM 안 하위 질의에서도 그대로 걸린다.
        root: format!(
            "select t.\"mandateId\"::text, t.\"ownAuthor\" from ({}) t",
            frag("card_thread_root")
        ),
        delegator: format!(
            "select t.delegator::text from ({}) t",
            frag("card_thread_delegator")
        ),
        touch: frag("card_thread_touch"),
        insert: format!(
            "with t as ({}) select t.id::text, t.owner::text, t.delegator::text, t.ended, t.inserted from t",
            frag("card_thread_insert")
        ),
        root_stamp: frag("card_thread_root_stamp"),
        valid_owner: format!(
            "select t.owner::text from ({}) t",
            frag("grant_valid_mandate_owner")
        ),
    })
}

/// P3 B4a — 위임장을 맡긴 사람(`coalesce(delegator, owner)`, TS `decidePermissionRequest` 의 C-3 대조와 같은 문장 골든).
pub async fn mandate_delegator(
    conn: &mut PgConnection,
    mandate_id: &str,
) -> sqlx::Result<Option<String>> {
    sqlx::query_scalar(sql().delegator.as_str())
        .bind(mandate_id)
        .fetch_optional(conn)
        .await
}

/// 요청 줄·카드 글에 키를 적는 문장(TS `NEW_MANDATE_REQUEST_SQL`·`NEW_MANDATE_CARD_SQL` 골든).
pub fn request_stamp_sql() -> &'static str {
    frag("new_mandate_request")
}
pub fn card_stamp_sql() -> &'static str {
    frag("new_mandate_card")
}

/// `mandate.created` 감사(TS `auditMandateCreated` — actor 는 맡긴 사람, 여기서는 소유자 본인).
pub const MANDATE_CREATED_AUDIT: &str = "insert into audit_log (action, actor_id, target, detail) \
     values ('mandate.created', $1::uuid, $2, $3::jsonb)";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Made {
    pub mandate_id: String,
    pub inserted: bool,
    /// P3 B4a — 소유자가 아닌 사람이 맡겨 세웠으면 (주인, 맡긴 사람). 소유자 본인이면 `None`.
    pub delegated: Option<(String, String)>,
}

impl Made {
    /// TS `auditMandateCreated` 의 detail — 소유자가 아닌 사람이 세웠을 때만 `ownerId`·`delegatorId` 칸이 붙는다.
    pub fn audit_detail(&self, channel_id: &str, thread_root_id: &str) -> Value {
        let mut d = json!({
            "mandateId": self.mandate_id, "rootMessageId": thread_root_id, "channelId": channel_id,
            "threadRootId": thread_root_id, "via": "card",
        });
        if let Some((owner, delegator)) = &self.delegated {
            d["ownerId"] = json!(owner);
            d["delegatorId"] = json!(delegator);
        }
        d
    }
}

/// 카드 스레드에 위임장을 세우거나 잇는다(TS `mandateForCardThread`). `owner_id` 는 에이전트 소유자, `delegator_id` 는 승인한 사람
/// (소유자 본인이면 같다). P3 B4a — 소유자가 아닌 사람이 세우면 머리 글은 **그 사람 본인의 글**이어야 하고(C-3, `$5` 거짓), 머리에
/// 있던 위임장도 맡긴 사람이 같아야 잇는다. `now` 는 결정 시각(`timestamptz` 문자열).
pub async fn mandate_for_card_thread(
    conn: &mut PgConnection,
    owner_id: &str,
    delegator_id: &str,
    channel_id: &str,
    thread_root_id: &str,
    now: &str,
) -> sqlx::Result<Option<Made>> {
    let s = sql();
    let by_owner = delegator_id == owner_id;
    let root: Option<(Option<String>, bool)> = sqlx::query_as(s.root.as_str())
        .bind(thread_root_id)
        .bind(channel_id)
        .bind(owner_id)
        .bind(delegator_id)
        .bind(by_owner)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((root_mandate, own_author)) = root else {
        return Ok(None);
    };
    if !own_author {
        return Ok(None);
    }
    if let Some(m) = root_mandate {
        let cutoff: String = sqlx::query_scalar("select ($1::timestamptz - $2::interval)::text")
            .bind(now)
            .bind(MANDATE_IDLE)
            .fetch_one(&mut *conn)
            .await?;
        let owner: Option<String> = sqlx::query_scalar(s.valid_owner.as_str())
            .bind(&m)
            .bind(&cutoff)
            .fetch_optional(&mut *conn)
            .await?;
        if owner.as_deref() != Some(owner_id) {
            return Ok(None);
        }
        let d: Option<String> = sqlx::query_scalar(s.delegator.as_str())
            .bind(&m)
            .fetch_optional(&mut *conn)
            .await?;
        if d.as_deref() != Some(delegator_id) {
            return Ok(None);
        }
        sqlx::query(s.touch)
            .bind(&m)
            .bind(now)
            .execute(&mut *conn)
            .await?;
        return Ok(Some(Made {
            mandate_id: m,
            inserted: false,
            delegated: None,
        }));
    }
    let (id, owner, delegator, ended, inserted): (String, String, String, bool, bool) =
        sqlx::query_as(s.insert.as_str())
            .bind(owner_id)
            .bind(thread_root_id)
            .bind(channel_id)
            .bind(now)
            .bind(delegator_id)
            .fetch_one(&mut *conn)
            .await?;
    if owner != owner_id || delegator != delegator_id || ended {
        return Ok(None);
    }
    sqlx::query(s.root_stamp)
        .bind(thread_root_id)
        .bind(&id)
        .execute(&mut *conn)
        .await?;
    Ok(Some(Made {
        mandate_id: id,
        inserted,
        delegated: (!by_owner).then(|| (owner_id.to_owned(), delegator_id.to_owned())),
    }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn audit_keys_follow_ts() {
        let m = super::Made {
            mandate_id: "m".into(),
            inserted: true,
            delegated: None,
        };
        let d = m.audit_detail("c", "r");
        let mut keys: Vec<_> = d.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(
            keys,
            [
                "channelId",
                "mandateId",
                "rootMessageId",
                "threadRootId",
                "via"
            ]
        );
    }

    #[test]
    fn delegated_audit_adds_owner_and_delegator() {
        let m = super::Made {
            mandate_id: "m".into(),
            inserted: true,
            delegated: Some(("o".into(), "u".into())),
        };
        let d = m.audit_detail("c", "r");
        assert_eq!(d["ownerId"], "o");
        assert_eq!(d["delegatorId"], "u");
        assert_eq!(d.as_object().unwrap().len(), 7);
    }
}
