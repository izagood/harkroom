//! TS `capabilities.ts::lineLive` + merge `matches` + `lineMatches` — 위임장 줄(`mandate_line`·상시 줄)이 이 머지를 덮는가.
//!
//! merge-checks 의 위임장 달린 임대(`findLine`)와 위임 켜짐(`mandateEnforced`) 갈래가 쓸 순수 판정이다. 아직 경로에 물리지 않았다 —
//! 그 두 갈래는 지금도 TS 몫이고, 물릴 때 읽을 열은 [`MERGE_CHECKS_MANDATE_PRIVILEGES`] 에 열 단위로 적어 둔다.

use super::merge_approval_peek::repo_scope;
use serde_json::Value;

/// `findLine`(`validMandateOwner`·`listMandateLines`·에이전트 소유자 대조)이 읽는 열. 하나라도 없으면 그 갈래는 TS 로 넘긴다.
pub const MERGE_CHECKS_MANDATE_PRIVILEGES: &[(&str, &str)] = &[
    ("mandate.id", "SELECT"),
    ("mandate.owner_account_id", "SELECT"),
    ("mandate.delegator_account_id", "SELECT"),
    ("mandate.channel_id", "SELECT"),
    ("mandate.ended_at", "SELECT"),
    ("mandate.automation_id", "SELECT"),
    ("mandate.last_activity_at", "SELECT"),
    ("automation.id", "SELECT"),
    ("automation.deleted_at", "SELECT"),
    ("automation.enabled", "SELECT"),
    ("automation.approved_at", "SELECT"),
    ("mandate_line.id", "SELECT"),
    ("mandate_line.mandate_id", "SELECT"),
    ("mandate_line.cap", "SELECT"),
    ("mandate_line.scope", "SELECT"),
    ("mandate_line.limits", "SELECT"),
    ("mandate_line.agent_ids", "SELECT"),
    ("mandate_line.granted_by", "SELECT"),
    ("mandate_line.via", "SELECT"),
    ("mandate_line.request_id", "SELECT"),
    ("mandate_line.used_count", "SELECT"),
    ("mandate_line.created_at", "SELECT"),
    ("mandate_line.revoked_at", "SELECT"),
    ("agent_config.account_id", "SELECT"),
    ("agent_config.owner_account_id", "SELECT"),
    ("account_grant.id", "SELECT"),
    ("account_grant.account_id", "SELECT"),
    ("account_grant.capability", "SELECT"),
    ("account_grant.scope", "SELECT"),
    ("account_grant.granted_by", "SELECT"),
    ("account_grant.granted_at", "SELECT"),
    ("account_grant.expires_at", "SELECT"),
];

/// 위임 켜짐(`consumeLine`) 갈래가 더 쓰는 열 — 저장된 줄의 `used_count` 를 한 문장에서 센다.
pub const MERGE_CHECKS_ENFORCE_PRIVILEGES: &[(&str, &str)] =
    &[("mandate_line.used_count", "UPDATE")];

/// 대조에 필요한 줄의 모양(TS `LineFacts`). `limits` 는 저장된 jsonb 그대로.
pub struct LineFacts<'a> {
    pub cap: &'a str,
    pub scope: &'a str,
    pub limits: &'a Value,
    pub used_count: i64,
    pub revoked: bool,
}

/// TS merge `CapAction`.
pub struct MergeAction<'a> {
    pub repo: &'a str,
    pub pr: Option<i64>,
    pub head: Option<&'a str>,
    pub gh_user: Option<&'a str>,
    pub ci_override: bool,
}

fn limit<'a>(l: &'a Value, k: &str) -> Option<&'a Value> {
    // TS 는 `!== undefined` 로 본다 — jsonb 에 null 로 적힌 값도 "있음"이다.
    l.as_object().and_then(|o| o.get(k))
}

