//! Rust 릴레이의 세션 사본·presence 쓰기(C6c-3, `core/relay_live.rs`)를 실제 Postgres 로 — security C6c r1a·r1b·r2·r3.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `bus-e2e` 잡이 `packages/server/test/rustFrontDb.test.ts` 로 DB 를 넘긴다).
//! 쓰기 풀은 `HARKROOM_TEST_WRITE_DATABASE_URL`(있으면 `OPERATOR_PRIVILEGES` 만 가진 역할)이다 — 표가 모자라면 여기서 빨개진다(r3).
use harkroom_server::core::relay_live::{LiveOpts, PresenceMark, SessionLive};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

async fn account(admin: &PgPool, handle: &str, kind: &str) -> String {
    sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id) values ($1, 'Some Person', $2, case when $2 = 'human' then $1 end) returning id::text",
    )
    .bind(handle)
    .bind(kind)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn rows(admin: &PgPool, agent: &str) -> Vec<(String, String, String)> {
    sqlx::query_as(
        "select session_id, hub_epoch::text, operator_id::text from agent_session_live
          where agent_account_id = $1::uuid order by session_id",
    )
    .bind(agent)
    .fetch_all(admin)
    .await
    .unwrap()
}

fn session(id: &str, ch: &str, thread: Option<&str>) -> Value {
    json!({
        "sessionId": id, "channelId": ch, "threadRootId": thread, "harness": "claude", "mode": "mention",
        "startedAt": "2026-11-16T04:00:00.000Z", "claudePoolName": "Some Person", "viewKey": "secret-key",
    })
}

fn opts(epoch: Option<String>, errors: Arc<Mutex<Vec<String>>>) -> LiveOpts {
    LiveOpts {
        beat: Duration::from_secs(3600),
        ttl_sec: 90,
        epoch,
        on_error: Arc::new(move |what, _| errors.lock().unwrap().push(what.to_owned())),
    }
}

