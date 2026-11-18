//! MCP `message.ask` 의 거절 앞머리(TS `mcpPlugin.ts` `message.ask`). TS 순서 그대로: zod 인자 → `planStepId` 인데 스레드
//! 없음(`bad_request`) → 채널 가시성(`forbidden`) → 선택지 id 겹침(`duplicate_option`) → 예약 id(`reserved_option_id`)
//! → 추천 둘 이상(`multiple_recommended`) → 머지 거절 카드에 `to`·`mirrorOf`(`merge_denial_audience`). 모두 지나면 `None`
//! (→ TS) — 대상 찾기·거울·대신하기·카드 쓰기는 아직 TS 몫이다. 인자가 zod 를 못 지나거나 DB 오류여도 `None`. 읽기만 한다.
use super::tools::err;
use crate::auth::Account;
use crate::core::ask::{ASK_MAX_OPTIONS, ASK_MIN_OPTIONS, ASK_TEXT_OPTION_ID};
use crate::core::cause_link::MODEL_ID_MAX;
use crate::core::channels::is_uuid;
use crate::core::msg_edit::MAX_MESSAGE_BODY_CHARS;
use serde_json::{Map, Value};
use sqlx::PgPool;
use std::collections::HashSet;

fn len_ok(s: &str, max: usize) -> bool {
    (1..=max).contains(&s.encode_utf16().count())
}

/// zod `optional()` 칸 — 없으면 `Some(None)`, 있는데 `ok` 를 못 지나면 `None`.
fn opt<'a>(
    o: &'a Map<String, Value>,
    k: &str,
    ok: impl Fn(&Value) -> bool,
) -> Option<Option<&'a Value>> {
    match o.get(k) {
        None => Some(None),
        Some(v) if ok(v) => Some(Some(v)),
        _ => None,
    }
}

fn str_ok(max: usize) -> impl Fn(&Value) -> bool {
    move |v| v.as_str().is_some_and(|s| len_ok(s, max))
}

fn uuid_ok(v: &Value) -> bool {
    v.as_str().is_some_and(is_uuid)
}

/// `/^s[1-9][0-9]{0,3}$/`.
fn plan_step_ok(v: &Value) -> bool {
    v.as_str().is_some_and(|s| {
        let b = s.as_bytes();
        b.len() >= 2
            && b.len() <= 5
            && b[0] == b's'
            && (b'1'..=b'9').contains(&b[1])
            && b[2..].iter().all(u8::is_ascii_digit)
    })
}

struct Args<'a> {
    channel: &'a str,
    thread: bool,
    /// (id, recommended)
    options: Vec<(&'a str, bool)>,
    to: bool,
    mirror_of: bool,
    merge_denial: bool,
    plan_step: bool,
}

fn parse(args: &Value) -> Option<Args<'_>> {
    let Value::Object(o) = args else { return None };
    let channel = o.get("channelId")?.as_str().filter(|s| is_uuid(s))?;
    if !len_ok(o.get("body")?.as_str()?, MAX_MESSAGE_BODY_CHARS) {
        return None;
    }
    let thread = opt(o, "threadRootId", uuid_ok)?.is_some();
    let raw = o.get("options")?.as_array()?;
    if !(ASK_MIN_OPTIONS..=ASK_MAX_OPTIONS).contains(&raw.len()) {
        return None;
    }
    let mut options = Vec::with_capacity(raw.len());
    for x in raw {
        let x = x.as_object()?;
        let id = x.get("id")?.as_str().filter(|s| len_ok(s, 64))?;
        if !str_ok(200)(x.get("label")?) {
            return None;
        }
        opt(x, "hint", str_ok(200))?;
        let rec = opt(x, "recommended", Value::is_boolean)?.and_then(Value::as_bool) == Some(true);
        options.push((id, rec));
    }
    opt(o, "irreversible", Value::is_boolean)?;
    let to = opt(o, "to", str_ok(64))?.is_some();
    opt(o, "prompt", str_ok(500))?;
    let mirror_of = opt(o, "mirrorOf", uuid_ok)?.is_some();
    opt(o, "supersedes", |v| {
        uuid_ok(v)
            || v.as_array()
                .is_some_and(|a| !a.is_empty() && a.iter().all(uuid_ok))
    })?;
    opt(o, "keepOpen", |v| {
        v.as_array()
            .is_some_and(|a| a.len() <= 50 && a.iter().all(uuid_ok))
    })?;
    let merge_denial = opt(o, "mergeDenialId", uuid_ok)?.is_some();
    let plan_step = opt(o, "planStepId", plan_step_ok)?.is_some();
    opt(o, "model", str_ok(MODEL_ID_MAX))?;
    Some(Args {
        channel,
        thread,
        options,
        to,
        mirror_of,
        merge_denial,
        plan_step,
    })
}

