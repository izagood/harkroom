//! 위임 다시 부르기(`core::delegation_recall`, DA)를 실제 Postgres 로 본다 — 말없이 끝난 담당을 두 번 다시 부르고, 그 뒤에는
//! 막힘을 찍고 위임자에게 한 번 알린다. 위임은 닫히지 않는다. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
use harkroom_server::core::delegation_recall::{
    RECALL_MAX, RECALL_ON_PRIVILEGES, RECALL_PRIVILEGES, Step, commit_step, peek, schedule,
};
use harkroom_server::core::msg_post::PostState;
use harkroom_server::core::turn_end_judge::Verdict;
use sqlx::PgPool;

async fn one(admin: &PgPool, sql: &'static str, binds: &[&str]) -> String {
    let mut q = sqlx::query_scalar::<_, String>(sql);
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

/// 항목의 (다시 부른 횟수, 막힘, 멈춤 알림, 결말 없음).
async fn item(admin: &PgPool, delegation: &str, delegate: &str) -> (i32, bool, bool, bool) {
    sqlx::query_as(
        "select recall_count, recall_blocked_at is not null, stalled_notified_at is not null, outcome is null \
           from team_delegation_item where delegation_id = $1::uuid and delegate_account_id = $2::uuid",
    )
    .bind(delegation)
    .bind(delegate)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn count(admin: &PgPool, sql: &'static str, binds: &[&str]) -> i64 {
    let mut q = sqlx::query_scalar::<_, i64>(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_one(admin).await.unwrap()
}

#[tokio::test]
async fn silent_delegate_is_recalled_twice_then_blocked_and_the_lead_is_told_once() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let needed = [RECALL_PRIVILEGES, RECALL_ON_PRIVILEGES].concat();
    let missing = harkroom_server::write::missing_in(&admin, &needed, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "{missing:?}");

    let human = one(
        &admin,
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text",
        &["dr_rs_human"],
    )
    .await;
    const AGENT: &str = "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text";
    let lead = one(&admin, AGENT, &["dr_rs_lead"]).await;
    let delegate = one(&admin, AGENT, &["dr_rs_delegate"]).await;
    let ch = one(
        &admin,
        "insert into channel(name, kind, visibility, created_by) values ($1, 'standard', 'private', $2::uuid) returning id::text",
        &["dr-rs", &human],
    )
    .await;
    for member in [&human, &lead, &delegate] {
        run(
            &admin,
            "insert into channel_member(channel_id, account_id) values ($1::uuid, $2::uuid)",
            &[&ch, member],
        )
        .await;
    }
    let root = one(
        &admin,
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'hi', 'user') returning id::text",
        &[&ch, &human],
    )
    .await;
    let call = one(
        &admin,
        "insert into message(channel_id, author_id, body, kind, thread_root_id) \
         values ($1::uuid, $2::uuid, 'do it', 'user', $3::uuid) returning id::text",
        &[&ch, &lead, &root],
    )
    .await;
    let delegation = one(
        &admin,
        "insert into team_delegation(message_id, lead_account_id, channel_id, thread_root_id, deadline_at) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now() + interval '1 hour') returning id::text",
        &[&call, &lead, &ch, &root],
    )
    .await;
    run(
        &admin,
        "insert into team_delegation_item(delegation_id, delegate_account_id) values ($1::uuid, $2::uuid)",
        &[&delegation, &delegate],
    )
    .await;

    // 같은 스레드에 위임자가 걸어 둔 열린 예약 — 다시 부르기 줄은 사람 글이 아니므로 이 예약을 깨우지 않아야 한다.
    let lead_wait = one(
        &admin,
        "insert into message(channel_id, author_id, body, kind, thread_root_id, meta) \
         values ($1::uuid, $2::uuid, 'wait', 'wake', $3::uuid, '{\"kind\":\"wake\",\"wake\":{\"reason\":\"wait\"}}'::jsonb) \
         returning id::text",
        &[&ch, &lead, &root],
    )
    .await;
    run(
        &admin,
        "insert into agent_wake(account_id, channel_id, message_id, wake_at) \
         values ($1::uuid, $2::uuid, $3::uuid, now() + interval '1 hour')",
        &[&lead, &ch, &lead_wait],
    )
    .await;

    // ① 읽기만(그림자) — 불렀을 것을 돌려주고 아무것도 적지 않는다. 담당이 아닌 계정·매듭지은 턴은 대상이 아니다.
    let (c, step) = peek(&admin, &root, &delegate, Verdict::Silent)
        .await
        .unwrap()
        .expect("candidate");
    assert_eq!(step, Step::Recall(1));
    assert_eq!(c.delegation_id, delegation);
    assert_eq!(c.lead_id, lead);
    assert_eq!(
        item(&admin, &delegation, &delegate).await,
        (0, false, false, true)
    );
    assert!(
        peek(&admin, &root, &lead, Verdict::Silent)
            .await
            .unwrap()
            .is_none()
    );
    let (_, step) = peek(&admin, &root, &delegate, Verdict::Settled)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(step, Step::Skip("not_silent"));

    // ② 다시 부르기 두 번 — 횟수만 오른다. 대기 줄은 보통의 예약 줄이고 예약 행이 2분 뒤로 선다.
    let st = PostState {
        read: admin.clone(),
        write: admin.clone(),
        up: harkroom_server::proxy::Upstream::new("http://127.0.0.1:0"),
        implicit_ok: false,
    };
    for n in 1..=RECALL_MAX {
        let (c, step) = commit_step(&admin, &root, &delegate, Verdict::Silent)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(step, Step::Recall(n));
        assert_eq!(
            item(&admin, &delegation, &delegate).await,
            (n, false, false, true)
        );
        assert!(schedule(&st, &root, &delegate, &c, n).await.unwrap());
        // 방금 세운 예약을 띄운 것으로 친다(다음 침묵을 보기 위해).
        run(
            &admin,
            "update agent_wake set fired_at = now() where account_id = $1::uuid and fired_at is null",
            &[&delegate],
        )
        .await;
    }
    assert_eq!(
        count(
            &admin,
            "select count(*) from agent_wake w join message m on m.id = w.message_id \
              where w.account_id = $1::uuid and m.thread_root_id = $2::uuid and m.kind = 'wake' and m.author_id = $1::uuid \
                and m.meta->'wake'->'recall'->>'delegationId' = $3 \
                and w.wake_at > w.created_at + interval '100 seconds' and w.wake_at < w.created_at + interval '140 seconds'",
            &[&delegate, &root, &delegation],
        )
        .await,
        i64::from(RECALL_MAX)
    );
    // 다시 부르기 줄은 누구의 inbox 에도 줄을 넣지 않는다(전달은 예약 루프 몫).
    assert_eq!(
        count(
            &admin,
            "select count(*) from inbox where account_id = $1::uuid",
            &[&delegate]
        )
        .await,
        0
    );

    // 위임자의 열린 예약은 그대로다 — 띄워지지 않았고, 닫힌 시각도 없고, 위임자 inbox 에 깨움 줄도 없다.
    assert_eq!(
        count(
            &admin,
            "select count(*) from agent_wake w join message m on m.id = w.message_id \
              where w.message_id = $1::uuid and w.fired_at is null and not (m.meta->'wake' ? 'canceledAt')",
            &[&lead_wait],
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &admin,
            "select count(*) from inbox where account_id = $1::uuid",
            &[&lead]
        )
        .await,
        0
    );

    // ③ 세 번째 침묵 — 막힘을 찍고 위임자에게 한 번 알린다. 위임은 열려 있다.
    let (_, step) = commit_step(&admin, &root, &delegate, Verdict::Silent)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(step, Step::Block);
    assert_eq!(
        item(&admin, &delegation, &delegate).await,
        (RECALL_MAX, true, true, true)
    );
    const NOTICES: &str = "select count(*) from inbox where account_id = $1::uuid and message_id = $2::uuid and reason = 'delegation_update'";
    assert_eq!(count(&admin, NOTICES, &[&lead, &call]).await, 1);

    // ④ 그 뒤의 침묵은 아무것도 하지 않는다.
    let (_, step) = commit_step(&admin, &root, &delegate, Verdict::Silent)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(step, Step::Skip("blocked"));
    assert_eq!(count(&admin, NOTICES, &[&lead, &call]).await, 1);
    assert_eq!(
        item(&admin, &delegation, &delegate).await,
        (RECALL_MAX, true, true, true)
    );

    // ⑤ 결말이 난 항목은 대상이 아니다.
    run(
        &admin,
        "update team_delegation_item set outcome = 'done', closed_at = now() where delegation_id = $1::uuid",
        &[&delegation],
    )
    .await;
    assert!(
        peek(&admin, &root, &delegate, Verdict::Silent)
            .await
            .unwrap()
            .is_none()
    );
}

/// 못 잡힌 위임 감시(DB) — 턴이 안 선 위임과 임대가 끝내기 없이 만료된 위임만 잡는다. 기다림 근거가 있으면 잡지 않는다.
#[tokio::test]
async fn unjudged_sweep_finds_only_delegations_no_turn_end_ever_judged() {
    use harkroom_server::core::delegation_recall::{
        EXPIRED_GRACE_SEC, UNCLAIMED_SEC, UNJUDGED_PRIVILEGES, unjudged,
    };
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let missing = harkroom_server::write::missing_in(&admin, UNJUDGED_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "{missing:?}");

    let human = one(
        &admin,
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text",
        &["du_rs_human"],
    )
    .await;
    const AGENT: &str = "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text";
    let lead = one(&admin, AGENT, &["du_rs_lead"]).await;
    let delegate = one(&admin, AGENT, &["du_rs_delegate"]).await;
    let ch = one(
        &admin,
        "insert into channel(name, kind, visibility, created_by) values ($1, 'standard', 'private', $2::uuid) returning id::text",
        &["du-rs", &human],
    )
    .await;
    let root = one(
        &admin,
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'hi', 'user') returning id::text",
        &[&ch, &human],
    )
    .await;
    let call = one(
        &admin,
        "insert into message(channel_id, author_id, body, kind, thread_root_id) \
         values ($1::uuid, $2::uuid, 'do it', 'user', $3::uuid) returning id::text",
        &[&ch, &lead, &root],
    )
    .await;
    let delegation = one(
        &admin,
        "insert into team_delegation(message_id, lead_account_id, channel_id, thread_root_id, deadline_at) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now() + interval '1 hour') returning id::text",
        &[&call, &lead, &ch, &root],
    )
    .await;
    run(
        &admin,
        "insert into team_delegation_item(delegation_id, delegate_account_id) values ($1::uuid, $2::uuid)",
        &[&delegation, &delegate],
    )
    .await;
    let found = |rows: Vec<(String, String, String)>| -> Option<String> {
        rows.into_iter()
            .find(|(t, a, _)| *t == root && *a == delegate)
            .map(|(_, _, case)| case)
    };
    let sweep = || unjudged(&admin, UNCLAIMED_SEC, EXPIRED_GRACE_SEC);

    // ① 갓 만든 위임 — 아직 기다린다.
    assert_eq!(found(sweep().await.unwrap()), None);

    // ② 11분이 지나도록 턴이 안 섰다 → `no_turn`.
    const AGE: &str =
        "update team_delegation set created_at = now() - interval '11 minutes' where id = $1::uuid";
    run(&admin, AGE, &[&delegation]).await;
    assert_eq!(found(sweep().await.unwrap()).as_deref(), Some("no_turn"));

    // ③ 기다림 근거 — 걸린 예약이 있으면 잡지 않는다. 띄워지면 다시 잡힌다.
    let wait = one(
        &admin,
        "insert into message(channel_id, author_id, body, kind, thread_root_id, meta) \
         values ($1::uuid, $2::uuid, 'wait', 'wake', $3::uuid, '{\"kind\":\"wake\",\"wake\":{\"reason\":\"wait\"}}'::jsonb) \
         returning id::text",
        &[&ch, &delegate, &root],
    )
    .await;
    run(
        &admin,
        "insert into agent_wake(account_id, channel_id, message_id, wake_at) \
         values ($1::uuid, $2::uuid, $3::uuid, now() + interval '1 hour')",
        &[&delegate, &ch, &wait],
    )
    .await;
    assert_eq!(found(sweep().await.unwrap()), None);
    run(
        &admin,
        "update agent_wake set fired_at = now() where message_id = $1::uuid",
        &[&wait],
    )
    .await;
    assert_eq!(found(sweep().await.unwrap()).as_deref(), Some("no_turn"));

    // ④ 열린 카드가 있으면 잡지 않는다. 답이 달리면 다시 잡힌다.
    let card = one(
        &admin,
        "insert into message(channel_id, author_id, body, kind, thread_root_id, meta) \
         values ($1::uuid, $2::uuid, 'q', 'user', $3::uuid, '{\"kind\":\"ask\",\"ask\":{\"prompt\":\"q\"}}'::jsonb) \
         returning id::text",
        &[&ch, &delegate, &root],
    )
    .await;
    assert_eq!(found(sweep().await.unwrap()), None);
    run(
        &admin,
        "update message set meta = '{\"kind\":\"ask\",\"ask\":{\"prompt\":\"q\",\"answeredWith\":\"y\"}}'::jsonb where id = $1::uuid",
        &[&card],
    )
    .await;
    assert_eq!(found(sweep().await.unwrap()).as_deref(), Some("no_turn"));

    // ⑤ 살아 있는 임대 — 턴이 돌고 있으면 잡지 않는다.
    let operator = one(
        &admin,
        "insert into operator(owner_account_id, name, token_hash) values ($1::uuid, 'du', 'du-token-hash') returning id::text",
        &[&human],
    )
    .await;
    let lease = one(
        &admin,
        "insert into secret_turn_lease(token_hash, agent_id, operator_id, cause_message_id, channel_id, thread_root_id, expires_at) \
         values ('du-lease', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, now() + interval '5 minutes') returning id::text",
        &[&delegate, &operator, &call, &ch, &root],
    )
    .await;
    assert_eq!(found(sweep().await.unwrap()), None);

    // ⑥ 끝내기가 찍힌 임대 — 판정 자리를 지났으므로 감시 몫이 아니다.
    run(
        &admin,
        "update secret_turn_lease set ended_at = now() where id = $1::uuid",
        &[&lease],
    )
    .await;
    assert_eq!(found(sweep().await.unwrap()), None);

    // ⑦ 끝내기 없이 만료 — 유예(2분) 안에는 기다리고, 지나면 `lease_expired`.
    run(
        &admin,
        "update secret_turn_lease set ended_at = null, expires_at = now() - interval '1 minute' where id = $1::uuid",
        &[&lease],
    )
    .await;
    assert_eq!(found(sweep().await.unwrap()), None);
    run(
        &admin,
        "update secret_turn_lease set expires_at = now() - interval '3 minutes' where id = $1::uuid",
        &[&lease],
    )
    .await;
    assert_eq!(
        found(sweep().await.unwrap()).as_deref(),
        Some("lease_expired")
    );

    // ⑧ 다시 부른 뒤에는 기준 시각이 옮겨 간다 — 만료된 임대는 그 앞이라 `no_turn` 으로 10분을 다시 기다린다.
    let (_, step) = commit_step(&admin, &root, &delegate, Verdict::Silent)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(step, Step::Recall(1));
    assert_eq!(found(sweep().await.unwrap()), None);
    run(
        &admin,
        "update team_delegation_item set recalled_at = now() - interval '11 minutes' where delegation_id = $1::uuid",
        &[&delegation],
    )
    .await;
    assert_eq!(found(sweep().await.unwrap()).as_deref(), Some("no_turn"));

    // ⑨ 막힘·결말이 난 항목은 잡지 않는다.
    run(
        &admin,
        "update team_delegation_item set recall_blocked_at = now() where delegation_id = $1::uuid",
        &[&delegation],
    )
    .await;
    assert_eq!(found(sweep().await.unwrap()), None);
    run(
        &admin,
        "update team_delegation_item set recall_blocked_at = null, outcome = 'done', closed_at = now() where delegation_id = $1::uuid",
        &[&delegation],
    )
    .await;
    assert_eq!(found(sweep().await.unwrap()), None);
}
