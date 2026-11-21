//! 묶음 카드 한 줄 닫기(S5.3 C4b — MCP `message.askBundleResolve`). TS `services/askBundles.ts` 의 `resolveBundleItem` 과 같은 판정·글자.
//!
//! - 판정(묶음·줄·사람 글·원본)은 읽기 풀로 TS 와 같은 차례로 본다. 여기서 DB 오류면 `Err` — 부르는 쪽이 TS 로 넘긴다(아직 안 썼다).
//! - 원본이 권한 거울 표지·권한 요청 줄의 카드(또는 그 거울)이거나 `mirrorOf` 를 못 읽으면 Rust 는 정하지 않고 TS 로
//!   넘긴다([`Resolved::Handoff`], C3b-1 [`super::ask::hand_answer_to_ts`] 와 같은 닫힌 판정 — 묶음 줄 답하기 C3b-2a 와 같은 경계).
//! - 쓰기(원본 닫기 → `message.updated` → 물어본 쪽 깨움 → 거울·묶음 맞추기)는 **한 트랜잭션**이다. TS 는 줄마다 따로 커밋하지만,
//!   닫기 조건(`answeredWith`·`closedAt` 없음, 권한·머지 거절 카드 아님)은 같은 `update … where` 한 문장이라 경합 결과는 같다.
//! - 쓰기를 시작한 뒤의 오류는 [`Resolved::Failed`] — 부르는 쪽이 고정 `internal` 로 답한다(security W1, TS 로 넘기지 않는다).
use super::ask::{To, js_trim, read_ask_row};
use super::ask_sync::{announce_updated, sync_ask_mirrors, wake_asker};
use super::msg_read::message_by_id;
use serde_json::Value;
use sqlx::{Acquire, PgPool};

const LABEL: &str = "askBundleResolve";

/// TS `AskBundleRefusal` 중 이 길에서 나는 것과 `ASK_BUNDLE_REFUSAL_MESSAGE` 문장.
pub const REFUSALS: &[(&str, &str)] = &[
    ("bundle_not_found", "no such bundle card"),
    (
        "bundle_not_yours",
        "only the agent that posted the bundle can change it",
    ),
    (
        "bundle_item_not_found",
        "that card is not a row of this bundle",
    ),
    (
        "bundle_item_link",
        "a person decides a permission request or merge-denial card on its card or bundle row — an agent cannot close it",
    ),
    (
        "bundle_item_resolved",
        "that row is already answered or closed",
    ),
    (
        "bundle_reply_invalid",
        "replyMessageId must be a human message in this bundle thread, from someone who may answer the card",
    ),
    (
        "mirror_not_found",
        "no such choice request, or you cannot see its channel",
    ),
];

pub fn refusal_message(code: &str) -> &'static str {
    REFUSALS
        .iter()
        .find(|(c, _)| *c == code)
        .map_or("", |(_, m)| m)
}

#[derive(Debug)]
pub enum Resolved {
    /// TS `{ ok: false, code }`.
    Refused(&'static str),
    /// 새로 읽은 묶음 글(TS `getMessageById` 모양 JSON).
    Bundle(String),
    /// 쓰기를 시작한 뒤의 오류.
    Failed,
    /// 원본을 Rust 가 정하지 않는다 — 아직 아무것도 안 썼으니 TS 가 처음부터 답한다.
    Handoff,
}

/// JS 참값(`item.link || …`).
fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(_) => true,
    }
}

/// TS shared `readAskBundleMeta` 의 줄 목록. 못 알아보면 None.
fn bundle_items(meta: &Value) -> Option<&Vec<Value>> {
    if meta.get("kind").and_then(Value::as_str) != Some("askBundle") {
        return None;
    }
    let items = meta.get("askBundle")?.get("items")?.as_array()?;
    items
        .iter()
        .all(|i| {
            i.get("rootId").is_some_and(Value::is_string)
                && i.get("options").is_some_and(Value::is_array)
        })
        .then_some(items)
}

