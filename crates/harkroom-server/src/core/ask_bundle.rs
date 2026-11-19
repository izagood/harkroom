//! S5.3 C3b-2a — 묶음 카드 REST: `POST /channels/{id}/messages/{messageId}/ask-bundle/answer`(한 줄에 답)와
//! `…/ask-bundle/accept-recommended`(남은 줄을 추천대로). TS `routes/messageRoutes.ts` 의 두 줄과 `services/askBundles.ts` 의
//! `answerBundleItem`·`acceptRecommended`·`isIrreversible` 을 옮긴다.
//!
//! - **정본은 원본이다.** 줄의 답은 원본에 누른 사람 이름으로 적는다 — C3b-1 의 [`super::ask::record_ask_answer`] 그대로(수신자·
//!   사람만·superseded 거절·깨움·거울/묶음 맞추기). 이벤트는 그 안의 묶음 `message.updated` 뒤에 원본의 `message.updated`(원본 채널의
//!   받는 사람) — TS 와 같은 차례.
//! - **TS 로 넘기는 줄**(닫힌 쪽): 줄마다 원본을 [`hand_answer_to_ts`] 로 잰다 — 권한 요청·권한 거울 표지,
//!   권한 요청 행의 카드, 못 읽는 모양·모르는 kind, 이상한 `mirrorOf`, 원본이 없음. 그런 줄의 답은 읽어 둔 본문 바이트 그대로 TS 가
//!   한다(권한 줄의 `decide` 는 C3b-3 몫). 머지 카드 [이번 한 번] 값(`once`)이 실린 답도 TS 로 넘긴다.
//!   머지 거절·백스톱 원본은 Rust 가 맡는다(TS 도 `recordAskAnswer` 길 — 「추천대로」에서는 결정 카드·`irreversible` 로 빠진다).
//!   「추천대로」는 TS 도 결정 카드 줄을 뺀다(`skipped_link`) — 남는 줄 가운데 하나라도 넘길 줄이면 요청 전체를 TS 로 넘긴다.
//! - 판정·쓰기·이벤트는 줄 하나에 한 트랜잭션이다. 「추천대로」는 TS 처럼 줄마다 따로 커밋한다(일부만 될 수 있다).
//!   `Err` 면 그 줄의 트랜잭션을 버리고 500.
//! - 문장은 TS 상수를 골든으로 받는다(`bundle_*`). 쓰기 권한은 C3b-1 의 `ASK_PRIVILEGES` 와 같다(같은 표·같은 칸을 쓴다) —
//!   `ask::routes` 가 이 두 줄을 함께 붙이므로 권한이 모자라면 둘 다 TS 에 남는다.
use super::ask::{
    AskState, Outcome, hand_answer_to_ts, read_ask_meta, read_ask_row, read_bytes,
    record_ask_answer, to_ts,
};
use super::audience::audience_on;
use super::msg_read::{channel_visible, is_uuid, message_by_id};
use crate::auth::RequireAccount;
use crate::directory::{internal, json_err};
use axum::extract::{ConnectInfo, Path, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::net::SocketAddr;
use std::sync::{Arc, OnceLock};

/// TS `ASK_BUNDLE_REFUSAL_MESSAGE` 의 이 두 줄이 쓰는 것.
pub(super) const BUNDLE_NOT_FOUND: &str = "no such bundle card";
const BUNDLE_ITEM_NOT_FOUND: &str = "that card is not a row of this bundle";
/// TS `answerBundleItem` 의 `answeredVia` — 「추천대로 일괄」.
const BULK: &str = "bundle_bulk";

struct Sql {
    read: String,
    decision_card: String,
    accept_root: String,
    irreversible: regex::Regex,
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
        let flags = frag("bundle_irreversible_flags");
        // JS 깃발은 `i` 하나다(다른 깃발이 붙으면 옮긴 판정이 달라지니 기동에서 멈춘다).
        assert_eq!(flags, "i", "bundle_irreversible_flags");
        Sql {
            read: format!(
                "select b.meta, b.\"channelId\"::text from ({}) b",
                frag("bundle_read")
            ),
            decision_card: format!(
                "select d.\"?column?\" from ({}) d",
                frag("bundle_decision_card")
            ),
            accept_root: frag("bundle_accept_root"),
            irreversible: regex::Regex::new(&format!("(?i){}", frag("bundle_irreversible_source")))
                .expect("irreversible regex"),
        }
    })
}

