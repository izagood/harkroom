//! J2c — 턴의 실행 조합 자격을 서버가 임대에서 고르고(`core/agent_combo_credential.rs`), 허용 목록·하네스·채널·비밀 id·
//! 부여 사슬을 지나야만 값 자리까지 가는 것을 실제 스키마에서 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 넘긴다).
//! 시험 DB 에는 비밀 키가 없다 — 값 사슬을 다 지난 것은 「지금 판 없음」(`no_value`)으로 본다.
use harkroom_server::core::agent_combo_credential::{self as cc, Answer, ComboDenial, Credential};
use harkroom_server::core::agent_secret_reveal::{self as reveal, RevealDenial};
use sqlx::PgPool;

async fn one(pool: &PgPool, sql: &str, args: &[&str]) -> String {
    let mut q = sqlx::query_scalar(sqlx::AssertSqlSafe(sql.to_owned()));
    for a in args {
        q = q.bind(*a);
    }
    q.fetch_one(pool).await.unwrap()
}

async fn run(pool: &PgPool, sql: &str, args: &[&str]) {
    let mut q = sqlx::query(sqlx::AssertSqlSafe(sql.to_owned()));
    for a in args {
        q = q.bind(*a);
    }
    q.execute(pool).await.unwrap();
}

async fn human(pool: &PgPool, handle: &str) -> String {
    one(
        pool,
        "insert into account(handle, display_name, kind, login_id, role, is_admin) \
         values ($1, $1, 'human', $1, 'admin', true) returning id::text",
        &[handle],
    )
    .await
}

async fn agent(pool: &PgPool, handle: &str, owner: &str) -> String {
    let id = one(
        pool,
        "insert into account(handle, display_name, kind, role, is_admin) \
         values ($1, $1, 'agent', 'member', false) returning id::text",
        &[handle],
    )
    .await;
    run(
        pool,
        "insert into agent_config(account_id, owner_account_id) values ($1::uuid, $2::uuid)",
        &[&id, owner],
    )
    .await;
    id
}

async fn message(pool: &PgPool, channel: &str, author: &str) -> String {
    one(
        pool,
        "insert into message(channel_id, author_id, body, kind, meta) \
         values ($1::uuid, $2::uuid, 'x', 'user', '{}') returning id::text",
        &[channel, author],
    )
    .await
}

/// 살아 있는 임대 — 토큰은 `tok`. 원인 글은 임대마다 새로 만든다((에이전트, 원인 글)이 유일하다).
async fn lease(
    pool: &PgPool,
    tok: &str,
    agent: &str,
    operator: &str,
    author: &str,
    channel: &str,
    root: &str,
) -> String {
    let cause = message(pool, channel, author).await;
    one(
        pool,
        "insert into secret_turn_lease(token_hash, agent_id, operator_id, cause_message_id, channel_id, thread_root_id, expires_at) \
         values (encode(sha256(convert_to($1, 'UTF8')), 'hex'), $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, now() + interval '5 minutes') \
         returning id::text",
        &[tok, agent, operator, &cause, channel, root],
    )
    .await
}

fn tag(a: &Answer) -> String {
    match a {
        Answer::LeaseInvalid => "lease_invalid".into(),
        Answer::None => "none".into(),
        Answer::Pool(_) => "pool".into(),
        Answer::Denied(d) => d.code().into(),
        Answer::Secret(d) => format!("secret:{}", d.code()),
        Answer::Key { .. } => "key".into(),
    }
}

