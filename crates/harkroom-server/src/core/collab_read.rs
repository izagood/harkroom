//! S5.5 — `GET /collab/proposals`(TS `routes/collabRoutes.ts` + `avcs/proposalReader.ts` + `avcs/proposals.ts` + `avcs/client.ts`).
//!
//! 협업 탭이 읽는 제안 트리. 채널에 바인딩된 저장소마다 avcs 의 로그(`sync` → `objects/fetch`)를 커서로 따라잡고,
//! 파생 상태(`GET /reduced`, ETag)를 얹어 `intent` 를 뿌리로 접는다. 판정(상태·충돌)은 avcs 가 준 것을 그대로 쓴다.
//!
//! TS 와 같게 둔 것:
//! - 로그 캐시·환원 캐시는 **프로세스 메모리**다(키 `baseUrl repo view`). 재기동하면 0부터 다시 읽는다.
//! - 저장소 하나가 실패하면 그 줄만 `error: "unreachable"` 이고 나머지는 선다.
//! - 보고 있는 서버(URL)는 `GET /leases` 와 같은 규칙으로 푼다(`projection_config` → env `AVCS_BASE_URL`).
//!
//! TS 와 다른 것:
//! - avcs 응답 하나에 [`RESPONSE_MAX_BYTES`] 상한을 둔다(넘으면 그 저장소만 `unreachable`). TS 는 상한이 없다.
//! - 캐시 잠금은 커서를 읽을 때와 붙일 때만 쥔다 — avcs 호출 동안 다른 협업 요청을 막지 않는다.
//!
//! TS 로 넘기는 것(아무것도 읽기 전에):
//! - URL 이 `http://` 가 아닐 때 — 이 크레이트의 avcs 클라이언트는 TLS 를 못 붙는다. Rust 가 답하면 TS 는 읽는 것을 `unreachable` 이라 한다.
//! - 저장소가 둘 이상인데 이름에 `[a-z0-9/.-]` 밖의 글자가 있을 때 — TS 는 `localeCompare`(ICU)로 줄을 세우고 그 순서를 여기서 못 낸다.
//!
//! **읽기만 한다.** 필요한 SELECT 는 [`COLLAB_READ_PRIVILEGES`], 없으면 `main.rs` 가 TS 에 남긴다.
use crate::auth::RequireAccount;
use crate::directory::{internal, json_ok};
use crate::loops::projection::{FETCH_CHUNK, PROJECTED, repo_path, resolve_url};
use crate::proxy::Upstream;
use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::response::Response;
use http_body_util::{BodyExt, Full};
use hyper::body::Bytes;
use hyper_util::client::legacy::{Client, connect::HttpConnector};
use hyper_util::rt::TokioExecutor;
use serde_json::{Map, Value, json};
use sqlx::PgPool;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

/// 읽기 풀에 있어야 하는 권한.
pub const COLLAB_READ_PRIVILEGES: &[(&str, &str)] = &[
    ("projection_config", "SELECT"),
    ("channel.id", "SELECT"),
    ("channel.repo", "SELECT"),
    ("channel.kind", "SELECT"),
    ("account_key.key_id", "SELECT"),
    ("account_key.account_id", "SELECT"),
];

const TIMEOUT: Duration = Duration::from_secs(30);
/// avcs 응답 하나의 바이트 상한(TS 에는 없다). 로그 조각(`FETCH_CHUNK` 개)·환원 상태가 이보다 크면 그 저장소는 `unreachable`.
pub const RESPONSE_MAX_BYTES: usize = 32 * 1024 * 1024;

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn opt(v: &str) -> Option<String> {
    (!v.is_empty()).then(|| v.to_owned())
}

/// TS `actorId` — 객체(배열 포함)일 때만 `id` 를 읽는다.
fn actor_id(v: &Value) -> Option<String> {
    opt(s(v.get("id")?))
}

fn first_str(v: &Value) -> Option<String> {
    v.as_array()?
        .iter()
        .find_map(Value::as_str)
        .map(str::to_owned)
}

/// TS `referencedOp`.
fn referenced_op(obj: &Value) -> Option<String> {
    match s(&obj["type"]) {
        "decision" => first_str(&obj["chosenOps"]),
        "evidence" => first_str(&obj["forOps"]),
        _ => None,
    }
}

