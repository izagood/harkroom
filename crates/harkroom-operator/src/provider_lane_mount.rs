//! API 키 연결(전용 제공사 경로)의 오퍼레이터 몫 — TS 옛 Node 오퍼레이터(P3 에서 지움)의 `src/providerLaneMount.ts` 이식(op-lane).
//!
//! 두 가지를 relay 가로채기 사슬에서 로컬로 답한다. 둘 다 서버에는 길이 없다(`forward::LOCAL_ONLY`).
//!
//! 1. **lane 턴 자리 막기**([`gate`], TS `createLaneTurnGate`, security ⓒ) — 러너의 API 키 연결 모드가 지금 설정과 다르면
//!    새 턴 자리(`POST /agent/turn-slots`)를 409 `lane_pending` 으로 막는다. 설정을 막 바꾼 뒤 옛 러너가 풀 계정으로 새 턴을
//!    세우는 틈을 닫는다. 자리 **놓기**(`/release`)는 막지 않는다. 판정 재료([`LanePorts`])가 배선되지 않았으면 **막는다**
//!    (security 67974 a). 사슬에서 `turn_slots` **앞**에 선다.
//! 2. **lane 마운트**([`mount`], TS `createProviderLaneMount`) — 러너가 PTY 직전에 `POST /agent/provider-lane/mount {cause}` 를
//!    보내면, 그 에이전트의 로컬 설정(`operator.json`)을 **매번** 읽어 비밀 이름을 고르고 그 턴의 임대로 비밀을 임대 폴더에
//!    0600 으로 쓴다(`turn_secrets::mount_for`). 답은 `{lane: {baseUrl, path}}` — 값은 응답에 싣지 않는다.
//!    - relay 에서만(브릿지·hook·wrapper 는 403 — 브릿지는 하네스가 띄운 것이라 모델이 고를 수 있다).
//!    - 요청 본문은 `cause` 하나만 읽는다. base URL·비밀 이름은 로컬 설정에서만 온다(security ⓓ).
//!    - 그 턴 스레드에 **실행 조합 줄**이 있으면(J2c) 로컬 설정보다 먼저다: 그 턴 임대만 서버에 보내 주소와 값을 받는다
//!      (`turn_secrets::mount_combo`). 조합이 있는데 쓸 수 없으면 실패다 — 로컬 설정의 키로 대신 돌리지 않는다.
//!    - 설정이 없거나 틀리면 `{lane: null}`(200). 러너는 lane 으로 떴는데 이 답이면 턴을 멈춘다.
//!    - 실패는 코드만: 임대 없음 409 `no_lease`, 그 밖 502 `<code>`. 로그에 이름·주소·값을 찍지 않는다.
//!    - 사슬에서 `turn_secrets` **앞**에 선다(TS run.ts 순서).
use crate::assignments::ComboWant;
use crate::local_agents::ProviderLane;
use crate::turn_secrets::ComboMount;
use crate::turn_slots::TURN_SLOTS_PATH;
use harkroom_proto::p1::{RunnerLinkKind, RunnerLinkRequest, RunnerLinkResponse};
use serde_json::{Value, json};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;

/// TS `PROVIDER_LANE_MOUNT_PATH`.
pub const PROVIDER_LANE_MOUNT_PATH: &str = "/agent/provider-lane/mount";
/// TS `CAUSE_MAX`.
const CAUSE_MAX: usize = 128;

/// 판정 재료 — serve 가 배정 조정기·로컬 설정에 잇는다.
pub trait LanePorts: Send + Sync {
    /// 그 러너의 모드가 그 에이전트의 지금 설정과 다른가(TS `reconciler.laneMismatch`).
    fn mismatch(&self, runner_id: &str, agent_id: &str) -> bool;
    /// 그 턴 스레드의 조합이 바라는 모드와 러너 모드를 견준다(J2c 「다」) — 막아야 하면 true. 다르면 조정기가 다음 기동
    /// 모드를 적고 러너를 다시 띄운다. 기본은 조합 줄이 없을 때만 [`Self::mismatch`] 로 답하고 그 밖은 막는다.
    fn combo_gate(&self, runner_id: &str, agent_id: &str, want: &ComboWant) -> bool {
        match want {
            ComboWant::Local => self.mismatch(runner_id, agent_id),
            _ => true,
        }
    }
    /// 그 계정 풀 이름이 이 기기 설정에서 계정으로 풀리는가(security J1). 모르면 false — 서버가 준 이름을 그냥 받지 않는다.
    fn pool_known(&self, _agent_id: &str, _name: &str) -> bool {
        false
    }
    /// 러너가 relay 로 알린 제 모드(`providerLane.mode`, TS `noteRunnerLane`).
    fn note_mode(&self, runner_id: &str, on: bool);
    /// 그 에이전트의 로컬 lane 설정 — 부를 때마다 `operator.json` 에서 읽는다. 없거나 틀리면 None.
    fn lane_of(&self, agent_id: &str) -> Option<ProviderLane>;
}

