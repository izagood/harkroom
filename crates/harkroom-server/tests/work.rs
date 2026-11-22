//! 작업 판(`core::work`, B1)을 실제 Postgres 로 본다 — 뿌리·하위 작업 행, 사건 이력, 나무 조회와 채널 가시성.
//! 쓰기는 `WORK_PRIVILEGES` 만 가진 역할로 한다(`scripts/db-tests.sh` 가 넘긴다 — 없으면 관리 연결).
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
use harkroom_server::core::work::{NewWork, Tree, append_event, create, set_state, tree};
use serde_json::json;
use sqlx::PgPool;

async fn id(admin: &PgPool, sql: &'static str, binds: &[&str]) -> String {
    let mut q = sqlx::query_scalar::<_, String>(sql);
    for b in binds {
        q = q.bind(*b);
    }
    q.fetch_one(admin).await.unwrap()
}

#[tokio::test]
async fn work_rows_events_and_tree() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let w = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(u) => PgPool::connect(&u).await.unwrap(),
        Err(_) => admin.clone(),
    };
    let human = id(&admin, "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text", &["work_rs_human"]).await;
    let outsider = id(&admin, "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text", &["work_rs_outsider"]).await;
    let agent = id(
        &admin,
        "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
        &["work_rs_agent"],
    )
    .await;
    let ch = id(
        &admin,
        "insert into channel(name, kind, visibility, created_by) values ($1, 'standard', 'private', $2::uuid) returning id::text",
        &["work-rs", &human],
    )
    .await;
    for who in [&human, &agent] {
        sqlx::query(
            "insert into channel_member(channel_id, account_id) values ($1::uuid, $2::uuid)",
        )
        .bind(&ch)
        .bind(who)
        .execute(&admin)
        .await
        .unwrap();
    }
    let root_msg = id(
        &admin,
        "insert into message(channel_id, author_id, body, kind, meta) \
         values ($1::uuid, $2::uuid, 'x', 'user', '{}') returning id::text",
        &[&ch, &human],
    )
    .await;

    // 뿌리 작업 — root_id = id, created 사건 한 줄.
    let root = create(
        &w,
        &NewWork {
            channel_id: &ch,
            thread_root_id: &root_msg,
            source_message_id: Some(&root_msg),
            assignee_account_id: Some(&agent),
            requester_account_id: Some(&human),
            cause_account_id: Some(&human),
            title: "root",
            ..Default::default()
        },
        Some(&human),
    )
    .await
    .unwrap()
    .unwrap();
    let (root_of, parent): (String, Option<String>) =
        sqlx::query_as("select root_id::text, parent_id::text from work where id = $1::uuid")
            .bind(&root)
            .fetch_one(&admin)
            .await
            .unwrap();
    assert_eq!(root_of, root);
    assert_eq!(parent, None);

    // 하위 작업 — 채널·스레드·뿌리·원인 사람은 부모 행에서 온다(넘긴 값은 무시된다). 담당이 비면 열린 과제.
    let paths = vec!["src/a".to_string()];
    let child = create(
        &w,
        &NewWork {
            channel_id: &ch,
            thread_root_id: &root_msg,
            parent_id: Some(&root),
            created_by_work_id: Some(&root),
            cause_account_id: Some(&outsider),
            title: "child",
            paths: &paths,
            ..Default::default()
        },
        Some(&agent),
    )
    .await
    .unwrap()
    .unwrap();
    let (c_root, c_cause, c_assignee): (String, Option<String>, Option<String>) = sqlx::query_as(
        "select root_id::text, cause_account_id::text, assignee_account_id::text from work where id = $1::uuid",
    )
    .bind(&child)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(c_root, root);
    assert_eq!(c_cause.as_deref(), Some(human.as_str()));
    assert_eq!(c_assignee, None);

    // 없는 부모 — 행을 만들지 않는다.
    let none = create(
        &w,
        &NewWork {
            channel_id: &ch,
            thread_root_id: &root_msg,
            parent_id: Some("00000000-0000-4000-8000-000000000000"),
            ..Default::default()
        },
        None,
    )
    .await
    .unwrap();
    assert_eq!(none, None);

    // 상태 바꾸기 — 같은 상태·모르는 상태는 아무것도 하지 않는다. 끝난 상태면 closed_at 이 찬다.
    assert!(set_state(&w, &child, "done", Some(&agent)).await.unwrap());
    assert!(!set_state(&w, &child, "done", Some(&agent)).await.unwrap());
    assert!(!set_state(&w, &child, "nope", Some(&agent)).await.unwrap());
    let closed: bool =
        sqlx::query_scalar("select closed_at is not null from work where id = $1::uuid")
            .bind(&child)
            .fetch_one(&admin)
            .await
            .unwrap();
    assert!(closed);
    append_event(&w, &root, "note", Some(&agent), &json!({ "n": 1 }))
        .await
        .unwrap();
    let kinds: Vec<String> =
        sqlx::query_scalar("select kind from work_event where work_id = $1::uuid order by id")
            .bind(&child)
            .fetch_all(&admin)
            .await
            .unwrap();
    assert_eq!(kinds, ["created", "state"]);

    // 나무 — 뿌리 아래 하위 하나, 마지막 사건·열린 하위 수.
    let Tree::Ok(t) = tree(&w, &human, &root_msg).await.unwrap() else {
        panic!("member must see the tree");
    };
    assert_eq!(t["channelId"], ch.as_str());
    let works = t["works"].as_array().unwrap();
    assert_eq!(works.len(), 1);
    assert_eq!(works[0]["id"], root.as_str());
    assert_eq!(works[0]["assigneeId"], agent.as_str());
    assert_eq!(works[0]["openChildren"], 0);
    assert_eq!(works[0]["eventCount"], 2);
    assert_eq!(works[0]["lastEvent"]["kind"], "note");
    assert_eq!(works[0]["lastEvent"]["payload"]["n"], 1);
    let kid = &works[0]["children"][0];
    assert_eq!(kid["id"], child.as_str());
    assert_eq!(kid["state"], "done");
    assert_eq!(kid["paths"], json!(["src/a"]));
    assert_eq!(kid["lastEvent"]["payload"]["to"], "done");

    // 가시성 — 비공개 채널의 멤버가 아니면 막힌다. 뿌리가 아닌 글·없는 글은 NotFound.
    assert!(matches!(
        tree(&w, &outsider, &root_msg).await.unwrap(),
        Tree::Forbidden
    ));
    assert!(matches!(
        tree(&w, &human, "00000000-0000-4000-8000-000000000000")
            .await
            .unwrap(),
        Tree::NotFound
    ));

    // 채널을 지우면 작업·사건도 같이 지워진다(FK cascade).
    sqlx::query("delete from channel where id = $1::uuid")
        .bind(&ch)
        .execute(&admin)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("select count(*) from work_event")
        .fetch_one(&admin)
        .await
        .unwrap();
    assert_eq!(left, 0);
}
