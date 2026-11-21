//! C4b — `grant.list`. [`super::tools`] 와 같은 약속이다 — TS 와 **같은 글자**(대조: `rustFrontDb.test.ts` 의 MCP 줄), zod 가 그대로
//! 받는 인자만, DB 오류·모르는 꼴은 TS 로.
//!
//! - 문장은 TS 정본 `LIST_DELEGATIONS_MINE_SQL`·`LIST_DELEGATIONS_GIVEN_SQL`(services/apiDelegation.ts)·`LIST_TOOL_RULES_SQL`
//!   (services/permissionRequests.ts)을 `golden/sql_fragments.json` 에서 읽는다.
//! - 명령 허용 줄의 `active` 는 TS `validateToolRule` 과 같은 판정이어야 한다 — 사본을 두지 않고 `harkroom_proto::tool_rules`(서버·hook·
//!   오퍼레이터가 함께 쓰고 TS 골든으로 고정한 것)를 쓴다.
//! - 지금 볼 수 없는 채널의 규칙은 글자를 싣지 않고 개수(`hiddenToolRules`)만 센다(TS `assertChannelVisible` = [`crate::core::channels::visible`]).
use super::reads2::jsonb_as_js;
use super::respond::{minify, text_result};
use crate::auth::Account;
use harkroom_proto::tool_rules::{ToolRuleVerdict, validate_tool_rule};
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;

struct Sql {
    mine: String,
    given: String,
    rules: String,
}

fn sql() -> &'static Sql {
    static S: std::sync::OnceLock<Sql> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        let f = crate::core::channels::frag;
        let rows = crate::core::channels::rows_sql;
        Sql {
            // timestamptz 칸(`expiresAt`)만 toISOString 꼴로. `limits`(jsonb)는 값 그대로 — 키 순서는 jsonb 출력이다.
            mine: rows(f("list_delegations_mine"), &["expiresAt"]),
            given: rows(f("list_delegations_given"), &["expiresAt"]),
            // 겉 정렬은 안쪽 문장과 같은 `order by scope` 다(같은 DB·같은 정렬 규칙).
            rules: format!(
                "select t.scope, to_char(t.\"expiresAt\" at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"'), t.\"mayDecide\" \
                   from ({}) t order by t.scope",
                f("list_tool_rules")
            ),
        }
    })
}

/// TS `parseToolScope` — `TOOL_SCOPE_RE = /^tool:(<uuid 소문자>):(.+)$/s`.
pub(crate) fn parse_tool_scope(scope: &str) -> Option<(&str, &str)> {
    static R: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = R.get_or_init(|| {
        regex::Regex::new(
            r"(?s)^tool:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(.+)$",
        )
        .expect("tool scope re")
    });
    let c = re.captures(scope)?;
    Some((c.get(1)?.as_str(), c.get(2)?.as_str()))
}

/// TS `active: r.mayDecide && v.ok && v.rule === p.rule`.
fn rule_active(may_decide: bool, rule: &str) -> bool {
    may_decide
        && matches!(validate_tool_rule(rule), ToolRuleVerdict::Ok { rule: r, .. } if r == rule)
}

async fn rows_text(pool: &PgPool, q: &'static str, me: &str) -> Option<String> {
    let t: String = sqlx::query_scalar(q).bind(me).fetch_one(pool).await.ok()?;
    // jsonb(`limits`) 안에 정수가 아닌 수가 있으면 JS 의 수 표기와 갈릴 수 있다 → TS 로.
    jsonb_as_js(&minify(&t))
}

