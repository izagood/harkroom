//! U1 — `agent.call` 의 `expect`(report·reply)가 호출 게이트를 지난 대상에게만 의무를 세우는지, `reply` 의무가 담당의 첫 답글로
//! 닫히는지, 새 부름이 **같은 넘긴 쪽**의 앞 의무만 대체하는지를 실제 스키마에서 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 넘긴다).
use harkroom_server::auth::Account;
use harkroom_server::core::mcp::msg_post::{answer, answer_call};
use harkroom_server::core::msg_post::PostState;
use serde_json::{Value, json};
use sqlx::PgPool;

async fn mk(pool: &PgPool, handle: &str, kind: &str) -> Account {
    let id: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id, role, is_admin) \
         values ($1, $1, $2, case when $2 = 'human' then $1 end, 'member', false) returning id::text",
    )
    .bind(handle)
    .bind(kind)
    .fetch_one(pool)
    .await
    .unwrap();
    Account {
        id,
        handle: handle.into(),
        display_name: handle.into(),
        kind: kind.into(),
        is_admin: false,
        role: "member".into(),
        status: "online".into(),
        status_text: None,
        avatar_attachment_id: None,
    }
}

async fn agent(pool: &PgPool, handle: &str, owner: &Account, online: bool) -> Account {
    let a = mk(pool, handle, "agent").await;
    sqlx::query(
        "insert into agent_config(account_id, invoke_scope, owner_account_id) values ($1::uuid, 'owner', $2::uuid)",
    )
    .bind(&a.id)
    .bind(&owner.id)
    .execute(pool)
    .await
    .unwrap();
    if online {
        sqlx::query(
            "insert into agent_presence(account_id, expires_at) values ($1::uuid, now() + interval '5 minutes')",
        )
        .bind(&a.id)
        .execute(pool)
        .await
        .unwrap();
    }
    a
}

/// (위임 id, 넘긴 쪽, 닫는 조건, 담당, 결말 — 열려 있으면 없음) — 이 스레드의 의무 행 전부, 세운 순서로.
type Row = (String, String, String, String, Option<String>);

