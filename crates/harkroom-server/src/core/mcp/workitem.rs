//! S5.4 A2a — `workitem.remove`·`workitem.upsert`(TS mcpPlugin.ts 의 그 도구 → services/workItems.ts `removeWorkItem`·`upsertWorkItem`).
//!
//! 주인 판정·가시성 술어는 REST `GET·DELETE /work-items`(`writes_misc.rs`)와 같은 것을 쓴다.
//! - remove: `(source, externalKey)` 로 지운다. 범위 밖(남의 보드·주인이 아닌 쪽이 못 보는 스레드)은 없는 것과 같은 `removed: false` 다.
//! - upsert: avcs 키·상태 규칙 → 스레드 가시성(주인·쓰는 계정 둘 다) → 주인별 잠금 → 못 보는 기존 항목 덮기 거절 → 상한 → insert/update.
//!   **`state: done` 이면서 스레드가 붙은 요청은 TS 로 넘긴다** — 같은 트랜잭션에서 위임장을 끝내야 하는데(`endMandatesForDoneThreadTx`)
//!   그 처리가 아직 Rust 에 없다(REST `PUT /work-items` 가 TS 에 남은 것과 같은 까닭).
//! - zod 가 거절할 인자는 `None`(TS 가 같은 검증 오류를 낸다). 쓰기 전 DB 오류도 `None`. 쓰기 트랜잭션을 연 뒤의 오류는 `internal`(security W1).
//! - 바뀌면 같은 트랜잭션에서 주인에게 `inbox.updated` 를 낸다(TS 는 커밋 뒤 `emitEvent` — outbox 라 커밋된 뒤에만 보인다).
use super::tools::err;
use crate::auth::Account;
use crate::lists::is_zod_uuid;
use crate::write::emit_event;
use crate::writes_misc::{NO_OWNER, WORK_ITEM_SOURCES, actor_sees, work_item_owner};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::OnceLock;

/// `workitem.remove` 쓰기 역할의 권한. 하나라도 없으면 `main.rs` 가 풀을 비워 TS 가 답한다.
pub const WORK_ITEM_REMOVE_PRIVILEGES: &[(&str, &str)] = &[
    ("work_item", "DELETE"),
    ("work_item", "SELECT"),
    ("event_outbox", "INSERT"),
];
pub const WORK_ITEM_REMOVE_SEQUENCES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// zod `externalKey: z.string().trim().min(1).max(300)`. JS `trim` 이 지우는 글자 가운데 Rust `trim` 이 안 지우는 것(U+FEFF)이
/// 끝에 있으면 같은 값을 낼 수 없으니 `None`(→ TS).
pub fn parse_remove(args: &Value) -> Option<(&str, &str)> {
    let source = args.get("source")?.as_str()?;
    if !WORK_ITEM_SOURCES.contains(&source) {
        return None;
    }
    let key = zod_trimmed(args.get("externalKey")?, 300)?;
    Some((source, key))
}

/// zod `z.string().trim().min(1).max(max)` — 길이는 UTF-16 단위. JS `trim` 과 Rust `trim` 이 다르게 지우는 글자(U+FEFF 는 JS 만,
/// U+0085 는 Rust 만)가 들어 있으면 같은 값을 낸다고 장담할 수 없으니 `None`(→ TS).
fn zod_trimmed(v: &Value, max: usize) -> Option<&str> {
    let raw = v.as_str()?;
    if raw.contains(['\u{feff}', '\u{85}']) {
        return None;
    }
    let t = raw.trim();
    (1..=max).contains(&t.encode_utf16().count()).then_some(t)
}

fn remove_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        format!(
            "delete from work_item w where w.owner_account_id = $1::uuid and w.source = $3::text \
               and w.external_key = $4::text and ($2::uuid = $1::uuid or {})",
            actor_sees()
        )
    })
}

