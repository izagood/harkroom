//! Q1 — 사람에게 넘기기 전 「이미 받은 것으로 할 수 있는 일인가」 판정(그림자).
//!
//! 에이전트가 `message.ask` 로 사람 앞 카드를 세울 때, 카드 글(본문·질문·선택지)이 가리키는 일을 그 에이전트가 **이미 받은**
//! 권한과 대조한다 — 머지 허락 저장소(`account_grant` `repo.merge`), 이 채널의 tool 규칙(`tool.allow`), 비밀 부여(`secret_grant`).
//!
//! - **카드를 막지 않는다.** 판정은 카드가 선 뒤에 하고, 결과는 `measure_event` 한 줄([`KIND`])로만 남긴다. 읽기 실패·판정 실패는
//!   삼킨다 — 카드 응답은 그대로다.
//! - 스위치 `HARKROOM_ASK_SELF_SERVE`(기본 꺼짐)가 `hint` 일 때만 응답에 `selfServe` 칸을 더한다(신호가 있을 때). 꺼져 있으면
//!   응답은 한 글자도 바뀌지 않는다.
//! - 판정은 글자 대조다(어림). 「할 수 있다」는 보증이 아니다 — 실제 허락은 머지 래퍼·tool 판정·비밀 마운트가 그대로 다시 본다.
//!   부여를 준 사람이 지금도 정할 수 있는지(`mayDecide`)는 여기서 다시 보지 않는다.
//! - 기록에는 글 본문·핸들·저장소 이름·규칙·비밀 이름을 싣지 않는다 — 신호 갈래 이름과 수만.
use serde_json::{Map, Value, json};
use sqlx::PgPool;

/// `measure_event.kind` — 사람 앞 카드 한 장의 판정. `detail.branch` 는 `possible`·`no_match`, `value` 는 신호 수.
pub const KIND: &str = "ask.self_serve";

/// 머지 허락이 있는 저장소의 머지를 사람에게 묻는다.
pub const SIGNAL_MERGE: &str = "merge_granted";
/// 이미 허락된 tool 규칙에 맞는 명령을 사람에게 돌려 달라고 한다.
pub const SIGNAL_TOOL: &str = "tool_allowed";
/// 이미 받은 비밀을 사람에게 달라고 한다.
pub const SIGNAL_SECRET: &str = "secret_granted";

/// 에이전트가 이미 가진 것 — 이 채널에서 통하는 것만.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Held {
    /// `owner/name` 또는 `owner/*`.
    pub merge_repos: Vec<String>,
    /// Claude Code allow 규칙 글자(`Bash(git status:*)` 등).
    pub tool_rules: Vec<String>,
    /// 비밀 이름.
    pub secrets: Vec<String>,
}

/// 읽기 — 만료 안 된 `repo.merge`·이 채널의 `tool.allow` scope 와, 정지 안 된 비밀 부여(이 채널 또는 채널 무관)의 이름.
pub const HELD_SQL: &str = "select 'g' as src, scope as v from account_grant \
      where account_id = $1::uuid and (expires_at is null or expires_at > now()) \
        and ((capability = 'repo.merge' and left(scope, 5) = 'repo:') \
          or (capability = 'tool.allow' and left(scope, length($3::text)) = $3::text)) \
     union all \
     select 's', s.name from secret_grant g join secret s on s.id = g.secret_id \
      where g.agent_id = $1::uuid and g.suspended_at is null and (g.channel_id is null or g.channel_id = $2::uuid)";

/// [`HELD_SQL`] 이 읽는 칸 — 읽기 풀에 있어야 한다(없으면 판정만 빠진다).
pub const HELD_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("account_grant", "SELECT"),
    ("secret_grant", "SELECT"),
    ("secret", "SELECT"),
];

