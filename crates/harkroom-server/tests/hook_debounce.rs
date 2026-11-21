//! 들어오는 hook 의 디바운스 모으기(`core::automation_hooks::enqueue_vars`, P5-3)가 TS `enqueueRun`·`mergeIntoGathering` 과 같은지
//! 실제 Postgres 로 본다. `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
use harkroom_server::core::automation_hooks::enqueue_vars;
use serde_json::{Map, Value, json};
use sqlx::PgPool;

fn vars(sha: &str) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("sha".into(), Value::String(sha.into()));
    m
}

async fn runs(admin: &PgPool, auto: &str) -> Vec<(String, String, bool)> {
    sqlx::query_as(
        "select event_key, payload::text, not_before is not null and not_before > now() \
           from automation_run where automation_id = $1::uuid order by created_at",
    )
    .bind(auto)
    .fetch_all(admin)
    .await
    .unwrap()
}

#[tokio::test]
async fn hook_debounce_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let admin = PgPool::connect(&url).await.unwrap();
    // 쓰기는 hook 쓰기 권한(`automation_hooks::write_privileges`)만 가진 역할로(rustFrontDb.test.ts 가 넘긴다 — 없으면 관리 연결).
    let w = match std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL") {
        Ok(u) => PgPool::connect(&u).await.unwrap(),
        Err(_) => admin.clone(),
    };
    let owner: String = sqlx::query_scalar("insert into account(handle, display_name, kind, login_id) values ('hd_owner', 'hd_owner', 'human', 'hd_owner') returning id::text")
        .fetch_one(&admin).await.unwrap();
    let ch: String = sqlx::query_scalar(
        "insert into channel(name, kind) values ('hook-debounce', 'standard') returning id::text",
    )
    .fetch_one(&admin)
    .await
    .unwrap();
    let auto: String = sqlx::query_scalar(
        "insert into automation(owner_id, channel_id, name, body, trigger, debounce_sec) \
         values ($1::uuid, $2::uuid, 'hd', 'b', '{\"kind\":\"github\"}'::jsonb, 60) returning id::text",
    )
    .bind(&owner).bind(&ch).fetch_one(&admin).await.unwrap();

    // 첫 이벤트 → 창(not_before = now + 60s)을 연 회차, 202 queued.
    let r = enqueue_vars(
        &w,
        &auto,
        "github",
        "github",
        Some("d1".into()),
        vars("aaa"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(r.status().as_u16(), 202);
    let rs = runs(&admin, &auto).await;
    assert_eq!(rs.len(), 1);
    assert!(rs[0].2, "debounce window open");

    // 둘째 이벤트 → 같은 회차에 모인다(202 merged), 변수는 마지막 것.
    let r = enqueue_vars(
        &w,
        &auto,
        "github",
        "github",
        Some("d2".into()),
        vars("bbb"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(r.status().as_u16(), 202);
    let rs = runs(&admin, &auto).await;
    assert_eq!(rs.len(), 1);
    let p: Value = serde_json::from_str(&rs[0].1).unwrap();
    assert_eq!(p["vars"], json!({"sha": "bbb"}));
    let keys: Vec<&str> = p["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["key"].as_str().unwrap())
        .collect();
    assert_eq!(keys, vec!["github:d1", "github:d2"]);

    // 같은 배달 다시 → 200 duplicate, 바뀌지 않는다.
    let r = enqueue_vars(
        &w,
        &auto,
        "github",
        "github",
        Some("d2".into()),
        vars("ccc"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(r.status().as_u16(), 200);
    assert_eq!(runs(&admin, &auto).await[0].1, rs[0].1);

    // 창이 닫혔으면(not_before 지남) 새 회차를 연다.
    sqlx::query("update automation_run set not_before = now() - interval '1 second' where automation_id = $1::uuid")
        .bind(&auto).execute(&admin).await.unwrap();
    let r = enqueue_vars(
        &w,
        &auto,
        "github",
        "github",
        Some("d3".into()),
        vars("ddd"),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(r.status().as_u16(), 202);
    let rs = runs(&admin, &auto).await;
    assert_eq!(rs.len(), 2);
    assert!(rs[1].2);

    // 디바운스 없는 자동화 → not_before 없음(예전 갈래 그대로).
    sqlx::query("update automation set debounce_sec = null where id = $1::uuid")
        .bind(&auto)
        .execute(&admin)
        .await
        .unwrap();
    enqueue_vars(
        &w,
        &auto,
        "webhook",
        "generic",
        Some("g1".into()),
        vars("e"),
    )
    .await
    .unwrap()
    .unwrap();
    let rs = runs(&admin, &auto).await;
    assert_eq!(rs.len(), 3);
    assert!(!rs[2].2);
}