/// 인자가 zod 를 못 지나면 `None`(TS 가 같은 검증 오류를 낸다). 쓰기 전 DB 오류도 `None`.
pub async fn remove(read: &PgPool, write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let (source, key) = parse_remove(args)?;
    let owner = match work_item_owner(read, me).await.ok()? {
        Some(o) => o,
        None => return Some(err("no_owner", NO_OWNER)),
    };
    let mut tx = write.begin().await.ok()?;
    let done: Result<bool, sqlx::Error> = async {
        let n = sqlx::query(remove_sql())
            .bind(&owner)
            .bind(&me.id)
            .bind(source)
            .bind(key)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        if n > 0 {
            emit_event(
                &mut tx,
                &json!({ "type": "inbox.updated", "accountId": owner }),
            )
            .await?;
        }
        tx.commit().await?;
        Ok(n > 0)
    }
    .await;
    Some(match done {
        Ok(removed) => super::respond::text_result(&format!("{{\"removed\":{removed}}}")),
        Err(_) => internal(),
    })
}

fn internal() -> String {
    err("internal", "the write failed; it was not retried")
}

// ── upsert ────────────────────────────────────────────────────────────

/// `workitem.upsert` 쓰기 역할의 권한. 하나라도 없으면 `main.rs` 가 풀을 비워 TS 가 답한다. UPDATE 는 `on conflict do update`
/// 가 고치는 칸만. 트랜잭션 안에서 읽는 표(기존 항목·가시성·개수)의 SELECT 도 본다.
pub const WORK_ITEM_UPSERT_PRIVILEGES: &[(&str, &str)] = &[
    ("work_item", "SELECT"),
    ("work_item", "INSERT"),
    ("work_item.url", "UPDATE"),
    ("work_item.title", "UPDATE"),
    ("work_item.state", "UPDATE"),
    ("work_item.thread_root_id", "UPDATE"),
    ("work_item.updated_by", "UPDATE"),
    ("work_item.updated_at", "UPDATE"),
    ("message", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("event_outbox", "INSERT"),
];
pub const WORK_ITEM_UPSERT_SEQUENCES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS `MAX_ITEMS_PER_OWNER`.
const MAX_ITEMS_PER_OWNER: i64 = 500;
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
/// 파서를 그대로 옮기지 않고 확실히 받는 꼴만 Rust 가 답한다 — 여기서 떨어진 값은 TS 가 판정한다(넓게 받으면 TS 와 갈린다).
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

/// TS `WORK_ITEM_REFUSAL_MESSAGE`.
fn refusal(code: &str) -> String {
    let m = match code {
        "bad_key" => "avcs externalKey must be <repo>/<intent oid>",
        "state_not_allowed" => "avcs items carry no state — it is read from the avcs server",
        "state_required" => "state is required for non-avcs items (mine | blocked | active | done)",
        "thread_required" => "avcs items must be attached to a thread (threadRootId)",
        "thread_not_found" => "no such message",
        "thread_forbidden" => "the thread is not visible to the board owner or to you",
        "not_root" => "threadRootId must be a thread root",
        _ => "the board already has 500 work items; remove some first",
    };
    err(code, m)
}

fn thread_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let vis = crate::core::channels::frag("channel_visible_c_p1uuid");
        format!(
            "select m.thread_root_id is null as is_root, ({}) as owner_sees, ({}) as actor_sees \
               from message m join channel c on c.id = m.channel_id where m.id = $1::uuid and m.deleted_at is null",
            vis.replace("$1::uuid", "$2::uuid"),
            vis.replace("$1::uuid", "$3::uuid"),
        )
    })
}

fn existing_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        format!(
            "select {} from work_item w where w.owner_account_id = $1::uuid and w.source = $3::text and w.external_key = $4::text",
            actor_sees()
        )
    })
}

fn insert_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        format!(
            "insert into work_item as w (owner_account_id, source, external_key, url, title, state, thread_root_id, updated_by) \
             values ($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::uuid, $8::uuid) \
             on conflict (owner_account_id, source, external_key) do update set \
               url = excluded.url, title = excluded.title, state = excluded.state, \
               thread_root_id = excluded.thread_root_id, updated_by = excluded.updated_by, updated_at = now() \
             returning json_build_object('id', w.id, 'source', w.source, 'externalKey', w.external_key, 'url', w.url, \
               'title', w.title, 'state', w.state, 'threadRootId', w.thread_root_id, 'updatedBy', w.updated_by, \
               'createdAt', {}, 'updatedAt', {})::text",
            crate::iso!("w.created_at"),
            crate::iso!("w.updated_at"),
        )
    })
}