/// TS `AvcsLogEntry` 중 제안 조립(`buildProposals`)이 읽는 네 타입. 나머지 타입은 엔트리가 되지만 조립이 버린다.
#[derive(Debug, Clone, PartialEq)]
enum Kind {
    Intent,
    Operation,
    Evidence,
    Decision,
}

#[derive(Debug, Clone, PartialEq)]
struct Entry {
    log_index: i64,
    oid: String,
    kind: Kind,
    actor_key_id: Option<String>,
    intent_oid: Option<String>,
    summary: String,
    /// `(changesBehavior, breaksPublicApi)` — operation 이 `effects` 를 선언했을 때만.
    effects: Option<(bool, bool)>,
}

/// TS `toEntries` — 조립이 쓰는 타입만. `intent_of_op` 는 op → intent.
fn to_entry(
    obj: &Value,
    oid: &str,
    log_index: i64,
    intent_of_op: &HashMap<String, Option<String>>,
) -> Option<Entry> {
    let via_op =
        |obj: &Value| referenced_op(obj).and_then(|r| intent_of_op.get(&r).cloned().flatten());
    let (kind, actor_key_id, intent_oid, summary, effects) = match s(&obj["type"]) {
        "intent" => (
            Kind::Intent,
            opt(s(&obj["owner"])),
            Some(oid.to_owned()),
            s(&obj["title"]).to_owned(),
            None,
        ),
        "operation" => {
            let eff = &obj["effects"];
            let declared = (eff.is_object() || eff.is_array()).then(|| {
                (
                    eff.get("changesBehavior") == Some(&Value::Bool(true)),
                    eff.get("breaksPublicApi") == Some(&Value::Bool(true)),
                )
            });
            (
                Kind::Operation,
                actor_id(&obj["actor"]),
                opt(s(&obj["intentOid"])),
                s(&obj["declaredPurpose"]).to_owned(),
                declared,
            )
        }
        "decision" => (
            Kind::Decision,
            actor_id(&obj["decidedBy"]),
            via_op(obj),
            s(&obj["reason"]).to_owned(),
            None,
        ),
        "evidence" => (
            Kind::Evidence,
            actor_id(&obj["producedBy"]),
            via_op(obj),
            format!("{} {}", s(&obj["kind"]), s(&obj["result"]))
                .trim()
                .to_owned(),
            None,
        ),
        _ => return None,
    };
    Some(Entry {
        log_index,
        oid: oid.to_owned(),
        kind,
        actor_key_id,
        intent_oid,
        summary,
        effects,
    })
}

// ---- avcs HTTP(TS `client.ts`) ----

type Http = Client<HttpConnector, Full<Bytes>>;

struct Got {
    status: u16,
    etag: Option<String>,
    bytes: Bytes,
}

async fn http(
    client: &Http,
    method: hyper::Method,
    url: String,
    body: Option<Value>,
    if_none_match: Option<&str>,
) -> Result<Got, String> {
    let mut req = hyper::Request::builder().method(method).uri(url);
    if let Some(e) = if_none_match {
        req = req.header("if-none-match", e);
    }
    let payload = match body {
        Some(b) => {
            req = req.header("content-type", "application/json");
            Bytes::from(b.to_string())
        }
        None => Bytes::new(),
    };
    let req = req.body(Full::new(payload)).map_err(|e| e.to_string())?;
    let work = async {
        let res = client.request(req).await.map_err(|e| e.to_string())?;
        let status = res.status().as_u16();
        let etag = res
            .headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(str::to_owned);
        // 응답 크기 상한 — 넘으면 그 저장소만 `unreachable`(메모리를 avcs 응답 크기에 맡기지 않는다).
        let bytes = http_body_util::Limited::new(res.into_body(), RESPONSE_MAX_BYTES)
            .collect()
            .await
            .map_err(|e| e.to_string())?
            .to_bytes();
        Ok(Got {
            status,
            etag,
            bytes,
        })
    };
    tokio::time::timeout(TIMEOUT, work)
        .await
        .map_err(|_| "timeout".to_owned())?
}

fn parse(got: &Got, what: &str) -> Result<Value, String> {
    if !(200..300).contains(&got.status) {
        return Err(format!("avcs {what} failed: {}", got.status));
    }
    serde_json::from_slice(&got.bytes).map_err(|e| e.to_string())
}

