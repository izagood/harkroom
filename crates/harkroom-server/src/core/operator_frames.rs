//! 허브 프레임을 DB·이벤트로 옮기는 일꾼(C2a, TS `operatorRoutes.ts` 의 `hub.onFrame` 구독 넷 중 셋).
//! 버전 쓰기는 `operator.rs` 에 있다.
//!
//! - `status`(박동): 10초에 한 번만 처리. 머신 digest 를 소유자 id 와 섞어 `operator.machine_id` 에 적고(바뀌면 전원에게
//!   `operator.changed`), 화면이 바로 알아야 하는 서명이 바뀌면 소유자에게만 `operator.changed`. 끊기면 기억을 잊는다.
//! - `upgrade.progress`: 한 줄씩 적고 최근 20줄만 남긴다. 오퍼레이터마다 기다리는 줄은 20개까지(넘치면 버린다).
//! - `gh.report`: 받을 모양으로 다시 지어 한 줄을 덮는다.
//!
//! 폐기된 오퍼레이터의 프레임은 적지 않는다(SQL 의 `revoked_at is null`) — 토큰 폐기와 소켓 끊김 사이의 틈.
use super::operator::OperatorCore;
use super::operator_hub::{Frame, is_machine_digest, is_version_string};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc};

pub const STATUS_MIN_INTERVAL: Duration = Duration::from_secs(10);
pub const UPGRADE_QUEUE_MAX: usize = 20;
const UPGRADE_HISTORY_MAX: i64 = 20;
const UPGRADE_ERROR_MAX: usize = 300;

// ---- HMAC·HKDF(SHA-256) — 의존을 늘리지 않고 sha2 위에 짓는다(RFC 2104 · RFC 5869) ----

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        k[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Sha256::new();
    inner.update(k.map(|b| b ^ 0x36));
    inner.update(msg);
    let mut outer = Sha256::new();
    outer.update(k.map(|b| b ^ 0x5c));
    outer.update(inner.finalize());
    outer.finalize().into()
}

/// 머신 묶음표 키 — env `HARKROOM_MACHINE_ID_KEY` 의 64자리 hex(32바이트). **파생된 키만** 받는다: 값은 TS `machineIdKey`
/// (`hkdfSync('sha256', HARKROOM_SECRET_KEY, salt=빈, 'harkroom operator machine id v1', 32)`)와 같은 바이트이고, 배포 쪽이 같은 HKDF 로
/// 만들어 넣는다. 앞단은 비밀 보관소의 마스터 키(`HARKROOM_SECRET_KEY`)를 읽지 않는다 — 그 키로는 모든 비밀을 풀 수 있다.
/// 꼴이 틀리면 None(경고 한 줄) — 그때는 `machine_id` 를 쓰지 않는다([`write_status`] 참고).
pub fn machine_id_key_from_env(raw: Option<&str>) -> Option<[u8; 32]> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        eprintln!("core: HARKROOM_MACHINE_ID_KEY unset — operator machine_id writes are skipped");
        return None;
    };
    let parsed = hex::decode(raw)
        .ok()
        .and_then(|b| <[u8; 32]>::try_from(b.as_slice()).ok());
    if parsed.is_none() {
        eprintln!(
            "core: HARKROOM_MACHINE_ID_KEY is not 64 hex chars — operator machine_id writes are skipped"
        );
    }
    parsed
}

/// TS `machineIdKey` 와 같은 파생 — 시험이 [`machine_id_key_from_env`] 에 넣을 값이 TS 와 바이트로 같은지 보는 데만 쓴다(앞단 코드는 부르지 않는다).
#[cfg(test)]
fn derive_machine_id_key(raw: Option<&str>) -> Option<[u8; 32]> {
    let secret = raw.map(str::trim).filter(|s| !s.is_empty())?;
    let prk = hmac_sha256(&[0u8; 32], secret.as_bytes());
    let mut info = b"harkroom operator machine id v1".to_vec();
    info.push(1);
    Some(hmac_sha256(&prk, &info))
}

/// TS `mixMachine`(키가 있을 때) — HMAC-SHA256(키, `owner:digest`). 키 없는 sha256 갈래는 옮기지 않는다(키가 없으면 쓰지 않는다).
pub fn mix_machine(key: &[u8; 32], owner: &str, digest: &str) -> String {
    hex::encode(hmac_sha256(key, format!("{owner}:{digest}").as_bytes()))
}

