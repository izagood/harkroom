//! 계획 진행 루프의 멈춤 판정(`loops::plan_progress`, 그림자)이 실제 스키마에서 신호를 읽는지 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다. 읽기만 하는 sweep 이라 계획·글은 시험이 직접 깐다.
use harkroom_server::loops::plan_progress::{PLAN_STALL_PRIVILEGES, Seen, StallState, sweep};
use sqlx::PgPool;

const HOUR: i64 = 3600;

async fn one(admin: &PgPool, sql: &'static str, binds: &[&str]) -> String {
    let mut q = sqlx::query_scalar(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_one(admin).await.unwrap()
}

async fn run(admin: &PgPool, sql: &'static str, binds: &[&str]) {
    let mut q = sqlx::query(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.execute(admin).await.unwrap();
}

/// 그 계획의 (조용함, 멈춤) 수 — 새 기록으로 한 번 훑는다(같은 수를 두 번 남기지 않는 규칙에 가리지 않게).
async fn counts(pool: &PgPool, root: &str) -> (i64, i64) {
    let mut state = StallState::new(HOUR);
    let events = sweep(pool, &mut Seen::new(), Some(&mut state))
        .await
        .unwrap();
    let of = |branch: &str| {
        events
            .iter()
            .filter(|e| e.thread_root_id.as_deref() == Some(root))
            .find(|e| e.detail.as_ref().is_some_and(|d| d["branch"] == branch))
            .and_then(|e| e.value)
            .unwrap_or(0)
    };
    (of("quiet"), of("would_stall"))
}

#[tokio::test]
async fn stall_shadow_reads_each_signal() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let missing = harkroom_server::write::missing_in(&admin, PLAN_STALL_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "{missing:?}");

    let account =
        "insert into account(handle, display_name, kind) values ($1, $1, $2) returning id::text";
    let lead = one(&admin, account, &["ps_lead", "agent"]).await;
    let agent = one(&admin, account, &["ps_agent", "agent"]).await;
    let human = one(&admin, account, &["ps_human", "human"]).await;
    let ch = one(
        &admin,
        "insert into channel(name, kind) values ('ps-rs', 'standard') returning id::text",
        &[],
    )
    .await;
    let post = "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'x', 'user') returning id::text";
    let root = one(&admin, post, &[&ch, &lead]).await;
    // s1: 에이전트 담당 active · s2: 사람 담당 active · s3: 에이전트 담당 pending.
    let doc = serde_json::json!({"goal": "", "groups": [], "steps": [
        {"id": "s1", "title": "a", "state": "active", "assigneeId": agent, "links": [], "dependsOn": []},
        {"id": "s2", "title": "b", "state": "active", "assigneeId": human, "links": [], "dependsOn": []},
        {"id": "s3", "title": "c", "state": "pending", "assigneeId": agent, "links": [], "dependsOn": ["s1"]}
    ]})
    .to_string();
    run(
        &admin,
        "insert into thread_plan(root_id, channel_id, doc) values ($1::uuid, $2::uuid, $3::jsonb)",
        &[&root, &ch, &doc],
    )
    .await;

    // 신호가 없다 — 에이전트 담당 active 단계 하나만 조용하고 멈춤이다.
    assert_eq!(counts(&admin, &root).await, (1, 1));

    // 담당이 이 스레드에 방금 썼다 — 조용하지만 멈춤은 아니다. 두 시간 전 글이면 다시 멈춤이다(창은 한 시간).
    let reply = "insert into message(channel_id, author_id, body, kind, thread_root_id) \
                 values ($1::uuid, $2::uuid, 'x', 'user', $3::uuid) returning id::text";
    let said = one(&admin, reply, &[&ch, &agent, &root]).await;
    assert_eq!(counts(&admin, &root).await, (1, 0));
    run(
        &admin,
        "update message set created_at = now() - interval '2 hours' where id = $1::uuid",
        &[&said],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (1, 1));

    // 열린 위임(단계 적힘) — 신호. 닫히면 다시 조용하다. 다른 단계가 적힌 위임은 s1 의 신호가 아니다.
    let call = one(&admin, reply, &[&ch, &lead, &root]).await;
    let delegation = one(
        &admin,
        "insert into team_delegation(message_id, lead_account_id, channel_id, thread_root_id, deadline_at, plan_step_id) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now() + interval '1 hour', 's1') returning id::text",
        &[&call, &lead, &ch, &root],
    )
    .await;
    run(
        &admin,
        "insert into team_delegation_item(delegation_id, delegate_account_id) values ($1::uuid, $2::uuid)",
        &[&delegation, &agent],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    run(
        &admin,
        "update team_delegation set plan_step_id = 's3' where id = $1::uuid",
        &[&delegation],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (1, 1));
    // 단계가 안 적힌 위임은 담당의 active 단계 모두의 신호다.
    run(
        &admin,
        "update team_delegation set plan_step_id = null where id = $1::uuid",
        &[&delegation],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    run(
        &admin,
        "update team_delegation_item set outcome = 'done', closed_at = now() where delegation_id = $1::uuid",
        &[&delegation],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (1, 1));

    // 살아 있는 턴 임대 — 신호. 끝나면 다시 조용하다.
    let operator = one(
        &admin,
        "insert into operator(owner_account_id, name, token_hash) values ($1::uuid, 'ps', 'ps-token-hash') returning id::text",
        &[&human],
    )
    .await;
    let lease = one(
        &admin,
        "insert into secret_turn_lease(token_hash, agent_id, operator_id, cause_message_id, channel_id, thread_root_id, expires_at) \
         values ('ps-lease', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, now() + interval '5 minutes') returning id::text",
        &[&agent, &operator, &call, &ch, &root],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    run(
        &admin,
        "update secret_turn_lease set ended_at = now() where id = $1::uuid",
        &[&lease],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (1, 1));

    // 걸린 예약 — 신호. 취소되면 다시 조용하다. (예약 글은 두 시간 전 것이라 「최근 글」이 아니다.)
    let wake_msg = one(&admin, reply, &[&ch, &agent, &root]).await;
    run(
        &admin,
        "update message set created_at = now() - interval '2 hours' where id = $1::uuid",
        &[&wake_msg],
    )
    .await;
    let wake = one(
        &admin,
        "insert into agent_wake(account_id, channel_id, message_id, wake_at) \
         values ($1::uuid, $2::uuid, $3::uuid, now() + interval '10 minutes') returning id::text",
        &[&agent, &ch, &wake_msg],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    run(
        &admin,
        "update agent_wake set canceled_at = now() where id = $1::uuid",
        &[&wake],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (1, 1));

    // 열린 PR 감시 — 신호. 끝나면 다시 조용하다.
    let watch = one(
        &admin,
        "insert into pr_watch(repo, number, head, until, expires_at) \
         values ('o/ps-rs', 1, repeat('a', 40), 'checks', now() + interval '1 hour') returning id::text",
        &[],
    )
    .await;
    run(
        &admin,
        "insert into pr_watch_subscriber(watch_id, account_id, channel_id, thread_root_id) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
        &[&watch, &agent, &ch, &root],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (0, 0));
    run(
        &admin,
        "update pr_watch set state = 'done', ended_at = now() where id = $1::uuid",
        &[&watch],
    )
    .await;
    assert_eq!(counts(&admin, &root).await, (1, 1));

    // 멈춤 판정을 끄면(권한 없음과 같은 길) 그 갈래는 남지 않는다.
    let off = sweep(&admin, &mut Seen::new(), None).await.unwrap();
    assert!(off.iter().all(|e| {
        let branch = &e.detail.as_ref().unwrap()["branch"];
        branch != "quiet" && branch != "would_stall"
    }));
}
