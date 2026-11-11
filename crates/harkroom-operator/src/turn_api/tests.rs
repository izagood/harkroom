//! TS `turnApi.test.ts` 와 같은 줄거리.
use super::*;
use std::sync::Mutex as M;

const AGENT: &str = "11111111-2222-4333-8444-555555555555";

/// 시험용 가짜 키(쪼개 쓴다 — 비밀 탐지기가 진짜로 읽지 않게).
fn key() -> String {
    ["fake", "-ke", "y-0123", "4567", "89ab", "cdef"].concat()
}

fn lease() -> TurnLease {
    TurnLease {
        lease_id: "L1".into(),
        token: "T1".into(),
        agent_id: AGENT.into(),
    }
}

fn call(args: Value) -> RunnerLinkRequest {
    RunnerLinkRequest::McpRequest {
        id: "r1".into(),
        payload: json!({"jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": {"name": API_TOOL, "arguments": args}}),
        cause: Some("c1".into()),
        cwd: None,
        turn_id: None,
        command_files: None,
    }
}

#[derive(Clone, Debug)]
struct Sent {
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
}

type Log = Arc<M<Vec<Sent>>>;

fn fake(replies: Vec<Result<ApiReply, String>>) -> (ApiFetch, Log) {
    let log: Log = Arc::new(M::new(Vec::new()));
    let q = Arc::new(M::new(
        replies
            .into_iter()
            .collect::<std::collections::VecDeque<_>>(),
    ));
    let l = log.clone();
    let f: ApiFetch = Arc::new(move |r: &ApiRequest<'_>| {
        l.lock().unwrap().push(Sent {
            method: r.method.into(),
            url: r.url.into(),
            headers: r.headers.to_vec(),
            body: r.body.clone().map(|b| String::from_utf8(b).unwrap()),
        });
        q.lock()
            .unwrap()
            .pop_front()
            .unwrap_or(Err("unscripted".into()))
    });
    (f, log)
}

fn reply(status: u16, body: &str) -> Result<ApiReply, String> {
    Ok(ApiReply {
        status,
        content_type: Some("application/json".into()),
        location: None,
        body: body.as_bytes().to_vec(),
        read: body.len(),
        truncated: false,
    })
}

fn api(f: ApiFetch) -> TurnApi {
    TurnApi::new(f, Arc::new(|| 1_000.0))
}

fn grant(extra: Value) -> String {
    let mut g = json!({"allowed": true, "baseUrl": "https://api.example.com", "authKind": "bearer",
        "valueBase64": base64::engine::general_purpose::STANDARD.encode(key())});
    for (k, v) in extra.as_object().unwrap() {
        g[k] = v.clone();
    }
    g.to_string()
}

type PostFn = dyn Fn(&str, String) -> Result<(u16, String), String>;
type Posts = Arc<M<Vec<(String, Value)>>>;

/// 서버 판정 자리 가짜 — api-checks 는 `check` 로, api-results 는 201.
fn server(check: (u16, String)) -> (Box<PostFn>, Posts) {
    let posts: Posts = Arc::new(M::new(Vec::new()));
    let p = posts.clone();
    (
        Box::new(move |path: &str, body: String| {
            p.lock()
                .unwrap()
                .push((path.into(), serde_json::from_str(&body).unwrap()));
            if path == API_CHECKS_PATH {
                Ok(check.clone())
            } else {
                Ok((201, "{}".into()))
            }
        }),
        posts,
    )
}

fn out(r: Option<RunnerLinkResponse>) -> (Value, bool) {
    let Some(RunnerLinkResponse::McpResponse { messages, .. }) = r else {
        panic!("응답 없음")
    };
    let res = &messages[0]["result"];
    let v: Value = serde_json::from_str(res["content"][0]["text"].as_str().unwrap()).unwrap();
    (v, res.get("isError").is_some())
}

fn go(t: &TurnApi, args: Value, post: &PostFn) -> (Value, bool) {
    let l = lease();
    out(t.maybe_handle(AGENT, &call(args), Some(&l), post, &|_| {}))
}