/// TS `lineLive`. `until` 은 `Date.parse` 대신 RFC 3339 로 읽는다(서버가 `toISOString` 으로 적는다). 못 읽으면 죽은 줄.
pub fn line_live(line: &LineFacts<'_>, now_ms: i64) -> bool {
    if line.revoked {
        return false;
    }
    if let Some(u) = limit(line.limits, "until") {
        let t = u
            .as_str()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|d| d.timestamp_millis());
        match t {
            Some(t) if t > now_ms => {}
            _ => return false,
        }
    }
    if let Some(u) = limit(line.limits, "uses") {
        match u.as_f64() {
            Some(n) if (line.used_count as f64) < n => {}
            _ => return false,
        }
    }
    true
}

/// TS `REPO_ORG_SCOPE_RE` (`^repo:[a-z0-9][a-z0-9._-]{0,99}/\*$`).
fn is_org_scope(s: &str) -> bool {
    let Some(owner) = s.strip_prefix("repo:").and_then(|r| r.strip_suffix("/*")) else {
        return false;
    };
    let b = owner.as_bytes();
    (1..=100).contains(&b.len())
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|&c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'.' | b'_' | b'-')
        })
}

/// TS merge `matches`.
fn merge_matches(line: &LineFacts<'_>, a: &MergeAction<'_>) -> bool {
    let Some(want) = repo_scope(a.repo) else {
        return false;
    };
    // `orgScopeOf(want)` — want 는 이미 REPO_SCOPE_RE 를 지났다.
    let org = want.split_once('/').map(|(o, _)| format!("{o}/*"));
    let hit =
        line.scope == want || (is_org_scope(line.scope) && org.as_deref() == Some(line.scope));
    if !hit {
        return false;
    }
    let l = line.limits;
    if let Some(p) = limit(l, "pr")
        && (p.as_f64() != a.pr.map(|n| n as f64) || a.pr.is_none())
    {
        return false;
    }
    if let Some(h) = limit(l, "head")
        && (h.as_str().is_none() || h.as_str() != a.head)
    {
        return false;
    }
    // TS `if (l.ghUser && ...)` — 빈 문자열·null 은 거짓.
    if let Some(g) = limit(l, "ghUser")
        .and_then(Value::as_str)
        .filter(|g| !g.is_empty())
        && a.gh_user.unwrap_or("").to_lowercase() != g.to_lowercase()
    {
        return false;
    }
    if a.ci_override && limit(l, "ciOverride") != Some(&Value::Bool(true)) {
        return false;
    }
    true
}