enum Wrote {
    Item(String),
    Refused(&'static str),
}

pub async fn upsert(read: &PgPool, write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let u = parse_upsert(args)?;
    // 위임장 끝내기(`endMandatesForDoneThreadTx`)가 Rust 에 없다 — 이 갈래는 TS 가 답한다.
    if u.state == Some("done") && u.thread.is_some() {
        return None;
    }
    let owner = match work_item_owner(read, me).await.ok()? {
        Some(o) => o,
        None => return Some(err("no_owner", NO_OWNER)),
    };
    if u.source == "avcs" {
        if !avcs_key_ok(u.key) {
            return Some(refusal("bad_key"));
        }
        if u.state.is_some() {
            return Some(refusal("state_not_allowed"));
        }
        if u.thread.is_none() {
            return Some(refusal("thread_required"));
        }
    } else if u.state.is_none() {
        return Some(refusal("state_required"));
    }
    if let Some(root) = u.thread {
        let row: Option<(bool, bool, bool)> = sqlx::query_as(thread_sql())
            .bind(root)
            .bind(&owner)
            .bind(&me.id)
            .fetch_optional(read)
            .await
            .ok()?;
        let Some((is_root, owner_sees, actor_sees)) = row else {
            return Some(refusal("thread_not_found"));
        };
        if !owner_sees || !actor_sees {
            return Some(refusal("thread_forbidden"));
        }
        if !is_root {
            return Some(refusal("not_root"));
        }
    }
    let mut tx = write.begin().await.ok()?;
    let wrote: Result<Wrote, sqlx::Error> = async {
        // 주인 단위 상한 — 같은 주인의 동시 쓰기가 상한을 같이 넘지 않게(TS 와 같은 잠금 키).
        sqlx::query("select pg_advisory_xact_lock(hashtextextended($1::text, 110))")
            .bind(&owner)
            .execute(&mut *tx)
            .await?;
        let existing: Option<bool> = sqlx::query_scalar(existing_sql())
            .bind(&owner)
            .bind(&me.id)
            .bind(u.source)
            .bind(u.key)
            .fetch_optional(&mut *tx)
            .await?;
        // 주인이 아닌 쪽은 자기가 못 보는 기존 항목을 덮지 못한다.
        if existing == Some(false) && me.id != owner {
            return Ok(Wrote::Refused("thread_forbidden"));
        }
        if existing.is_none() {
            let n: i64 = sqlx::query_scalar(
                "select count(*) from work_item where owner_account_id = $1::uuid",
            )
            .bind(&owner)
            .fetch_one(&mut *tx)
            .await?;
            if n >= MAX_ITEMS_PER_OWNER {
                return Ok(Wrote::Refused("too_many"));
            }
        }
        let item: String = sqlx::query_scalar(insert_sql())
            .bind(&owner)
            .bind(u.source)
            .bind(u.key)
            .bind(u.url)
            .bind(u.title)
            .bind(u.state)
            .bind(u.thread)
            .bind(&me.id)
            .fetch_one(&mut *tx)
            .await?;
        emit_event(
            &mut tx,
            &json!({ "type": "inbox.updated", "accountId": owner }),
        )
        .await?;
        Ok(Wrote::Item(item))
    }
    .await;
    Some(match wrote {
        Ok(Wrote::Refused(code)) => {
            // 거절은 아무것도 쓰지 않았다 — 잠금만 풀면 된다.
            let _ = tx.rollback().await;
            refusal(code)
        }
        Ok(Wrote::Item(item)) => match tx.commit().await {
            Ok(()) => super::respond::text_result(&format!(
                "{{\"item\":{}}}",
                super::respond::minify(&item)
            )),
            Err(_) => internal(),
        },
        Err(_) => internal(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
