//! 위임 idle 끝 sweep(`loops::mandate_idle`)이 TS `mandateEnd.ts` 의 `endIdleMandates` 와 같은 일을 하는지 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 sweep 은 그 역할(`MANDATE_IDLE_PRIVILEGES` 만 가진 쓰기 역할)로 돈다.
//! - `HARKROOM_MANDATE_IDLE_DUAL=<owner id>` 면 이중 실행 모드 — TS 가 깔아 둔 위임을 TS sweep 과 **동시에** 끝내고
//!   끝낸 수만 찍는다(판정은 TS 쪽).
use harkroom_server::loops::mandate_idle::{
    MANDATE_IDLE_BATCH, MANDATE_IDLE_PRIVILEGES, MANDATE_IDLE_SEQUENCE_PRIVILEGES,
    end_idle_mandates, sweep,
};
use harkroom_server::loops::{GateResult, Side, run_gated};
use serde_json::Value;
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;

async fn open_idle(pool: &PgPool, owner: &str) -> i64 {
    sqlx::query_scalar(
        "select count(*) from mandate where owner_account_id = $1::uuid and ended_at is null \
           and automation_id is null and last_activity_at <= now() - interval '7 days'",
    )
    .bind(owner)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// 위임 하나(뿌리 글 + 위임 + 살아 있는 줄 하나). `age` 는 마지막 활동이 몇 전인지(Postgres interval).
async fn mandate(admin: &PgPool, ch: &str, owner: &str, age: &str) -> String {
    let root: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, '@tm go', 'user') returning id::text",
    )
    .bind(ch)
    .bind(owner)
    .fetch_one(admin)
    .await
    .unwrap();
    let m: String = sqlx::query_scalar(
        "insert into mandate(owner_account_id, delegator_account_id, root_message_id, channel_id, thread_root_id, last_activity_at) \
         values ($1::uuid, $1::uuid, $2::uuid, $3::uuid, $2::uuid, now() - $4::interval) returning id::text",
    )
    .bind(owner)
    .bind(&root)
    .bind(ch)
    .bind(age)
    .fetch_one(admin)
    .await
    .unwrap();
    sqlx::query(
        "insert into mandate_line(mandate_id, cap, scope, granted_by, via) values ($1::uuid, 'tool', 'Bash(git status)', $2::uuid, 'button')",
    )
    .bind(&m)
    .bind(owner)
    .execute(admin)
    .await
    .unwrap();
    m
}

/// 그 위임을 단 권한 카드(요청 + 카드 글). 카드 글 id.
async fn card(admin: &PgPool, ch: &str, agent: &str, m: &str, status: &str) -> String {
    let root: String =
        sqlx::query_scalar("select root_message_id::text from mandate where id = $1::uuid")
            .bind(m)
            .fetch_one(admin)
            .await
            .unwrap();
    let req: String = sqlx::query_scalar(
        "insert into permission_request(agent_id, kind, target, reason, channel_id, thread_root_id, expires_at, mandate_id, status) \
         values ($1::uuid, 'tool', 'Bash(git status)', 'x', $2::uuid, $3::uuid, now() + interval '1 day', $4::uuid, $5) returning id::text",
    )
    .bind(agent)
    .bind(ch)
    .bind(&root)
    .bind(m)
    .bind(status)
    .fetch_one(admin)
    .await
    .unwrap();
    let meta = serde_json::json!({ "permissionRequest": { "requestId": req, "status": status, "mandate": { "id": m, "name": "x" } } });
    let card: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind, meta, thread_root_id) \
         values ($1::uuid, $2::uuid, '카드', 'user', $3, $4::uuid) returning id::text",
    )
    .bind(ch)
    .bind(agent)
    .bind(&meta)
    .bind(&root)
    .fetch_one(admin)
    .await
    .unwrap();
    sqlx::query("update permission_request set card_message_id = $2::uuid where id = $1::uuid")
        .bind(&req)
        .bind(&card)
        .execute(admin)
        .await
        .unwrap();
    card
}

