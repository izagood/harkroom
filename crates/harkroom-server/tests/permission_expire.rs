//! 권한 요청 만료 sweep(`loops::permission_expire`)이 TS `permissionRequests.ts` 의 `expirePermissionRequests` 와 같은 일을 하는지
//! 실제 Postgres 로 본다. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 sweep 은 그 역할(`PERMISSION_EXPIRE_PRIVILEGES` 만 가진 쓰기 역할)로 돈다.
//! - `HARKROOM_PERMISSION_EXPIRE_DUAL=<agent id>` 면 이중 실행 모드 — TS 가 깔아 둔 요청을 TS sweep 과 **동시에** 만료하고
//!   만료한 수만 찍는다(판정은 TS 쪽).
use harkroom_server::loops::permission_expire::{
    PERMISSION_EXPIRE_BATCH, PERMISSION_EXPIRE_PRIVILEGES, PERMISSION_EXPIRE_SEQUENCE_PRIVILEGES,
    expire_permission_requests, sweep,
};
use harkroom_server::loops::{GateResult, Side, run_gated};
use serde_json::{Value, json};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;

async fn due(pool: &PgPool, agent: &str) -> i64 {
    sqlx::query_scalar(
        "select count(*) from permission_request where agent_id = $1::uuid and status = 'pending' and expires_at <= now()",
    )
    .bind(agent)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn account(admin: &PgPool, handle: &str) -> String {
    sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
    )
    .bind(handle)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn post(admin: &PgPool, ch: &str, author: &str, meta: Value) -> String {
    sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind, meta) values ($1::uuid, $2::uuid, 'm', 'user', $3) returning id::text",
    )
    .bind(ch)
    .bind(author)
    .bind(meta)
    .fetch_one(admin)
    .await
    .unwrap()
}

/// 요청 하나. `age` 가 양수면 시한이 그만큼 지났다(Postgres interval). `ask` 가 있으면 그 meta.ask 를 단 카드를 붙인다.
async fn request(
    admin: &PgPool,
    ch: &str,
    agent: &str,
    target: &str,
    age: &str,
    ask: Option<Value>,
) -> (String, Option<String>) {
    let root = post(admin, ch, agent, json!({})).await;
    let req: String = sqlx::query_scalar(
        "insert into permission_request(agent_id, kind, target, reason, channel_id, thread_root_id, expires_at) \
         values ($1::uuid, 'tool', $2, 'x', $3::uuid, $4::uuid, now() - $5::interval) returning id::text",
    )
    .bind(agent)
    .bind(target)
    .bind(ch)
    .bind(&root)
    .bind(age)
    .fetch_one(admin)
    .await
    .unwrap();
    let Some(ask) = ask else {
        return (req, None);
    };
    let card = post(
        admin,
        ch,
        agent,
        json!({ "permissionRequest": { "requestId": req, "status": "pending" }, "ask": ask }),
    )
    .await;
    sqlx::query("update permission_request set card_message_id = $2::uuid where id = $1::uuid")
        .bind(&req)
        .bind(&card)
        .execute(admin)
        .await
        .unwrap();
    (req, Some(card))
}