/// TS `statusSignature` — 턴 수·자격 증명 상태·MCP 상태. 같음 비교에만 쓰므로 TS 와 바이트가 같을 필요는 없다.
pub fn status_signature(status: &Value) -> String {
    let field = |v: &Value, k: &str| -> String {
        match v.get(k) {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Null) | None => String::new(),
            Some(other) => other.to_string(),
        }
    };
    let list = |key: &str, keys: &[&str]| -> Vec<String> {
        let mut v: Vec<String> = status
            .get(key)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|e| {
                keys.iter()
                    .map(|k| field(e, k))
                    .collect::<Vec<_>>()
                    .join(":")
            })
            .collect();
        v.sort();
        v
    };
    json!([
        status["turns"]["running"],
        status["turns"]["max"],
        list("credentials", &["kind", "name", "state"]),
        list("mcp", &["name", "defined", "auth", "clientIdFp"]),
    ])
    .to_string()
}

// ---- gh.report(TS `parseGhReport`) ----

fn gh_login_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 39 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn gh_scope_ok(s: &str) -> bool {
    // /^[a-z0-9][a-z0-9._-]{0,99}\/(?:\*|[a-z0-9._-]{1,100})$/
    let part = |p: &str, min: usize, max: usize| {
        p.len() >= min
            && p.len() <= max
            && p.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
            })
    };
    let Some((owner, name)) = s.split_once('/') else {
        return false;
    };
    let first = owner.bytes().next();
    first.is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && part(owner, 1, 100)
        && (name == "*" || part(name, 1, 100))
}

pub fn parse_gh_report(value: &Value) -> Option<Value> {
    let v = value.as_object()?;
    let logins_raw = v.get("logins")?.as_array()?;
    let mut logins: Vec<&str> = Vec::new();
    for l in logins_raw
        .iter()
        .filter_map(Value::as_str)
        .filter(|l| gh_login_ok(l))
    {
        if !logins.contains(&l) {
            logins.push(l);
        }
    }
    logins.truncate(64);
    let mut by_scope = Map::new();
    if let Some(m) = v.get("byScope").and_then(Value::as_object) {
        // JS `Object.entries` 는 넣은 순서다. serde_json 의 Map 은 키 순서로 정렬된다(preserve_order 없음) — 64개를 넘는
        // 객체에서 어느 64개를 남기는지가 TS 와 다를 수 있다. 오퍼레이터는 64개를 넘겨 보내지 않는다.
        for (k, l) in m.iter().take(64) {
            if gh_scope_ok(k)
                && let Some(l) = l.as_str().filter(|l| gh_login_ok(l))
            {
                by_scope.insert(k.clone(), json!(l));
            }
        }
    }
    let default_gh_user = v
        .get("defaultGhUser")
        .and_then(Value::as_str)
        .filter(|l| gh_login_ok(l));
    let mut reach = Vec::new();
    for r in v
        .get("reach")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(64)
    {
        let Some(r) = r.as_object() else { continue };
        let (Some(scope), Some(login)) = (
            r.get("scope")
                .and_then(Value::as_str)
                .filter(|s| gh_scope_ok(s)),
            r.get("login")
                .and_then(Value::as_str)
                .filter(|s| gh_login_ok(s)),
        ) else {
            continue;
        };
        let reachable = match r.get("reachable") {
            Some(Value::Bool(b)) => json!(b),
            Some(Value::String(s)) if s == "unknown" => json!("unknown"),
            _ => continue,
        };
        reach.push(json!({ "scope": scope, "login": login, "reachable": reachable }));
    }
    Some(
        json!({ "logins": logins, "byScope": by_scope, "defaultGhUser": default_gh_user, "reach": reach }),
    )
}

// ---- upgrade.progress(TS `parseUpgradeProgress`) ----

/// (단계, 앞 판, 새 판, 사유).
pub type Upgrade = (String, Option<String>, Option<String>, Option<String>);