/// JS 참·거짓(`if (item.link)`).
fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// 묶음의 한 줄 — TS `AskBundleItem` 중 여기서 쓰는 칸.
struct Item {
    root_id: String,
    link: bool,
}

/// TS shared `readAskBundleMeta` — 못 알아보면 None.
fn read_bundle_meta(meta: &Value) -> Option<Vec<Item>> {
    if meta.get("kind").and_then(Value::as_str) != Some("askBundle") {
        return None;
    }
    let bundle = meta.get("askBundle").filter(|b| b.is_object())?;
    let items = bundle.get("items")?.as_array()?;
    let mut out = Vec::with_capacity(items.len());
    for i in items {
        // TS: `i && typeof i.rootId === 'string' && Array.isArray(i.options)` — `i` 가 객체가 아니면 `i.rootId` 는 undefined.
        let root_id = i.get("rootId").and_then(Value::as_str)?;
        i.get("options").filter(|o| o.is_array())?;
        out.push(Item {
            root_id: root_id.to_owned(),
            link: js_truthy(i.get("link")),
        });
    }
    Some(out)
}

/// TS `readBundle` — (줄들, 채널).
async fn read_bundle<'e, E: sqlx::PgExecutor<'e>>(
    ex: E,
    id: &str,
) -> sqlx::Result<Option<(Vec<Item>, String)>> {
    let row: Option<(Value, String)> = sqlx::query_as(sql().read.as_str())
        .bind(id)
        .fetch_optional(ex)
        .await?;
    Ok(row.and_then(|(meta, ch)| read_bundle_meta(&meta).map(|items| (items, ch))))
}

/// TS `isDecisionCard`.
async fn is_decision_card(pool: &PgPool, id: &str) -> sqlx::Result<bool> {
    let hit: Option<i32> = sqlx::query_scalar(sql().decision_card.as_str())
        .bind(id)
        .fetch_optional(pool)
        .await?;
    Ok(hit.is_some())
}

/// TS `isIrreversible` — 결정 카드 표지, 못 읽는 물음, `irreversible: true`, 아니면 본문·물음·선택지 글자의 낱말.
pub(super) fn is_irreversible(meta: &Value, body: &str) -> bool {
    if js_truthy(meta.get("permissionRequest")) || js_truthy(meta.get("mergeDenial")) {
        return true;
    }
    if read_ask_meta(meta).is_none() {
        return true;
    }
    let ask = &meta["ask"];
    if ask.get("irreversible") == Some(&Value::Bool(true)) {
        return true;
    }
    // TS `ask.prompt ?? ''`·`o.hint ?? ''` — 문자열이 아닌 값은 JS 가 글자로 바꿔 잇는다. 여기서는 문자열만 잇고,
    // 문자열이 아닌 값이 있으면 판정이 갈릴 수 있으니 되돌릴 수 없는 쪽으로 본다(넓은 쪽 — 빼면 사람이 손으로 누른다).
    let mut parts = vec![body.to_owned()];
    let mut odd = false;
    let mut push = |v: Option<&Value>| match v {
        None | Some(Value::Null) => parts.push(String::new()),
        Some(Value::String(s)) => parts.push(s.clone()),
        Some(_) => odd = true,
    };
    push(ask.get("prompt"));
    for o in ask["options"].as_array().into_iter().flatten() {
        push(o.get("label"));
        push(o.get("hint"));
    }
    odd || sql().irreversible.is_match(&parts.join("\n"))
}

