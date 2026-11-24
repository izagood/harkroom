//! I2b 잡기 프레임 — 오퍼레이터 연결 위에서 `work.claim`·`work.renew`·`work.release` 를 받아 [`super::work_claim`] 을 부르고
//! `work.claimed`·`work.renewed` 로 답한다. 놓기에는 답이 없다(놓친 놓기는 임대가 끝나며 풀린다).
//!
//! - **`operator_id` 는 인증된 연결의 것만 쓴다.** 허브가 프레임과 함께 넘기는 값(소켓을 연 등록의 id)이고, 프레임 안의 어떤 칸도
//!   오퍼레이터를 가리키는 데 읽지 않는다.
//! - **횟수(`attempts`)는 손대지 않는다.** 잡을 때 DB 가 준 값을 그대로 돌려주고, 갱신·놓기는 오퍼레이터가 보낸 값을 그대로 넘긴다 —
//!   맞는지는 문장이 본다(펜싱).
//! - 좁히기(`agents`·`threadRootId`)는 후보를 줄이기만 한다. 자격은 잡는 문장이 판정한다.
//! - **이 처리기는 `work.state` 를 바꾸지 않고, `work_claim` 을 권한·순서 판정에 읽지 않는다.** 잡은 줄은 기록이다
//!   ([`super::work_claim`] 머리말).
//! - 스위치(`HARKROOM_WORK_CLAIM`)가 꺼져 있거나 쓰기 역할에 권한([`WORK_CLAIM_PRIVILEGES`])이 없으면 DB 에 닿지 않고
//!   `work_claim_disabled` 로 답한다 — 오퍼레이터는 그 답을 보고 지금 길(깨움으로 러너를 빌림)로 물러난다.
//!   이 프레임을 모르는 옛 서버는 프레임을 버리므로 답이 없다(오퍼레이터가 기한으로 안다).
//! - 프레임은 온 순서대로 하나씩 처리한다. 구독이 밀려 프레임을 놓치면 답이 없다 — 잡기·갱신은 오퍼레이터가 기한으로 알고,
//!   놓기는 임대 만료가 대신한다.
use super::operator_hub::OperatorHub;
use super::work_claim::{
    self, Claimed, Held, IDS_MAX, Refusal, ReleaseReason, WORK_CLAIM_PRIVILEGES,
};
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use tokio::sync::broadcast;

/// 요청 id 길이 상한(바이트). 답에 그대로 돌려주는 값이라 짧게 받는다.
pub const REQUEST_ID_MAX: usize = 64;
/// DB 가 실패했을 때 답에 싣는 글자. 까닭은 싣지 않는다.
pub const UNAVAILABLE: &str = "unavailable";

/// `work.claim` 본문.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimRequest {
    pub slot_generation: i64,
    pub lease_secs: Option<i32>,
    pub agents: Option<Vec<String>>,
    pub thread_root_id: Option<String>,
}

/// `work.renew` 본문.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenewRequest {
    pub lease_secs: Option<i32>,
    pub held: Vec<Held>,
}

/// 요청 id — 1~[`REQUEST_ID_MAX`] 바이트의 보이는 ASCII. 아니면 답할 곳이 없으므로 프레임을 버린다.
pub fn request_id(frame: &Map<String, Value>) -> Option<&str> {
    let id = frame.get("requestId")?.as_str()?;
    ((1..=REQUEST_ID_MAX).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_graphic()))
        .then_some(id)
}

/// 없으면 `Some(None)`, 정수면 `Some(Some(_))`(i32 범위로 자른다 — 임대 범위는 코어가 다시 자른다), 그 밖은 `None`(틀린 모양).
fn lease_of(frame: &Map<String, Value>) -> Option<Option<i32>> {
    match frame.get("leaseSecs") {
        None => Some(None),
        Some(v) => v
            .as_i64()
            .map(|n| Some(n.clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32)),
    }
}

/// `{workId, attempts}` 하나. 모양(uuid·횟수 ≥ 1)은 코어가 본다 — 여기서는 타입만 맞춘다.
fn held_of(v: &Value) -> Option<Held> {
    Some(Held {
        work_id: v.get("workId")?.as_str()?.to_owned(),
        attempts: i32::try_from(v.get("attempts")?.as_i64()?).ok()?,
    })
}

