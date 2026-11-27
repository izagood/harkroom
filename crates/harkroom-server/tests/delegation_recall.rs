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