/// TS `fetchObjects`.
async fn fetch_objects(
    client: &Http,
    base: &str,
    repo: &str,
    oids: &[String],
) -> Result<HashMap<String, Value>, String> {
    let mut out = HashMap::new();
    for chunk in oids.chunks(FETCH_CHUNK) {
        let got = http(
            client,
            hyper::Method::POST,
            format!("{base}/{}/objects/fetch", repo_path(repo)),
            Some(json!({ "oids": chunk })),
            None,
        )
        .await?;
        let body = parse(&got, "objects/fetch")?;
        let Some(objects) = body["objects"].as_array() else {
            return Err("avcs objects/fetch: no objects".to_owned());
        };
        for o in objects {
            if let Some(oid) = o["oid"].as_str() {
                out.insert(oid.to_owned(), o.clone());
            }
        }
        if body["truncated"].as_bool() == Some(true) {
            break;
        }
    }
    Ok(out)
}

fn type_of_oid(oid: &str) -> &str {
    match oid.find('_') {
        Some(i) if i > 0 => &oid[..i],
        _ => "",
    }
}

/// TS `fetchSince` — 엔트리와 다음 커서.
async fn fetch_since(
    client: &Http,
    base: &str,
    repo: &str,
    since: i64,
) -> Result<(Vec<Entry>, i64), String> {
    let got = http(
        client,
        hyper::Method::GET,
        format!("{base}/{}/sync?since={since}", repo_path(repo)),
        None,
        None,
    )
    .await?;
    let body = parse(&got, "sync")?;
    let cursor = body["cursor"].as_i64().unwrap_or(0);
    let oids: Vec<String> = match &body["oids"] {
        Value::Null => vec![],
        Value::Array(a) => a
            .iter()
            .map(|v| v.as_str().map(str::to_owned).ok_or("avcs sync: bad oid"))
            .collect::<Result<_, _>>()?,
        _ => return Err("avcs sync: bad oids".to_owned()),
    };
    // logIndex는 필터 전 objlog 위치다.
    let wanted: Vec<(String, i64)> = oids
        .into_iter()
        .enumerate()
        .map(|(i, o)| (o, since + i as i64 + 1))
        .filter(|(o, _)| PROJECTED.contains(&type_of_oid(o)))
        .collect();
    if wanted.is_empty() {
        return Ok((vec![], cursor));
    }
    let want_oids: Vec<String> = wanted.iter().map(|(o, _)| o.clone()).collect();
    let objects = fetch_objects(client, base, repo, &want_oids).await?;

    // op → intent. 이번 배치의 operation 에서 먼저 채우고, 앞선 배치에 있던 op 는 모아서 한 번 더 받는다.
    let mut intent_of_op: HashMap<String, Option<String>> = HashMap::new();
    for (oid, obj) in &objects {
        if s(&obj["type"]) == "operation" {
            intent_of_op.insert(oid.clone(), opt(s(&obj["intentOid"])));
        }
    }
    let missing: BTreeSet<String> = objects
        .values()
        .filter_map(referenced_op)
        .filter(|r| !intent_of_op.contains_key(r))
        .collect();
    if !missing.is_empty() {
        let more: Vec<String> = missing.into_iter().collect();
        for (oid, obj) in fetch_objects(client, base, repo, &more).await? {
            if s(&obj["type"]) == "operation" {
                intent_of_op.insert(oid, opt(s(&obj["intentOid"])));
            }
        }
    }

    let mut entries = vec![];
    let mut next = cursor;
    for (oid, log_index) in &wanted {
        let Some(obj) = objects.get(oid) else {
            // 배치가 실어오지 못한 객체 — 커서를 이 앞에 세워 다음에 다시 받는다.
            next = next.min(log_index - 1);
            break;
        };
        entries.extend(to_entry(obj, oid, *log_index, &intent_of_op));
    }
    Ok((entries, next))
}

/// TS `AvcsReduced` 중 조립이 읽는 칸.
#[derive(Debug, Clone, Default, PartialEq)]
struct Reduced {
    cursor: Value,
    materializer: String,
    tree_hash: String,
    statuses: Value,
    blocked: Value,
    conflicts: Vec<Value>,
    etag: Option<String>,
}

