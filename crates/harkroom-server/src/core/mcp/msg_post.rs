//! S5.3 C1c-4c — MCP `message.post` 의 몸통. TS `mcp/mcpPlugin.ts` 의 같은 도구를 옮긴다: 채널 가시성 → 모델 신고 meta →
//! `postMessage`(원인 입력과 함께, [`crate::core::msg_post::post_in_tx`]) → `postedResult`.
//!
//! - **TS 로 넘기는 것**(`None` — 아무것도 쓰지 않았다): zod 가 받지 않을 인자(모양을 모르면 넘긴다) · `agentModels`(모델 지정은
//!   `applyAgentPicks`, TS 몫) · ASCII 밖 모델 신고(JS `trim`·UTF-16 자르기를 그대로 맞추지 않는다) · `post_in_tx` 가 TS 몫이라고 한
//!   글(상한에 막힌 부름·암묵 위임을 모르는 부름·TS 몫 스레드) · DB 오류(트랜잭션이 버려져 아무것도 남지 않았다 — TS 가 같은 요청을 다시 돈다).
//! - REST 와 다른 점(TS 와 같다): 보관된 채널도 막지 않는다(`assertChannelVisible` 만) · 링크 미리보기·글 승인이 없어 본문 가드가
//!   없다 — 그래서 메시지 링크가 든 글도 Rust 가 맡고, 정체 판정의 「같은 대화 링크」 갈래가 여기서 닿는다 · 재시도 키가 없다 ·
//!   본문 공백 거절(refine)이 없다(`min(1)` 만).
//! - 원인: `cause`(모양만 본 헤더)는 깊이에, 사슬 고리·principal·위임·`meta.turnId` 는 **오퍼레이터를 거친 요청**의 헤더만(TS
//!   `chainCause`·`storedTurnId`).
use super::tools::err;
use crate::auth::Account;
use crate::core::audience::audience_for;
use crate::core::cause_link;
use crate::core::msg_edit::MAX_MESSAGE_BODY_CHARS;
use crate::core::msg_post::{self, Origin, Outcome, PostBody, PostState};
use crate::core::msg_read::{channel_visible, is_uuid};
use serde_json::{Map, Value};

/// zod `attachmentIds.max(10)`.
const MAX_ATTACHMENTS: usize = 10;

/// TS `BAD_THREAD_MESSAGE`.
const BAD_THREAD: &str = "threadRootId must be a top-level message in this channel";

/// zod 가 받는 인자. 모르는 키는 zod 처럼 버린다.
#[derive(Debug, PartialEq, Eq)]
struct Args {
    channel: String,
    post: PostBody,
    /// 다듬은 모델 신고(빈 값이면 없음).
    model: Option<String>,
}

/// zod `inputSchema` 를 그대로 받는 인자만 `Some`. 틀린 꼴·`agentModels`·ASCII 밖 모델은 `None`(→ TS 가 검증 오류나 그 갈래를 낸다).
fn parse(args: &Value) -> Option<Args> {
    let Value::Object(o) = args else { return None };
    if o.contains_key("agentModels") {
        return None;
    }
    let channel = o
        .get("channelId")?
        .as_str()
        .filter(|s| is_uuid(s))?
        .to_owned();
    let body = o.get("body")?.as_str()?;
    let n = body.encode_utf16().count();
    if n == 0 || n > MAX_MESSAGE_BODY_CHARS {
        return None;
    }
    let thread_root = match o.get("threadRootId") {
        None => None,
        Some(Value::String(r)) if is_uuid(r) => Some(r.clone()),
        _ => return None,
    };
    let also = match o.get("alsoInChannel") {
        None => false,
        Some(Value::Bool(b)) => *b,
        _ => return None,
    };
    let attachment_ids = match o.get("attachmentIds") {
        None => vec![],
        Some(Value::Array(a)) if a.len() <= MAX_ATTACHMENTS => {
            let mut ids = Vec::with_capacity(a.len());
            for x in a {
                ids.push(x.as_str().filter(|s| is_uuid(s))?.to_owned());
            }
            ids
        }
        _ => return None,
    };
    let model = match o.get("model") {
        None => None,
        Some(Value::String(m)) => {
            let n = m.encode_utf16().count();
            if n == 0 || n > cause_link::MODEL_ID_MAX {
                return None;
            }
            cause_link::trimmed_model(m)?
        }
        _ => return None,
    };
    Some(Args {
        channel,
        post: PostBody {
            body: body.to_owned(),
            attachment_ids,
            // TS `postMessage` — 머리가 없으면 false.
            also_in_channel: also && thread_root.is_some(),
            thread_root,
        },
        model,
    })
}