async fn rows(pool: &PgPool, root: &str) -> Vec<Row> {
    sqlx::query_as(
        "select d.id::text, d.lead_account_id::text, d.close_on, i.delegate_account_id::text, i.outcome \
           from team_delegation d join team_delegation_item i on i.delegation_id = d.id \
          where d.thread_root_id = $1::uuid order by d.created_at, d.id",
    )
    .bind(root)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// 도구 결과(`content[0].text`)의 안쪽 JSON.
fn inner(result: &str) -> Value {
    let v: Value = serde_json::from_str(result).unwrap();
    serde_json::from_str(v["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn expect_makes_obligations_only_for_gate_passed_targets() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    // 스위치는 처음 읽힐 때 한 번만 읽힌다 — 이 바이너리의 시험은 이것 하나다.
    unsafe {
        std::env::set_var("HARKROOM_DELEGATION_V2", "on");
        std::env::set_var("HARKROOM_DELEGATION_IMPLICIT", "off");
    }
    let pool = PgPool::connect(&url).await.unwrap();
    let st = PostState {
        read: pool.clone(),
        write: pool.clone(),
        up: harkroom_server::proxy::Upstream::new("http://127.0.0.1:0"),
        implicit_ok: true,
    };
    let alice = mk(&pool, "ce-alice", "human").await;
    let bob = mk(&pool, "ce-bob", "human").await;
    let me = agent(&pool, "ce-me", &alice, true).await;
    let other = agent(&pool, "ce-other", &alice, true).await;
    let mate = agent(&pool, "ce-mate", &alice, true).await;
    // 남의 에이전트(범위 owner) — 호출 게이트가 막는다. 접속은 해 있다.
    let closed = agent(&pool, "ce-closed", &bob, true).await;
    // 접속하지 않은 에이전트.
    let away = agent(&pool, "ce-away", &alice, false).await;
    let channel: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility, created_by) values ('ce-ch', 'standard', 'public', $1::uuid) returning id::text",
    )
    .bind(&alice.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let root: String = sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind) values ($1::uuid, $2::uuid, 'root', 'user') returning id::text",
    )
    .bind(&channel)
    .bind(&alice.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    let call = |who: &Account, extra: Value| {
        let mut args = json!({ "channelId": channel, "threadRootId": root, "body": "해 줘" });
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (st, who) = (&st, who.clone());
        async move {
            answer_call(st, &who, &args, None, None, false, true, false)
                .await
                .expect("answered")
        }
    };
    let say = |who: &Account, body: &str| {
        let args = json!({ "channelId": channel, "threadRootId": root, "body": body });
        let (st, who) = (&st, who.clone());
        async move {
            answer(st, &who, &args, None, None, false)
                .await
                .expect("posted")
        }
    };

    // 꼴 거절 — 아무것도 쓰지 않는다.
    let no_thread = answer_call(
        &st,
        &me,
        &json!({ "channelId": channel, "body": "x", "to": ["ce-mate"], "expect": "report" }),
        None,
        None,
        false,
        true,
        false,
    )
    .await
    .expect("answered");
    assert!(no_thread.contains("bad_request"), "{no_thread}");
    let stray = call(&me, json!({ "to": ["ce-mate"], "deadlineSec": 60 })).await;
    assert!(stray.contains("bad_request"), "{stray}");
    let one = call(
        &me,
        json!({ "to": ["ce-mate"], "expect": "reply", "planGroupId": "g1" }),
    )
    .await;
    assert!(one.contains("bad_request"), "{one}");
    // 게이트가 막는 대상뿐 · 접속하지 않은 대상뿐 — 글도 의무도 없다.
    let denied = call(&me, json!({ "to": ["ce-closed"], "expect": "reply" })).await;
    assert!(denied.contains("not_invokable"), "{denied}");
    let offline = call(&me, json!({ "to": ["ce-away"], "expect": "report" })).await;
    assert!(offline.contains("unreachable"), "{offline}");
    assert!(rows(&pool, &root).await.is_empty());
    let posted: i64 =
        sqlx::query_scalar("select count(*) from message where thread_root_id = $1::uuid")
            .bind(&root)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(posted, 0);

    // 묻기(`reply`) — 게이트를 지난 대상에게만 의무가 선다. 막힌 대상·접속하지 않은 대상은 `notCalled` 에만 실린다.
    let asked = call(
        &me,
        json!({ "to": ["ce-mate", "ce-closed", "ce-away"], "expect": "reply", "deadlineSec": 120 }),
    )
    .await;
    let v = inner(&asked);
    assert!(v["delegationId"].is_string(), "{asked}");
    assert!(v["deadlineAt"].is_string(), "{asked}");
    assert_eq!(v["expect"], "reply", "{asked}");
    assert_eq!(v["called"], json!([mate.id]), "{asked}");
    let why = |h: &str| {
        v["notCalled"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["handle"] == h)
            .map(|x| x["reason"].as_str().unwrap().to_owned())
    };
    assert_eq!(why("ce-closed").as_deref(), Some("gate_denied"), "{asked}");
    assert_eq!(why("ce-away").as_deref(), Some("unreachable"), "{asked}");
    // 그 글은 위임 글이고(`meta.kind`), 열린 담당은 지난 대상 하나다.
    assert_eq!(v["message"]["meta"]["kind"], "delegation", "{asked}");
    assert_eq!(
        v["message"]["meta"]["delegation"]["open"],
        json!([mate.id]),
        "{asked}"
    );
    let r = rows(&pool, &root).await;
    assert_eq!(r.len(), 1, "{r:?}");
    assert_eq!(
        (r[0].1.as_str(), r[0].2.as_str(), r[0].3.as_str(), &r[0].4),
        (me.id.as_str(), "reply", mate.id.as_str(), &None)
    );
    // 담당의 부름은 위임 부름이고, 막힌 대상·접속하지 않은 대상에게는 부름이 없다.
    let inbox: Vec<(String, String)> =
        sqlx::query_as("select account_id::text, reason from inbox where message_id = $1::uuid")
            .bind(v["message"]["id"].as_str().unwrap())
            .fetch_all(&pool)
            .await
            .unwrap();
    assert!(
        inbox.contains(&(mate.id.clone(), "team_delegated".to_owned())),
        "{inbox:?}"
    );
    assert!(
        inbox.iter().all(|(a, _)| *a != closed.id && *a != away.id),
        "{inbox:?}"
    );

    // 넘긴 쪽의 글은 닫지 않는다. 담당의 첫 답글이 닫는다.
    say(&me, "덧붙임").await;
    assert_eq!(rows(&pool, &root).await[0].4, None);
    say(&mate, "답").await;
    let r = rows(&pool, &root).await;
    assert_eq!(r[0].4.as_deref(), Some("reported"), "{r:?}");

    // 일 넘기기(`report`) — 보통 답글로는 닫히지 않는다.
    let handed = call(&me, json!({ "to": ["@ce-mate"], "expect": "report" })).await;
    assert_eq!(inner(&handed)["expect"], "report", "{handed}");
    say(&mate, "하는 중").await;
    let r = rows(&pool, &root).await;
    assert_eq!(r.len(), 2, "{r:?}");
    assert_eq!((r[1].2.as_str(), &r[1].4), ("report", &None), "{r:?}");

    // 다른 넘긴 쪽이 같은 담당을 불러도 내 의무는 열린 채다 — 대체는 같은 넘긴 쪽의 앞 의무만.
    call(&other, json!({ "to": ["ce-mate"], "expect": "report" })).await;
    let r = rows(&pool, &root).await;
    assert_eq!(r.len(), 3, "{r:?}");
    assert_eq!(r[1].4, None, "남의 새 부름이 내 의무를 닫지 않는다: {r:?}");
    assert_eq!((r[2].1.as_str(), &r[2].4), (other.id.as_str(), &None));
    // 내가 다시 부르면 내 앞 의무만 대체된다.
    call(&me, json!({ "to": ["ce-mate"], "expect": "report" })).await;
    let r = rows(&pool, &root).await;
    assert_eq!(r.len(), 4, "{r:?}");
    assert_eq!(r[1].4.as_deref(), Some("closed"), "{r:?}");
    assert_eq!(r[2].4, None, "{r:?}");
    assert_eq!((r[3].1.as_str(), &r[3].4), (me.id.as_str(), &None));

    // 의무 없는 부름(기본)은 예전 그대로 — 의무도 위임 글도 아니다.
    let plain = call(&me, json!({ "to": ["ce-mate"] })).await;
    let v = inner(&plain);
    assert!(v.get("delegationId").is_none(), "{plain}");
    assert!(v["message"]["meta"].get("kind").is_none(), "{plain}");
    assert_eq!(rows(&pool, &root).await.len(), 4);
}
