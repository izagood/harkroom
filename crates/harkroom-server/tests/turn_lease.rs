//! 턴 임대(`core::turn_lease`, S5.3 C6b)가 TS `secretAccess.ts` 의 `issueTurnLease`·`renewTurnLease`·`endTurnLease` 와 같은 판정을
//! 하는지 실제 Postgres 로 본다. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `packages/server/test/rustFrontDb.test.ts` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 임대 쓰기는 그 역할(`TURN_LEASE_PRIVILEGES` 만 가진 쓰기 역할)로 한다.
//! - `HARKROOM_TURN_LEASE_DUAL=<agent id>:<operator id>` 면 동시 발급 모드 — TS 가 깔아 둔 부름 전부에 TS 와 **동시에** 임대를
//!   청하고 받은 수·거절 수만 찍는다(판정은 TS 쪽: 부름마다 살아 있는 임대가 정확히 하나인가).
use harkroom_server::core::turn_lease::{Issue, TURN_LEASE_PRIVILEGES, end, issue, renew};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;

async fn account(admin: &PgPool, handle: &str, kind: &str) -> String {
    sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id) values ($1, $1, $2, case when $2 = 'human' then $1 end) returning id::text",
    )
    .bind(handle)
    .bind(kind)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn operator(admin: &PgPool, owner: &str, name: &str) -> String {
    sqlx::query_scalar(
        "insert into operator(owner_account_id, name, token_hash) values ($1::uuid, $2, md5(random()::text)) returning id::text",
    )
    .bind(owner)
    .bind(name)
    .fetch_one(admin)
    .await
    .unwrap()
}

/// 사람이 쓴 글 하나와, 그 글로 에이전트를 부른 인박스 항목(`age` 만큼 전).
async fn called(admin: &PgPool, ch: &str, author: &str, agent: &str, age: &str) -> String {
    let m: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'hi', 'user') returning id::text",
    )
    .bind(ch)
    .bind(author)
    .fetch_one(admin)
    .await
    .unwrap();
    sqlx::query(
        "insert into inbox(account_id, message_id, reason, created_at) values ($1::uuid, $2::uuid, 'mention', now() - $3::interval)",
    )
    .bind(agent)
    .bind(&m)
    .bind(age)
    .execute(admin)
    .await
    .unwrap();
    m
}

async fn live(admin: &PgPool, agent: &str, cause: &str) -> i64 {
    sqlx::query_scalar(
        "select count(*) from secret_turn_lease where agent_id = $1::uuid and cause_message_id = $2::uuid and ended_at is null",
    )
    .bind(agent)
    .bind(cause)
    .fetch_one(admin)
    .await
    .unwrap()
}

/// 켜짐·승인·사람 세션으로 만든 자동화(위임장 ⑤b 가 키를 줄 수 있는 꼴).
async fn automation(admin: &PgPool, owner: &str, ch: &str) -> String {
    sqlx::query_scalar(
        "insert into automation(owner_id, channel_id, name, body, trigger, approved_at, enabled, mandate_session_at) \
         values ($1::uuid, $2::uuid, 'n', 'b', '{}'::jsonb, now(), true, now()) returning id::text",
    )
    .bind(owner)
    .bind(ch)
    .fetch_one(admin)
    .await
    .unwrap()
}

/// 그 자동화의 정기 회차 글(meta.automation)과 회차 행, 그 글로 에이전트를 부른 인박스 항목.
async fn auto_called(
    admin: &PgPool,
    ch: &str,
    author: &str,
    agent: &str,
    automation_id: &str,
    key: &str,
) -> String {
    let m = called(admin, ch, author, agent, "1 minute").await;
    sqlx::query("update message set meta = jsonb_build_object('automation', jsonb_build_object('id', $2::text)) where id = $1::uuid")
        .bind(&m)
        .bind(automation_id)
        .execute(admin)
        .await
        .unwrap();
    sqlx::query(
        "insert into automation_run(automation_id, event_key, trigger_kind, status, message_id, initiated_by) \
         values ($1::uuid, $2, 'schedule', 'sent', $3::uuid, null)",
    )
    .bind(automation_id)
    .bind(key)
    .bind(&m)
    .execute(admin)
    .await
    .unwrap();
    m
}

async fn lease_mandate(admin: &PgPool, lease_id: &str) -> Option<String> {
    sqlx::query_scalar("select mandate_id::text from secret_turn_lease where id = $1::uuid")
        .bind(lease_id)
        .fetch_one(admin)
        .await
        .unwrap()
}

