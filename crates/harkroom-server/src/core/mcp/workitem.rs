//! `workitem.upsert`·`workitem.list`·`workitem.remove` — 「내 작업」 보드를 걷으며(P4) **저장하지 않는 도구**가 됐다.
//!
//! 도구 이름·스키마는 이번 판에 남긴다(지우는 것은 뒤 단계) — 예전 판 지시를 따르는 에이전트가 부르면 예전과 **같은 꼴의 성공**을
//! 돌려주고 DB 에는 닿지 않는다(표 `work_item` 은 남는다).
//! - upsert: 인자 검사(zod 와 같은 좁은 꼴 + avcs·상태 규칙)를 지나면 `{"item":{…}}` — 칸 이름·차례는 예전 `json_build_object` 와 같고,
//!   `id` 는 이번에만 쓰는 새 uuid, `updatedBy` 는 부른 계정, 시각은 지금이다. 스레드 가시성·상한처럼 DB 가 필요한 판정과
//!   `state: done` 의 위임장 끝내기(`work_done`)는 더 하지 않는다.
//! - list: `{"items":[]}`.
//! - remove: `{"removed":false}` — 지운 것이 없다.
//! - zod 가 거절할 인자는 `None`(앞단이 `unsupported_call` 로 답한다, 예전과 같다).
use super::respond::text_result;
use super::tools::{err, opt_uuid};
use crate::auth::Account;
use crate::lists::is_zod_uuid;
use serde_json::Value;

/// 예전 services/workItems.ts `WORK_ITEM_SOURCES`.
pub(crate) const WORK_ITEM_SOURCES: &[&str] = &["github", "jira", "slack", "other", "avcs"];

/// 인자가 zod 를 못 지나면 `None`. 저장한 것이 없으니 늘 `removed: false`.
pub fn remove(args: &Value) -> Option<String> {
    parse_remove(args)?;
    Some(text_result("{\"removed\":false}"))
}

/// 인자가 zod 를 못 지나면 `None`. 저장하지 않고 예전과 같은 꼴의 `{item}` 을 돌려준다.
pub fn upsert(me: &Account, args: &Value) -> Option<String> {
    let u = parse_upsert(args)?;
    if let Some(code) = arg_refusal(&u) {
        return Some(refusal(code));
    }
    let now = crate::core::operator_hub::now_iso();
    let item = item_json(&u, &uuid_v4()?, &me.id, &now);
    Some(text_result(&format!("{{\"item\":{item}}}")))
}

/// 인자가 zod 를 못 지나면 `None`. 저장한 것이 없으니 늘 빈 목록.
pub fn list(args: &Value) -> Option<String> {
    args.as_object()?;
    opt_uuid(args, "threadRootId")?;
    match args.get("source") {
        None => {}
        Some(Value::String(s)) if WORK_ITEM_SOURCES.contains(&s.as_str()) => {}
        Some(_) => return None,
    }
    Some(text_result("{\"items\":[]}"))
}

/// 예전 `upsertWorkItem` 의 판정 가운데 DB 없이 인자만으로 정해지는 것.
fn arg_refusal(u: &Upsert<'_>) -> Option<&'static str> {
    if u.source == "avcs" {
        if !avcs_key_ok(u.key) {
            return Some("bad_key");
        }
        if u.state.is_some() {
            return Some("state_not_allowed");
        }
        if u.thread.is_none() {
            return Some("thread_required");
        }
        None
    } else if u.state.is_none() {
        Some("state_required")
    } else {
        None
    }
}

/// 예전 `insert … returning json_build_object(…)` 와 같은 칸·같은 차례(serde_json 의 `Map` 은 키를 정렬하므로 손으로 잇는다).
fn item_json(u: &Upsert<'_>, id: &str, by: &str, now: &str) -> String {
    let j = |v: Option<&str>| v.map_or(Value::Null, Value::from).to_string();
    format!(
        "{{\"id\":{},\"source\":{},\"externalKey\":{},\"url\":{},\"title\":{},\"state\":{},\"threadRootId\":{},\"updatedBy\":{},\"createdAt\":{},\"updatedAt\":{}}}",
        j(Some(id)),
        j(Some(u.source)),
        j(Some(u.key)),
        j(u.url),
        j(Some(u.title)),
        j(u.state),
        j(u.thread),
        j(Some(by)),
        j(Some(now)),
        j(Some(now)),
    )
}

/// 소문자 v4 uuid.
fn uuid_v4() -> Option<String> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).ok()?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Some(format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    ))
}