/// 읽은 줄을 [`Held`] 로 — 모르는 꼴은 버린다.
pub fn held_from_rows(rows: Vec<(String, String)>, channel: &str) -> Held {
    let tool_prefix = format!("tool:{channel}:");
    let mut h = Held::default();
    for (src, v) in rows {
        if src == "s" {
            h.secrets.push(v);
        } else if let Some(repo) = v.strip_prefix("repo:") {
            h.merge_repos.push(repo.to_owned());
        } else if let Some(rule) = v.strip_prefix(tool_prefix.as_str()) {
            h.tool_rules.push(rule.to_owned());
        }
    }
    h
}

pub async fn read_held(pool: &PgPool, agent: &str, channel: &str) -> Result<Held, sqlx::Error> {
    let rows: Vec<(String, String)> = sqlx::query_as(HELD_SQL)
        .bind(agent)
        .bind(channel)
        .bind(format!("tool:{channel}:"))
        .fetch_all(pool)
        .await?;
    Ok(held_from_rows(rows, channel))
}

fn repo_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')
}

/// 글 속의 `owner/name` 꼴(양쪽이 저장소 글자, 앞뒤가 `/` 로 이어지지 않는 것) — 소문자로.
fn repo_mentions(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for tok in text.split(|c: char| !(repo_char(c) || c == '/')) {
        let mut parts = tok.split('/');
        let (Some(owner), Some(name), None) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let name = name.trim_end_matches('.');
        if owner.is_empty() || name.is_empty() {
            continue;
        }
        out.push(format!("{owner}/{name}").to_ascii_lowercase());
    }
    out
}

fn mentions_merge(lower: &str) -> bool {
    lower.contains("머지") || lower.contains("merge") || lower.contains("병합")
}

fn merge_signal(text: &str, lower: &str, held: &[String]) -> bool {
    if held.is_empty() || !mentions_merge(lower) {
        return false;
    }
    repo_mentions(text).iter().any(|m| {
        held.iter().any(|h| {
            let h = h.to_ascii_lowercase();
            match h.strip_suffix("/*") {
                Some(owner) => m.split('/').next() == Some(owner),
                None => *m == h,
            }
        })
    })
}

/// 백틱 한 쌍 안의 글(코드 조각) — 세 겹 울타리의 줄도 줄 단위로 낸다.
fn code_spans(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    for (i, part) in text.split('`').enumerate() {
        if i % 2 == 1 {
            out.extend(part.lines().map(str::trim).filter(|l| !l.is_empty()));
        }
    }
    out
}

/// `Bash(<글>)` 규칙이 그 명령을 덮는가 — `…:*` 는 그 앞머리(낱말 경계)로 시작하면, 아니면 글자가 같을 때.
/// 묶은 명령(`;`·`&&`·`|`·줄바꿈·`$(`·백틱)은 규칙 하나로 덮이지 않는다고 본다.
pub fn rule_covers(rule: &str, command: &str) -> bool {
    let Some(inner) = rule.strip_prefix("Bash(").and_then(|r| r.strip_suffix(')')) else {
        return false;
    };
    let cmd = command.trim();
    if cmd.is_empty()
        || [";", "&&", "||", "|", "\n", "$(", ">", "<"]
            .iter()
            .any(|s| cmd.contains(s))
    {
        return false;
    }
    match inner.strip_suffix(":*") {
        Some(prefix) if !prefix.is_empty() => {
            cmd == prefix
                || cmd
                    .strip_prefix(prefix)
                    .is_some_and(|rest| rest.starts_with(' '))
        }
        Some(_) => false,
        None => cmd == inner,
    }
}

fn tool_signal(text: &str, rules: &[String]) -> bool {
    if rules.is_empty() {
        return false;
    }
    code_spans(text)
        .iter()
        .any(|c| rules.iter().any(|r| rule_covers(r, c)))
}

fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-')
}

fn secret_signal(lower: &str, secrets: &[String]) -> bool {
    secrets.iter().any(|name| {
        let name = name.to_ascii_lowercase();
        !name.is_empty() && lower.split(|c: char| !name_char(c)).any(|tok| tok == name)
    })
}

