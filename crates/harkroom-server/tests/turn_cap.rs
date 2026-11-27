//! 에이전트별 동시 턴 상한(`core::turn_cap`)을 실제 Postgres 로 본다 — 스레드 임대를 잡는 자리에서 세고, 하트비트는 세지 않는다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다. `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 잡기는 그 역할로 한다.
use harkroom_server::core::turn_cap::{Outcome, Want, claim};
use sqlx::PgPool;

async fn one(admin: &PgPool, sql: &'static str, binds: &[&str]) -> String {
    let mut q = sqlx::query_scalar::<_, String>(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_one(admin).await.unwrap()
}

struct Env {
    admin: PgPool,
    w: PgPool,
    human: String,
    ch: String,
}

impl Env {
    async fn agent(&self, handle: &str) -> String {
        one(
            &self.admin,
            "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
            &[handle],
        )
        .await
    }

    /// 스레드 뿌리 글 하나.
    async fn thread(&self) -> String {
        one(
            &self.admin,
            "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'hi', 'user') returning id::text",
            &[&self.ch, &self.human],
        )
        .await
    }

    async fn take(&self, agent: &str, root: &str, holder: &str, cap: Option<i64>) -> Outcome {
        let want = Want {
            agent,
            channel: &self.ch,
            root,
            holder,
            ttl_secs: 90,
        };
        claim(&self.w, want, cap).await.unwrap()
    }

    async fn live(&self, agent: &str) -> i64 {
        sqlx::query_scalar(
            "select count(*)::int8 from agent_thread_claim where agent_id = $1::uuid and expires_at > now()",
        )
        .bind(agent)
        .fetch_one(&self.admin)
        .await
        .unwrap()
    }

    async fn expire(&self, agent: &str, root: &str) {
        sqlx::query(
            "update agent_thread_claim set expires_at = now() - interval '1 second' \
              where agent_id = $1::uuid and thread_root_id = $2::uuid",
        )
        .bind(agent)
        .bind(root)
        .execute(&self.admin)
        .await
        .unwrap();
    }

    async fn release(&self, agent: &str, root: &str) {
        sqlx::query(
            "delete from agent_thread_claim where agent_id = $1::uuid and thread_root_id = $2::uuid",
        )
        .bind(agent)
        .bind(root)
        .execute(&self.admin)
        .await
        .unwrap();
    }
}

fn held(o: &Outcome) -> bool {
    matches!(o, Outcome::Held(_))
}

#[tokio::test]
async fn agent_turn_cap_counts_live_claims_and_spares_heartbeats() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let w = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(u) => PgPool::connect(&u).await.unwrap(),
        Err(_) => admin.clone(),
    };
    let human = one(
        &admin,
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text",
        &["tcap_rs_human"],
    )
    .await;
    let ch = one(
        &admin,
        "insert into channel(name, kind, visibility, created_by) values ($1, 'standard', 'private', $2::uuid) returning id::text",
        &["tcap-rs", &human],
    )
    .await;
    let env = Env {
        admin,
        w,
        human,
        ch,
    };
    let a = env.agent("tcap_rs_a").await;
    let b = env.agent("tcap_rs_b").await;
    let (t1, t2, t3) = (env.thread().await, env.thread().await, env.thread().await);

    // 상한 2 — 두 스레드까지 잡고 세 번째는 막힌다. 막힌 잡기는 줄을 남기지 않는다.
    assert!(held(&env.take(&a, &t1, "r1", Some(2)).await));
    assert!(held(&env.take(&a, &t2, "r1", Some(2)).await));
    assert_eq!(
        env.take(&a, &t3, "r1", Some(2)).await,
        Outcome::Capped { live: 2, cap: 2 }
    );
    assert_eq!(env.live(&a).await, 2);

    // 하트비트(같은 holder 가 쥔 스레드를 다시 잡기)는 상한이 찼어도 늘린다 — 상한을 1 로 낮춰도 도는 턴은 끊기지 않는다.
    assert!(held(&env.take(&a, &t1, "r1", Some(2)).await));
    assert!(held(&env.take(&a, &t2, "r1", Some(1)).await));
    // 만료된 내 줄의 늦은 하트비트도 늘린다.
    env.expire(&a, &t2).await;
    assert!(held(&env.take(&a, &t2, "r1", Some(1)).await));
    assert_eq!(env.live(&a).await, 2);

    // 같은 에이전트의 다른 러너가 쥔 스레드 — 상한이 찼으면 상한이 먼저 답하고, 자리가 있으면 예전처럼 「남이 쥠」이다.
    assert_eq!(
        env.take(&a, &t1, "r2", Some(1)).await,
        Outcome::Capped { live: 1, cap: 1 }
    );
    assert!(matches!(
        env.take(&a, &t1, "r2", Some(3)).await,
        Outcome::Taken(Some(_))
    ));

    // 다른 에이전트는 따로 센다.
    assert!(held(&env.take(&b, &t3, "r1", Some(1)).await));
    assert_eq!(
        env.take(&b, &t1, "r1", Some(1)).await,
        Outcome::Capped { live: 1, cap: 1 }
    );

    // 놓으면 자리가 난다. 만료된 줄은 세지 않는다.
    env.release(&a, &t1).await;
    assert!(held(&env.take(&a, &t3, "r1", Some(2)).await));
    env.expire(&a, &t2).await;
    assert!(held(&env.take(&a, &t1, "r2", Some(2)).await));
    assert_eq!(env.live(&a).await, 2);

    // 상한 없음 — 세지 않는다(예전 문장 하나).
    let t4 = env.thread().await;
    assert!(held(&env.take(&a, &t4, "r1", None).await));
    assert!(matches!(
        env.take(&a, &t4, "r2", None).await,
        Outcome::Taken(Some(_))
    ));
    assert_eq!(env.live(&a).await, 3);
}

/// 같은 에이전트의 잡기가 한꺼번에 몰려도 상한을 넘지 않는다(에이전트마다 줄을 세운다).
#[tokio::test]
async fn concurrent_claims_never_exceed_the_cap() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let w = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(u) => PgPool::connect(&u).await.unwrap(),
        Err(_) => admin.clone(),
    };
    let human = one(
        &admin,
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text",
        &["tcap_rs_human2"],
    )
    .await;
    let ch = one(
        &admin,
        "insert into channel(name, kind, visibility, created_by) values ($1, 'standard', 'private', $2::uuid) returning id::text",
        &["tcap-rs-2", &human],
    )
    .await;
    let env = std::sync::Arc::new(Env {
        admin,
        w,
        human,
        ch,
    });
    let a = env.agent("tcap_rs_many").await;
    let mut threads = Vec::new();
    for _ in 0..6 {
        threads.push(env.thread().await);
    }
    let mut tasks = Vec::new();
    for t in threads {
        let (env, a) = (env.clone(), a.clone());
        tasks.push(tokio::spawn(async move {
            env.take(&a, &t, "r1", Some(3)).await
        }));
    }
    let mut got = 0;
    for t in tasks {
        match t.await.unwrap() {
            Outcome::Held(_) => got += 1,
            Outcome::Capped { cap: 3, .. } => {}
            other => panic!("{other:?}"),
        }
    }
    assert_eq!(got, 3);
    assert_eq!(env.live(&a).await, 3);
}