async fn status(admin: &PgPool, req: &str) -> (String, bool) {
    sqlx::query_as(
        "select status, decided_at is not null from permission_request where id = $1::uuid",
    )
    .bind(req)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn meta(admin: &PgPool, id: &str) -> Value {
    sqlx::query_scalar("select meta from message where id = $1::uuid")
        .bind(id)
        .fetch_one(admin)
        .await
        .unwrap()
}

async fn inbox(admin: &PgPool, account: &str, message: &str) -> Vec<String> {
    sqlx::query_scalar(
        "select reason from inbox where account_id = $1::uuid and message_id = $2::uuid order by id",
    )
    .bind(account)
    .bind(message)
    .fetch_all(admin)
    .await
    .unwrap()
}

async fn audits(admin: &PgPool, req: &str) -> i64 {
    sqlx::query_scalar(
        "select count(*) from audit_log where action = 'permission.expired' and actor_id is null and detail = jsonb_build_object('requestId', $1::text)",
    )
    .bind(req)
    .fetch_one(admin)
    .await
    .unwrap()
}

#[tokio::test]
async fn permission_expire_sweep_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let opts = PgConnectOptions::from_str(&write_url)
        .unwrap()
        .application_name("harkroom-permission-expire-dual");
    let w = PgPoolOptions::new()
        .max_connections(3)
        .connect_with(opts)
        .await
        .unwrap();
    let missing = harkroom_server::write::missing_in(
        &w,
        PERMISSION_EXPIRE_PRIVILEGES,
        PERMISSION_EXPIRE_SEQUENCE_PRIVILEGES,
    )
    .await
    .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    if let Ok(agent) = std::env::var("HARKROOM_PERMISSION_EXPIRE_DUAL") {
        // 기다리지 않는다 — TS 는 이 연결을 보고 시작한다.
        let mut expired = 0usize;
        let mut overlapped = 0u64;
        loop {
            let before = due(&admin, &agent).await;
            let n = expire_permission_requests(&w, None).await.unwrap().len();
            expired += n;
            if before > 0 {
                overlapped += 1;
            }
            if n == 0 && due(&admin, &agent).await == 0 {
                break;
            }
        }
        println!("permission-expire-dual rust expired {expired} overlapped {overlapped}");
        return;
    }

    let agent = account(&admin, "pe_agent").await;
    let other = account(&admin, "pe_mirror").await;
    let human = account(&admin, "pe_human").await;
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('pe-rs', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let open_ask = json!({ "question": "q", "options": ["ok"] });

    // A: 시한 지남 + 열린 카드(거울 하나·묶음 하나가 이 카드를 담는다).
    let (a, a_card) = request(
        &admin,
        &ch,
        &agent,
        "Bash(a)",
        "1 minute",
        Some(open_ask.clone()),
    )
    .await;
    let a_card = a_card.unwrap();
    let mirror = post(
        &admin,
        &ch,
        &other,
        json!({ "ask": { "question": "q", "options": ["ok"], "mirrorOf": a_card } }),
    )
    .await;
    let bundle = post(
        &admin,
        &ch,
        &other,
        json!({ "kind": "askBundle", "askBundle": { "items": [{ "rootId": a_card }] } }),
    )
    .await;
    // B: 시한 지남 + 사람이 이미 닫은 카드 — 만료는 되지만 다시 닫거나 깨우지 않는다.
    let (b, b_card) = request(
        &admin, &ch, &agent, "Bash(b)", "1 minute",
        Some(json!({ "question": "q", "options": ["ok"], "closedAt": "2026-01-01T00:00:00.000Z", "closedBy": human, "closedReason": "declined" })),
    )
    .await;
    let b_card = b_card.unwrap();
    // C: 아직 시한 전. D: 시한 지남 + 카드 없음.
    let (c, c_card) = request(
        &admin,
        &ch,
        &agent,
        "Bash(c)",
        "-1 hour",
        Some(open_ask.clone()),
    )
    .await;
    let (d, _) = request(&admin, &ch, &agent, "Bash(d)", "1 minute", None).await;
    let outbox_before: i64 = sqlx::query_scalar("select coalesce(max(id), 0) from event_outbox")
        .fetch_one(&admin)
        .await
        .unwrap();

    let mut got: Vec<String> = expire_permission_requests(&w, None)
        .await
        .unwrap()
        .into_iter()
        .map(|r| r.id)
        .collect();
    got.sort();
    let mut want = vec![a.clone(), b.clone(), d.clone()];
    want.sort();
    assert_eq!(got, want);
    for r in [&a, &b, &d] {
        assert_eq!(status(&admin, r).await, ("expired".into(), true));
        assert_eq!(audits(&admin, r).await, 1);
    }
    assert_eq!(status(&admin, &c).await, ("pending".into(), false));
    assert_eq!(audits(&admin, &c).await, 0);

    // A 카드: 요청 상태 expired·decidedAt(= decided_at, toISOString 꼴), ask 는 만료로 닫힘(닫은 사람 없음).
    let am = meta(&admin, &a_card).await;
    let decided: String = sqlx::query_scalar(
        "select to_char(decided_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') from permission_request where id = $1::uuid",
    )
    .bind(&a)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(am["permissionRequest"]["status"], "expired");
    assert_eq!(
        am["permissionRequest"]["decidedAt"],
        Value::String(decided.clone())
    );
    assert_eq!(
        am["permissionRequest"]["requestId"],
        Value::String(a.clone())
    );
    assert_eq!(am["ask"]["closedAt"], Value::String(decided.clone()));
    assert_eq!(am["ask"]["closedReason"], "expired");
    assert!(am["ask"].get("closedBy").is_none());
    assert_eq!(
        inbox(&admin, &agent, &a_card).await,
        vec!["ask_closed".to_owned()]
    );
    // 거울도 같은 결과로 닫히고(닫은 사람 null) 거울을 낸 쪽을 깨운다.
    let mm = meta(&admin, &mirror).await;
    assert_eq!(mm["ask"]["closedAt"], Value::String(decided));
    assert_eq!(mm["ask"]["closedReason"], "expired");
    assert_eq!(mm["ask"]["closedBy"], Value::Null);
    assert_eq!(
        inbox(&admin, &other, &mirror).await,
        vec!["ask_closed".to_owned()]
    );

    // B 카드: 요청 상태만 expired, 사람이 닫은 ask 는 그대로, 깨움 없음.
    let bm = meta(&admin, &b_card).await;
    assert_eq!(bm["permissionRequest"]["status"], "expired");
    assert_eq!(bm["ask"]["closedReason"], "declined");
    assert_eq!(bm["ask"]["closedBy"], Value::String(human.clone()));
    assert!(inbox(&admin, &agent, &b_card).await.is_empty());
    // C 카드는 손대지 않았다.
    assert_eq!(
        meta(&admin, c_card.as_deref().unwrap()).await["permissionRequest"]["status"],
        "pending"
    );

    // 이벤트 — A 카드·거울·묶음·B 카드의 message.updated, 깨운 둘의 inbox.updated.
    let events: Vec<Value> =
        sqlx::query_scalar("select event from event_outbox where id > $1 order by id")
            .bind(outbox_before)
            .fetch_all(&admin)
            .await
            .unwrap();
    let updated = |id: &str| {
        events
            .iter()
            .filter(|e| e["type"] == "message.updated" && e["message"]["id"] == id)
            .count()
    };
    assert_eq!(updated(&a_card), 1, "{events:?}");
    assert_eq!(updated(&mirror), 1, "{events:?}");
    assert_eq!(updated(&b_card), 1, "{events:?}");
    // 묶음은 A 카드 맞추기 한 번 — B 카드는 담지 않았다.
    assert_eq!(updated(&bundle), 1, "{events:?}");
    let woke: Vec<&Value> = events
        .iter()
        .filter(|e| e["type"] == "inbox.updated")
        .map(|e| &e["accountId"])
        .collect();
    assert_eq!(woke.len(), 2, "{events:?}");
    assert!(woke.contains(&&Value::String(agent.clone())));
    assert!(woke.contains(&&Value::String(other.clone())));

    // 두 번째는 아무것도 안 한다(감사·깨움도 한 번).
    assert!(
        expire_permission_requests(&w, None)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(audits(&admin, &a).await, 1);
    assert_eq!(inbox(&admin, &agent, &a_card).await.len(), 1);
    assert_eq!(inbox(&admin, &other, &mirror).await.len(), 1);

    // request_id 를 주면 그 요청만 — 시한 전이면 손대지 않는다.
    assert!(
        expire_permission_requests(&w, Some(&c))
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(status(&admin, &c).await, ("pending".into(), false));

    // 묶음이 꽉 차면 이어 돈다 — 배치 + 5.
    let n = PERMISSION_EXPIRE_BATCH as usize + 5;
    sqlx::query(
        "insert into permission_request(agent_id, kind, target, reason, channel_id, thread_root_id, expires_at) \
         select $1::uuid, 'tool', 'Bash(n' || g || ')', 'x', $2::uuid, gen_random_uuid(), now() - interval '1 minute' \
           from generate_series(1, $3::int) g",
    )
    .bind(&agent)
    .bind(&ch)
    .bind(n as i32)
    .execute(&admin)
    .await
    .unwrap();
    assert_eq!(due(&admin, &agent).await, n as i64);
    assert_eq!(sweep(&w).await.unwrap(), n);
    assert_eq!(due(&admin, &agent).await, 0);

    // C5 조건 — 문지기 풀과 sweep 풀이 각각 연결 하나뿐이어도 sweep 이 돈다.
    let (last, last_card) = request(
        &admin,
        &ch,
        &agent,
        "Bash(last)",
        "1 minute",
        Some(open_ask),
    )
    .await;
    let one = || {
        PgPoolOptions::new()
            .max_connections(1)
            .acquire_timeout(std::time::Duration::from_secs(3))
            .connect(&write_url)
    };
    let (gate1, work1) = (one().await.unwrap(), one().await.unwrap());
    let r = run_gated(&gate1, "permission.expire", Side::Ts, || async {
        sweep(&work1).await.map(|_| ())
    })
    .await;
    assert!(matches!(r, GateResult::Ran), "{r:?}");
    assert_eq!(status(&admin, &last).await, ("expired".into(), true));
    assert_eq!(
        inbox(&admin, &agent, last_card.as_deref().unwrap()).await,
        vec!["ask_closed".to_owned()]
    );
}