/// 카드 글과 가진 것을 대조한 신호 — 순서는 고정(머지·tool·비밀).
pub fn judge(text: &str, held: &Held) -> Vec<&'static str> {
    let lower = text.to_lowercase();
    let mut out = Vec::new();
    if merge_signal(text, &lower, &held.merge_repos) {
        out.push(SIGNAL_MERGE);
    }
    if tool_signal(text, &held.tool_rules) {
        out.push(SIGNAL_TOOL);
    }
    if secret_signal(&lower, &held.secrets) {
        out.push(SIGNAL_SECRET);
    }
    out
}

/// 판정할 카드인가 — 사람 앞 평범한 카드만(머지 거절 카드·거울·받는 이를 정한 카드는 뺀다: 서버가 꼴을 정하거나 사람이 아닐 수 있다).
pub fn eligible(args: &Map<String, Value>) -> bool {
    ["mergeDenialId", "mirrorOf", "to"]
        .iter()
        .all(|k| args.get(*k).is_none_or(Value::is_null))
}

/// 카드에서 대조할 글 — 본문·질문·선택지의 label·description.
pub fn card_text(args: &Map<String, Value>) -> String {
    let mut out = String::new();
    let mut push = |v: Option<&Value>| {
        if let Some(s) = v.and_then(Value::as_str) {
            out.push_str(s);
            out.push('\n');
        }
    };
    push(args.get("body"));
    push(args.get("prompt"));
    for o in args
        .get("options")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        push(o.get("label"));
        push(o.get("description"));
    }
    out
}

