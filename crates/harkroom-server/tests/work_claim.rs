//! I2a 잡은 기록 — 자격(허용 표·회수·개인 자격증명)·순서·한 작업 한 줄·임대 갱신·만료 뒤 다시 잡기·펜싱(횟수)·갱신 때 자격·
//! 경로가 겹치는 작업의 동시 잡기를 실제 스키마에서 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 잡기·갱신·놓기는 그 역할(`WORK_CLAIM_PRIVILEGES` 만 더 가진 쓰기 역할)로 한다.
//! 스위치 읽기는 단위 시험이 본다 — 여기서는 스위치 값을 인자로 넘긴다.
use harkroom_server::core::work_claim::{
    Held, Refusal, ReleaseReason, WORK_CLAIM_PRIVILEGES, claim_next_with, note_turn_with,
    release_with, renew_with,
};
use sqlx::PgPool;

struct Db {
    admin: PgPool,
    w: PgPool,
    /// 이 파일의 시험은 한 번에 하나만 돈다([`GATE`]).
    _gate: tokio::sync::MutexGuard<'static, ()>,
}

/// 쓰기 역할은 연결 수가 묶여 있다(`scripts/db-tests.sh` 의 `connection limit`). 동시 잡기 시험이 연결을 여럿 쓰므로
/// 시험들이 나란히 돌면 그 한도를 넘는다 — 이 파일의 시험을 한 줄로 세우고 풀 크기도 한도 아래로 둔다.
static GATE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
const WRITE_POOL_MAX: u32 = 6;