#[test]
fn 인자_모양() {
    let ok = args_of(&json!({"params": {"arguments": {"connector": "gh", "method": "post", "path": "/x", "body": "{}"}}})).unwrap();
    assert_eq!(ok.method, "POST");
    assert_eq!(ok.content_type.as_deref(), Some("application/json"));
    for bad in [
        json!({"connector": "GH", "method": "GET", "path": "/x"}),
        json!({"connector": "gh", "method": "HEAD", "path": "/x"}),
        json!({"connector": "gh", "method": "GET", "path": "https://evil/x"}),
        json!({"connector": "gh", "method": "GET", "path": "/x", "body": "a"}),
        json!({"connector": "gh", "method": "GET", "path": "/x", "headers": {}}),
        json!({"connector": "gh", "method": "POST", "path": "/x", "body": 1}),
        json!({"connector": "gh", "method": "POST", "path": "/x", "body": "{}", "contentType": "text/plain\r\nx: y"}),
    ] {
        assert!(
            args_of(&json!({"params": {"arguments": bad}})).is_err(),
            "{bad}"
        );
    }
    assert!(is_content_type("application/json; charset=utf-8"));
    assert!(!is_content_type("application/json; boundary=x"));
}

#[test]
fn 가리기() {
    let k = key();
    let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(&k);
    let s = scrub_value(&format!("a {k} b {b64} c"), &k);
    assert!(!s.contains(&k) && !s.contains(&b64));
    assert_eq!(scrub_value("short", "short"), "short");
    let v = "abc def/ghij";
    assert_eq!(scrub_value("q=abc%20def%2Fghij", v), "q=[REDACTED]");
}

#[test]
fn 통과하면_bearer_로_부르고_결과에_키가_없고_보고한다() {
    let (f, sent) = fake(vec![reply(200, &format!("{{\"echo\":\"{}\"}}", key()))]);
    let (post, posts) = server((200, grant(json!({}))));
    let (v, err) = go(
        &api(f),
        json!({"connector": "gh", "method": "GET", "path": "/user?x=1"}),
        &post,
    );
    assert!(!err);
    assert_eq!(v["status"], 200);
    assert!(!v.to_string().contains(&key()));
    let s = sent.lock().unwrap();
    assert_eq!(s[0].url, "https://api.example.com/user?x=1");
    assert_eq!(s[0].method, "GET");
    assert!(
        s[0].headers
            .contains(&("authorization".into(), format!("Bearer {}", key())))
    );
    let p = posts.lock().unwrap();
    assert_eq!(p[1].0, API_RESULTS_PATH);
    assert_eq!(p[1].1["status"], 200);
    assert_eq!(p[0].1["caps"], json!(["token_exchange"]));
}

#[test]
fn header_종류는_그_헤더에() {
    let (f, sent) = fake(vec![reply(200, "{}")]);
    let (post, _) = server((
        200,
        grant(json!({"authKind": "header", "authHeader": "X-Api-Key"})),
    ));
    go(
        &api(f),
        json!({"connector": "gh", "method": "POST", "path": "/x", "body": "{}"}),
        &post,
    );
    let s = sent.lock().unwrap();
    assert!(s[0].headers.contains(&("x-api-key".into(), key())));
    assert!(
        s[0].headers
            .contains(&("content-type".into(), "application/json".into()))
    );
    assert_eq!(s[0].body.as_deref(), Some("{}"));
}

#[test]
fn 리다이렉트는_location_만() {
    let mut r = reply(302, "").unwrap();
    r.location = Some(format!("https://other.example/?k={}", key()));
    let (f, _) = fake(vec![Ok(r)]);
    let (post, _) = server((200, grant(json!({}))));
    let (v, err) = go(
        &api(f),
        json!({"connector": "gh", "method": "GET", "path": "/r"}),
        &post,
    );
    assert!(!err);
    assert_eq!(v["note"], "redirects are not followed");
    assert!(!v["location"].as_str().unwrap().contains(&key()));
}