fn ok(i: Issue) -> harkroom_server::core::turn_lease::Issued {
    match i {
        Issue::Ok(x) => x,
        other => panic!("expected a lease, got {other:?}"),
    }
}

#[tokio::test]
async fn turn_lease_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let opts = PgConnectOptions::from_str(&write_url)
        .unwrap()
        .application_name("harkroom-turn-lease-dual");
    let w = PgPoolOptions::new()
        .max_connections(4)
        .connect_with(opts)
        .await
        .unwrap();
    let missing = harkroom_server::write::missing_in(&w, TURN_LEASE_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    if let Ok(dual) = std::env::var("HARKROOM_TURN_LEASE_DUAL") {
        let (agent, op) = dual.split_once(':').expect("<agent>:<operator>");
        // TS 와 **같은 차례**로, 넷씩 나란히 — 같은 부름을 두고 계속 맞붙는다. 출발은 TS 가 쥔 출발 잠금이 풀릴 때 같이 한다.
        let causes: Vec<String> = sqlx::query_scalar(
            "select message_id::text from inbox where account_id = $1::uuid order by created_at, message_id",
        )
        .bind(agent)
        .fetch_all(&admin)
        .await
        .unwrap();
        let mut gate = admin.acquire().await.unwrap();
        sqlx::query("select pg_advisory_lock(hashtext('turn-lease-dual-start'))")
            .execute(&mut *gate)
            .await
            .unwrap();
        sqlx::query("select pg_advisory_unlock(hashtext('turn-lease-dual-start'))")
            .execute(&mut *gate)
            .await
            .unwrap();
        let (mut got, mut used, mut other) = (0usize, 0usize, 0usize);
        for chunk in causes.chunks(4) {
            let tasks: Vec<_> = chunk
                .iter()
                .map(|c| {
                    let (w, a, o, c) = (w.clone(), agent.to_string(), op.to_string(), c.clone());
                    tokio::spawn(async move { issue(&w, &a, &o, &c, None).await })
                })
                .collect();
            for t in tasks {
                // 오류(예: 23505 색인 충돌)는 줄 세우기가 깨졌다는 뜻 — 그대로 터뜨린다.
                match t.await.unwrap().unwrap() {
                    Issue::Ok(_) => got += 1,
                    Issue::LeaseUsed => used += 1,
                    _ => other += 1,
                }
            }
        }
        println!("turn-lease-dual rust issued {got} used {used} other {other}");
        return;
    }

    let human = account(&admin, "tl_human", "human").await;
    let agent = account(&admin, "tl_agent", "agent").await;
    let op = operator(&admin, &human, "op-a").await;
    let op2 = operator(&admin, &human, "op-b").await;
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('tl-rs', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();

    // 발급: 채널·스레드는 글에서, principal 은 사람 글의 작성자, 수명 35분, 토큰은 해시만.
    let m1 = called(&admin, &ch, &human, &agent, "5 seconds").await;
    let l1 = ok(issue(&w, &agent, &op, &m1, None).await.unwrap());
    assert_eq!(l1.channel_id, ch);
    assert_eq!(l1.thread_root_id, m1);
    assert!(l1.reissue.is_none());
    assert!(
        (4..=10).contains(&l1.waited_sec),
        "waited {}",
        l1.waited_sec
    );
    let (principal, hash_ok, ttl_ok, beat_ok): (Option<String>, bool, bool, bool) = sqlx::query_as(
        "select principal_account_id::text, token_hash = encode(sha256(convert_to($2, 'UTF8')), 'hex'), \
                expires_at - created_at = interval '35 minutes', last_renewed_at = created_at \
           from secret_turn_lease where id = $1::uuid",
    )
    .bind(&l1.lease_id)
    .bind(&l1.token)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(principal.as_deref(), Some(human.as_str()));
    assert!(hash_ok && ttl_ok && beat_ok);
    assert!(
        l1.expires_at.ends_with('Z') && l1.expires_at.len() == 24,
        "{}",
        l1.expires_at
    );

    // 부름당 한 번 — 박동이 살아 있으면 같은 오퍼레이터도 다시 못 받는다.
    assert_eq!(
        issue(&w, &agent, &op, &m1, None).await.unwrap(),
        Issue::LeaseUsed
    );

    // 불리지 않은 것: 인박스 없음 · 읽음 처리됨 · 6시간 넘음 · 지운 글.
    let no_inbox: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'x', 'user') returning id::text",
    )
    .bind(&ch)
    .bind(&human)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(
        issue(&w, &agent, &op, &no_inbox, None).await.unwrap(),
        Issue::NotInvoked
    );
    let read = called(&admin, &ch, &human, &agent, "1 minute").await;
    sqlx::query("update inbox set read_at = now() where message_id = $1::uuid")
        .bind(&read)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(
        issue(&w, &agent, &op, &read, None).await.unwrap(),
        Issue::NotInvoked
    );
    let old = called(&admin, &ch, &human, &agent, "6 hours 1 minute").await;
    assert_eq!(
        issue(&w, &agent, &op, &old, None).await.unwrap(),
        Issue::NotInvoked
    );
    let gone = called(&admin, &ch, &human, &agent, "1 minute").await;
    sqlx::query("update message set deleted_at = now() where id = $1::uuid")
        .bind(&gone)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(
        issue(&w, &agent, &op, &gone, None).await.unwrap(),
        Issue::NotInvoked
    );

    // 늘리기: 토큰·오퍼레이터가 맞아야 한다. 지금+10분과 발급+70분 중 이른 쪽, 이미 더 길면 그대로.
    assert_eq!(
        renew(&w, &l1.lease_id, "wrong", &agent, &op).await.unwrap(),
        None
    );
    assert_eq!(
        renew(&w, &l1.lease_id, &l1.token, &agent, &op2)
            .await
            .unwrap(),
        None
    );
    let kept = renew(&w, &l1.lease_id, &l1.token, &agent, &op)
        .await
        .unwrap();
    assert_eq!(
        kept.as_deref(),
        Some(l1.expires_at.as_str()),
        "35분 > 지금+10분이면 그대로"
    );
    sqlx::query(
        "update secret_turn_lease set created_at = now() - interval '65 minutes', expires_at = now() + interval '1 minute' where id = $1::uuid",
    )
    .bind(&l1.lease_id)
    .execute(&admin)
    .await
    .unwrap();
    renew(&w, &l1.lease_id, &l1.token, &agent, &op)
        .await
        .unwrap()
        .expect("renewed");
    let capped: bool = sqlx::query_scalar(
        "select expires_at = created_at + interval '70 minutes' and last_renewed_at > created_at from secret_turn_lease where id = $1::uuid",
    )
    .bind(&l1.lease_id)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(capped, "70분 상한");

    // 끝내기: 토큰이 맞아야, 한 번만. 끝난 임대는 늘지 않는다.
    assert!(!end(&w, &l1.lease_id, "wrong", &agent).await.unwrap());
    assert!(!end(&w, &l1.lease_id, &l1.token, &human).await.unwrap());
    assert!(end(&w, &l1.lease_id, &l1.token, &agent).await.unwrap());
    assert!(!end(&w, &l1.lease_id, &l1.token, &agent).await.unwrap());
    assert_eq!(
        renew(&w, &l1.lease_id, &l1.token, &agent, &op)
            .await
            .unwrap(),
        None
    );
    // 끝난 부름은 다시 못 받는다(S1).
    assert_eq!(
        issue(&w, &agent, &op, &m1, None).await.unwrap(),
        Issue::LeaseUsed
    );

    // 만료된 임대는 늘지 않는다.
    let m_exp = called(&admin, &ch, &human, &agent, "1 minute").await;
    let l_exp = ok(issue(&w, &agent, &op, &m_exp, None).await.unwrap());
    sqlx::query(
        "update secret_turn_lease set expires_at = now() - interval '1 second' where id = $1::uuid",
    )
    .bind(&l_exp.lease_id)
    .execute(&admin)
    .await
    .unwrap();
    assert_eq!(
        renew(&w, &l_exp.lease_id, &l_exp.token, &agent, &op)
            .await
            .unwrap(),
        None
    );

    // 다시 주기(157) — 박동이 6분 끊김: 같은 오퍼레이터만, 옛 임대는 끝나고 새 임대가 옛 것을 가리킨다.
    let m2 = called(&admin, &ch, &human, &agent, "1 minute").await;
    let a = ok(issue(&w, &agent, &op, &m2, None).await.unwrap());
    sqlx::query("update secret_turn_lease set last_renewed_at = now() - interval '5 minutes 59 seconds' where id = $1::uuid")
        .bind(&a.lease_id)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(
        issue(&w, &agent, &op, &m2, None).await.unwrap(),
        Issue::LeaseUsed,
        "6분 전엔 안 준다"
    );
    sqlx::query("update secret_turn_lease set last_renewed_at = now() - interval '6 minutes 1 second' where id = $1::uuid")
        .bind(&a.lease_id)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(
        issue(&w, &agent, &op2, &m2, None).await.unwrap(),
        Issue::LeaseUsed,
        "다른 오퍼레이터"
    );
    let b = ok(issue(&w, &agent, &op, &m2, None).await.unwrap());
    let r = b.reissue.clone().expect("reissue");
    assert_eq!(r.old_lease_id, a.lease_id);
    assert_eq!(r.via, "stale_beat");
    assert!(
        (361..=370).contains(&r.since_last_beat_sec),
        "{}",
        r.since_last_beat_sec
    );
    let (old_ended, link): (bool, Option<String>) = sqlx::query_as(
        "select (select ended_at is not null from secret_turn_lease where id = $1::uuid), \
                (select reissue_of::text from secret_turn_lease where id = $2::uuid)",
    )
    .bind(&a.lease_id)
    .bind(&b.lease_id)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert!(old_ended);
    assert_eq!(link.as_deref(), Some(a.lease_id.as_str()));
    assert_eq!(live(&admin, &agent, &m2).await, 1);

    // 스레드 임대를 옛 박동 뒤에 넘겨받은 러너는 문턱 없이 받는다 — holder 가 맞을 때만.
    sqlx::query(
        "insert into agent_thread_claim(agent_id, channel_id, thread_root_id, holder, claimed_at, expires_at) \
         values ($1::uuid, $2::uuid, $3::uuid, 'h2', now() + interval '1 second', now() + interval '90 seconds')",
    )
    .bind(&agent)
    .bind(&ch)
    .bind(&m2)
    .execute(&admin)
    .await
    .unwrap();
    assert_eq!(
        issue(&w, &agent, &op, &m2, Some("h1")).await.unwrap(),
        Issue::LeaseUsed
    );
    assert_eq!(
        issue(&w, &agent, &op, &m2, None).await.unwrap(),
        Issue::LeaseUsed
    );
    let c = ok(issue(&w, &agent, &op, &m2, Some("h2")).await.unwrap());
    assert_eq!(c.reissue.as_ref().map(|r| r.via), Some("thread_claim"));
    // 행이 셋 — 다시 주기 상한(2)에 닿았다.
    sqlx::query("update secret_turn_lease set last_renewed_at = now() - interval '1 hour' where id = $1::uuid")
        .bind(&c.lease_id)
        .execute(&admin)
        .await
        .unwrap();
    assert_eq!(
        issue(&w, &agent, &op, &m2, None).await.unwrap(),
        Issue::LeaseUsed,
        "다시 주기 상한"
    );

    // 위임장: 원인 글의 위임은 이 에이전트 소유자의 것일 때만 붙는다.
    sqlx::query(
        "insert into agent_config(account_id, owner_account_id) values ($1::uuid, $2::uuid)",
    )
    .bind(&agent)
    .bind(&human)
    .execute(&admin)
    .await
    .unwrap();
    let m3 = called(&admin, &ch, &human, &agent, "1 minute").await;
    let mandate: String = sqlx::query_scalar(
        "insert into mandate(owner_account_id, delegator_account_id, root_message_id, channel_id, thread_root_id) \
         values ($1::uuid, $1::uuid, $3::uuid, $2::uuid, $3::uuid) returning id::text",
    )
    .bind(&human)
    .bind(&ch)
    .bind(&m3)
    .fetch_one(&admin)
    .await
    .unwrap();
    sqlx::query("update message set mandate_id = $2::uuid where id = $1::uuid")
        .bind(&m3)
        .bind(&mandate)
        .execute(&admin)
        .await
        .unwrap();
    let l3 = ok(issue(&w, &agent, &op, &m3, None).await.unwrap());
    let got: Option<String> =
        sqlx::query_scalar("select mandate_id::text from secret_turn_lease where id = $1::uuid")
            .bind(&l3.lease_id)
            .fetch_one(&admin)
            .await
            .unwrap();
    assert_eq!(got.as_deref(), Some(mandate.as_str()));

    // 자동화 회차 글(⑤b) — 키를 줄 수 없는 회차(승인 전·사람이 아닌 길로 돌린 회차)는 위임장 없이 임대만 나간다.
    let m4 = called(&admin, &ch, &human, &agent, "1 minute").await;
    sqlx::query(
        "with a as (insert into automation(owner_id, channel_id, name, body, trigger) values ($1::uuid, $2::uuid, 'n', 'b', '{}'::jsonb) returning id) \
         insert into automation_run(automation_id, event_key, trigger_kind, message_id) select id, 'k', 'manual', $3::uuid from a",
    )
    .bind(&human)
    .bind(&ch)
    .bind(&m4)
    .execute(&admin)
    .await
    .unwrap();
    let l4 = ok(issue(&w, &agent, &op, &m4, None).await.unwrap());
    assert_eq!(lease_mandate(&admin, &l4.lease_id).await, None);

    // 키를 주는 회차: 켜짐·승인·사람 세션으로 만든 자동화의 정기 회차 글. 맡긴 사람(자동화 소유자)이 에이전트 소유자 본인이다.
    let auto_id = automation(&admin, &human, &ch).await;
    let m5 = auto_called(&admin, &ch, &human, &agent, &auto_id, "r5").await;
    let l5 = ok(issue(&w, &agent, &op, &m5, None).await.unwrap());
    let made = lease_mandate(&admin, &l5.lease_id)
        .await
        .expect("automation mandate");
    let (m_auto, m_owner, m_delegator, m_root): (String, String, String, Option<String>) = sqlx::query_as(
        "select automation_id::text, owner_account_id::text, delegator_account_id::text, root_message_id::text from mandate where id = $1::uuid and ended_at is null",
    )
    .bind(&made)
    .fetch_one(&admin)
    .await
    .unwrap();
    assert_eq!(
        (
            m_auto.as_str(),
            m_owner.as_str(),
            m_delegator.as_str(),
            m_root
        ),
        (auto_id.as_str(), human.as_str(), human.as_str(), None)
    );
    // 다음 회차는 같은 위임장을 잇는다 — 새로 만들지 않고 감사도 한 줄뿐이다.
    let m6 = auto_called(&admin, &ch, &human, &agent, &auto_id, "r6").await;
    let l6 = ok(issue(&w, &agent, &op, &m6, None).await.unwrap());
    assert_eq!(
        lease_mandate(&admin, &l6.lease_id).await.as_deref(),
        Some(made.as_str())
    );
    let audits: Vec<(Option<String>, String)> = sqlx::query_as(
        "select actor_id::text, detail::text from audit_log where action = 'mandate.created' and target = $1",
    )
    .bind(&made)
    .fetch_all(&admin)
    .await
    .unwrap();
    assert_eq!(audits.len(), 1);
    assert_eq!(audits[0].0.as_deref(), Some(human.as_str()));
    let detail: serde_json::Value = serde_json::from_str(&audits[0].1).unwrap();
    assert_eq!(
        detail,
        serde_json::json!({"mandateId": made, "via": "automation", "automationId": auto_id, "ownerId": human, "delegatorId": human})
    );

    // 맡긴 사람이 지금 이 에이전트를 정할 수 없으면(여기서는 사람이 아닌 계정이 자동화 소유자) 키 없음 — 위임장도 안 생긴다.
    let bot_owner = account(&admin, "tl-auto-bot", "agent").await;
    let auto2 = automation(&admin, &bot_owner, &ch).await;
    let m7 = auto_called(&admin, &ch, &human, &agent, &auto2, "r7").await;
    let l7 = ok(issue(&w, &agent, &op, &m7, None).await.unwrap());
    assert_eq!(lease_mandate(&admin, &l7.lease_id).await, None);
    let n: i64 = sqlx::query_scalar("select count(*) from mandate where automation_id = $1::uuid")
        .bind(&auto2)
        .fetch_one(&admin)
        .await
        .unwrap();
    assert_eq!(n, 0);

    // 자동화가 다른 채널 것이면 키 없음.
    let other_ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('tl-rs-other', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let auto3 = automation(&admin, &human, &other_ch).await;
    let m8 = auto_called(&admin, &ch, &human, &agent, &auto3, "r8").await;
    let l8 = ok(issue(&w, &agent, &op, &m8, None).await.unwrap());
    assert_eq!(lease_mandate(&admin, &l8.lease_id).await, None);
    println!("turn-lease rust ok");
}
