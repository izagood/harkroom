//! I2a 잡은 기록 — 자격(허용 표·회수·개인 자격증명)·순서·한 작업 한 줄·임대 갱신·만료 뒤 다시 잡기를 실제 스키마에서 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 잡기·갱신·놓기는 그 역할(`WORK_CLAIM_PRIVILEGES` 만 더 가진 쓰기 역할)로 한다.
//! 스위치 읽기는 단위 시험이 본다 — 여기서는 스위치 값을 인자로 넘긴다.
use harkroom_server::core::work_claim::{
    Refusal, ReleaseReason, WORK_CLAIM_PRIVILEGES, claim_next_with, note_turn_with, release_with,
    renew_with,
};
use sqlx::PgPool;

struct Db {
    admin: PgPool,
    w: PgPool,
}

async fn db() -> Option<Db> {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return None;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let w = PgPool::connect(&write_url).await.unwrap();
    let missing = harkroom_server::write::missing_in(&w, WORK_CLAIM_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "{missing:?}");
    Some(Db { admin, w })
}

async fn account(admin: &PgPool, kind: &str, handle: &str) -> String {
    sqlx::query_scalar(
        "insert into account (kind, handle, display_name, login_id) \
         values ($1, $2, $2, case when $1 = 'human' then $2 end) returning id::text",
    )
    .bind(kind)
    .bind(handle)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn operator(admin: &PgPool, owner: &str, name: &str) -> String {
    sqlx::query_scalar(
        "insert into operator (owner_account_id, name, token_hash) values ($1::uuid, $2, $2) returning id::text",
    )
    .bind(owner)
    .bind(name)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn allow(admin: &PgPool, agent: &str, op: &str) {
    sqlx::query(
        "insert into agent_operator_allow (agent_id, operator_id) values ($1::uuid, $2::uuid)",
    )
    .bind(agent)
    .bind(op)
    .execute(admin)
    .await
    .unwrap();
}

/// 채널과 뿌리 글 하나. 돌려주는 것은 (채널, 뿌리 글).
async fn thread(admin: &PgPool, by: &str, name: &str) -> (String, String) {
    let channel: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility, created_by) values ($1, 'standard', 'public', $2::uuid) returning id::text",
    )
    .bind(name)
    .bind(by)
    .fetch_one(admin)
    .await
    .unwrap();
    let root: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'root', 'user') returning id::text",
    )
    .bind(&channel)
    .bind(by)
    .fetch_one(admin)
    .await
    .unwrap();
    (channel, root)
}

/// 뿌리 작업 하나. `age_min` 분 전에 만든 것으로 적는다(순서를 정하려고).
async fn work(
    admin: &PgPool,
    (channel, root): &(String, String),
    assignee: Option<&str>,
    requester: Option<&str>,
    state: &str,
    age_min: i32,
) -> String {
    sqlx::query_scalar(
        "insert into work (id, channel_id, thread_root_id, root_id, assignee_account_id, requester_account_id, state, \
                           closed_at, created_at) \
         select g.id, $1::uuid, $2::uuid, g.id, $3::uuid, $4::uuid, $5::text, \
                case when $5::text in ('done', 'failed', 'canceled') then now() end, \
                now() - make_interval(mins => $6::int) \
           from (select gen_random_uuid() as id) g returning id::text",
    )
    .bind(channel)
    .bind(root)
    .bind(assignee)
    .bind(requester)
    .bind(state)
    .bind(age_min)
    .fetch_one(admin)
    .await
    .unwrap()
}

