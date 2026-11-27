//! J1 — 실행 조합·키 연결·에이전트 허용 목록의 쓰기 권한과 표 제약을 실제 스키마에서 본다(`core/exec_combo.rs`, migration 185·202).
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `db-tests` 잡이 넘긴다).
use harkroom_server::auth::{Account, Auth, Via};
use harkroom_server::core::exec_combo::{self as ec, ComboError, ComboInput, KeyLinkInput};
use serde_json::json;
use sqlx::PgPool;

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

/// 비밀을 만들고 그 id 를 돌려준다 — 키 연결은 비밀을 id 로 가리킨다(202).
async fn secret(pool: &PgPool, name: &str, owner: &Account) -> String {
    sqlx::query_scalar(
        "insert into secret(name, kind, owner_account_id) values ($1, 'text', $2::uuid) returning id::text",
    )
    .bind(name)
    .bind(&owner.id)
    .fetch_one(pool)
    .await
    .unwrap()
}

fn session() -> Auth {
    Auth {
        via: Some(Via::Session),
        ..Auth::default()
    }
}

fn pool_combo(name: &str) -> ComboInput {
    ComboInput::parse(&json!({
        "name": name, "harness": "claude-code", "model": "m", "effort": "high",
        "accountPool": "main", "inputPrice": 3, "outputPrice": 15, "promoteAllowed": true
    }))
    .unwrap()
}

fn link_input(name: &str, secret_id: &str) -> KeyLinkInput {
    KeyLinkInput::parse(&json!({
        "name": name, "baseUrl": "https://api.example.com/v1", "secretId": secret_id
    }))
    .unwrap()
}

