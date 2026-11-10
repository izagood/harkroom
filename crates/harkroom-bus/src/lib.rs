//! 이벤트 버스의 **쓰는 쪽**(S5.0, Rust 전환). 받는 쪽은 TS 서버의 `packages/server/src/eventBus.ts` 다.
//!
//! 계약(마이그레이션 `168_event_outbox.sql`):
//! - 한 트랜잭션에서 `insert into event_outbox(event) values ($1) returning id` 뒤
//!   `select pg_notify('harkroom_event_outbox', id::text)` 를 부른다.
//! - NOTIFY 는 커밋될 때만 나가므로, 받는 쪽이 id 로 다시 읽을 때 줄이 이미 있다. 롤백하면 둘 다 사라진다.
//! - 페이로드는 **id 만**이다(NOTIFY 는 8000바이트 미만이라 이벤트 본문을 싣지 않는다).
//!
//! 이벤트 모양은 여기서 검사하지 않는다 — 받는 쪽이 `events.ts` 의 종류·모양으로 거르고, 그 뒤 TS 가 직접 낸
//! 이벤트와 같은 가시성 판정(`visibleTo`)을 지난다. 이 crate 는 아직 어디에도 연결되지 않았다.

use sqlx::{PgConnection, Postgres, Transaction};

/// 받는 쪽이 LISTEN 하는 채널 이름(`eventBus.ts::EVENT_OUTBOX_CHANNEL` 과 같아야 한다).
pub const EVENT_OUTBOX_CHANNEL: &str = "harkroom_event_outbox";

/// 이벤트 하나를 호출자의 트랜잭션 안에서 outbox 에 넣고 알린다. 돌려주는 값은 outbox 줄의 id 다.
///
/// 호출자가 커밋해야 받는 쪽에 닿는다 — 이벤트를 일으킨 쓰기와 같은 트랜잭션에 묶으면
/// 「쓰기는 됐는데 이벤트는 안 나감」·「이벤트는 나갔는데 쓰기는 롤백」이 생기지 않는다.
pub async fn publish(
    tx: &mut Transaction<'_, Postgres>,
    event: &serde_json::Value,
) -> Result<i64, sqlx::Error> {
    publish_on(tx, event).await
}

/// [`publish`] 와 같되 연결을 직접 받는다(이미 트랜잭션을 연 연결이거나, 자동 커밋 한 건이면 그대로).
pub async fn publish_on(
    conn: &mut PgConnection,
    event: &serde_json::Value,
) -> Result<i64, sqlx::Error> {
    let (id,): (i64,) = sqlx::query_as("insert into event_outbox(event) values ($1) returning id")
        .bind(sqlx::types::Json(event))
        .fetch_one(&mut *conn)
        .await?;
    sqlx::query("select pg_notify($1, $2)")
        .bind(EVENT_OUTBOX_CHANNEL)
        .bind(id.to_string())
        .execute(&mut *conn)
        .await?;
    Ok(id)
}