fn reduced_of(body: &Value, etag: Option<String>) -> Result<Reduced, String> {
    if body.is_null() {
        return Err("avcs reduced: null body".to_owned());
    }
    Ok(Reduced {
        cursor: if body["cursor"].is_number() {
            body["cursor"].clone()
        } else {
            json!(0)
        },
        materializer: s(&body["materializer"]).to_owned(),
        tree_hash: s(&body["treeHash"]).to_owned(),
        statuses: body["statuses"].clone(),
        blocked: body["blockedReasons"].clone(),
        conflicts: body["conflicts"].as_array().cloned().unwrap_or_default(),
        etag,
    })
}

enum ReducedRead {
    NotModified,
    Missing,
    Got(Box<Reduced>),
}

/// TS `fetchReduced` — 304 는 「안 바뀜」, 404 는 「환원 평면 없음」(오류 아님).
async fn fetch_reduced(
    client: &Http,
    base: &str,
    repo: &str,
    etag: Option<&str>,
) -> Result<ReducedRead, String> {
    let got = http(
        client,
        hyper::Method::GET,
        format!("{base}/{}/reduced?view=main", repo_path(repo)),
        None,
        etag.filter(|e| !e.is_empty()),
    )
    .await?;
    match got.status {
        304 => Ok(ReducedRead::NotModified),
        404 => Ok(ReducedRead::Missing),
        _ => {
            let body = parse(&got, "reduced")?;
            Ok(ReducedRead::Got(Box::new(reduced_of(
                &body,
                got.etag.clone(),
            )?)))
        }
    }
}

// ---- 조립(TS `proposals.ts`) ----

struct Op {
    oid: String,
    purpose: String,
    actor: Option<String>,
    status: Value,
    blocked: Value,
    effects: Option<(bool, bool)>,
    evidence: Vec<Value>,
}

struct Proposal {
    intent_oid: String,
    title: String,
    owner: Option<String>,
    last_log_index: i64,
    ops: Vec<Op>,
    decisions: Vec<Value>,
    conflicts: Vec<Value>,
}

fn state_order(state: &str) -> u8 {
    match state {
        "needs_decision" => 0,
        "check_failed" => 1,
        "open" => 2,
        "unknown" => 3,
        "accepted" => 4,
        _ => 5,
    }
}

/// TS `stateOf` — 막는 것이 이긴다.
fn state_of(p: &Proposal, has_reduced: bool) -> &'static str {
    if !has_reduced {
        return "unknown";
    }
    if !p.conflicts.is_empty() {
        return "needs_decision";
    }
    let st: Vec<&str> = p
        .ops
        .iter()
        .map(|o| o.status.as_str().unwrap_or("\u{0}"))
        .collect();
    if st.contains(&"needs_decision") {
        return "needs_decision";
    }
    if st.contains(&"quarantined") {
        return "check_failed";
    }
    if st.iter().any(|x| *x == "proposed" || *x == "validating") {
        return "open";
    }
    if st.is_empty() {
        return "open";
    }
    if st.iter().all(|x| *x == "accepted") {
        return "accepted";
    }
    if st.iter().all(|x| *x == "rejected" || *x == "superseded") {
        return "rejected";
    }
    "open"
}

fn effects_json(e: (bool, bool)) -> Value {
    json!({ "changesBehavior": e.0, "breaksPublicApi": e.1 })
}

/// JS `a ?? null` — 없는 칸은 null.
fn or_null(map: &Value, key: &str) -> Value {
    map.get(key).cloned().unwrap_or(Value::Null)
}

