//! S5.4 A2a — `agent.modelOptions`(TS mcpPlugin.ts `agent.modelOptions` → routes/threadAgentModelRoutes.ts `agentModelOptions`
//! · services/operatorCapabilities.ts `offeredModels` · services/agentModelPicks.ts `readPickable`).
//!
//! **오퍼레이터 코어가 Rust 에 있을 때만**(`McpWrites::relay_moved`) 답한다. 그때 TS 허브는 비어 있어 TS 도 능력 스냅숏
//! (`operator_capability`, `seen_at` 이 [`SNAPSHOT_FRESH_SEC`] 초 안)만 읽는다 — Rust 가 같은 표를 같은 조건으로 읽으면 같은 답이다.
//! 코어가 TS 에 있으면 하네스 목록이 TS 허브(프로세스 메모리)에만 있으니 TS 가 답한다.
//!
//! 글자는 TS `jsonResult` = `JSON.stringify` 와 같게 키 순서를 손으로 짓는다(serde_json 맵은 키를 정렬한다).
//! 인자가 zod 를 못 지나거나(ASCII 밖 handle 포함 — UTF-16 길이·`lower` 차이를 피한다) DB 오류면 `None`(→ TS).
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// TS `SNAPSHOT_FRESH_SEC`.
pub const SNAPSHOT_FRESH_SEC: i32 = 180;

const FIND_SQL: &str = "select id::text from account where lower(handle) = lower($1) and kind = 'agent' and deleted_at is null";
pub(crate) const OPTS_SQL: &str = "select c.harness, c.model, c.effort, c.agent_pickable_models \
       from account a left join agent_config c on c.account_id = a.id \
      where a.id = $1::uuid and a.kind = 'agent' and a.deleted_at is null";
pub(crate) const ASSIGNMENT_SQL: &str =
    "select operator_id::text from agent_assignment where agent_id = $1::uuid";
pub(crate) const SNAPSHOT_SQL: &str = "select body from operator_capability \
      where operator_id = $1::uuid and seen_at > now() - make_interval(secs => $2)";

const SELF_REASON: &str = "자기 자신의 모델은 고를 수 없다 — 사람만 바꾼다";
const EMPTY_REASON: &str = "그 에이전트의 소유자가 고를 수 있는 모델을 켜지 않았다";

fn s(v: &str) -> String {
    Value::from(v).to_string()
}

fn opt_s(v: Option<&str>) -> String {
    v.map(s).unwrap_or_else(|| "null".into())
}

fn str_list(v: &[String]) -> String {
    format!("[{}]", v.iter().map(|x| s(x)).collect::<Vec<_>>().join(","))
}

/// zod `handle: z.string().min(1).max(64)`. ASCII 만 받는다(그 밖은 TS).
pub fn parse_handle(args: &Value) -> Option<&str> {
    let h = args.as_object()?.get("handle")?.as_str()?;
    (h.is_ascii() && (1..=64).contains(&h.len())).then_some(h)
}

#[derive(Debug, Clone, PartialEq)]
pub struct HarnessModel {
    pub id: String,
    pub label: Option<String>,
    pub efforts: Option<Vec<String>>,
}

/// TS `narrowModels` — 문자열 `id` 가 있는 항목만, `efforts` 는 문자열만.
fn narrow_models(raw: &Value) -> Option<Vec<HarnessModel>> {
    let arr = raw.as_array()?;
    Some(
        arr.iter()
            .filter_map(|m| {
                let o = m.as_object()?;
                let id = o.get("id")?.as_str()?.to_string();
                let label = o.get("label").and_then(Value::as_str).map(str::to_string);
                let efforts = o.get("efforts").and_then(Value::as_array).map(|a| {
                    a.iter()
                        .filter_map(|e| e.as_str().map(str::to_string))
                        .collect()
                });
                Some(HarnessModel { id, label, efforts })
            })
            .collect(),
    )
}

/// TS `modelsIn` — 그 하네스가 밝힌 목록. 모르면 `None`.
pub fn models_in(caps: &Value, harness: &str) -> Option<Vec<HarnessModel>> {
    let h = caps
        .as_object()?
        .get("harnesses")?
        .as_object()?
        .get(harness)?;
    narrow_models(h.as_object()?.get("models")?)
}

/// TS `readPickable` — 모양이 틀린 줄은 버린다.
pub fn read_pickable(raw: Option<&Value>) -> Vec<(String, Vec<String>)> {
    let Some(arr) = raw.and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|e| {
            let o = e.as_object()?;
            let model = o.get("model")?.as_str().filter(|m| !m.is_empty())?;
            let efforts = o
                .get("efforts")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            Some((model.to_string(), efforts))
        })
        .collect()
}

/// TS 도구 본문의 `pickable` 교집합(결정 11) — 글자로.
pub fn pickable_text(
    pickable: &[(String, Vec<String>)],
    models: Option<&[HarnessModel]>,
) -> (String, usize) {
    let mut out = Vec::new();
    for (model, efforts) in pickable {
        let offered = models.and_then(|ms| ms.iter().find(|m| &m.id == model));
        if models.is_some() && offered.is_none() {
            continue;
        }
        let efforts: Vec<String> = match offered.and_then(|o| o.efforts.as_ref()) {
            Some(ok) => efforts.iter().filter(|x| ok.contains(x)).cloned().collect(),
            None => efforts.clone(),
        };
        let label = offered
            .and_then(|o| o.label.as_deref())
            .map(|l| format!(",\"label\":{}", s(l)))
            .unwrap_or_default();
        out.push(format!(
            "{{\"id\":{}{label},\"efforts\":{}}}",
            s(model),
            str_list(&efforts)
        ));
    }
    let n = out.len();
    (format!("[{}]", out.join(",")), n)
}

