//! 깨움 행 같이 쓰기(`core::wake_write`)를 실제 Postgres 로 본다 — 같은 트랜잭션에서 쓰이는지, 거울과 겹쳐도 한 줄인지,
//! 작업을 채우는지, 읽음이 같이 닫는지, 실패해도 부른 쪽 트랜잭션이 사는지.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 쓰기는 그 역할(`WAKE_WRITE_PRIVILEGES` + inbox 읽음 칸)로 돈다.
use harkroom_server::core::wake_write::{WAKE_WRITE_PRIVILEGES, read_close, write_now};
use harkroom_server::loops::wake_mirror::sweep;
use sqlx::PgPool;

async fn account(admin: &PgPool, handle: &str, kind: &str) -> String {
    sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, $2, case when $2 = 'human' then $1 end) returning id::text",
    )
    .bind(handle)
    .bind(kind)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn message(admin: &PgPool, ch: &str, author: &str, root: Option<&str>) -> String {
    sqlx::query_scalar(
        "insert into message(channel_id, author_id, thread_root_id, body, kind) \
         values ($1::uuid, $2::uuid, $3::uuid, 'x', 'user') returning id::text",
    )
    .bind(ch)
    .bind(author)
    .bind(root)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn inbox(admin: &PgPool, who: &str, msg: &str, reason: &str) -> i64 {
    sqlx::query_scalar(
        "insert into inbox(account_id, message_id, reason) values ($1::uuid, $2::uuid, $3) returning id",
    )
    .bind(who)
    .bind(msg)
    .bind(reason)
    .fetch_one(admin)
    .await
    .unwrap()
}

/// (사유, 상태, 스레드 뿌리, 작업, 닫힘이 inbox 의 read_at 과 같은가)
type Row = (String, String, Option<String>, Option<String>, bool);
async fn wakes(admin: &PgPool, inbox_id: i64) -> Vec<Row> {
    sqlx::query_as(
        "select w.reason, w.state, w.thread_root_id::text, w.work_id::text, \
                w.closed_at is not distinct from (select read_at from inbox where id = w.inbox_id) \
           from wake w where w.inbox_id = $1",
    )
    .bind(inbox_id)
    .fetch_all(admin)
    .await
    .unwrap()
}

#[tokio::test]
async fn writes_along_inbox_rows_in_the_same_transaction() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let w = PgPool::connect(&write_url).await.unwrap();
    let missing = harkroom_server::write::missing_in(&w, WAKE_WRITE_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    let agent = account(&admin, "ww-agent", "agent").await;
    let other = account(&admin, "ww-other", "agent").await;
    let human = account(&admin, "ww-human", "human").await;
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('ww-rs', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let root = message(&admin, &ch, &human, None).await;
    let reply = message(&admin, &ch, &human, Some(&root)).await;
    // 그 스레드에서 에이전트가 맡은 열린 작업 — 깨움의 `work_id` 로 들어가야 한다.
    let work: String = sqlx::query_scalar(
        "with n as (select gen_random_uuid() as id) \
         insert into work (id, channel_id, thread_root_id, root_id, assignee_account_id) \
         select n.id, $1::uuid, $2::uuid, n.id, $3::uuid from n returning id::text",
    )
    .bind(&ch)
    .bind(&root)
    .bind(&agent)
    .fetch_one(&admin)
    .await
    .unwrap();

    let mine = inbox(&admin, &agent, &reply, "mention").await;
    let theirs = inbox(&admin, &other, &reply, "mention").await;
    let for_human = inbox(&admin, &human, &reply, "mention").await;

    // 1) 되돌린 트랜잭션에서는 깨움도 남지 않는다 — 같은 트랜잭션이다.
    let mut tx = w.begin().await.unwrap();
    write_now(&mut tx, &reply, std::slice::from_ref(&agent)).await;
    tx.rollback().await.unwrap();
    assert!(wakes(&admin, mine).await.is_empty());

    // 2) 커밋하면 그 계정 것만 한 줄 — 스레드 뿌리와 작업이 찬다. 다른 계정·사람 줄은 건드리지 않는다.
    let mut tx = w.begin().await.unwrap();
    write_now(&mut tx, &reply, &[agent.clone(), human.clone()]).await;
    tx.commit().await.unwrap();
    assert_eq!(
        wakes(&admin, mine).await,
        vec![(
            "mention".to_owned(),
            "pending".to_owned(),
            Some(root.clone()),
            Some(work.clone()),
            true
        )]
    );
    assert!(wakes(&admin, theirs).await.is_empty());
    assert!(wakes(&admin, for_human).await.is_empty());

    // 3) 다시 불러도, 거울이 돌아도 한 줄이다. 거울은 빠진 줄(다른 에이전트)만 채우고 작업은 비운 채 둔다.
    let mut tx = w.begin().await.unwrap();
    write_now(&mut tx, &reply, std::slice::from_ref(&agent)).await;
    tx.commit().await.unwrap();
    sweep(&w).await.unwrap();
    assert_eq!(wakes(&admin, mine).await.len(), 1);
    assert_eq!(wakes(&admin, mine).await[0].3, Some(work.clone()));
    let t = wakes(&admin, theirs).await;
    assert_eq!((t.len(), t[0].3.clone()), (1, None));
    assert!(wakes(&admin, for_human).await.is_empty());

    // 4) inbox 줄의 사유가 바뀌면(위임 줄 바꿔 적기) 깨움의 사유를 맞춘다.
    sqlx::query("update inbox set reason = 'delegation_update' where id = $1")
        .bind(mine)
        .execute(&admin)
        .await
        .unwrap();
    let mut tx = w.begin().await.unwrap();
    write_now(&mut tx, &reply, std::slice::from_ref(&agent)).await;
    tx.commit().await.unwrap();
    assert_eq!(wakes(&admin, mine).await[0].0, "delegation_update");

    // 5) 읽음 + 닫기 한 문장 — 남의 줄 id 를 섞어도 자기 것만 읽히고 닫힌다. 두 번째는 0.
    let n = read_close(&w, &agent, &[mine, theirs]).await.unwrap();
    assert_eq!(n, 1);
    let a = wakes(&admin, mine).await;
    assert_eq!((a[0].1.as_str(), a[0].4), ("done", true));
    assert_eq!(wakes(&admin, theirs).await[0].1, "pending");
    assert_eq!(read_close(&w, &agent, &[mine]).await.unwrap(), 0);

    // 6) 실패해도 부른 쪽 트랜잭션은 산다 — 글 id 가 틀린 꼴이면 문장이 실패하지만 savepoint 만 되돌린다.
    let mut tx = w.begin().await.unwrap();
    write_now(&mut tx, "not-a-uuid", std::slice::from_ref(&agent)).await;
    let alive: i32 = sqlx::query_scalar("select 1")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(alive, 1);
    tx.commit().await.unwrap();

    // 7) 트랜잭션 밖에서 불리면 아무것도 쓰지 않는다(던지지도 않는다).
    let late = inbox(&admin, &agent, &root, "wake").await;
    let mut c = w.acquire().await.unwrap();
    write_now(&mut c, &root, std::slice::from_ref(&agent)).await;
    assert!(wakes(&admin, late).await.is_empty());
}