/// 기록 한 줄 — 신호 갈래 이름과 수만.
pub fn event(
    agent: &str,
    channel: &str,
    thread: Option<&str>,
    card: Option<&str>,
    signals: &[&'static str],
    held: &Held,
) -> super::measure::Event {
    super::measure::Event {
        kind: KIND,
        account_id: Some(agent.to_owned()),
        channel_id: Some(channel.to_owned()),
        thread_root_id: thread.map(str::to_owned),
        ref_id: card.map(str::to_owned),
        value: Some(signals.len() as i64),
        detail: Some(json!({
            "branch": if signals.is_empty() { "no_match" } else { "possible" },
            "signals": signals,
            "held": {
                "mergeRepos": held.merge_repos.len(),
                "toolRules": held.tool_rules.len(),
                "secrets": held.secrets.len(),
            },
        })),
    }
}

/// `HARKROOM_ASK_SELF_SERVE` — `hint` 만 응답 칸을 켠다. 없거나 다른 값이면 기록만.
pub fn hint_on(raw: Option<&str>) -> bool {
    raw.map(|v| v.trim().to_ascii_lowercase()).as_deref() == Some("hint")
}

/// MCP 응답(`{"content":[{"type":"text","text":"<JSON>"}]}`)의 안쪽 객체 — 카드가 선 응답(`message` 가 있는 것)만.
fn posted(response: &str) -> Option<(Value, Map<String, Value>)> {
    let outer: Value = serde_json::from_str(response).ok()?;
    let inner: Value =
        serde_json::from_str(outer.get("content")?.get(0)?.get("text")?.as_str()?).ok()?;
    let Value::Object(inner) = inner else {
        return None;
    };
    inner.get("message")?.get("id")?.as_str()?;
    Some((outer, inner))
}

/// 응답에 `selfServe` 칸을 더한 글자. 꼴이 다르면 `None`(부른 쪽이 원래 응답을 그대로 쓴다).
pub fn with_hint(response: &str, signals: &[&'static str]) -> Option<String> {
    let (_, mut inner) = posted(response)?;
    inner.insert(
        "selfServe".into(),
        json!({
            "signals": signals,
            "note": "this card may ask for something you were already granted — check grant.list / secret.list before waiting for the answer",
        }),
    );
    Some(super::mcp::respond::text_result(
        &Value::Object(inner).to_string(),
    ))
}

/// `message.ask` 응답이 나간 뒤 한 번 — 카드가 섰고 판정할 꼴이면 대조해 기록하고, `hint` 면 응답에 칸을 더해 돌려준다.
/// 어떤 실패도 원래 응답을 그대로 돌려준다.
pub async fn after_ask(
    read: &PgPool,
    agent_id: &str,
    is_agent: bool,
    args: &Value,
    response: String,
    hint: bool,
) -> String {
    let Some(o) = args.as_object() else {
        return response;
    };
    if !is_agent || !eligible(o) {
        return response;
    }
    let Some(channel) = o.get("channelId").and_then(Value::as_str) else {
        return response;
    };
    let Some((_, inner)) = posted(&response) else {
        return response;
    };
    let card = inner
        .get("message")
        .and_then(|m| m.get("id"))
        .and_then(Value::as_str);
    let held = match read_held(read, agent_id, channel).await {
        Ok(h) => h,
        Err(e) => {
            eprintln!(
                "front: ask self-serve read failed: {}",
                e.as_database_error().map_or("io", |_| "db")
            );
            return response;
        }
    };
    let signals = judge(&card_text(o), &held);
    super::measure::record(event(
        agent_id,
        channel,
        o.get("threadRootId").and_then(Value::as_str),
        card,
        &signals,
        &held,
    ));
    if hint
        && !signals.is_empty()
        && let Some(r) = with_hint(&response, &signals)
    {
        return r;
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    const CH: &str = "0b7f3f92-3fa6-494a-8ab3-76d0d2a6a1c0";

    fn held() -> Held {
        held_from_rows(
            vec![
                ("g".into(), "repo:acme/widgets".into()),
                ("g".into(), "repo:orgx/*".into()),
                ("g".into(), format!("tool:{CH}:Bash(gh pr ready:*)")),
                ("g".into(), format!("tool:{CH}:Bash(make deploy)")),
                // 다른 채널의 규칙·모르는 꼴은 버린다.
                (
                    "g".into(),
                    "tool:11111111-1111-4111-8111-111111111111:Bash(rm:*)".into(),
                ),
                ("g".into(), "connector:abc".into()),
                ("s".into(), "deploy-token".into()),
            ],
            CH,
        )
    }

    #[test]
    fn held_rows_split_by_kind_and_channel() {
        let h = held();
        assert_eq!(h.merge_repos, ["acme/widgets", "orgx/*"]);
        assert_eq!(h.tool_rules, ["Bash(gh pr ready:*)", "Bash(make deploy)"]);
        assert_eq!(h.secrets, ["deploy-token"]);
    }

    #[test]
    fn merge_needs_word_and_granted_repo() {
        let h = held();
        assert_eq!(judge("acme/widgets#12 머지해 주세요", &h), [SIGNAL_MERGE]);
        assert_eq!(
            judge("Please merge OrgX/anything PR 3.", &h),
            [SIGNAL_MERGE]
        );
        // 저장소는 맞지만 머지 얘기가 아님 · 머지지만 허락 없는 저장소 · 더 긴 경로의 한 토막.
        assert!(judge("acme/widgets 이슈를 봐 주세요", &h).is_empty());
        assert!(judge("other/repo#1 머지해 주세요", &h).is_empty());
        assert!(judge("머지: src/acme/widgets/x.rs", &h).is_empty());
        assert!(judge("acme/widgets 머지", &Held::default()).is_empty());
    }

    #[test]
    fn tool_rule_prefix_and_exact() {
        assert!(rule_covers(
            "Bash(gh pr ready:*)",
            "gh pr ready 12 -R acme/widgets"
        ));
        assert!(rule_covers("Bash(gh pr ready:*)", "gh pr ready"));
        assert!(!rule_covers("Bash(gh pr ready:*)", "gh pr readyx"));
        assert!(!rule_covers(
            "Bash(gh pr ready:*)",
            "gh pr ready 1 && rm -rf x"
        ));
        assert!(!rule_covers("Bash(gh pr ready:*)", "gh pr ready $(cat x)"));
        assert!(rule_covers("Bash(make deploy)", "make deploy"));
        assert!(!rule_covers("Bash(make deploy)", "make deploy prod"));
        assert!(!rule_covers("Bash(:*)", "anything"));
        assert!(!rule_covers("Read(/x)", "/x"));

        let h = held();
        assert_eq!(
            judge("`gh pr ready 12` 를 대신 눌러 주세요", &h),
            [SIGNAL_TOOL]
        );
        // 백틱 밖의 글은 명령으로 보지 않는다.
        assert!(judge("gh pr ready 12 를 눌러 주세요", &h).is_empty());
        assert_eq!(judge("```\nmake deploy\n```", &h), [SIGNAL_TOOL]);
    }

    #[test]
    fn secret_name_is_a_whole_token() {
        let h = held();
        assert_eq!(judge("`deploy-token` 값을 주세요", &h), [SIGNAL_SECRET]);
        assert!(judge("deploy-token-2 를 주세요", &h).is_empty());
        assert!(judge("토큰을 주세요", &h).is_empty());
    }

    #[test]
    fn card_text_and_eligibility() {
        let args = json!({
            "channelId": CH, "body": "본문", "prompt": "질문",
            "options": [{ "id": "a", "label": "acme/widgets 머지", "description": "설명" }],
        });
        let o = args.as_object().unwrap();
        assert_eq!(card_text(o), "본문\n질문\nacme/widgets 머지\n설명\n");
        assert!(eligible(o));
        assert_eq!(judge(&card_text(o), &held()), [SIGNAL_MERGE]);
        for k in ["mergeDenialId", "mirrorOf", "to"] {
            let mut m = o.clone();
            m.insert(k.into(), json!("x"));
            assert!(!eligible(&m), "{k}");
            m.insert(k.into(), Value::Null);
            assert!(eligible(&m), "{k} null");
        }
    }

    #[test]
    fn event_carries_no_names() {
        let h = held();
        let e = event("a", CH, Some("t"), Some("c"), &[SIGNAL_MERGE], &h);
        assert_eq!(e.kind, KIND);
        assert_eq!(e.value, Some(1));
        let detail = e.detail.unwrap();
        assert_eq!(
            detail,
            json!({
                "branch": "possible",
                "signals": ["merge_granted"],
                "held": { "mergeRepos": 2, "toolRules": 2, "secrets": 1 },
            })
        );
        let d = detail.to_string();
        for leak in ["acme", "widgets", "deploy-token", "gh pr"] {
            assert!(!d.contains(leak), "{leak}");
        }
        let none = event("a", CH, None, None, &[], &h);
        assert_eq!(none.value, Some(0));
        assert_eq!(none.detail.unwrap()["branch"], "no_match");
    }

    #[test]
    fn hint_switch_and_response_field() {
        assert!(hint_on(Some("hint")) && hint_on(Some(" HINT ")));
        assert!(!hint_on(None) && !hint_on(Some("on")) && !hint_on(Some("")));

        let ok = crate::core::mcp::respond::text_result(r#"{"message":{"id":"m1"},"notified":[]}"#);
        let out = with_hint(&ok, &[SIGNAL_TOOL]).unwrap();
        let outer: Value = serde_json::from_str(&out).unwrap();
        let inner: Value =
            serde_json::from_str(outer["content"][0]["text"].as_str().unwrap()).unwrap();
        assert_eq!(inner["message"]["id"], "m1");
        assert_eq!(inner["selfServe"]["signals"], json!(["tool_allowed"]));
        // 거절·모르는 꼴은 건드리지 않는다.
        let refused = crate::core::mcp::respond::text_result(r#"{"error":"forbidden"}"#);
        assert!(with_hint(&refused, &[SIGNAL_TOOL]).is_none());
        assert!(with_hint("not json", &[SIGNAL_TOOL]).is_none());
    }
}
