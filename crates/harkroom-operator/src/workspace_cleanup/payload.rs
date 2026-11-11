//! 소켓 4요청의 payload 읽기 — TS `daemonProtocol.ts` 의 `readWorkspaceCleanupSettingsPayload`·`readWorkspaceCleanupActPayload` 이식.

use super::HumanAction;
use serde_json::{Map, Value};

/// `workspaceCleanupSettingsSet` — `enabled`(bool)·`graceDays`(정수) 둘 다 선택이고 하나는 있어야 한다. 1~30 자르기는 서비스가 한다.
pub fn read_settings_payload(payload: Option<&Value>) -> Result<Value, String> {
    let Some(Value::Object(p)) = payload else {
        return Err("workspaceCleanupSettingsSet 에는 enabled 나 graceDays 가 필요하다".into());
    };
    let mut out = Map::new();
    match p.get("enabled") {
        None => {}
        Some(Value::Bool(b)) => {
            out.insert("enabled".into(), Value::Bool(*b));
        }
        Some(_) => return Err("enabled 는 boolean 이어야 한다".into()),
    }
    match p.get("graceDays") {
        None => {}
        Some(v @ Value::Number(n))
            if n.is_i64() || n.is_u64() || n.as_f64().is_some_and(|f| f.fract() == 0.0) =>
        {
            out.insert("graceDays".into(), v.clone());
        }
        Some(_) => return Err("graceDays 는 정수여야 한다".into()),
    }
    if out.is_empty() {
        return Err("enabled 나 graceDays 가 필요하다".into());
    }
    Ok(Value::Object(out))
}

/// `workspaceCleanupAct` — 원장의 절대 경로·동작·누른 사람의 계정 id(uuid 꼴).
pub fn read_act_payload(payload: Option<&Value>) -> Result<(String, HumanAction, String), String> {
    let p = payload.and_then(Value::as_object);
    let path = p
        .and_then(|p| p.get("path"))
        .and_then(Value::as_str)
        .filter(|s| s.starts_with('/'))
        .ok_or("path 는 원장의 절대 경로여야 한다")?;
    let action = p
        .and_then(|p| p.get("action"))
        .and_then(Value::as_str)
        .and_then(HumanAction::parse)
        .ok_or("action 은 keep·unkeep·list·deleteNow 중 하나다")?;
    let by = p
        .and_then(|p| p.get("by"))
        .and_then(Value::as_str)
        .filter(|s| crate::local_agents::is_uuid_shape(s))
        .ok_or("by 는 계정 id 여야 한다")?;
    Ok((path.to_string(), action, by.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_payload_matches_ts() {
        assert!(read_settings_payload(None).is_err());
        assert!(read_settings_payload(Some(&json!({}))).is_err());
        assert!(read_settings_payload(Some(&json!({"enabled": "yes"}))).is_err());
        assert!(read_settings_payload(Some(&json!({"graceDays": 1.5}))).is_err());
        assert_eq!(
            read_settings_payload(Some(&json!({"enabled": true, "graceDays": 40, "x": 1})))
                .unwrap(),
            json!({"enabled": true, "graceDays": 40})
        );
    }

    #[test]
    fn act_payload_matches_ts() {
        let by = "2c8c1910-da9c-47bc-a483-ce41a1217d85";
        assert!(
            read_act_payload(Some(&json!({"path": "rel", "action": "keep", "by": by}))).is_err()
        );
        assert!(read_act_payload(Some(&json!({"path": "/a", "action": "rm", "by": by}))).is_err());
        assert!(
            read_act_payload(Some(
                &json!({"path": "/a", "action": "keep", "by": "jaebin"})
            ))
            .is_err()
        );
        let (p, a, b) = read_act_payload(Some(
            &json!({"path": "/a", "action": "deleteNow", "by": by}),
        ))
        .unwrap();
        assert_eq!(
            (p.as_str(), a, b.as_str()),
            ("/a", HumanAction::DeleteNow, by)
        );
    }
}