/// 채널 가시성 뒤의 거절(순서가 TS 와 같다).
fn option_refusal(a: &Args<'_>) -> Option<String> {
    let ids: HashSet<&str> = a.options.iter().map(|(id, _)| *id).collect();
    if ids.len() != a.options.len() {
        return Some(err("duplicate_option", "option ids must be unique"));
    }
    if ids.contains(ASK_TEXT_OPTION_ID) {
        return Some(err(
            "reserved_option_id",
            &format!("option id {ASK_TEXT_OPTION_ID} is reserved"),
        ));
    }
    if a.options.iter().filter(|(_, r)| *r).count() > 1 {
        return Some(err(
            "multiple_recommended",
            "mark at most one option as recommended",
        ));
    }
    if a.merge_denial && (a.to || a.mirror_of) {
        return Some(err(
            "merge_denial_audience",
            "a merge-denial card is addressed to humans; omit `to` and `mirrorOf`",
        ));
    }
    None
}

pub async fn answer(read: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let a = parse(args)?;
    if a.plan_step && !a.thread {
        return Some(err(
            "bad_request",
            "planStepId 는 threadRootId 와 함께 준다(그 스레드의 계획 단계)",
        ));
    }
    if !crate::core::channels::visible(read, &me.id, a.channel)
        .await
        .ok()?
    {
        return Some(err("forbidden", "not a member of this dm channel"));
    }
    option_refusal(&a)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const C: &str = "0b7f3f92-3fa6-494a-8ab3-76d0d2a6a1c0";

    fn ask(extra: Value) -> Value {
        let mut v = json!({ "channelId": C, "body": "b",
            "options": [{ "id": "a", "label": "A" }, { "id": "b", "label": "B", "hint": "h", "recommended": false }] });
        for (k, x) in extra.as_object().unwrap() {
            v[k] = x.clone();
        }
        v
    }

    fn code(r: Option<String>) -> Option<String> {
        let v: Value = serde_json::from_str(&r?).ok()?;
        let inner: Value = serde_json::from_str(v.pointer("/content/0/text")?.as_str()?).ok()?;
        Some(inner.pointer("/error/code")?.as_str()?.to_owned())
    }

    #[test]
    fn parse_like_zod() {
        assert!(parse(&ask(json!({}))).is_some());
        assert!(
            parse(&ask(
                json!({ "supersedes": C, "keepOpen": [], "planStepId": "s1234" })
            ))
            .is_some()
        );
        assert!(parse(&ask(json!({ "supersedes": [C] }))).is_some());
        for bad in [
            json!({ "supersedes": [] }),
            json!({ "supersedes": "x" }),
            json!({ "planStepId": "s0" }),
            json!({ "planStepId": "s12345" }),
            json!({ "options": [{ "id": "a", "label": "A" }] }),
            json!({ "options": [{ "id": "", "label": "A" }, { "id": "b", "label": "B" }] }),
            json!({ "options": [{ "id": "a", "label": "A", "recommended": 1 }, { "id": "b", "label": "B" }] }),
            json!({ "to": "" }),
            json!({ "prompt": null }),
            json!({ "irreversible": "yes" }),
            json!({ "keepOpen": ["x"] }),
            json!({ "body": "" }),
            json!({ "model": "" }),
        ] {
            assert!(parse(&ask(bad.clone())).is_none(), "{bad}");
        }
    }

    #[test]
    fn option_refusals_in_ts_order() {
        let r = |v: Value| code(option_refusal(&parse(&v).unwrap()));
        assert_eq!(r(ask(json!({}))), None);
        assert_eq!(
            r(ask(
                json!({ "options": [{ "id": "a", "label": "A" }, { "id": "a", "label": "B" }] })
            ))
            .as_deref(),
            Some("duplicate_option")
        );
        assert_eq!(
            r(ask(json!({ "options": [{ "id": "__text__", "label": "A" }, { "id": "a", "label": "B" }] }))).as_deref(),
            Some("reserved_option_id")
        );
        assert_eq!(
            r(ask(json!({ "options": [{ "id": "a", "label": "A", "recommended": true }, { "id": "b", "label": "B", "recommended": true }] }))).as_deref(),
            Some("multiple_recommended")
        );
        assert_eq!(
            r(ask(json!({ "mergeDenialId": C, "to": "x" }))).as_deref(),
            Some("merge_denial_audience")
        );
        assert_eq!(
            r(ask(json!({ "mergeDenialId": C, "mirrorOf": C }))).as_deref(),
            Some("merge_denial_audience")
        );
        assert_eq!(r(ask(json!({ "mergeDenialId": C }))), None);
    }
}
