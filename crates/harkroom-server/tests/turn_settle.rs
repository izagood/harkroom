//! 릴레이 cancel 뒤의 정리(C6c-3, `core/turn_settle.rs` — TS `settleCanceledTurn`)를 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! 쓰기 풀은 `HARKROOM_TEST_WRITE_DATABASE_URL`(있으면 `OPERATOR_PRIVILEGES` 만 가진 역할) — 정리 권한이 모자라면 여기서 빨개진다.
use harkroom_server::core::turn_settle::settle_canceled_turn;
use serde_json::{Value, json};
use sqlx::PgPool;

async fn account(admin: &PgPool, handle: &str) -> String {
    sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
    )
    .bind(handle)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn message(
    admin: &PgPool,
    ch: &str,
    author: &str,
    root: Option<&str>,
    kind: &str,
    meta: Value,
) -> String {
    sqlx::query_scalar(
        "insert into message(channel_id, author_id, thread_root_id, body, kind, meta) \
         values ($1::uuid, $2::uuid, $3::uuid, 'x', $4, $5::jsonb) returning id::text",
    )
    .bind(ch)
    .bind(author)
    .bind(root)
    .bind(kind)
    .bind(meta.to_string())
    .fetch_one(admin)
    .await
    .unwrap()
}

/// 위임 하나(팀장·팀원들) — 위임 글 meta 의 열린 목록까지.
async fn delegation(
    admin: &PgPool,
    ch: &str,
    root: &str,
    lead: &str,
    members: &[&str],
) -> (String, String) {
    let open: Vec<&str> = members.to_vec();
    let msg = message(
        admin,
        ch,
        lead,
        Some(root),
        "user",
        json!({ "kind": "delegation", "delegation": { "open": open } }),
    )
    .await;
    let d: String = sqlx::query_scalar(
        "insert into team_delegation(message_id, lead_account_id, channel_id, thread_root_id, deadline_at) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now() + interval '1 hour') returning id::text",
    )
    .bind(&msg)
    .bind(lead)
    .bind(ch)
    .bind(root)
    .fetch_one(admin)
    .await
    .unwrap();
    for m in members {
        sqlx::query("insert into team_delegation_item(delegation_id, delegate_account_id) values ($1::uuid, $2::uuid)")
            .bind(&d)
            .bind(m)
            .execute(admin)
            .await
            .unwrap();
    }
    (d, msg)
}

/// 예약 하나 — 대기 줄과 agent_wake.
async fn wake(admin: &PgPool, ch: &str, who: &str, root: &str, meta: Value) -> String {
    let m = message(admin, ch, who, Some(root), "wake", json!({ "wake": meta })).await;
    sqlx::query(
        "insert into agent_wake(account_id, channel_id, message_id, wake_at) values ($1::uuid, $2::uuid, $3::uuid, now() + interval '1 hour')",
    )
    .bind(who)
    .bind(ch)
    .bind(&m)
    .execute(admin)
    .await
    .unwrap();
    m
}