async fn card_mandate(admin: &PgPool, card: &str) -> Value {
    sqlx::query_scalar(
        "select meta->'permissionRequest'->'mandate' from message where id = $1::uuid",
    )
    .bind(card)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn state(admin: &PgPool, m: &str) -> (Option<String>, i64, i64) {
    let reason: Option<String> =
        sqlx::query_scalar("select end_reason from mandate where id = $1::uuid")
            .bind(m)
            .fetch_one(admin)
            .await
            .unwrap();
    let live: i64 = sqlx::query_scalar(
        "select count(*) from mandate_line where mandate_id = $1::uuid and revoked_at is null",
    )
    .bind(m)
    .fetch_one(admin)
    .await
    .unwrap();
    let audits: i64 = sqlx::query_scalar(
        "select count(*) from audit_log where action = 'mandate.ended' and target = $1 and detail = '{\"reason\":\"idle\"}'::jsonb",
    )
    .bind(m)
    .fetch_one(admin)
    .await
    .unwrap();
    (reason, live, audits)
}

#[tokio::test]
async fn mandate_idle_sweep_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let opts = PgConnectOptions::from_str(&write_url)
        .unwrap()
        .application_name("harkroom-mandate-idle-dual");
    let w = PgPoolOptions::new()
        .max_connections(3)
        .connect_with(opts)
        .await
        .unwrap();
    let missing = harkroom_server::write::missing_in(
        &w,
        MANDATE_IDLE_PRIVILEGES,
        MANDATE_IDLE_SEQUENCE_PRIVILEGES,
    )
    .await
    .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    if let Ok(owner) = std::env::var("HARKROOM_MANDATE_IDLE_DUAL") {
        // 기다리지 않는다 — TS 는 이 연결을 보고 시작한다. 한 묶음씩 끝내며 남은 것이 있는 동안 돈 횟수를 센다.
        let mut ended = 0usize;
        let mut overlapped = 0u64;
        loop {
            let before = open_idle(&admin, &owner).await;
            let n = end_idle_mandates(&w).await.unwrap().len();
            ended += n;
            if before > 0 {
                overlapped += 1;
            }
            if n == 0 && open_idle(&admin, &owner).await == 0 {
                break;
            }
        }
        println!("mandate-idle-dual rust ended {ended} overlapped {overlapped}");
        return;
    }

    let owner: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ('mi_owner', 'mi_owner', 'agent') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let agent: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ('mi_tm', 'mi_tm', 'agent') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('mi-rs', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();

    // 끝낼 것: 8일 된 위임(열린 카드·이미 닫힌 카드 하나씩). 남길 것: 6일 된 위임·이미 끝난 위임·8일 된 자동화 위임.
    let old = mandate(&admin, &ch, &owner, "8 days").await;
    let open_card = card(&admin, &ch, &agent, &old, "pending").await;
    let closed_card = card(&admin, &ch, &agent, &old, "granted").await;
    let fresh = mandate(&admin, &ch, &owner, "6 days").await;
    let done = mandate(&admin, &ch, &owner, "9 days").await;
    sqlx::query("update mandate set ended_at = now() - interval '1 day', end_reason = 'owner' where id = $1::uuid")
        .bind(&done)
        .execute(&admin)
        .await
        .unwrap();
    let auto_id: String = sqlx::query_scalar(
        "insert into automation(owner_id, channel_id, name, body, trigger) \
         values ($1::uuid, $2::uuid, 'a', '@mi_tm 점검', '{\"kind\":\"manual\"}') returning id::text",
    )
    .bind(&owner)
    .bind(&ch)
    .fetch_one(&admin)
    .await
    .unwrap();
    let auto: String = sqlx::query_scalar(
        "insert into mandate(owner_account_id, delegator_account_id, automation_id, channel_id, last_activity_at) \
         values ($1::uuid, $1::uuid, $2::uuid, $3::uuid, now() - interval '30 days') returning id::text",
    )
    .bind(&owner)
    .bind(&auto_id)
    .bind(&ch)
    .fetch_one(&admin)
    .await
    .unwrap();
    let outbox_before: i64 = sqlx::query_scalar("select coalesce(max(id), 0) from event_outbox")
        .fetch_one(&admin)
        .await
        .unwrap();

    let ended = end_idle_mandates(&w).await.unwrap();
    assert_eq!(ended, vec![old.clone()]);
    assert_eq!(state(&admin, &old).await, (Some("idle".into()), 0, 1));
    assert_eq!(state(&admin, &fresh).await, (None, 1, 0));
    assert_eq!(state(&admin, &done).await, (Some("owner".into()), 1, 0));
    let auto_reason: Option<String> =
        sqlx::query_scalar("select end_reason from mandate where id = $1::uuid")
            .bind(&auto)
            .fetch_one(&admin)
            .await
            .unwrap();
    assert_eq!(auto_reason, None);

    // 열린 카드에만 endedAt(= 위임의 ended_at, toISOString 꼴) + message.updated 한 줄.
    let m = card_mandate(&admin, &open_card).await;
    let want: String = sqlx::query_scalar(
        "select to_char(ended_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from mandate where id = $1::uuid",
    )
    .bind(&old)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(m["endedAt"], Value::String(want));
    assert_eq!(m["id"], Value::String(old.clone()));
    assert_eq!(m["name"], "x");
    assert!(
        card_mandate(&admin, &closed_card)
            .await
            .get("endedAt")
            .is_none()
    );
    let events: Vec<Value> =
        sqlx::query_scalar("select event from event_outbox where id > $1 order by id")
            .bind(outbox_before)
            .fetch_all(&admin)
            .await
            .unwrap();
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["type"], "message.updated");
    assert_eq!(events[0]["message"]["id"], Value::String(open_card.clone()));

    // 두 번째는 아무것도 안 한다(감사도 한 번, 카드 갱신도 다시 안 한다).
    assert!(end_idle_mandates(&w).await.unwrap().is_empty());
    assert_eq!(state(&admin, &old).await, (Some("idle".into()), 0, 1));
    refresh_is_idempotent(&w, &admin, &old, &open_card).await;

    // 묶음이 꽉 차면 이어 돈다 — 배치 + 5.
    let n = MANDATE_IDLE_BATCH as usize + 5;
    sqlx::query(
        "with r as (insert into message(channel_id, author_id, body, kind) \
                    select $1::uuid, $2::uuid, 'b' || g, 'user' from generate_series(1, $3::int) g returning id) \
         insert into mandate(owner_account_id, delegator_account_id, root_message_id, channel_id, thread_root_id, last_activity_at) \
         select $2::uuid, $2::uuid, r.id, $1::uuid, r.id, now() - interval '8 days' from r",
    )
    .bind(&ch)
    .bind(&owner)
    .bind(n as i32)
    .execute(&admin)
    .await
    .unwrap();
    assert_eq!(open_idle(&admin, &owner).await, n as i64);
    assert_eq!(sweep(&w).await.unwrap(), n);
    assert_eq!(open_idle(&admin, &owner).await, 0);

    // C5 조건 — 문지기 풀과 sweep 풀이 각각 연결 하나뿐이어도 sweep 이 돈다.
    let last = mandate(&admin, &ch, &owner, "8 days").await;
    let one = || {
        PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(3))
            .connect(&write_url)
    };
    let (gate1, work1) = (one().await.unwrap(), one().await.unwrap());
    let r = run_gated(&gate1, "mandate.idle", Side::Rust, || async {
        sweep(&work1).await.map(|_| ())
    })
    .await;
    assert!(matches!(r, GateResult::Ran), "{r:?}");
    assert_eq!(state(&admin, &last).await, (Some("idle".into()), 0, 1));
}

/// 이미 endedAt 이 있는 카드는 다시 고치지 않고 이벤트도 내지 않는다(이중 실행에서 두 쪽이 같은 카드를 만나도 한 번).
async fn refresh_is_idempotent(w: &PgPool, admin: &PgPool, m: &str, card: &str) {
    let before = card_mandate(admin, card).await;
    let outbox: i64 = sqlx::query_scalar("select count(*) from event_outbox")
        .fetch_one(admin)
        .await
        .unwrap();
    harkroom_server::loops::mandate_idle::refresh_mandate_cards(w, &[m.to_owned()]).await;
    assert_eq!(card_mandate(admin, card).await, before);
    let after: i64 = sqlx::query_scalar("select count(*) from event_outbox")
        .fetch_one(admin)
        .await
        .unwrap();
    assert_eq!(after, outbox);
}
