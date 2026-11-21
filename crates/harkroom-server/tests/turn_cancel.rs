//! MCP `turn.cancel` 을 Rust 허브로 답하는 길(`core/mcp/turn_cancel.rs` — TS `mcpPlugin.ts` `turn.cancel`)을 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! 쓰기 풀은 `HARKROOM_TEST_WRITE_DATABASE_URL`(있으면 `OPERATOR_PRIVILEGES` 만 가진 역할) — 정리·감사 권한이 모자라면 여기서 빨개진다.
use harkroom_server::auth::Account;
use harkroom_server::core::mcp::turn_cancel::answer;
use harkroom_server::core::operator_hub::OperatorHub;
use harkroom_server::core::relay::RelayHub;
use harkroom_server::core::relay_link::{LinkHooks, RelayLink, db_assign_check};
use harkroom_server::core::relay_routes::RelayCore;
use harkroom_server::core::turn_settle::settle_hook;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::sync::{Arc, Mutex};

async fn account(admin: &PgPool, handle: &str) -> String {
    sqlx::query_scalar(
        "insert into account(handle, display_name, kind) values ($1, $1, 'agent') returning id::text",
    )
    .bind(handle)
    .fetch_one(admin)
    .await
    .unwrap()
}

fn me(id: &str, handle: &str) -> Account {
    Account {
        id: id.to_owned(),
        handle: handle.to_owned(),
        display_name: handle.to_owned(),
        kind: "agent".into(),
        is_admin: false,
        role: "member".into(),
        status: "active".into(),
        status_text: None,
        avatar_attachment_id: None,
    }
}

