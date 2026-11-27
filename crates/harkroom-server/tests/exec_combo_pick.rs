//! J2b — `agent.call` 의 `agentModels[].comboId` 가 허용 목록을 지나 스레드 지정으로 남고, 조합·허용 목록이 바뀌면
//! 그 지정이 따라가는 것을 실제 스키마에서 본다(`core/agent_model_picks.rs`·`core/exec_combo.rs`, migration 203).
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 넘긴다).
use harkroom_server::auth::{Account, Auth, Via};
use harkroom_server::core::agent_model_picks::{self as picks, Pick};
use harkroom_server::core::exec_combo::{self as ec, ComboInput};
use serde_json::json;
use sqlx::PgPool;
use std::collections::HashSet;

async fn mk(pool: &PgPool, handle: &str, kind: &str, role: &str) -> Account {
    let is_admin = matches!(role, "owner" | "admin");
    let id: String = sqlx::query_scalar(
        "insert into account(handle, display_name, kind, login_id, role, is_admin) \
         values ($1, $1, $2, case when $2 = 'human' then $1 end, $3, $4) returning id::text",
    )
    .bind(handle)
    .bind(kind)
    .bind(role)
    .bind(is_admin)
    .fetch_one(pool)
    .await
    .unwrap();
    Account {
        id,
        handle: handle.into(),
        display_name: handle.into(),
        kind: kind.into(),
        is_admin,
        role: role.into(),
        status: "online".into(),
        status_text: None,
        avatar_attachment_id: None,
    }
}

async fn agent(pool: &PgPool, handle: &str, owner: &Account) -> Account {
    let a = mk(pool, handle, "agent", "member").await;
    sqlx::query(
        "insert into agent_config(account_id, owner_account_id) values ($1::uuid, $2::uuid)",
    )
    .bind(&a.id)
    .bind(&owner.id)
    .execute(pool)
    .await
    .unwrap();
    a
}

fn combo(name: &str, harness: &str, model: &str, effort: Option<&str>) -> ComboInput {
    ComboInput::parse(&json!({
        "name": name, "harness": harness, "model": model, "effort": effort, "accountPool": "main"
    }))
    .unwrap()
}

async fn root(pool: &PgPool, channel: &str, author: &Account) -> String {
    sqlx::query_scalar(
        "insert into message(channel_id, author_id, body, kind, meta) \
         values ($1::uuid, $2::uuid, 'x', 'user', '{}') returning id::text",
    )
    .bind(channel)
    .bind(&author.id)
    .fetch_one(pool)
    .await
    .unwrap()
}

/// 그 스레드·에이전트의 지정 — (정한 쪽, model, effort, combo_id).
type Row = (String, Option<String>, Option<String>, Option<String>);

async fn held(pool: &PgPool, root: &str, agent: &Account) -> Option<Row> {
    sqlx::query_as(
        "select set_by_kind, model, effort, combo_id::text from thread_agent_model \
          where thread_root_id = $1::uuid and agent_id = $2::uuid",
    )
    .bind(root)
    .bind(&agent.id)
    .fetch_optional(pool)
    .await
    .unwrap()
}

fn pick(agent: &Account, combo_id: &str) -> Pick {
    Pick {
        agent_id: agent.id.clone(),
        model: None,
        effort: None,
        combo_id: Some(combo_id.to_owned()),
    }
}

/// 게시 tx 처럼 돈다 — 지나면 커밋, 거절이면 롤백하고 (상태, 코드)를 돌려준다.
async fn call(
    pool: &PgPool,
    channel: &str,
    root: &str,
    actor: &Account,
    p: Pick,
) -> Result<Vec<picks::Change>, (u16, String)> {
    let notified: HashSet<String> = [p.agent_id.clone()].into();
    let mut tx = pool.begin().await.unwrap();
    match picks::apply(&mut tx, channel, root, &actor.id, &[p], &notified)
        .await
        .unwrap()
    {
        Ok(changes) => {
            tx.commit().await.unwrap();
            Ok(changes)
        }
        Err(r) => {
            let (status, code) = r.status_code();
            Err((status, code.to_owned()))
        }
    }
}

