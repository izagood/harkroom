//! C3b-3a 판정 코어(`core::decide_core`)를 실제 Postgres 로 본다. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다
//! (CI `bus-e2e` 의 `packages/server/test/rustFrontDb.test.ts` 가 마이그레이션을 다 적용한 DB 를 넘긴다).
//!
//! - `locks_*`: 동시성 — 판정이 근거 줄을 잠근 채 **이기면** 명단 빼기·게스트 강등·비활성·채널 삭제·에이전트 삭제가 기다리고,
//!   그 쓰기가 **먼저면** 판정이 기다렸다가 거절(`ok: None`)로 끝나는지. 잠금을 끄면(`Checks.lock = false`) 기다리지 않음을 함께 본다
//!   — 시험이 잠금 제거를 잡는지(망가뜨리기).
//! - `retry_*`: 40P01·55P03 이면 한 번만 다시 하고, 또 나면 `Exhausted`(호출자 `internal`).
//! - `contrast`: TS `mayDecideFor` 대조 — 사례는 `HARKROOM_DECIDE_CASES`(TS 가 깔고 넘김). 답을 `DECIDE_CORE_JSON` 한 줄로 찍고,
//!   같은지·스위치를 끄면 달라지는지는 TS 쪽이 맞춰 본다.
use harkroom_server::core::decide_core::{
    Checks, DecideScope, LockRetryError, Verdict, has_lock_fn_privilege, is_retryable_lock_error,
    lock_basis, lock_request, may_decide_for_locked, may_decide_for_with, retry_lock_once,
};
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

fn db_url() -> Option<String> {
    match std::env::var("HARKROOM_TEST_DATABASE_URL") {
        Ok(u) => Some(u),
        Err(_) => {
            eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
            None
        }
    }
}

fn tag() -> String {
    static N: AtomicUsize = AtomicUsize::new(0);
    let ns = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!(
        "{}{}{}",
        std::process::id(),
        ns % 1_000_000_000,
        N.fetch_add(1, Ordering::SeqCst)
    )
}

async fn account(pool: &PgPool, handle: &str, kind: &str, role: &str) -> String {
    sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id, role) \
         values ($1, $1, $2, case when $2 = 'human' then $1 end, $3) returning id::text",
    )
    .bind(handle)
    .bind(kind)
    .bind(role)
    .fetch_one(pool)
    .await
    .unwrap()
}

struct Fx {
    owner: String,
    actor: String,
    agent: String,
    channel: String,
}

/// 소유자 O·사람 H(명단·채널 멤버)·에이전트 A(범위 `scope`)·공개 채널 C.
async fn fixture(pool: &PgPool, scope: &str) -> Fx {
    let t = tag();
    let owner = account(pool, &format!("dc-o-{t}"), "human", "member").await;
    let actor = account(pool, &format!("dc-h-{t}"), "human", "member").await;
    let agent = account(pool, &format!("dc-a-{t}"), "agent", "member").await;
    sqlx::query(
        "insert into agent_config(account_id, owner_account_id, invoke_scope) values ($1::uuid, $2::uuid, $3)",
    )
    .bind(&agent)
    .bind(&owner)
    .bind(scope)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("insert into agent_invoker(agent_id, account_id) values ($1::uuid, $2::uuid)")
        .bind(&agent)
        .bind(&actor)
        .execute(pool)
        .await
        .unwrap();
    let channel: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ($1, 'standard') returning id::text",
    )
    .bind(format!("dc-c-{t}"))
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query("insert into channel_member(channel_id, account_id) values ($1::uuid, $2::uuid)")
        .bind(&channel)
        .bind(&actor)
        .execute(pool)
        .await
        .unwrap();
    Fx {
        owner,
        actor,
        agent,
        channel,
    }
}