async fn message(
    admin: &PgPool,
    ch: &str,
    author: &str,
    root: Option<&str>,
    meta: Value,
) -> String {
    sqlx::query_scalar(
        "insert into message(channel_id, author_id, thread_root_id, body, kind, meta) \
         values ($1::uuid, $2::uuid, $3::uuid, 'x', 'user', $4::jsonb) returning id::text",
    )
    .bind(ch)
    .bind(author)
    .bind(root)
    .bind(meta.to_string())
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn delegation(admin: &PgPool, ch: &str, root: &str, lead: &str, members: &[&str]) -> String {
    let msg = message(
        admin,
        ch,
        lead,
        Some(root),
        json!({ "kind": "delegation", "delegation": { "open": members } }),
    )
    .await;
    let d: String = sqlx::query_scalar(
        "insert into team_delegation(message_id, lead_account_id, channel_id, thread_root_id, deadline_at) \
         values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, now() + interval '1 hour') returning id::text",
    )
    .bind(&msg)
    .bind(lead)
    .bind(ch)
    .bind(root)
    .fetch_one(admin)
    .await
    .unwrap();
    for m in members {
        sqlx::query("insert into team_delegation_item(delegation_id, delegate_account_id) values ($1::uuid, $2::uuid)")
            .bind(&d)
            .bind(m)
            .execute(admin)
            .await
            .unwrap();
    }
    d
}

async fn outcome(admin: &PgPool, d: &str, who: &str) -> Option<String> {
    sqlx::query_scalar(
        "select outcome from team_delegation_item where delegation_id = $1::uuid and delegate_account_id = $2::uuid",
    )
    .bind(d)
    .bind(who)
    .fetch_one(admin)
    .await
    .unwrap()
}

async fn audits(admin: &PgPool, actor: &str) -> Vec<(String, Option<String>, Value)> {
    let rows: Vec<(String, Option<String>, String)> = sqlx::query_as(
        "select action, target, detail::text from audit_log where actor_id = $1::uuid order by id",
    )
    .bind(actor)
    .fetch_all(admin)
    .await
    .unwrap();
    rows.into_iter()
        .map(|(a, t, d)| (a, t, serde_json::from_str(&d).unwrap()))
        .collect()
}

fn sess(sid: &str, agent: &str, ch: &str, root: &str, at: &str) -> Value {
    json!({ "sessionId": sid, "agentAccountId": agent, "channelId": ch, "threadRootId": root,
            "harness": "claude", "mode": "mention", "startedAt": at })
}

/// 러너 하나를 허브에 붙이고 세션을 알린다. 러너가 받은 프레임을 돌려준다.
fn runner(
    hub: &RelayHub,
    agent: &str,
    caps: &[&str],
    sessions: Vec<Value>,
) -> Arc<Mutex<Vec<Value>>> {
    let got = Arc::new(Mutex::new(vec![]));
    let g = got.clone();
    hub.add_runner(
        agent,
        Arc::new(move |f: &Value| {
            g.lock().unwrap().push(f.clone());
            true
        }),
    );
    let Value::Object(frame) = json!({ "type": "announce", "sessions": sessions, "caps": caps })
    else {
        unreachable!()
    };
    hub.on_runner_frame(agent, &frame);
    got
}

fn parse(out: Option<String>) -> Value {
    let s = out.expect("Rust must answer (not hand over to TS)");
    let v: Value = serde_json::from_str(&s).unwrap();
    let text = v["content"][0]["text"].as_str().unwrap_or("").to_owned();
    serde_json::from_str(&text).unwrap_or(v)
}

fn code(v: &Value) -> String {
    let s = v.to_string();
    for c in ["forbidden", "not_delegator", "internal"] {
        if s.contains(c) {
            return c.into();
        }
    }
    s
}

#[tokio::test]
async fn turn_cancel_answers_like_ts() {
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
    let tag = format!("tc{}", std::process::id());
    let lead_h = format!("{tag}-lead");
    let lead = account(&admin, &lead_h).await;
    let a = account(&admin, &format!("{tag}-a")).await;
    let b = account(&admin, &format!("{tag}-b")).await;
    let outsider_h = format!("{tag}-out");
    let outsider = account(&admin, &outsider_h).await;
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility) values ($1, 'standard', 'private') returning id::text",
    )
    .bind(format!("{tag}-ch"))
    .fetch_one(&admin)
    .await
    .unwrap();
    for m in [&lead, &a, &b] {
        sqlx::query(
            "insert into channel_member(channel_id, account_id) values ($1::uuid, $2::uuid)",
        )
        .bind(&ch)
        .bind(m)
        .execute(&admin)
        .await
        .unwrap();
    }
    let root = message(&admin, &ch, &lead, None, json!({})).await;
    let other_root = message(&admin, &ch, &lead, None, json!({})).await;

    let hub = RelayHub::new(None);
    let link = RelayLink::spawn(
        hub.clone(),
        OperatorHub::new(),
        db_assign_check(admin.clone()),
        LinkHooks::default(),
    );
    let rc = RelayCore::new(
        admin.clone(),
        write.clone(),
        Arc::new(harkroom_server::trust_proxy::TrustProxy::None),
        link,
        None,
        harkroom_server::core::ws::Timing::from_env(),
        settle_hook(write.clone()),
    );
    let lead_me = me(&lead, &lead_h);
    let args = |extra: Value| {
        let mut m: Map<String, Value> = Map::new();
        m.insert("channelId".into(), json!(ch));
        m.insert("threadRootId".into(), json!(root));
        if let Value::Object(e) = extra {
            m.extend(e);
        }
        Value::Object(m)
    };

    // ── 틀린 인자는 TS(zod)로 넘긴다 ──
    assert!(
        answer(
            &admin,
            &rc,
            &lead_me,
            &json!({ "channelId": "x", "threadRootId": root })
        )
        .await
        .is_none()
    );
    assert!(
        answer(&admin, &rc, &lead_me, &args(json!({ "sessionId": "nope" })))
            .await
            .is_none()
    );

    // ── 멤버가 아니면 forbidden ──
    let v = parse(answer(&admin, &rc, &me(&outsider, &outsider_h), &args(json!({}))).await);
    assert_eq!(code(&v), "forbidden", "{v}");

    // ── 넘긴 일이 없으면 not_delegator ──
    let v = parse(answer(&admin, &rc, &lead_me, &args(json!({}))).await);
    assert_eq!(code(&v), "not_delegator", "{v}");

    // a·b 에게 넘김. 다른 스레드에 넘긴 것은 이 스레드의 근거가 아니다.
    let d = delegation(&admin, &ch, &root, &lead, &[&a, &b]).await;

    // ── 도는 턴이 없으면 빈 결과 + note ──
    let v = parse(answer(&admin, &rc, &lead_me, &args(json!({}))).await);
    assert_eq!(v["canceled"], json!([]), "{v}");
    assert_eq!(v["failed"], json!([]), "{v}");
    assert!(v["note"].is_string(), "{v}");

    // a: cancel 을 알아듣는 러너 — 이 스레드 sa1, 다른 스레드 sa2. b: 옛 러너(cancel 모름) — 이 스레드 sb1.
    // outsider 는 넘긴 팀원이 아니다 — 같은 스레드여도 건드리지 않는다.
    let sid = |n: u8| format!("00000000-0000-4000-8000-{n:012}");
    let (sa1, sa2, sb1, so1) = (sid(1), sid(2), sid(3), sid(4));
    let a_got = runner(
        &hub,
        &a,
        &["cancel"],
        vec![
            sess(&sa1, &a, &ch, &root, "2026-11-18T00:00:01.000Z"),
            sess(&sa2, &a, &ch, &other_root, "2026-11-18T00:00:02.000Z"),
        ],
    );
    let b_got = runner(
        &hub,
        &b,
        &[],
        vec![sess(&sb1, &b, &ch, &root, "2026-11-18T00:00:03.000Z")],
    );
    let o_got = runner(
        &hub,
        &outsider,
        &["cancel"],
        vec![sess(
            &so1,
            &outsider,
            &ch,
            &root,
            "2026-11-18T00:00:04.000Z",
        )],
    );
    let cancels = |g: &Arc<Mutex<Vec<Value>>>| -> Vec<Value> {
        g.lock()
            .unwrap()
            .iter()
            .filter(|f| f["type"] == "session.cancel")
            .cloned()
            .collect()
    };

    // ── sessionId 로 거르면 그 세션만 — 다른 스레드의 sa2 는 이 스레드 대상이 아니라 note ──
    let v = parse(answer(&admin, &rc, &lead_me, &args(json!({ "sessionId": sa2 }))).await);
    assert_eq!(v["canceled"], json!([]), "{v}");
    assert!(v["note"].is_string(), "{v}");
    assert!(cancels(&a_got).is_empty());

    // ── 이 스레드의 팀원 세션: sa1 은 멈춤, sb1 은 옛 러너라 failed(runner_outdated), so1·sa2 는 건드리지 않음 ──
    let v = parse(answer(&admin, &rc, &lead_me, &args(json!({}))).await);
    assert_eq!(
        v["canceled"],
        json!([{ "sessionId": sa1, "agentAccountId": a }]),
        "{v}"
    );
    assert_eq!(
        v["failed"],
        json!([{ "sessionId": sb1, "agentAccountId": b, "code": "runner_outdated" }]),
        "{v}"
    );
    assert!(v.get("note").is_none(), "{v}");
    assert_eq!(
        cancels(&a_got),
        vec![json!({ "type": "session.cancel", "sessionId": sa1, "byHandle": lead_h })]
    );
    assert!(cancels(&b_got).is_empty());
    assert!(cancels(&o_got).is_empty());

    // 정리: a 의 의무는 닫히고 b 는 그대로 열려 있다.
    assert!(
        outcome(&admin, &d, &a).await.is_some(),
        "a's item must be settled"
    );
    assert_eq!(outcome(&admin, &d, &b).await, None);

    // 감사: 사람의 [그만두기]와 같은 액션, via delegator, 멈춘 것만.
    let au = audits(&admin, &lead).await;
    assert_eq!(au.len(), 1, "{au:?}");
    assert_eq!(au[0].0, "agent.turn.canceled");
    assert_eq!(au[0].1.as_deref(), Some(a.as_str()));
    assert_eq!(
        au[0].2,
        json!({ "sessionId": sa1, "channelId": ch, "via": "delegator" })
    );

    // ── a 의 의무가 닫혔으니 남은 팀원은 b 뿐 — 다시 눌러도 a 는 대상이 아니다 ──
    let v = parse(answer(&admin, &rc, &lead_me, &args(json!({}))).await);
    assert_eq!(v["canceled"], json!([]), "{v}");
    assert_eq!(v["failed"].as_array().map(Vec::len), Some(1), "{v}");
    assert_eq!(cancels(&a_got).len(), 1);
}
