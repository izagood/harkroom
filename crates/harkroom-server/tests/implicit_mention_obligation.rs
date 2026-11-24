//! U4 — 에이전트의 맨 앞 멘션(암묵 위임)이 스위치마다 무엇을 적는지 실제 스키마에서 본다. 꺼짐은 아무것도, 그림자는 판정 기록만,
//! 켜짐은 `agent.call(expect: "reply")` 와 같은 의무(`close_on = 'reply'`, 생김새는 `mention`)를 세운다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 넘긴다).
use harkroom_server::core::implicit_delegation::{Mode, Post, record};
use sqlx::PgPool;

/// 기한 글자 — 이 시험은 기한을 보지 않는다.
fn deadline(_ms: i64) -> String {
    "2099-01-01T00:00:00.000Z".to_owned()
}

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

async fn message(pool: &PgPool, channel: &str, author: &str, root: Option<&str>) -> String {
    sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind, thread_root_id) \
         values ($1::uuid, $2::uuid, 'x', 'user', $3::uuid) returning id::text",
    )
    .bind(channel)
    .bind(author)
    .bind(root)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// 이 스레드의 의무 행 — (생김새, 닫는 조건, 담당, 결말).
async fn obligations(pool: &PgPool, root: &str) -> Vec<(String, String, String, Option<String>)> {
    sqlx::query_as(
        "select d.kind, d.close_on, i.delegate_account_id::text, i.outcome \
           from team_delegation d join team_delegation_item i on i.delegation_id = d.id \
          where d.thread_root_id = $1::uuid order by d.created_at, d.id",
    )
    .bind(root)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// 이 스레드의 판정 기록 — (판정, 모드, 의무를 세웠나).
async fn verdicts(pool: &PgPool, root: &str) -> Vec<(String, String, bool)> {
    sqlx::query_as(
        "select verdict, mode, delegation_id is not null from delegation_implicit_log \
          where thread_root_id = $1::uuid order by created_at, id",
    )
    .bind(root)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn head_mention_obligation_follows_the_switch() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let alice = account(&pool, "im-alice", "human").await;
    let me = account(&pool, "im-me", "agent").await;
    let mate = account(&pool, "im-mate", "agent").await;
    let channel: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility, created_by) values ('im-ch', 'standard', 'public', $1::uuid) returning id::text",
    )
    .bind(&alice)
    .fetch_one(&pool)
    .await
    .unwrap();
    let body = format!("<@{mate}> 이거 봐 줄래?");
    // 한 번의 맨 앞 멘션 — 새 스레드에 `from` 이 `to` 를 부른 글 하나를 놓고 판정을 돌린다. 돌려주는 것은 (스레드, 세운 의무 id 들).
    let run = |mode: Mode, from: String, to: Vec<String>, root: Option<String>| {
        let (pool, alice, channel, body) = (&pool, &alice, &channel, &body);
        async move {
            let root = match root {
                Some(r) => r,
                None => message(pool, channel, alice, None).await,
            };
            let msg = message(pool, channel, &from, Some(&root)).await;
            let called: Vec<&String> = to.iter().collect();
            let mut conn = pool.acquire().await.unwrap();
            let made = record(
                &mut conn,
                mode,
                &Post {
                    message_id: &msg,
                    channel_id: channel,
                    thread_root_id: &root,
                    author_id: &from,
                    normalized_body: body,
                },
                &called,
                0,
                deadline,
            )
            .await
            .unwrap();
            (root, made)
        }
    };

    // 꺼짐 — 의무도 판정 기록도 없다.
    let (root, made) = run(Mode::Off, me.clone(), vec![mate.clone()], None).await;
    assert!(made.is_empty());
    assert!(obligations(&pool, &root).await.is_empty());
    assert!(verdicts(&pool, &root).await.is_empty());

    // 그림자 — 판정 기록만. 의무는 서지 않는다.
    let (root, made) = run(Mode::Shadow, me.clone(), vec![mate.clone()], None).await;
    assert!(made.is_empty());
    assert!(obligations(&pool, &root).await.is_empty());
    assert_eq!(
        verdicts(&pool, &root).await,
        [("open".to_owned(), "shadow".to_owned(), false)]
    );

    // 켜짐 — 첫 답글로 닫히는 의무 하나. 사람을 부른 멘션에는 서지 않는다.
    let (root, made) = run(
        Mode::On,
        me.clone(),
        vec![mate.clone(), alice.clone()],
        None,
    )
    .await;
    assert_eq!(made.len(), 1);
    assert_eq!(
        obligations(&pool, &root).await,
        [("mention".to_owned(), "reply".to_owned(), mate.clone(), None)]
    );
    assert_eq!(
        verdicts(&pool, &root).await,
        [("open".to_owned(), "on".to_owned(), true)]
    );
    // 판정은 그대로다 — 답 방향(담당이 넘긴 쪽을 부름)·이미 열린 의무가 있으면 새로 세우지 않는다.
    let (_, made) = run(Mode::On, mate.clone(), vec![me.clone()], Some(root.clone())).await;
    assert!(made.is_empty());
    let (_, made) = run(Mode::On, me.clone(), vec![mate.clone()], Some(root.clone())).await;
    assert!(made.is_empty());
    assert_eq!(obligations(&pool, &root).await.len(), 1);
    let v = verdicts(&pool, &root).await;
    assert_eq!((v[1].0.as_str(), v[2].0.as_str()), ("reply", "existing"));
}