/// 판정까지 — 쓰기 전. `Ok(Err(Refused|Handoff))` 는 거절·넘김, `Ok(Ok(..))` 는 닫을 원본·글쓴이.
async fn check(
    read: &PgPool,
    caller: &str,
    bundle_id: &str,
    root_id: &str,
    reply_id: &str,
) -> sqlx::Result<Result<(String, String), Resolved>> {
    use Resolved::Refused;
    // readBundle
    let row: Option<(Value, String, Option<String>, Option<String>)> = sqlx::query_as(
        "select meta, channel_id::text, thread_root_id::text, author_id::text \
           from message where id = $1::uuid and deleted_at is null",
    )
    .bind(bundle_id)
    .fetch_optional(read)
    .await?;
    let Some((meta, channel, thread_root, author)) = row else {
        return Ok(Err(Refused("bundle_not_found")));
    };
    let Some(items) = bundle_items(&meta) else {
        return Ok(Err(Refused("bundle_not_found")));
    };
    if author.as_deref() != Some(caller) {
        return Ok(Err(Refused("bundle_not_yours")));
    }
    let Some(item) = items
        .iter()
        .find(|i| i.get("rootId").and_then(Value::as_str) == Some(root_id))
    else {
        return Ok(Err(Refused("bundle_item_not_found")));
    };
    // isDecisionCard — 사본의 link 가 아니라 원본 meta 로도 잰다.
    if js_truthy(item.get("link"))
        || {
            let n: Option<i32> = sqlx::query_scalar(
            "select 1 from message where id = $1::uuid and (meta ? 'permissionRequest' or meta ? 'mergeDenial')",
        )
        .bind(root_id)
        .fetch_optional(read)
        .await?;
            n.is_some()
        }
    {
        return Ok(Err(Refused("bundle_item_link")));
    }
    let bundle_root = thread_root.unwrap_or_else(|| bundle_id.to_owned());
    // id 는 DB 에서 읽은 것을 쓴다 — 대문자 uuid 가 와도 TS(`reply.id`)처럼 소문자로 적힌다.
    let reply: Option<(String, String)> = sqlx::query_as(
        "select m.author_id::text, m.id::text from message m join account a on a.id = m.author_id \
          where m.id = $1::uuid and m.deleted_at is null and a.kind = 'human' \
            and m.channel_id = $2::uuid and (m.thread_root_id = $3::uuid or m.id = $3::uuid)",
    )
    .bind(reply_id)
    .bind(&channel)
    .bind(&bundle_root)
    .fetch_optional(read)
    .await?;
    let Some((reply_author, reply_id)) = reply else {
        return Ok(Err(Refused("bundle_reply_invalid")));
    };
    let mut conn = read.acquire().await?;
    let Some((ask, root_channel, _)) = read_ask_row(&mut conn, root_id).await? else {
        return Ok(Err(Refused("mirror_not_found")));
    };
    drop(conn);
    // 읽히는 카드라도 권한 거울 표지·권한 요청 줄의 카드(또는 그 거울)면 Rust 가 닫지 않는다 — C3b-1·C3b-2a 와 같은
    // 닫힌 판정([`super::ask::hand_answer_to_ts`]). 아직 안 썼으니 TS 가 처음부터 답한다. 못 읽는 원본은 위에서 TS 와 같은 거절로
    // 끝났다. 백스톱 원본은 TS 도 보통 길로 닫는다(머지 거절은 위 `isDecisionCard` 로 이미 거절).
    if super::ask::hand_answer_to_ts(read, root_id).await? {
        return Ok(Err(Resolved::Handoff));
    }
    if ask.answered || ask.closed {
        return Ok(Err(Refused("bundle_item_resolved")));
    }
    let may_answer = match &ask.to {
        To::Human => true,
        To::Account(a) => *a == reply_author,
    };
    if !may_answer || !super::channels::visible(read, &reply_author, &root_channel).await? {
        return Ok(Err(Refused("bundle_reply_invalid")));
    }
    Ok(Ok((reply_author, reply_id)))
}

