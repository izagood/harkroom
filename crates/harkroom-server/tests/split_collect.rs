//! F1b 하위 결과 모으기 — 자기 조각 둘이 **기한으로** 닫힐 때 넘긴 쪽이 조각마다가 아니라 마지막에 한 번만 깨어나는지
//! 실제 스키마에서 본다(기한 스윕이 결과 글과 같은 판정을 지나는지 고정). `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
//! 스위치 꺼짐·판정 표는 단위 시험이 본다(env 는 프로세스에서 한 번만 읽힌다).
use harkroom_server::auth::Account;
use harkroom_server::core::mcp::delegate_gate::answer;
use harkroom_server::core::msg_post::PostState;
use serde_json::{Value, json};
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

async fn done_wakes(pool: &PgPool, who: &str) -> i64 {
    sqlx::query_scalar(
        "select count(*) from inbox where account_id = $1::uuid and reason = 'delegation_done'",
    )
    .bind(who)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn deadline_closed_pieces_wake_the_parent_once() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    // 스위치는 처음 읽힐 때 한 번만 읽힌다 — 이 바이너리의 시험은 이것 하나다.
    unsafe {
        std::env::set_var("HARKROOM_SELF_SPLIT", "on");
        std::env::set_var("HARKROOM_SPLIT_COLLECT", "on");
        std::env::set_var("HARKROOM_DELEGATION_V2", "on");
    }
    let pool = PgPool::connect(&url).await.unwrap();
    let st = PostState {
        read: pool.clone(),
        write: pool.clone(),
        up: harkroom_server::proxy::Upstream::new("http://127.0.0.1:0"),
        implicit_ok: false,
    };
    let alice = mk(&pool, "sc-alice", "human").await;
    let me = agent(&pool, "sc-me", &alice).await;
    let channel: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility, created_by) values ('sc-ch', 'standard', 'public', $1::uuid) returning id::text",
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
    for _ in 0..2 {
        let args =
            json!({ "channelId": channel, "threadRootId": root, "body": "조각", "to": ["sc-me"] });
        let a = answer(&pool, Some(&st), false, &me, &args, None, None, false)
            .await
            .expect("answered");
        assert!(a.contains("delegationId"), "{a}");
    }
    let ids: Vec<(String, String)> = sqlx::query_as(
        "select id::text, message_id::text from team_delegation where thread_root_id = $1::uuid order by created_at, id",
    )
    .bind(&root)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(ids.len(), 2);
    let before = done_wakes(&pool, &me.id).await;

    // 첫 조각만 기한이 지났다 — 닫히지만 형제가 열려 있어 깨우지 않는다.
    let expire =
        "update team_delegation set deadline_at = now() - interval '1 second' where id = $1::uuid";
    sqlx::query(expire)
        .bind(&ids[0].0)
        .execute(&pool)
        .await
        .unwrap();
    harkroom_server::loops::delegation_deadline::sweep(&pool, false)
        .await
        .unwrap();
    let first: Option<String> = sqlx::query_scalar(
        "select outcome from team_delegation_item where delegation_id = $1::uuid",
    )
    .bind(&ids[0].0)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(first.as_deref(), Some("timeout"));
    assert_eq!(
        done_wakes(&pool, &me.id).await,
        before,
        "형제가 열려 있으면 깨우지 않는다"
    );

    // 마지막 조각도 기한으로 닫힌다 — 이때 한 번 깨우고, 그 위임 글에 두 조각의 표가 실린다.
    sqlx::query(expire)
        .bind(&ids[1].0)
        .execute(&pool)
        .await
        .unwrap();
    harkroom_server::loops::delegation_deadline::sweep(&pool, false)
        .await
        .unwrap();
    assert_eq!(
        done_wakes(&pool, &me.id).await,
        before + 1,
        "마지막 조각에서 한 번"
    );
    let meta: Value = sqlx::query_scalar("select meta::jsonb from message where id = $1::uuid")
        .bind(&ids[1].1)
        .fetch_one(&pool)
        .await
        .unwrap();
    let c = &meta["splitCollect"];
    assert_eq!(c["state"], "collected", "{meta}");
    assert_eq!(c["pieces"].as_array().map(Vec::len), Some(2), "{meta}");
    let body = c["body"].as_str().unwrap();
    assert!(
        body.contains(&format!("harkroom://message/{}", ids[0].1)),
        "{body}"
    );
    assert!(body.contains("기한"), "{body}");

    // 다시 쓸어도 더 깨우지 않는다.
    harkroom_server::loops::delegation_deadline::sweep(&pool, false)
        .await
        .unwrap();
    assert_eq!(done_wakes(&pool, &me.id).await, before + 1);
}
