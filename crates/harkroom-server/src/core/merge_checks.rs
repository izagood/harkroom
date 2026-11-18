//! S5.4 — `POST /agent/merge-checks`(TS `mergeRoutes.ts` → `mergeGrants.ts::checkMerge`) — **부분 이식**.
//!
//! Rust 는 판정 전의 두 갈래만 답한다: 오퍼레이터를 거치지 않은 요청(403 `forbidden`)과 zod 모양이 틀린 본문(400 `bad_request`).
//! 모양이 맞는 요청은 전부 TS 로 넘긴다 — 임대·사슬 판정(`checkMergeByChain`)·위임 판정·1회 승인 소모·`merge_denial`·카드·
//! 그림자 감사(`mandate.shadow`)는 아직 TS 몫이다. 넘기는 쪽은 DB 를 건드리지 않으므로 칸 권한이 필요 없다.
//!
//! `POST /agent/merge-results`(TS `reportMerge`)도 같은 꼴로 부분 이식한다 — 403 `forbidden`·400 `bad_request` 만 Rust,
//! 임대·판정 소모·「머지됨」 줄·CI 거절 기록·감사는 아직 TS 몫이다.
use super::grant_reads::through_operator;
use super::merge_approval_peek::str_len_ok;
use super::msg_read::is_uuid;
use crate::auth::RequireAccount;
use crate::directory::json_err;
use crate::proxy::Upstream;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::StatusCode;
use axum::response::Response;
use serde_json::{Map, Value};
use std::net::SocketAddr;
use std::sync::Arc;

const FORBIDDEN: &str = "only an agent through its operator can do this";
const BAD: &str = "leaseId, token, repo, number and a 40-hex headSha are required";

/// zod `^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`.
fn gh_user_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 39
        && b[0].is_ascii_alphanumeric()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

/// zod `{ leaseId, token, repo, number, headSha, ghUser? }` 모양만 본다(남는 키는 zod 처럼 무시).
pub fn shape_ok(body: Option<&Value>) -> bool {
    let empty = Map::new();
    let o = match body {
        None => &empty,
        Some(v) => match v.as_object() {
            Some(o) => o,
            None => return false,
        },
    };
    let ok = (|| {
        if !is_uuid(o.get("leaseId")?.as_str()?) {
            return None;
        }
        str_len_ok(o.get("token")?, 1, 200)?;
        str_len_ok(o.get("repo")?, 3, 201)?;
        let n = o.get("number")?.as_f64()?;
        if !(n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0) {
            return None;
        }
        let h = o.get("headSha")?.as_str()?;
        if !(h.len() == 40 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))) {
            return None;
        }
        if let Some(g) = o.get("ghUser")
            && !gh_user_ok(g.as_str()?)
        {
            return None;
        }
        Some(())
    })();
    ok.is_some()
}

const BAD_RESULT: &str = "leaseId, token, repo, number, headSha and result are required";

/// 키가 없거나 `null` 이면 통과(zod `.nullable().optional()`), 아니면 길이 0..=max 문자열.
fn opt_null_str(o: &Map<String, Value>, k: &str, max: usize) -> Option<()> {
    match o.get(k) {
        None | Some(Value::Null) => Some(()),
        Some(v) => str_len_ok(v, 0, max).map(|_| ()),
    }
}

/// zod `z.array(z.string().max(1000)).max(100)`.
fn str_array_ok(v: &Value) -> Option<()> {
    let a = v.as_array()?;
    if a.len() > 100 {
        return None;
    }
    for x in a {
        str_len_ok(x, 0, 1000)?;
    }
    Some(())
}