/// zod `externalKey: z.string().trim().min(1).max(300)`. JS `trim` 이 지우는 글자 가운데 Rust `trim` 이 안 지우는 것(U+FEFF)이
/// 끝에 있으면 같은 값을 낼 수 없으니 `None`(→ `unsupported_call`).
pub fn parse_remove(args: &Value) -> Option<(&str, &str)> {
    let source = args.get("source")?.as_str()?;
    if !WORK_ITEM_SOURCES.contains(&source) {
        return None;
    }
    let key = zod_trimmed(args.get("externalKey")?, 300)?;
    Some((source, key))
}

/// zod `z.string().trim().min(1).max(max)` — 길이는 UTF-16 단위. JS `trim` 과 Rust `trim` 이 다르게 지우는 글자(U+FEFF 는 JS 만,
/// U+0085 는 Rust 만)가 들어 있으면 같은 값을 낸다고 장담할 수 없으니 `None`(→ `unsupported_call`).
fn zod_trimmed(v: &Value, max: usize) -> Option<&str> {
    let raw = v.as_str()?;
    if raw.contains(['\u{feff}', '\u{85}']) {
        return None;
    }
    let t = raw.trim();
    (1..=max).contains(&t.encode_utf16().count()).then_some(t)
}

const STATES: &[&str] = &["mine", "blocked", "active", "done"];

#[derive(Debug, PartialEq)]
pub struct Upsert<'a> {
    pub source: &'a str,
    pub key: &'a str,
    pub title: &'a str,
    pub url: Option<&'a str>,
    pub state: Option<&'a str>,
    pub thread: Option<&'a str>,
}

/// `null`·없음은 `Some(None)`, 맞는 값은 `Some(Some(_))`, 그 밖은 `None`(zod 거절).
fn nullable<'a>(v: Option<&'a Value>, ok: impl Fn(&'a str) -> bool) -> Option<Option<&'a str>> {
    match v {
        None | Some(Value::Null) => Some(None),
        Some(Value::String(s)) if ok(s) => Some(Some(s)),
        _ => None,
    }
}

/// zod `workItemUpsertSchema`. 모르는 키는 버린다. 거절할 인자는 `None`.
pub fn parse_upsert(args: &Value) -> Option<Upsert<'_>> {
    args.as_object()?;
    let source = args.get("source")?.as_str()?;
    if !WORK_ITEM_SOURCES.contains(&source) {
        return None;
    }
    Some(Upsert {
        source,
        key: zod_trimmed(args.get("externalKey")?, 300)?,
        title: zod_trimmed(args.get("title")?, 200)?,
        url: nullable(args.get("url"), safe_https_url)?,
        state: nullable(args.get("state"), |s| STATES.contains(&s))?,
        thread: nullable(args.get("threadRootId"), is_zod_uuid)?,
    })
}

/// zod `z.string().url().max(2000).refine(startsWith('https://'))` 의 **좁은 부분집합**. zod 는 `new URL()` 이 받으면 통과인데, WHATWG
/// 파서를 그대로 옮기지 않고 확실히 받는 꼴만 Rust 가 답한다 — 여기서 떨어진 값은 `unsupported_call` 이다.
/// 받는 꼴: `https://` + 호스트(`[A-Za-z0-9-]+` 마디를 `.` 로 이음, 마지막 마디는 글자로 시작 — 숫자·`0x` 로 끝나면 IPv4 로 읽혀
/// 실패할 수 있다, `xn--` 마디 없음) + 선택 `:포트`(1~5자리, 65535 이하) + `/`·`?`·`#` 로 시작하는 나머지(보이는 ASCII, 공백·`\\`·꺾쇠 등 없음).
pub fn safe_https_url(u: &str) -> bool {
    if u.len() > 2000 || !u.is_ascii() {
        return false;
    }
    let Some(rest) = u.strip_prefix("https://") else {
        return false;
    };
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (auth, tail) = rest.split_at(end);
    let (host, port) = match auth.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (auth, None),
    };
    let port_ok = |p: &str| {
        (1..=5).contains(&p.len())
            && p.bytes().all(|b| b.is_ascii_digit())
            && p.parse::<u32>().is_ok_and(|n| n <= 65535)
    };
    if port.is_some_and(|p| !port_ok(p)) {
        return false;
    }
    let labels: Vec<&str> = host.split('.').collect();
    let label_ok = |l: &&str| {
        !l.is_empty()
            && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !l.get(..4).is_some_and(|p| p.eq_ignore_ascii_case("xn--"))
    };
    if !labels.iter().all(label_ok)
        || !labels
            .last()
            .is_some_and(|l| l.as_bytes()[0].is_ascii_alphabetic())
    {
        return false;
    }
    tail.bytes().all(|b| {
        b.is_ascii_graphic()
            && !matches!(
                b,
                b'\\' | b'<' | b'>' | b'"' | b'`' | b'{' | b'}' | b'|' | b'^'
            )
    })
}

