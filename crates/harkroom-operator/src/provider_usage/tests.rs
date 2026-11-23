//! TS `test/providerUsage.test.ts`·`usageChain` 의 해석·고르기 경우를 옮긴다.
use super::*;
use serde_json::json;

const NOW: f64 = 1_700_000_000_000.0;

#[test]
fn iso_parse_matches_date_parse() {
    assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0.0));
    assert_eq!(
        parse_iso_ms("2026-11-11T11:29:19.123Z"),
        Some(1_794_396_559_123.0)
    );
    assert_eq!(
        parse_iso_ms("2026-11-11T20:29:19.123456+09:00"),
        Some(1_794_396_559_123.0)
    );
    assert_eq!(
        parse_iso_ms("2000-02-29T00:00:00-01:30"),
        Some(951_787_800_000.0)
    );
    assert_eq!(parse_iso_ms("nope"), None);
}

#[test]
fn claude_parse_full() {
    let raw = json!({
        "five_hour": {"utilization": 42.5, "resets_at": "1970-01-01T00:00:01Z"},
        "seven_day": {"utilization": 120, "resets_at": null},
        "seven_day_opus": {"utilization": -3},
        "seven_day_sonnet": null,
    });
    let m = parse_claude_oauth_usage(&raw, NOW);
    assert_eq!(
        serde_json::to_value(&m).unwrap(),
        json!({
            "fetchedAtMs": (NOW) as i64,
            "session": {"usedPercent": 42.5, "resetsAtMs": 1000},
            "weekly": {"usedPercent": 100.0, "resetsAtMs": null},
            "extra": [{"label": "Opus weekly", "window": {"usedPercent": 0.0, "resetsAtMs": null}}],
        })
    );
}

/// 실측 모양(2026-11): 모델별 주간 창은 `limits[]` 의 `weekly_scoped` 로만 오고 `seven_day_<모델>` 칸은 null 이다.
#[test]
fn claude_parse_weekly_scoped_model_limit() {
    let raw = json!({
        "five_hour": {"utilization": 4.0, "resets_at": "1970-01-01T00:00:01Z"},
        "seven_day": {"utilization": 28.0, "resets_at": "1970-01-01T00:00:02Z"},
        "seven_day_opus": null,
        "seven_day_sonnet": null,
        "limits": [
            {"kind": "session", "group": "session", "percent": 4, "resets_at": "1970-01-01T00:00:01Z", "scope": null},
            {"kind": "weekly_all", "group": "weekly", "percent": 28, "resets_at": "1970-01-01T00:00:02Z", "scope": null},
            {"kind": "weekly_scoped", "group": "weekly", "percent": 1, "resets_at": "1970-01-01T00:00:03Z",
             "scope": {"model": {"id": null, "display_name": "Fable"}, "surface": null}},
            {"kind": "weekly_scoped", "percent": 9, "scope": {"model": null, "surface": "x"}},
            {"kind": "weekly_scoped", "scope": {"model": {"display_name": "NoPercent"}}},
        ],
    });
    let m = parse_claude_oauth_usage(&raw, NOW);
    assert_eq!(
        serde_json::to_value(&m.extra).unwrap(),
        json!([{"label": "Fable weekly", "window": {"usedPercent": 1.0, "resetsAtMs": 3000}}])
    );
}

/// 옛 `seven_day_opus` 와 `limits[]` 가 같은 모델을 둘 다 말하면 하나만 싣는다.
#[test]
fn claude_parse_weekly_scoped_does_not_duplicate_legacy_key() {
    let raw = json!({
        "seven_day_opus": {"utilization": 10},
        "limits": [{"kind": "weekly_scoped", "percent": 10, "scope": {"model": {"display_name": "Opus"}}}],
    });
    let m = parse_claude_oauth_usage(&raw, NOW);
    assert_eq!(m.extra.unwrap().len(), 1);
}