async fn db() -> Option<Db> {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return None;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let gate = GATE.lock().await;
    let admin = PgPool::connect(&url).await.unwrap();
    let w = sqlx::postgres::PgPoolOptions::new()
        .max_connections(WRITE_POOL_MAX)
        .connect(&write_url)
        .await
        .unwrap();
    let missing = harkroom_server::write::missing_in(&w, WORK_CLAIM_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "{missing:?}");
    Some(Db {
        admin,
        w,
        _gate: gate,
    })
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

/// 이 시험의 스레드에 딸린 `work_claim` 줄 수. 시험들이 한 DB 를 같이 쓰고 나란히 돌아서, 표 전체를 세면
/// 다른 시험이 적은 줄이 섞인다.
async fn claim_rows(admin: &PgPool, (_, root): &(String, String)) -> i64 {
    sqlx::query_scalar(
        "select count(*) from work_claim c join work w on w.id = c.work_id where w.thread_root_id = $1::uuid",
    )
    .bind(root)
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

/// 임대를 가리키는 짝.
fn held(work_id: &str, attempts: i32) -> Held {
    Held {
        work_id: work_id.to_string(),
        attempts,
    }
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
    let rows = claim_rows(a, &t).await;
    assert_eq!(rows, 0);

    // 잡을 수 없는 것들: 담당 없음 · 허용 표에 없는 에이전트 · 닫힌 작업.
    // (`running`·`waiting` 은 I2d 부터 잡을 수 있다 — `pull_takes_only_work_with_unread_input` 이 본다.)
    work(a, &t, None, Some(&owner), "open", 60).await;
    work(a, &t, Some(&unlisted), Some(&owner), "open", 60).await;
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
    let renewed = renew_with(&db.w, true, &op1, Some(300), &[held(&w1, 1), held(&w2, 1)])
        .await
        .unwrap()
        .unwrap();
    assert_eq!(renewed, vec![w1.clone()]);
    assert_eq!(
        renew_with(&db.w, false, &op1, None, &[held(&w1, 1)])
            .await
            .unwrap(),
        Err(Refusal::Disabled)
    );
    // 남의 줄은 못 놓고, 턴도 못 적는다.
    let turn = "00000000-0000-4000-8000-0000000000aa";
    assert!(
        !release_with(&db.w, true, &op1, &held(&w2, 1), ReleaseReason::Released)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(
        !note_turn_with(&db.w, true, &op1, &held(&w2, 1), turn)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(
        note_turn_with(&db.w, true, &op2, &held(&w2, 1), turn)
            .await
            .unwrap()
            .unwrap()
    );

    // 임대가 끝나면 판으로 돌아간다 — 다른 기기가 같은 줄을 이어 잡고 횟수가 오른다.
    expire(a, &w1).await;
    assert!(
        renew_with(&db.w, true, &op1, None, &[held(&w1, 1)])
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
        !release_with(&db.w, true, &op1, &held(&w1, 2), ReleaseReason::Done)
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
        release_with(&db.w, true, &op2, &held(&w2, 1), ReleaseReason::Released)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(
        release_with(&db.w, true, &op2, &held(&w1, 2), ReleaseReason::Done)
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
    let rows = claim_rows(a, &t).await;
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
        release_with(&db.w, true, &op, &held(&first, 1), ReleaseReason::Done)
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

/// 펜싱: 임대가 끝난 뒤 **같은 기기**가 다시 잡으면 횟수가 오른다. 옛 횟수를 쥔 쪽은 새 줄을 갱신·놓기·턴 적기 할 수 없다.
#[tokio::test]
async fn stale_holder_of_the_same_operator_is_fenced_by_attempts() {
    let Some(db) = db().await else { return };
    let a = &db.admin;
    let owner = account(a, "human", "wc4-owner").await;
    let agent = account(a, "agent", "wc4-agent").await;
    let op = operator(a, &owner, "wc4-op").await;
    allow(a, &agent, &op).await;
    let t = thread(a, &owner, "wc4-ch").await;
    let w = work(a, &t, Some(&agent), Some(&owner), "open", 5).await;

    let first = claim_next_with(&db.w, true, &op, 1, None, None)
        .await
        .unwrap()
        .unwrap()
        .expect("first claim");
    assert_eq!((first.work_id.as_str(), first.attempts), (w.as_str(), 1));
    expire(a, &w).await;
    let second = claim_next_with(&db.w, true, &op, 2, None, None)
        .await
        .unwrap()
        .unwrap()
        .expect("same operator claims again");
    assert_eq!((second.work_id.as_str(), second.attempts), (w.as_str(), 2));

    let turn = "00000000-0000-4000-8000-0000000000bb";
    let (old, new) = (held(&w, 1), held(&w, 2));
    // 옛 임대(횟수 1)는 아무것도 못 한다.
    assert!(
        renew_with(&db.w, true, &op, None, std::slice::from_ref(&old))
            .await
            .unwrap()
            .unwrap()
            .is_empty()
    );
    assert!(
        !note_turn_with(&db.w, true, &op, &old, turn)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(
        !release_with(&db.w, true, &op, &old, ReleaseReason::Failed)
            .await
            .unwrap()
            .unwrap()
    );
    let (released, turn_id): (bool, Option<String>) = sqlx::query_as(
        "select released_at is not null, turn_id::text from work_claim where work_id = $1::uuid",
    )
    .bind(&w)
    .fetch_one(a)
    .await
    .unwrap();
    assert_eq!((released, turn_id), (false, None));
    // 횟수가 0 이하면 DB 에 닿기 전에 거절된다.
    assert_eq!(
        renew_with(&db.w, true, &op, None, &[held(&w, 0)])
            .await
            .unwrap(),
        Err(Refusal::BadRequest)
    );
    // 새 임대(횟수 2)는 다 된다. 옛 짝과 새 짝을 같이 보내면 새 것만 갱신된다.
    assert_eq!(
        renew_with(&db.w, true, &op, None, &[old.clone(), new.clone()])
            .await
            .unwrap()
            .unwrap(),
        vec![w.clone()]
    );
    assert!(
        note_turn_with(&db.w, true, &op, &new, turn)
            .await
            .unwrap()
            .unwrap()
    );
    assert!(
        release_with(&db.w, true, &op, &new, ReleaseReason::Done)
            .await
            .unwrap()
            .unwrap()
    );
}

/// 갱신도 잡을 때와 같은 자격을 본다: 허용 줄이 빠지거나, 기기가 회수되거나, 개인 자격증명 에이전트의 주인이 달라지면 끊긴다.
/// 작업이 닫히거나 담당이 바뀌어도 끊긴다.
#[tokio::test]
async fn renew_rechecks_eligibility() {
    let Some(db) = db().await else { return };
    let a = &db.admin;
    let owner = account(a, "human", "wc5-owner").await;
    let other = account(a, "human", "wc5-other").await;
    let t = thread(a, &owner, "wc5-ch").await;
    // 경우마다 에이전트·기기·작업을 따로 둔다.
    let mut cases = Vec::new();
    let stranger = account(a, "agent", "wc5-agent-stranger").await;
    for name in [
        "allow",
        "revoke",
        "personal",
        "deleted",
        "closed",
        "reassigned",
        "kept",
    ] {
        let agent = account(a, "agent", &format!("wc5-agent-{name}")).await;
        let op = operator(a, &owner, &format!("wc5-op-{name}")).await;
        allow(a, &agent, &op).await;
        let w = work(a, &t, Some(&agent), Some(&owner), "open", 5).await;
        assert_eq!(next(&db, &op).await, Some(w.clone()), "{name}");
        cases.push((name, agent, op, w));
    }
    for (name, agent, op, w) in &cases {
        let renewed = renew_with(&db.w, true, op, None, &[held(w, 1)])
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            renewed,
            vec![w.clone()],
            "{name}: 자격이 있는 동안은 갱신된다"
        );
        match *name {
            "allow" => {
                sqlx::query("delete from agent_operator_allow where agent_id = $1::uuid and operator_id = $2::uuid")
                    .bind(agent)
                    .bind(op)
                    .execute(a)
                    .await
                    .unwrap();
            }
            "revoke" => {
                sqlx::query("update operator set revoked_at = now() where id = $1::uuid")
                    .bind(op)
                    .execute(a)
                    .await
                    .unwrap();
            }
            "personal" => {
                sqlx::query(
                    "insert into agent_config (account_id, owner_account_id, credential_scope) \
                     values ($1::uuid, $2::uuid, 'personal') \
                     on conflict (account_id) do update \
                        set owner_account_id = excluded.owner_account_id, credential_scope = 'personal'",
                )
                .bind(agent)
                .bind(&other)
                .execute(a)
                .await
                .unwrap();
            }
            "deleted" => {
                sqlx::query("update account set deleted_at = now() where id = $1::uuid")
                    .bind(agent)
                    .execute(a)
                    .await
                    .unwrap();
            }
            // 작업이 닫혔다 — 끝난 일의 임대는 늘지 않는다.
            "closed" => {
                sqlx::query(
                    "update work set state = 'done', closed_at = now() where id = $1::uuid",
                )
                .bind(w)
                .execute(a)
                .await
                .unwrap();
            }
            // 담당이 바뀌었다 — 잡을 때의 에이전트가 더는 그 작업의 담당이 아니다.
            "reassigned" => {
                sqlx::query("update work set assignee_account_id = $2::uuid where id = $1::uuid")
                    .bind(w)
                    .bind(&stranger)
                    .execute(a)
                    .await
                    .unwrap();
            }
            _ => {}
        }
        let after = renew_with(&db.w, true, op, None, &[held(w, 1)])
            .await
            .unwrap()
            .unwrap();
        if *name == "kept" {
            assert_eq!(after, vec![w.clone()]);
        } else {
            assert!(after.is_empty(), "{name}: 자격을 잃으면 갱신되지 않는다");
        }
    }
}

/// 경로가 겹치는 작업 여럿에 동시에 덤벼도, 같은 뿌리에서 겹치는 것은 한 번에 하나만 잡힌다(뿌리 잠금).
/// 여러 판을 돌려 창을 넓힌다 — 잠금이 없으면 서로의 아직 안 적힌 줄을 못 봐 둘 이상이 잡힌다.
#[tokio::test]
async fn overlapping_paths_are_never_claimed_together() {
    let Some(db) = db().await else { return };
    let a = &db.admin;
    let owner = account(a, "human", "wc6-owner").await;
    let agent = account(a, "agent", "wc6-agent").await;
    let op = operator(a, &owner, "wc6-op").await;
    allow(a, &agent, &op).await;
    for round in 0..6 {
        let t = thread(a, &owner, &format!("wc6-ch-{round}")).await;
        let root = work(a, &t, Some(&agent), Some(&owner), "running", 60).await;
        // 여섯 조각이 모두 같은 파일을 건드리고, 한 조각은 아무와도 안 겹친다.
        for i in 0..6 {
            let own = format!("src/own-{i}.rs");
            child(a, &t, &root, &agent, &["src/shared.rs", &own], None, i).await;
        }
        let free = child(a, &t, &root, &agent, &["docs/free.md"], None, 0).await;
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
        for task in tasks {
            task.await.unwrap();
        }
        // 뒤에 남은 것을 마저 잡게 해도 겹치는 여섯 가운데 살아 있는 줄은 하나뿐이다.
        while next(&db, &op).await.is_some() {}
        let live: Vec<(String, bool)> = sqlx::query_as(
            "select w.id::text, w.paths && array['src/shared.rs'] from work_claim c join work w on w.id = c.work_id \
              where w.thread_root_id = $1::uuid and c.released_at is null and c.lease_expires_at > now()",
        )
        .bind(&t.1)
        .fetch_all(a)
        .await
        .unwrap();
        let shared = live.iter().filter(|(_, s)| *s).count();
        assert_eq!(
            shared, 1,
            "round {round}: 겹치는 조각이 {shared}개 잡혔다 — {live:?}"
        );
        assert!(
            live.iter().any(|(id, _)| *id == free),
            "round {round}: 안 겹치는 조각은 잡힌다"
        );
        // 다음 판의 후보에 섞이지 않게 이 판의 줄을 모두 놓는다.
        sqlx::query(
            "update work set state = 'canceled', closed_at = now() where thread_root_id = $1::uuid and closed_at is null",
        )
        .bind(&t.1)
        .execute(a)
        .await
        .unwrap();
    }
}

fn frame(v: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
    v.as_object().unwrap().clone()
}

/// I2b 프레임 처리기 — 스레드 좁히기는 후보만 줄이고, 횟수는 받은 값 그대로 돌아가 펜싱에 쓰인다.
#[tokio::test]
async fn frames_narrow_by_thread_and_pass_attempts_through() {
    use harkroom_server::core::work_claim_frames::handle;
    use serde_json::json;
    let Some(db) = db().await else { return };
    let a = &db.admin;
    let owner = account(a, "human", "wc7-owner").await;
    let agent = account(a, "agent", "wc7-agent").await;
    let op = operator(a, &owner, "wc7-op").await;
    let other_op = operator(a, &owner, "wc7-other").await;
    allow(a, &agent, &op).await;
    let t1 = thread(a, &owner, "wc7-ch1").await;
    let t2 = thread(a, &owner, "wc7-ch2").await;
    let old = work(a, &t1, Some(&agent), Some(&owner), "open", 30).await;
    let new = work(a, &t2, Some(&agent), Some(&owner), "open", 5).await;

    // 꺼져 있으면 답만 하고 아무것도 적지 않는다.
    let claim_t2 = frame(json!({
        "type": "work.claim", "requestId": "q1", "slotGeneration": 4, "leaseSecs": 60,
        "agents": [agent], "threadRootId": t2.1,
    }));
    let off = handle(&db.w, false, &op, &claim_t2).await.unwrap();
    assert_eq!(off["error"], "work_claim_disabled");
    assert_eq!(off["requestId"], "q1");
    assert_eq!(claim_rows(a, &t2).await, 0);
    let off = handle(
        &db.w,
        false,
        &op,
        &frame(json!({"type": "work.renew", "requestId": "q0", "held": []})),
    )
    .await
    .unwrap();
    assert_eq!(off["error"], "work_claim_disabled");

    // 좁히기는 자격을 넓히지 않는다 — 허용 표에 없는 오퍼레이터는 그 스레드를 대도 못 잡는다.
    let none = handle(&db.w, true, &other_op, &claim_t2).await.unwrap();
    assert!(
        none.get("work").is_none() && none.get("error").is_none(),
        "{none}"
    );
    // 프레임 안에 다른 오퍼레이터를 적어도 읽지 않는다(연결의 값만 쓴다).
    let mut forged = claim_t2.clone();
    forged.insert("operatorId".into(), json!(op));
    let none = handle(&db.w, true, &other_op, &forged).await.unwrap();
    assert!(none.get("work").is_none(), "{none}");
    assert_eq!(claim_rows(a, &t2).await, 0);

    // 그 스레드로 좁히면 더 오래된 다른 스레드의 작업을 건너뛴다.
    let got = handle(&db.w, true, &op, &claim_t2).await.unwrap();
    assert_eq!(got["type"], "work.claimed");
    assert_eq!(got["work"]["workId"], new);
    assert_eq!(got["work"]["threadRootId"], t2.1);
    assert_eq!(got["work"]["attempts"], 1);
    assert!(got["work"]["leaseExpiresAt"].is_string());
    // 잡아도 작업 상태는 그대로다.
    let state: String = sqlx::query_scalar("select state from work where id = $1::uuid")
        .bind(&new)
        .fetch_one(a)
        .await
        .unwrap();
    assert_eq!(state, "open");
    // 같은 스레드에 더 잡을 것은 없다(오래된 작업은 다른 스레드다).
    let none = handle(&db.w, true, &op, &claim_t2).await.unwrap();
    assert!(
        none.get("work").is_none() && none.get("error").is_none(),
        "{none}"
    );

    // 갱신: 횟수가 다르면 닿지 않는다.
    let renew = |attempts: i32| {
        frame(
            json!({"type": "work.renew", "requestId": "q2", "held": [{"workId": new, "attempts": attempts}]}),
        )
    };
    let stale = handle(&db.w, true, &op, &renew(2)).await.unwrap();
    assert_eq!(stale["workIds"], json!([]));
    let kept = handle(&db.w, true, &op, &renew(1)).await.unwrap();
    assert_eq!(kept["workIds"], json!([new]));
    assert_eq!(kept["leaseSecs"], 90);
    // 다른 연결은 같은 짝을 대도 갱신·놓기가 안 된다.
    let foreign = handle(&db.w, true, &other_op, &renew(1)).await.unwrap();
    assert_eq!(foreign["workIds"], json!([]));
    let release = |attempts: i32| {
        frame(
            json!({"type": "work.release", "workId": new, "attempts": attempts, "reason": "released"}),
        )
    };
    assert!(handle(&db.w, true, &other_op, &release(1)).await.is_none());
    assert!(handle(&db.w, true, &op, &release(2)).await.is_none());
    let live: i64 = sqlx::query_scalar(
        "select count(*) from work_claim where work_id = $1::uuid and released_at is null",
    )
    .bind(&new)
    .fetch_one(a)
    .await
    .unwrap();
    assert_eq!(live, 1);

    // 놓기: 답은 없고 줄이 놓인다. 다시 잡으면 횟수가 오른다.
    assert!(handle(&db.w, true, &op, &release(1)).await.is_none());
    let reason: Option<String> =
        sqlx::query_scalar("select release_reason from work_claim where work_id = $1::uuid")
            .bind(&new)
            .fetch_one(a)
            .await
            .unwrap();
    assert_eq!(reason.as_deref(), Some("released"));
    let again = handle(&db.w, true, &op, &claim_t2).await.unwrap();
    assert_eq!(again["work"]["attempts"], 2);

    // 틀린 모양은 DB 에 닿기 전에 거절한다.
    let bad = handle(
        &db.w,
        true,
        &op,
        &frame(json!({"type": "work.claim", "requestId": "q9", "slotGeneration": 0, "threadRootId": "nope"})),
    )
    .await
    .unwrap();
    assert_eq!(bad["error"], "invalid_request");
    // 좁히지 않으면 지금처럼 가장 오래된 것부터다.
    let oldest = handle(
        &db.w,
        true,
        &op,
        &frame(json!({"type": "work.claim", "requestId": "q10", "slotGeneration": 0, "agents": [agent]})),
    )
    .await
    .unwrap();
    assert_eq!(oldest["work"]["workId"], old);
}

/// 그 스레드에 글 하나를 올리고 `to` 의 인박스에 안 읽힌 줄을 넣는다. 돌려주는 것은 글 id.
async fn unread(admin: &PgPool, (channel, root): &(String, String), by: &str, to: &str) -> String {
    let m: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind, thread_root_id) \
         values ($1::uuid, $2::uuid, 'hi', 'user', $3::uuid) returning id::text",
    )
    .bind(channel)
    .bind(by)
    .bind(root)
    .fetch_one(admin)
    .await
    .unwrap();
    sqlx::query(
        "insert into inbox (account_id, message_id, reason) values ($1::uuid, $2::uuid, 'mention')",
    )
    .bind(to)
    .bind(&m)
    .execute(admin)
    .await
    .unwrap();
    m
}

#[tokio::test]
async fn pull_takes_only_work_with_unread_input() {
    use harkroom_server::core::work_claim::{PULL_MAX, WORK_PULL_PRIVILEGES, pull_with};
    let Some(db) = db().await else { return };
    let a = &db.admin;
    let missing = harkroom_server::write::missing_in(&db.w, WORK_PULL_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "{missing:?}");
    let owner = account(a, "human", "wc8-owner").await;
    let agent = account(a, "agent", "wc8-agent").await;
    let other = account(a, "agent", "wc8-other").await;
    let op = operator(a, &owner, "wc8-op").await;
    let stranger_op = operator(a, &owner, "wc8-stranger").await;
    allow(a, &agent, &op).await;
    let (t_idle, t_open, t_wait, t_run, t_other) = (
        thread(a, &owner, "wc8-idle").await,
        thread(a, &owner, "wc8-open").await,
        thread(a, &owner, "wc8-wait").await,
        thread(a, &owner, "wc8-run").await,
        thread(a, &owner, "wc8-other").await,
    );
    // 할 일 없는 옛 열린 작업 — 가장 오래됐지만 pull 은 잡지 않는다(잡으면 러너가 빈손으로 반납하고 또 잡는 고리가 된다).
    work(a, &t_idle, Some(&agent), Some(&owner), "open", 90).await;
    let w_open = work(a, &t_open, Some(&agent), Some(&owner), "open", 30).await;
    let w_wait = work(a, &t_wait, Some(&agent), Some(&owner), "waiting", 20).await;
    let w_run = work(a, &t_run, Some(&agent), Some(&owner), "running", 10).await;
    // 허용 표에 없는 에이전트의 작업은 안 읽힌 글이 있어도 못 잡는다.
    work(a, &t_other, Some(&other), Some(&owner), "open", 95).await;
    for (t, to) in [
        (&t_open, &agent),
        (&t_wait, &agent),
        (&t_run, &agent),
        (&t_other, &other),
    ] {
        unread(a, t, &owner, to).await;
    }

    // 꺼져 있으면(스위치 또는 권한) 아무것도 잡지 않는다.
    let off = pull_with(&db.w, false, &op, 1, None, None, 4)
        .await
        .unwrap();
    assert_eq!(off, Err(Refusal::PullDisabled));
    assert_eq!(
        pull_with(&db.w, true, &op, 1, None, None, 0).await.unwrap(),
        Err(Refusal::BadRequest)
    );
    // 자격 없는 오퍼레이터는 빈 목록.
    let none = pull_with(&db.w, true, &stranger_op, 1, None, None, 4)
        .await
        .unwrap()
        .unwrap();
    assert!(none.is_empty());

    // 빈 칸 2개 → 앞에서부터 2개만. 상태가 waiting·running 이어도 안 읽힌 글이 있으면 후보다.
    let two = pull_with(&db.w, true, &op, 1, None, None, 2)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        two.iter().map(|c| c.work_id.as_str()).collect::<Vec<_>>(),
        [w_open.as_str(), w_wait.as_str()]
    );
    let rest = pull_with(&db.w, true, &op, 1, None, None, PULL_MAX + 50)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        rest.iter().map(|c| c.work_id.as_str()).collect::<Vec<_>>(),
        [w_run.as_str()]
    );
    assert_eq!(claim_rows(a, &t_idle).await, 0);
    assert_eq!(claim_rows(a, &t_other).await, 0);
    // 잡아도 작업 상태는 그대로다.
    let st: String = sqlx::query_scalar("select state from work where id = $1::uuid")
        .bind(&w_open)
        .fetch_one(a)
        .await
        .unwrap();
    assert_eq!(st, "open");

    // 놓아도 바로 되잡지 않는다(잡힌 횟수 × 30초 쉰다) — 러너가 못 뜨는 작업을 되풀이해 잡지 않는다.
    assert_eq!(
        release_with(&db.w, true, &op, &held(&w_open, 1), ReleaseReason::Released)
            .await
            .unwrap(),
        Ok(true)
    );
    assert!(
        pull_with(&db.w, true, &op, 1, None, None, 4)
            .await
            .unwrap()
            .unwrap()
            .is_empty()
    );
    sqlx::query(
        "update work_claim set claimed_at = now() - interval '31 seconds' where work_id = $1::uuid",
    )
    .bind(&w_open)
    .execute(a)
    .await
    .unwrap();
    let again = pull_with(&db.w, true, &op, 1, None, None, 4)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(again.len(), 1);
    assert_eq!(
        (again[0].work_id.as_str(), again[0].attempts),
        (w_open.as_str(), 2)
    );
    // 글을 읽으면(러너가 당겼다) 더는 후보가 아니다.
    assert_eq!(
        release_with(&db.w, true, &op, &held(&w_open, 2), ReleaseReason::Released)
            .await
            .unwrap(),
        Ok(true)
    );
    sqlx::query(
        "update work_claim set claimed_at = now() - interval '10 minutes' where work_id = $1::uuid",
    )
    .bind(&w_open)
    .execute(a)
    .await
    .unwrap();
    sqlx::query("update inbox set read_at = now() where account_id = $1::uuid")
        .bind(&agent)
        .execute(a)
        .await
        .unwrap();
    assert!(
        pull_with(&db.w, true, &op, 1, None, None, 4)
            .await
            .unwrap()
            .unwrap()
            .is_empty()
    );

    // 프레임: 꺼진 pull 은 `work_pull_disabled`, 잡기까지 꺼져 있으면 `work_claim_disabled`.
    use harkroom_server::core::work_claim_frames::handle_with;
    let ask = frame(
        serde_json::json!({"type": "work.pull", "requestId": "p1", "slotGeneration": 1, "max": 2}),
    );
    assert_eq!(
        handle_with(&db.w, true, false, &op, &ask).await.unwrap()["error"],
        "work_pull_disabled"
    );
    assert_eq!(
        handle_with(&db.w, false, true, &op, &ask).await.unwrap()["error"],
        "work_claim_disabled"
    );
    let ok = handle_with(&db.w, true, true, &op, &ask).await.unwrap();
    assert_eq!(ok["type"], "work.pulled");
    assert!(
        ok["works"].as_array().unwrap().is_empty() && ok.get("error").is_none(),
        "{ok}"
    );
}

/// 턴 임대 한 줄(그 에이전트 × 그 스레드, 살아 있음). 돌려주는 것은 임대 id.
async fn lease(
    admin: &PgPool,
    agent: &str,
    op: &str,
    (channel, root): &(String, String),
    cause: &str,
) -> String {
    sqlx::query_scalar(
        "insert into secret_turn_lease (token_hash, agent_id, operator_id, cause_message_id, channel_id, thread_root_id, expires_at) \
         values (md5(random()::text || clock_timestamp()::text), $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, now() + interval '10 minutes') \
         returning id::text",
    )
    .bind(agent)
    .bind(op)
    .bind(cause)
    .bind(channel)
    .bind(root)
    .fetch_one(admin)
    .await
    .unwrap()
}

#[tokio::test]
async fn turn_start_notes_the_claim_and_moves_the_root() {
    use harkroom_server::core::work_run::{Started, turn_started_with, turn_waits};
    let Some(db) = db().await else { return };
    let a = &db.admin;
    let owner = account(a, "human", "wc9-owner").await;
    let agent = account(a, "agent", "wc9-agent").await;
    let other = account(a, "agent", "wc9-other").await;
    let op = operator(a, &owner, "wc9-op").await;
    let other_op = operator(a, &owner, "wc9-other-op").await;
    allow(a, &agent, &op).await;
    allow(a, &other, &op).await;
    let t = thread(a, &owner, "wc9-ch").await;
    let t2 = thread(a, &owner, "wc9-ch2").await;
    let w = work(a, &t, Some(&agent), Some(&owner), "open", 5).await;
    let foreign = work(a, &t2, Some(&other), Some(&owner), "open", 5).await;
    let cause = unread(a, &t, &owner, &agent).await;
    let c = claim_next_with(
        &db.w,
        true,
        &op,
        0,
        None,
        Some(std::slice::from_ref(&agent)),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert_eq!(c.work_id, w);
    let cf = claim_next_with(
        &db.w,
        true,
        &op,
        0,
        None,
        Some(std::slice::from_ref(&other)),
    )
    .await
    .unwrap()
    .unwrap()
    .unwrap();
    assert_eq!(cf.work_id, foreign);
    let l = lease(a, &agent, &op, &t, &cause).await;
    let started = |work: Option<Held>, operator: &str| Started {
        lease_id: l.clone(),
        agent_id: agent.clone(),
        operator_id: operator.to_string(),
        thread_root_id: t.1.clone(),
        cause_message_id: cause.clone(),
        work,
    };
    let turn_of = |id: String| async move {
        sqlx::query_scalar::<_, Option<String>>(
            "select turn_id::text from work_claim where work_id = $1::uuid",
        )
        .bind(id)
        .fetch_one(a)
        .await
        .unwrap()
    };
    let state_of = |id: String| async move {
        sqlx::query_scalar::<_, String>("select state from work where id = $1::uuid")
            .bind(id)
            .fetch_one(a)
            .await
            .unwrap()
    };

    // 적지 못하는 것들: 틀린 횟수 · 남의 오퍼레이터 · 다른 에이전트·다른 스레드의 줄(자기 턴에 남의 작업을 잇지 못한다).
    for (held_row, operator) in [
        (held(&w, 2), op.as_str()),
        (held(&w, 1), other_op.as_str()),
        (held(&foreign, 1), op.as_str()),
    ] {
        let r = turn_started_with(a, false, true, &started(Some(held_row), operator))
            .await
            .unwrap();
        assert_eq!(r, (false, false));
    }
    assert_eq!(turn_of(w.clone()).await, None);
    assert_eq!(turn_of(foreign.clone()).await, None);
    // 둘 다 꺼져 있으면 아무것도 안 한다.
    assert_eq!(
        turn_started_with(a, false, false, &started(Some(held(&w, 1)), &op))
            .await
            .unwrap(),
        (false, false)
    );
    assert_eq!(state_of(w.clone()).await, "open");

    // 맞는 줄이면 임대 id 가 적히고(기록), 상태 스위치가 켜져 있으면 뿌리가 running 이 된다.
    let r = turn_started_with(a, true, true, &started(Some(held(&w, 1)), &op))
        .await
        .unwrap();
    assert_eq!(r, (true, true));
    assert_eq!(turn_of(w.clone()).await.as_deref(), Some(l.as_str()));
    assert_eq!(state_of(w.clone()).await, "running");
    // 되풀이해도 사건은 한 줄이다(이미 running).
    assert_eq!(
        turn_started_with(a, true, false, &started(None, &op))
            .await
            .unwrap(),
        (false, false)
    );
    let events: Vec<serde_json::Value> = sqlx::query_scalar(
        "select payload from work_event where work_id = $1::uuid and kind = 'state' order by id",
    )
    .bind(&w)
    .fetch_all(a)
    .await
    .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["from"], "open");
    assert_eq!(events[0]["to"], "running");
    assert_eq!(events[0]["leaseId"], l);

    // 살아 있는 임대가 있는 동안에는 waiting 으로 옮기지 않는다.
    assert!(
        !turn_waits(a, &w, &agent, &l, "waiting_on_wake")
            .await
            .unwrap()
    );
    sqlx::query("update secret_turn_lease set ended_at = now() where id = $1::uuid")
        .bind(&l)
        .execute(a)
        .await
        .unwrap();
    // 남의 작업은 못 옮긴다.
    assert!(
        !turn_waits(a, &w, &other, &l, "waiting_on_wake")
            .await
            .unwrap()
    );
    assert!(
        turn_waits(a, &w, &agent, &l, "waiting_on_wake")
            .await
            .unwrap()
    );
    assert_eq!(state_of(w.clone()).await, "waiting");
    assert!(
        !turn_waits(a, &w, &agent, &l, "waiting_on_wake")
            .await
            .unwrap()
    );
    // 다음 턴이 서면 다시 running(작업 id 를 안 넘긴 옛 러너도 — 스레드의 열린 작업으로 찾는다).
    assert_eq!(
        turn_started_with(a, true, true, &started(None, &op))
            .await
            .unwrap(),
        (false, true)
    );
    assert_eq!(state_of(w.clone()).await, "running");
    // 닫힌 작업은 다시 열지 않는다.
    sqlx::query("update work set state = 'done', closed_at = now() where id = $1::uuid")
        .bind(&w)
        .execute(a)
        .await
        .unwrap();
    assert_eq!(
        turn_started_with(a, true, false, &started(Some(held(&w, 1)), &op))
            .await
            .unwrap(),
        (false, false)
    );
    assert_eq!(state_of(w.clone()).await, "done");
    // 남의 스레드 작업은 상태도 그대로다.
    assert_eq!(state_of(foreign.clone()).await, "open");
}
