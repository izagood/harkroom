//! S5.4 — API 막힘 카드(TS `services/blockedCards.ts`)의 순수한 몫: 카드를 세우는 거절 코드, 사유 글자, 카드 경로·키·
//! 요청 글자·본문·번역 표지(`system.apiBlocked*`)·`meta.blocked`. 카드 본문은 TS 처럼 한국어 고정 문구이고, 영어는 앱이
//! 번역 표지(`i18n`)와 `blocked.why.<code>` 사전으로 옮긴다. DB 쓰기는 `api_checks` 가 한다.
use super::api_results::js_slice;
use serde_json::{Value, json};

/// TS `API_CARD_CODES`.
pub const API_CARD_CODES: &[&str] = &[
    "not_granted",
    "no_connector",
    "no_secret",
    "secret_expired",
    "expired",
    "suspended",
    "method_not_allowed",
    "path_not_allowed",
    "cause_not_human",
    "operator_update_required",
];

pub fn is_card_code(code: &str) -> bool {
    API_CARD_CODES.contains(&code)
}

/// TS `reasonText[code] ?? code`.
pub fn reason_text(code: &str) -> &str {
    match code {
        "not_granted" => "권한 없음",
        "no_connector" => "연결 없음",
        "no_secret" => "키 없음",
        "secret_expired" => "키 만료",
        "expired" => "권한 만료",
        "suspended" => "권한 멈춤",
        "method_not_allowed" => "메서드 밖",
        "path_not_allowed" => "경로 밖",
        "cause_not_human" => "사람 글 턴 아님",
        "operator_update_required" => "앱을 올려야 함",
        c => c,
    }
}

/// TS `cardPath`. 바깥 `None` 은 Rust 가 `safePath` 를 못 따라가는 경로(`%`·ASCII 밖) — TS 에 맡긴다.
pub fn card_path(path: &str) -> Option<Option<String>> {
    if !super::api_checks::safe_path(path) || path.contains('`') {
        return Some(None);
    }
    Some(Some(js_slice(path.split('?').next().unwrap_or(""), 200)))
}

/// TS `key` — `api:<agent>:<target>:<threadRoot>:<UTC 날짜>`. `now` 는 ISO(`…Z`).
pub fn card_key(agent: &str, connector_id: Option<&str>, thread_root: &str, now: &str) -> String {
    let target = match connector_id {
        Some(c) => format!("connector:{c}"),
        None => "connector-name:*".to_owned(),
    };
    let day = now.get(..10).unwrap_or(now);
    format!("api:{agent}:{target}:{thread_root}:{day}")
}

/// TS `request`.
pub fn card_request(method: &str, path: Option<&str>) -> String {
    format!("{method} {}", path.unwrap_or("(경로 생략)"))
}

/// TS `meta.connectorName` — 없는 연결이면 이름이 연결 이름 꼴일 때만.
pub fn card_connector_name(connector_id: Option<&str>, name: &str) -> Option<String> {
    if connector_id.is_some() || super::api_results::connector_ok(name) {
        Some(name.to_owned())
    } else {
        None
    }
}

/// TS 카드 본문(`@` 무력화까지).
pub fn card_body(handle: &str, connector_name: Option<&str>, request: &str, code: &str) -> String {
    let name = connector_name.unwrap_or("(연결 없음)");
    format!(
        "🔒 {handle} 의 API 호출이 막혔다 · {name} `{request}` · {}",
        reason_text(code)
    )
    .replace('@', "＠")
}

/// TS `systemI18n('system.apiBlocked' | 'system.apiBlocked.noConnector', …)` — 문자열 인자는 200 UTF-16 단위로 자른다.
pub fn card_i18n(agent: &str, connector_name: Option<&str>, request: &str, code: &str) -> Value {
    let c = |s: &str| js_slice(s, 200);
    match connector_name {
        Some(n) => json!({ "key": "system.apiBlocked", "args": {
            "agentId": c(agent), "connector": c(n), "request": c(request), "code": c(code) } }),
        None => json!({ "key": "system.apiBlocked.noConnector", "args": {
            "agentId": c(agent), "request": c(request), "code": c(code) } }),
    }
}