fn answer(req: &RunnerLinkRequest, status: u16, body: Value) -> RunnerLinkResponse {
    let id = match req {
        RunnerLinkRequest::HttpForward { id, .. } => id.clone(),
        _ => String::new(),
    };
    RunnerLinkResponse::HttpResponse {
        id,
        status,
        body: body.to_string(),
    }
}

fn refuse(req: &RunnerLinkRequest, status: u16, code: &str) -> RunnerLinkResponse {
    answer(req, status, json!({"error": {"code": code}}))
}

/// POST 이고 경로(쿼리 앞)가 `want` 인가.
fn is_post_to(req: &RunnerLinkRequest, want: &str) -> bool {
    matches!(req, RunnerLinkRequest::HttpForward { method, path, .. }
        if method == "POST" && path.split('?').next() == Some(want))
}

/// 같은 러너는 한 번만 적는 막기 기록(TS `logged`).
#[derive(Default)]
pub struct GateLog(Mutex<HashSet<String>>);

impl GateLog {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// 서버 조합 기동 답 길(J2c 「가」 — `GET /agent/exec-combo?threadRootId=`).
pub const COMBO_KIND_PATH: &str = "/agent/exec-combo";

/// 턴 칸 열쇠(`<채널 id>/<스레드 뿌리 id | _root>`, 러너 `thread_key`)에서 스레드 id 를 꺼낸다 — **uuid 꼴일 때만**.
/// 이 값은 러너가 적은 것이라 서버 물음의 질의로만 쓴다(비밀을 고르지 않는다 — 답은 그 에이전트의 조합 종류뿐이다).
pub fn thread_of_slot(req: &RunnerLinkRequest) -> Option<String> {
    let RunnerLinkRequest::HttpForward { body, .. } = req else {
        return None;
    };
    let v: Value = serde_json::from_str(body.as_deref()?).ok()?;
    let id = v.get("key")?.as_str()?.rsplit('/').next()?;
    let b = id.as_bytes();
    let ok = b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        });
    ok.then(|| id.to_ascii_lowercase())
}

/// 「가」 답(상태·본문)을 바라는 모드로 읽는다. 그 길이 없는 서버(404)는 조합 없음이다. 거절·틀린 꼴은 코드 하나.
pub fn parse_combo_kind(status: u16, body: &str) -> Result<ComboWant, String> {
    if status == 404 {
        return Ok(ComboWant::Local);
    }
    let v: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    if status != 200 {
        let code = v
            .pointer("/error/code")
            .and_then(Value::as_str)
            .unwrap_or("unavailable");
        return Err(mount_failure_code(code));
    }
    match v.get("kind").and_then(Value::as_str) {
        Some("none") => Ok(ComboWant::Local),
        Some("key") => Ok(ComboWant::Key),
        Some("pool") => match v.get("accountPool").and_then(Value::as_str) {
            // 이름 꼴은 계정 풀 이름 문법 그대로 — 이 값이 러너 env 에 실린다.
            Some(n) if harkroom_accounts::is_account_name(n) => Ok(ComboWant::Pool(n.to_string())),
            _ => Err("combo_bad_answer".into()),
        },
        _ => Err("combo_bad_answer".into()),
    }
}