/// `work.claim` 을 읽는다 — 틀린 모양이면 `None`.
pub fn parse_claim(frame: &Map<String, Value>) -> Option<ClaimRequest> {
    let agents = match frame.get("agents") {
        None => None,
        Some(Value::Array(a)) if a.len() <= IDS_MAX => Some(
            a.iter()
                .map(|v| v.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?,
        ),
        Some(_) => return None,
    };
    let thread_root_id = match frame.get("threadRootId") {
        None => None,
        Some(Value::String(s)) => Some(s.clone()),
        Some(_) => return None,
    };
    Some(ClaimRequest {
        slot_generation: frame.get("slotGeneration")?.as_i64()?,
        lease_secs: lease_of(frame)?,
        agents,
        thread_root_id,
    })
}

/// `work.renew` 를 읽는다 — 틀린 모양이면 `None`.
pub fn parse_renew(frame: &Map<String, Value>) -> Option<RenewRequest> {
    let Value::Array(held) = frame.get("held")? else {
        return None;
    };
    if held.len() > IDS_MAX {
        return None;
    }
    Some(RenewRequest {
        lease_secs: lease_of(frame)?,
        held: held.iter().map(held_of).collect::<Option<Vec<_>>>()?,
    })
}

/// `work.release` 를 읽는다 — 틀린 모양·모르는 까닭이면 `None`.
pub fn parse_release(frame: &Map<String, Value>) -> Option<(Held, ReleaseReason)> {
    let held = Held {
        work_id: frame.get("workId")?.as_str()?.to_owned(),
        attempts: i32::try_from(frame.get("attempts")?.as_i64()?).ok()?,
    };
    Some((held, ReleaseReason::parse(frame.get("reason")?.as_str()?)?))
}

/// 잡기의 답 — 잡았으면 `work`, 잡을 것이 없으면 둘 다 없음, 하지 않았으면 `error`.
pub fn claimed_frame(request_id: &str, outcome: Result<Option<&Claimed>, &str>) -> Value {
    let mut f = json!({"type": "work.claimed", "requestId": request_id});
    match outcome {
        Ok(Some(c)) => {
            f["work"] = json!({
                "workId": c.work_id, "agentId": c.agent_id, "channelId": c.channel_id,
                "threadRootId": c.thread_root_id, "rootId": c.root_id,
                "attempts": c.attempts, "leaseExpiresAt": c.lease_expires_at,
            });
        }
        Ok(None) => {}
        Err(code) => f["error"] = json!(code),
    }
    f
}

/// 갱신의 답 — 실제로 갱신된 작업 id(빠진 것은 잃은 줄)와 적용한 임대 길이. 하지 않았으면 `error` 와 빈 목록.
pub fn renewed_frame(request_id: &str, outcome: Result<(&[String], i32), &str>) -> Value {
    match outcome {
        Ok((ids, lease)) => json!({
            "type": "work.renewed", "requestId": request_id, "workIds": ids, "leaseSecs": lease,
        }),
        Err(code) => json!({
            "type": "work.renewed", "requestId": request_id, "workIds": [], "error": code,
        }),
    }
}

fn code_of<T>(r: sqlx::Result<Result<T, Refusal>>) -> Result<T, &'static str> {
    match r {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(refusal)) => Err(refusal.code()),
        Err(_) => {
            eprintln!("core: work claim write failed");
            Err(UNAVAILABLE)
        }
    }
}

