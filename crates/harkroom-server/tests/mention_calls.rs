//! 「누구를 부르나」(`core::mention_calls::resolve`)가 TS `resolveMentionCalls` 와 같은 판정인지 — 실제 스키마에서.
//! 픽스처와 사례는 CI `bus-e2e` 의 `packages/server/test/rustFrontDb.test.ts` 가 넣고 `HARKROOM_MENTION_CASES`(JSON 파일 경로)로 넘긴다.
//! 이 시험은 Rust 의 답을 `MENTION_CALLS_JSON` 한 줄로 찍고, 같은지는 TS 쪽이 자기 함수의 답과 맞춰 본다. env 가 없으면 건너뛴다.
use harkroom_server::core::mention_calls::{Input, Principal, resolve};
use serde_json::{Value, json};

fn sorted(v: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut v: Vec<String> = v.into_iter().collect();
    v.sort();
    v
}

#[tokio::test]
async fn resolve_matches_ts() {
    let (Ok(url), Ok(path)) = (
        std::env::var("HARKROOM_TEST_DATABASE_URL"),
        std::env::var("HARKROOM_MENTION_CASES"),
    ) else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let pool = sqlx::PgPool::connect(&url).await.unwrap();
    let cases: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;
    let mut out = vec![];
    for c in &cases {
        let s = |k: &str| c[k].as_str().map(str::to_string);
        let body = s("body").unwrap();
        let channel = s("channelId").unwrap();
        let author = s("authorId").unwrap();
        let principal = s("principalId");
        let thread = s("replyGrantThreadId");
        let input = Input {
            body: &body,
            channel_id: &channel,
            author_id: &author,
            author_is_agent: c["authorIsAgent"].as_bool().unwrap(),
            mention_depth: c["mentionDepth"].as_i64().unwrap(),
            chain_bound: c["chainBound"].as_bool().unwrap_or(false),
            chain_started_at_ms: c["chainStartedAtMs"].as_i64(),
            reply_grant_thread_id: thread.as_deref(),
            principal: principal.as_deref().map(|id| Principal { id }),
            now_ms,
            principal_invoke_enabled: Some(c["principalInvokeEnabled"].as_bool().unwrap_or(true)),
        };
        let mut tx = pool.begin().await.unwrap();
        let r = resolve(&mut tx, &input).await.unwrap();
        tx.rollback().await.unwrap();
        out.push(json!({
            "normalizedBody": r.normalized_body,
            "accountHandles": sorted(r.account_handles),
            "calledIds": r.called_ids,
            "cappedIds": sorted(r.capped_ids),
            "deniedIds": sorted(r.denied_ids),
            "teamPlans": r.team_plans.iter().map(|p| json!({ "teamId": p.team_id, "recipients": p.recipients, "viaLead": p.via_lead })).collect::<Vec<_>>(),
            "targetCall": r.target_call.iter().map(|t| format!("{}:{}", t.kind.as_str(), t.id)).collect::<Vec<_>>(),
            "channelCalled": r.channel_called,
            "callMeta": r.call_meta,
        }));
    }
    println!("MENTION_CALLS_JSON {}", Value::Array(out));
}