/// 새 카드의 TS `BlockedMeta`.
pub struct NewMeta<'a> {
    pub key: &'a str,
    pub agent: &'a str,
    pub owner: Option<&'a str>,
    pub code: &'a str,
    pub now: &'a str,
    pub connector_id: Option<&'a str>,
    pub connector_name: Option<&'a str>,
    pub method: &'a str,
    pub path: Option<&'a str>,
}

pub fn card_meta(m: &NewMeta<'_>) -> Value {
    json!({
        "key": m.key, "kind": "api", "agentId": m.agent, "ownerAccountId": m.owner,
        "code": m.code, "lastCode": m.code, "count": 1, "firstAt": m.now, "lastAt": m.now,
        "connectorId": m.connector_id, "connectorName": m.connector_name,
        "method": m.method, "path": m.path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_and_reasons_like_ts() {
        assert_eq!(API_CARD_CODES.len(), 10);
        assert!(is_card_code("not_granted"));
        assert!(!is_card_code("lease_invalid"));
        assert!(!is_card_code("chain_broken"));
        assert!(!is_card_code("bad_path"));
        assert_eq!(reason_text("not_granted"), "권한 없음");
        assert_eq!(reason_text("cause_not_human"), "사람 글 턴 아님");
        assert_eq!(reason_text("weird"), "weird");
    }

    #[test]
    fn path_key_request_like_ts() {
        assert_eq!(card_path("/x?a=1"), Some(Some("/x".into())));
        assert_eq!(card_path("/a`b"), Some(None));
        assert_eq!(card_path("x"), Some(None));
        assert_eq!(card_path("/a%2e"), Some(None));
        assert_eq!(card_path("/a%2Fb?x"), Some(Some("/a%2Fb".into())));
        assert_eq!(
            card_path(&format!("/{}", "a".repeat(300)))
                .unwrap()
                .unwrap()
                .len(),
            200
        );
        assert_eq!(
            card_key("A", Some("C"), "T", "2026-11-18T13:00:00.000Z"),
            "api:A:connector:C:T:2026-11-18"
        );
        assert_eq!(
            card_key("A", None, "T", "2026-11-18T13:00:00.000Z"),
            "api:A:connector-name:*:T:2026-11-18"
        );
        assert_eq!(card_request("GET", None), "GET (경로 생략)");
        assert_eq!(card_request("GET", Some("/x")), "GET /x");
    }

    #[test]
    fn body_and_i18n_like_ts() {
        assert_eq!(
            card_body("bot@x", Some("lab"), "GET /a@b", "not_granted"),
            "🔒 bot＠x 의 API 호출이 막혔다 · lab `GET /a＠b` · 권한 없음"
        );
        assert_eq!(
            card_body("bot", None, "GET /x", "no_connector"),
            "🔒 bot 의 API 호출이 막혔다 · (연결 없음) `GET /x` · 연결 없음"
        );
        assert_eq!(card_connector_name(None, "Bad Name"), None);
        assert_eq!(card_connector_name(None, "lab").as_deref(), Some("lab"));
        assert_eq!(
            card_connector_name(Some("c"), "Bad").as_deref(),
            Some("Bad")
        );
        assert_eq!(
            card_i18n("A", Some("lab"), "GET /x", "not_granted"),
            json!({ "key": "system.apiBlocked", "args": { "agentId": "A", "connector": "lab", "request": "GET /x", "code": "not_granted" } })
        );
        assert_eq!(
            card_i18n("A", None, "GET /x", "no_connector")["key"],
            json!("system.apiBlocked.noConnector")
        );
        let m = card_meta(&NewMeta {
            key: "k",
            agent: "A",
            owner: None,
            code: "not_granted",
            now: "N",
            connector_id: Some("C"),
            connector_name: Some("lab"),
            method: "GET",
            path: None,
        });
        assert_eq!(m["count"], json!(1));
        assert_eq!(m["lastCode"], json!("not_granted"));
        assert_eq!(m["path"], Value::Null);
        assert_eq!(m["ownerAccountId"], Value::Null);
    }
}
