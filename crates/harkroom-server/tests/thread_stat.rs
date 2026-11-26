//! 미리 센 스레드 집계(마이그레이션 197 `thread_stat`·`thread_stat_of`)가 예전 줄마다 다시 세던 LATERAL 과
//! **같은 값**인지 실제 Postgres 로 대조한다. 넣기·지우기(soft delete)·여러 kind·같은 작성자 여러 번·시스템 줄(시스템 줄만 쓴 작성자 포함)·
//! 채널 지우기를 지난다. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
use sqlx::PgPool;

/// 예전 `golden/sql_fragments.json` 의 `thread_stats` LATERAL 그대로(뿌리 하나에 대해).
const OLD: &str = "select reply_count, activity_count, last_reply_at, participant_ids::text[] from message m \
  left join lateral ( \
    select count(*) filter (where kind not in ('progress', 'wake'))::int as reply_count, \
      count(*)::int as activity_count, \
      max(created_at) filter (where kind not in ('progress', 'wake'))::text as last_reply_at, \
      coalesce(( \
        select array_agg(author_id order by last_at desc) from ( \
          select author_id, max(created_at) as last_at from message \
          where thread_root_id = m.id and deleted_at is null and author_id is not null \
            and kind <> 'system' and m.thread_root_id is null \
          group by author_id) recent \
      ), '{}'::uuid[]) as participant_ids \
    from message where thread_root_id = m.id and deleted_at is null and m.thread_root_id is null \
  ) thread_stats on true where m.id = $1::uuid";

const NEW: &str = "select reply_count, activity_count, last_reply_at, participant_ids::text[] from message m \
  left join lateral (select * from thread_stat_of(case when m.thread_root_id is null then m.id end)) thread_stats on true \
  where m.id = $1::uuid";

type Stat = (i32, i32, Option<String>, Vec<String>);

async fn stat(pool: &PgPool, sql: &'static str, id: &str) -> Stat {
    sqlx::query_as(sql).bind(id).fetch_one(pool).await.unwrap()
}

async fn same(pool: &PgPool, id: &str, ctx: &str) -> Stat {
    let old = stat(pool, OLD, id).await;
    let new = stat(pool, NEW, id).await;
    assert_eq!(new, old, "{ctx}: 집계가 예전 LATERAL 과 다르다");
    new
}

async fn one(pool: &PgPool, sql: &'static str, bind: &str) -> String {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// `at` 초 뒤 시각으로 넣는다 — 같은 시각이면 참여자 순서가 정해지지 않는다.
async fn say(
    pool: &PgPool,
    ch: &str,
    root: Option<&str>,
    author: Option<&str>,
    kind: &str,
    at: i32,
) -> String {
    sqlx::query_scalar(
        "insert into message(channel_id, thread_root_id, author_id, body, kind, meta, created_at) \
         values ($1::uuid, $2::uuid, $3::uuid, 'x', $4, '{}', timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => $5)) \
         returning id::text",
    )
    .bind(ch)
    .bind(root)
    .bind(author)
    .bind(kind)
    .bind(at as f64)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn thread_stat_matches_lateral() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let db = PgPool::connect(&url).await.unwrap();
    let alice = one(&db, "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text", "ts_alice").await;
    let bot = one(&db, "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text", "ts_bot").await;
    let bob = one(&db, "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text", "ts_bob").await;
    let ch = one(
        &db,
        "insert into channel(name, kind) values ($1, 'standard') returning id::text",
        "thread-stat-rs",
    )
    .await;

    // 답글 없는 뿌리 — 집계 줄이 없어도 0·null·빈 배열.
    let lonely = say(&db, &ch, None, Some(&alice), "user", 0).await;
    let s = same(&db, &lonely, "답글 없는 뿌리").await;
    assert_eq!(
        (s.0, s.1, s.2.is_none(), s.3.is_empty()),
        (0, 0, true, true)
    );

    let root = say(&db, &ch, None, Some(&alice), "user", 1).await;
    let r1 = say(&db, &ch, Some(&root), Some(&bot), "user", 2).await;
    say(&db, &ch, Some(&root), Some(&bot), "progress", 3).await;
    say(&db, &ch, Some(&root), Some(&bot), "wake", 4).await;
    say(&db, &ch, Some(&root), Some(&alice), "system", 5).await;
    say(&db, &ch, Some(&root), Some(&bob), "system", 6).await;
    let r_bob = say(&db, &ch, Some(&root), Some(&bob), "user", 7).await;
    say(&db, &ch, Some(&root), Some(&alice), "user", 8).await;
    let s = same(&db, &root, "넣기 뒤").await;
    assert_eq!((s.0, s.1), (5, 7));
    assert_eq!(s.3.len(), 3);

    // 답글 줄 자신은 집계가 비어 있다(뿌리에서만 센다).
    same(&db, &r1, "답글 줄").await;

    // 지우기: 마지막 답글·한 사람뿐인 작성자의 글.
    sqlx::query("update message set deleted_at = now() where id = $1::uuid")
        .bind(&r_bob)
        .execute(&db)
        .await
        .unwrap();
    let s = same(&db, &root, "bob 글 지운 뒤").await;
    assert_eq!(s.3.len(), 2);
    sqlx::query(
        "update message set deleted_at = now() where thread_root_id = $1::uuid and kind = 'user'",
    )
    .bind(&root)
    .execute(&db)
    .await
    .unwrap();
    let s = same(&db, &root, "사람 답글을 다 지운 뒤").await;
    assert_eq!(s.0, 2);

    // 더 넣으면 다시 맞는다(지우기 뒤 더하기).
    say(&db, &ch, Some(&root), Some(&bob), "user", 9).await;
    same(&db, &root, "지운 뒤 다시 넣기").await;

    // 뿌리를 지워도(soft) 집계는 답글만 본다 — 예전과 같다.
    sqlx::query("update message set deleted_at = now() where id = $1::uuid")
        .bind(&root)
        .execute(&db)
        .await
        .unwrap();
    same(&db, &root, "뿌리 soft delete").await;

    // 채널 지우기: 뿌리와 함께 집계 줄도 사라진다.
    sqlx::query("delete from message where channel_id = $1::uuid")
        .bind(&ch)
        .execute(&db)
        .await
        .unwrap();
    let left: i64 = sqlx::query_scalar("select count(*) from thread_stat where root_id = $1::uuid")
        .bind(&root)
        .fetch_one(&db)
        .await
        .unwrap();
    let left_p: i64 =
        sqlx::query_scalar("select count(*) from thread_participant where root_id = $1::uuid")
            .bind(&root)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!((left, left_p), (0, 0));
}