/// TS `AVCS_KEY = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\/[0-9a-f]{12,128}$/`.
pub fn avcs_key_ok(k: &str) -> bool {
    let segs: Vec<&str> = k.split('/').collect();
    let (last, front) = match segs.split_last() {
        Some(x) => x,
        None => return false,
    };
    !front.is_empty()
        && front.iter().all(|s| {
            !s.is_empty()
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
        })
        && (12..=128).contains(&last.len())
        && last.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// 예전 TS `WORK_ITEM_REFUSAL_MESSAGE` 의 글자(인자 판정 넷만).
fn refusal(code: &str) -> String {
    err(code, refusal_message(code))
}

fn refusal_message(code: &str) -> &'static str {
    match code {
        "bad_key" => "avcs externalKey must be <repo>/<intent oid>",
        "state_not_allowed" => "avcs items carry no state — it is read from the avcs server",
        "state_required" => "state is required for non-avcs items (mine | blocked | active | done)",
        _ => "avcs items must be attached to a thread (threadRootId)",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_upsert_like_zod() {
        let a = json!({"source": "github", "externalKey": " acme/x#1 ", "title": " PR ", "state": "active",
            "url": "https://example.com/pr/1?x=1#f", "threadRootId": null, "extra": 1});
        assert_eq!(
            parse_upsert(&a),
            Some(Upsert {
                source: "github",
                key: "acme/x#1",
                title: "PR",
                url: Some("https://example.com/pr/1?x=1#f"),
                state: Some("active"),
                thread: None
            })
        );
        let min = json!({"source": "avcs", "externalKey": "k", "title": "t"});
        assert_eq!(
            parse_upsert(&min).map(|u| (u.url, u.state, u.thread)),
            Some((None, None, None))
        );
        for bad in [
            json!({"source": "github", "externalKey": "k"}),
            json!({"source": "github", "externalKey": "k", "title": "  "}),
            json!({"source": "github", "externalKey": "k", "title": "a".repeat(201)}),
            json!({"source": "github", "externalKey": "k", "title": "t", "state": "closed"}),
            json!({"source": "github", "externalKey": "k", "title": "t", "url": "http://example.com"}),
            json!({"source": "github", "externalKey": "k", "title": "t", "url": 1}),
            json!({"source": "github", "externalKey": "k", "title": "t", "threadRootId": "x"}),
            json!({"source": "github", "externalKey": "k", "title": "t\u{85}"}),
            json!([]),
        ] {
            assert_eq!(parse_upsert(&bad), None, "{bad}");
        }
        assert!(
            parse_upsert(&json!({"source": "jira", "externalKey": "k", "title": "a".repeat(200)}))
                .is_some()
        );
    }

    #[test]
    fn https_subset() {
        for ok in [
            "https://example.com",
            "https://a.b-c.example:8443/p?q=1#x",
            "https://localhost/",
            "https://1.example.com/%41",
        ] {
            assert!(safe_https_url(ok), "{ok}");
        }
        for no in [
            "http://example.com",
            "HTTPS://example.com",
            "https://",
            "https://999.1.1.1/",
            "https://1.2.3.4",
            "https://a.0x1f",
            "https://xn--zz.example",
            "https://a..b",
            "https://u@example.com",
            "https://example.com:",
            "https://example.com:99999",
            "https://example.com/a b",
            "https://example.com/\\",
            "https://例.com",
        ] {
            assert!(!safe_https_url(no), "{no}");
        }
    }

    #[test]
    fn avcs_key_like_regex() {
        assert!(avcs_key_ok("repo/abcdef012345"));
        assert!(avcs_key_ok("org/sub.repo_x-1/abcdef012345abcdef"));
        for no in [
            "abcdef012345",
            "/abcdef012345",
            "repo//abcdef012345",
            "repo/ABCDEF012345",
            "repo/abcdef01234",
            "re po/abcdef012345",
            &format!("r/{}", "a".repeat(129)),
        ] {
            assert!(!avcs_key_ok(no), "{no}");
        }
    }

    #[test]
    fn parse_remove_like_zod() {
        let ok = json!({"source": "github", "externalKey": "  acme/x#1 ", "extra": 1});
        assert_eq!(parse_remove(&ok), Some(("github", "acme/x#1")));
        assert_eq!(
            parse_remove(&json!({"source": "gitlab", "externalKey": "a"})),
            None
        );
        assert_eq!(
            parse_remove(&json!({"source": "jira", "externalKey": "   "})),
            None
        );
        assert_eq!(parse_remove(&json!({"source": "jira"})), None);
        assert_eq!(
            parse_remove(&json!({"source": "jira", "externalKey": "a".repeat(301)})),
            None
        );
        assert!(parse_remove(&json!({"source": "jira", "externalKey": "a".repeat(300)})).is_some());
        assert_eq!(
            parse_remove(&json!({"source": "jira", "externalKey": "\u{feff}a"})),
            None
        );
    }

    fn account() -> Account {
        Account {
            id: "22222222-2222-4222-8222-222222222222".into(),
            handle: "bot".into(),
            display_name: "bot".into(),
            kind: "agent".into(),
            is_admin: false,
            role: "member".into(),
            status: "active".into(),
            status_text: None,
            avatar_attachment_id: None,
        }
    }

    fn text(body: &str) -> String {
        let v: Value = serde_json::from_str(body).unwrap();
        v["content"][0]["text"].as_str().unwrap().to_string()
    }

    /// 예전 `json_build_object` 와 칸 이름·차례·null 표기가 글자까지 같다.
    #[test]
    fn item_shape_unchanged() {
        let a = json!({"source": "github", "externalKey": "acme/x#1", "title": "a \"b\"", "state": "active"});
        assert_eq!(
            item_json(&parse_upsert(&a).unwrap(), "I", "B", "T"),
            r#"{"id":"I","source":"github","externalKey":"acme/x#1","url":null,"title":"a \"b\"","state":"active","threadRootId":null,"updatedBy":"B","createdAt":"T","updatedAt":"T"}"#
        );
    }

    #[test]
    fn noop_answers() {
        let t = "11111111-1111-4111-8111-111111111111";
        let a = json!({"source": "github", "externalKey": "k", "title": "t", "state": "done", "threadRootId": t});
        let me = account();
        let out: Value = serde_json::from_str(&text(&upsert(&me, &a).unwrap())).unwrap();
        let item = &out["item"];
        assert!(is_zod_uuid(item["id"].as_str().unwrap()));
        assert_eq!(item["updatedBy"], me.id.as_str());
        assert_eq!(item["state"], "done");
        assert_eq!(item["threadRootId"], t);
        assert_eq!(item["createdAt"], item["updatedAt"]);
        assert!(item["createdAt"].as_str().unwrap().ends_with('Z'));
        assert_eq!(text(&list(&json!({})).unwrap()), "{\"items\":[]}");
        assert_eq!(
            text(&list(&json!({"source": "jira", "threadRootId": t})).unwrap()),
            "{\"items\":[]}"
        );
        assert_eq!(
            text(&remove(&json!({"source": "jira", "externalKey": "a"})).unwrap()),
            "{\"removed\":false}"
        );
        assert!(list(&json!({"source": "gitlab"})).is_none());
        assert!(remove(&json!({"source": "gitlab", "externalKey": "a"})).is_none());
        assert!(upsert(&me, &json!({})).is_none());
    }

    #[test]
    fn arg_refusals_kept() {
        let r = |a: Value| arg_refusal(&parse_upsert(&a).unwrap());
        let k = "repo/abcdef012345";
        let t = "11111111-1111-4111-8111-111111111111";
        assert_eq!(
            r(json!({"source": "jira", "externalKey": "k", "title": "t"})),
            Some("state_required")
        );
        assert_eq!(
            r(json!({"source": "avcs", "externalKey": "k", "title": "t"})),
            Some("bad_key")
        );
        assert_eq!(
            r(json!({"source": "avcs", "externalKey": k, "title": "t", "state": "done"})),
            Some("state_not_allowed")
        );
        assert_eq!(
            r(json!({"source": "avcs", "externalKey": k, "title": "t"})),
            Some("thread_required")
        );
        assert_eq!(
            r(json!({"source": "avcs", "externalKey": k, "title": "t", "threadRootId": t})),
            None
        );
    }
}