/// TS `buildProposals` → `{ proposals, reducedAt }` 와 그 안의 actor 키.
fn build(
    entries: &[Entry],
    reduced: Option<&Reduced>,
    keys: &mut BTreeSet<String>,
) -> (Value, Value) {
    let mut props: Vec<Proposal> = vec![];
    let mut by_intent: HashMap<String, usize> = HashMap::new();
    // op oid → (제안, 그 안의 op 자리). 같은 oid 가 다시 오면 뒤 것이 이긴다(TS `opIndex.set`).
    let mut op_index: HashMap<String, (usize, usize)> = HashMap::new();
    let null = Value::Null;
    let statuses = reduced.map_or(&null, |r| &r.statuses);
    let blocked = reduced.map_or(&null, |r| &r.blocked);

    for e in entries {
        if e.kind == Kind::Intent {
            let p = Proposal {
                intent_oid: e.oid.clone(),
                title: e.summary.clone(),
                owner: e.actor_key_id.clone(),
                last_log_index: e.log_index,
                ops: vec![],
                decisions: vec![],
                conflicts: vec![],
            };
            match by_intent.get(&e.oid) {
                Some(&i) => {
                    op_index.retain(|_, (pi, _)| *pi != i);
                    props[i] = p;
                }
                None => {
                    by_intent.insert(e.oid.clone(), props.len());
                    props.push(p);
                }
            }
            continue;
        }
        let Some(&i) = e.intent_oid.as_ref().and_then(|o| by_intent.get(o)) else {
            continue;
        };
        let p = &mut props[i];
        p.last_log_index = p.last_log_index.max(e.log_index);
        match e.kind {
            Kind::Operation => {
                op_index.insert(e.oid.clone(), (i, p.ops.len()));
                p.ops.push(Op {
                    oid: e.oid.clone(),
                    purpose: e.summary.clone(),
                    actor: e.actor_key_id.clone(),
                    status: or_null(statuses, &e.oid),
                    blocked: or_null(blocked, &e.oid),
                    effects: e.effects,
                    evidence: vec![],
                });
            }
            Kind::Evidence => {
                // 제안의 마지막 op 에 붙인다(TS 와 같다).
                if let Some(host) = p.ops.last_mut() {
                    host.evidence.push(json!({
                        "oid": e.oid, "summary": e.summary, "actorKeyId": e.actor_key_id,
                    }));
                    keys.extend(e.actor_key_id.clone());
                }
            }
            Kind::Decision => {
                p.decisions.push(json!({
                    "oid": e.oid, "reason": e.summary, "decidedByKeyId": e.actor_key_id,
                }));
                keys.extend(e.actor_key_id.clone());
            }
            Kind::Intent => {}
        }
    }

    for c in reduced.map_or(&[][..], |r| &r.conflicts) {
        let mut seen: HashSet<usize> = HashSet::new();
        for o in c["options"].as_array().into_iter().flatten() {
            let Some(&(pi, _)) = o["opOid"].as_str().and_then(|oid| op_index.get(oid)) else {
                continue;
            };
            if !seen.insert(pi) {
                continue;
            }
            let mut m = Map::new();
            for k in ["id", "key", "reason"] {
                if let Some(v) = c.get(k) {
                    m.insert(k.to_owned(), v.clone());
                }
            }
            props[pi].conflicts.push(Value::Object(m));
        }
    }

    let mut out: Vec<(u8, i64, Value)> = props
        .into_iter()
        .map(|p| {
            let state = state_of(&p, reduced.is_some());
            let declared: Vec<(bool, bool)> = p.ops.iter().filter_map(|o| o.effects).collect();
            let effects = if declared.is_empty() {
                Value::Null
            } else {
                effects_json((declared.iter().any(|e| e.0), declared.iter().any(|e| e.1)))
            };
            keys.extend(p.owner.clone());
            let ops: Vec<Value> = p
                .ops
                .into_iter()
                .map(|o| {
                    keys.extend(o.actor.clone());
                    let mut m = Map::new();
                    m.insert("oid".into(), json!(o.oid));
                    m.insert("purpose".into(), json!(o.purpose));
                    m.insert("actorKeyId".into(), json!(o.actor));
                    m.insert("status".into(), o.status);
                    m.insert("blockedReason".into(), o.blocked);
                    if let Some(e) = o.effects {
                        m.insert("effects".into(), effects_json(e));
                    }
                    m.insert("evidence".into(), Value::Array(o.evidence));
                    Value::Object(m)
                })
                .collect();
            let v = json!({
                "intentOid": p.intent_oid,
                "title": p.title,
                "ownerKeyId": p.owner,
                "lastLogIndex": p.last_log_index,
                "ops": ops,
                "decisions": p.decisions,
                "state": state,
                "conflicts": p.conflicts,
                "effects": effects,
            });
            (state_order(state), p.last_log_index, v)
        })
        .collect();
    // 안정 정렬 — 같은 자리는 로그에 나온 순서 그대로(JS `sort` 와 같다).
    out.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    let reduced_at = reduced.map_or(
        Value::Null,
        |r| json!({ "cursor": r.cursor, "materializer": r.materializer, "treeHash": r.tree_hash }),
    );
    (
        Value::Array(out.into_iter().map(|x| x.2).collect()),
        reduced_at,
    )
}

