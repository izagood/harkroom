//! 깨움 전달(E2a, 그림자) — `wake` 표(181)의 대기 행을 그 에이전트가 배정된 오퍼레이터에게 `wake` 프레임으로 보내고,
//! `wake.ack` 가 오면 그 행을 `delivered` 로 적는다. 정본은 여전히 `inbox` 다: 이 일꾼이 꺼지거나 실패해도 다른 동작은 달라지지 않는다.
//!
//! - **받겠다고 밝힌 오퍼레이터에게만** 보낸다(hello 의 `wakeFrames: true` — [`OperatorHub::send_wake`]). 옛 오퍼레이터는 받지 않는다.
//! - `inbox` 를 고치지 않고 이벤트를 내지 않는다. 글 내용은 싣지 않는다(id·사유뿐).
//! - 루프 문지기(`loops::run_gated`)를 쓰지 않는다 — 붙어 있는 소켓은 이 프로세스의 것이라 서버가 여럿이면 저마다 자기 소켓에 보내야
//!   한다. 문지기 연결도 늘지 않는다. ack 쓰기는 `state = 'pending'` 일 때만이라 겹쳐도 한 번만 바뀐다.
//! - 다시 보내지 않기: 보낸 (깨움, 오퍼레이터) 쌍을 메모리에 쥔다(프로세스가 사는 동안 쌍마다 한 번). 후보에서 빠진 쌍은 버린다.
//!   거기에 [`PENDING_SQL`] 이 [`MAX_AGE_MINUTES`] 분보다 오래된 행을 보지 않으므로, 재시작해도 옛 행을 몰아 보내지 않는다.
//!   ack 를 놓친 행(구독이 밀렸거나 오퍼레이터가 답하지 않음)은 `pending` 으로 남고, inbox 가 읽히면 거울의 `CLOSE_SQL` 이 닫는다.
//! - 권한([`WAKE_DELIVER_PRIVILEGES`])이 없으면 띄우지 않는다(조용히 꺼진다).
use super::operator_hub::OperatorHub;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::HashSet;
use std::time::Duration;
use tokio::sync::broadcast;

/// 훑는 주기 — 거울(`loops::wake_mirror`)과 같다.
pub const WAKE_DELIVER_INTERVAL: Duration = Duration::from_secs(15);
/// 한 번에 보는 최대 행 수. [`PENDING_SQL`] 의 `limit` 과 같아야 한다(시험이 본다).
pub const DELIVER_BATCH: i64 = 200;
/// 이보다 오래된 대기 행은 보내지 않는다(분). [`PENDING_SQL`] 의 수와 같아야 한다(시험이 본다).
pub const MAX_AGE_MINUTES: i64 = 10;

/// 보낼 후보 — 붙어 있고 받겠다고 밝힌 오퍼레이터(`$1`)에 배정된 에이전트의 대기 깨움. 오래된 순.
pub const PENDING_SQL: &str = "select w.id::text, w.account_id::text, w.message_id::text, w.channel_id::text, \
            w.thread_root_id::text, w.work_id::text, w.reason, a.operator_id::text \
       from wake w \
       join agent_assignment a on a.agent_id = w.account_id \
      where w.state = 'pending' and a.operator_id = any($1::uuid[]) \
        and w.channel_id is not null and w.thread_root_id is not null \
        and w.created_at > now() - interval '10 minutes' \
      order by w.created_at, w.id limit 200";

/// ack — 그 오퍼레이터(`$2`)에 지금 배정된 에이전트의 깨움이고 아직 `pending` 일 때만 `delivered` 로.
pub const ACK_SQL: &str = "update wake w set state = 'delivered' \
       from agent_assignment a \
      where w.id = $1::uuid and w.state = 'pending' \
        and a.agent_id = w.account_id and a.operator_id = $2::uuid";

/// 이 일꾼이 쓰는 권한(표, 권한). 없으면 띄우지 않는다.
pub const WAKE_DELIVER_PRIVILEGES: &[(&str, &str)] = &[
    ("wake", "SELECT"),
    ("wake", "UPDATE"),
    ("agent_assignment", "SELECT"),
];

type PendingRow = (
    String,
    String,
    String,
    String,
    String,
    Option<String>,
    String,
    String,
);

/// 프레임 하나(P2 `wake`) — `workId` 는 있을 때만 싣는다.
pub fn wake_frame(
    wake_id: &str,
    agent_id: &str,
    message_id: &str,
    channel_id: &str,
    thread_root_id: &str,
    work_id: Option<&str>,
    reason: &str,
) -> Value {
    let mut f = json!({
        "type": "wake", "wakeId": wake_id, "agentId": agent_id, "messageId": message_id,
        "channelId": channel_id, "threadRootId": thread_root_id, "reason": reason,
    });
    if let Some(w) = work_id {
        f["workId"] = json!(w);
    }
    f
}

