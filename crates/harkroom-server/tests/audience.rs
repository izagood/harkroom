//! 받는 사람 계산(`core::audience`)이 TS `audienceFor`·`channelListAudience`·`channelListLostAudience` 와 같은 답을 내는지 —
//! 실제 스키마에서. 픽스처(공개·비공개·DM·탈퇴자·admin·없는 채널)는 CI `bus-e2e` 의 `packages/server/test/rustFrontDb.test.ts` 가
//! TS 서비스 함수로 넣고, 채널 id 를 `HARKROOM_AUDIENCE_CHANNELS`(쉼표)로 넘긴다. 이 시험은 Rust 의 답을 `AUDIENCE_JSON` 한 줄로
//! 찍고, 같은 답인지는 TS 쪽이 자기 함수의 답과 맞춰 본다. env 가 없으면 건너뛴다.
use harkroom_server::core::audience::{
    Audience, audience_for, channel_list_audience, channel_list_lost_audience,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;

fn sorted(a: Audience) -> Value {
    match a {
        Audience::All => json!("all"),
        Audience::Accounts(mut ids) => {
            ids.sort();
            json!(ids)
        }
    }
}

#[tokio::test]
async fn audience_matches_ts() {
    let (Ok(url), Ok(chs)) = (
        std::env::var("HARKROOM_TEST_DATABASE_URL"),
        std::env::var("HARKROOM_AUDIENCE_CHANNELS"),
    ) else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = PgPool::connect(&url).await.unwrap();
    let mut out = Map::new();
    for ch in chs.split(',').filter(|s| !s.is_empty()) {
        let mut lost = channel_list_lost_audience(&pool, ch).await.unwrap();
        lost.sort();
        out.insert(
            ch.to_owned(),
            json!({
                "for": sorted(audience_for(&pool, ch).await.unwrap()),
                "list": sorted(channel_list_audience(&pool, ch).await.unwrap()),
                "lost": lost,
            }),
        );
    }
    println!("AUDIENCE_JSON {}", Value::Object(out));
}