/// TS `postedResult` — 못 부른 이름을 앞세운다(상한에 막힌 부름 → 호출 범위 밖 순서).
fn posted_result(row: &str, notified: &[String]) -> Option<String> {
    let v: Value = serde_json::from_str(row).ok()?;
    let handles = |key: &str| -> Vec<String> {
        v.pointer(key)
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(|h| format!("@{h}"))
                    .collect()
            })
            .unwrap_or_default()
    };
    let capped = handles("/meta/mentionChainCapped");
    let mut warnings: Vec<String> = Vec::new();
    // TS `postedResult` — 상한에 막힌 부름이 먼저(C1c-4d-2 부터 Rust 가 맡는다). 백스톱 카드는 서버가 세웠다.
    if !capped.is_empty() {
        let why = if v
            .pointer("/meta/mentionChainReason")
            .and_then(Value::as_str)
            == Some("age")
        {
            "사람 손길 뒤 24시간이 지났다".to_owned()
        } else {
            // TS `String(meta.mentionChainLimit)` — 숫자 그대로(없으면 undefined).
            let limit = match v.pointer("/meta/mentionChainLimit") {
                Some(Value::Number(n)) => n.to_string(),
                Some(Value::String(t)) => t.clone(),
                None => "undefined".to_owned(),
                Some(other) => other.to_string(),
            };
            format!("멘션 연쇄 상한 {limit} 홉에 닿았다")
        };
        warnings.push(format!(
            "{} 를 부르지 못했다: {why} (사람 없이 에이전트끼리 이어진 부름이 너무 길다). 서버가 네 소유자에게 [계속 — 예산 리셋]/[멈춤] 카드를 세웠다 — 따로 message.ask 를 세우지 말고 지금 아는 것을 정리한 뒤 턴을 끝내라. 「계속」이면 다시 깨어난다.",
            capped.join(", ")
        ));
    }
    let denied = handles("/meta/mentionDenied");
    // 행 글자는 그대로 싣는다 — 키 순서가 TS `JSON.stringify(row)` 와 같다(REST 응답과 같은 글자).
    let notified = Value::from(notified.to_vec()).to_string();
    if !denied.is_empty() {
        warnings.push(format!(
            "{} 를 부르지 못했다: 너는 그 에이전트의 호출 범위(invokeScope) 밖이다. 사람에게 message.ask 로 넘기거나 소유자에게 호출 범위를 물어라.",
            denied.join(", ")
        ));
    }
    let inner = if warnings.is_empty() {
        format!("{{\"message\":{row},\"notified\":{notified}}}")
    } else {
        format!(
            "{{\"warnings\":{},\"message\":{row},\"notified\":{notified}}}",
            Value::from(warnings)
        )
    };
    Some(super::respond::text_result(&super::respond::minify(&inner)))
}

