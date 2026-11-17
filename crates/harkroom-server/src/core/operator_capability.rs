//! AC6 — 오퍼레이터 능력 스냅숏(`operator_capability` 표, 마이그레이션 174).
//!
//! 오퍼레이터 코어가 이 프로세스(Rust)에 있으면 TS 허브는 비어 있어 `hub.capabilities()` 가 늘 null 이다. 그러면 TS 의
//! `checkOffered`(하네스가 밝힌 모델·effort 검사)가 늘 통과하고 `model-options` 에 `models` 가 빠진다. 그래서 Rust 가 받은
//! 능력을 표에 적고 TS 가 그 표를 읽는다.
//!
//! - 쓰기는 일꾼 **하나**가 허브 피드([`CapEvent`])를 받은 순서대로 한다 — 앞 연결 끊김(delete)과 새 연결 hello(upsert)가
//!   뒤집히지 않는다.
//! - **기동 때 표를 비우지 않는다**(Rust 서버가 여럿이면 남의 줄을 지운다). 대신 붙어 있는 오퍼레이터의 `seen_at` 을
//!   주기마다 고치고, TS 는 `seen_at` 이 낡은 줄을 「모른다」로 읽는다. 프로세스가 죽어 delete 를 못 낸 줄도 그렇게 걸러진다.
//! - 권한([`CAPABILITY_PRIVILEGES`])이 없으면 쓰지 않고 한 줄만 남긴다 — 이 스냅숏은 덧붙이는 기능이라 오퍼레이터 코어 전체를
//!   TS 로 돌리지 않는다(없으면 지금처럼 TS 검사가 「모른다」로 통과할 뿐이다).
use super::operator_hub::{CapEvent, CapFeed, OperatorHub};
use serde_json::Value;
use sqlx::PgPool;
use std::time::Duration;

pub const CAPABILITY_PRIVILEGES: &[(&str, &str)] = &[
    ("operator_capability", "SELECT"),
    ("operator_capability", "INSERT"),
    ("operator_capability", "UPDATE"),
    ("operator_capability", "DELETE"),
];

/// 한 오퍼레이터의 능력 본문 상한(직렬화 바이트). 넘으면 적지 않는다(「모른다」) — 표가 오퍼레이터 마음대로 커지지 않게.
pub const MAX_BODY_BYTES: usize = 64 * 1024;

pub const UPSERT_SQL: &str = "insert into operator_capability (operator_id, body, updated_at, seen_at) \
     select $1::uuid, $2::jsonb, now(), now() where exists (select 1 from operator where id = $1::uuid) \
     on conflict (operator_id) do update set body = excluded.body, updated_at = now(), seen_at = now()";
pub const DELETE_SQL: &str = "delete from operator_capability where operator_id = $1::uuid";
pub const TOUCH_SQL: &str =
    "update operator_capability set seen_at = now() where operator_id = any($1::uuid[])";

/// 줄 하나를 쓸 값 — 상한을 넘거나 객체가 아니면 `None`(지운다). 허브가 피드에 넣기 **전에** 부른다.
pub fn body_of(caps: Option<&Value>) -> Option<String> {
    let v = caps.filter(|v| v.is_object())?;
    let s = v.to_string();
    (s.len() <= MAX_BODY_BYTES).then_some(s)
}

async fn apply(pool: &PgPool, ev: CapEvent) -> Result<(), sqlx::Error> {
    let CapEvent(id, caps) = ev;
    if !super::msg_read::is_uuid(&id) {
        return Ok(());
    }
    match caps {
        Some(body) => sqlx::query(UPSERT_SQL)
            .bind(&id)
            .bind(body)
            .execute(pool)
            .await
            .map(|_| ()),
        None => sqlx::query(DELETE_SQL)
            .bind(&id)
            .execute(pool)
            .await
            .map(|_| ()),
    }
}

async fn touch(pool: &PgPool, hub: &OperatorHub) -> Result<(), sqlx::Error> {
    let ids: Vec<String> = hub
        .online_ids()
        .into_iter()
        .filter(|id| super::msg_read::is_uuid(id))
        .collect();
    if ids.is_empty() {
        return Ok(());
    }
    sqlx::query(TOUCH_SQL)
        .bind(ids)
        .execute(pool)
        .await
        .map(|_| ())
}

/// 일꾼을 띄운다. `touch_every` 마다 붙어 있는 오퍼레이터의 `seen_at` 을 고친다.
pub fn spawn(write: PgPool, hub: OperatorHub, touch_every: Duration) {
    let feed: CapFeed = hub.capability_feed();
    tokio::spawn(async move {
        match crate::write::missing_in(&write, CAPABILITY_PRIVILEGES, &[]).await {
            Ok(m) if m.is_empty() => {}
            Ok(m) => {
                eprintln!(
                    "core: operator capability snapshot off (missing {})",
                    m.join(", ")
                );
                return;
            }
            Err(_) => {
                eprintln!("core: operator capability snapshot off (privilege check failed)");
                return;
            }
        }
        let mut tick = tokio::time::interval(touch_every);
        tick.tick().await;
        loop {
            tokio::select! {
                batch = feed.next_batch() => {
                    for ev in batch {
                        if apply(&write, ev).await.is_err() {
                            eprintln!("core: operator capability write failed");
                        }
                    }
                }
                _ = tick.tick() => {
                    if touch(&write, &hub).await.is_err() {
                        eprintln!("core: operator capability touch failed");
                    }
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
    fn body_rules() {
        assert_eq!(body_of(None), None);
        assert_eq!(body_of(Some(&json!([1]))), None);
        assert_eq!(body_of(Some(&json!("x"))), None);
        assert_eq!(
            body_of(Some(&json!({"a":1}))).as_deref(),
            Some(r#"{"a":1}"#)
        );
        let big = "x".repeat(MAX_BODY_BYTES);
        assert_eq!(body_of(Some(&json!({ "a": big }))), None);
    }
}
