//! S5.3 C1c-4d — **암묵 위임**(위임 재설계 P4). 에이전트가 에이전트를 맨 앞 멘션으로 부른 글이면 그 부름을 위임으로 판정해 적는다
//! (그림자 모드는 판정만). TS `services/implicitDelegation.ts`(`implicitDelegationMode`·`implicitBodyFacts`·`planStepFor`·
//! `recordImplicitDelegations`)와 `createDelegation` 의 `kind = 'mention'` 갈래를 옮긴다.
//!
//! - 모드는 TS 와 같은 낱말로 읽되, 위임 스위치(`HARKROOM_DELEGATION_V2`)를 **모르면** `None` 이다 — 그때 부름이 든 에이전트 글은
//!   지금처럼 TS 로 넘긴다([`super::msg_post`]).
//! - 문장은 전부 TS 상수를 골든(`implicit_*`·`delegation_insert`·`delegation_item_insert`)으로 받는다.
//! - 암묵 위임은 앞 위임을 대체하지 않고(`supersedePrevious` 없음) 담당의 `mention` inbox 도 바꾸지 않는다 — TS 와 같다.
use super::mention_parse::head_mention_run_end;
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::OnceLock;

/// TS `SHORT_QUESTION_MAX_CHARS`.
pub const SHORT_QUESTION_MAX_CHARS: usize = 200;
/// TS `DELEGATION_DEADLINE_DEFAULT_SEC`.
pub const DELEGATION_DEADLINE_DEFAULT_SEC: i64 = 10 * 60;
/// TS `DELEGATION_MAX_AGE_SEC` — 그림자 판정을 열린 것으로 치는 수명.
pub const DELEGATION_MAX_AGE_SEC: i32 = 24 * 60 * 60;

/// 이 갈래가 [`super::msg_post::MESSAGE_POST_PRIVILEGES`] 위에 더 쓰는 권한. 빠지면 부름이 든 에이전트 글은 TS 에 남는다.
pub const IMPLICIT_DELEGATION_PRIVILEGES: &[(&str, &str)] = &[
    ("delegation_implicit_log", "INSERT"),
    ("team_delegation", "INSERT"),
    ("team_delegation_item", "INSERT"),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off,
    Shadow,
    On,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Off => "off",
            Mode::Shadow => "shadow",
            Mode::On => "on",
        }
    }
}

/// TS `implicitDelegationMode` — `v2` 는 [`super::msg_post`] 의 `delegation_v2`(모르면 `None`). 모르면 `None`.
/// v2 가 켜졌는데 `HARKROOM_DELEGATION_IMPLICIT` 가 없거나 비었으면 그것도 모름이다 — TS 가 on·off·shadow 중 무엇인지
/// 앞단은 알 수 없다(TS 의 「없으면 shadow」를 앞단이 짐작하지 않는다).
pub fn mode(v2: Option<bool>, implicit: Option<&str>) -> Option<Mode> {
    match v2? {
        false => Some(Mode::Off),
        true => {
            let v = implicit?.trim().to_lowercase();
            if v.is_empty() {
                return None;
            }
            Some(match v.as_str() {
                "on" | "1" | "true" => Mode::On,
                "off" | "0" | "false" => Mode::Off,
                _ => Mode::Shadow,
            })
        }
    }
}

/// JS `String.prototype.trim` 의 공백(유니코드 공백 + BOM).
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// TS `implicitBodyFacts` — 머리 멘션 런을 뺀 본문의 글자 수(코드 포인트)와 짧은 질문 여부.
pub fn body_facts(normalized_body: &str) -> (i32, bool) {
    let rest = js_trim(&normalized_body[head_mention_run_end(normalized_body)..]);
    let chars = rest.chars().count();
    let short = chars <= SHORT_QUESTION_MAX_CHARS && (rest.contains('?') || rest.contains('？'));
    (i32::try_from(chars).unwrap_or(i32::MAX), short)
}

fn plan_link() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    // TS `/harkroom:\/\/plan\/([0-9a-f-]{36})\/(s[1-9][0-9]{0,3})\b/gi` — `i` 는 손으로 펼치고, `\b` 는 JS 처럼 ASCII 다.
    R.get_or_init(|| {
        Regex::new(r"[hH][aA][rR][kK][rR][oO][oO][mM]://[pP][lL][aA][nN]/([0-9a-fA-F-]{36})/([sS][1-9][0-9]{0,3})(?-u:\b)")
            .expect("plan link regex")
    })
}