async fn wake_state(admin: &PgPool, m: &str) -> (bool, Option<String>, Option<String>) {
    sqlx::query_as(
        "select w.canceled_at is not null, w.canceled_by_message_id::text, m.meta->'wake'->>'canceledAt' \
           from agent_wake w join message m on m.id = w.message_id where w.message_id = $1::uuid",
    )
    .bind(m)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn items(admin: &PgPool, d: &str) -> Vec<(String, Option<String>)> {
    sqlx::query_as(
        "select delegate_account_id::text, outcome from team_delegation_item where delegation_id = $1::uuid order by delegate_account_id",
    )
    .bind(d)
    .fetch_all(admin)
    .await
    .unwrap()
}

async fn notified(admin: &PgPool, d: &str) -> bool {
    sqlx::query_scalar("select notified_at is not null from team_delegation where id = $1::uuid")
        .bind(d)
        .fetch_one(admin)
        .await
        .unwrap()
}

async fn open_meta(admin: &PgPool, msg: &str) -> Value {
    let s: String = sqlx::query_scalar(
        "select (meta->'delegation'->'open')::text from message where id = $1::uuid",
    )
    .bind(msg)
    .fetch_one(admin)
    .await
    .unwrap();
    serde_json::from_str(&s).unwrap()
}

async fn inbox(admin: &PgPool, who: &str) -> Vec<(String, String)> {
    sqlx::query_as(
        "select message_id::text, reason from inbox where account_id = $1::uuid order by id",
    )
    .bind(who)
    .fetch_all(admin)
    .await
    .unwrap()
}

async fn events_since(admin: &PgPool, from: i64) -> Vec<Value> {
    let v: Vec<String> =
        sqlx::query_scalar("select event::text from event_outbox where id > $1 order by id")
            .bind(from)
            .fetch_all(admin)
            .await
            .unwrap();
    v.iter().map(|s| serde_json::from_str(s).unwrap()).collect()
}

async fn outbox_top(admin: &PgPool) -> i64 {
    sqlx::query_scalar("select coalesce(max(id), 0) from event_outbox")
        .fetch_one(admin)
        .await
        .unwrap()
}

#[tokio::test]
async fn settle_canceled_turn_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let write = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(w) => {
            let w = PgPool::connect(&w).await.unwrap();
            let missing = harkroom_server::write::missing_operator_privileges(&w)
                .await
                .unwrap();
            assert!(missing.is_empty(), "write role missing {missing:?}");
            w
        }
        Err(_) => admin.clone(),
    };
    let tag = format!("ts{}", std::process::id());
    let lead = account(&admin, &format!("{tag}-lead")).await;
    let a = account(&admin, &format!("{tag}-a")).await;
    let b = account(&admin, &format!("{tag}-b")).await;
    let lead2 = account(&admin, &format!("{tag}-lead2")).await;
    let c = account(&admin, &format!("{tag}-c")).await;
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ($1, 'standard') returning id::text",
    )
    .bind(format!("{tag}-ch"))
    .fetch_one(&admin)
    .await
    .unwrap();
    let root = message(&admin, &ch, &lead, None, "user", json!({})).await;
    let other_root = message(&admin, &ch, &lead, None, "user", json!({})).await;

    // ── 팀원 둘(a·b)에게 넘긴 위임 D1 ──
    let (d1, d1_msg) = delegation(&admin, &ch, &root, &lead, &[&a, &b]).await;
    // a 의 예약 — 이 스레드(보고처 있음)는 접히고, 다른 스레드는 남는다.
    let report = json!({ "channelId": ch, "threadRootId": root });
    let a_here = wake(&admin, &ch, &a, &root, json!({ "reportTo": report })).await;
    let a_there = wake(&admin, &ch, &a, &other_root, json!({})).await;
    // 팀장의 예약 — 이 위임에 걸린 것은 깨울 때 접히고, 다른 위임에 걸린 것은 남는다.
    let lead_d1 = wake(&admin, &ch, &lead, &root, json!({ "delegationId": d1 })).await;
    let lead_other = wake(
        &admin,
        &ch,
        &lead,
        &root,
        json!({ "delegationId": "00000000-0000-0000-0000-000000000000" }),
    )
    .await;

    // ① 팀원 a 중단 — b 가 남았으니 팀장을 깨우지 않는다.
    let o0 = outbox_top(&admin).await;
    let out = settle_canceled_turn(&write, &root, &a).await;
    assert!(out.woke.is_empty());
    assert_eq!(out.rows, vec![a_here.clone()]);
    assert_eq!(out.report, vec![(ch.clone(), root.clone())]);
    let mut want = vec![(a.clone(), Some("canceled".to_string())), (b.clone(), None)];
    want.sort();
    assert_eq!(items(&admin, &d1).await, want);
    assert!(!notified(&admin, &d1).await);
    assert_eq!(open_meta(&admin, &d1_msg).await, json!([b]));
    assert!(inbox(&admin, &lead).await.is_empty());
    let (canceled, by, stamp) = wake_state(&admin, &a_here).await;
    assert!(canceled && by.is_none());
    assert!(stamp.is_some_and(|s| s.len() == 24 && s.ends_with('Z')));
    assert!(
        !wake_state(&admin, &a_there).await.0,
        "다른 스레드의 예약은 그대로"
    );
    let ev = events_since(&admin, o0).await;
    let types: Vec<&str> = ev.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(types, ["thread.reportWakes.changed", "message.updated"]);
    assert_eq!(ev[1]["message"]["id"], a_here.as_str());

    // ② 팀원 b 중단 — 마지막 미결이었으니 팀장을 한 번 깨우고, 이 위임에 걸린 팀장 예약을 접는다.
    let o1 = outbox_top(&admin).await;
    let out = settle_canceled_turn(&write, &root, &b).await;
    assert_eq!(out.woke, vec![lead.clone()]);
    assert_eq!(out.rows, vec![lead_d1.clone()]);
    assert!(notified(&admin, &d1).await);
    assert_eq!(open_meta(&admin, &d1_msg).await, json!([]));
    assert_eq!(
        inbox(&admin, &lead).await,
        vec![(d1_msg.clone(), "delegation_done".into())]
    );
    let (canceled, by, stamp) = wake_state(&admin, &lead_d1).await;
    assert!(canceled);
    assert_eq!(by.as_deref(), Some(d1_msg.as_str()));
    assert!(stamp.is_some());
    assert!(
        !wake_state(&admin, &lead_other).await.0,
        "다른 위임의 예약은 그대로"
    );
    let ev = events_since(&admin, o1).await;
    let types: Vec<&str> = ev.iter().map(|e| e["type"].as_str().unwrap()).collect();
    assert_eq!(types, ["inbox.updated", "message.updated"]);
    assert_eq!(ev[0]["accountId"], lead.as_str());

    // ③ 다시 불러도 아무 일 없다 — 한 번만 깨운다.
    let out = settle_canceled_turn(&write, &root, &b).await;
    assert!(out.woke.is_empty() && out.rows.is_empty());
    assert_eq!(inbox(&admin, &lead).await.len(), 1);

    // ── 팀장 lead2 가 c 에게 넘긴 위임 D2 — 팀장이 중단되면 전부 닫고 깨우지 않는다 ──
    let (d2, d2_msg) = delegation(&admin, &ch, &root, &lead2, &[&c]).await;
    let lead2_wake = wake(&admin, &ch, &lead2, &root, json!({})).await;
    let o2 = outbox_top(&admin).await;
    let out = settle_canceled_turn(&write, &root, &lead2).await;
    assert!(out.woke.is_empty());
    assert_eq!(out.rows, vec![lead2_wake.clone()]);
    assert_eq!(
        items(&admin, &d2).await,
        vec![(c.clone(), Some("canceled".into()))]
    );
    assert!(notified(&admin, &d2).await);
    assert_eq!(open_meta(&admin, &d2_msg).await, json!([]));
    assert!(
        inbox(&admin, &lead2).await.is_empty(),
        "사람이 멈춘 팀장을 되살리지 않는다"
    );
    assert!(inbox(&admin, &c).await.is_empty());
    let types: Vec<String> = events_since(&admin, o2)
        .await
        .iter()
        .map(|e| e["type"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(types, ["message.updated"]);

    // ④ 실패는 롤백하고 던지지 않는다 — 깨진 스레드 id 로 부르면 빈 결과, 남은 예약(a_there)은 그대로.
    let o3 = outbox_top(&admin).await;
    let out = settle_canceled_turn(&write, "not-a-uuid", &a).await;
    assert!(out.woke.is_empty() && out.rows.is_empty() && out.report.is_empty());
    assert!(!wake_state(&admin, &a_there).await.0);
    assert!(events_since(&admin, o3).await.is_empty());
}