/// lane 턴 자리 막기(TS `laneTurnGate.maybeBlock`). relay 의 `POST /agent/turn-slots` 만 본다.
///
/// `combo_of(스레드 id)` 는 그 턴 스레드의 조합 종류를 서버에 **매번** 묻는다(J2c 「다」, 기억하지 않는다). 못 물었거나
/// 거절이면 그 턴을 세우지 않는다(409, 코드만). 풀 조합의 이름이 이 기기 설정에 없으면 막고 러너를 다시 띄우지 않는다(J1).
#[allow(clippy::too_many_arguments)]
pub fn gate(
    runner_id: &str,
    agent_id: &str,
    req: &RunnerLinkRequest,
    from: RunnerLinkKind,
    ports: Option<&dyn LanePorts>,
    combo_of: &dyn Fn(Option<&str>) -> Result<ComboWant, String>,
    logged: &GateLog,
    log: &dyn Fn(&str),
) -> Option<RunnerLinkResponse> {
    if from != RunnerLinkKind::Relay || !is_post_to(req, TURN_SLOTS_PATH) {
        return None;
    }
    // 판정 재료가 없으면 막는다(security 67974 a) — 모드를 모르는 채로 자리를 내주지 않는다.
    let Some(ports) = ports else {
        return Some(block(req, runner_id, agent_id, "lane_pending", logged, log));
    };
    let want = match combo_of(thread_of_slot(req).as_deref()) {
        Ok(ComboWant::Pool(name)) if !ports.pool_known(agent_id, &name) => {
            Err("combo_pool_unknown".to_string())
        }
        other => other,
    };
    let code = match want {
        Ok(want) if !ports.combo_gate(runner_id, agent_id, &want) => {
            logged.lock().remove(runner_id);
            return None;
        }
        Ok(_) => "lane_pending".to_string(),
        Err(raw) => mount_failure_code(&raw),
    };
    Some(block(req, runner_id, agent_id, &code, logged, log))
}

/// 409 로 막고, 같은 러너·같은 코드는 한 번만 적는다. 로그에는 에이전트 id 와 코드만 — 주소·풀 이름은 찍지 않는다.
fn block(
    req: &RunnerLinkRequest,
    runner_id: &str,
    agent_id: &str,
    code: &str,
    logged: &GateLog,
    log: &dyn Fn(&str),
) -> RunnerLinkResponse {
    if logged.lock().insert(runner_id.to_string()) {
        log(&format!(
            "API 키 연결: agent={agent_id} 새 턴을 막는다({code}) — 러너 모드가 설정·실행 조합과 다르거나 판정하지 못했다. 러너가 다시 뜨면 풀린다"
        ));
    }
    refuse(req, 409, code)
}

/// lane 마운트(TS `providerLaneMount.maybeHandle`). `mount_for(cause, secret_name)` 은 그 턴 임대로 비밀을 써 경로를 돌려준다.
pub fn mount(
    agent_id: &str,
    req: &RunnerLinkRequest,
    from: RunnerLinkKind,
    combo_for: &dyn Fn(&str) -> Result<ComboMount, String>,
    lane_of: &dyn Fn() -> Option<ProviderLane>,
    mount_for: &dyn Fn(&str, &str) -> Result<PathBuf, String>,
    log: &dyn Fn(&str),
) -> Option<RunnerLinkResponse> {
    if !is_post_to(req, PROVIDER_LANE_MOUNT_PATH) {
        return None;
    }
    if from != RunnerLinkKind::Relay {
        return Some(refuse(req, 403, "forbidden"));
    }
    let RunnerLinkRequest::HttpForward { body, .. } = req else {
        return None;
    };
    let cause = body
        .as_deref()
        .and_then(|b| serde_json::from_str::<Value>(b).ok())
        .and_then(|v| v.get("cause").and_then(Value::as_str).map(str::to_string))
        .filter(|c| !c.is_empty() && c.chars().count() <= CAUSE_MAX);
    let Some(cause) = cause else {
        return Some(refuse(req, 400, "bad_request"));
    };
    let failed = |raw: &str| {
        // 형식 밖 코드(서버가 낸 긴 글·경로 등)는 `unavailable` 로 접는다 — 로그·응답에 원문을 싣지 않는다.
        let code = mount_failure_code(raw);
        // 거절 코드는 비밀이 아니다 — 러너가 실패 통지에 싣는다. 이름·주소는 찍지 않는다.
        log(&format!(
            "provider-lane: agent={agent_id} 비밀을 못 꺼냈다 — {code}"
        ));
        let status = if code == "no_lease" { 409 } else { 502 };
        Some(refuse(req, status, &code))
    };
    // 그 턴의 실행 조합을 먼저 본다(J2c 「나」) — 주소·비밀은 서버가 그 턴 임대에서 고른다. 조합 줄이 없을 때만 로컬 설정 길이다.
    // 조합이 있는데 쓸 수 없으면(거절·서버 안 닿음·풀 조합) 로컬 설정의 키로 대신 돌리지 않는다.
    match combo_for(&cause) {
        Ok(ComboMount::Key { base_url, path }) => {
            return Some(answer(
                req,
                200,
                json!({"lane": {"baseUrl": base_url, "path": path.to_string_lossy()}}),
            ));
        }
        Ok(ComboMount::None) => {}
        // 임대가 없으면 조합을 물을 수 없다 — 로컬 설정도 없으면 지금까지처럼 `{lane: null}` 이다.
        Err(raw) if raw == "no_lease" && lane_of().is_none() => {
            return Some(answer(req, 200, json!({"lane": null})));
        }
        Err(raw) => return failed(&raw),
    }
    let Some(lane) = lane_of() else {
        return Some(answer(req, 200, json!({"lane": null})));
    };
    match mount_for(&cause, &lane.secret_name) {
        Ok(path) => Some(answer(
            req,
            200,
            json!({"lane": {"baseUrl": lane.base_url, "path": path.to_string_lossy()}}),
        )),
        Err(raw) => failed(&raw),
    }
}