/// 판정과 동시에 들어오는 쓰기 — TS 의 그 경로가 쓰는 문장 꼴(첫 문장이 판정과 부딪는 자리).
fn writer(kind: &str, f: &Fx) -> Vec<(&'static str, Vec<String>)> {
    let a = f.agent.clone();
    let h = f.actor.clone();
    let c = f.channel.clone();
    let q = |s: &'static str, b: Vec<String>| (s, b);
    match kind {
        // `setInvoker` — 명단에서 빼기.
        "list" => vec![q(
            "delete from agent_invoker where agent_id = $1::uuid and account_id = $2::uuid",
            vec![a, h],
        )],
        // `grantRoutes.ts` role 바꾸기 — 키 아닌 칸 UPDATE.
        "guest" => vec![q(
            "update account set role = 'guest' where id = $1::uuid",
            vec![h],
        )],
        "disable" => vec![q(
            "update account set disabled_at = now() where id = $1::uuid",
            vec![h],
        )],
        // `channels.ts` 채널 삭제 — channel for update 가 먼저.
        "channel_delete" => vec![
            q(
                "select id from channel where id = $1::uuid for update",
                vec![c.clone()],
            ),
            q(
                "delete from channel_member where channel_id = $1::uuid",
                vec![c.clone()],
            ),
            q("delete from channel where id = $1::uuid", vec![c]),
        ],
        // `accountDeletion.ts` 에이전트 삭제 — account for update 가 먼저.
        "agent_delete" => vec![
            q(
                "select id from account where id = $1::uuid for update",
                vec![a.clone()],
            ),
            q(
                "delete from agent_invoker where agent_id = $1::uuid",
                vec![a.clone()],
            ),
            q(
                "update account set deleted_at = now(), disabled_at = coalesce(disabled_at, now()) where id = $1::uuid",
                vec![a],
            ),
        ],
        o => panic!("writer {o}"),
    }
}