// ---- 읽기(TS `ProposalReader`) ----

#[derive(Default)]
struct Cache {
    logs: HashMap<String, (Vec<Entry>, i64)>,
    reductions: HashMap<String, Option<Reduced>>,
}

#[derive(Clone)]
pub struct CollabState {
    pub read: PgPool,
    pub up: Upstream,
    client: Http,
    /// 커서·ETag 를 읽을 때와 결과를 붙일 때만 잠깐 쥔다 — avcs 호출 동안에는 놓는다(느린 avcs 뒤에 협업 요청이 줄 서지 않게).
    /// 같은 구간을 두 요청이 겹쳐 붙이지 않도록, 붙일 때 커서가 읽은 때 그대로인지 본다([`read_repo`]).
    cache: Arc<tokio::sync::Mutex<Cache>>,
}

impl CollabState {
    pub fn new(read: PgPool, up: Upstream) -> Self {
        Self {
            read,
            up,
            client: Client::builder(TokioExecutor::new()).build_http(),
            cache: Arc::default(),
        }
    }
}

async fn read_repo(
    client: &Http,
    cache: &tokio::sync::Mutex<Cache>,
    base: &str,
    repo: &str,
    keys: &mut BTreeSet<String>,
) -> Result<(Value, Value), String> {
    let key = format!("{base} {repo} main");
    // 1) 잠깐 쥐고 커서·ETag 만 읽는다.
    let (since, cached) = {
        let c = cache.lock().await;
        (
            c.logs.get(&key).map_or(0, |l| l.1),
            c.reductions.get(&key).cloned().flatten(),
        )
    };
    // 2) 잠금 없이 avcs 를 읽는다.
    let (entries, next) = fetch_since(client, base.trim_end_matches('/'), repo, since).await?;
    let etag = cached.as_ref().and_then(|r| r.etag.clone());
    let fetched = fetch_reduced(client, base.trim_end_matches('/'), repo, etag.as_deref()).await?;
    // 3) 다시 쥐고 붙인다. 그 사이 다른 요청이 커서를 옮겼으면 그쪽이 같은 구간을 이미 붙였다 — 이 조각은 버린다.
    let mut c = cache.lock().await;
    let log = c.logs.entry(key.clone()).or_default();
    if log.1 == since {
        log.0.extend(entries);
        log.1 = next;
    }
    let reduced = match fetched {
        // 304 — 그 사이 더 새 환원이 들어왔으면 그것을 쓴다.
        ReducedRead::NotModified => c.reductions.get(&key).cloned().flatten().or(cached),
        ReducedRead::Missing => None,
        ReducedRead::Got(r) => Some(*r),
    };
    c.reductions.insert(key.clone(), reduced.clone());
    let entries = &c.logs[&key].0;
    Ok(build(entries, reduced.as_ref(), keys))
}

/// TS 의 `localeCompare` 줄 세우기를 바이트 순서로 낼 수 있는 이름인가.
fn plain_name(repo: &str) -> bool {
    repo.bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"/.-".contains(&b))
}