fn unknown(handle: &str) -> String {
    super::tools::err("unknown_handle", &format!("no agent with handle @{handle}"))
}

pub async fn answer(pool: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let handle = parse_handle(args)?;
    let found: Vec<String> = sqlx::query_scalar(FIND_SQL)
        .bind(handle.strip_prefix('@').unwrap_or(handle))
        .fetch_all(pool)
        .await
        .ok()?;
    // TS 는 `rows[0]` — 둘 이상이면 어느 줄인지 정해지지 않으니 TS 로.
    let agent_id = match found.as_slice() {
        [] => return Some(unknown(handle)),
        [one] => one.clone(),
        _ => return None,
    };
    if agent_id == me.id {
        return Some(super::respond::text_result(&format!(
            "{{\"agentId\":{},\"pickable\":[],\"reason\":{}}}",
            s(&agent_id),
            s(SELF_REASON)
        )));
    }
    #[allow(clippy::type_complexity)]
    let row: Option<(
        Option<String>,
        Option<String>,
        Option<String>,
        Option<Value>,
    )> = sqlx::query_as(OPTS_SQL)
        .bind(&agent_id)
        .fetch_optional(pool)
        .await
        .ok()?;
    let Some((harness, model, effort, pickable)) = row else {
        return Some(unknown(handle));
    };
    let harness = harness.unwrap_or_else(|| "claude-code".into());
    let operator: Option<String> = sqlx::query_scalar(ASSIGNMENT_SQL)
        .bind(&agent_id)
        .fetch_optional(pool)
        .await
        .ok()?;
    let models = match operator {
        Some(op) => {
            let body: Option<Value> = sqlx::query_scalar(SNAPSHOT_SQL)
                .bind(&op)
                .bind(SNAPSHOT_FRESH_SEC)
                .fetch_optional(pool)
                .await
                .ok()?;
            body.as_ref().and_then(|b| models_in(b, &harness))
        }
        None => None,
    };
    let (picks, n) = pickable_text(&read_pickable(pickable.as_ref()), models.as_deref());
    let reason = if n == 0 {
        format!(",\"reason\":{}", s(EMPTY_REASON))
    } else {
        String::new()
    };
    Some(super::respond::text_result(&format!(
        "{{\"agentId\":{},\"harness\":{},\"defaultModel\":{},\"defaultEffort\":{},\"pickable\":{picks}{reason}}}",
        s(&agent_id),
        s(&harness),
        opt_s(model.as_deref()),
        opt_s(effort.as_deref()),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn handle_follows_zod() {
        assert_eq!(parse_handle(&json!({"handle": "alice"})), Some("alice"));
        assert_eq!(
            parse_handle(&json!({"handle": "@bob.x-1"})),
            Some("@bob.x-1")
        );
        assert_eq!(parse_handle(&json!({"handle": ""})), None);
        assert_eq!(parse_handle(&json!({"handle": "a".repeat(65)})), None);
        assert_eq!(parse_handle(&json!({"handle": "가"})), None);
        assert_eq!(parse_handle(&json!({"handle": 1})), None);
        assert_eq!(parse_handle(&json!({})), None);
    }

    #[test]
    fn models_in_narrows_like_ts() {
        let caps = json!({"harnesses": {"claude-code": {"models": [
            {"id": "m1", "label": "M one", "efforts": ["low", 3, "high"]},
            {"id": 2},
            {"label": "no id"},
            {"id": "m2", "label": 5}
        ]}}});
        let m = models_in(&caps, "claude-code").unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(
            m[0].efforts.as_deref(),
            Some(&["low".to_string(), "high".to_string()][..])
        );
        assert_eq!(m[1].label, None);
        assert_eq!(m[1].efforts, None);
        assert!(models_in(&caps, "codex").is_none());
        assert!(models_in(&json!({"harnesses": []}), "claude-code").is_none());
        assert!(
            models_in(
                &json!({"harnesses": {"claude-code": {"models": {}}}}),
                "claude-code"
            )
            .is_none()
        );
    }

    #[test]
    fn pickable_intersects_like_ts() {
        let pick = read_pickable(Some(&json!([
            {"model": "m1", "efforts": ["low", "max"]},
            {"model": "m9", "efforts": ["high"]},
            {"model": "", "efforts": []},
            {"model": "m2"},
            "junk"
        ])));
        assert_eq!(pick.len(), 3);
        // 하네스 목록을 모르면 허용 목록 그대로, label 없음.
        let (t, n) = pickable_text(&pick, None);
        assert_eq!(n, 3);
        assert_eq!(
            t,
            r#"[{"id":"m1","efforts":["low","max"]},{"id":"m9","efforts":["high"]},{"id":"m2","efforts":[]}]"#
        );
        let models = vec![
            HarnessModel {
                id: "m1".into(),
                label: Some("M one".into()),
                efforts: Some(vec!["low".into(), "high".into()]),
            },
            HarnessModel {
                id: "m2".into(),
                label: None,
                efforts: None,
            },
        ];
        let (t, n) = pickable_text(&pick, Some(&models));
        assert_eq!(n, 2);
        assert_eq!(
            t,
            r#"[{"id":"m1","label":"M one","efforts":["low"]},{"id":"m2","efforts":[]}]"#
        );
        let (t, n) = pickable_text(&[], Some(&models));
        assert_eq!((t.as_str(), n), ("[]", 0));
    }
}