async fn run_writer(
    tx: &mut Transaction<'_, Postgres>,
    stmts: &[(&'static str, Vec<String>)],
) -> sqlx::Result<()> {
    for (s, binds) in stmts {
        let mut q = sqlx::query(*s);
        for b in binds {
            q = q.bind(b);
        }
        q.execute(&mut **tx).await?;
    }
    Ok(())
}

/// 그 쓰기가 어느 범위에서 판정을 가르는가(채널 삭제는 채널 범위, 나머지는 명단 범위 — 명단 빼기가 판정을 바꾸게).
fn scope_for(kind: &str) -> &'static str {
    if kind == "channel_delete" {
        "channel"
    } else {
        "list"
    }
}

const KINDS: [&str; 5] = ["list", "guest", "disable", "channel_delete", "agent_delete"];

/// 판정이 먼저 잠그면 쓰기가 기다리는가(`lock_timeout` 으로 55P03 이 나면 기다린 것).
async fn writer_waits_for_decision(pool: &PgPool, kind: &str, checks: Checks) -> bool {
    let f = fixture(pool, scope_for(kind)).await;
    let mut d = pool.begin().await.unwrap();
    let v = may_decide_for_with(&mut d, &f.agent, &f.actor, Some(&f.channel), checks)
        .await
        .unwrap();
    assert_eq!(
        v.ok,
        Some(false),
        "{kind}: 픽스처는 소유자 아닌 결정권자여야 한다"
    );
    let mut w = pool.begin().await.unwrap();
    sqlx::query("set local lock_timeout = '300ms'")
        .execute(&mut *w)
        .await
        .unwrap();
    let r = run_writer(&mut w, &writer(kind, &f)).await;
    w.rollback().await.unwrap();
    d.rollback().await.unwrap();
    match r {
        Ok(()) => false,
        Err(e) if is_retryable_lock_error(&e) => true,
        Err(e) => panic!("{kind}: writer failed otherwise: {e}"),
    }
}

#[tokio::test]
async fn locks_decision_wins_writer_waits() {
    let Some(url) = db_url() else { return };
    let pool = PgPool::connect(&url).await.unwrap();
    for kind in KINDS {
        assert!(
            writer_waits_for_decision(&pool, kind, Checks::default()).await,
            "{kind}: 판정이 잠근 근거 줄을 쓰기가 기다려야 한다"
        );
        // 망가뜨리기: 잠금을 끄면 쓰기가 기다리지 않는다 → 위 단언이 빨개진다.
        let off = Checks {
            lock: false,
            ..Checks::default()
        };
        assert!(
            !writer_waits_for_decision(&pool, kind, off).await,
            "{kind}: 잠금을 끄면 기다리지 않아야(시험이 잠금 제거를 잡는다)"
        );
    }
}

#[tokio::test]
async fn locks_writer_wins_decision_waits_then_forbidden() {
    let Some(url) = db_url() else { return };
    let pool = PgPool::connect(&url).await.unwrap();
    for kind in KINDS {
        let f = fixture(&pool, scope_for(kind)).await;
        let mut w = pool.begin().await.unwrap();
        run_writer(&mut w, &writer(kind, &f)).await.unwrap();
        let p = pool.clone();
        let (agent, actor, channel) = (f.agent.clone(), f.actor.clone(), f.channel.clone());
        let decide = tokio::spawn(async move {
            let mut d = p.begin().await.unwrap();
            let v = may_decide_for_locked(&mut d, &agent, &actor, Some(&channel))
                .await
                .unwrap();
            d.rollback().await.unwrap();
            v
        });
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(
            !decide.is_finished(),
            "{kind}: 쓰기가 쥔 줄을 판정이 기다려야 한다"
        );
        w.commit().await.unwrap();
        let v = tokio::time::timeout(Duration::from_secs(10), decide)
            .await
            .expect("decision finished")
            .unwrap();
        assert_eq!(v.ok, None, "{kind}: 쓰기 뒤의 판정은 거절이어야 한다");
        // 소유자는 그대로 정할 수 있다(에이전트 삭제는 소유자도 남는다 — TS 와 같게 소유자 판정이 먼저).
        if kind != "channel_delete" {
            let mut d = pool.begin().await.unwrap();
            let o = may_decide_for_locked(&mut d, &f.agent, &f.owner, Some(&f.channel))
                .await
                .unwrap();
            d.rollback().await.unwrap();
            assert_eq!(o.ok, Some(true), "{kind}: owner");
        }
    }
}

#[tokio::test]
async fn retry_once_then_exhausted() {
    let Some(url) = db_url() else { return };
    let pool = PgPool::connect(&url).await.unwrap();
    let f = fixture(&pool, "list").await;
    // 쓰기 쪽이 행위자 account 를 쥐고 있다 → 판정의 잠금이 55P03.
    let mut hold = pool.begin().await.unwrap();
    sqlx::query("select id from account where id = $1::uuid for update")
        .bind(&f.actor)
        .execute(&mut *hold)
        .await
        .unwrap();
    let tries = Arc::new(AtomicUsize::new(0));
    let attempt = |release_after_first: bool| {
        let pool = pool.clone();
        let tries = tries.clone();
        let (agent, actor, channel) = (f.agent.clone(), f.actor.clone(), f.channel.clone());
        move || {
            let pool = pool.clone();
            let tries = tries.clone();
            let (agent, actor, channel) = (agent.clone(), actor.clone(), channel.clone());
            async move {
                let n = tries.fetch_add(1, Ordering::SeqCst);
                let mut d = pool.begin().await?;
                let timeout = if release_after_first && n > 0 {
                    "set local lock_timeout = '5s'"
                } else {
                    "set local lock_timeout = '200ms'"
                };
                sqlx::query(timeout).execute(&mut *d).await?;
                let v = may_decide_for_locked(&mut d, &agent, &actor, Some(&channel)).await?;
                d.rollback().await?;
                Ok::<Verdict, sqlx::Error>(v)
            }
        }
    };
    // 두 번 다 막힘 → Exhausted, 정확히 두 번.
    match retry_lock_once(attempt(false)).await {
        Err(LockRetryError::Exhausted(e)) => assert!(is_retryable_lock_error(&e)),
        other => panic!("expected Exhausted, got {other:?}"),
    }
    assert_eq!(tries.load(Ordering::SeqCst), 2);
    // 첫 시도만 막히고 그 사이 풀림 → 두 번째에 성공.
    tries.store(0, Ordering::SeqCst);
    let release = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        hold.rollback().await.unwrap();
    });
    let v = retry_lock_once(attempt(true)).await.unwrap();
    release.await.unwrap();
    assert_eq!(v.ok, Some(false));
    assert_eq!(tries.load(Ordering::SeqCst), 2);
    // 잠금 오류가 아니면 다시 하지 않는다.
    let once = AtomicUsize::new(0);
    let r: Result<(), _> = retry_lock_once(|| {
        once.fetch_add(1, Ordering::SeqCst);
        let pool = pool.clone();
        async move {
            sqlx::query("select 1/0").execute(&pool).await?;
            Ok(())
        }
    })
    .await;
    assert!(matches!(r, Err(LockRetryError::Other(_))));
    assert_eq!(once.load(Ordering::SeqCst), 1);
}