/// 원본의 추천 선택지 — `recommended === true` 인 것이 꼭 하나일 때만.
fn single_recommended(meta: &Value) -> Option<String> {
    let rec: Vec<&str> = meta["ask"]["options"]
        .as_array()?
        .iter()
        .filter(|o| o.get("recommended") == Some(&Value::Bool(true)))
        .filter_map(|o| o.get("id").and_then(Value::as_str))
        .collect();
    (rec.len() == 1).then(|| rec[0].to_owned())
}

fn err(status: StatusCode, code: &str, message: &str) -> Response {
    json_err(status, code, message)
}

fn ok_json(body: String) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json; charset=utf-8")],
        body,
    )
        .into_response()
}

/// 한 줄에 답한 결과 — 거절은 (상태, 코드, 문구).
enum ItemResult {
    Done,
    Refused(StatusCode, &'static str, &'static str),
}

/// TS `answerBundleItem` 의 원본 쪽(권한 줄이 아닌 것) — 원본을 이미 [`hand_answer_to_ts`] 로 거른 뒤에 부른다. 한 트랜잭션.
async fn answer_root(
    st: &AskState,
    root: &str,
    option: &str,
    actor: &str,
    via: Option<&str>,
) -> sqlx::Result<ItemResult> {
    let mut tx = st.write.begin().await?;
    let Some((ask, root_channel, _)) = read_ask_row(&mut tx, root).await? else {
        return Ok(ItemResult::Refused(
            StatusCode::NOT_FOUND,
            "not_found",
            "the original card is gone",
        ));
    };
    if !channel_visible(&st.read, actor, &root_channel).await? {
        return Ok(ItemResult::Refused(
            StatusCode::FORBIDDEN,
            "forbidden",
            "you cannot see the channel of the original card",
        ));
    }
    if ask.mirror_of.is_some() {
        return Ok(ItemResult::Refused(
            StatusCode::FORBIDDEN,
            "forbidden",
            "that card is itself a mirror — bundle the original card",
        ));
    }
    let out = record_ask_answer(&st.read, &mut tx, root, actor, option, None, via).await?;
    let res = match out {
        Outcome::NotFound => {
            ItemResult::Refused(StatusCode::NOT_FOUND, "not_found", "no such choice request")
        }
        Outcome::Forbidden => ItemResult::Refused(
            StatusCode::FORBIDDEN,
            "forbidden",
            "this choice is addressed to someone else",
        ),
        Outcome::UnknownOption => ItemResult::Refused(
            StatusCode::BAD_REQUEST,
            "unknown_option",
            "no such option in this request",
        ),
        Outcome::AlreadyAnswered => ItemResult::Refused(
            StatusCode::CONFLICT,
            "already_answered",
            "this choice is already answered",
        ),
        Outcome::Row(row) => {
            let message: Value =
                serde_json::from_str(&row).map_err(|e| sqlx::Error::Decode(e.into()))?;
            let audience = audience_on(&mut tx, &root_channel).await?.to_json();
            crate::write::emit_event(
                &mut tx,
                &json!({ "type": "message.updated", "message": message, "audience": audience }),
            )
            .await?;
            ItemResult::Done
        }
    };
    // 거절도 커밋한다 — 거절에 쓰기가 없으면 빈 커밋이다(C3b-1 `commit_with` 와 같다).
    tx.commit().await?;
    Ok(res)
}

/// 본문: `rootId` uuid, `optionId` 1..=64(UTF-16), `once` 는 있으면 TS 로.
fn parse_answer(v: &Value) -> Option<(String, String, bool)> {
    let Value::Object(o) = v else { return None };
    let root = o
        .get("rootId")
        .and_then(Value::as_str)
        .filter(|s| is_uuid(s))?;
    let option = o.get("optionId").and_then(Value::as_str)?;
    if !(1..=64).contains(&option.encode_utf16().count()) {
        return None;
    }
    let once = o.get("once").is_some_and(|v| !v.is_null());
    Some((root.to_owned(), option.to_owned(), once))
}

