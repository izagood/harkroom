//! PX5 조각 판정 — 넘긴 쪽만·닫힌 조각에만·재시도 1번·수락/버림 뒤 재판정 불가를 실제 스키마에서 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 넘긴다). 스위치 읽기는 단위 시험이 본다 —
//! 여기서는 스위치 값을 인자로 넘긴다.
use harkroom_server::core::piece_verdict::{Decided, Refusal, Verdict, decide_with};
use sqlx::PgPool;

async fn account(pool: &PgPool, handle: &str, kind: &str) -> String {
    sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id, role, is_admin) \
         values ($1, $1, $2, case when $2 = 'human' then $1 end, 'member', false) returning id::text",
    )
    .bind(handle)
    .bind(kind)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// 리더 `lead` 가 `assignee` 에게 넘긴 조각 하나(위임 + 하위 작업 행). 돌려주는 것은 조각 작업 id.
async fn piece(
    pool: &PgPool,
    channel: &str,
    root_msg: &str,
    parent: &str,
    lead: &str,
    assignee: &str,
    state: &str,
) -> String {
    let delegation: String = sqlx::query_scalar(
        "insert into team_delegation (message_id, lead_account_id, channel_id, thread_root_id, deadline_at, kind) \
         values ($1::uuid, $2::uuid, $3::uuid, $1::uuid, now() + interval '1 hour', 'delegate') returning id::text",
    )
    .bind(root_msg)
    .bind(lead)
    .bind(channel)
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query_scalar(
        "insert into work (channel_id, thread_root_id, parent_id, root_id, assignee_account_id, requester_account_id, \
                           delegation_id, state, closed_at) \
         values ($1::uuid, $2::uuid, $3::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7, \
                 case when $7 in ('done', 'failed', 'canceled') then now() end) returning id::text",
    )
    .bind(channel)
    .bind(root_msg)
    .bind(parent)
    .bind(assignee)
    .bind(lead)
    .bind(&delegation)
    .bind(state)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn leader_judges_closed_pieces_within_limits() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let alice = account(&pool, "pv-alice", "human").await;
    let me = account(&pool, "pv-me", "agent").await;
    let other = account(&pool, "pv-other", "agent").await;
    let channel: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility, created_by) values ('pv-ch', 'standard', 'public', $1::uuid) returning id::text",
    )
    .bind(&alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    let root: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'root', 'user') returning id::text",
    )
    .bind(&channel)
    .bind(&alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    // 리더의 뿌리 작업(`root_id = id`).
    let parent: String = sqlx::query_scalar(
        "insert into work (id, channel_id, thread_root_id, root_id, assignee_account_id, state) \
         select g.id, $1::uuid, $2::uuid, g.id, $3::uuid, 'running' from (select gen_random_uuid() as id) g \
         returning id::text",
    )
    .bind(&channel)
    .bind(&root)
    .bind(&me)
    .fetch_one(&pool)
    .await
    .unwrap();
    let done = piece(&pool, &channel, &root, &parent, &me, &me, "done").await;
    let failed = piece(&pool, &channel, &root, &parent, &me, &me, "failed").await;
    let open = piece(&pool, &channel, &root, &parent, &me, &me, "running").await;
    let theirs = piece(&pool, &channel, &root, &parent, &other, &me, "done").await;
    let rows = || async {
        sqlx::query_scalar::<_, i64>("select count(*) from work_verdict")
            .fetch_one(&pool)
            .await
            .unwrap()
    };
    let go = |work: &str, who: &str, v: Verdict, on: bool| {
        let (pool, work, who, parent) = (
            pool.clone(),
            work.to_string(),
            who.to_string(),
            parent.clone(),
        );
        async move {
            decide_with(&pool, on, &who, &work, v, Some(&parent))
                .await
                .unwrap()
        }
    };

    // 스위치가 꺼져 있으면 아무것도 적지 않는다.
    assert_eq!(
        go(&done, &me, Verdict::Accept, false).await,
        Err(Refusal::Disabled)
    );
    // 승격은 조합이 생기기 전까지 거절이다.
    assert_eq!(
        go(&done, &me, Verdict::Promote, true).await,
        Err(Refusal::ComboUnimplemented)
    );
    // 열린 조각·남이 넘긴 조각·없는 조각·위임이 낳지 않은 작업(뿌리).
    assert_eq!(
        go(&open, &me, Verdict::Accept, true).await,
        Err(Refusal::NotClosed)
    );
    assert_eq!(
        go(&theirs, &me, Verdict::Accept, true).await,
        Err(Refusal::NotLeader)
    );
    assert_eq!(
        go(&done, &other, Verdict::Discard, true).await,
        Err(Refusal::NotLeader)
    );
    assert_eq!(
        go(&done, &alice, Verdict::Accept, true).await,
        Err(Refusal::NotLeader)
    );
    assert_eq!(
        go(&channel, &me, Verdict::Accept, true).await,
        Err(Refusal::NotFound)
    );
    assert_eq!(
        go(&parent, &me, Verdict::Accept, true).await,
        Err(Refusal::NotFound)
    );
    assert_eq!(rows().await, 0);

    // 수락은 끝이다.
    assert_eq!(
        go(&done, &me, Verdict::Accept, true).await,
        Ok(Decided {
            verdict: Verdict::Accept,
            retry_count: 0
        })
    );
    for v in [Verdict::Retry, Verdict::Discard, Verdict::Accept] {
        assert_eq!(
            go(&done, &me, v, true).await,
            Err(Refusal::AlreadyDecided),
            "{v:?}"
        );
    }

    // 재시도는 한 번 — 그 뒤에는 수락·버림만.
    assert_eq!(
        go(&failed, &me, Verdict::Retry, true).await,
        Ok(Decided {
            verdict: Verdict::Retry,
            retry_count: 1
        })
    );
    assert_eq!(
        go(&failed, &me, Verdict::Retry, true).await,
        Err(Refusal::RetryLimit)
    );
    assert_eq!(
        go(&failed, &other, Verdict::Discard, true).await,
        Err(Refusal::NotLeader)
    );
    assert_eq!(
        go(&failed, &me, Verdict::Discard, true).await,
        Ok(Decided {
            verdict: Verdict::Discard,
            retry_count: 1
        })
    );
    assert_eq!(
        go(&failed, &me, Verdict::Accept, true).await,
        Err(Refusal::AlreadyDecided)
    );

    let got: Vec<(String, String, i32, Option<String>, Option<String>)> = sqlx::query_as(
        "select work_id::text, verdict, retry_count, decided_by_account_id::text, decided_by_work_id::text \
           from work_verdict order by created_at, work_id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(got.len(), 2, "{got:?}");
    let of = |id: &str| got.iter().find(|r| r.0 == id).expect("row").clone();
    assert_eq!(of(&done).1, "accept");
    assert_eq!(of(&failed).1, "discard");
    assert_eq!(of(&failed).2, 1);
    assert!(got.iter().all(|r| r.3.as_deref() == Some(me.as_str())));
    assert!(got.iter().all(|r| r.4.as_deref() == Some(parent.as_str())));
}