fn verdict_json(v: &Verdict) -> Value {
    let scope = v.scope.as_ref().map(|s| match s {
        DecideScope::Owner => "owner".to_owned(),
        DecideScope::List => "list".to_owned(),
        DecideScope::Channel => "channel".to_owned(),
        DecideScope::Community => "community".to_owned(),
        DecideScope::SwitchOff => "switchOff".to_owned(),
        DecideScope::Other(o) => o.clone(),
    });
    let mut o = json!({ "ok": v.ok.is_some(), "ownerAccountId": v.owner, "decideScope": scope });
    if let Some(as_owner) = v.ok {
        o["asOwner"] = json!(as_owner);
    }
    o
}

#[tokio::test]
async fn contrast() {
    let Some(url) = db_url() else { return };
    let Ok(path) = std::env::var("HARKROOM_DECIDE_CASES") else {
        eprintln!("skip contrast: HARKROOM_DECIDE_CASES unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let variants: [(&str, Checks); 4] = [
        ("normal", Checks::default()),
        (
            "scope",
            Checks {
                scope: false,
                ..Checks::default()
            },
        ),
        (
            "guest",
            Checks {
                guest: false,
                ..Checks::default()
            },
        ),
        (
            "switch",
            Checks {
                switch: false,
                ..Checks::default()
            },
        ),
    ];
    let mut out = serde_json::Map::new();
    for (name, checks) in variants {
        let mut got = vec![];
        for c in &cases {
            let agent = c["agentId"].as_str().unwrap();
            let actor = c["actorId"].as_str().unwrap();
            let channel = c["channelId"].as_str();
            let mut d = pool.begin().await.unwrap();
            let v = may_decide_for_with(&mut d, agent, actor, channel, checks)
                .await
                .unwrap();
            d.rollback().await.unwrap();
            got.push(verdict_json(&v));
        }
        out.insert(name.to_owned(), Value::Array(got));
    }
    println!("DECIDE_CORE_JSON {}", Value::Object(out));
}

/// 잠그는 select(`for share`·`for key share`)는 PG 에서 그 표의 **UPDATE 권한(칸 하나 이상)**을 요구한다. 읽기 권한만 가진 역할은
/// 판정 잠금에서 42501 로 막힌다 — 3b·3c 의 「두 겹 잠금」 권한 목록에 잠그는 표마다 UPDATE 칸이 들어가야 한다는 근거.
/// A안(security) — 읽기만 가진 역할은 잠금 함수의 EXECUTE 가 없으면 `has_lock_fn_privilege` 가 거짓이고(→ 풀 `None`, TS),
/// EXECUTE 만 받으면 다섯 표의 UPDATE 칸 없이도 잠근다. 표를 직접 `for share` 하는 것은 여전히 42501(칸을 주지 않았다는 증거).
#[tokio::test]
async fn lock_fn_privilege_gates_rust() {
    let Some(url) = db_url() else { return };
    let pool = PgPool::connect(&url).await.unwrap();
    let f = fixture(&pool, "list").await;
    let role = format!("dc_ro_{}", tag());
    for q in [
        format!("create role {role} login password '{role}' nosuperuser"),
        format!("grant pg_read_all_data to {role}"),
    ] {
        sqlx::query(sqlx::AssertSqlSafe(q))
            .execute(&pool)
            .await
            .unwrap();
    }
    let mut u = url::Url::parse(&url).unwrap();
    u.set_username(&role).unwrap();
    u.set_password(Some(&role)).unwrap();
    let ro = PgPool::connect(u.as_str()).await.unwrap();
    // EXECUTE 없음(PUBLIC 회수) → 거짓 · 부르면 42501.
    assert!(!has_lock_fn_privilege(&ro).await.unwrap());
    let mut d = ro.begin().await.unwrap();
    let e = lock_basis(&mut d, &f.agent, &f.actor, Some(&f.channel))
        .await
        .expect_err("no EXECUTE");
    assert_eq!(
        e.as_database_error().and_then(|x| x.code()).as_deref(),
        Some("42501"),
        "{e}"
    );
    d.rollback().await.unwrap();
    // EXECUTE 만 줌 → 참 · 판정까지 됨 · 표 직접 잠금은 여전히 42501.
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "grant execute on function permission_decide_lock(uuid, uuid, uuid) to {role}"
    )))
    .execute(&pool)
    .await
    .unwrap();
    assert!(has_lock_fn_privilege(&ro).await.unwrap());
    let mut d = ro.begin().await.unwrap();
    let v = may_decide_for_locked(&mut d, &f.agent, &f.actor, Some(&f.channel))
        .await
        .unwrap();
    assert_eq!(v.ok, Some(false));
    let e = sqlx::query("select id from channel where id = $1::uuid for share")
        .bind(&f.channel)
        .execute(&mut *d)
        .await
        .expect_err("table lock still needs UPDATE");
    assert_eq!(
        e.as_database_error().and_then(|x| x.code()).as_deref(),
        Some("42501")
    );
    d.rollback().await.unwrap();
    ro.close().await;
    sqlx::query(sqlx::AssertSqlSafe(format!(
        "revoke execute on function permission_decide_lock(uuid, uuid, uuid) from {role}"
    )))
    .execute(&pool)
    .await
    .unwrap();
}