/// TS `lineMatches` (cap `merge`).
pub fn merge_line_matches(line: &LineFacts<'_>, a: &MergeAction<'_>, now_ms: i64) -> bool {
    if line.cap != "merge" || !line_live(line, now_ms) {
        return false;
    }
    // TS `if (line.limits.turnCause)` — 참 같은 값이면 턴 하나짜리 줄이라 머지에 맞지 않는다.
    if limit(line.limits, "turnCause").is_some_and(super::merge_checks::js_truthy) {
        return false;
    }
    merge_matches(line, a)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn line<'a>(scope: &'a str, limits: &'a Value) -> LineFacts<'a> {
        LineFacts {
            cap: "merge",
            scope,
            limits,
            used_count: 0,
            revoked: false,
        }
    }
    fn act(repo: &str) -> MergeAction<'_> {
        MergeAction {
            repo,
            pr: Some(7),
            head: Some("h"),
            gh_user: None,
            ci_override: false,
        }
    }
    const NOW: i64 = 1_800_000_000_000;

    #[test]
    fn scope_like_ts() {
        let e = json!({});
        assert!(merge_line_matches(&line("repo:o/r", &e), &act("O/R "), NOW));
        assert!(merge_line_matches(&line("repo:o/*", &e), &act("o/r"), NOW));
        assert!(!merge_line_matches(&line("repo:x/*", &e), &act("o/r"), NOW));
        assert!(!merge_line_matches(
            &line("repo:o/r2", &e),
            &act("o/r"),
            NOW
        ));
        assert!(!merge_line_matches(&line("repo:o/*", &e), &act("o/*"), NOW));
        let mut l = line("repo:o/r", &e);
        l.cap = "tool";
        assert!(!merge_line_matches(&l, &act("o/r"), NOW));
    }

    #[test]
    fn live_like_ts() {
        let e = json!({});
        let mut l = line("repo:o/r", &e);
        l.revoked = true;
        assert!(!merge_line_matches(&l, &act("o/r"), NOW));
        let u = json!({"uses": 2});
        let mut l = line("repo:o/r", &u);
        l.used_count = 1;
        assert!(merge_line_matches(&l, &act("o/r"), NOW));
        l.used_count = 2;
        assert!(!merge_line_matches(&l, &act("o/r"), NOW));
        let bad = json!({"uses": "2"});
        assert!(!merge_line_matches(
            &line("repo:o/r", &bad),
            &act("o/r"),
            NOW
        ));
        let fut = json!({"until": "2030-01-01T00:00:00.000Z"});
        let past = json!({"until": "2020-01-01T00:00:00.000Z"});
        let junk = json!({"until": "nope"});
        assert!(merge_line_matches(
            &line("repo:o/r", &fut),
            &act("o/r"),
            NOW
        ));
        assert!(!merge_line_matches(
            &line("repo:o/r", &past),
            &act("o/r"),
            NOW
        ));
        assert!(!merge_line_matches(
            &line("repo:o/r", &junk),
            &act("o/r"),
            NOW
        ));
        let tc = json!({"turnCause": "m1"});
        assert!(!merge_line_matches(
            &line("repo:o/r", &tc),
            &act("o/r"),
            NOW
        ));
        let tc0 = json!({"turnCause": ""});
        assert!(merge_line_matches(
            &line("repo:o/r", &tc0),
            &act("o/r"),
            NOW
        ));
    }

    #[test]
    fn limits_like_ts() {
        let pr = json!({"pr": 7, "head": "h"});
        assert!(merge_line_matches(&line("repo:o/r", &pr), &act("o/r"), NOW));
        let pr8 = json!({"pr": 8});
        assert!(!merge_line_matches(
            &line("repo:o/r", &pr8),
            &act("o/r"),
            NOW
        ));
        let hd = json!({"head": "z"});
        assert!(!merge_line_matches(
            &line("repo:o/r", &hd),
            &act("o/r"),
            NOW
        ));
        let gh = json!({"ghUser": "Bot"});
        assert!(!merge_line_matches(
            &line("repo:o/r", &gh),
            &act("o/r"),
            NOW
        ));
        let mut a = act("o/r");
        a.gh_user = Some("bot");
        assert!(merge_line_matches(&line("repo:o/r", &gh), &a, NOW));
        let ghn = json!({"ghUser": null});
        assert!(merge_line_matches(
            &line("repo:o/r", &ghn),
            &act("o/r"),
            NOW
        ));
        let mut a = act("o/r");
        a.ci_override = true;
        let e = json!({});
        assert!(!merge_line_matches(&line("repo:o/r", &e), &a, NOW));
        let ci = json!({"ciOverride": true});
        assert!(merge_line_matches(&line("repo:o/r", &ci), &a, NOW));
    }

    #[test]
    fn privileges_cover_line_cols() {
        for c in [
            "id",
            "mandate_id",
            "cap",
            "scope",
            "limits",
            "agent_ids",
            "granted_by",
            "via",
            "request_id",
            "used_count",
            "created_at",
            "revoked_at",
        ] {
            let k = format!("mandate_line.{c}");
            assert!(
                MERGE_CHECKS_MANDATE_PRIVILEGES.contains(&(k.as_str(), "SELECT")),
                "{k}"
            );
        }
    }
}
