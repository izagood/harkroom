//! F1a 자기 쪼개기 — 스위치가 켜졌을 때 `to` 가 나 하나뿐인 위임이 자기 조각 의무를 세우는지 실제 스키마에서 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 넘긴다). 스위치 꺼짐은 단위 시험이 본다
//! (env 는 프로세스에서 한 번만 읽힌다).
use harkroom_server::auth::Account;
use harkroom_server::core::mcp::delegate_gate::answer;
use harkroom_server::core::msg_post::PostState;
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

async fn agent(pool: &PgPool, handle: &str, owner: &Account) -> Account {
    let a = mk(pool, handle, "agent").await;
    sqlx::query(
        "insert into agent_config(account_id, invoke_scope, owner_account_id) values ($1::uuid, 'owner', $2::uuid)",
    )
    .bind(&a.id)
    .bind(&owner.id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "insert into agent_presence(account_id, expires_at) values ($1::uuid, now() + interval '5 minutes')",
    )
    .bind(&a.id)
    .execute(pool)
    .await
    .unwrap();
    a
}

/// (위임 id, team_id, 담당, 결말 — 열려 있으면 없음) — 이 스레드의 의무 행 전부, 세운 순서로.
async fn pieces(
    pool: &PgPool,
    root: &str,
) -> Vec<(String, Option<String>, String, Option<String>)> {
    sqlx::query_as(
        "select d.id::text, d.team_id::text, i.delegate_account_id::text, i.outcome \
           from team_delegation d join team_delegation_item i on i.delegation_id = d.id \
          where d.thread_root_id = $1::uuid order by d.created_at, d.id",
    )
    .bind(root)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn self_piece_opens_without_team_and_keeps_siblings() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    // 스위치는 처음 읽힐 때 한 번만 읽힌다 — 이 바이너리의 시험은 이것 하나다.
    unsafe {
        std::env::set_var("HARKROOM_SELF_SPLIT", "on");
        std::env::set_var("HARKROOM_DELEGATION_V2", "on");
    }
    let pool = PgPool::connect(&url).await.unwrap();
    let st = PostState {
        read: pool.clone(),
        write: pool.clone(),
        up: harkroom_server::proxy::Upstream::new("http://127.0.0.1:0"),
        implicit_ok: false,
    };
    let alice = mk(&pool, "ss-alice", "human").await;
    let me = agent(&pool, "ss-me", &alice).await;
    let mate = agent(&pool, "ss-mate", &alice).await;
    // 나는 내 팀의 팀장이자 팀원이다 — 그래도 자기 조각은 팀 명단 갈래를 타지 않는다.
    let team: String = sqlx::query_scalar(
        "insert into agent_team(name, created_by, invoke_scope, owner_account_id) \
         values ('ss-team', $1::uuid, 'owner', $1::uuid) returning id::text",
    )
    .bind(&alice.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    for m in [&me, &mate] {
        sqlx::query(
            "insert into agent_team_member(team_id, agent_account_id) values ($1::uuid, $2::uuid)",
        )
        .bind(&team)
        .bind(&m.id)
        .execute(&pool)
        .await
        .unwrap();
    }
    sqlx::query("update agent_team set lead_account_id = $2::uuid where id = $1::uuid")
        .bind(&team)
        .bind(&me.id)
        .execute(&pool)
        .await
        .unwrap();
    let channel: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility, created_by) values ('ss-ch', 'standard', 'public', $1::uuid) returning id::text",
    )
    .bind(&alice.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let root: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'root', 'user') returning id::text",
    )
    .bind(&channel)
    .bind(&alice.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let ask = |who: &Account, to: &[&str]| {
        let args = json!({ "channelId": channel, "threadRootId": root, "body": "조각", "to": to });
        let (pool, st, who) = (pool.clone(), &st, who.clone());
        async move { answer(&pool, Some(st), false, &who, &args, None, None, false).await }
    };

    // 남과 섞인 `to`·사람의 자기 위임은 스위치가 켜져도 예전 거절이고 아무것도 쓰지 않는다.
    let mixed = ask(&me, &["ss-me", "ss-mate"]).await.expect("refused");
    assert!(mixed.contains("self_delegation"), "{mixed}");
    let human = ask(&alice, &["ss-alice"]).await.expect("refused");
    assert!(human.contains("self_delegation"), "{human}");
    assert!(pieces(&pool, &root).await.is_empty());

    // 자기 조각 — 호출 범위가 owner 여도 선다. 팀장이어도 `team_id` 는 적지 않는다.
    let first = ask(&me, &["SS-Me"]).await.expect("answered");
    assert!(first.contains("delegationId"), "{first}");
    assert!(!first.contains("\"error\""), "{first}");
    let rows = pieces(&pool, &root).await;
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].1, None, "자기 조각은 team_id 가 없다");
    assert_eq!(rows[0].2, me.id);
    assert_eq!(rows[0].3, None, "열린 의무");
    let lead: String =
        sqlx::query_scalar("select lead_account_id::text from team_delegation where id = $1::uuid")
            .bind(&rows[0].0)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(lead, me.id);

    // 둘째 조각 — 앞 조각을 대체하지 않는다(둘 다 열린 채).
    let second = ask(&me, &["ss-me"]).await.expect("answered");
    assert!(second.contains("delegationId"), "{second}");
    let rows = pieces(&pool, &root).await;
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(
        rows.iter().all(|r| r.3.is_none() && r.1.is_none()),
        "{rows:?}"
    );

    // 견줌: 팀원에게 넘기는 보통의 위임은 팀 명단 갈래 그대로다(`team_id` 가 적힌다).
    let other = ask(&me, &["ss-mate"]).await.expect("answered");
    assert!(other.contains("delegationId"), "{other}");
    let rows = pieces(&pool, &root).await;
    assert_eq!(rows.len(), 3, "{rows:?}");
    let to_mate = rows.iter().find(|r| r.2 == mate.id).expect("mate row");
    assert_eq!(to_mate.1.as_deref(), Some(team.as_str()));
}