/// 권한 카드 하나(에이전트가 쓴 카드 글 + 그 요청 줄).
async fn request_with_card(pool: &PgPool, f: &Fx) -> (String, String) {
    let card: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind, meta) \
         values ($1::uuid, $2::uuid, 'card', 'user', '{\"kind\":\"ask\",\"permissionRequest\":{}}'::jsonb) returning id::text",
    )
    .bind(&f.channel)
    .bind(&f.agent)
    .fetch_one(pool)
    .await
    .unwrap();
    let req: String = sqlx::query_scalar(
        "insert into permission_request(agent_id, kind, target, reason, channel_id, thread_root_id, card_message_id, expires_at) \
         values ($1::uuid, 'tool', 'Bash(x)', 'r', $2::uuid, $3::uuid, $3::uuid, now() + interval '1 hour') returning id::text",
    )
    .bind(&f.agent)
    .bind(&f.channel)
    .bind(&card)
    .fetch_one(pool)
    .await
    .unwrap();
    (req, card)
}

/// 채널 삭제의 전체 꼴 — channel for update → member → message(→ 요청 줄 card_message_id null) → channel(→ 요청 줄 cascade).
fn channel_delete_full(c: &str) -> Vec<(&'static str, Vec<String>)> {
    vec![
        (
            "select id from channel where id = $1::uuid for update",
            vec![c.into()],
        ),
        (
            "delete from channel_member where channel_id = $1::uuid",
            vec![c.into()],
        ),
        (
            "delete from message where channel_id = $1::uuid",
            vec![c.into()],
        ),
        ("delete from channel where id = $1::uuid", vec![c.into()]),
    ]
}

