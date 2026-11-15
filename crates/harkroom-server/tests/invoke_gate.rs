//! 호출 게이트(`core::invoke_gate`)가 TS `invokeGate.ts`(`invokeFactsFor`·`mayInvoke`·`isEligibleDelegate`·`mayInvokeTeam`)와 같은 답을
//! 내는지 — 실제 스키마에서. 픽스처(범위 넷·꺼짐·지움·형제 신뢰·대리 명단·회신권·팀 범위)는 CI `bus-e2e` 의
//! `packages/server/test/rustFrontDb.test.ts` 가 넣고, 축(에이전트·팀·호출자·채널·부름 길·스레드)을 `HARKROOM_INVOKE_AXES`(JSON)로 넘긴다.
//! 두 쪽이 같은 순서의 겹친 반복으로 답을 만든다 — 이 시험은 Rust 의 답을 `INVOKE_JSON` 한 줄로 찍고, 같은 답인지는 TS 쪽이 맞춰 본다.
//! env 가 없으면 건너뛴다.
use harkroom_server::core::invoke_gate::{
    Ctx, TeamFacts, Via, invoke_facts, is_eligible_delegate, may_invoke, may_invoke_team,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn invoke_gate_matches_ts() {
    let (Ok(url), Ok(axes)) = (
        std::env::var("HARKROOM_TEST_DATABASE_URL"),
        std::env::var("HARKROOM_INVOKE_AXES"),
    ) else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let axes: Value = serde_json::from_str(&axes).unwrap();
    let pool = PgPool::connect(&url).await.unwrap();
    let mut conn = pool.acquire().await.unwrap();

    // 사람·없는 id 까지 섞어 넘긴다 — 빠지는지가 대조의 일부다.
    let fact_ids = strs(&axes["factIds"]);
    let facts = invoke_facts(&mut conn, &fact_ids).await.unwrap();
    let mut facts_out = Map::new();
    for (id, f) in &facts {
        facts_out.insert(
            id.clone(),
            json!({ "invokeScope": f.invoke_scope, "ownerAccountId": f.owner_account_id, "off": f.off }),
        );
    }

    let agents = strs(&axes["agents"]);
    let callers = strs(&axes["callers"]);
    let channels = strs(&axes["channels"]);
    let vias = strs(&axes["vias"]);
    let threads: Vec<Option<String>> = axes["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t.as_str().map(str::to_owned))
        .collect();

    let mut agent_out = Vec::new();
    for a in &agents {
        let f = &facts[a];
        for c in &callers {
            for ch in &channels {
                for v in &vias {
                    for t in &threads {
                        let ctx = Ctx {
                            caller_id: c,
                            channel_id: ch,
                            via: Via::parse(v).unwrap(),
                            reply_grant_thread_id: t.as_deref(),
                        };
                        agent_out.push(may_invoke(&mut conn, f, &ctx).await.unwrap());
                    }
                }
            }
        }
    }

    let mut delegate_out = Vec::new();
    for a in &agents {
        let f = &facts[a];
        for c in &callers {
            for listed in [true, false] {
                delegate_out.push(
                    is_eligible_delegate(&mut conn, a, f.owner_account_id.as_deref(), c, listed)
                        .await
                        .unwrap(),
                );
            }
        }
    }

    let mut team_out = Vec::new();
    for t in axes["teams"].as_array().unwrap() {
        let tf = TeamFacts {
            team_id: t["teamId"].as_str().unwrap().to_owned(),
            invoke_scope: t["invokeScope"].as_str().unwrap().to_owned(),
            owner_account_id: t["ownerAccountId"].as_str().map(str::to_owned),
        };
        for c in &callers {
            for ch in &channels {
                team_out.push(may_invoke_team(&mut conn, &tf, c, ch).await.unwrap());
            }
        }
    }

    println!(
        "INVOKE_JSON {}",
        json!({ "facts": facts_out, "agent": agent_out, "delegate": delegate_out, "team": team_out })
    );
}