#[tokio::test]
async fn session_live_and_presence_against_real_schema() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let write = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(w) => {
            let w = PgPool::connect(&w).await.unwrap();
            let missing = harkroom_server::write::missing_operator_privileges(&w)
                .await
                .unwrap();
            assert!(missing.is_empty(), "write role missing {missing:?}");
            w
        }
        Err(_) => admin.clone(),
    };
    let tag = format!("rl{}", std::process::id());
    let human = account(&admin, &format!("{tag}-h"), "human").await;
    let agent = account(&admin, &format!("{tag}-a"), "agent").await;
    let other = account(&admin, &format!("{tag}-b"), "agent").await;
    let op: String = sqlx::query_scalar(
        "insert into operator(owner_account_id, name, token_hash) values ($1::uuid, 'op', md5(random()::text)) returning id::text",
    )
    .bind(&human)
    .fetch_one(&admin)
    .await
    .unwrap();
    let op2: String = sqlx::query_scalar(
        "insert into operator(owner_account_id, name, token_hash) values ($1::uuid, 'op2', md5(random()::text)) returning id::text",
    )
    .bind(&human)
    .fetch_one(&admin)
    .await
    .unwrap();
    let ch = |name: String| {
        let admin = admin.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "insert into channel(name, kind, visibility) values ($1, 'standard', 'private') returning id::text",
            )
            .bind(name)
            .fetch_one(&admin)
            .await
            .unwrap()
        }
    };
    let joined = ch(format!("{tag}-in")).await;
    let foreign = ch(format!("{tag}-out")).await;
    for (c, a) in [(&joined, &agent), (&joined, &other), (&foreign, &human)] {
        sqlx::query(
            "insert into channel_member(channel_id, account_id) values ($1::uuid, $2::uuid)",
        )
        .bind(c)
        .bind(a)
        .execute(&admin)
        .await
        .unwrap();
    }
    let msg = |c: String| {
        let admin = admin.clone();
        let human = human.clone();
        async move {
            sqlx::query_scalar::<_, String>(
                "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'hi', 'user') returning id::text",
            )
            .bind(c)
            .bind(human)
            .fetch_one(&admin)
            .await
            .unwrap()
        }
    };
    let root_in = msg(joined.clone()).await;
    let root_out = msg(foreign.clone()).await;

    let errors = Arc::new(Mutex::new(vec![]));
    let live = SessionLive::start(write.clone(), opts(None, errors.clone()))
        .await
        .unwrap();
    let epoch = live.epoch().to_owned();
    let hub_impl: String =
        sqlx::query_scalar("select impl from relay_hub where hub_epoch = $1::uuid")
            .bind(&epoch)
            .fetch_one(&admin)
            .await
            .unwrap();
    assert_eq!(hub_impl, "rust");

    // ---- r2: 멤버인 채널·그 채널의 스레드만 쓴다 ----
    live.started(&op, &agent, &session("s-ok", &joined, Some(&root_in)));
    live.started(&op, &agent, &session("s-foreign-ch", &foreign, None));
    live.started(
        &op,
        &agent,
        &session("s-foreign-thread", &joined, Some(&root_out)),
    );
    live.flush().await;
    let r = rows(&admin, &agent).await;
    assert_eq!(
        r,
        vec![("s-ok".into(), epoch.clone(), op.clone())],
        "r2 membership"
    );
    // ① 이름·키 문자열이 행 어디에도 없다.
    let dump: String = sqlx::query_scalar(
        "select row_to_json(l)::text from agent_session_live l where session_id = 's-ok'",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(
        !dump.contains("Some Person") && !dump.contains("secret-key"),
        "{dump}"
    );

    // ---- ①′: 남의 에이전트가 같은 세션 id 를 보내도 주인이 안 바뀐다 ----
    live.started(&op, &other, &session("s-ok", &joined, None));
    live.ended(&other, "s-ok");
    live.flush().await;
    assert_eq!(rows(&admin, &agent).await.len(), 1);
    assert!(rows(&admin, &other).await.is_empty());

    // ---- r1a: 쓸린 뒤 되살릴 때 다른 허브로 옮겨 간 행은 덮지 않는다 ----
    live.started(&op, &agent, &session("s-moved", &joined, None));
    live.flush().await;
    sqlx::query("delete from relay_hub where hub_epoch = $1::uuid")
        .bind(&epoch)
        .execute(&admin)
        .await
        .unwrap();
    assert!(rows(&admin, &agent).await.is_empty(), "cascade");
    // 멈춘 사이 러너가 다른 허브(op2)로 옮겨 가 그 허브가 s-moved 를 썼다.
    let other_hub: String = sqlx::query_scalar(
        "insert into relay_hub (hub_epoch, impl) values (gen_random_uuid(), 'ts') returning hub_epoch::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    sqlx::query(
        "insert into agent_session_live (session_id, agent_account_id, operator_id, channel_id, harness, hub_epoch)
         values ('s-moved', $1::uuid, $2::uuid, $3::uuid, 'claude', $4::uuid)",
    )
    .bind(&agent)
    .bind(&op2)
    .bind(&joined)
    .bind(&other_hub)
    .execute(&admin)
    .await
    .unwrap();
    assert_eq!(live.beat_once().await, Ok(true), "revived");
    assert_eq!(
        rows(&admin, &agent).await,
        vec![
            ("s-moved".into(), other_hub.clone(), op2.clone()),
            ("s-ok".into(), epoch.clone(), op.clone()),
        ],
        "r1a: s-ok 은 다시 쓰고 s-moved 는 덮지 않는다"
    );
    assert_eq!(
        live.beat_once().await,
        Ok(false),
        "살아 있을 때 박동은 새로 넣지 않는다"
    );

    // r1b 는 아래 `failed_rewrite_is_retried_next_beat` 가 권한을 잠시 거둬 본다.

    // ---- presence: 프레임이 오면 agent_presence 에 쓰고, 처음이면 online ----
    let online = Arc::new(Mutex::new(vec![]));
    let o = online.clone();
    let p = PresenceMark::with_timing(
        write.clone(),
        Duration::from_secs(30),
        Duration::from_secs(10),
        Some(Arc::new(move |a: &str| {
            o.lock().unwrap().push(a.to_owned())
        })),
        Arc::new(|_, e| panic!("presence write failed: {e}")),
    );
    assert!(p.write(&agent).await.unwrap(), "처음은 online");
    assert!(
        !p.write(&agent).await.unwrap(),
        "살아 있으면 online 이 아니다"
    );
    sqlx::query("update agent_presence set expires_at = now() - interval '1 second' where account_id = $1::uuid")
        .bind(&agent)
        .execute(&admin)
        .await
        .unwrap();
    assert!(p.write(&agent).await.unwrap(), "만료 뒤는 다시 online");
    p.mark(&other);
    p.mark(&other); // 10초 묶음 — 두 번째는 쓰지 않는다
    for _ in 0..50 {
        if !online.lock().unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(*online.lock().unwrap(), vec![other.clone()]);
    let alive: bool = sqlx::query_scalar(
        "select expires_at > now() from agent_presence where account_id = $1::uuid",
    )
    .bind(&other)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(alive);

    // ---- runnerGone·announce ----
    live.beat_once().await.unwrap();
    live.replaced(
        &op,
        &agent,
        &[
            session("s-a", &joined, None),
            session("s-ok", &joined, None),
        ],
    );
    live.flush().await;
    let ids: Vec<String> = rows(&admin, &agent)
        .await
        .into_iter()
        .map(|r| r.0)
        .collect();
    assert_eq!(
        ids,
        vec!["s-a", "s-ok"],
        "announce 목록 밖(s-moved)은 지운다"
    );
    live.runner_gone(&op, &agent);
    live.flush().await;
    assert!(rows(&admin, &agent).await.is_empty(), "runnerGone");
    live.beat_once().await.unwrap();
    assert!(
        rows(&admin, &agent).await.is_empty(),
        "runnerGone 뒤는 되살리지 않는다"
    );

    // ---- 쓸기: TTL 넘긴 다른 허브만 ----
    sqlx::query(
        "update relay_hub set seen_at = now() - interval '10 minutes' where hub_epoch = $1::uuid",
    )
    .bind(&other_hub)
    .execute(&admin)
    .await
    .unwrap();
    live.beat_once().await.unwrap();
    let gone: bool = sqlx::query_scalar(
        "select not exists (select 1 from relay_hub where hub_epoch = $1::uuid)",
    )
    .bind(&other_hub)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(gone);

    live.stop().await;
    let left: bool =
        sqlx::query_scalar("select exists (select 1 from relay_hub where hub_epoch = $1::uuid)")
            .bind(&epoch)
            .fetch_one(&admin)
            .await
            .unwrap();
    assert!(!left, "stop 은 자기 허브 줄을 지운다");
}

/// r1b — 다시 쓰기가 실패한 세션은 표시가 남아 다음 박동에 다시 쓰인다. 실패는 채널 멤버 조회 권한을 잠시 빼서 만든다
/// (관리자 풀에서만 — 쓰기 역할이 따로 있을 때 그 역할의 권한을 거뒀다 돌려준다).
#[tokio::test]
async fn failed_rewrite_is_retried_next_beat() {
    let (Ok(url), Ok(wurl)) = (
        std::env::var("HARKROOM_TEST_DATABASE_URL"),
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL"),
    ) else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL / HARKROOM_TEST_WRITE_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    let write = PgPool::connect(&wurl).await.unwrap();
    let role: String = sqlx::query_scalar("select current_user::text")
        .fetch_one(&write)
        .await
        .unwrap();
    let tag = format!("rr{}", std::process::id());
    let human = account(&admin, &format!("{tag}-h"), "human").await;
    let agent = account(&admin, &format!("{tag}-a"), "agent").await;
    let op: String = sqlx::query_scalar(
        "insert into operator(owner_account_id, name, token_hash) values ($1::uuid, 'op', md5(random()::text)) returning id::text",
    )
    .bind(&human)
    .fetch_one(&admin)
    .await
    .unwrap();
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility) values ($1, 'standard', 'private') returning id::text",
    )
    .bind(format!("{tag}-c"))
    .fetch_one(&admin)
    .await
    .unwrap();
    sqlx::query("insert into channel_member(channel_id, account_id) values ($1::uuid, $2::uuid)")
        .bind(&ch)
        .bind(&agent)
        .execute(&admin)
        .await
        .unwrap();

    let errors = Arc::new(Mutex::new(vec![]));
    let live = SessionLive::start(write.clone(), opts(None, errors.clone()))
        .await
        .unwrap();
    let epoch = live.epoch().to_owned();
    live.started(&op, &agent, &session("s1", &ch, None));
    live.flush().await;
    assert_eq!(rows(&admin, &agent).await.len(), 1);

    // 허브 줄이 쓸리고, 되살리는 박동에서 쓰기가 실패한다(INSERT 권한을 잠시 거둔다).
    sqlx::query("delete from relay_hub where hub_epoch = $1::uuid")
        .bind(&epoch)
        .execute(&admin)
        .await
        .unwrap();
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "revoke insert on agent_session_live from {role}"
    )))
    .execute(&admin)
    .await
    .unwrap();
    // pg_read_all_data 로는 INSERT 가 안 된다 — 이 박동의 다시 쓰기는 실패한다.
    assert_eq!(live.beat_once().await, Ok(true));
    assert!(rows(&admin, &agent).await.is_empty());
    assert!(errors.lock().unwrap().iter().any(|w| w == "session_write"));
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "grant insert on agent_session_live to {role}"
    )))
    .execute(&admin)
    .await
    .unwrap();
    // 다음 박동: 줄은 이미 있다(inserted=false) — 그래도 실패 표시가 남아 다시 쓴다.
    assert_eq!(live.beat_once().await, Ok(false));
    assert_eq!(
        rows(&admin, &agent).await,
        vec![("s1".into(), epoch.clone(), op.clone())]
    );

    // 박동 밖의 쓰기(session.started)가 실패해도 같다 — 다음 박동이 다시 쓴다.
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "revoke insert on agent_session_live from {role}"
    )))
    .execute(&admin)
    .await
    .unwrap();
    live.started(&op, &agent, &session("s2", &ch, None));
    live.flush().await;
    assert_eq!(rows(&admin, &agent).await.len(), 1, "s2 는 아직 없다");
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "grant insert on agent_session_live to {role}"
    )))
    .execute(&admin)
    .await
    .unwrap();
    assert_eq!(live.beat_once().await, Ok(false));
    let ids: Vec<String> = rows(&admin, &agent)
        .await
        .into_iter()
        .map(|r| r.0)
        .collect();
    assert_eq!(ids, vec!["s1", "s2"]);
    live.stop().await;
}