#[tokio::test]
async fn turn_credential_is_chosen_by_the_server_and_passes_every_gate() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let st = reveal::load_state(pool.clone()).await.unwrap();

    let admin = human(&pool, "cc-admin").await;
    let bot = agent(&pool, "cc-bot", &admin).await;
    let stranger = agent(&pool, "cc-stranger", &admin).await;
    let ch = one(
        &pool,
        "insert into channel(name, kind) values ('cc-one', 'standard') returning id::text",
        &[],
    )
    .await;
    let ch2 = one(
        &pool,
        "insert into channel(name, kind) values ('cc-two', 'standard') returning id::text",
        &[],
    )
    .await;
    let root = message(&pool, &ch, &admin).await;
    let op = one(
        &pool,
        "insert into operator(owner_account_id, name, token_hash) values ($1::uuid, 'cc', 'cc-op-hash') returning id::text",
        &[&admin],
    )
    .await;
    let op2 = one(
        &pool,
        "insert into operator(owner_account_id, name, token_hash) values ($1::uuid, 'cc2', 'cc-op2-hash') returning id::text",
        &[&admin],
    )
    .await;
    let secret = one(
        &pool,
        "insert into secret(name, kind, owner_account_id) values ('cc-key', 'text', $1::uuid) returning id::text",
        &[&admin],
    )
    .await;
    let link = one(
        &pool,
        "insert into exec_key_link(name, base_url, secret_id, secret_name, created_by) \
         values ('cc-link', 'https://llm.example.com/v1', $1::uuid, 'cc-key', $2::uuid) returning id::text",
        &[&secret, &admin],
    )
    .await;
    let key_combo = one(
        &pool,
        "insert into exec_combo(name, harness, model, key_link_id) values ('cc-key-combo', 'claude-code', 'm', $1::uuid) returning id::text",
        &[&link],
    )
    .await;
    let pool_combo = one(
        &pool,
        "insert into exec_combo(name, harness, model, account_pool) values ('cc-pool-combo', 'claude-code', 'm', 'main') returning id::text",
        &[],
    )
    .await;
    for c in [&key_combo, &pool_combo] {
        run(
            &pool,
            "insert into agent_exec_combo(agent_id, combo_id) values ($1::uuid, $2::uuid)",
            &[&bot, c],
        )
        .await;
    }
    let l = lease(&pool, "tok", &bot, &op, &admin, &ch, &root).await;
    let ask = async |lease_id: &str, tok: &str, operator: &str| {
        tag(&cc::turn_credential(&st, &bot, operator, lease_id, tok)
            .await
            .unwrap())
    };

    // 조합 줄이 없는 스레드 — 조합 없음(오퍼레이터는 로컬 길).
    assert_eq!(ask(&l, "tok", &op).await, "none");
    assert_eq!(
        cc::startup_kind(&pool, &bot, Some(&root)).await.unwrap(),
        Ok(None)
    );

    // 임대가 이 토큰·이 오퍼레이터의 것이 아니면 조합을 보기도 전에 막힌다.
    run(
        &pool,
        "insert into thread_agent_model(thread_root_id, agent_id, harness, model, combo_id) \
         values ($1::uuid, $2::uuid, 'claude-code', 'm', $3::uuid)",
        &[&root, &bot, &key_combo],
    )
    .await;
    assert_eq!(ask(&l, "wrong", &op).await, "lease_invalid");
    assert_eq!(ask(&l, "tok", &op2).await, "lease_invalid");

    // 기동 답 — 종류만(주소·비밀 id 는 몸에 없다). 남의 에이전트는 이 줄을 못 본다.
    let kind = cc::startup_kind(&pool, &bot, Some(&root))
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert!(matches!(kind, Credential::Key { ref combo_id, .. } if *combo_id == key_combo));
    let body = cc::kind_body(&kind);
    assert!(!body.contains("llm.example.com") && !body.contains(&secret));
    assert_eq!(
        cc::startup_kind(&pool, &stranger, Some(&root))
            .await
            .unwrap(),
        Ok(None)
    );
    assert_eq!(cc::startup_kind(&pool, &bot, None).await.unwrap(), Ok(None));

    // 허용 목록에 있어도 부여가 없으면 값은 안 풀린다 — 허용 목록 = 고를 수 있음, 부여 = 값을 씀.
    assert_eq!(ask(&l, "tok", &op).await, "secret:not_granted");
    run(
        &pool,
        "insert into secret_grant(secret_id, agent_id, channel_id, granted_by) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid)",
        &[&secret, &bot, &ch2, &admin],
    )
    .await;
    assert_eq!(ask(&l, "tok", &op).await, "secret:wrong_channel");
    run(
        &pool,
        "update secret_grant set channel_id = $2::uuid where secret_id = $1::uuid",
        &[&secret, &ch],
    )
    .await;
    // 사슬을 다 지났다 — 시험 DB 에는 값 판이 없어 여기서 멎는다.
    assert_eq!(ask(&l, "tok", &op).await, "secret:no_value");
    let logged: Vec<(String, Option<String>)> = sqlx::query_as(
        "select result, reason from secret_access_log where secret_id = $1::uuid and agent_id = $2::uuid order by id",
    )
    .bind(&secret)
    .bind(&bot)
    .fetch_all(&pool)
    .await
    .unwrap();
    let reasons: Vec<_> = logged.iter().map(|(_, r)| r.as_deref()).collect();
    assert_eq!(
        reasons,
        [
            Some(RevealDenial::NotGranted.code()),
            Some(RevealDenial::WrongChannel.code()),
            Some(RevealDenial::NoValue.code())
        ]
    );
    assert!(logged.iter().all(|(r, _)| r == "denied"));

    // 허용 목록에서 빠진 조합(스레드 줄만 남은 경우) — 거절.
    run(
        &pool,
        "delete from agent_exec_combo where agent_id = $1::uuid and combo_id = $2::uuid",
        &[&bot, &key_combo],
    )
    .await;
    assert_eq!(ask(&l, "tok", &op).await, ComboDenial::NotAllowed.code());
    assert_eq!(
        cc::startup_kind(&pool, &bot, Some(&root)).await.unwrap(),
        Err(ComboDenial::NotAllowed)
    );
    run(
        &pool,
        "insert into agent_exec_combo(agent_id, combo_id) values ($1::uuid, $2::uuid)",
        &[&bot, &key_combo],
    )
    .await;

    // 하네스가 바뀌었다 — 옛 하네스의 줄은 안 읽히고(조합 없음), 지금 하네스 줄이 다른 하네스 조합을 가리키면 거절.
    run(
        &pool,
        "update agent_config set harness = 'codex' where account_id = $1::uuid",
        &[&bot],
    )
    .await;
    assert_eq!(ask(&l, "tok", &op).await, "none");
    run(
        &pool,
        "update thread_agent_model set harness = 'codex' where thread_root_id = $1::uuid and agent_id = $2::uuid",
        &[&root, &bot],
    )
    .await;
    assert_eq!(
        ask(&l, "tok", &op).await,
        ComboDenial::HarnessMismatch.code()
    );
    run(
        &pool,
        "update agent_config set harness = 'claude-code' where account_id = $1::uuid",
        &[&bot],
    )
    .await;
    run(
        &pool,
        "update thread_agent_model set harness = 'claude-code' where thread_root_id = $1::uuid and agent_id = $2::uuid",
        &[&root, &bot],
    )
    .await;

    // 임대의 채널이 그 스레드 뿌리 글의 채널과 다르다 — 남의 채널 스레드의 줄로 풀지 않는다.
    let crossed = lease(&pool, "tok2", &bot, &op, &admin, &ch2, &root).await;
    assert_eq!(
        ask(&crossed, "tok2", &op).await,
        ComboDenial::ThreadMismatch.code()
    );

    // 풀 조합 — 이름만.
    run(
        &pool,
        "update thread_agent_model set combo_id = $3::uuid where thread_root_id = $1::uuid and agent_id = $2::uuid",
        &[&root, &bot, &pool_combo],
    )
    .await;
    assert_eq!(ask(&l, "tok", &op).await, "pool");
    assert_eq!(
        cc::startup_kind(&pool, &bot, Some(&root)).await.unwrap(),
        Ok(Some(Credential::Pool {
            combo_id: pool_combo.clone(),
            account_pool: "main".into()
        }))
    );

    // 비밀을 지우고 같은 이름으로 다시 만들어 부여해도 — 조합은 id 로만 잇는다. 뜨지 않는다.
    run(
        &pool,
        "update thread_agent_model set combo_id = $3::uuid where thread_root_id = $1::uuid and agent_id = $2::uuid",
        &[&root, &bot, &key_combo],
    )
    .await;
    run(&pool, "delete from secret where id = $1::uuid", &[&secret]).await;
    let again = one(
        &pool,
        "insert into secret(name, kind, owner_account_id) values ('cc-key', 'text', $1::uuid) returning id::text",
        &[&admin],
    )
    .await;
    run(
        &pool,
        "insert into secret_grant(secret_id, agent_id, granted_by) values ($1::uuid, $2::uuid, $3::uuid)",
        &[&again, &bot, &admin],
    )
    .await;
    assert_eq!(ask(&l, "tok", &op).await, ComboDenial::Unusable.code());
    assert_eq!(
        cc::startup_kind(&pool, &bot, Some(&root)).await.unwrap(),
        Err(ComboDenial::Unusable)
    );
    let touched: i64 =
        sqlx::query_scalar("select count(*) from secret_access_log where secret_id = $1::uuid")
            .bind(&again)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(touched, 0);
}