/// uuid 모양(36자, hex 와 `-`)인가 — 오퍼레이터가 보낸 `wakeId` 를 `::uuid` 로 넘기기 전에 거른다.
pub fn is_uuid_shaped(s: &str) -> bool {
    s.len() == 36
        && s.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// 한 번 훑는다 — 보낸 수. `sent` 는 이미 보낸 (깨움, 오퍼레이터) 쌍이다(후보에서 빠진 쌍은 여기서 버린다).
pub async fn deliver(
    pool: &PgPool,
    hub: &OperatorHub,
    sent: &mut HashSet<(String, String)>,
) -> Result<usize, sqlx::Error> {
    let operators = hub.wake_capable_ids();
    if operators.is_empty() {
        sent.clear();
        return Ok(0);
    }
    let rows: Vec<PendingRow> = sqlx::query_as(PENDING_SQL)
        .bind(&operators)
        .fetch_all(pool)
        .await?;
    let current: HashSet<(String, String)> =
        rows.iter().map(|r| (r.0.clone(), r.7.clone())).collect();
    sent.retain(|k| current.contains(k));
    let mut n = 0;
    for (id, agent, message, channel, root, work, reason, operator) in rows {
        let key = (id, operator);
        if sent.contains(&key) {
            continue;
        }
        let frame = wake_frame(
            &key.0,
            &agent,
            &message,
            &channel,
            &root,
            work.as_deref(),
            &reason,
        );
        // 받겠다고 밝힌 연결이 아니면(그 사이 다시 붙었으면) 보내지 않는다 — 다음에 다시 본다.
        if hub.send_wake(&key.1, &frame) {
            sent.insert(key);
            n += 1;
        }
    }
    Ok(n)
}

/// ack 하나를 적는다 — 바뀐 행 수(0 또는 1).
pub async fn ack(pool: &PgPool, operator_id: &str, wake_id: &str) -> Result<u64, sqlx::Error> {
    if !is_uuid_shaped(wake_id) {
        return Ok(0);
    }
    Ok(sqlx::query(ACK_SQL)
        .bind(wake_id)
        .bind(operator_id)
        .execute(pool)
        .await?
        .rows_affected())
}

/// 일꾼을 띄운다 — `every` 마다 보내고, 그 사이 오는 `wake.ack` 를 적는다.
pub fn spawn(write: PgPool, hub: OperatorHub, every: Duration) {
    let mut frames = hub.subscribe_frames();
    tokio::spawn(async move {
        match crate::write::missing_in(&write, WAKE_DELIVER_PRIVILEGES, &[]).await {
            Ok(m) if m.is_empty() => {}
            // 그림자 기능이라 조용히 꺼진다(한 줄만).
            Ok(m) => {
                eprintln!("core: wake delivery off (missing {})", m.join(", "));
                return;
            }
            Err(_) => {
                eprintln!("core: wake delivery off (privilege check failed)");
                return;
            }
        }
        let mut sent = HashSet::new();
        let mut tick = tokio::time::interval(every);
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                got = frames.recv() => match got {
                    Ok((operator_id, frame)) => {
                        if frame.get("type").and_then(Value::as_str) != Some("wake.ack") {
                            continue;
                        }
                        let Some(wake_id) = frame.get("wakeId").and_then(Value::as_str) else {
                            continue;
                        };
                        if ack(&write, &operator_id, wake_id).await.is_err() {
                            eprintln!("core: wake ack write failed");
                        }
                    }
                    // 놓친 ack 는 `pending` 으로 남는다 — 그림자라 받아들인다(머리말).
                    Err(broadcast::error::RecvError::Lagged(_)) => {}
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                _ = tick.tick() => {
                    if deliver(&write, &hub, &mut sent).await.is_err() {
                        eprintln!("core: wake delivery sweep failed");
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sql_matches_constants() {
        assert_eq!(WAKE_DELIVER_INTERVAL.as_secs(), 15);
        assert!(PENDING_SQL.ends_with(&format!("limit {DELIVER_BATCH}")));
        assert!(PENDING_SQL.contains(&format!("interval '{MAX_AGE_MINUTES} minutes'")));
    }

    #[test]
    fn pending_reads_only_assigned_pending_rows_and_writes_nothing() {
        assert!(PENDING_SQL.starts_with("select "));
        assert!(PENDING_SQL.contains("w.state = 'pending'"));
        assert!(PENDING_SQL.contains("join agent_assignment a on a.agent_id = w.account_id"));
        assert!(PENDING_SQL.contains("a.operator_id = any($1::uuid[])"));
        assert!(!PENDING_SQL.contains("inbox"));
    }

    #[test]
    fn ack_only_moves_pending_rows_of_that_operator() {
        assert!(ACK_SQL.starts_with("update wake w set state = 'delivered' "));
        assert!(ACK_SQL.contains("w.state = 'pending'"));
        assert!(ACK_SQL.contains("a.operator_id = $2::uuid"));
        assert!(!ACK_SQL.contains("inbox"));
        assert!(!ACK_SQL.contains("closed_at"));
    }

    #[test]
    fn privileges_never_write_outside_wake() {
        assert!(
            WAKE_DELIVER_PRIVILEGES
                .iter()
                .all(|(t, p)| *t == "wake" || *p == "SELECT")
        );
        assert!(!WAKE_DELIVER_PRIVILEGES.iter().any(|(t, _)| *t == "inbox"));
    }

    #[test]
    fn frame_shape_matches_proto() {
        let f = wake_frame("w1", "a1", "m1", "c1", "r1", None, "mention");
        assert!(f.get("workId").is_none());
        assert!(super::super::operator_hub::parse_server_frame(&f.to_string()).is_some());
        let f = wake_frame("w1", "a1", "m1", "c1", "r1", Some("k1"), "mention");
        let p: harkroom_proto::p2::ServerToOperatorFrame = serde_json::from_value(f).unwrap();
        assert_eq!(
            p,
            harkroom_proto::p2::ServerToOperatorFrame::Wake {
                wake_id: "w1".into(),
                agent_id: "a1".into(),
                message_id: "m1".into(),
                channel_id: "c1".into(),
                thread_root_id: "r1".into(),
                work_id: Some("k1".into()),
                reason: "mention".into(),
            }
        );
    }

    #[test]
    fn uuid_shape() {
        assert!(is_uuid_shaped("00000000-0000-4000-8000-00000000000a"));
        assert!(!is_uuid_shaped("w1"));
        assert!(!is_uuid_shaped("00000000-0000-4000-8000-00000000000'"));
    }
}
