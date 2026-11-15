//! S5.3 C1c-3c — 사람이 카드를 누르지 않고 **같은 스레드에 글로 답하면** 그 앞의 열린 카드를 `replied` 로 닫는다.
//! TS `services/messages.ts::closeAsksByReply`(라우트가 사람 글을 올린 뒤 부른다)를 옮긴다.
//!
//! - 닫는 문장은 TS 상수 `ASK_CLOSE_BY_REPLY_SQL` 을 골든(`ask_close_by_reply`)으로 받는다 — 고르는 조건(이 답보다 seq 가 앞,
//!   답·닫힘 없음, 거울·권한 요청·머지 거절 아님, 받는 쪽이 사람 전체이거나 답한 사람)이 TS 와 바이트로 같다.
//! - 닫힌 카드마다 TS 순서 그대로 `message.updated` → 거울 맞추기(`sync_ask_mirrors` — 묶음 알림 → 거울 닫기·거울 낸 쪽 깨움).
//! - TS 는 이 일을 커밋 뒤에 하고 실패를 삼킨다(글은 남는다). 여기서는 같은 트랜잭션의 SAVEPOINT 안에서 하고, 실패하면 그
//!   SAVEPOINT 만 되돌리고 기록한다 — 글·부름은 그대로 커밋된다. 신호는 outbox 라 커밋 뒤에 나간다.
//! - 이 단계는 `message.created`·부름 `inbox.updated` 를 outbox 에 넣은 **뒤**에 부른다(TS 라우트 순서).
use super::ask_sync::{announce_updated, sync_ask_mirrors};
use serde_json::Value;
use sqlx::{Connection, PgConnection};
use std::sync::OnceLock;

const LABEL: &str = "[ask_replied]";

fn close_sql() -> &'static str {
    static S: OnceLock<String> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = v["ask_close_by_reply"]
            .as_str()
            .expect("golden fragment ask_close_by_reply");
        // TS 는 `returning ${COLS}` 행을 그대로 내보낸다 — 여기서는 id 만 받아 같은 연결로 다시 읽는다(`announce_updated`).
        format!("with c as ({frag}) select c.id::text from c")
    })
}

/// 답글 `reply_id`(seq `reply_seq`)로 스레드 `root` 의 열린 카드를 닫는다. 던지지 않는다(모듈 주석).
pub async fn close_by_reply(
    conn: &mut PgConnection,
    root: &str,
    channel: &str,
    reply_seq: i64,
    author: &str,
    reply_id: &str,
) -> Result<(), sqlx::Error> {
    let r: Result<(), sqlx::Error> = async {
        let mut sp = conn.begin().await?;
        let ids: Vec<String> = sqlx::query_scalar(close_sql())
            .bind(root)
            .bind(channel)
            .bind(reply_seq)
            .bind(author)
            .bind(reply_id)
            .fetch_all(&mut *sp)
            .await?;
        for id in &ids {
            announce_updated(&mut sp, id).await?;
            sync_ask_mirrors(&mut sp, LABEL, id).await?;
        }
        sp.commit().await
    }
    .await;
    if let Err(e) = r {
        eprintln!("{LABEL} closing asks by reply failed (the reply is posted): {e}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_loads() {
        let s = close_sql();
        assert!(s.contains("'{ask,closedReason}', to_jsonb('replied'::text)"));
        assert!(s.contains("not (meta ? 'mergeDenial')"));
        assert!(s.contains("seq < $3::bigint"));
    }
}