/// security C3b-3 조건 ② — 요청 줄 `for update` 까지 잡은 결정과 채널 삭제(message DELETE 포함)를 동시에 돌려도 교착(40P01)이 없다.
/// 두 차례: 결정이 먼저(삭제가 기다렸다가 끝남) · 삭제가 먼저(결정이 기다렸다가 요청 줄이 사라짐 → `None`).
#[tokio::test]
async fn deny_vs_channel_delete_no_deadlock() {
    let Some(url) = db_url() else { return };
    let pool = PgPool::connect(&url).await.unwrap();
    // 1) 결정이 먼저.
    let f = fixture(&pool, "channel").await;
    let (req, card) = request_with_card(&pool, &f).await;
    let mut d = pool.begin().await.unwrap();
    lock_basis(&mut d, &f.agent, &f.actor, Some(&f.channel))
        .await
        .unwrap();
    let r = lock_request(&mut d, &req)
        .await
        .unwrap()
        .expect("request row");
    assert_eq!(r.card_message_id.as_deref(), Some(card.as_str()));
    let p = pool.clone();
    let c = f.channel.clone();
    let w = tokio::spawn(async move {
        let mut w = p.begin().await.unwrap();
        sqlx::query("set local lock_timeout = '5s'")
            .execute(&mut *w)
            .await
            .unwrap();
        let r = run_writer(&mut w, &channel_delete_full(&c)).await;
        if r.is_ok() {
            w.commit().await.unwrap();
        }
        r
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !w.is_finished(),
        "channel delete must wait for the decision"
    );
    // 3b 의 쓰기 꼴: 요청 줄 → 카드 글(expirePermissionRequests 와 같은 차례).
    sqlx::query(
        "update permission_request set status = 'denied', decided_at = now() where id = $1::uuid",
    )
    .bind(&req)
    .execute(&mut *d)
    .await
    .unwrap();
    sqlx::query("update message set meta = meta || '{\"x\":1}'::jsonb where id = $1::uuid")
        .bind(&card)
        .execute(&mut *d)
        .await
        .unwrap();
    d.commit().await.unwrap();
    w.await
        .unwrap()
        .expect("channel delete finishes without 40P01");

    // 2) 삭제가 먼저 — message·channel 까지 지운 채 커밋 전, 결정이 들어온다.
    let f = fixture(&pool, "channel").await;
    let (req, _) = request_with_card(&pool, &f).await;
    let mut w = pool.begin().await.unwrap();
    run_writer(&mut w, &channel_delete_full(&f.channel))
        .await
        .unwrap();
    let p = pool.clone();
    let (a, h, c, rq) = (
        f.agent.clone(),
        f.actor.clone(),
        f.channel.clone(),
        req.clone(),
    );
    let d = tokio::spawn(async move {
        let mut d = p.begin().await.unwrap();
        sqlx::query("set local lock_timeout = '5s'")
            .execute(&mut *d)
            .await
            .unwrap();
        lock_basis(&mut d, &a, &h, Some(&c)).await?;
        let r = lock_request(&mut d, &rq).await?;
        d.rollback().await.unwrap();
        Ok::<_, sqlx::Error>(r)
    });
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !d.is_finished(),
        "decision must wait for the channel delete"
    );
    w.commit().await.unwrap();
    let r = d.await.unwrap().expect("decision finishes without 40P01");
    assert!(r.is_none(), "request row went with the channel");
}
