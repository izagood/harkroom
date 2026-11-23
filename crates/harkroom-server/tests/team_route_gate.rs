//! 팀 명단 갈래 위임에도 호출 범위가 적용되는지, 팀원 넣기가 소유·관리하는 에이전트만 받는지를 실제 스키마에서 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 넘긴다).
use harkroom_server::auth::Account;
use harkroom_server::core::mcp::delegate_gate::answer;
use harkroom_server::writes_teams::may_add_member;
use serde_json::json;
use sqlx::PgPool;

async fn mk(pool: &PgPool, handle: &str, kind: &str) -> Account {
    let id: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id, role, is_admin) \
         values ($1, $1, $2, case when $2 = 'human' then $1 end, 'member', false) returning id::text",
    )
    .bind(handle)
    .bind(kind)
    .fetch_one(pool)
    .await
    .unwrap();
    Account {
        id,
        handle: handle.into(),
        display_name: handle.into(),
        kind: kind.into(),
        is_admin: false,
        role: "member".into(),
        status: "online".into(),
        status_text: None,
        avatar_attachment_id: None,
    }
}

async fn agent(pool: &PgPool, handle: &str, scope: &str, owner: &Account) -> Account {
    let a = mk(pool, handle, "agent").await;
    sqlx::query(
        "insert into agent_config(account_id, invoke_scope, owner_account_id) values ($1::uuid, $2, $3::uuid)",
    )
    .bind(&a.id)
    .bind(scope)
    .bind(&owner.id)
    .execute(pool)
    .await
    .unwrap();
    a
}

async fn team(pool: &PgPool, name: &str, by: &Account, lead: &Account, members: &[&Account]) {
    let id: String = sqlx::query_scalar(
        "insert into agent_team(name, created_by, invoke_scope, owner_account_id) \
         values ($1, $2::uuid, 'owner', $2::uuid) returning id::text",
    )
    .bind(name)
    .bind(&by.id)
    .fetch_one(pool)
    .await
    .unwrap();
    for m in std::iter::once(&lead).chain(members) {
        sqlx::query(
            "insert into agent_team_member(team_id, agent_account_id) values ($1::uuid, $2::uuid)",
        )
        .bind(&id)
        .bind(&m.id)
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query("update agent_team set lead_account_id = $2::uuid where id = $1::uuid")
        .bind(&id)
        .bind(&lead.id)
        .execute(pool)
        .await
        .unwrap();
}

#[tokio::test]
async fn team_route_respects_invoke_scope() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let alice = mk(&pool, "tg-alice", "human").await;
    let bob = mk(&pool, "tg-bob", "human").await;
    let lead = agent(&pool, "tg-lead", "owner", &alice).await;
    let same = agent(&pool, "tg-same", "owner", &alice).await;
    let closed = agent(&pool, "tg-closed", "owner", &bob).await;
    let open = agent(&pool, "tg-open", "community", &bob).await;
    // 같은 소유자 팀 / 소유자가 섞인 팀(팀장이 다른 에이전트).
    team(&pool, "tg-team-same", &alice, &lead, &[&same]).await;
    let lead2 = agent(&pool, "tg-lead2", "owner", &alice).await;
    team(
        &pool,
        "tg-team-mixed",
        &alice,
        &lead2,
        &[&same, &closed, &open],
    )
    .await;
    let channel: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility, created_by) values ('tg-ch', 'standard', 'public', $1::uuid) returning id::text",
    )
    .bind(&alice.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let root = "22222222-2222-2222-2222-222222222222";
    let call =
        |to: &[&str]| json!({ "channelId": channel, "threadRootId": root, "body": "x", "to": to });
    // 쓰기 칸 없이 부른다 — 게이트를 지나면 `None`(쓰기 앞에서 멈춤), 거절이면 그 글자.
    let ask = |me: &Account, to: &[&str]| {
        let (pool, me, args) = (pool.clone(), me.clone(), call(to));
        async move { answer(&pool, None, false, &me, &args, None, None, false).await }
    };

    // 같은 소유자 팀: 호출 범위가 owner 여도 예전처럼 명단으로 지나간다.
    assert_eq!(ask(&lead, &["tg-same"]).await, None);
    // 섞인 팀: 범위 밖 팀원은 거절되고, 거절 글에는 그 팀원만 실린다.
    let refused = ask(&lead2, &["tg-same", "tg-closed"])
        .await
        .expect("refused");
    assert!(refused.contains("not_invokable"), "{refused}");
    assert!(refused.contains("tg-closed"), "{refused}");
    assert!(!refused.contains("tg-same"), "{refused}");
    // 섞인 팀이어도 범위가 받는 팀원(community)·같은 소유자 팀원은 지나간다.
    assert_eq!(ask(&lead2, &["tg-same", "tg-open"]).await, None);

    // 팀원 넣기: 소유자는 되고, 남의 에이전트는 안 된다. 그 에이전트의 관리 권한을 받으면 된다.
    assert!(may_add_member(&pool, &alice, &same.id).await.unwrap());
    assert!(!may_add_member(&pool, &alice, &closed.id).await.unwrap());
    sqlx::query(
        "insert into account_grant(account_id, capability, scope, granted_by) values ($1::uuid, 'agent.manage', $2, $3::uuid)",
    )
    .bind(&alice.id)
    .bind(format!("agent:{}", closed.id))
    .bind(&bob.id)
    .execute(&pool)
    .await
    .unwrap();
    assert!(may_add_member(&pool, &alice, &closed.id).await.unwrap());
}