/// `parent` 밑의 하위 작업(같은 뿌리). 경로·앞 작업을 줄 수 있다.
async fn child(
    admin: &PgPool,
    (channel, root): &(String, String),
    parent: &str,
    assignee: &str,
    paths: &[&str],
    after: Option<&str>,
    age_min: i32,
) -> String {
    let paths: Vec<String> = paths.iter().map(|s| s.to_string()).collect();
    sqlx::query_scalar(
        "insert into work (channel_id, thread_root_id, parent_id, root_id, assignee_account_id, state, paths, \
                           after_work_id, created_at) \
         values ($1::uuid, $2::uuid, $3::uuid, $3::uuid, $4::uuid, 'open', $5::text[], $6::uuid, \
                 now() - make_interval(mins => $7::int)) returning id::text",
    )
    .bind(channel)
    .bind(root)
    .bind(parent)
    .bind(assignee)
    .bind(&paths)
    .bind(after)
    .bind(age_min)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn next(db: &Db, op: &str) -> Option<String> {
    claim_next_with(&db.w, true, op, 0, None, None)
        .await
        .unwrap()
        .unwrap()
        .map(|c| c.work_id)
}

async fn expire(admin: &PgPool, work_id: &str) {
    sqlx::query("update work_claim set lease_expires_at = now() - interval '1 second' where work_id = $1::uuid")
        .bind(work_id)
        .execute(admin)
        .await
        .unwrap();
}

#[tokio::test]
async fn eligibility_and_order() {
    let Some(db) = db().await else { return };
    let a = &db.admin;
    let owner = account(a, "human", "wc1-owner").await;
    let stranger = account(a, "human", "wc1-stranger").await;
    let agent = account(a, "agent", "wc1-agent").await;
    let personal = account(a, "agent", "wc1-personal").await;
    let unlisted = account(a, "agent", "wc1-unlisted").await;
    let own_op = operator(a, &owner, "wc1-own").await;
    let foreign_op = operator(a, &stranger, "wc1-foreign").await;
    let revoked_op = operator(a, &owner, "wc1-revoked").await;
    sqlx::query("update operator set revoked_at = now() where id = $1::uuid")
        .bind(&revoked_op)
        .execute(a)
        .await
        .unwrap();
    sqlx::query(
        "insert into agent_config (account_id, owner_account_id, credential_scope) values ($1::uuid, $2::uuid, 'personal') \
         on conflict (account_id) do update set owner_account_id = excluded.owner_account_id, credential_scope = 'personal'",
    )
    .bind(&personal)
    .bind(&owner)
    .execute(a)
    .await
    .unwrap();
    for (ag, op) in [
        (&agent, &own_op),
        (&agent, &revoked_op),
        (&personal, &own_op),
        (&personal, &foreign_op),
    ] {
        allow(a, ag, op).await;
    }
    let t = thread(a, &owner, "wc1-ch").await;

    // 스위치가 꺼져 있으면 아무것도 적지 않는다.
    let old_agent_work = work(a, &t, Some(&agent), Some(&agent), "open", 30).await;
    let off = claim_next_with(&db.w, false, &own_op, 0, None, None)
        .await
        .unwrap();
    assert_eq!(off, Err(Refusal::Disabled));
    let rows: i64 = sqlx::query_scalar("select count(*) from work_claim")
        .fetch_one(a)
        .await
        .unwrap();
    assert_eq!(rows, 0);

    // 잡을 수 없는 것들: 담당 없음 · 허용 표에 없는 에이전트 · 이미 도는 작업 · 닫힌 작업.
    work(a, &t, None, Some(&owner), "open", 60).await;
    work(a, &t, Some(&unlisted), Some(&owner), "open", 60).await;
    work(a, &t, Some(&agent), Some(&owner), "running", 60).await;
    work(a, &t, Some(&agent), Some(&owner), "done", 60).await;
    let personal_work = work(a, &t, Some(&personal), Some(&agent), "open", 20).await;
    let human_work = work(a, &t, Some(&agent), Some(&owner), "open", 5).await;

    // 회수된 오퍼레이터는 허용 줄이 있어도 못 잡는다.
    assert_eq!(next(&db, &revoked_op).await, None);
    // 남의 기기는 개인 자격증명 에이전트의 작업을 못 잡는다(허용 줄이 있어도).
    assert_eq!(next(&db, &foreign_op).await, None);
    // 모양이 틀린 id 는 DB 에 닿기 전에 거절된다.
    let bad = claim_next_with(&db.w, true, "not-a-uuid", 0, None, None)
        .await
        .unwrap();
    assert_eq!(bad, Err(Refusal::BadRequest));

    // 좁히기: 목록에 든 에이전트의 작업만.
    let only_personal = claim_next_with(
        &db.w,
        true,
        &own_op,
        7,
        Some(40),
        Some(std::slice::from_ref(&personal)),
    )
    .await
    .unwrap()
    .unwrap()
    .expect("personal work");
    assert_eq!(only_personal.work_id, personal_work);
    assert_eq!(only_personal.agent_id, personal);
    assert_eq!(only_personal.channel_id, t.0);
    assert_eq!(only_personal.thread_root_id, t.1);
    assert_eq!(only_personal.attempts, 1);
    let (gen_, mode, secs): (i64, String, f64) = sqlx::query_as(
        "select slot_generation, mode, extract(epoch from lease_expires_at - claimed_at)::float8 \
           from work_claim where work_id = $1::uuid",
    )
    .bind(&personal_work)
    .fetch_one(a)
    .await
    .unwrap();
    assert_eq!((gen_, mode.as_str()), (7, "pull"));
    assert!((39.0..=41.0).contains(&secs), "{secs}");

    // 순서: 사람이 시킨 작업이 더 늦게 생겼어도 먼저, 그다음 오래된 순.
    assert_eq!(next(&db, &own_op).await, Some(human_work));
    assert_eq!(next(&db, &own_op).await, Some(old_agent_work));
    assert_eq!(next(&db, &own_op).await, None);
}

#[tokio::test]
async fn lease_renew_release_and_takeover() {
    let Some(db) = db().await else { return };
    let a = &db.admin;
    let owner = account(a, "human", "wc2-owner").await;
    let agent = account(a, "agent", "wc2-agent").await;
    let op1 = operator(a, &owner, "wc2-op1").await;
    let op2 = operator(a, &owner, "wc2-op2").await;
    allow(a, &agent, &op1).await;
    allow(a, &agent, &op2).await;
    let t = thread(a, &owner, "wc2-ch").await;
    let w1 = work(a, &t, Some(&agent), Some(&owner), "open", 10).await;
    let w2 = work(a, &t, Some(&agent), Some(&owner), "open", 5).await;

    assert_eq!(next(&db, &op1).await, Some(w1.clone()));
    assert_eq!(next(&db, &op2).await, Some(w2.clone()));
    assert_eq!(next(&db, &op1).await, None);

    // 갱신은 내 줄만, 내가 말한 작업만.
    let renewed = renew_with(&db.w, true, &op1, Some(300), &[w1.clone(), w2.clone()])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renewed, vec![w1.clone()]);
    assert_eq!(
        renew_with(&db.w, false, &op1, None, std::slice::from_ref(&w1))
            .await
            .unwrap(),
        Err(Refusal::Disabled)
    );
    // 남의 줄은 못 놓고, 턴도 못 적는다.
    let turn = "00000000-0000-4000-8000-0000000000aa";
    assert!(
        !release_with(&db.w, true, &op1, &w2, ReleaseReason::Released)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(
        !note_turn_with(&db.w, true, &op1, &w2, turn)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(
        note_turn_with(&db.w, true, &op2, &w2, turn)
            .await
            .unwrap()
            .unwrap()
    );

    // 임대가 끝나면 판으로 돌아간다 — 다른 기기가 같은 줄을 이어 잡고 횟수가 오른다.
    expire(a, &w1).await;
    assert!(
        renew_with(&db.w, true, &op1, None, std::slice::from_ref(&w1))
            .await
            .unwrap()
            .unwrap()
            .is_empty(),
        "끝난 임대는 갱신되지 않는다"
    );
    let again = claim_next_with(&db.w, true, &op2, 3, None, None)
        .await
        .unwrap()
        .unwrap()
        .expect("expired work returns to the board");
    assert_eq!((again.work_id.as_str(), again.attempts), (w1.as_str(), 2));
    // 옛 주인은 이제 놓을 수도 없다.
    assert!(
        !release_with(&db.w, true, &op1, &w1, ReleaseReason::Done)
            .await
            .unwrap()
            .unwrap()
    );
    let (holder, turn_id): (String, Option<String>) = sqlx::query_as(
        "select operator_id::text, turn_id::text from work_claim where work_id = $1::uuid",
    )
    .bind(&w1)
    .fetch_one(a)
    .await
    .unwrap();
    assert_eq!(holder, op2);
    assert_eq!(turn_id, None);

    // 스스로 놓으면 바로 다시 잡을 수 있다. 작업이 닫혔으면 다시 잡히지 않는다.
    assert!(
        release_with(&db.w, true, &op2, &w2, ReleaseReason::Released)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(
        release_with(&db.w, true, &op2, &w1, ReleaseReason::Done)
            .await
            .unwrap()
            .unwrap()
    );
    sqlx::query("update work set state = 'done', closed_at = now() where id = $1::uuid")
        .bind(&w1)
        .execute(a)
        .await
        .unwrap();
    assert_eq!(next(&db, &op1).await, Some(w2.clone()));
    assert_eq!(next(&db, &op1).await, None);
    let rows: i64 = sqlx::query_scalar("select count(*) from work_claim")
        .fetch_one(a)
        .await
        .unwrap();
    assert_eq!(rows, 2, "작업마다 한 줄");
}

#[tokio::test]
async fn predecessor_path_overlap_and_concurrent_claims() {
    let Some(db) = db().await else { return };
    let a = &db.admin;
    let owner = account(a, "human", "wc3-owner").await;
    let agent = account(a, "agent", "wc3-agent").await;
    let op = operator(a, &owner, "wc3-op").await;
    allow(a, &agent, &op).await;
    let t = thread(a, &owner, "wc3-ch").await;
    // 뿌리는 도는 중(잡히지 않는다). 그 밑에 조각 셋: 첫 조각, 첫 조각과 경로가 겹치는 조각, 첫 조각 뒤에 오는 조각.
    let root = work(a, &t, Some(&agent), Some(&owner), "running", 60).await;
    let first = child(a, &t, &root, &agent, &["src/a.rs", "src/b.rs"], None, 30).await;
    let overlap = child(a, &t, &root, &agent, &["src/b.rs"], None, 20).await;
    let after = child(a, &t, &root, &agent, &["docs/x.md"], Some(&first), 10).await;

    assert_eq!(next(&db, &op).await, Some(first.clone()));
    // 겹치는 경로는 첫 조각이 쥐어진 동안 기다리고, 뒤 조각은 앞 작업이 닫힐 때까지 기다린다.
    assert_eq!(next(&db, &op).await, None);
    // 앞 작업이 닫히면 뒤 조각이 풀린다(첫 조각의 줄은 아직 살아 있어 겹치는 조각은 계속 기다린다).
    sqlx::query("update work set state = 'done', closed_at = now() where id = $1::uuid")
        .bind(&first)
        .execute(a)
        .await
        .unwrap();
    assert_eq!(next(&db, &op).await, Some(after));
    assert_eq!(
        next(&db, &op).await,
        None,
        "경로가 겹치는 줄이 아직 살아 있다"
    );
    assert!(
        release_with(&db.w, true, &op, &first, ReleaseReason::Done)
            .await
            .unwrap()
            .unwrap()
    );
    assert_eq!(next(&db, &op).await, Some(overlap));

    // 겹쳐 잡기: 작업 셋에 여덟이 동시에 덤벼도 작업마다 한 번만 잡힌다.
    let t2 = thread(a, &owner, "wc3-ch2").await;
    let mut fresh = Vec::new();
    for i in 0..3 {
        fresh.push(work(a, &t2, Some(&agent), Some(&owner), "open", i).await);
    }
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let (w, op) = (db.w.clone(), op.clone());
        tasks.push(tokio::spawn(async move {
            claim_next_with(&w, true, &op, 0, None, None)
                .await
                .unwrap()
                .unwrap()
                .map(|c| c.work_id)
        }));
    }
    let mut got = Vec::new();
    for t in tasks {
        if let Some(id) = t.await.unwrap() {
            got.push(id);
        }
    }
    got.sort();
    fresh.sort();
    assert!(
        got.windows(2).all(|p| p[0] != p[1]),
        "같은 작업이 두 번 잡혔다: {got:?}"
    );
    assert!(got.iter().all(|g| fresh.contains(g)), "{got:?}");
    // 진 쪽이 빈손으로 돌아갈 수는 있어도, 남은 작업은 다음 부름이 마저 잡는다.
    while let Some(id) = next(&db, &op).await {
        got.push(id);
    }
    got.sort();
    assert_eq!(got, fresh);
}
