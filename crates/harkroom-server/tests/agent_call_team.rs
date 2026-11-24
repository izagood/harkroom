//! T2 — `agent.call` 의 `to` 에 팀을 적으면 팀원으로 펼치고, **팀원마다** 호출 게이트를 지난 대상만 깨어나고 의무를 받는지 실제
//! 스키마에서 본다. 부른 쪽이 그 팀의 팀장이어도 건너뛰지 않는다. 팀의 호출 범위가 막으면 명단을 펼치지 않는다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 넘긴다).
use harkroom_server::auth::Account;
use harkroom_server::core::mcp::msg_post::answer_call;
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

/// 팀을 만든다 — `lead` 가 있으면 팀장으로 둔다. 팀원은 `members`.
async fn team(
    pool: &PgPool,
    name: &str,
    scope: &str,
    owner: &Account,
    lead: Option<&Account>,
    members: &[&Account],
) -> String {
    let id: String = sqlx::query_scalar(
        "insert into agent_team(name, created_by, invoke_scope, owner_account_id) \
         values ($1, $2::uuid, $3, $2::uuid) returning id::text",
    )
    .bind(name)
    .bind(&owner.id)
    .bind(scope)
    .fetch_one(pool)
    .await
    .unwrap();
    for m in members {
        sqlx::query(
            "insert into agent_team_member(team_id, agent_account_id) values ($1::uuid, $2::uuid)",
        )
        .bind(&id)
        .bind(&m.id)
        .execute(pool)
        .await
        .unwrap();
    }
    if let Some(l) = lead {
        sqlx::query("update agent_team set lead_account_id = $2::uuid where id = $1::uuid")
            .bind(&id)
            .bind(&l.id)
            .execute(pool)
            .await
            .unwrap();
    }
    id
}