/// TS `/agent/merge-results` 의 zod 모양 — `base` + `result`·`mergeSha?`·`error?`·`ciRefusal?`·`ignoredChecks?`·
/// `noPrChecks?`·`ghUserUsed?`(남는 키는 무시).
pub fn results_shape_ok(body: Option<&Value>) -> bool {
    let empty = Map::new();
    let o = match body {
        None => &empty,
        Some(v) => match v.as_object() {
            Some(o) => o,
            None => return false,
        },
    };
    let ok = (|| {
        if !is_uuid(o.get("leaseId")?.as_str()?) {
            return None;
        }
        str_len_ok(o.get("token")?, 1, 200)?;
        str_len_ok(o.get("repo")?, 3, 201)?;
        let n = o.get("number")?.as_f64()?;
        if !(n > 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0) {
            return None;
        }
        if !sha_ok(o.get("headSha")?.as_str()?) {
            return None;
        }
        if !matches!(o.get("result")?.as_str()?, "merged" | "queued" | "failed") {
            return None;
        }
        match o.get("mergeSha") {
            None | Some(Value::Null) => {}
            Some(v) => {
                if !sha_ok(v.as_str()?) {
                    return None;
                }
            }
        }
        opt_null_str(o, "error", 1000)?;
        match o.get("ciRefusal") {
            None | Some(Value::Null) => {}
            Some(v) => {
                let c = v.as_object()?;
                str_len_ok(c.get("code")?, 0, 40)?;
                opt_null_str(c, "mergeState", 40)?;
                str_array_ok(c.get("checks")?)?;
            }
        }
        if let Some(v) = o.get("ignoredChecks") {
            str_array_ok(v)?;
        }
        if let Some(v) = o.get("noPrChecks") {
            v.as_bool()?;
        }
        opt_null_str(o, "ghUserUsed", 100)?;
        Some(())
    })();
    ok.is_some()
}

fn sha_ok(h: &str) -> bool {
    h.len() == 40 && h.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f'))
}

pub async fn results_route(
    State(up): State<Arc<Upstream>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let (bytes, parsed) = match super::ask::read_bytes(&parts.headers, body).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    if !results_shape_ok(parsed.as_ref()) {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD_RESULT);
    }
    super::msg_post::to_ts((*up).clone(), peer, parts, bytes).await
}

pub async fn checks_route(
    State(up): State<Arc<Upstream>>,
    RequireAccount(me, auth): RequireAccount,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let (parts, body) = req.into_parts();
    let (bytes, parsed) = match super::ask::read_bytes(&parts.headers, body).await {
        Ok(v) => v,
        Err(r) => return r,
    };
    if !through_operator(&me, &auth) {
        return json_err(StatusCode::FORBIDDEN, "forbidden", FORBIDDEN);
    }
    if !shape_ok(parsed.as_ref()) {
        return json_err(StatusCode::BAD_REQUEST, "bad_request", BAD);
    }
    super::msg_post::to_ts((*up).clone(), peer, parts, bytes).await
}

pub fn routes(
    up: Upstream,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<Upstream>>::new()
        .post("/agent/merge-checks", checks_route)
        .post("/agent/merge-results", results_route)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(up)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shape_like_zod() {
        let ok = json!({ "leaseId": "00000000-0000-4000-8000-000000000000", "token": "t", "repo": "o/r", "number": 3, "headSha": "a".repeat(40), "ghUser": "bot-1", "x": 1 });
        assert!(shape_ok(Some(&ok)));
        assert!(!shape_ok(None));
        for (k, v) in [
            ("number", json!(0)),
            ("number", json!(1.5)),
            ("headSha", json!("A".repeat(40))),
            ("repo", json!("ab")),
            ("ghUser", json!("-bad")),
            ("ghUser", json!(null)),
        ] {
            let mut b = ok.clone();
            b[k] = v;
            assert!(!shape_ok(Some(&b)), "{k}");
        }
    }

    #[test]
    fn results_shape_like_zod() {
        let ok = json!({ "leaseId": "00000000-0000-4000-8000-000000000000", "token": "t", "repo": "o/r", "number": 3,
            "headSha": "a".repeat(40), "result": "merged", "mergeSha": null, "error": null,
            "ciRefusal": { "code": "checks_failed", "mergeState": null, "checks": ["ci"] },
            "ignoredChecks": ["x"], "noPrChecks": true, "ghUserUsed": null, "extra": 1 });
        assert!(results_shape_ok(Some(&ok)));
        assert!(!results_shape_ok(None));
        for (k, v) in [
            ("result", json!("done")),
            ("mergeSha", json!("B".repeat(40))),
            ("error", json!("e".repeat(1001))),
            ("ciRefusal", json!({ "code": "c" })),
            ("ignoredChecks", json!(null)),
            ("noPrChecks", json!(null)),
            ("ghUserUsed", json!(1)),
        ] {
            let mut b = ok.clone();
            b[k] = v;
            assert!(!results_shape_ok(Some(&b)), "{k}");
        }
    }
}