/// TS `planStepFor` — 이 담당이 맡은(끝나지 않은) 단계 중 본문 링크 → 진행 중 하나 → 하나뿐인 것. 애매하면 `None`.
pub fn plan_step_for(
    doc: &Value,
    thread_root_id: &str,
    delegate_id: &str,
    body: &str,
) -> Option<String> {
    let steps = doc.get("steps")?.as_array()?;
    let mine: Vec<&Value> = steps
        .iter()
        .filter(|s| {
            s.get("assigneeId").and_then(Value::as_str) == Some(delegate_id)
                && s.get("state").and_then(Value::as_str) != Some("done")
        })
        .collect();
    if mine.is_empty() {
        return None;
    }
    let root = thread_root_id.to_lowercase();
    let linked: HashSet<&str> = plan_link()
        .captures_iter(body)
        .filter(|c| c[1].to_lowercase() == root)
        .filter_map(|c| c.get(2).map(|m| m.as_str()))
        .collect();
    let id = |s: &&Value| s.get("id").and_then(Value::as_str).map(str::to_owned);
    let by_link: Vec<&&Value> = mine
        .iter()
        .filter(|s| {
            s.get("id")
                .and_then(Value::as_str)
                .is_some_and(|i| linked.contains(i))
        })
        .collect();
    if by_link.len() == 1 {
        return id(by_link[0]);
    }
    let active: Vec<&&Value> = mine
        .iter()
        .filter(|s| s.get("state").and_then(Value::as_str) == Some("active"))
        .collect();
    if active.len() == 1 {
        return id(active[0]);
    }
    if mine.len() == 1 { id(&mine[0]) } else { None }
}

struct Sql {
    callees: String,
    lock: String,
    plan: String,
    verdict: String,
    log: String,
    deleg: String,
    item: String,
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
        Sql {
            callees: frag("implicit_agent_callees"),
            lock: frag("implicit_lock"),
            plan: frag("implicit_plan"),
            verdict: frag("implicit_verdict"),
            log: frag("implicit_log_insert"),
            deleg: frag("delegation_insert"),
            item: frag("delegation_item_insert"),
        }
    })
}

/// 한 글의 맥락.
pub struct Post<'a> {
    pub message_id: &'a str,
    pub channel_id: &'a str,
    pub thread_root_id: &'a str,
    pub author_id: &'a str,
    pub normalized_body: &'a str,
}