#[test]
fn claude_parse_unknown_shape_is_empty_not_error() {
    let m = parse_claude_oauth_usage(&json!("x"), NOW);
    assert_eq!(
        serde_json::to_value(&m).unwrap(),
        json!({"fetchedAtMs": (NOW) as i64, "session": null, "weekly": null, "extra": []})
    );
}

#[test]
fn codex_parse_reset_at_then_after() {
    let raw = json!({
        "plan_type": "plus",
        "rate_limit": {
            "primary_window": {"used_percent": 10, "reset_at": 2, "limit_window_seconds": 18000},
            "secondary_window": {"used_percent": 50, "reset_after_seconds": 3, "limit_window_seconds": 90},
        }
    });
    let m = parse_codex_wham_usage(&raw, NOW);
    assert_eq!(
        serde_json::to_value(&m).unwrap(),
        json!({
            "fetchedAtMs": (NOW) as i64,
            "session": {"usedPercent": 10.0, "resetsAtMs": 2000, "windowMinutes": 300.0},
            "weekly": {"usedPercent": 50.0, "resetsAtMs": (NOW + 3000.0) as i64, "windowMinutes": 2.0},
            "plan": "plus",
        })
    );
}

#[test]
fn codex_parse_missing_rate_limit() {
    let m = parse_codex_wham_usage(&json!({}), NOW);
    assert_eq!(
        serde_json::to_value(&m).unwrap(),
        json!({"fetchedAtMs": (NOW) as i64, "session": null, "weekly": null})
    );
}

#[test]
fn error_labels() {
    assert_eq!(error_label(FetchError::Status(401)), "unauthorized");
    assert_eq!(error_label(FetchError::Status(403)), "unauthorized");
    assert_eq!(error_label(FetchError::Status(429)), "http-429");
    assert_eq!(error_label(FetchError::Timeout), "timeout");
    assert_eq!(error_label(FetchError::Network), "network");
}

fn ok() -> Measured {
    parse_codex_wham_usage(&json!({}), NOW)
}

#[test]
fn api_first_ok_skips_cli() {
    let m = api_then_cli(ok, || panic!("cli 를 띄우면 안 된다"));
    assert_eq!((m.source, m.error), (Some("api"), None));
}

#[test]
fn api_first_falls_back_to_cli_on_any_error() {
    // 만료 토큰(unauthorized)도 CLI 로 넘긴다 — CLI 는 토큰을 갱신하고 이 프로세스는 하지 않는다.
    for e in ["no-credentials", "unauthorized", "http-429", "network"] {
        let m = api_then_cli(|| Measured::failed(NOW, e), ok);
        assert_eq!((m.source, m.error), (Some("cli"), None), "{e}");
    }
}

#[test]
fn api_first_both_fail_picks_like_cli_then_api() {
    let m = api_then_cli(
        || Measured::failed(NOW, "unauthorized"),
        || Measured::failed(NOW, "cli-error"),
    );
    assert_eq!(
        (m.source, m.error.as_deref()),
        (Some("api"), Some("unauthorized"))
    );
    let m = api_then_cli(
        || Measured::failed(NOW, "timeout"),
        || Measured::failed(NOW, "cli-unparsed"),
    );
    assert_eq!(
        (m.source, m.error.as_deref()),
        (Some("cli"), Some("cli-unparsed"))
    );
}

#[test]
fn chain_cli_ok_skips_api() {
    let m = cli_then_api(ok, || panic!("api 를 부르면 안 된다"));
    assert_eq!(m.source, Some("cli"));
    assert_eq!(serde_json::to_value(&m).unwrap()["source"], "cli");
}

#[test]
fn chain_falls_back_to_api() {
    let m = cli_then_api(|| Measured::failed(NOW, "cli-unavailable"), ok);
    assert_eq!((m.source, m.error), (Some("api"), None));
}

#[test]
fn chain_both_fail_auth_prefers_api_error() {
    for e in ["unauthorized", "no-credentials"] {
        let m = cli_then_api(
            || Measured::failed(NOW, "cli-error"),
            || Measured::failed(NOW, e),
        );
        assert_eq!((m.source, m.error.as_deref()), (Some("api"), Some(e)));
    }
}

