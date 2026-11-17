//! 위임 기한 스윕(S5.4 L1, `loops/delegation_deadline.rs` — TS `createDelegationDeadlineSweeper`)을 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `packages/server/test/rustFrontDb.test.ts` 가 넘긴다).
//! 쓰기 풀은 `HARKROOM_TEST_WRITE_DATABASE_URL`(있으면 `DELEGATION_DEADLINE_PRIVILEGES` 만 가진 역할) — 권한이 모자라면 여기서 빨개진다.
use harkroom_server::loops::delegation_deadline::{
    DELEGATION_DEADLINE_PRIVILEGES, DELEGATION_DEADLINE_SEQUENCE_PRIVILEGES, sweep,
};
use harkroom_server::loops::{GateResult, Side, run_gated};
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

/// 기한이 지난 위임 하나(새 뿌리 글 + 위임 글 + 팀원 한 명). (뿌리, 위임 id, 위임 글 id).
async fn due(admin: &PgPool, ch: &str, lead: &str, member: &str) -> (String, String, String) {
    let root = message(admin, ch, lead, None, "user", json!({})).await;
    let msg = message(
        admin,
        ch,
        lead,
        Some(&root),
        "user",
        json!({ "kind": "delegation", "delegation": { "open": [member] } }),
    )
    .await;
    let d: String = sqlx::query_scalar(
        "insert into team_delegation(message_id, lead_account_id, channel_id, thread_root_id, deadline_at) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now() - interval '1 minute') returning id::text",
    )
    .bind(&msg)
    .bind(lead)
    .bind(ch)
    .bind(&root)
    .fetch_one(admin)
    .await
    .unwrap();
    sqlx::query(
        "insert into team_delegation_item(delegation_id, delegate_account_id) values ($1::uuid, $2::uuid)",
    )
    .bind(&d)
    .bind(member)
    .execute(admin)
    .await
    .unwrap();
    (root, d, msg)
}