/// 프레임 하나를 처리한다 — 보낼 답(없으면 `None`). `operator_id` 는 **인증된 연결의 값**이어야 한다. `on` 은 스위치와 권한을
/// 함께 본 값이다.
pub async fn handle(
    pool: &PgPool,
    on: bool,
    operator_id: &str,
    frame: &Map<String, Value>,
) -> Option<Value> {
    match frame.get("type")?.as_str()? {
        "work.claim" => {
            let id = request_id(frame)?;
            let Some(req) = parse_claim(frame) else {
                return Some(claimed_frame(id, Err(Refusal::BadRequest.code())));
            };
            let got = code_of(
                work_claim::claim_narrowed_with(
                    pool,
                    on,
                    operator_id,
                    req.slot_generation,
                    req.lease_secs,
                    req.agents.as_deref(),
                    req.thread_root_id.as_deref(),
                )
                .await,
            );
            Some(claimed_frame(
                id,
                got.as_ref().map(Option::as_ref).map_err(|c| *c),
            ))
        }
        "work.renew" => {
            let id = request_id(frame)?;
            let Some(req) = parse_renew(frame) else {
                return Some(renewed_frame(id, Err(Refusal::BadRequest.code())));
            };
            let got = code_of(
                work_claim::renew_with(pool, on, operator_id, req.lease_secs, &req.held).await,
            );
            let lease = work_claim::lease_secs(req.lease_secs);
            Some(renewed_frame(
                id,
                got.as_ref()
                    .map(|ids| (ids.as_slice(), lease))
                    .map_err(|c| *c),
            ))
        }
        "work.release" => {
            let (held, reason) = parse_release(frame)?;
            let _ = code_of(work_claim::release_with(pool, on, operator_id, &held, reason).await);
            None
        }
        _ => None,
    }
}