/// (담당, 위임 행의 팀 칸) — 이 스레드의 의무 행 전부.
async fn rows(pool: &PgPool, root: &str) -> Vec<(String, Option<String>)> {
    sqlx::query_as(
        "select i.delegate_account_id::text, d.team_id::text \
           from team_delegation d join team_delegation_item i on i.delegation_id = d.id \
          where d.thread_root_id = $1::uuid order by d.created_at, d.id",
    )
    .bind(root)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn posted(pool: &PgPool, root: &str) -> i64 {
    sqlx::query_scalar("select count(*) from message where thread_root_id = $1::uuid")
        .bind(root)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// 도구 결과(`content[0].text`)의 안쪽 JSON.
fn inner(result: &str) -> Value {
    let v: Value = serde_json::from_str(result).unwrap();
    serde_json::from_str(v["content"][0]["text"].as_str().unwrap()).unwrap()
}

#[tokio::test]
async fn team_in_to_expands_and_gates_each_member() {
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
    let alice = mk(&pool, "ct-alice", "human").await;
    let bob = mk(&pool, "ct-bob", "human").await;
    let me = agent(&pool, "ct-me", &alice, true).await;
    let mate = agent(&pool, "ct-mate", &alice, true).await;
    // 남의 에이전트(범위 owner) — 호출 게이트가 막는다. 접속은 해 있다.
    let closed = agent(&pool, "ct-closed", &bob, true).await;
    // 접속하지 않은 에이전트.
    let away = agent(&pool, "ct-away", &alice, false).await;
    // 꺼진 에이전트 — 펼칠 때 빠지고 `notCalled` 에 `disabled` 로 실린다.
    let off = agent(&pool, "ct-off", &alice, true).await;
    sqlx::query("update account set disabled_at = now() where id = $1::uuid")
        .bind(&off.id)
        .execute(&pool)
        .await
        .unwrap();
    let channel: String = sqlx::query_scalar(
        "insert into channel(name, kind, visibility, created_by) values ('ct-ch', 'standard', 'public', $1::uuid) returning id::text",
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
    // 부른 쪽(`me`)이 **팀장**인 팀 — 팀장이어도 팀원의 호출 게이트를 건너뛰지 않는다.
    let crew = team(
        &pool,
        "ct-crew",
        "community",
        &alice,
        Some(&me),
        // 사람(`bob`)은 라우트가 팀원으로 받지 않지만 표에는 그 제약이 없다 — 표에 직접 넣어 본다.
        &[&me, &mate, &closed, &away, &bob, &off],
    )
    .await;
    // 호출 범위가 owner 인 팀 — 에이전트인 부른 쪽은 팀을 부를 수 없다(팀원은 부를 수 있는 사이여도).
    team(&pool, "ct-own", "owner", &alice, None, &[&mate]).await;
    // 막히는 팀원뿐인 팀.
    team(&pool, "ct-far", "community", &bob, None, &[&closed]).await;
    let call = |extra: Value| {
        let mut args = json!({ "channelId": channel, "threadRootId": root, "body": "해 줘" });
        args.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        let (st, who) = (&st, me.clone());
        async move {
            answer_call(st, &who, &args, None, None, false, true, false)
                .await
                .expect("answered")
        }
    };

    // 팀의 호출 범위가 막는다 · 팀원이 모두 게이트에 막힌다 — 글도 의무도 없다.
    let own = call(json!({ "to": ["ct-own"], "expect": "report" })).await;
    assert!(own.contains("not_callable"), "{own}");
    let far = call(json!({ "to": ["@ct-far"], "expect": "report" })).await;
    assert!(far.contains("not_invokable"), "{far}");
    let far_plain = call(json!({ "to": ["ct-far"] })).await;
    assert!(far_plain.contains("not_invokable"), "{far_plain}");
    assert_eq!(posted(&pool, &root).await, 0);
    assert!(rows(&pool, &root).await.is_empty());

    // 팀을 펼친다 — 게이트를 지난 팀원(`mate`)만 깨어나고 의무를 받는다. 막힌 팀원·접속하지 않은 팀원은 `notCalled` 에만 실린다.
    let handed = call(json!({ "to": ["ct-crew"], "expect": "report" })).await;
    let v = inner(&handed);
    assert_eq!(v["called"], json!([mate.id]), "{handed}");
    let why = |h: &str| {
        v["notCalled"]
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["handle"] == h)
            .map(|x| x["reason"].as_str().unwrap().to_owned())
    };
    assert_eq!(why("ct-closed").as_deref(), Some("gate_denied"), "{handed}");
    assert_eq!(why("ct-away").as_deref(), Some("unreachable"), "{handed}");
    // 사람·꺼진 팀원은 말없이 빠지지 않는다 — 이유와 함께 실리고, 펼친 명단(`teams.members`)·부름·의무에는 없다.
    assert_eq!(why("ct-bob").as_deref(), Some("not_agent"), "{handed}");
    assert_eq!(why("ct-off").as_deref(), Some("disabled"), "{handed}");
    assert_eq!(
        v["teams"][0]["members"],
        json!(["ct-away", "ct-closed", "ct-mate"]),
        "{handed}"
    );
    assert_eq!(v["teams"][0]["teamId"], json!(crew), "{handed}");
    assert_eq!(v["teams"][0]["team"], "ct-crew", "{handed}");
    assert_eq!(
        v["message"]["meta"]["delegation"]["open"],
        json!([mate.id]),
        "{handed}"
    );
    // 의무는 지난 팀원 하나뿐이고, 위임 행에 팀을 적지 않는다(팀 명단 갈래가 아니다).
    assert_eq!(rows(&pool, &root).await, vec![(mate.id.clone(), None)]);
    // 막힌 팀원에게는 부름(inbox)이 서지 않는다.
    let woke: i64 = sqlx::query_scalar("select count(*) from inbox where account_id = $1::uuid")
        .bind(&closed.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(woke, 0);
    let woke_skipped: i64 =
        sqlx::query_scalar("select count(*) from inbox where account_id = any($1::uuid[])")
            .bind(vec![bob.id.clone(), off.id.clone()])
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(woke_skipped, 0);

    // 팀 id 로도 같다 · 알리기(`expect` 없음)도 같은 게이트를 지난다.
    let by_id = call(json!({ "to": [crew] })).await;
    let v = inner(&by_id);
    // 알리기는 접속을 보지 않는다 — 접속하지 않은 팀원도 부름을 받는다(팀원 handle 순). 막힌 팀원은 여전히 빠진다.
    assert_eq!(v["called"], json!([away.id, mate.id]), "{by_id}");
    assert!(
        v["notCalled"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["handle"] == "ct-closed" && x["reason"] == "gate_denied"),
        "{by_id}"
    );
    assert!(
        v["notCalled"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["handle"] == "ct-off" && x["reason"] == "disabled"),
        "{by_id}"
    );

    // 펼친 대상이 상한(8)을 넘으면 아무것도 쓰지 않고 거절한다.
    let mut many: Vec<Account> = Vec::new();
    for i in 0..9 {
        many.push(agent(&pool, &format!("ct-m{i}"), &alice, true).await);
    }
    let refs: Vec<&Account> = many.iter().collect();
    team(&pool, "ct-big", "community", &alice, None, &refs).await;
    let before = posted(&pool, &root).await;
    let big = call(json!({ "to": ["ct-big"] })).await;
    assert!(big.contains("too_many_targets"), "{big}");
    assert_eq!(posted(&pool, &root).await, before);
}