fn bad_request() -> Response {
    // 문구는 TS(zod 오류 JSON)와 다르다 — 대조는 상태·코드만 본다.
    json_err(StatusCode::BAD_REQUEST, "invalid_request", "body: invalid")
}

async fn visible_or_403(st: &AskState, me: &str, channel: &str) -> Option<Response> {
    match channel_visible(&st.read, me, channel).await {
        Ok(true) => None,
        Ok(false) => Some(err(
            StatusCode::FORBIDDEN,
            "forbidden",
            "not a member of this dm channel",
        )),
        Err(e) => Some(internal(e)),
    }
}

/// `POST /channels/{id}/messages/{messageId}/ask-bundle/answer`.
pub async fn answer(
    State(st): State<Arc<AskState>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((id, bundle)): Path<(String, String)>,
    req: Request,
) -> Response {
    if !is_uuid(&id) || !is_uuid(&bundle) {
        return bad_request();
    }
    let (parts, body) = req.into_parts();
    let (bytes, parsed) = match read_bytes(&parts.headers, body).await {
        Ok((b, Some(v))) => match parse_answer(&v) {
            Some(a) => (b, a),
            None => return bad_request(),
        },
        Ok(_) => return bad_request(),
        Err(r) => return r,
    };
    let (root, option, once) = parsed;
    // 머지 카드 [이번 한 번] 값(`once`)은 모양 검사부터 TS 가 한다 — 판정 전에 넘긴다.
    if once {
        return to_ts(st.up.clone(), peer, parts, bytes).await;
    }
    if let Some(r) = visible_or_403(&st, &me.id, &id).await {
        return r;
    }
    let items = match read_bundle(&st.read, &bundle).await {
        Ok(Some((items, ch))) if ch == id => items,
        Ok(_) => return err(StatusCode::NOT_FOUND, "not_found", BUNDLE_NOT_FOUND),
        Err(e) => return internal(e),
    };
    if !items.iter().any(|i| i.root_id == root) {
        return err(
            StatusCode::NOT_FOUND,
            "bundle_item_not_found",
            BUNDLE_ITEM_NOT_FOUND,
        );
    }
    // C3b-3c — 권한 줄의 거절. W1: 위에서 이 채널의 묶음이 이 줄(root)을 담는 것을 확인한 **뒤에만** 묶음 id 를 넘긴다.
    if let super::decide_routes::Taken::Done(r) =
        super::decide_routes::answer_bundle_deny(&st, &me, &auth, &bundle, &root, &option).await
    {
        return r;
    }
    // S5.3 B2 — 같은 W1 확인 뒤의 소유자 승인.
    if let super::decide_routes::Taken::Done(r) =
        super::decide_routes::answer_bundle_approve(&st, &me, &auth, &bundle, &root, &option).await
    {
        return r;
    }
    // 원본이 Rust 가 정하지 않는 카드면 TS 가 한다. 사슬·옛 머지 거절 원본은 TS 에서도 `recordAskAnswer` 길이라 Rust 가 맡는다.
    match hand_answer_to_ts(&st.read, &root).await {
        Ok(false) => {}
        Ok(true) => return to_ts(st.up.clone(), peer, parts, bytes).await,
        Err(e) => return internal(e),
    }
    match answer_root(&st, &root, &option, &me.id, None).await {
        Err(e) => internal(e),
        Ok(ItemResult::Refused(s, c, m)) => err(s, c, m),
        Ok(ItemResult::Done) => match message_by_id(&st.read, &bundle).await {
            Ok(Some(row)) => ok_json(row),
            Ok(None) => err(StatusCode::NOT_FOUND, "not_found", BUNDLE_NOT_FOUND),
            Err(e) => internal(e),
        },
    }
}