/// 일꾼을 띄운다. 스위치가 꺼져 있으면 권한도 묻지 않고, 모든 잡기·갱신에 `work_claim_disabled` 로 답한다.
pub fn spawn(write: PgPool, hub: OperatorHub) {
    let mut frames = hub.subscribe_frames();
    tokio::spawn(async move {
        let on = work_claim::switch_from_env()
            && match crate::write::missing_in(&write, WORK_CLAIM_PRIVILEGES, &[]).await {
                Ok(m) if m.is_empty() => true,
                Ok(m) => {
                    eprintln!("core: work claim off (missing {})", m.join(", "));
                    false
                }
                Err(_) => {
                    eprintln!("core: work claim off (privilege check failed)");
                    false
                }
            };
        loop {
            match frames.recv().await {
                // `operator_id` 는 허브가 그 소켓의 등록에서 꺼낸 값이다(프레임 본문이 아니다).
                Ok((operator_id, frame)) => {
                    if let Some(reply) = handle(&write, on, &operator_id, &frame).await {
                        hub.send(&operator_id, &reply);
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {}
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::super::operator_hub::{parse_operator_frame, parse_server_frame};
    use super::*;
    use harkroom_proto::p2;

    const W: &str = "00000000-0000-4000-8000-000000000001";

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    fn claimed() -> Claimed {
        Claimed {
            work_id: W.into(),
            agent_id: "a".into(),
            channel_id: "c".into(),
            thread_root_id: "t".into(),
            root_id: W.into(),
            attempts: 3,
            lease_expires_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn request_id_is_short_visible_ascii() {
        assert_eq!(request_id(&obj(json!({"requestId": "r-1"}))), Some("r-1"));
        for bad in [
            json!(""),
            json!("a b"),
            json!("한"),
            json!(1),
            json!("x".repeat(65)),
        ] {
            assert_eq!(request_id(&obj(json!({"requestId": bad}))), None);
        }
        assert_eq!(request_id(&obj(json!({}))), None);
    }

    #[test]
    fn claim_shapes() {
        let full = parse_claim(&obj(json!({
            "slotGeneration": 4, "leaseSecs": 120, "agents": [W], "threadRootId": W,
        })))
        .unwrap();
        assert_eq!(full.slot_generation, 4);
        assert_eq!(full.lease_secs, Some(120));
        assert_eq!(full.agents.as_deref(), Some(&[W.to_string()][..]));
        assert_eq!(full.thread_root_id.as_deref(), Some(W));
        let bare = parse_claim(&obj(json!({"slotGeneration": 0}))).unwrap();
        assert_eq!(
            (bare.lease_secs, bare.agents, bare.thread_root_id),
            (None, None, None)
        );
        // 큰 값은 i32 로 자른다(임대 범위는 코어가 자른다).
        let big = parse_claim(&obj(
            json!({"slotGeneration": 0, "leaseSecs": 9_000_000_000i64}),
        ));
        assert_eq!(big.unwrap().lease_secs, Some(i32::MAX));
        for bad in [
            json!({}),
            json!({"slotGeneration": "1"}),
            json!({"slotGeneration": 1.5}),
            json!({"slotGeneration": 1, "leaseSecs": "90"}),
            json!({"slotGeneration": 1, "agents": W}),
            json!({"slotGeneration": 1, "agents": [1]}),
            json!({"slotGeneration": 1, "agents": vec![W; IDS_MAX + 1]}),
            json!({"slotGeneration": 1, "threadRootId": 7}),
        ] {
            assert_eq!(parse_claim(&obj(bad.clone())), None, "{bad}");
        }
    }

    #[test]
    fn renew_and_release_keep_attempts_as_sent() {
        let r = parse_renew(&obj(json!({"held": [{"workId": W, "attempts": 7}]}))).unwrap();
        assert_eq!(
            r.held,
            [Held {
                work_id: W.into(),
                attempts: 7
            }]
        );
        assert_eq!(parse_renew(&obj(json!({"held": []}))).unwrap().held, []);
        for bad in [
            json!({}),
            json!({"held": {}}),
            json!({"held": [{"workId": W}]}),
            json!({"held": [{"workId": W, "attempts": "1"}]}),
            json!({"held": [{"workId": W, "attempts": 9_000_000_000i64}]}),
            json!({"held": vec![json!({"workId": W, "attempts": 1}); IDS_MAX + 1]}),
        ] {
            assert_eq!(parse_renew(&obj(bad.clone())), None, "{bad}");
        }
        let (held, reason) = parse_release(&obj(
            json!({"workId": W, "attempts": 2, "reason": "failed"}),
        ))
        .unwrap();
        assert_eq!((held.attempts, reason), (2, ReleaseReason::Failed));
        for bad in [
            json!({"workId": W, "attempts": 2}),
            json!({"workId": W, "attempts": 2, "reason": "expired"}),
            json!({"attempts": 2, "reason": "done"}),
        ] {
            assert!(parse_release(&obj(bad)).is_none());
        }
    }

    #[test]
    fn replies_match_proto_and_the_hub_parser() {
        let c = claimed();
        let frames = [
            claimed_frame("r1", Ok(Some(&c))),
            claimed_frame("r1", Ok(None)),
            claimed_frame("r1", Err(Refusal::Disabled.code())),
            renewed_frame("r2", Ok((&[W.to_string()], 90))),
            renewed_frame("r2", Err(Refusal::Disabled.code())),
        ];
        for f in &frames {
            assert!(parse_server_frame(&f.to_string()).is_some(), "{f}");
            let p: p2::ServerToOperatorFrame = serde_json::from_value(f.clone()).unwrap();
            assert_eq!(&serde_json::to_value(&p).unwrap(), f);
        }
        assert_eq!(frames[0]["work"]["attempts"], 3);
        assert_eq!(frames[0]["work"]["leaseExpiresAt"], c.lease_expires_at);
        assert!(frames[1].get("work").is_none() && frames[1].get("error").is_none());
        assert_eq!(frames[2]["error"], "work_claim_disabled");
        assert_eq!(frames[4]["error"], "work_claim_disabled");
    }

    #[test]
    fn hub_parser_wants_the_reply_key() {
        for ok in [
            json!({"type": "work.claim", "requestId": "r", "slotGeneration": 0}),
            json!({"type": "work.renew", "requestId": "r", "held": []}),
            json!({"type": "work.release", "workId": W, "attempts": 1, "reason": "released"}),
        ] {
            assert!(parse_operator_frame(&ok.to_string()).is_some(), "{ok}");
            // 정본 타입으로도 읽힌다.
            let _: p2::OperatorToServerFrame = serde_json::from_value(ok).unwrap();
        }
        for bad in [
            json!({"type": "work.claim", "slotGeneration": 0}),
            json!({"type": "work.renew", "held": []}),
            json!({"type": "work.release", "attempts": 1, "reason": "released"}),
        ] {
            assert!(parse_operator_frame(&bad.to_string()).is_none(), "{bad}");
        }
        assert!(parse_server_frame(r#"{"type":"work.claimed"}"#).is_none());
    }

    #[test]
    fn frames_never_name_the_operator() {
        // 오퍼레이터를 가리키는 칸은 프레임에 없다 — 연결이 곧 신원이다.
        let src = include_str!("work_claim_frames.rs");
        let body = src.split("#[cfg(test)]").next().unwrap();
        assert!(!body.contains("\"operatorId\""));
        assert!(!body.contains("update work "));
    }
}