/// (결말, 멈춤 알림 찍힘, 위임 알림 찍힘, 기한이 미래인가).
async fn state(admin: &PgPool, d: &str) -> (Option<String>, bool, bool, bool) {
    sqlx::query_as(
        "select i.outcome, i.stalled_notified_at is not null, t.notified_at is not null, t.deadline_at > now() \
           from team_delegation t join team_delegation_item i on i.delegation_id = t.id where t.id = $1::uuid",
    )
    .bind(d)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn inbox(admin: &PgPool, who: &str, msg: &str) -> Vec<String> {
    sqlx::query_scalar(
        "select reason from inbox where account_id = $1::uuid and message_id = $2::uuid order by reason",
    )
    .bind(who)
    .bind(msg)
    .fetch_all(admin)
    .await
    .unwrap()
}

async fn hub(admin: &PgPool, age: &str) -> String {
    sqlx::query_scalar(
        "insert into relay_hub(hub_epoch, impl, seen_at) values (gen_random_uuid(), 'ts', now() - $1::interval) returning hub_epoch::text",
    )
    .bind(age)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn live(admin: &PgPool, sid: &str, agent: &str, ch: &str, root: &str, hub: &str) {
    sqlx::query(
        "insert into agent_session_live(session_id, agent_account_id, channel_id, thread_root_id, harness, hub_epoch) \
         values ($1, $2::uuid, $3::uuid, $4::uuid, 'claude', $5::uuid)",
    )
    .bind(sid)
    .bind(agent)
    .bind(ch)
    .bind(root)
    .bind(hub)
    .execute(admin)
    .await
    .unwrap();
}

async fn events_since(admin: &PgPool, after: i64) -> Vec<Value> {
    sqlx::query_scalar("select event from event_outbox where id > $1 order by id")
        .bind(after)
        .fetch_all(admin)
        .await
        .unwrap()
}

async fn outbox_max(admin: &PgPool) -> i64 {
    sqlx::query_scalar("select coalesce(max(id), 0) from event_outbox")
        .fetch_one(admin)
        .await
        .unwrap()
}

fn woke(events: &[Value], who: &str) -> usize {
    events
        .iter()
        .filter(|e| e["type"] == "inbox.updated" && e["accountId"] == who)
        .count()
}

#[tokio::test]
async fn delegation_deadline_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let w = PgPool::connect(&write_url).await.unwrap();
    let missing = harkroom_server::write::missing_in(
        &w,
        DELEGATION_DEADLINE_PRIVILEGES,
        DELEGATION_DEADLINE_SEQUENCE_PRIVILEGES,
    )
    .await
    .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    let lead = account(&admin, "alice").await;
    let bob = account(&admin, "bob.x-1").await;
    let carol = account(&admin, "carol").await;
    let dave = account(&admin, "dave").await;
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('dd-rs', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();

    // ── v0 ──
    // 닫힘: 아무도 안 돎 → timeout + 위임자 delegation_done + inbox.updated.
    let (_, closed, closed_msg) = due(&admin, &ch, &lead, &bob).await;
    // 도는 턴: 살아 있는 허브 + 같은 스레드의 사본 → 민다.
    let (busy_root, busy, _) = due(&admin, &ch, &lead, &carol).await;
    let fresh = hub(&admin, "0 seconds").await;
    live(&admin, "s-busy", &carol, &ch, &busy_root, &fresh).await;
    // 죽은 허브(TTL 90초 넘김)의 사본은 세지 않는다 → 닫힘.
    let (stale_root, stale, _) = due(&admin, &ch, &lead, &dave).await;
    let old = hub(&admin, "10 minutes").await;
    live(&admin, "s-stale", &dave, &ch, &stale_root, &old).await;
    // 다른 스레드에서 도는 턴은 세지 않는다 → 닫힘.
    let (_, elsewhere, _) = due(&admin, &ch, &lead, &carol).await;
    // 예약을 둔 팀원(만든 지 24시간 안) → 민다.
    let (wait_root, waiting, _) = due(&admin, &ch, &lead, &bob).await;
    let wm = message(
        &admin,
        &ch,
        &bob,
        Some(&wait_root),
        "wake",
        json!({ "wake": {} }),
    )
    .await;
    sqlx::query(
        "insert into agent_wake(account_id, channel_id, message_id, wake_at) values ($1::uuid, $2::uuid, $3::uuid, now() + interval '30 minutes')",
    )
    .bind(&bob)
    .bind(&ch)
    .bind(&wm)
    .execute(&admin)
    .await
    .unwrap();

    let before = outbox_max(&admin).await;
    sweep(&w, false).await.unwrap();
    assert_eq!(
        state(&admin, &closed).await,
        (Some("timeout".into()), false, true, false)
    );
    assert_eq!(
        inbox(&admin, &lead, &closed_msg).await,
        vec!["delegation_done".to_string()]
    );
    assert_eq!(state(&admin, &busy).await, (None, false, false, true));
    assert_eq!(state(&admin, &stale).await.0.as_deref(), Some("timeout"));
    assert_eq!(
        state(&admin, &elsewhere).await.0.as_deref(),
        Some("timeout")
    );
    assert_eq!(state(&admin, &waiting).await, (None, false, false, true));
    // 예약 시각 + 침묵(10분)까지 민다.
    let past_wake: bool = sqlx::query_scalar(
        "select deadline_at >= now() + interval '39 minutes' from team_delegation where id = $1::uuid",
    )
    .bind(&waiting)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(past_wake);
    let ev = events_since(&admin, before).await;
    assert!(woke(&ev, &lead) >= 1, "{ev:?}");
    // 위임 글 meta 의 열린 목록이 비었다.
    let open: Value =
        sqlx::query_scalar("select meta->'delegation'->'open' from message where id = $1::uuid")
            .bind(&closed_msg)
            .fetch_one(&admin)
            .await
            .unwrap();
    assert_eq!(open, json!([]));

    // 두 번째 스윕은 이미 알린 위임을 건드리지 않는다(위임자 inbox 도 하나).
    sweep(&w, false).await.unwrap();
    assert_eq!(inbox(&admin, &lead, &closed_msg).await.len(), 1);

    // ── v2 ──
    // 멈춤 알림: 닫지 않고 위임자에게 delegation_update 하나 → 기한을 최대 수명까지.
    let (_, stalled, stalled_msg) = due(&admin, &ch, &lead, &bob).await;
    // 열린 PR 감시 → 민다(알림 없음).
    let (pr_root, watched, _) = due(&admin, &ch, &lead, &dave).await;
    let watch: String = sqlx::query_scalar(
        "insert into pr_watch(repo, number, head, until, expires_at) \
         values ('example/repo', 7, repeat('a', 40), 'checks', now() + interval '1 hour') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    sqlx::query(
        "insert into pr_watch_subscriber(watch_id, account_id, channel_id, thread_root_id, delegation_id) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid)",
    )
    .bind(&watch)
    .bind(&dave)
    .bind(&ch)
    .bind(&pr_root)
    .bind(&watched)
    .execute(&admin)
    .await
    .unwrap();
    // 팀원이 위임 뒤 그 스레드에 연 카드 → 민다.
    let (ask_root, asking, _) = due(&admin, &ch, &lead, &carol).await;
    message(
        &admin,
        &ch,
        &carol,
        Some(&ask_root),
        "user",
        json!({ "kind": "ask", "ask": { "question": "q" } }),
    )
    .await;
    // 자동 닫힘(idle): 결과가 온 뒤 7시간 조용 → closed/idle, 위임은 조용히 알린 것으로.
    let (_, idle, idle_msg) = due(&admin, &ch, &lead, &bob).await;
    sqlx::query(
        "update team_delegation set deadline_at = now() + interval '1 hour' where id = $1::uuid",
    )
    .bind(&idle)
    .execute(&admin)
    .await
    .unwrap();
    sqlx::query(
        "update team_delegation_item set outcome = 'reported', closed_at = now() - interval '7 hours', \
                last_activity_at = now() - interval '7 hours' where delegation_id = $1::uuid",
    )
    .bind(&idle)
    .execute(&admin)
    .await
    .unwrap();
    // 턴 끝 update: 팀원 글이 대기 중 2분 → 위임자에게 delegation_update, 횟수 1.
    let (up_root, upd, _) = due(&admin, &ch, &lead, &dave).await;
    sqlx::query(
        "update team_delegation set deadline_at = now() + interval '1 hour' where id = $1::uuid",
    )
    .bind(&upd)
    .execute(&admin)
    .await
    .unwrap();
    let up_msg = message(&admin, &ch, &dave, Some(&up_root), "user", json!({})).await;
    sqlx::query(
        "update team_delegation_item set update_pending_message_id = $2::uuid, update_pending_at = now() - interval '2 minutes' \
          where delegation_id = $1::uuid",
    )
    .bind(&upd)
    .bind(&up_msg)
    .execute(&admin)
    .await
    .unwrap();

    let before = outbox_max(&admin).await;
    sweep(&w, true).await.unwrap();
    assert_eq!(state(&admin, &stalled).await, (None, true, false, true));
    let max_age: bool = sqlx::query_scalar(
        "select deadline_at >= created_at + interval '24 hours' from team_delegation where id = $1::uuid",
    )
    .bind(&stalled)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(max_age);
    assert_eq!(
        inbox(&admin, &lead, &stalled_msg).await,
        vec!["delegation_update".to_string()]
    );
    assert_eq!(state(&admin, &watched).await, (None, false, false, true));
    assert_eq!(state(&admin, &asking).await, (None, false, false, true));
    assert_eq!(
        state(&admin, &idle).await,
        (Some("closed".into()), false, true, true)
    );
    let reason: Option<String> = sqlx::query_scalar(
        "select closed_reason from team_delegation_item where delegation_id = $1::uuid",
    )
    .bind(&idle)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(reason.as_deref(), Some("idle"));
    // 자동 닫힘은 깨우지 않는다.
    assert!(inbox(&admin, &lead, &idle_msg).await.is_empty());
    assert_eq!(
        inbox(&admin, &lead, &up_msg).await,
        vec!["delegation_update".to_string()]
    );
    let (pending, count): (Option<String>, i32) = sqlx::query_as(
        "select update_pending_message_id::text, update_count from team_delegation_item where delegation_id = $1::uuid",
    )
    .bind(&upd)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!((pending, count), (None, 1));
    let ev = events_since(&admin, before).await;
    // 멈춤 알림 한 번 + update 한 번 — sweepV2 는 한 위임자를 한 번만 친다.
    assert!(woke(&ev, &lead) >= 1, "{ev:?}");

    // 두 번째 스윕: 멈춤 알림은 한 번만(기한이 미래라 집히지도 않는다).
    sweep(&w, true).await.unwrap();
    assert_eq!(inbox(&admin, &lead, &stalled_msg).await.len(), 1);

    // C5 조건 — 문지기 풀과 sweep 풀이 각각 연결 하나뿐이어도 돈다.
    let (_, last, _) = due(&admin, &ch, &lead, &bob).await;
    let one = || {
        sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(3))
            .connect(&write_url)
    };
    let (gate1, work1) = (one().await.unwrap(), one().await.unwrap());
    let r = run_gated(&gate1, "delegation.deadline", Side::Ts, || {
        sweep(&work1, false)
    })
    .await;
    assert!(matches!(r, GateResult::Ran), "{r:?}");
    assert_eq!(state(&admin, &last).await.0.as_deref(), Some("timeout"));
}