/// `POST /channels/{id}/messages/{messageId}/ask-bundle/accept-recommended`.
pub async fn accept_recommended(
    State(st): State<Arc<AskState>>,
    RequireAccount(me, _): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((id, bundle)): Path<(String, String)>,
    req: Request,
) -> Response {
    if !is_uuid(&id) || !is_uuid(&bundle) {
        return bad_request();
    }
    let (parts, body) = req.into_parts();
    // TS 는 본문을 보지 않는다 — 그래도 fastify 가 먼저 읽으므로 같은 규칙(413·400·415)으로 읽는다.
    let bytes = match read_bytes(&parts.headers, body).await {
        Ok((b, _)) => b,
        Err(r) => return r,
    };
    if let Some(r) = visible_or_403(&st, &me.id, &id).await {
        return r;
    }
    let items = match read_bundle(&st.read, &bundle).await {
        Ok(Some((items, ch))) if ch == id => items,
        Ok(_) => return err(StatusCode::NOT_FOUND, "not_found", BUNDLE_NOT_FOUND),
        Err(e) => return internal(e),
    };
    // 먼저 훑는다 — 결정 카드 줄(TS 도 뺀다) 밖에서 하나라도 Rust 가 정하지 않는 원본이면 요청 전체를 TS 로.
    let mut skip_link = Vec::with_capacity(items.len());
    for item in &items {
        let skip = item.link
            || match is_decision_card(&st.read, &item.root_id).await {
                Ok(b) => b,
                Err(e) => return internal(e),
            };
        // 사슬 백스톱 원본은 TS 도 `recordAskAnswer` 길이다(실제로는 `irreversible` 로 빠진다).
        if !skip {
            match hand_answer_to_ts(&st.read, &item.root_id).await {
                Ok(false) => {}
                Ok(true) => return to_ts(st.up.clone(), peer, parts, bytes).await,
                Err(e) => return internal(e),
            }
        }
        skip_link.push(skip);
    }
    let mut results: Vec<Value> = Vec::with_capacity(items.len());
    for (item, skip) in items.iter().zip(skip_link) {
        let root = item.root_id.as_str();
        if skip {
            results.push(json!({ "rootId": root, "outcome": "skipped_link" }));
            continue;
        }
        let found: Option<(Value, String)> = match sqlx::query_as(sql().accept_root.as_str())
            .bind(root)
            .fetch_optional(&st.read)
            .await
        {
            Ok(f) => f,
            Err(e) => return internal(e),
        };
        let open = found
            .as_ref()
            .and_then(|(meta, _)| read_ask_meta(meta))
            .is_some_and(|a| !a.answered && !a.closed);
        let Some((meta, body)) = found.filter(|_| open) else {
            results.push(json!({ "rootId": root, "outcome": "resolved" }));
            continue;
        };
        if is_irreversible(&meta, &body) {
            results.push(json!({ "rootId": root, "outcome": "skipped_irreversible" }));
            continue;
        }
        let Some(option) = single_recommended(&meta) else {
            results.push(json!({ "rootId": root, "outcome": "skipped_no_recommendation" }));
            continue;
        };
        // TS `answerBundleItem(… answeredVia: 'bundle_bulk')` — 묶음·줄을 다시 읽고 원본으로 간다.
        let again = match read_bundle(&st.read, &bundle).await {
            Ok(Some((items, ch))) if ch == id => items,
            Ok(_) => {
                results.push(json!({ "rootId": root, "outcome": "failed", "code": "not_found" }));
                continue;
            }
            Err(e) => return internal(e),
        };
        if !again.iter().any(|i| i.root_id == root) {
            results.push(
                json!({ "rootId": root, "outcome": "failed", "code": "bundle_item_not_found" }),
            );
            continue;
        }
        match answer_root(&st, root, &option, &me.id, Some(BULK)).await {
            Err(e) => return internal(e),
            Ok(ItemResult::Done) => results.push(json!({ "rootId": root, "outcome": "answered" })),
            Ok(ItemResult::Refused(_, code, _)) => {
                results.push(json!({ "rootId": root, "outcome": "failed", "code": code }));
            }
        }
    }
    match message_by_id(&st.read, &bundle).await {
        Ok(Some(row)) => {
            let message: Value = match serde_json::from_str(&row) {
                Ok(v) => v,
                Err(e) => return internal(sqlx::Error::Decode(e.into())),
            };
            ok_json(json!({ "message": message, "results": results }).to_string())
        }
        Ok(None) => err(StatusCode::NOT_FOUND, "not_found", BUNDLE_NOT_FOUND),
        Err(e) => internal(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_loads() {
        let s = sql();
        assert!(s.read.contains("deleted_at is null"));
        assert!(s.decision_card.contains("permissionRequest"));
        assert!(s.irreversible.is_match("Please MERGE this"));
        assert!(s.irreversible.is_match("배포할까요"));
        assert!(!s.irreversible.is_match("점심 메뉴"));
    }

    #[test]
    fn bundle_meta_like_ts() {
        let ok = json!({ "kind": "askBundle", "askBundle": { "items": [{ "rootId": "r", "options": [], "link": "x" }, { "rootId": "q", "options": [] }] } });
        let items = read_bundle_meta(&ok).unwrap();
        assert_eq!(items.len(), 2);
        assert!(items[0].link && !items[1].link);
        assert!(read_bundle_meta(&json!({ "kind": "ask" })).is_none());
        assert!(read_bundle_meta(&json!({ "kind": "askBundle", "askBundle": { "items": [{ "rootId": 1, "options": [] }] } })).is_none());
        assert!(
            read_bundle_meta(
                &json!({ "kind": "askBundle", "askBundle": { "items": [{ "rootId": "r" }] } })
            )
            .is_none()
        );
    }

    #[test]
    fn irreversible_like_ts() {
        let card = |prompt: &str, label: &str| {
            json!({ "kind": "ask", "ask": { "prompt": prompt, "to": { "kind": "human" },
            "options": [{ "id": "a", "label": label }, { "id": "b", "label": "B" }] } })
        };
        assert!(!is_irreversible(&card("점심?", "A"), "고르기"));
        assert!(is_irreversible(&card("Deploy now?", "A"), "x"));
        assert!(is_irreversible(&card("x", "force-push"), "x"));
        assert!(is_irreversible(
            &json!({ "kind": "ask", "mergeDenial": {} }),
            "x"
        ));
        assert!(is_irreversible(&json!({ "kind": "nope" }), "x"));
        let mut flagged = card("점심?", "A");
        flagged["ask"]["irreversible"] = json!(true);
        assert!(is_irreversible(&flagged, "x"));
    }

    #[test]
    fn recommended_needs_exactly_one() {
        let m = |recs: &[bool]| json!({ "ask": { "options": recs.iter().enumerate().map(|(i, r)| json!({ "id": i.to_string(), "label": "L", "recommended": r })).collect::<Vec<_>>() } });
        assert_eq!(single_recommended(&m(&[false, true])), Some("1".into()));
        assert_eq!(single_recommended(&m(&[true, true])), None);
        assert_eq!(single_recommended(&m(&[false, false])), None);
    }

    #[test]
    fn answer_body_like_zod() {
        let u = "0b6f8d2e-3c1a-4f5e-9a7b-1c2d3e4f5a6b";
        assert!(parse_answer(&json!({ "rootId": u, "optionId": "a" })).is_some());
        assert!(parse_answer(&json!({ "rootId": u, "optionId": "" })).is_none());
        assert!(parse_answer(&json!({ "rootId": u, "optionId": "a".repeat(65) })).is_none());
        assert!(parse_answer(&json!({ "rootId": "x", "optionId": "a" })).is_none());
        assert_eq!(
            parse_answer(&json!({ "rootId": u, "optionId": "a", "once": { "number": 1 } }))
                .map(|p| p.2),
            Some(true)
        );
    }
}