/// 마운트 실패 코드는 `^[a-z0-9_]{1,64}$` 만 그대로 싣고, 그 밖은 `unavailable` 로 접는다.
fn mount_failure_code(raw: &str) -> String {
    let ok = !raw.is_empty()
        && raw.len() <= 64
        && raw
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if ok {
        raw.to_string()
    } else {
        "unavailable".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn fwd(method: &str, path: &str, body: &str) -> RunnerLinkRequest {
        RunnerLinkRequest::HttpForward {
            id: "h1".into(),
            method: method.into(),
            path: path.into(),
            body: Some(body.into()),
            body_base64: None,
            content_type: None,
        }
    }

    fn parts(r: Option<RunnerLinkResponse>) -> (u16, Value) {
        match r {
            Some(RunnerLinkResponse::HttpResponse { status, body, .. }) => {
                (status, serde_json::from_str(&body).unwrap())
            }
            other => panic!("{other:?}"),
        }
    }

    fn lane() -> Option<ProviderLane> {
        Some(ProviderLane {
            base_url: "https://g.example.com/anthropic".into(),
            secret_name: "lane-key".into(),
        })
    }

    fn no_combo(_: &str) -> Result<ComboMount, String> {
        Ok(ComboMount::None)
    }

    fn local_kind(_: Option<&str>) -> Result<ComboWant, String> {
        Ok(ComboWant::Local)
    }

    fn never_combo(_: &str) -> Result<ComboMount, String> {
        panic!("조합을 물으면 안 된다")
    }

    struct Ports(bool);
    impl LanePorts for Ports {
        fn mismatch(&self, _: &str, _: &str) -> bool {
            self.0
        }
        fn note_mode(&self, _: &str, _: bool) {}
        fn lane_of(&self, _: &str) -> Option<ProviderLane> {
            None
        }
    }

    #[test]
    fn gate_blocks_new_slot_on_mismatch_and_when_unwired_but_never_release() {
        let logged = GateLog::default();
        let lines = RefCell::new(Vec::<String>::new());
        let log = |l: &str| lines.borrow_mut().push(l.to_string());
        let take = fwd("POST", "/agent/turn-slots", r#"{"key":"k"}"#);
        let rel = fwd("POST", "/agent/turn-slots/release", r#"{"key":"k"}"#);
        let relay = RunnerLinkKind::Relay;
        // 맞으면 지나간다.
        assert!(
            gate(
                "r1",
                "a",
                &take,
                relay,
                Some(&Ports(false)),
                &local_kind,
                &logged,
                &log
            )
            .is_none()
        );
        // 다르면 409 lane_pending, 로그는 한 번만.
        for _ in 0..2 {
            let (s, b) = parts(gate(
                "r1",
                "a",
                &take,
                relay,
                Some(&Ports(true)),
                &local_kind,
                &logged,
                &log,
            ));
            assert_eq!(
                (s, b["error"]["code"].as_str()),
                (409, Some("lane_pending"))
            );
        }
        assert_eq!(lines.borrow().len(), 1);
        // 판정 재료가 없으면 막는다(fail-closed).
        let (s, _) = parts(gate(
            "r2",
            "a",
            &take,
            relay,
            None,
            &local_kind,
            &logged,
            &log,
        ));
        assert_eq!(s, 409);
        // 놓기·다른 소켓·다른 길은 건드리지 않는다.
        assert!(gate("r1", "a", &rel, relay, None, &local_kind, &logged, &log).is_none());
        assert!(
            gate(
                "r1",
                "a",
                &take,
                RunnerLinkKind::Bridge,
                None,
                &local_kind,
                &logged,
                &log
            )
            .is_none()
        );
        let other = fwd("POST", "/agent/activity", "{}");
        assert!(gate("r1", "a", &other, relay, None, &local_kind, &logged, &log).is_none());
        // 풀리면 기록을 지워 다음 막힘을 다시 적는다.
        assert!(
            gate(
                "r1",
                "a",
                &take,
                relay,
                Some(&Ports(false)),
                &local_kind,
                &logged,
                &log
            )
            .is_none()
        );
        let _ = gate(
            "r1",
            "a",
            &take,
            relay,
            Some(&Ports(true)),
            &local_kind,
            &logged,
            &log,
        );
        assert_eq!(lines.borrow().len(), 3);
    }

    /// 조합 견주기를 흉내 내는 판정 재료: 러너 모드(`lane`·`pool`)와 이 기기가 아는 풀 이름.
    struct ComboPorts {
        lane: bool,
        pool: Option<&'static str>,
        known: &'static [&'static str],
        asked: RefCell<Vec<ComboWant>>,
    }
    // 시험은 한 스레드에서만 돈다.
    unsafe impl Sync for ComboPorts {}
    impl LanePorts for ComboPorts {
        fn mismatch(&self, _: &str, _: &str) -> bool {
            false
        }
        fn combo_gate(&self, _: &str, _: &str, want: &ComboWant) -> bool {
            self.asked.borrow_mut().push(want.clone());
            match want {
                ComboWant::Local => false,
                ComboWant::Key => !self.lane,
                ComboWant::Pool(n) => self.lane || self.pool != Some(n.as_str()),
            }
        }
        fn pool_known(&self, _: &str, name: &str) -> bool {
            self.known.contains(&name)
        }
        fn note_mode(&self, _: &str, _: bool) {}
        fn lane_of(&self, _: &str) -> Option<ProviderLane> {
            None
        }
    }

    const THREAD: &str = "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40";

    fn slot(key: &str) -> RunnerLinkRequest {
        fwd(
            "POST",
            "/agent/turn-slots",
            &json!({"key": key}).to_string(),
        )
    }

    /// 문지기 표(「가」 답 × 러너 모드) — 8칸 + 못 물음·거절·모르는 풀 이름.
    #[test]
    fn gate_compares_thread_combo_kind_with_runner_mode() {
        let relay = RunnerLinkKind::Relay;
        let take = slot(&format!("ch/{THREAD}"));
        let run = |ports: &ComboPorts, kind: Result<ComboWant, String>| {
            let seen = RefCell::new(Vec::<Option<String>>::new());
            let lines = RefCell::new(Vec::<String>::new());
            let r = gate(
                "r1",
                "a",
                &take,
                relay,
                Some(ports),
                &|t| {
                    seen.borrow_mut().push(t.map(str::to_string));
                    kind.clone()
                },
                &GateLog::default(),
                &|l| lines.borrow_mut().push(l.into()),
            );
            // 매번 그 스레드 id 로 묻는다.
            assert_eq!(*seen.borrow(), vec![Some(THREAD.to_string())]);
            let l = lines.borrow().join("\n");
            assert!(
                !l.contains("team-pool") && !l.contains("example.com"),
                "{l}"
            );
            r.map(|r| parts(Some(r)))
                .map(|(s, b)| (s, b["error"]["code"].as_str().unwrap().to_string()))
        };
        let ports = |lane, pool| ComboPorts {
            lane,
            pool,
            known: &["team-pool"],
            asked: RefCell::default(),
        };
        let pending = Some((409, "lane_pending".to_string()));
        let pool = || Ok(ComboWant::Pool("team-pool".into()));
        // none — 지금 그대로(로컬 판정).
        assert_eq!(run(&ports(true, None), Ok(ComboWant::Local)), None);
        assert_eq!(run(&ports(false, None), Ok(ComboWant::Local)), None);
        // key — 키 모드는 지나가고 구독 풀 모드는 막힌다.
        assert_eq!(run(&ports(true, None), Ok(ComboWant::Key)), None);
        assert_eq!(run(&ports(false, None), Ok(ComboWant::Key)), pending);
        // pool — 키 모드는 막히고, 구독 풀 모드는 이름이 같을 때만 지나간다.
        assert_eq!(run(&ports(true, None), pool()), pending);
        assert_eq!(run(&ports(false, Some("team-pool")), pool()), None);
        assert_eq!(run(&ports(false, Some("other")), pool()), pending);
        assert_eq!(run(&ports(false, None), pool()), pending);
        // 거절·안 닿음·틀린 꼴 — 두 모드 다 409, 코드만. 견주기(다시 띄우기)는 부르지 않는다.
        for (raw, code) in [
            ("combo_not_allowed", "combo_not_allowed"),
            ("unavailable", "unavailable"),
            ("combo_bad_answer", "combo_bad_answer"),
            ("https://x.example.com/v1", "unavailable"),
        ] {
            for lane in [true, false] {
                let p = ports(lane, Some("team-pool"));
                assert_eq!(run(&p, Err(raw.into())), Some((409, code.to_string())));
                assert!(p.asked.borrow().is_empty());
            }
        }
        // 이 기기 설정에 없는 풀 이름(J1) — 막고, 다시 띄우지 않는다(견주기를 부르지 않는다).
        let p = ports(false, None);
        assert_eq!(
            run(&p, Ok(ComboWant::Pool("stranger".into()))),
            Some((409, "combo_pool_unknown".to_string()))
        );
        assert!(p.asked.borrow().is_empty());
    }

    #[test]
    fn slot_key_gives_thread_only_when_uuid_shaped() {
        assert_eq!(
            thread_of_slot(&slot(&format!("ch/{THREAD}"))).as_deref(),
            Some(THREAD)
        );
        for key in [
            "ch/_root",
            "k1",
            "",
            "ch/0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a4",
            "ch/0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a40&x=1",
            "ch/0b1c2d3e_4f50-4a61-8b72-9c8d7e6f5a40",
        ] {
            assert_eq!(thread_of_slot(&slot(key)), None, "{key}");
        }
        assert_eq!(
            thread_of_slot(&fwd("POST", "/agent/turn-slots", "nope")),
            None
        );
    }

    #[test]
    fn combo_kind_answer_parsing() {
        let ok = |b: &str| parse_combo_kind(200, b);
        assert_eq!(
            ok(r#"{"comboId":null,"kind":"none","accountPool":null}"#),
            Ok(ComboWant::Local)
        );
        assert_eq!(
            ok(r#"{"comboId":"c","kind":"key","accountPool":null}"#),
            Ok(ComboWant::Key)
        );
        assert_eq!(
            ok(r#"{"comboId":"c","kind":"pool","accountPool":"team-pool"}"#),
            Ok(ComboWant::Pool("team-pool".into()))
        );
        // 틀린 꼴·이름 문법 밖은 조합 없음으로 넘기지 않는다.
        for b in [
            "{}",
            "not json",
            r#"{"kind":"pool","accountPool":null}"#,
            r#"{"kind":"pool","accountPool":"../x"}"#,
            r#"{"kind":"pool","accountPool":"a b\nc"}"#,
            r#"{"kind":"other"}"#,
        ] {
            assert_eq!(ok(b), Err("combo_bad_answer".into()), "{b}");
        }
        // 그 길이 없는 서버는 조합 없음, 거절은 서버 코드(형식 밖은 접는다).
        assert_eq!(parse_combo_kind(404, "nope"), Ok(ComboWant::Local));
        assert_eq!(
            parse_combo_kind(403, r#"{"error":{"code":"combo_not_allowed"}}"#),
            Err("combo_not_allowed".into())
        );
        assert_eq!(parse_combo_kind(500, "oops"), Err("unavailable".into()));
        assert_eq!(
            parse_combo_kind(403, r#"{"error":{"code":"Bad Code"}}"#),
            Err("unavailable".into())
        );
    }

    #[test]
    fn mount_answers_base_url_and_path_only() {
        let seen = RefCell::new(Vec::<(String, String)>::new());
        let lines = RefCell::new(Vec::<String>::new());
        let mf = |c: &str, n: &str| {
            seen.borrow_mut().push((c.into(), n.into()));
            Ok(PathBuf::from("/state/turn-secrets/lease-1/sec-1"))
        };
        let req = fwd(
            "POST",
            PROVIDER_LANE_MOUNT_PATH,
            // 본문의 다른 칸(주소·이름)은 읽지 않는다.
            r#"{"cause":"c1","secretName":"evil","baseUrl":"https://evil.example.com"}"#,
        );
        let (s, b) = parts(mount(
            "a",
            &req,
            RunnerLinkKind::Relay,
            &no_combo,
            &lane,
            &mf,
            &|l| lines.borrow_mut().push(l.into()),
        ));
        assert_eq!(s, 200);
        assert_eq!(
            b,
            json!({"lane": {"baseUrl": "https://g.example.com/anthropic", "path": "/state/turn-secrets/lease-1/sec-1"}})
        );
        assert_eq!(*seen.borrow(), vec![("c1".into(), "lane-key".into())]);
        assert!(lines.borrow().is_empty());
    }

    #[test]
    fn mount_refusals() {
        let never =
            |_: &str, _: &str| -> Result<PathBuf, String> { panic!("불리면 안 된다") };
        let log = |_: &str| {};
        let ok = fwd("POST", PROVIDER_LANE_MOUNT_PATH, r#"{"cause":"c1"}"#);
        // relay 아님 → 403(설정도 안 읽는다).
        let no_lane = || -> Option<ProviderLane> { panic!("읽으면 안 된다") };
        for k in [
            RunnerLinkKind::Bridge,
            RunnerLinkKind::Hook,
            RunnerLinkKind::Wrapper,
        ] {
            let (s, b) = parts(mount("a", &ok, k, &never_combo, &no_lane, &never, &log));
            assert_eq!((s, b["error"]["code"].as_str()), (403, Some("forbidden")));
        }
        // cause 없음·빔·너무 김 → 400.
        let long = format!(r#"{{"cause":"{}"}}"#, "x".repeat(CAUSE_MAX + 1));
        for body in [
            "{}",
            r#"{"cause":""}"#,
            r#"{"cause":1}"#,
            "not json",
            long.as_str(),
        ] {
            let r = fwd("POST", PROVIDER_LANE_MOUNT_PATH, body);
            let (s, _) = parts(mount(
                "a",
                &r,
                RunnerLinkKind::Relay,
                &never_combo,
                &lane,
                &never,
                &log,
            ));
            assert_eq!(s, 400, "{body}");
        }
        // 설정 없음 → {lane:null}, 마운트 안 함.
        let (s, b) = parts(mount(
            "a",
            &ok,
            RunnerLinkKind::Relay,
            &no_combo,
            &|| None,
            &never,
            &log,
        ));
        assert_eq!((s, b), (200, json!({"lane": null})));
        // 다른 메서드·길은 지나간다.
        let get = fwd("GET", PROVIDER_LANE_MOUNT_PATH, "{}");
        assert!(
            mount(
                "a",
                &get,
                RunnerLinkKind::Relay,
                &never_combo,
                &lane,
                &never,
                &log
            )
            .is_none()
        );
    }

    #[test]
    fn mount_failure_is_code_only_no_lease_409_else_502() {
        let ok = fwd("POST", PROVIDER_LANE_MOUNT_PATH, r#"{"cause":"c1"}"#);
        for (code, want) in [
            ("no_lease", 409),
            ("not_granted", 502),
            ("unavailable", 502),
        ] {
            let lines = RefCell::new(Vec::<String>::new());
            let mf = |_: &str, _: &str| -> Result<PathBuf, String> { Err(code.into()) };
            let (s, b) = parts(mount(
                "a",
                &ok,
                RunnerLinkKind::Relay,
                &no_combo,
                &lane,
                &mf,
                &|l| lines.borrow_mut().push(l.into()),
            ));
            assert_eq!(s, want);
            assert_eq!(b, json!({"error": {"code": code}}));
            // 로그에 비밀 이름·주소가 없다.
            let l = lines.borrow().join("\n");
            assert!(
                !l.contains("lane-key") && !l.contains("g.example.com"),
                "{l}"
            );
        }
    }

    #[test]
    fn mount_failure_code_outside_format_folds_to_unavailable() {
        let ok = fwd("POST", PROVIDER_LANE_MOUNT_PATH, r#"{"cause":"c1"}"#);
        let long = "a".repeat(65);
        for raw in [
            "Bad Code",
            "/path/to/secret",
            "x@host",
            "",
            long.as_str(),
            "코드",
        ] {
            let lines = RefCell::new(Vec::<String>::new());
            let mf = |_: &str, _: &str| -> Result<PathBuf, String> { Err(raw.into()) };
            let (s, b) = parts(mount(
                "a",
                &ok,
                RunnerLinkKind::Relay,
                &no_combo,
                &lane,
                &mf,
                &|l| lines.borrow_mut().push(l.into()),
            ));
            assert_eq!(
                (s, b),
                (502, json!({"error": {"code": "unavailable"}})),
                "{raw}"
            );
            if !raw.is_empty() {
                assert!(!lines.borrow().join("\n").contains(raw), "{raw}");
            }
        }
        assert_eq!(mount_failure_code(&"a".repeat(64)), "a".repeat(64));
    }

    #[test]
    fn combo_key_wins_over_local_config_and_local_is_never_read() {
        let never = |_: &str, _: &str| -> Result<PathBuf, String> {
            panic!("로컬 길로 가면 안 된다")
        };
        let no_lane =
            || -> Option<ProviderLane> { panic!("로컬 설정을 읽으면 안 된다") };
        let seen = RefCell::new(Vec::<String>::new());
        let combo = |c: &str| {
            seen.borrow_mut().push(c.into());
            Ok(ComboMount::Key {
                base_url: "https://combo.example.com/v1".into(),
                path: PathBuf::from("/state/turn-secrets/lease-1/sec-9"),
            })
        };
        // 본문의 다른 칸(조합 id·주소·이름)은 읽지 않는다 — 조합 물음에는 cause 만 간다.
        let req = fwd(
            "POST",
            PROVIDER_LANE_MOUNT_PATH,
            r#"{"cause":"c1","comboId":"x","baseUrl":"https://evil.example.com","secretName":"evil"}"#,
        );
        let (s, b) = parts(mount(
            "a",
            &req,
            RunnerLinkKind::Relay,
            &combo,
            &no_lane,
            &never,
            &|_| {},
        ));
        assert_eq!(s, 200);
        assert_eq!(
            b,
            json!({"lane": {"baseUrl": "https://combo.example.com/v1", "path": "/state/turn-secrets/lease-1/sec-9"}})
        );
        assert_eq!(*seen.borrow(), vec!["c1".to_string()]);
    }

    #[test]
    fn combo_refusal_never_falls_back_to_local_key() {
        let never = |_: &str, _: &str| -> Result<PathBuf, String> {
            panic!("로컬 키로 대신 돌리면 안 된다")
        };
        let ok = fwd("POST", PROVIDER_LANE_MOUNT_PATH, r#"{"cause":"c1"}"#);
        for (raw, status, code) in [
            ("combo_not_allowed", 502, "combo_not_allowed"),
            ("combo_unusable", 502, "combo_unusable"),
            ("combo_mode_mismatch", 502, "combo_mode_mismatch"),
            ("combo_bad_url", 502, "combo_bad_url"),
            ("not_granted", 502, "not_granted"),
            ("unavailable", 502, "unavailable"),
            ("lease_invalid", 502, "lease_invalid"),
            // 로컬 설정이 있는 러너는 임대가 없으면 지금처럼 409 다.
            ("no_lease", 409, "no_lease"),
            ("https://combo.example.com/v1", 502, "unavailable"),
        ] {
            let lines = RefCell::new(Vec::<String>::new());
            let combo = |_: &str| -> Result<ComboMount, String> { Err(raw.into()) };
            let (s, b) = parts(mount(
                "a",
                &ok,
                RunnerLinkKind::Relay,
                &combo,
                &lane,
                &never,
                &|l| lines.borrow_mut().push(l.into()),
            ));
            assert_eq!((s, b), (status, json!({"error": {"code": code}})), "{raw}");
            let l = lines.borrow().join("\n");
            assert!(!l.contains("example.com") && !l.contains("lane-key"), "{l}");
        }
        // 임대도 로컬 설정도 없으면 지금까지처럼 `{lane: null}`.
        let combo = |_: &str| -> Result<ComboMount, String> { Err("no_lease".into()) };
        let (s, b) = parts(mount(
            "a",
            &ok,
            RunnerLinkKind::Relay,
            &combo,
            &|| None,
            &never,
            &|_| {},
        ));
        assert_eq!((s, b), (200, json!({"lane": null})));
    }
}