async fn defaults(pool: &PgPool, agent_id: &str) -> Vec<String> {
    sqlx::query_scalar(
        "select combo_id::text from agent_exec_combo where agent_id = $1::uuid and is_default",
    )
    .bind(agent_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[tokio::test]
async fn exec_combo_writes_and_permissions() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let s = session();
    let admin = mk(&pool, "xc-admin", "human", "admin").await;
    let admin2 = mk(&pool, "xc-admin2", "human", "admin").await;
    let member = mk(&pool, "xc-member", "human", "member").await;
    let bot = agent(&pool, "xc-bot", &member).await;
    let admin_key = secret(&pool, "xc-admin-key", &admin).await;
    let member_key = secret(&pool, "xc-member-key", &member).await;
    let no_key = "00000000-0000-4000-8000-00000000beef";

    // ① 관리자가 키 연결·조합을 만들고 목록에서 본다.
    let link = ec::create_key_link(&pool, &admin, &s, &link_input("xc-link", &admin_key))
        .await
        .unwrap();
    let c1 = ec::create_combo(&pool, &admin, &s, &pool_combo("xc-one"))
        .await
        .unwrap();
    let keyed = ComboInput::parse(&json!({
        "name": "xc-keyed", "harness": "codex", "model": "m2", "keyLinkId": link
    }))
    .unwrap();
    let c2 = ec::create_combo(&pool, &admin, &s, &keyed).await.unwrap();
    let links = ec::list_key_links(&pool, &admin, &s).await.unwrap();
    assert_eq!(links.len(), 1);
    assert_eq!(links[0]["secretName"], "xc-admin-key");
    assert_eq!(links[0]["baseUrl"], "https://api.example.com/v1");
    let combos = ec::list_combos(&pool, &member, &s).await.unwrap();
    assert_eq!(combos.len(), 2);
    assert_eq!(combos[0]["name"], "xc-keyed");
    assert_eq!(combos[0]["keyLinkId"], link.as_str());
    assert_eq!(combos[1]["accountPool"], "main");
    assert_eq!(combos[1]["promoteAllowed"], true);
    // 이름 겹침은 Conflict.
    assert!(matches!(
        ec::create_combo(&pool, &admin, &s, &pool_combo("xc-one")).await,
        Err(ComboError::Conflict)
    ));

    // ② 에이전트 계정·일반 사람은 조합·키 연결을 못 쓴다.
    for who in [&bot, &member] {
        assert!(matches!(
            ec::create_combo(&pool, who, &s, &pool_combo("xc-no")).await,
            Err(ComboError::Forbidden)
        ));
        assert!(matches!(
            ec::update_combo(&pool, who, &s, &c1, &pool_combo("xc-no")).await,
            Err(ComboError::Forbidden)
        ));
        assert!(matches!(
            ec::delete_combo(&pool, who, &s, &c1).await,
            Err(ComboError::Forbidden)
        ));
        assert!(matches!(
            ec::create_key_link(&pool, who, &s, &link_input("xc-no", &member_key)).await,
            Err(ComboError::Forbidden)
        ));
    }
    assert_eq!(ec::list_combos(&pool, &admin, &s).await.unwrap().len(), 2);

    // ③ 남의 에이전트 허용 목록은 관리자여도 못 넣는다. 에이전트 자신도 못 넣는다.
    assert!(matches!(
        ec::allow_add(&pool, &admin, &s, &bot.id, &c1).await,
        Err(ComboError::Forbidden)
    ));
    assert!(matches!(
        ec::allow_add(&pool, &bot, &s, &bot.id, &c1).await,
        Err(ComboError::Forbidden)
    ));
    assert!(
        ec::list_allowed(&pool, &member, &s, &bot.id)
            .await
            .unwrap()
            .is_empty()
    );
    // 소유자는 넣는다(두 번 넣어도 한 줄).
    ec::allow_add(&pool, &member, &s, &bot.id, &c1)
        .await
        .unwrap();
    ec::allow_add(&pool, &member, &s, &bot.id, &c1)
        .await
        .unwrap();
    ec::allow_add(&pool, &member, &s, &bot.id, &c2)
        .await
        .unwrap();
    assert_eq!(
        ec::list_allowed(&pool, &member, &s, &bot.id)
            .await
            .unwrap()
            .len(),
        2
    );

    // ④ 남의 비밀로는 키 연결을 만들지도, 고쳐 꽂지도 못한다. 없는 비밀도 같다.
    for name in [member_key.as_str(), no_key] {
        assert!(matches!(
            ec::create_key_link(&pool, &admin, &s, &link_input("xc-steal", name)).await,
            Err(ComboError::Forbidden)
        ));
        assert!(matches!(
            ec::update_key_link(&pool, &admin, &s, &link, &link_input("xc-link", name)).await,
            Err(ComboError::Forbidden)
        ));
    }
    // 다른 관리자는 그 비밀의 소유자가 아니다 — 같은 연결을 고치지 못한다.
    assert!(matches!(
        ec::update_key_link(
            &pool,
            &admin2,
            &s,
            &link,
            &link_input("xc-link", &admin_key)
        )
        .await,
        Err(ComboError::Forbidden)
    ));
    assert_eq!(
        ec::list_key_links(&pool, &admin, &s).await.unwrap()[0]["secretName"],
        "xc-admin-key"
    );

    // ④-b 남의 키 연결은 조합에 꽂지도, 돌려 꽂지도, 지우지도 못한다(관리자여도).
    let admin2_key = secret(&pool, "xc-admin2-key", &admin2).await;
    // 만들기 — 남의 연결·없는 연결 둘 다 Forbidden.
    for (name, link_id) in [
        ("xc-steal-a", link.as_str()),
        ("xc-steal-b", "00000000-0000-4000-8000-00000000dead"),
    ] {
        let steal = ComboInput::parse(&json!({
            "name": name, "harness": "codex", "model": "m2", "keyLinkId": link_id
        }))
        .unwrap();
        assert!(matches!(
            ec::create_combo(&pool, &admin2, &s, &steal).await,
            Err(ComboError::Forbidden)
        ));
    }
    // 고치기 — 풀 조합을 남의 연결로 돌리지 못하고, 남의 키를 쓰는 조합의 다른 칸도 못 고친다.
    let onto_link = ComboInput::parse(&json!({
        "name": "xc-one", "harness": "claude-code", "model": "m", "keyLinkId": link
    }))
    .unwrap();
    assert!(matches!(
        ec::update_combo(&pool, &admin2, &s, &c1, &onto_link).await,
        Err(ComboError::Forbidden)
    ));
    let keyed_other_model = ComboInput::parse(&json!({
        "name": "xc-keyed", "harness": "codex", "model": "m9", "keyLinkId": link
    }))
    .unwrap();
    assert!(matches!(
        ec::update_combo(&pool, &admin2, &s, &c2, &keyed_other_model).await,
        Err(ComboError::Forbidden)
    ));
    let combos = ec::list_combos(&pool, &admin, &s).await.unwrap();
    assert_eq!(combos.len(), 2);
    assert_eq!(combos[0]["model"], "m2");
    assert_eq!(combos[1]["accountPool"], "main");
    assert!(combos[1]["keyLinkId"].is_null());
    // 연결의 주인은 같은 고치기를 한다. 없는 조합은 NotFound.
    ec::update_combo(&pool, &admin, &s, &c2, &keyed)
        .await
        .unwrap();
    assert!(matches!(
        ec::update_combo(
            &pool,
            &admin,
            &s,
            "00000000-0000-4000-8000-00000000dead",
            &keyed
        )
        .await,
        Err(ComboError::NotFound)
    ));
    // 남의 연결을 자기 비밀로 돌려 꽂지 못하고, 지우지도 못한다(조합이 안 쓰는 연결이어도).
    assert!(matches!(
        ec::update_key_link(
            &pool,
            &admin2,
            &s,
            &link,
            &link_input("xc-link", &admin2_key)
        )
        .await,
        Err(ComboError::Forbidden)
    ));
    let spare = ec::create_key_link(&pool, &admin, &s, &link_input("xc-spare", &admin_key))
        .await
        .unwrap();
    for id in [&link, &spare] {
        assert!(matches!(
            ec::delete_key_link(&pool, &admin2, &s, id).await,
            Err(ComboError::Forbidden)
        ));
    }
    assert_eq!(
        ec::list_key_links(&pool, &admin, &s).await.unwrap().len(),
        2
    );
    ec::delete_key_link(&pool, &admin, &s, &spare)
        .await
        .unwrap();
    // 자기 비밀의 연결은 자기 조합에 꽂는다. 가리키던 비밀이 지워진 연결은 다른 관리자가 치울 수 있다.
    let own = ec::create_key_link(&pool, &admin2, &s, &link_input("xc-own", &admin2_key))
        .await
        .unwrap();
    let own_combo = ComboInput::parse(&json!({
        "name": "xc-own-combo", "harness": "codex", "model": "m2", "keyLinkId": own
    }))
    .unwrap();
    let c_own = ec::create_combo(&pool, &admin2, &s, &own_combo)
        .await
        .unwrap();
    assert!(matches!(
        ec::update_combo(&pool, &admin, &s, &c_own, &own_combo).await,
        Err(ComboError::Forbidden)
    ));
    ec::delete_combo(&pool, &admin2, &s, &c_own).await.unwrap();
    sqlx::query("delete from secret where name = 'xc-admin2-key'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(matches!(
        ec::update_key_link(&pool, &admin, &s, &own, &link_input("xc-own", &admin_key)).await,
        Err(ComboError::Forbidden)
    ));
    // 비밀이 지워진 연결은 id 가 비고 옛 이름만 남는다. 같은 이름의 비밀을 **다른 사람이** 새로 만들어도 다시 이어지지 않는다 —
    // 그 연결은 누구의 조합에도 꽂히지 않는다.
    let reborn = secret(&pool, "xc-admin2-key", &admin).await;
    assert_ne!(reborn, admin2_key);
    let orphan = ec::list_key_links(&pool, &admin, &s)
        .await
        .unwrap()
        .into_iter()
        .find(|l| l["id"] == own.as_str())
        .unwrap();
    assert!(orphan["secretId"].is_null());
    assert_eq!(orphan["secretName"], "xc-admin2-key");
    assert!(matches!(
        ec::create_combo(&pool, &admin, &s, &own_combo).await,
        Err(ComboError::Forbidden)
    ));
    ec::delete_key_link(&pool, &admin, &s, &own).await.unwrap();

    // ⑤ 에이전트당 기본 조합은 하나. 남은 못 정하고, 허용 목록에 없는 조합은 기본이 못 된다.
    assert!(matches!(
        ec::set_default(&pool, &admin, &s, &bot.id, &c1).await,
        Err(ComboError::Forbidden)
    ));
    ec::set_default(&pool, &member, &s, &bot.id, &c1)
        .await
        .unwrap();
    assert_eq!(defaults(&pool, &bot.id).await, vec![c1.clone()]);
    ec::set_default(&pool, &member, &s, &bot.id, &c2)
        .await
        .unwrap();
    assert_eq!(defaults(&pool, &bot.id).await, vec![c2.clone()]);
    let c3 = ec::create_combo(&pool, &admin, &s, &pool_combo("xc-three"))
        .await
        .unwrap();
    assert!(matches!(
        ec::set_default(&pool, &member, &s, &bot.id, &c3).await,
        Err(ComboError::Forbidden)
    ));
    // 실패한 정하기는 앞 기본을 내리지 않는다.
    assert_eq!(defaults(&pool, &bot.id).await, vec![c2.clone()]);
    // 표 제약도 둘째 기본을 막는다.
    assert!(
        sqlx::query(
            "update agent_exec_combo set is_default = true where agent_id = $1::uuid and combo_id = $2::uuid"
        )
        .bind(&bot.id)
        .bind(&c1)
        .execute(&pool)
        .await
        .is_err()
    );

    // ⑥ 조합이 쓰는 키 연결은 못 지운다. 조합을 지우면 허용 줄도 사라지고, 그 뒤에는 지워진다.
    assert!(matches!(
        ec::delete_key_link(&pool, &admin, &s, &link).await,
        Err(ComboError::Conflict)
    ));
    ec::delete_combo(&pool, &admin, &s, &c2).await.unwrap();
    assert!(defaults(&pool, &bot.id).await.is_empty());
    assert_eq!(
        ec::list_allowed(&pool, &member, &s, &bot.id)
            .await
            .unwrap()
            .len(),
        1
    );
    ec::delete_key_link(&pool, &admin, &s, &link).await.unwrap();
    assert!(matches!(
        ec::delete_key_link(&pool, &admin, &s, &link).await,
        Err(ComboError::NotFound)
    ));

    // ⑦ 자격은 정확히 하나 — 입력에서도, 표 제약에서도.
    let base = json!({"name": "xc-bad", "harness": "h", "model": "m"});
    assert!(matches!(
        ComboInput::parse(&base),
        Err(ComboError::Invalid("credential"))
    ));
    let mut both = base.clone();
    both["accountPool"] = json!("main");
    both["keyLinkId"] = json!(link);
    assert!(matches!(
        ComboInput::parse(&both),
        Err(ComboError::Invalid("credential"))
    ));
    assert!(
        sqlx::query("insert into exec_combo(name, harness, model) values ('xc-bad', 'h', 'm')")
            .execute(&pool)
            .await
            .is_err()
    );
    let link2 = ec::create_key_link(&pool, &admin, &s, &link_input("xc-link2", &admin_key))
        .await
        .unwrap();
    assert!(
        sqlx::query(
            "insert into exec_combo(name, harness, model, account_pool, key_link_id) \
             values ('xc-bad', 'h', 'm', 'main', $1::uuid)"
        )
        .bind(&link2)
        .execute(&pool)
        .await
        .is_err()
    );

    // 빼기 — 소유자만.
    assert!(matches!(
        ec::allow_remove(&pool, &admin, &s, &bot.id, &c1).await,
        Err(ComboError::Forbidden)
    ));
    ec::allow_remove(&pool, &member, &s, &bot.id, &c1)
        .await
        .unwrap();
    assert!(
        ec::list_allowed(&pool, &member, &s, &bot.id)
            .await
            .unwrap()
            .is_empty()
    );
}