/// TS `postMessage` 의 암묵 위임 갈래 — `called` 는 부른 순서의 계정들(작성자·inbox 가 안 간 계정은 호출하는 쪽이 이미 뺐다).
/// 그중 에이전트만 판정한다. 돌려주는 것은 적은 판정 수.
pub async fn record(
    conn: &mut sqlx::PgConnection,
    mode: Mode,
    p: &Post<'_>,
    called: &[&String],
    now_ms: i64,
    iso_ms: fn(i64) -> String,
) -> Result<usize, sqlx::Error> {
    if mode == Mode::Off || called.is_empty() {
        return Ok(0);
    }
    let s = sql();
    let agents: HashSet<String> = sqlx::query_scalar::<_, String>(s.callees.as_str())
        .bind(called)
        .fetch_all(&mut *conn)
        .await?
        .into_iter()
        .collect();
    // TS: `called.filter(id => agentCallees.includes(id))` 를 `[...new Set(…)]` 로 — 부른 순서, 겹침 없이.
    let mut seen = HashSet::new();
    let targets: Vec<&str> = called
        .iter()
        .map(|c| c.as_str())
        .filter(|c| agents.contains(*c) && *c != p.author_id && seen.insert(*c))
        .collect();
    if targets.is_empty() {
        return Ok(0);
    }
    let (body_chars, short_question) = body_facts(p.normalized_body);
    sqlx::query(s.lock.as_str())
        .bind(p.thread_root_id)
        .execute(&mut *conn)
        .await?;
    let plan: Option<Value> = sqlx::query_scalar(s.plan.as_str())
        .bind(p.thread_root_id)
        .fetch_optional(&mut *conn)
        .await?;
    let mut n = 0;
    for to in targets {
        let dirs: Vec<String> = sqlx::query_scalar(s.verdict.as_str())
            .bind(p.thread_root_id)
            .bind(p.author_id)
            .bind(to)
            .bind(DELEGATION_MAX_AGE_SEC)
            .fetch_all(&mut *conn)
            .await?;
        let verdict = if dirs.iter().any(|d| d == "reverse") {
            "reply"
        } else if !dirs.is_empty() {
            "existing"
        } else {
            "open"
        };
        let step = plan
            .as_ref()
            .and_then(|d| plan_step_for(d, p.thread_root_id, to, p.normalized_body));
        let mut delegation: Option<String> = None;
        if mode == Mode::On && verdict == "open" {
            let id: String = sqlx::query_scalar(s.deleg.as_str())
                .bind(p.message_id)
                .bind(None::<String>)
                .bind(p.author_id)
                .bind(p.channel_id)
                .bind(p.thread_root_id)
                .bind(iso_ms(now_ms + DELEGATION_DEADLINE_DEFAULT_SEC * 1000))
                .bind("mention")
                .bind(step.as_deref())
                .fetch_one(&mut *conn)
                .await?;
            sqlx::query(s.item.as_str())
                .bind(&id)
                .bind(to)
                .execute(&mut *conn)
                .await?;
            delegation = Some(id);
        }
        sqlx::query(s.log.as_str())
            .bind(p.message_id)
            .bind(p.channel_id)
            .bind(p.thread_root_id)
            .bind(p.author_id)
            .bind(to)
            .bind(verdict)
            .bind(mode.as_str())
            .bind(step.as_deref())
            .bind(short_question)
            .bind(body_chars)
            .bind(delegation.as_deref())
            .execute(&mut *conn)
            .await?;
        n += 1;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn mode_words_follow_ts() {
        assert_eq!(mode(None, Some("on")), None);
        assert_eq!(mode(Some(false), Some("on")), Some(Mode::Off));
        assert_eq!(mode(Some(true), None), None);
        assert_eq!(mode(Some(true), Some("  ")), None);
        assert_eq!(mode(Some(true), Some("shadow")), Some(Mode::Shadow));
        assert_eq!(mode(Some(true), Some(" ON ")), Some(Mode::On));
        assert_eq!(mode(Some(true), Some("0")), Some(Mode::Off));
        assert_eq!(mode(Some(true), Some("weird")), Some(Mode::Shadow));
    }

    #[test]
    fn body_facts_skip_head_run() {
        let a = "<@11111111-1111-1111-1111-111111111111> 이거 봐 줄래?";
        assert_eq!(body_facts(a), (8, true));
        assert_eq!(
            body_facts("<@11111111-1111-1111-1111-111111111111>\n 끝"),
            (1, false)
        );
        let long = format!(
            "<@11111111-1111-1111-1111-111111111111> {}?",
            "가".repeat(200)
        );
        assert_eq!(body_facts(&long), (201, false));
    }

    #[test]
    fn plan_step_picks_like_ts() {
        let root = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        let doc = json!({ "steps": [
            { "id": "s1", "assigneeId": "x", "state": "active" },
            { "id": "s2", "assigneeId": "x", "state": "todo" },
            { "id": "s3", "assigneeId": "x", "state": "done" },
            { "id": "s4", "assigneeId": "y", "state": "todo" },
        ]});
        assert_eq!(plan_step_for(&doc, root, "x", "그냥"), Some("s1".into()));
        let body = format!("harkroom://plan/{}/s2 보자", root.to_uppercase());
        assert_eq!(plan_step_for(&doc, root, "x", &body), Some("s2".into()));
        // 단계 id 뒤에 낱말 글자가 붙으면 링크가 아니다(ASCII 경계) — 한글은 경계다(JS 와 같다).
        assert_eq!(
            plan_step_for(&doc, root, "x", &format!("harkroom://plan/{root}/s2x")),
            Some("s1".into())
        );
        assert_eq!(
            plan_step_for(&doc, root, "x", &format!("harkroom://plan/{root}/s2가")),
            Some("s2".into())
        );
        assert_eq!(plan_step_for(&doc, root, "y", ""), Some("s4".into()));
        assert_eq!(plan_step_for(&doc, root, "z", ""), None);
        let two = json!({ "steps": [
            { "id": "s1", "assigneeId": "x", "state": "todo" },
            { "id": "s2", "assigneeId": "x", "state": "todo" },
        ]});
        assert_eq!(plan_step_for(&two, root, "x", ""), None);
    }
}
