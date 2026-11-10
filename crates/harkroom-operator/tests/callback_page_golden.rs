//! 콜백 페이지(A5d)가 TS `callbackPage.ts::renderCallbackPage` 와 바이트까지 같은지 — `golden/callback_page.json` 은
//! TS 가 실제로 낸 페이지다(입력: 두 언어 × 다섯 종류 × 이름·사유 코드 네 갈래 — 이스케이프·공백 이름·UTF-16 자르기 포함).
use harkroom_operator::callback_page::{Kind, Lang, render};
use serde_json::Value;

#[test]
fn matches_ts_output() {
    let raw = include_str!("../golden/callback_page.json");
    let cases: Vec<Value> = serde_json::from_str(raw).unwrap();
    assert_eq!(cases.len(), 40);
    for c in cases {
        let i = &c["input"];
        let kind = match i["kind"].as_str().unwrap() {
            "ok" => Kind::Ok,
            "expired" => Kind::Expired,
            "denied" => Kind::Denied,
            "exchange_failed" => Kind::ExchangeFailed,
            "save_failed" => Kind::SaveFailed,
            k => panic!("{k}"),
        };
        let lang = if i["lang"] == "ko" {
            Lang::Ko
        } else {
            Lang::En
        };
        let p = render(kind, i["name"].as_str(), i["code"].as_str(), lang);
        assert_eq!(u64::from(p.status), c["status"].as_u64().unwrap(), "{i}");
        let headers: Vec<Value> = p
            .headers
            .iter()
            .map(|(k, v)| Value::Array(vec![Value::from(*k), Value::from(v.as_str())]))
            .collect();
        assert_eq!(Value::Array(headers), c["headers"], "{i}");
        assert_eq!(p.body, c["body"].as_str().unwrap(), "{i}");
    }
}
