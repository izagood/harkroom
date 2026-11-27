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

const INSERT_REPLY: &str = "insert into message(channel_id, thread_root_id, author_id, body, kind, meta, created_at) \
  values ($1::uuid, $2::uuid, $3::uuid, 'x', 'user', '{}', timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => $4)) \
  returning id::text";

/// 같은 뿌리에서 답글 넣기와 지우기(soft delete → `thread_stat_recount`)가 겹쳐도 교착이 없고, 집계가 다시 센 값과 같다.
#[tokio::test]
async fn thread_stat_recount_races_with_insert() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let db = sqlx::postgres::PgPoolOptions::new()
        .max_connections(16)
        .connect(&url)
        .await
        .unwrap();
    let alice = one(&db, "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text", "tsr_alice").await;
    let bob = one(&db, "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text", "tsr_bob").await;
    let ch = one(
        &db,
        "insert into channel(name, kind) values ($1, 'standard') returning id::text",
        "thread-stat-race",
    )
    .await;
    let root = say(&db, &ch, None, Some(&alice), "user", 0).await;
    let gone = say(&db, &ch, Some(&root), Some(&alice), "user", 1).await;

    // 1) 넣기 tx 가 커밋 전에 thread_stat 줄을 잡고 있는 동안 지우기가 온다. 지우기의 recount 는 잠금을 기다렸다가
    //    넣은 답글까지 보고 세야 한다(잠금 전 스냅숏으로 세면 1 모자란다).
    let mut t1 = db.begin().await.unwrap();
    sqlx::query_scalar::<_, String>(INSERT_REPLY)
        .bind(&ch)
        .bind(&root)
        .bind(&bob)
        .bind(2f64)
        .fetch_one(&mut *t1)
        .await
        .unwrap();
    let del = {
        let db = db.clone();
        let gone = gone.clone();
        tokio::spawn(async move {
            sqlx::query("update message set deleted_at = now() where id = $1::uuid")
                .bind(&gone)
                .execute(&db)
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert!(
        !del.is_finished(),
        "recount 가 thread_stat 잠금을 기다리지 않았다"
    );
    t1.commit().await.unwrap();
    del.await.unwrap().expect("지우기가 실패했다");
    let s = same(&db, &root, "넣기 커밋 전에 온 지우기").await;
    assert_eq!((s.0, s.1, s.3.len()), (1, 1, 1));

    // 2) 여러 넣기·지우기를 동시에 — 교착 오류 없이 끝나고 집계 = 다시 센 값.
    let mut ids = Vec::new();
    for i in 0..20 {
        let who = if i % 2 == 0 { &alice } else { &bob };
        ids.push(say(&db, &ch, Some(&root), Some(who), "user", 10 + i).await);
    }
    let mut jobs = Vec::new();
    for (i, id) in ids.into_iter().enumerate() {
        let db = db.clone();
        let (ch, root) = (ch.clone(), root.clone());
        let who = if i % 2 == 0 {
            bob.clone()
        } else {
            alice.clone()
        };
        jobs.push(tokio::spawn(async move {
            let mut tx = db.begin().await?;
            sqlx::query("update message set deleted_at = now() where id = $1::uuid")
                .bind(&id)
                .execute(&mut *tx)
                .await?;
            sqlx::query_scalar::<_, String>(INSERT_REPLY)
                .bind(&ch)
                .bind(&root)
                .bind(&who)
                .bind(100f64 + i as f64)
                .fetch_one(&mut *tx)
                .await?;
            tx.commit().await
        }));
    }
    for j in jobs {
        j.await
            .unwrap()
            .expect("넣기·지우기 동시 tx 가 실패했다(교착?)");
    }
    let s = same(&db, &root, "넣기·지우기 동시").await;
    assert_eq!((s.0, s.1, s.3.len()), (21, 21, 2));
}

/// 규모 L1(마이그레이션 198): `thread_state` 에 kind 거르기를 넣은 golden 목록 쿼리가 **거르기 전과 같은 행**을 내는지,
/// 그리고 머리 집계가 새 부분 색인 `message_thread_kind_seq_idx` 를 타는지 본다.
#[tokio::test]
async fn thread_kind_filter_matches_unfiltered() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let db = PgPool::connect(&url).await.unwrap();
    let golden: serde_json::Value =
        serde_json::from_str(include_str!("../golden/sql_fragments.json")).unwrap();
    let new_sql = golden["list_messages_latest"].as_str().unwrap().to_string();
    // 거르기 줄(주석 포함)을 빼면 예전 쿼리다.
    let start = new_sql
        .find("    -- **물음·실패 줄만 훑는다**")
        .expect("thread_state 거르기 주석");
    let filter = "    AND t.meta->>'kind' IN ('ask', 'failure')\n";
    let end = new_sql[start..].find(filter).expect("thread_state 거르기") + start + filter.len();
    let old_sql = format!("{}{}", &new_sql[..start], &new_sql[end..]);
    assert_ne!(old_sql, new_sql);

    let alice = one(&db, "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text", "tk_alice").await;
    let bot = one(
        &db,
        "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
        "tk_bot",
    )
    .await;
    let ch = one(
        &db,
        "insert into channel(name, kind) values ($1, 'standard') returning id::text",
        "thread-kind-rs",
    )
    .await;
    let mut at = 0;
    let mut put = |root: Option<String>, author: String, kind: &'static str, meta: String| {
        at += 1;
        let db = db.clone();
        let ch = ch.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "insert into message(channel_id, thread_root_id, author_id, body, kind, meta, created_at) \
                 values ($1::uuid, $2::uuid, $3::uuid, 'x', $4, $5::jsonb, timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => $6)) \
                 returning id::text",
            )
            .bind(&ch)
            .bind(root)
            .bind(author)
            .bind(kind)
            .bind(meta)
            .bind(at as f64)
            .fetch_one(&db)
            .await
            .unwrap()
        }
    };
    let ask_acc = |to: &str| {
        format!(r#"{{"kind":"ask","ask":{{"to":{{"kind":"account","accountId":"{to}"}}}}}}"#)
    };
    let ask_human = r#"{"kind":"ask","ask":{"to":{"kind":"human"}}}"#.to_string();

    // 뿌리 자신이 물음인 스레드.
    let r_ask = put(None, bot.clone(), "user", ask_acc(&alice)).await;
    put(Some(r_ask.clone()), alice.clone(), "user", "{}".into()).await;
    // 여러 kind 가 섞인 긴 스레드.
    let root = put(None, alice.clone(), "user", "{}".into()).await;
    for _ in 0..5 {
        put(Some(root.clone()), bot.clone(), "user", "{}".into()).await;
    }
    put(Some(root.clone()), bot.clone(), "user", ask_acc(&alice)).await;
    put(Some(root.clone()), bot.clone(), "user", ask_human.clone()).await;
    put(
        Some(root.clone()),
        bot.clone(),
        "user",
        r#"{"kind":"ask","ask":{"to":{"kind":"human"},"answeredWith":"a"}}"#.into(),
    )
    .await;
    put(
        Some(root.clone()),
        bot.clone(),
        "user",
        r#"{"kind":"ask","ask":{"to":{"kind":"human"},"closedAt":"2026-01-01T00:00:00Z"}}"#.into(),
    )
    .await;
    put(
        Some(root.clone()),
        bot.clone(),
        "user",
        r#"{"kind":"failure","failure":{"code":"x"}}"#.into(),
    )
    .await;
    put(Some(root.clone()), bot.clone(), "progress", "{}".into()).await;
    put(Some(root.clone()), bot.clone(), "user", format!(r#"{{"kind":"failure","failure":{{"code":"account_gate","awaitingAccountId":"{alice}"}}}}"#)).await;
    put(
        Some(root.clone()),
        alice.clone(),
        "user",
        format!(r#"{{"kind":"delegation","delegation":{{"open":["{bot}"]}}}}"#),
    )
    .await;
    put(
        Some(root.clone()),
        bot.clone(),
        "user",
        r#"{"kind":"report"}"#.into(),
    )
    .await;
    let gone = put(Some(root.clone()), bot.clone(), "user", ask_human.clone()).await;
    sqlx::query("update message set deleted_at = now() where id = $1::uuid")
        .bind(&gone)
        .execute(&db)
        .await
        .unwrap();
    put(Some(root.clone()), alice.clone(), "system", "{}".into()).await;
    // 답글 없는 뿌리.
    put(None, alice.clone(), "user", "{}".into()).await;

    let rows = |sql: String| {
        let db = db.clone();
        let ch = ch.clone();
        async move {
            sqlx::query_scalar::<_, String>(sqlx::AssertSqlSafe(format!(
                "select row_to_json(x)::text from ({sql}) x order by x.seq"
            )))
            .bind(&ch)
            .bind(100_i64)
            .fetch_all(&db)
            .await
            .unwrap()
        }
    };
    let new_rows = rows(new_sql.clone()).await;
    let old_rows = rows(old_sql).await;
    assert_eq!(new_rows.len(), 19, "넣은 줄 전부(지운 답글 포함)");
    assert_eq!(new_rows, old_rows, "kind 거르기 뒤 목록이 예전과 다르다");
    // 집계가 실제로 무언가를 셌는지(빈 값끼리 같아서 통과하지 않게).
    let long = new_rows.iter().find(|r| r.contains(&root)).unwrap();
    assert!(long.contains(r#""openAskHumanCount":1"#), "{long}");
    assert!(long.contains(r#""failureCount":2"#), "{long}");
    assert!(
        long.contains(&format!(r#""openAskAccountIds":["{alice}"]"#)),
        "{long}"
    );

    // 플래너가 새 부분 색인을 고르는지. 표가 작아 그냥 두면 아무 색인이나 통째로 훑는다 — 운영의 큰 스레드에서처럼
    // 비트맵(id OR thread_root_id)으로 찾게 하고, 그 갈래에서 답글 전체 색인(062)이 아니라 kind 부분 색인을 고르는지 본다.
    let mut conn = db.acquire().await.unwrap();
    for set in [
        "analyze message",
        "set enable_seqscan = off",
        "set enable_indexscan = off",
    ] {
        sqlx::query(set).execute(&mut *conn).await.unwrap();
    }
    let plan: Vec<String> = sqlx::query_scalar(sqlx::AssertSqlSafe(format!("explain {new_sql}")))
        .bind(&ch)
        .bind(100_i64)
        .fetch_all(&mut *conn)
        .await
        .unwrap();
    let plan = plan.join("\n");
    assert!(
        plan.contains("message_thread_kind_seq_idx"),
        "머리 집계가 kind 부분 색인을 타지 않는다:\n{plan}"
    );
}