#[tokio::test]
async fn combo_pick_follows_allow_list_and_combo_edits() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let s = Auth {
        via: Some(Via::Session),
        ..Auth::default()
    };
    let admin = mk(&pool, "xp-admin", "human", "admin").await;
    let owner = mk(&pool, "xp-owner", "human", "member").await;
    let caller = agent(&pool, "xp-caller", &owner).await;
    let bot = agent(&pool, "xp-bot", &owner).await;
    let other = agent(&pool, "xp-other", &owner).await;
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('xp-combo-pick', 'standard') returning id::text",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let c1 = ec::create_combo(
        &pool,
        &admin,
        &s,
        &combo("xp-one", "claude-code", "m", Some("high")),
    )
    .await
    .unwrap();
    let c2 = ec::create_combo(&pool, &admin, &s, &combo("xp-codex", "codex", "g", None))
        .await
        .unwrap();
    for c in [&c1, &c2] {
        ec::allow_add(&pool, &owner, &s, &bot.id, c).await.unwrap();
    }
    let r1 = root(&pool, &ch, &owner).await;

    // ⓪ 기능이 꺼져 있으면(붙이는 조건을 못 지난 서버) 조합은 못 고른다 — 허용 목록에 있어도.
    assert_eq!(
        call(&pool, &ch, &r1, &caller, pick(&bot, &c1)).await,
        Err((409, "combo_off".into()))
    );
    assert!(held(&pool, &r1, &bot).await.is_none());
    ec::enable(pool.clone());

    // ⓪′ `agent.modelOptions` 가 싣는 조합 — 그 에이전트 허용 목록 중 지금 하네스와 맞는 것만(codex 조합은 빠진다).
    use harkroom_server::core::mcp::model_options::allowed_combos;
    assert_eq!(
        allowed_combos(&pool, &bot.id, "claude-code").await.unwrap(),
        vec![(c1.clone(), "xp-one".into(), "m".into(), Some("high".into()))]
    );
    assert_eq!(
        allowed_combos(&pool, &bot.id, "codex").await.unwrap(),
        vec![(c2.clone(), "xp-codex".into(), "g".into(), None)]
    );
    assert!(
        allowed_combos(&pool, &other.id, "claude-code")
            .await
            .unwrap()
            .is_empty()
    );

    // ① 허용된 조합 — 조합의 model·effort 가 그 스레드 줄에 베껴지고 combo_id 가 남는다.
    let changes = call(&pool, &ch, &r1, &caller, pick(&bot, &c1))
        .await
        .unwrap();
    assert_eq!(
        changes,
        vec![(
            bot.id.clone(),
            Some((Some("m".into()), Some("high".into())))
        )]
    );
    assert_eq!(
        held(&pool, &r1, &bot).await,
        Some((
            "agent".into(),
            Some("m".into()),
            Some("high".into()),
            Some(c1.clone())
        ))
    );
    // 같은 조합을 다시 고르면 바뀐 것이 없다(스레드 상한을 쓰지 않는다).
    assert!(
        call(&pool, &ch, &r1, &caller, pick(&bot, &c1))
            .await
            .unwrap()
            .is_empty()
    );

    // ② 거절 — 그 에이전트 허용 목록에 없는 조합 · 없는 조합 · 하네스가 다른 조합 · model 을 같이 준 것.
    assert_eq!(
        call(&pool, &ch, &r1, &caller, pick(&other, &c1)).await,
        Err((403, "combo_not_allowed".into()))
    );
    assert_eq!(
        call(
            &pool,
            &ch,
            &r1,
            &caller,
            pick(&bot, "00000000-0000-4000-8000-00000000beef")
        )
        .await,
        Err((403, "combo_not_allowed".into()))
    );
    assert_eq!(
        call(&pool, &ch, &r1, &caller, pick(&bot, &c2)).await,
        Err((403, "combo_harness_mismatch".into()))
    );
    let mut both = pick(&bot, &c1);
    both.model = Some("m".into());
    assert_eq!(
        call(&pool, &ch, &r1, &caller, both).await,
        Err((400, "combo_with_model".into()))
    );
    assert!(held(&pool, &r1, &other).await.is_none());
    assert_eq!(
        held(&pool, &r1, &bot).await.unwrap().3,
        Some(c1.clone()),
        "거절은 있던 지정을 건드리지 않는다"
    );

    // ③ 조합을 고치면 그 조합으로 정한 스레드 줄이 따라간다. 하네스가 달라지면 지운다.
    ec::update_combo(
        &pool,
        &admin,
        &s,
        &c1,
        &combo("xp-one", "claude-code", "m9", None),
    )
    .await
    .unwrap();
    assert_eq!(
        held(&pool, &r1, &bot).await,
        Some(("agent".into(), Some("m9".into()), None, Some(c1.clone())))
    );
    ec::update_combo(
        &pool,
        &admin,
        &s,
        &c1,
        &combo("xp-one", "codex", "m9", None),
    )
    .await
    .unwrap();
    assert!(held(&pool, &r1, &bot).await.is_none());
    ec::update_combo(
        &pool,
        &admin,
        &s,
        &c1,
        &combo("xp-one", "claude-code", "m", Some("high")),
    )
    .await
    .unwrap();

    // ④ 허용 목록에서 빼면 그 에이전트의 스레드 줄이 사라지고, 다시 고를 수 없다. 다른 에이전트의 줄은 남는다.
    ec::allow_add(&pool, &owner, &s, &other.id, &c1)
        .await
        .unwrap();
    let r2 = root(&pool, &ch, &owner).await;
    call(&pool, &ch, &r2, &caller, pick(&bot, &c1))
        .await
        .unwrap();
    call(&pool, &ch, &r2, &caller, pick(&other, &c1))
        .await
        .unwrap();
    ec::allow_remove(&pool, &owner, &s, &bot.id, &c1)
        .await
        .unwrap();
    assert!(held(&pool, &r2, &bot).await.is_none());
    assert_eq!(held(&pool, &r2, &other).await.unwrap().3, Some(c1.clone()));
    assert_eq!(
        call(&pool, &ch, &r2, &caller, pick(&bot, &c1)).await,
        Err((403, "combo_not_allowed".into()))
    );
    ec::allow_add(&pool, &owner, &s, &bot.id, &c1)
        .await
        .unwrap();

    // ⑤ 사람이 정한 줄은 조합으로도 덮지 못한다.
    let r3 = root(&pool, &ch, &owner).await;
    sqlx::query(
        "insert into thread_agent_model (thread_root_id, agent_id, harness, model, set_by, set_by_kind) \
         values ($1::uuid, $2::uuid, 'claude-code', 'pinned', $3::uuid, 'human')",
    )
    .bind(&r3)
    .bind(&bot.id)
    .bind(&owner.id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        call(&pool, &ch, &r3, &caller, pick(&bot, &c1)).await,
        Err((409, "human_pinned".into()))
    );
    assert_eq!(
        held(&pool, &r3, &bot).await,
        Some(("human".into(), Some("pinned".into()), None, None))
    );

    // ⑥ 조합으로 정한 줄도 풀기(model·effort·comboId 모두 없음)로 지운다.
    let r4 = root(&pool, &ch, &owner).await;
    call(&pool, &ch, &r4, &caller, pick(&bot, &c1))
        .await
        .unwrap();
    let cleared = Pick {
        agent_id: bot.id.clone(),
        model: None,
        effort: None,
        combo_id: None,
    };
    assert_eq!(
        call(&pool, &ch, &r4, &caller, cleared).await.unwrap(),
        vec![(bot.id.clone(), None)]
    );
    assert!(held(&pool, &r4, &bot).await.is_none());

    // ⑦ 조합을 지우면 그 조합으로 정한 지정도 같이 지워진다(cascade). 사람이 정한 줄은 남는다.
    call(&pool, &ch, &r4, &caller, pick(&bot, &c1))
        .await
        .unwrap();
    ec::delete_combo(&pool, &admin, &s, &c1).await.unwrap();
    assert!(held(&pool, &r4, &bot).await.is_none());
    assert!(held(&pool, &r2, &other).await.is_none());
    assert!(held(&pool, &r3, &bot).await.is_some());
}
