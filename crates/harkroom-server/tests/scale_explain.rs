//! 규모 회귀 시험(M0) — 합성 채널 하나(10만 행, 답글 95%, 답글 수천 개짜리 스레드 여럿, 물음·실패·위임 섞음)에서
//! 목록·스레드·검색 golden 쿼리를 `EXPLAIN (ANALYZE, BUFFERS)` 로 재고, **읽은 버퍼 수(shared hit + read)** 가
//! 쿼리별 상한을 넘으면 빨개진다. 시간은 기계마다 흔들려서 게이트로 쓰지 않는다 — 버퍼 수는 같은 데이터·같은 계획이면
//! 거의 그대로다. 줄마다 그 스레드 답글을 전부 훑는 쿼리가 다시 생기면 버퍼 수가 수십 배로 뛰어 여기서 잡힌다.
//!
//! 상한은 실측의 약 2~3배다. 쿼리를 일부러 무겁게 바꿨거나(새 집계 등) 색인으로 가볍게 만들었으면 아래 `BUDGET` 을
//! 새 실측에 맞춰 고친다 — 실측은 `eprintln` 으로 찍힌다(`cargo test --test scale_explain -- --nocapture`).
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다.
use serde_json::Value;
use sqlx::PgPool;

/// 시드 모양.
const ROWS: i64 = 100_000;
/// 뿌리 수(5%) — 나머지 95% 가 답글.
const ROOTS: i64 = 5_000;
/// 답글이 몰리는 큰 스레드 자리 수. 답글의 80% 가 `ROOTS - i % BIG` 번째 뿌리로 가는데 `i % 5 <> 0` 이라
/// 그중 16 개에만 실린다 → 큰 스레드 16 개, 각 4,750 개.
const BIG: i64 = 20;

/// 쿼리별 버퍼 상한(shared hit + read 블록 수). 2026-11-27 실측(pg16): latest 11 · beforeFeed 122,444 · threadLatest 7,371 ·
/// threadBefore 107 · has_older 1·3·113 · 검색 2,534·2,481. beforeFeed 가 큰 까닭은 본문 줄마다 그 스레드 답글을 전부 훑는
/// `thread_state`·`thread_open`·`thread_last` LATERAL 이다 — 색인으로 줄이면 여기 상한도 새 실측에 맞춰 내린다.
const BUDGET: &[(&str, i64)] = &[
    ("latest", 40),
    ("beforeFeed", 300_000),
    ("threadLatest", 20_000),
    ("threadBefore", 400),
    ("has_older_channel", 10),
    ("has_older_feed", 10),
    ("has_older_thread", 400),
    ("search_relevance", 7_000),
    ("search_recent", 7_000),
];

fn frag(k: &str) -> String {
    let v: Value = serde_json::from_str(include_str!("../golden/sql_fragments.json")).unwrap();
    v[k].as_str()
        .unwrap_or_else(|| panic!("golden fragment {k}"))
        .to_string()
}