/// 바인딩 줄(나온 순서)을 저장소로 접는다 — `None` 이면 줄 세우기를 TS 에 맡긴다.
fn fold_repos(bound: Vec<(String, String)>) -> Option<Vec<(String, Vec<String>)>> {
    let mut out: Vec<(String, Vec<String>)> = vec![];
    for (repo, channel) in bound {
        match out.iter_mut().find(|(r, _)| *r == repo) {
            Some((_, ids)) => ids.push(channel),
            None => out.push((repo, vec![channel])),
        }
    }
    if out.len() > 1 && !out.iter().all(|(r, _)| plain_name(r)) {
        return None;
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Some(out)
}

pub async fn proposals(
    State(st): State<Arc<CollabState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    _: RequireAccount,
    req: Request,
) -> Response {
    let to_ts = |req: Request| async {
        let (parts, _) = req.into_parts();
        crate::proxy::forward(
            State(st.up.clone()),
            ConnectInfo(peer),
            Request::from_parts(parts, Body::empty()),
        )
        .await
    };
    let app: Option<String> =
        match sqlx::query_scalar("select avcs_base_url from projection_config where id = true")
            .fetch_optional(&st.read)
            .await
        {
            Ok(v) => v.flatten(),
            Err(e) => return internal(e),
        };
    let env = std::env::var("AVCS_BASE_URL")
        .ok()
        .filter(|v| !v.is_empty());
    let Some(base) = resolve_url(env.as_deref(), app.as_deref()) else {
        return json_ok(r#"{"baseUrl":null,"repos":[]}"#.to_owned());
    };
    if !base.starts_with("http://") {
        return to_ts(req).await;
    }
    let bound: Vec<(String, String)> = match sqlx::query_as(
        "select repo, id::text from channel where repo is not null and kind = 'standard'",
    )
    .fetch_all(&st.read)
    .await
    {
        Ok(v) => v,
        Err(e) => return internal(e),
    };
    let Some(by_repo) = fold_repos(bound) else {
        return to_ts(req).await;
    };

    let mut keys = BTreeSet::new();
    let mut repos = vec![];
    {
        for (repo, channel_ids) in by_repo {
            let mut repo_keys = BTreeSet::new();
            match read_repo(&st.client, &st.cache, &base, &repo, &mut repo_keys).await {
                Ok((proposals, reduced_at)) => {
                    keys.extend(repo_keys);
                    repos.push(json!({
                        "repo": repo, "channelIds": channel_ids, "error": null,
                        "proposals": proposals, "reducedAt": reduced_at,
                    }));
                }
                Err(e) => {
                    eprintln!("collab: repo read failed ({e})");
                    repos.push(json!({
                        "repo": repo, "channelIds": channel_ids, "error": "unreachable",
                        "proposals": [], "reducedAt": null,
                    }));
                }
            }
        }
    }

    let mut actors = Map::new();
    if !keys.is_empty() {
        let ids: Vec<String> = keys.into_iter().collect();
        let rows: Vec<(String, String)> = match sqlx::query_as(
            "select key_id, account_id::text from account_key where key_id = any($1::text[])",
        )
        .bind(ids)
        .fetch_all(&st.read)
        .await
        {
            Ok(v) => v,
            Err(e) => return internal(e),
        };
        for (k, a) in rows {
            actors.insert(k, json!(a));
        }
    }
    json_ok(json!({ "baseUrl": base, "repos": repos, "actors": actors }).to_string())
}

pub fn routes(
    st: CollabState,
    auth: crate::auth::AuthPools,
    cors: Arc<crate::cors::Cors>,
) -> crate::route_table::Routes<()> {
    use crate::route_table::Table;
    let t = Table::<Arc<CollabState>>::new()
        .get("/collab/proposals", proposals)
        .map(|r| {
            r.route_layer(axum::middleware::from_fn_with_state(
                auth,
                crate::auth::layer,
            ))
            .layer(axum::middleware::from_fn_with_state(
                cors,
                crate::cors::layer,
            ))
        })
        .finish();
    crate::route_table::Routes {
        router: t.router.with_state(Arc::new(st)),
        http: t.http,
        sockets: t.sockets,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entries(objs: &[(&str, Value)], ops: &[(&str, &str)]) -> Vec<Entry> {
        let map: HashMap<String, Option<String>> = ops
            .iter()
            .map(|(o, i)| ((*o).to_owned(), Some((*i).to_owned())))
            .collect();
        objs.iter()
            .enumerate()
            .filter_map(|(i, (oid, o))| to_entry(o, oid, i as i64 + 1, &map))
            .collect()
    }

    #[test]
    fn tree_folds_like_ts() {
        let es = entries(
            &[
                (
                    "intent_a",
                    json!({"type": "intent", "owner": "k1", "title": "A"}),
                ),
                (
                    "intent_b",
                    json!({"type": "intent", "owner": "", "title": "B"}),
                ),
                (
                    "operation_1",
                    json!({"type": "operation", "actor": {"id": "k2"}, "intentOid": "intent_a",
                           "declaredPurpose": "p1", "effects": {"changesBehavior": true}}),
                ),
                (
                    "evidence_1",
                    json!({"type": "evidence", "forOps": ["operation_1"], "producedBy": {"id": "k3"},
                           "kind": "test", "result": "pass"}),
                ),
                (
                    "decision_1",
                    json!({"type": "decision", "chosenOps": ["operation_1"], "decidedBy": {"id": "k1"}, "reason": "ok"}),
                ),
                (
                    "operation_x",
                    json!({"type": "operation", "intentOid": "intent_gone", "declaredPurpose": "lost"}),
                ),
                ("lease_1", json!({"type": "lease", "writeScopes": ["a"]})),
            ],
            &[("operation_1", "intent_a")],
        );
        assert_eq!(es.len(), 6, "lease 는 조립 재료가 아니다");
        let mut keys = BTreeSet::new();
        // 환원 평면 없음 → 전부 unknown, 로그 늦은 것이 위.
        let (p, at) = build(&es, None, &mut keys);
        assert_eq!(at, Value::Null);
        assert_eq!(p[0]["intentOid"], "intent_a");
        assert_eq!(p[0]["state"], "unknown");
        assert_eq!(p[0]["lastLogIndex"], 5);
        assert_eq!(p[0]["ops"][0]["status"], Value::Null);
        assert_eq!(
            p[0]["ops"][0]["effects"],
            json!({"changesBehavior": true, "breaksPublicApi": false})
        );
        assert_eq!(p[0]["ops"][0]["evidence"][0]["summary"], "test pass");
        assert_eq!(p[0]["decisions"][0]["decidedByKeyId"], "k1");
        assert_eq!(p[1]["ownerKeyId"], Value::Null);
        assert_eq!(p[1]["effects"], Value::Null);
        assert_eq!(
            keys.into_iter().collect::<Vec<_>>(),
            ["k1", "k2", "k3"],
            "뿌리 없는 op 의 키는 없다"
        );

        // 환원 평면 — 충돌이 걸린 제안이 위로, op 없는 intent 는 open.
        let r = reduced_of(
            &json!({"cursor": 7, "materializer": "m", "treeHash": "t",
                    "statuses": {"operation_1": "accepted"},
                    "blockedReasons": {"operation_1": "why"},
                    "conflicts": [{"id": "c1", "key": "file:a", "kind": "k", "reason": "r",
                                   "options": [{"opOid": "operation_1"}, {"opOid": "operation_1"}, {"opOid": "nope"}]}]}),
            Some("e".into()),
        )
        .unwrap();
        let (p, at) = build(&es, Some(&r), &mut BTreeSet::new());
        assert_eq!(
            at,
            json!({"cursor": 7, "materializer": "m", "treeHash": "t"})
        );
        assert_eq!(p[0]["state"], "needs_decision");
        assert_eq!(
            p[0]["conflicts"],
            json!([{"id": "c1", "key": "file:a", "reason": "r"}])
        );
        assert_eq!(p[0]["ops"][0]["blockedReason"], "why");
        assert_eq!(p[1]["state"], "open");
        let mut r2 = r.clone();
        r2.conflicts.clear();
        let (p, _) = build(&es, Some(&r2), &mut BTreeSet::new());
        assert_eq!(p[0]["intentOid"], "intent_b", "open 이 accepted 보다 위");
        assert_eq!(p[1]["state"], "accepted");
    }

    #[test]
    fn repo_fold_and_order_guard() {
        let b = |v: &[(&str, &str)]| {
            v.iter()
                .map(|(r, c)| ((*r).to_owned(), (*c).to_owned()))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            fold_repos(b(&[("o/b", "1"), ("o/a", "2"), ("o/b", "3")])),
            Some(vec![
                ("o/a".to_owned(), vec!["2".to_owned()]),
                ("o/b".to_owned(), vec!["1".to_owned(), "3".to_owned()]),
            ])
        );
        assert_eq!(fold_repos(b(&[("o/B", "1"), ("o/a", "2")])), None);
        assert_eq!(fold_repos(b(&[("o/a_b", "1"), ("o/a", "2")])), None);
        assert!(
            fold_repos(b(&[("O/Weird_", "1")])).is_some(),
            "하나뿐이면 순서가 없다"
        );
        assert!(reduced_of(&Value::Null, None).is_err());
    }
}