#[test]
fn 서버가_거절하면_부르지_않는다() {
    let (f, sent) = fake(vec![]);
    let (post, _) = server((403, json!({"error": {"code": "not_granted"}}).to_string()));
    let (v, err) = go(
        &api(f),
        json!({"connector": "gh", "method": "GET", "path": "/x"}),
        &post,
    );
    assert!(err);
    assert_eq!(v["error"]["code"], "not_granted");
    assert_eq!(v["blocked"], true);
    assert!(sent.lock().unwrap().is_empty());
    // 닿지 않으면 fail-closed.
    let (f, sent) = fake(vec![]);
    let (v, _) = go(
        &api(f),
        json!({"connector": "gh", "method": "GET", "path": "/x"}),
        &|_, _| Err("down".into()),
    );
    assert_eq!(v["error"]["code"], "unavailable");
    assert!(sent.lock().unwrap().is_empty());
}

#[test]
fn origin_을_벗어나면_부르지_않는다() {
    for p in ["//evil.example/x", "/\\evil.example/x", "/a b"] {
        let (f, sent) = fake(vec![]);
        let (post, posts) = server((200, grant(json!({"path": p}))));
        let (v, err) = go(
            &api(f),
            json!({"connector": "gh", "method": "GET", "path": "/x"}),
            &post,
        );
        assert!(err, "{p}");
        assert!(
            matches!(
                v["error"]["code"].as_str(),
                Some("origin_mismatch" | "bad_url")
            ),
            "{p} {v}"
        );
        assert!(sent.lock().unwrap().is_empty());
        assert_eq!(posts.lock().unwrap()[1].0, API_RESULTS_PATH);
    }
    assert!(build_url("https://api.example.com/base", "/x").is_err());
    assert!(build_url("http://api.example.com", "/x").is_err());
    assert_eq!(
        build_url("https://api.example.com:8443", "/x#frag").unwrap(),
        "https://api.example.com:8443/x"
    );
}

#[test]
fn 임대가_없으면_서버에도_묻지_않는다() {
    let (f, _) = fake(vec![]);
    let (post, posts) = server((200, grant(json!({}))));
    let r = api(f).maybe_handle(
        AGENT,
        &call(json!({"connector": "gh", "method": "GET", "path": "/x"})),
        None,
        &post,
        &|_| {},
    );
    assert_eq!(out(r).0["error"]["code"], "no_lease");
    assert!(posts.lock().unwrap().is_empty());
    // 다른 에이전트의 임대도 안 된다.
    let other = TurnLease {
        lease_id: "L".into(),
        token: "T".into(),
        agent_id: "x".into(),
    };
    let (f, _) = fake(vec![]);
    let r = api(f).maybe_handle(
        AGENT,
        &call(json!({"connector": "gh", "method": "GET", "path": "/x"})),
        Some(&other),
        &post,
        &|_| {},
    );
    assert_eq!(out(r).0["error"]["code"], "no_lease");
}

#[test]
fn 호출_실패_문구에서도_키를_가린다() {
    let (f, _) = fake(vec![Err(format!("connect failed for {}", key()))]);
    let (post, posts) = server((200, grant(json!({}))));
    let (v, err) = go(
        &api(f),
        json!({"connector": "gh", "method": "GET", "path": "/x"}),
        &post,
    );
    assert!(err);
    assert_eq!(v["error"]["code"], "unreachable");
    assert!(!v.to_string().contains(&key()));
    assert!(!posts.lock().unwrap()[1].1.to_string().contains(&key()));
}

#[test]
fn api_call_이_아니면_건드리지_않는다() {
    let (f, _) = fake(vec![]);
    let req = RunnerLinkRequest::McpRequest {
        id: "r".into(),
        payload: json!({"method": "tools/call", "params": {"name": "repo.merge"}}),
        cause: None,
        cwd: None,
        turn_id: None,
        command_files: None,
    };
    assert!(
        api(f)
            .maybe_handle(AGENT, &req, None, &|_, _| Ok((200, String::new())), &|_| {})
            .is_none()
    );
}

fn exchange_grant() -> String {
    grant(
        json!({"authKind": "token_exchange", "tokenUrl": "https://auth.example.com/token",
        "tokenForm": {"grantType": "api_key", "clientId": "cli", "keyField": "apikey"}, "path": "/v2/x"}),
    )
}