pub(super) async fn answer(
    pool: &PgPool,
    me: &Account,
    tool: &str,
    args: &Value,
) -> Option<String> {
    // `inputSchema: {}` — 빈 모양이라도 스키마가 있으면 SDK 는 `arguments` 가 객체여야 받는다(없으면 검증 오류 → TS).
    if tool != "grant.list" || !args.is_object() {
        return None;
    }
    let s = sql();
    let mine = rows_text(pool, s.mine.as_str(), &me.id).await?;
    let given = rows_text(pool, s.given.as_str(), &me.id).await?;
    let rows: Vec<(String, Option<String>, bool)> = sqlx::query_as(s.rules.as_str())
        .bind(&me.id)
        .bind("now")
        .fetch_all(pool)
        .await
        .ok()?;
    let mut visible: HashMap<String, bool> = HashMap::new();
    let mut hidden = 0u64;
    let mut rules = Vec::new();
    for (scope, expires, may_decide) in rows {
        let Some((channel, rule)) = parse_tool_scope(&scope) else {
            continue;
        };
        if !visible.contains_key(channel) {
            let v = crate::core::channels::visible(pool, &me.id, channel)
                .await
                .ok()?;
            visible.insert(channel.to_owned(), v);
        }
        if !visible[channel] {
            hidden += 1;
            continue;
        }
        rules.push(format!(
            "{{\"channelId\":{},\"rule\":{},\"expiresAt\":{},\"active\":{}}}",
            Value::from(channel),
            Value::from(rule),
            expires.map_or(Value::Null, Value::from),
            rule_active(may_decide, rule),
        ));
    }
    Some(text_result(&format!(
        "{{\"mine\":{mine},\"given\":{given},\"toolRules\":[{}],\"hiddenToolRules\":{hidden}}}",
        rules.join(",")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scope_parse_like_ts() {
        let id = "0b7f3f92-3fa6-494a-8ab3-76d0d2a6a1c0";
        assert_eq!(
            parse_tool_scope(&format!("tool:{id}:Bash(kubectl get pods:*)")),
            Some((id, "Bash(kubectl get pods:*)"))
        );
        // 대문자 uuid·빈 규칙·접두 틀림은 TS 정규식도 받지 않는다.
        assert_eq!(
            parse_tool_scope(&format!("tool:{}:x", id.to_uppercase())),
            None
        );
        assert_eq!(parse_tool_scope(&format!("tool:{id}:")), None);
        assert_eq!(parse_tool_scope(&format!("tools:{id}:x")), None);
        // `s` 깃발 — 규칙 안 줄바꿈도 `.` 이 받는다.
        assert_eq!(
            parse_tool_scope(&format!("tool:{id}:a\nb")),
            Some((id, "a\nb"))
        );
    }

    /// security 조건(C4b) — server 빌드(server 의 regex·의존 그래프) 위에서 TS 정본 판정 골든(`harkroom-operator/golden/tool_rules.json`,
    /// TS `validateToolRule` 이 낸 값)을 다시 돌린다. `active` 가 보는 두 칸(ok·정규형 rule)이 한 글자도 다르지 않아야 한다.
    #[test]
    fn tool_rules_ts_golden_on_server_build() {
        let g: Value = serde_json::from_str(include_str!(
            "../../../../harkroom-operator/golden/tool_rules.json"
        ))
        .unwrap();
        let mut n = 0;
        for c in g["rules"].as_array().unwrap() {
            let input = c["input"].as_str().unwrap();
            let want = &c["want"];
            match validate_tool_rule(input) {
                ToolRuleVerdict::Ok { rule, .. } => {
                    assert_eq!(want["ok"], true, "{input}");
                    assert_eq!(want["rule"], rule.as_str(), "{input}");
                    assert_eq!(rule_active(true, input), rule == input, "{input}");
                }
                ToolRuleVerdict::Refused(code) => {
                    assert_eq!(want["ok"], false, "{input}");
                    assert_eq!(want["code"], code, "{input}");
                    assert!(!rule_active(true, input), "{input}");
                }
            }
            n += 1;
        }
        assert!(n > 50, "골든 사례가 너무 적다: {n}");
    }

    #[test]
    fn active_uses_shared_verdict() {
        assert!(rule_active(true, "Bash(kubectl get pods:*)"));
        assert!(!rule_active(false, "Bash(kubectl get pods:*)"));
        // 정규형과 글자가 다르면(공백) 거짓 — TS `v.rule === p.rule`.
        assert!(!rule_active(true, "Bash(kubectl  get pods:*)"));
        assert!(!rule_active(true, "Bash(*)"));
    }

    #[test]
    fn statements_follow_ts_source() {
        let tr = include_str!("../../../../../packages/shared/src/toolRules.ts");
        assert!(tr.contains(
            "const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';"
        ));
        assert!(tr.contains("const TOOL_SCOPE_RE = new RegExp(`^tool:(${UUID}):(.+)$`, 's');"));
    }
}
