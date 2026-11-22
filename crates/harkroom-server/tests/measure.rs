//! 기준선 측정 기록(`core::measure`)을 실제 Postgres 로 본다 — 쓰기 역할의 권한만으로 한 줄이 들어가고 집계가 읽히는지.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `scripts/db-tests.sh` 가 넘긴다).
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 기록은 그 역할(`MEASURE_PRIVILEGES` 만 가진 쓰기 역할)로 한다.
use harkroom_server::core::measure::{
    Event, KIND_MERGE_DENIED, KIND_QUEUE_WAIT, MEASURE_PRIVILEGES, record_with, summary,
};
use serde_json::json;
use sqlx::PgPool;

#[tokio::test]
async fn records_and_summarizes() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let w = PgPool::connect(&write_url).await.unwrap();
    let missing = harkroom_server::write::missing_in(&w, MEASURE_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "{missing:?}");

    for sec in [2_i64, 4, 60] {
        record_with(
            &w,
            Event {
                kind: KIND_QUEUE_WAIT,
                account_id: Some("00000000-0000-4000-8000-000000000001".into()),
                ref_id: Some("m".into()),
                value: Some(sec),
                detail: Some(json!({ "reissue": false })),
                ..Event::default()
            },
        )
        .await;
    }
    record_with(
        &w,
        Event {
            kind: KIND_MERGE_DENIED,
            detail: Some(json!({ "code": "not_granted", "branch": "grant" })),
            ..Event::default()
        },
    )
    .await;
    // uuid 가 아닌 id — 그 줄만 버려지고 부른 쪽은 그대로 간다.
    record_with(
        &w,
        Event {
            kind: KIND_QUEUE_WAIT,
            account_id: Some("not-a-uuid".into()),
            value: Some(999),
            ..Event::default()
        },
    )
    .await;

    let rows = summary(&w, 3600).await.unwrap();
    let wait = rows
        .iter()
        .find(|r| r["kind"] == KIND_QUEUE_WAIT)
        .expect("queue.wait row");
    assert_eq!(wait["count"], 3);
    assert_eq!(wait["sum"], 66);
    assert_eq!(wait["max"], 60);
    assert_eq!(wait["p50"], 4.0);
    let denied = rows
        .iter()
        .find(|r| r["kind"] == KIND_MERGE_DENIED)
        .expect("merge.denied row");
    assert_eq!(denied["branch"], "grant");
    assert_eq!(denied["count"], 1);
}