#[test]
fn 토큰_교환_후_bearer_로_서버가_준_경로로() {
    let (f, sent) = fake(vec![
        reply(
            200,
            r#"{"access_token":"tok-AAAAAAAAAAAA","token_type":"Bearer","expires_in":3600}"#,
        ),
        reply(200, r#"{"t":"tok-AAAAAAAAAAAA"}"#),
    ]);
    let (post, _) = server((200, exchange_grant()));
    let (v, err) = go(
        &api(f),
        json!({"connector": "gh", "method": "GET", "path": "/x"}),
        &post,
    );
    assert!(!err, "{v}");
    assert!(!v.to_string().contains("tok-AAAAAAAAAAAA"));
    let s = sent.lock().unwrap();
    assert_eq!(s[0].url, "https://auth.example.com/token");
    assert_eq!(
        s[0].body.as_deref(),
        Some(format!("grant_type=api_key&client_id=cli&apikey={}", key()).as_str())
    );
    assert_eq!(s[1].url, "https://api.example.com/v2/x");
    assert!(
        s[1].headers
            .contains(&("authorization".into(), "Bearer tok-AAAAAAAAAAAA".into()))
    );
}

#[test]
fn 캐시와_401_한_번_재교환() {
    let (f, sent) = fake(vec![
        reply(200, r#"{"access_token":"tok-1111111111"}"#),
        reply(200, "{}"),
        reply(401, "{}"),
        reply(200, r#"{"access_token":"tok-2222222222"}"#),
        reply(200, "{}"),
    ]);
    let (post, posts) = server((200, exchange_grant()));
    let t = api(f);
    let a = json!({"connector": "gh", "method": "GET", "path": "/x"});
    go(&t, a.clone(), &post);
    let (_, err) = go(&t, a, &post);
    assert!(!err);
    let s = sent.lock().unwrap();
    assert_eq!(s.len(), 5);
    assert!(
        s[2].headers
            .contains(&("authorization".into(), "Bearer tok-1111111111".into()))
    );
    assert!(
        s[4].headers
            .contains(&("authorization".into(), "Bearer tok-2222222222".into()))
    );
    // 서버 판정은 매번.
    assert_eq!(
        posts
            .lock()
            .unwrap()
            .iter()
            .filter(|p| p.0 == API_CHECKS_PATH)
            .count(),
        2
    );
}

#[test]
fn 교환_실패는_상태만() {
    let k = key();
    for r in [
        reply(400, &format!("{{\"error\":\"bad {k}\"}}")),
        reply(302, ""),
        reply(
            200,
            r#"{"access_token":"tok-1111111111","token_type":"mac"}"#,
        ),
        reply(200, r#"{"access_token":"has space"}"#),
    ] {
        let (f, sent) = fake(vec![r]);
        let (post, _) = server((200, exchange_grant()));
        let (v, err) = go(
            &api(f),
            json!({"connector": "gh", "method": "GET", "path": "/x"}),
            &post,
        );
        assert!(err);
        assert_eq!(v["error"]["code"], "token_exchange_failed");
        assert!(!v.to_string().contains(&k));
        assert_eq!(sent.lock().unwrap().len(), 1);
    }
}

#[test]
fn 수명() {
    assert_eq!(token_ttl_seconds(Some(&json!(3600))), 3540.0);
    assert_eq!(token_ttl_seconds(Some(&json!(100))), 50.0);
    assert_eq!(token_ttl_seconds(Some(&json!(10))), 10.0);
    assert_eq!(token_ttl_seconds(None), 300.0);
    assert_eq!(token_ttl_seconds(Some(&json!(99999))), 3600.0);
}

#[test]
fn https_가_아닌_토큰_주소로는_보내지_않는다() {
    let (f, sent) = fake(vec![]);
    let form = TokenForm {
        grant_type: "a".into(),
        client_id: "b".into(),
        key_field: "c".into(),
    };
    for u in [
        "http://auth.example.com/t",
        "https://u:p@auth.example.com/t",
        "https://auth.example.com/t?x=1",
    ] {
        assert_eq!(exchange_token(&f, u, &form, &key()), Err(0));
    }
    assert!(sent.lock().unwrap().is_empty());
}