/// `message.post`. `operator` 는 이 요청이 오퍼레이터를 거쳤는가(TS `operatorId`).
pub async fn answer(
    st: &PostState,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    let a = parse(args)?;
    match channel_visible(&st.read, &me.id, &a.channel).await {
        Ok(true) => {}
        Ok(false) => return Some(err("forbidden", "not a member of this dm channel")),
        Err(_) => return None,
    }
    let mut meta = Map::new();
    cause_link::reported_model_meta(
        &st.read,
        &me.id,
        a.model.as_deref(),
        a.post.thread_root.as_deref(),
        &mut meta,
    )
    .await
    .ok()?;
    let is_dm = msg_post::channel_is_dm(&st.read, &a.channel).await.ok()?;
    let audience = audience_for(&st.read, &a.channel).await.ok()?.to_json();
    let origin = Origin {
        cause,
        chain_cause: cause.filter(|_| operator),
        turn_id: turn.filter(|_| operator),
        meta,
        server_notice: false,
    };
    let out = msg_post::post_in_tx(
        st,
        &a.channel,
        &me.id,
        me.kind == "agent",
        &a.post,
        None,
        &audience,
        is_dm,
        &origin,
    )
    .await
    .ok()?;
    match out {
        Outcome::ToTs | Outcome::Replayed(_) => None,
        Outcome::BadThread => Some(err("bad_thread", BAD_THREAD)),
        Outcome::BadAttachment => Some(err(
            "bad_attachment",
            "attachments must be your own, unused uploads",
        )),
        // 에이전트 글은 새 위임을 만들지 않는다(`mandate` 는 사람 글만) — 감사 줄이 없다.
        Outcome::Posted { row, notified, .. } => posted_result(&row, &notified),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const C: &str = "11111111-1111-1111-1111-111111111111";
    const R: &str = "22222222-2222-2222-2222-222222222222";

    #[test]
    fn parse_like_zod() {
        let a = parse(&json!({ "channelId": C, "body": " ", "extra": 1 })).expect("min(1) only");
        assert_eq!(a.post.body, " ");
        assert!(!a.post.also_in_channel);
        let a = parse(&json!({ "channelId": C, "body": "x", "threadRootId": R, "alsoInChannel": true, "model": " opus " }))
            .expect("full");
        assert!(a.post.also_in_channel);
        assert_eq!(a.model.as_deref(), Some("opus"));
        // 공백뿐인 모델은 zod 를 지나고 meta 가 없다.
        assert_eq!(
            parse(&json!({ "channelId": C, "body": "x", "model": "  " })).map(|a| a.model),
            Some(None)
        );
        for bad in [
            json!({ "channelId": C, "body": "" }),
            json!({ "channelId": "x", "body": "a" }),
            json!({ "channelId": C, "body": "a", "threadRootId": null }),
            json!({ "channelId": C, "body": "a", "alsoInChannel": "yes" }),
            json!({ "channelId": C, "body": "a", "attachmentIds": [1] }),
            json!({ "channelId": C, "body": "a", "attachmentIds": vec![C; 11] }),
            json!({ "channelId": C, "body": "a", "model": "" }),
            json!({ "channelId": C, "body": "a", "model": "x".repeat(121) }),
            json!({ "channelId": C, "body": "a", "model": "오푸스" }),
            json!({ "channelId": C, "body": "a", "agentModels": [] }),
            json!({ "channelId": C, "body": "a".repeat(8001) }),
        ] {
            assert!(parse(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn result_shape_like_ts() {
        let row = r#"{"id":"m","meta":{"mentionDenied":["bot","b2"]},"body":"x"}"#;
        let t = posted_result(row, &["a".into()]).unwrap();
        let v: Value = serde_json::from_str(&t).unwrap();
        let inner = v
            .pointer("/content/0/text")
            .and_then(Value::as_str)
            .unwrap();
        assert!(
            inner.starts_with(r#"{"warnings":["@bot, @b2 를 부르지 못했다"#),
            "{inner}"
        );
        assert!(inner.ends_with(r#""message":{"id":"m","meta":{"mentionDenied":["bot","b2"]},"body":"x"},"notified":["a"]}"#));
        let t = posted_result(
            r#"{"id":"m","meta":{"mentionChainCapped":["b2"],"mentionChainLimit":8,"mentionDenied":["x"]}}"#,
            &[],
        )
        .unwrap();
        let v: Value = serde_json::from_str(&t).unwrap();
        let inner: Value = serde_json::from_str(
            v.pointer("/content/0/text")
                .and_then(Value::as_str)
                .unwrap(),
        )
        .unwrap();
        let w = inner["warnings"].as_array().unwrap();
        assert_eq!(w.len(), 2);
        assert!(
            w[0].as_str()
                .unwrap()
                .starts_with("@b2 를 부르지 못했다: 멘션 연쇄 상한 8 홉에 닿았다 (사람 없이")
        );
        assert!(
            w[1].as_str()
                .unwrap()
                .starts_with("@x 를 부르지 못했다: 너는")
        );
        let t = posted_result(r#"{"id":"m","meta":{}}"#, &[]).unwrap();
        assert!(
            t.contains(r#"{\"message\":{\"id\":\"m\",\"meta\":{}},\"notified\":[]}"#),
            "{t}"
        );
    }
}