async fn one(pool: &PgPool, sql: &'static str, bind: &str) -> String {
    sqlx::query_scalar(sql)
        .bind(bind)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// 실행계획 맨 위 노드의 shared hit + read 블록 수(아래 노드·CTE·하위 질의를 다 담는다)와 실행 시간(ms).
fn buffers(plan: &Value) -> (i64, f64) {
    // 노드 값은 아래 노드를 담는다 — 그래도 CTE·InitPlan 이 위 노드에 안 잡히는 판이 있을까 봐 모든 노드의 최댓값을 쓴다.
    fn max_node(p: &Value) -> i64 {
        let n = |k: &str| p[k].as_i64().unwrap_or(0);
        let own = n("Shared Hit Blocks") + n("Shared Read Blocks");
        p["Plans"]
            .as_array()
            .map(|c| c.iter().map(max_node).max().unwrap_or(0))
            .unwrap_or(0)
            .max(own)
    }
    let top = &plan[0];
    (
        max_node(&top["Plan"]),
        top["Execution Time"].as_f64().unwrap_or(0.0),
    )
}

#[derive(Clone)]
enum Arg {
    Text(Option<String>),
    Int(i64),
    Bool(Option<bool>),
    TextArr(Option<Vec<String>>),
}

async fn explain(pool: &PgPool, sql: &str, args: &[Arg]) -> (i64, f64) {
    let text = format!("explain (analyze, buffers, format json) {sql}");
    // golden 조각(저장소의 고정 SQL)에 머리말만 붙인다 — 바깥 값은 전부 bind 로 간다.
    let mut q = sqlx::query_scalar::<_, Value>(sqlx::AssertSqlSafe(text));
    for a in args {
        q = match a.clone() {
            Arg::Text(v) => q.bind(v),
            Arg::Int(v) => q.bind(v),
            Arg::Bool(v) => q.bind(v),
            Arg::TextArr(v) => q.bind(v),
        };
    }
    let plan = q.fetch_one(pool).await.unwrap();
    buffers(&plan)
}

fn t(s: &str) -> Arg {
    Arg::Text(Some(s.to_string()))
}

#[tokio::test]
async fn scale_explain_buffers_within_budget() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let db = PgPool::connect(&url).await.unwrap();
    let started = std::time::Instant::now();
    let me = one(&db, "insert into account(handle, display_name, kind, login_id) values ($1, $1, 'human', $1) returning id::text", "sc_human").await;
    let bot = one(
        &db,
        "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
        "sc_bot",
    )
    .await;
    let ch = one(
        &db,
        "insert into channel(name, kind, visibility) values ($1, 'standard', 'public') returning id::text",
        "scale-explain",
    )
    .await;

    // 뿌리 먼저(seq 가 앞선다), 그다음 답글 — 최신 행이 거의 다 답글인 오늘의 모양.
    sqlx::query(
        "insert into message(channel_id, author_id, body, kind, meta, created_at) \
         select $1::uuid, case when i % 2 = 0 then $2::uuid else $3::uuid end, \
           'root ' || i || case when i % 10 = 0 then ' deploy plan' else ' note' end, 'user', '{}', \
           timestamptz '2026-01-01 00:00:00+00' + make_interval(secs => i) \
         from generate_series(1, $4::int8) i order by i",
    )
    .bind(&ch)
    .bind(&me)
    .bind(&bot)
    .bind(ROOTS)
    .execute(&db)
    .await
    .unwrap();
    // 큰 스레드는 **마지막** 뿌리 BIG 자리 — 본문 줄 첫 페이지(최신 뿌리 100개)에 큰 스레드가 끼는 모양. 답글 i 는 80% 가 큰 스레드로, 20% 는 나머지 뿌리에 흩어진다.
    // meta kind: 50 마다 failure, 50+1 마다 물음(ask, 사람에게), 97 마다 위임, 113 마다 askBundle.
    sqlx::query(
        "with roots as (select id, row_number() over (order by seq) as n from message where channel_id = $1::uuid), \
         r as (select i, case when i % 5 <> 0 then $4::int8 - (i % $5::int8) else 1 + ((i * 7919) % ($4::int8 - $5::int8)) end as n \
               from generate_series(1, $6::int8 - $4::int8) i) \
         insert into message(channel_id, thread_root_id, author_id, body, kind, meta, created_at) \
         select $1::uuid, roots.id, case when r.i % 3 = 0 then $2::uuid else $3::uuid end, \
           'reply ' || r.i || case when r.i % 10 = 0 then ' deploy done' else ' ok' end, 'user', \
           case when r.i % 50 = 0 then '{\"kind\":\"failure\"}'::jsonb \
                when r.i % 50 = 1 then jsonb_build_object('kind', 'ask', 'ask', jsonb_build_object('to', jsonb_build_object('kind', 'account', 'accountId', $2::text))) \
                when r.i % 97 = 0 then '{\"kind\":\"delegation\"}'::jsonb \
                when r.i % 113 = 0 then '{\"kind\":\"askBundle\"}'::jsonb \
                else '{}'::jsonb end, \
           timestamptz '2026-01-02 00:00:00+00' + make_interval(secs => r.i) \
         from r join roots on roots.n = r.n order by r.i",
    )
    .bind(&ch)
    .bind(&me)
    .bind(&bot)
    .bind(ROOTS)
    .bind(BIG)
    .bind(ROWS)
    .execute(&db)
    .await
    .unwrap();
    // 지운 줄(soft delete)도 섞는다 — 목록은 「지운 뿌리라도 답글이 남았으면 보인다」를 줄마다 따진다.
    sqlx::query(
        "update message set deleted_at = created_at + interval '1 minute' \
         where channel_id = $1::uuid and seq % 997 = 0",
    )
    .bind(&ch)
    .execute(&db)
    .await
    .unwrap();
    sqlx::query("analyze").execute(&db).await.unwrap();
    let seeded = started.elapsed();

    let (max_seq, big_root, mid_seq): (i64, String, i64) = sqlx::query_as(
        "select (select max(seq)::int8 from message where channel_id = $1::uuid), r.id::text, \
           (select seq::int8 from message where thread_root_id = r.id order by seq offset 1500 limit 1) \
         from message r where r.channel_id = $1::uuid and r.thread_root_id is null \
         order by (select count(*) from message x where x.thread_root_id = r.id) desc, r.seq limit 1",
    )
    .bind(&ch)
    .fetch_one(&db)
    .await
    .unwrap();
    let total: i64 = sqlx::query_scalar("select count(*) from message where channel_id = $1::uuid")
        .bind(&ch)
        .fetch_one(&db)
        .await
        .unwrap();
    let big_replies: i64 =
        sqlx::query_scalar("select count(*) from message where thread_root_id = $1::uuid")
            .bind(&big_root)
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(total, ROWS, "시드 행 수");
    assert!(big_replies >= 3_000, "큰 스레드 답글 {big_replies}");

    let search = |q: &str| {
        vec![
            t(q),
            Arg::Int(51),
            t(&me),
            t(&ch),
            Arg::Text(None),
            Arg::Int(0),
            Arg::TextArr(None),
            Arg::Text(None),
            Arg::Text(None),
            Arg::Bool(None),
        ]
    };
    let cases: Vec<(&str, String, Vec<Arg>)> = vec![
        (
            "latest",
            frag("list_messages_latest"),
            vec![t(&ch), Arg::Int(50)],
        ),
        (
            "beforeFeed",
            frag("list_messages_beforeFeed"),
            vec![t(&ch), Arg::Int(max_seq + 1), Arg::Int(100)],
        ),
        (
            "threadLatest",
            frag("list_messages_threadLatest"),
            vec![t(&ch), t(&big_root), Arg::Int(200)],
        ),
        (
            "threadBefore",
            frag("list_messages_threadBefore"),
            vec![t(&ch), t(&big_root), Arg::Int(mid_seq), Arg::Int(200)],
        ),
        (
            "has_older_channel",
            frag("has_older_channel"),
            vec![t(&ch), Arg::Int(max_seq - 50)],
        ),
        (
            "has_older_feed",
            frag("has_older_feed"),
            vec![t(&ch), Arg::Int(max_seq - 50)],
        ),
        (
            "has_older_thread",
            frag("has_older_thread"),
            vec![t(&ch), t(&big_root), Arg::Int(mid_seq)],
        ),
        (
            "search_relevance",
            frag("search_messages_relevance"),
            search("deploy"),
        ),
        (
            "search_recent",
            frag("search_messages_recent"),
            search("deploy"),
        ),
    ];

    let mut over = Vec::new();
    eprintln!(
        "scale_explain: rows={total} big_thread_replies={big_replies} seed={:.1}s",
        seeded.as_secs_f64()
    );
    for (name, sql, args) in &cases {
        // 한 번 데워 둔다 — hit/read 비율만 바뀌고 합은 같지만, 시간 참고값이 덜 흔들린다.
        explain(&db, sql, args).await;
        let (b, ms) = explain(&db, sql, args).await;
        let cap = BUDGET
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, c)| *c)
            .unwrap_or_else(|| panic!("BUDGET 에 {name} 이 없다"));
        eprintln!("scale_explain: {name:<18} buffers={b:>8} cap={cap:>8} time={ms:.1}ms");
        if b > cap {
            over.push(format!("{name}: {b} > {cap}"));
        }
    }
    eprintln!(
        "scale_explain: total {:.1}s",
        started.elapsed().as_secs_f64()
    );
    assert!(over.is_empty(), "버퍼 상한을 넘은 쿼리: {over:?}");
}
