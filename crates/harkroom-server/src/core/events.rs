//! 이벤트 허브 — 프로세스 안 팬아웃(TS `events.ts` 의 `emitEvent`/`onEvent`)과 outbox 공급(TS `eventBus.ts`).
//!
//! - 받는 사람 판정(`visible_to`)과 outbox 모양 검사(`to_workspace_event`)의 표는 `golden/events.json` 이고, 그 파일이 TS 의
//!   `EVENT_VISIBILITY`·`AUDIENCE_TYPES`·`ACCOUNT_TYPES`·`EVENT_BUS_TYPES` 와 같은지는 `packages/server/test/rustEventGolden.test.ts` 가 본다.
//! - outbox 는 TS 와 같이 **알림이 온 순서대로 하나씩** 다시 읽는다(알림 순서 = 커밋 순서, id 순서는 아니다).
//! - 허브는 `tokio::sync::broadcast` 다. 느린 소켓이 밀려 이벤트를 놓치면(`Lagged`) 그 소켓을 닫는다 — 조용히 빠진 채 남기보다
//!   다시 붙어 새로 읽게 한다(TS 는 동기 emit 이라 이 경우가 없다).
use serde_json::Value;
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, OnceLock};
use tokio::sync::broadcast;

pub const EVENT_OUTBOX_CHANNEL: &str = harkroom_bus::EVENT_OUTBOX_CHANNEL;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    Audience,
    Account,
    Everyone,
}

struct Tables {
    visibility: HashMap<String, Rule>,
    bus_all: HashSet<String>,
    bus_audience: HashSet<String>,
    bus_account: HashSet<String>,
}

fn tables() -> &'static Tables {
    static T: OnceLock<Tables> = OnceLock::new();
    T.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/events.json"))
            .expect("golden/events.json");
        let visibility = v["visibility"]
            .as_object()
            .expect("visibility")
            .iter()
            .map(|(k, r)| {
                let rule = match r.as_str() {
                    Some("audience") => Rule::Audience,
                    Some("account") => Rule::Account,
                    Some("everyone") => Rule::Everyone,
                    other => panic!("unknown rule {other:?}"),
                };
                (k.clone(), rule)
            })
            .collect();
        let set = |k: &str| -> HashSet<String> {
            v["bus"][k]
                .as_array()
                .expect(k)
                .iter()
                .filter_map(|x| x.as_str().map(str::to_owned))
                .collect()
        };
        Tables {
            visibility,
            bus_all: set("all"),
            bus_audience: set("audience"),
            bus_account: set("account"),
        }
    })
}

/// TS `visibleTo` — 모르는 종류는 아무에게도 보내지 않는다.
pub fn visible_to(e: &Value, account_id: &str) -> bool {
    let Some(ty) = e.get("type").and_then(Value::as_str) else {
        return false;
    };
    match tables().visibility.get(ty) {
        Some(Rule::Audience) => match e.get("audience") {
            Some(Value::String(s)) => s == "all",
            Some(Value::Array(a)) => a.iter().any(|x| x.as_str() == Some(account_id)),
            _ => false,
        },
        Some(Rule::Account) => e.get("accountId").and_then(Value::as_str) == Some(account_id),
        Some(Rule::Everyone) => true,
        None => false,
    }
}

/// TS `toWorkspaceEvent` — outbox 에서 읽은 값이 받아들일 꼴인가.
pub fn to_workspace_event(v: &Value) -> bool {
    let Some(o) = v.as_object() else { return false };
    let Some(ty) = o.get("type").and_then(Value::as_str) else {
        return false;
    };
    let t = tables();
    if !t.bus_all.contains(ty) {
        return false;
    }
    if t.bus_audience.contains(ty) {
        let ok = match o.get("audience") {
            Some(Value::String(s)) => s == "all",
            Some(Value::Array(a)) => a.iter().all(Value::is_string),
            _ => false,
        };
        if !ok {
            return false;
        }
    }
    if t.bus_account.contains(ty) && !o.get("accountId").is_some_and(Value::is_string) {
        return false;
    }
    true
}

#[derive(Clone)]
pub struct Hub {
    tx: broadcast::Sender<Arc<Value>>,
}

impl Default for Hub {
    fn default() -> Self {
        Self::new()
    }
}

impl Hub {
    pub fn new() -> Self {
        Self {
            tx: broadcast::channel(4096).0,
        }
    }

    /// TS `emitEvent` — 듣는 소켓이 없으면 버려진다(TS 와 같다).
    pub fn emit(&self, e: Value) {
        let _ = self.tx.send(Arc::new(e));
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<Value>> {
        self.tx.subscribe()
    }
}

/// outbox 공급 — `LISTEN harkroom_event_outbox` → id 로 다시 읽어 모양을 보고 허브로. 끊기면 sqlx 가 다시 붙는다.
pub fn spawn_outbox_listener(pool: PgPool, hub: Hub) {
    tokio::spawn(async move {
        loop {
            let mut listener = match sqlx::postgres::PgListener::connect_with(&pool).await {
                Ok(l) => l,
                Err(e) => {
                    eprintln!(
                        "core: outbox listen connect failed ({})",
                        e.as_database_error().map_or("io", |_| "db")
                    );
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    continue;
                }
            };
            if listener.listen(EVENT_OUTBOX_CHANNEL).await.is_err() {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                continue;
            }
            eprintln!("core: listening on {EVENT_OUTBOX_CHANNEL}");
            loop {
                let n = match listener.recv().await {
                    Ok(n) => n,
                    Err(_) => break,
                };
                let id = n.payload();
                // TS 와 같은 꼴만(1~19자리 양수).
                if id.is_empty()
                    || id.len() > 19
                    || id.starts_with('0')
                    || !id.bytes().all(|b| b.is_ascii_digit())
                {
                    continue;
                }
                let row: Option<String> = sqlx::query_scalar(
                    "select event::text from event_outbox where id = $1::bigint",
                )
                .bind(id)
                .fetch_optional(&pool)
                .await
                .ok()
                .flatten();
                if let Some(v) = row.and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    && to_workspace_event(&v)
                {
                    hub.emit(v);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn visibility_follows_golden() {
        assert!(visible_to(
            &json!({ "type": "message.created", "audience": "all" }),
            "a"
        ));
        assert!(visible_to(
            &json!({ "type": "message.created", "audience": ["a"] }),
            "a"
        ));
        assert!(!visible_to(
            &json!({ "type": "message.created", "audience": ["b"] }),
            "a"
        ));
        assert!(visible_to(
            &json!({ "type": "inbox.updated", "accountId": "a" }),
            "a"
        ));
        assert!(!visible_to(
            &json!({ "type": "inbox.updated", "accountId": "b" }),
            "a"
        ));
        assert!(visible_to(
            &json!({ "type": "presence.changed", "accountId": "b" }),
            "a"
        ));
        assert!(
            !visible_to(&json!({ "type": "nope", "audience": "all" }), "a"),
            "모르는 종류는 아무에게도"
        );
    }

    #[test]
    fn outbox_shape_follows_golden() {
        assert!(to_workspace_event(
            &json!({ "type": "agent_team.changed", "teamId": "t", "audience": "all" })
        ));
        assert!(
            !to_workspace_event(&json!({ "type": "agent_team.changed", "teamId": "t" })),
            "audience 없음"
        );
        assert!(
            !to_workspace_event(&json!({ "type": "inbox.updated" })),
            "accountId 없음"
        );
        assert!(!to_workspace_event(
            &json!({ "type": "typing.whatever", "audience": "all" })
        ));
        assert!(!to_workspace_event(&json!([1])));
    }
}