/// TS `resolveBundleItem`. 판정 중 DB 오류는 `Err`(TS 로 넘겨도 된다 — 아직 안 썼다).
pub async fn resolve(
    read: &PgPool,
    write: &PgPool,
    caller: &str,
    bundle_id: &str,
    root_id: &str,
    reply_id: &str,
    note: Option<&str>,
) -> sqlx::Result<Resolved> {
    let (reply_author, reply_id) = match check(read, caller, bundle_id, root_id, reply_id).await? {
        Ok(v) => v,
        Err(r) => return Ok(r),
    };
    // zod 가 1000 UTF-16 단위까지만 받으므로 trim 뒤 slice(0, 1000) 은 늘 그대로다.
    let note = js_trim(note.unwrap_or(""));
    // 여기부터 쓰기다(security W1).
    let written: sqlx::Result<Option<()>> = async {
        let mut conn = write.acquire().await?;
        let mut tx = conn.begin().await?;
        let closed: Option<Option<String>> = sqlx::query_scalar(
            "update message \
                set meta = jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(meta::jsonb, \
                    '{ask,closedAt}', to_jsonb(now())), \
                    '{ask,closedBy}', to_jsonb($2::text)), \
                    '{ask,closedReason}', to_jsonb('replied'::text)), \
                    '{ask,replyMessageId}', to_jsonb($3::text)), \
                    '{ask,replyNote}', to_jsonb($4::text)), \
                    '{ask,replyNoteBy}', to_jsonb($5::text)) \
              where id = $1::uuid \
                and deleted_at is null \
                and meta->'ask'->>'answeredWith' is null \
                and meta->'ask'->>'closedAt' is null \
                and not (meta ? 'permissionRequest') \
                and not (meta ? 'mergeDenial') \
              returning author_id::text",
        )
        .bind(root_id)
        .bind(&reply_author)
        .bind(&reply_id)
        .bind(note)
        .bind(caller)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(asker) = closed else {
            return Ok(None);
        };
        announce_updated(&mut tx, root_id).await?;
        // 원 스레드에는 사람 글이 없으니 thread_reply 로 깨지 않는다 — 여기서 깨운다.
        wake_asker(&mut tx, LABEL, asker.as_deref(), &reply_author, root_id, "ask_closed").await;
        sync_ask_mirrors(&mut tx, LABEL, root_id).await?;
        tx.commit().await?;
        Ok(Some(()))
    }
    .await;
    match written {
        Err(_) => return Ok(Resolved::Failed),
        Ok(None) => return Ok(Resolved::Refused("bundle_item_resolved")),
        Ok(Some(_)) => {}
    }
    // 커밋 뒤 다시 읽기 — 실패해도 쓰기는 끝났으니 TS 로 넘기지 않는다.
    Ok(match message_by_id(read, bundle_id).await {
        Ok(Some(row)) => Resolved::Bundle(row),
        Ok(None) => Resolved::Refused("bundle_not_found"),
        Err(_) => Resolved::Failed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn bundle_meta_like_read_ask_bundle_meta() {
        let ok = json!({"kind":"askBundle","askBundle":{"items":[{"rootId":"a","options":[]}]}});
        assert_eq!(bundle_items(&ok).map(Vec::len), Some(1));
        for bad in [
            json!({"kind":"ask","askBundle":{"items":[]}}),
            json!({"kind":"askBundle"}),
            json!({"kind":"askBundle","askBundle":{"items":{}}}),
            json!({"kind":"askBundle","askBundle":{"items":[{"rootId":1,"options":[]}]}}),
            json!({"kind":"askBundle","askBundle":{"items":[{"rootId":"a"}]}}),
        ] {
            assert!(bundle_items(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn link_is_js_truthy() {
        for (v, want) in [
            (None, false),
            (Some(json!(null)), false),
            (Some(json!(false)), false),
            (Some(json!("")), false),
            (Some(json!(0)), false),
            (Some(json!("x")), true),
            (Some(json!({})), true),
            (Some(json!([])), true),
            (Some(json!(1)), true),
        ] {
            assert_eq!(js_truthy(v.as_ref()), want, "{v:?}");
        }
    }
}