#[test]
fn chain_both_fail_other_keeps_cli_error() {
    let m = cli_then_api(
        || Measured::failed(NOW, "cli-unparsed"),
        || Measured::failed(NOW, "timeout"),
    );
    assert_eq!(
        (m.source, m.error.as_deref()),
        (Some("cli"), Some("cli-unparsed"))
    );
    let v = serde_json::to_value(&m).unwrap();
    assert_eq!(
        v.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["fetchedAtMs", "session", "weekly", "error", "source"]
    );
}

#[test]
fn js_round_half_up() {
    assert_eq!(js_round(2.5), 3.0);
    assert_eq!(js_round(-2.5), -2.0);
}

// ── 토큰 읽기·API 조회(c3d-1 뒤쪽) ───────────────────────────────────────────

use std::cell::RefCell;

type Seen = Vec<(String, Vec<(String, String)>)>;

struct FakeHttp {
    reply: Result<Value, FetchError>,
    seen: RefCell<Seen>,
}

impl UsageHttp for FakeHttp {
    fn get_json(&self, url: &str, headers: &[(&str, &str)]) -> Result<Value, FetchError> {
        self.seen.borrow_mut().push((
            url.into(),
            headers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        ));
        self.reply.clone()
    }
}

fn fake(reply: Result<Value, FetchError>) -> FakeHttp {
    FakeHttp {
        reply,
        seen: RefCell::new(vec![]),
    }
}

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("hk-pu-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn claude_credentials_file_parse() {
    let d = tmpdir("cc");
    fs::write(
        d.join(".credentials.json"),
        r#"{"claudeAiOauth":{"accessToken":"t1","expiresAt":5}}"#,
    )
    .unwrap();
    let t = read_claude_token(&d).unwrap();
    assert_eq!(
        (t.access_token.as_str(), t.expires_at_ms),
        ("t1", Some(5.0))
    );
    assert!(parse_claude_credentials(&json!({"claudeAiOauth":{"accessToken":""}})).is_none());
    assert!(parse_claude_credentials(&json!({})).is_none());
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn codex_auth_json_parse() {
    let d = tmpdir("cx");
    assert!(read_codex_token(&d).is_none());
    fs::write(
        d.join("auth.json"),
        r#"{"tokens":{"access_token":"a","account_id":"acc"}}"#,
    )
    .unwrap();
    let t = read_codex_token(&d).unwrap();
    assert_eq!(
        (t.access_token.as_str(), t.account_id.as_deref()),
        ("a", Some("acc"))
    );
    fs::write(
        d.join("auth.json"),
        r#"{"tokens":{"access_token":"a","account_id":3}}"#,
    )
    .unwrap();
    assert!(read_codex_token(&d).unwrap().account_id.is_none());
    fs::write(d.join("auth.json"), r#"{"tokens":{"access_token":""}}"#).unwrap();
    assert!(read_codex_token(&d).is_none());
    let _ = fs::remove_dir_all(&d);
}

#[test]
fn claude_fetch_paths() {
    let p = Path::new("/x");
    let h = fake(Ok(json!({"five_hour":{"utilization":10}})));
    let none = |_: &Path| None;
    assert_eq!(
        fetch_claude_provider_usage(p, NOW, &h, &none)
            .error
            .as_deref(),
        Some("no-credentials")
    );
    let expired = |_: &Path| {
        Some(ClaudeToken {
            access_token: "t".into(),
            expires_at_ms: Some(NOW),
        })
    };
    assert_eq!(
        fetch_claude_provider_usage(p, NOW, &h, &expired)
            .error
            .as_deref(),
        Some("token-expired")
    );
    assert!(h.seen.borrow().is_empty());
    let good = |_: &Path| {
        Some(ClaudeToken {
            access_token: "t".into(),
            expires_at_ms: None,
        })
    };
    let m = fetch_claude_provider_usage(p, NOW, &h, &good);
    assert_eq!(m.session.unwrap().used_percent, 10.0);
    let seen = h.seen.borrow();
    assert_eq!(seen[0].0, CLAUDE_OAUTH_USAGE_URL);
    assert_eq!(
        seen[0].1,
        vec![
            ("Authorization".into(), "Bearer t".into()),
            ("anthropic-beta".into(), "oauth-2025-04-20".into()),
            ("Accept".into(), "application/json".into()),
        ]
    );
    let bad = fake(Err(FetchError::Status(401)));
    let m = fetch_claude_provider_usage(p, NOW, &bad, &good);
    assert_eq!(
        serde_json::to_value(&m).unwrap(),
        json!({"fetchedAtMs": (NOW) as i64, "session": null, "weekly": null, "error": "unauthorized"})
    );
}

#[test]
fn codex_fetch_account_header_only_when_present() {
    let p = Path::new("/x");
    let h = fake(Ok(json!({"plan_type":"plus"})));
    let no_id = |_: &Path| {
        Some(CodexToken {
            access_token: "a".into(),
            account_id: None,
        })
    };
    assert_eq!(
        fetch_codex_provider_usage(p, NOW, &h, &no_id)
            .plan
            .as_deref(),
        Some("plus")
    );
    let with_id = |_: &Path| {
        Some(CodexToken {
            access_token: "a".into(),
            account_id: Some("acc".into()),
        })
    };
    fetch_codex_provider_usage(p, NOW, &h, &with_id);
    let seen = h.seen.borrow();
    assert!(!seen[0].1.iter().any(|(k, _)| k == "ChatGPT-Account-Id"));
    assert!(
        seen[1]
            .1
            .contains(&("ChatGPT-Account-Id".into(), "acc".into()))
    );
    assert_eq!(seen[1].0, CODEX_WHAM_USAGE_URL);
    let to = fake(Err(FetchError::Timeout));
    assert_eq!(
        fetch_codex_provider_usage(p, NOW, &to, &no_id)
            .error
            .as_deref(),
        Some("timeout")
    );
    let none = |_: &Path| None;
    assert_eq!(
        fetch_codex_provider_usage(p, NOW, &to, &none)
            .error
            .as_deref(),
        Some("no-credentials")
    );
}

/// 3xx 는 따라가지 않고 `http-3xx` 다 — Authorization 이 Location 으로 실려 가지 않는다(security c3d-3).
#[test]
fn ureq_does_not_follow_redirects() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (mut s, _) = listener.accept().unwrap();
        let mut buf = [0u8; 2048];
        let _ = s.read(&mut buf);
        let _ = s.write_all(
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        );
        // 두 번째 접속(리다이렉트를 따라온 것)은 없어야 한다.
        listener.set_nonblocking(true).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(200));
        listener.accept().is_err()
    });
    let r = UreqUsageHttp::default().get_json(
        &format!("http://127.0.0.1:{port}/usage"),
        &[("Authorization", "Bearer t")],
    );
    assert!(matches!(r, Err(FetchError::Status(302))), "{r:?}");
    assert_eq!(error_label(FetchError::Status(302)), "http-302");
    assert!(server.join().unwrap());
}

/// TS 의 `Date.now()` 처럼 정수로 낸다(로컬 실측에서 `1794399373105.0` 꼴로 나가던 것).
#[test]
fn ms_fields_serialize_as_integers_like_ts() {
    assert_eq!(ms_value(1794399373105.0).to_string(), "1794399373105");
    assert_eq!(ms_value(1.5).to_string(), "1.5");
    let mut m = Measured::failed(1794399373105.0, "no-credentials");
    m.session = Some(UsageWindow {
        used_percent: 12.5,
        resets_at_ms: Some(1794400000000.0),
        window_minutes: None,
    });
    let s = serde_json::to_string(&m).unwrap();
    assert!(s.contains("\"fetchedAtMs\":1794399373105,"), "{s}");
    assert!(s.contains("\"resetsAtMs\":1794400000000"), "{s}");
    assert!(s.contains("\"usedPercent\":12.5"), "{s}");
    assert!(!s.contains(".0,") && !s.contains(".0}"), "{s}");
}