pub fn parse_upgrade_progress(frame: &Map<String, Value>) -> Option<Upgrade> {
    let stage = frame.get("stage")?.as_str().filter(|s| {
        matches!(
            *s,
            "download" | "verify" | "unpack" | "restart" | "healthy" | "failed" | "rolled_back"
        )
    })?;
    let version = |k: &str| {
        frame
            .get(k)
            .filter(|v| is_version_string(v))
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    let error = frame
        .get("error")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .map(|s| {
            // 제어 문자 덩어리를 공백 하나로 바꾸고 다듬어 300자(UTF-16)에서 자른다.
            let mut out = String::new();
            let mut in_ctrl = false;
            for c in s.chars() {
                if (c as u32) < 0x20 || c as u32 == 0x7f {
                    if !in_ctrl {
                        out.push(' ');
                    }
                    in_ctrl = true;
                } else {
                    out.push(c);
                    in_ctrl = false;
                }
            }
            let trimmed = out.trim();
            let mut cut = String::new();
            let mut units = 0;
            for c in trimmed.chars() {
                units += c.len_utf16();
                if units > UPGRADE_ERROR_MAX {
                    break;
                }
                cut.push(c);
            }
            cut
        });
    Some((stage.to_owned(), version("from"), version("to"), error))
}

// ---- 일꾼 ----

pub fn spawn(core: Arc<OperatorCore>, machine_key: Option<[u8; 32]>, status_min: Duration) {
    let mut frames = core.hub.subscribe_frames();
    let mut closes = core.hub.subscribe_closes();
    let (up_tx, mut up_rx) = mpsc::unbounded_channel::<(String, Upgrade)>();
    let pending: Arc<Mutex<HashMap<String, usize>>> = Arc::default();

    // 업그레이드 줄은 한 줄로 세운다 — 도착 순서대로 insert 가 끝나야 이력 순서(id)와 20줄 자르기가 맞는다.
    {
        let core = core.clone();
        let pending = pending.clone();
        tokio::spawn(async move {
            while let Some((op, (stage, from, to, error))) = up_rx.recv().await {
                if let Err(_e) = write_upgrade(&core, &op, &stage, from, to, error).await {
                    eprintln!("core: operator upgrade write failed");
                }
                let mut p = pending.lock().unwrap_or_else(|e| e.into_inner());
                match p.get_mut(&op) {
                    Some(n) if *n > 1 => *n -= 1,
                    _ => {
                        p.remove(&op);
                    }
                }
            }
        });
    }

    tokio::spawn(async move {
        let mut last_at: HashMap<String, Instant> = HashMap::new();
        let mut last_sig: HashMap<String, String> = HashMap::new();
        let mut last_machine: HashMap<String, String> = HashMap::new();
        loop {
            tokio::select! {
                c = closes.recv() => match c {
                    Ok(op) => { last_at.remove(&op); last_sig.remove(&op); last_machine.remove(&op); }
                    Err(broadcast::error::RecvError::Lagged(_)) => { last_at.clear(); last_sig.clear(); last_machine.clear(); }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                f = frames.recv() => match f {
                    Ok((op, frame)) => handle(&core, machine_key.as_ref(), status_min, &up_tx, &pending,
                        &mut last_at, &mut last_sig, &mut last_machine, op, frame),
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            }
        }
    });
}

#[allow(clippy::too_many_arguments)]
fn handle(
    core: &Arc<OperatorCore>,
    machine_key: Option<&[u8; 32]>,
    status_min: Duration,
    up_tx: &mpsc::UnboundedSender<(String, Upgrade)>,
    pending: &Mutex<HashMap<String, usize>>,
    last_at: &mut HashMap<String, Instant>,
    last_sig: &mut HashMap<String, String>,
    last_machine: &mut HashMap<String, String>,
    op: String,
    frame: Frame,
) {
    match frame.get("type").and_then(Value::as_str).unwrap_or("") {
        "status" => {
            let now = Instant::now();
            if last_at
                .get(&op)
                .is_some_and(|at| now.duration_since(*at) < status_min)
            {
                return;
            }
            last_at.insert(op.clone(), now);
            let sig = core.hub.status(&op).map(|s| status_signature(&s));
            let sig_changed = sig.as_ref().is_some_and(|s| last_sig.get(&op) != Some(s));
            if let Some(s) = sig {
                last_sig.insert(op.clone(), s);
            }
            let machine = frame
                .get("machine")
                .filter(|m| is_machine_digest(m))
                .and_then(Value::as_str)
                .filter(|m| last_machine.get(&op).map(String::as_str) != Some(*m))
                .map(str::to_owned);
            if machine.is_none() && !sig_changed {
                return;
            }
            if let Some(m) = &machine {
                // TS 는 쓰기가 끝난 뒤 기억한다 — 여기는 먼저 기억한다(실패하면 다음 머신 값 변화까지 다시 쓰지 않는다; 머신은 바뀌지 않는 값).
                last_machine.insert(op.clone(), m.clone());
            }
            let core = core.clone();
            let key = machine_key.copied();
            tokio::spawn(async move {
                if write_status(&core, key.as_ref(), &op, machine, sig_changed)
                    .await
                    .is_err()
                {
                    eprintln!("core: operator status write failed");
                }
            });
        }
        "upgrade.progress" => {
            let Some(ev) = parse_upgrade_progress(&frame) else {
                return;
            };
            {
                let mut p = pending.lock().unwrap_or_else(|e| e.into_inner());
                let n = p.entry(op.clone()).or_insert(0);
                if *n >= UPGRADE_QUEUE_MAX {
                    eprintln!("core: operator upgrade frames are piling up — dropping");
                    return;
                }
                *n += 1;
            }
            let _ = up_tx.send((op, ev));
        }
        "gh.report" => {
            let Some(report) = frame.get("report").and_then(parse_gh_report) else {
                return;
            };
            let pool = core.write.clone();
            tokio::spawn(async move {
                let res = sqlx::query(
                    "insert into operator_gh_report (operator_id, logins, by_scope, default_gh_user, reach, reported_at) \
                     select id, $2::jsonb, $3::jsonb, $4, $5::jsonb, now() from operator where id = $1::uuid and revoked_at is null \
                     on conflict (operator_id) do update set logins = excluded.logins, by_scope = excluded.by_scope, \
                       default_gh_user = excluded.default_gh_user, reach = excluded.reach, reported_at = excluded.reported_at",
                )
                .bind(&op)
                .bind(report["logins"].to_string())
                .bind(report["byScope"].to_string())
                .bind(report["defaultGhUser"].as_str())
                .bind(report["reach"].to_string())
                .execute(&pool)
                .await;
                if res.is_err() {
                    eprintln!("core: operator gh report write failed");
                }
            });
        }
        _ => {}
    }
}

async fn write_status(
    core: &OperatorCore,
    key: Option<&[u8; 32]>,
    op: &str,
    machine: Option<String>,
    sig_changed: bool,
) -> Result<(), sqlx::Error> {
    let owner: Option<String> = sqlx::query_scalar(
        "select owner_account_id::text from operator where id = $1::uuid and revoked_at is null",
    )
    .bind(op)
    .fetch_optional(&core.write)
    .await?;
    let Some(owner) = owner else { return Ok(()) };
    let mut machine_changed = false;
    // 키가 없으면 machine_id 를 쓰지 않는다 — 키 없는 sha256 으로 떨어지면 TS 가 적은 값(HMAC)과 갈려 「머신 바뀜」이 거짓으로 뜬다.
    if let (Some(m), Some(k)) = (machine, key) {
        let mixed = mix_machine(k, &owner, &m);
        machine_changed = sqlx::query(
            "update operator set machine_id = $2 where id = $1::uuid and machine_id is distinct from $2 returning id",
        )
        .bind(op)
        .bind(mixed)
        .fetch_optional(&core.write)
        .await?
        .is_some();
    }
    if machine_changed {
        core.events
            .emit(json!({ "type": "operator.changed", "operatorId": op, "audience": "all" }));
    } else if sig_changed {
        core.events
            .emit(json!({ "type": "operator.changed", "operatorId": op, "audience": [owner] }));
    }
    Ok(())
}

async fn write_upgrade(
    core: &OperatorCore,
    op: &str,
    stage: &str,
    from: Option<String>,
    to: Option<String>,
    error: Option<String>,
) -> Result<(), sqlx::Error> {
    let owner: Option<String> = sqlx::query_scalar(
        "with op as (select id, owner_account_id from operator where id = $1::uuid and revoked_at is null), \
              ins as (insert into operator_upgrade (operator_id, stage, from_version, to_version, error) \
                      select id, $2, $3, $4, $5 from op returning operator_id) \
         select owner_account_id::text from op where exists (select 1 from ins)",
    )
    .bind(op)
    .bind(stage)
    .bind(from)
    .bind(to)
    .bind(error)
    .fetch_optional(&core.write)
    .await?;
    let Some(owner) = owner else { return Ok(()) };
    sqlx::query(
        "delete from operator_upgrade where operator_id = $1::uuid \
            and id not in (select id from operator_upgrade where operator_id = $1::uuid order by id desc limit $2)",
    )
    .bind(op)
    .bind(UPGRADE_HISTORY_MAX)
    .execute(&core.write)
    .await?;
    core.events
        .emit(json!({ "type": "operator.changed", "operatorId": op, "audience": [owner] }));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_mix_matches_node() {
        // node: hkdfSync('sha256', 'test-secret', '', 'harkroom operator machine id v1', 32) → createHmac(..).update('owner:'+'a'*64)
        let key = derive_machine_id_key(Some(" test-secret ")).unwrap();
        assert_eq!(
            hex::encode(key),
            "c57f31f721311623fb1f603b51fb5eba9315be057506ff27d45f2811b3495309"
        );
        let d = "a".repeat(64);
        assert_eq!(
            mix_machine(&key, "owner", &d),
            "86b9d3f01f1b646b05c15076956da6879eae62b6bdabaeddc0d10596644e1a2d"
        );
        assert!(derive_machine_id_key(Some("  ")).is_none());
        // 배포가 넣는 env 값(파생 키 hex)을 그대로 읽으면 같은 키다.
        assert_eq!(
            machine_id_key_from_env(Some(&format!(" {} ", hex::encode(key)))),
            Some(key)
        );
        assert_eq!(machine_id_key_from_env(None), None);
        assert_eq!(
            machine_id_key_from_env(Some("test-secret")),
            None,
            "원문 비밀은 받지 않는다"
        );
        assert_eq!(
            machine_id_key_from_env(Some(&"ab".repeat(31))),
            None,
            "31바이트"
        );
    }

    #[test]
    fn signature_ignores_times_and_order() {
        let a = json!({ "turns": { "running": 1, "max": null },
            "credentials": [{ "kind": "gh", "name": "b", "state": "present" }, { "kind": "claude", "name": "a", "state": "expired" }],
            "mcp": [{ "name": "x", "defined": true, "auth": "ok", "authAt": "2026-01-01T00:00:00.000Z" }] });
        let b = json!({ "turns": { "running": 1, "max": null },
            "credentials": [{ "kind": "claude", "name": "a", "state": "expired" }, { "kind": "gh", "name": "b", "state": "present" }],
            "mcp": [{ "name": "x", "defined": true, "auth": "ok", "authAt": "2026-02-02T00:00:00.000Z" }] });
        assert_eq!(status_signature(&a), status_signature(&b));
        let c = json!({ "turns": { "running": 2, "max": null } });
        assert_ne!(status_signature(&a), status_signature(&c));
    }

    #[test]
    fn gh_report_rebuilt_from_allowed_shape() {
        let r = parse_gh_report(&json!({
            "logins": ["octo", "octo", "bad name", 3], "token": "x",
            "byScope": { "acme/*": "octo", "Acme/x": "octo", "acme/web": "bad name" },
            "defaultGhUser": "",
            "reach": [{ "scope": "acme/web", "login": "octo", "reachable": "unknown" }, { "scope": "acme/web", "login": "octo", "reachable": "yes" }]
        }))
        .unwrap();
        assert_eq!(
            r,
            json!({ "logins": ["octo"], "byScope": { "acme/*": "octo" }, "defaultGhUser": null,
            "reach": [{ "scope": "acme/web", "login": "octo", "reachable": "unknown" }] })
        );
        assert!(parse_gh_report(&json!({ "byScope": {} })).is_none());
        assert!(parse_gh_report(&json!([])).is_none());
    }

    #[test]
    fn upgrade_progress_shape() {
        let f = |v: Value| parse_upgrade_progress(v.as_object().unwrap());
        assert!(f(json!({ "stage": "nope" })).is_none());
        assert_eq!(
            f(json!({ "stage": "failed", "from": "0.1", "to": "", "error": " a\n\n\tb " })),
            Some((
                "failed".into(),
                Some("0.1".into()),
                None,
                Some("a b".into())
            ))
        );
        let long = f(json!({ "stage": "failed", "error": "x".repeat(400) }))
            .unwrap()
            .3
            .unwrap();
        assert_eq!(long.len(), 300);
    }
}
