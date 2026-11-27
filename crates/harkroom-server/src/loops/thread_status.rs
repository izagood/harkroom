//! 스레드 상태 이모지 감시(P5) — TS `services/threadStatus.ts` 의 `startThreadStatusWatcher`·`refreshThreadStatus`·
//! `syncStatusReaction` 과 shared `threadStatus.ts` 의 `decideThreadStatus` 를 옮긴다.
//!
//! - **이벤트로 돈다**(tick 이 없다). outbox 허브를 구독해 이벤트가 건드린 루트를 모으고, 루트마다 마지막 이벤트에서
//!   [`DEBOUNCE`] 뒤에 한 번 판정한다(TS `debounceMs = 300`). 다시 판정하는 때는 TS 와 같다:
//!   `message.created`·`message.updated`(루트 = `threadRootId ?? id`) · `thread.reportWakes.changed`(그 `rootId`) ·
//!   상태 이모지가 떼어진 `reaction.removed`(그 `messageId`) · `presence.changed`(그 에이전트가 주인인 running·received·stuck 루트).
//! - **판정은 한 번에 하나**다(한 태스크가 차례로 돈다). TS 는 루트마다 직렬이고 루트끼리는 겹쳤는데, 여기선 루트끼리도 직렬이다 —
//!   낡은 사실이 나중에 써지는 일(#1030 security N1)은 같은 이유로 없다.
//! - **주인**: 묶음마다 문지기([`run_gated`], 이름 `thread.status`) 아래서 돈다. 주인이 아니면 그 묶음을 버린다(TS 가 판정한다).
//!   잠금을 못 잡으면(다른 Rust 프로세스가 같은 이름으로 돌고 있으면) 버리지 않고 다음 차례에 다시 한다. 줄이 없으면 주인은
//!   `rust` 다(TS 백엔드를 지운 11-21 부터 — `loops.rs` 머리).
//! - 문장은 TS 가 정본이다 — 사실 모으기·리액션 맞추기·`thread_status` 쓰기·지우기·presence 루트를 `golden/sql_fragments.json` 으로 읽는다.
//! - 쓰기와 이벤트는 한 트랜잭션이다(outbox 는 커밋돼야 나간다). TS 는 쓰기마다 따로 커밋하고 이벤트를 메모리 버스로 냈다 —
//!   결과(행·이벤트 모양·순서)는 같다.
//! - 온라인 목록은 TS `presence.online()` 대신 `agent_presence`(만료 전) 를 읽는다 — 그 표는 러너 폴마다 TS·Rust 가 함께 쓴다.
use super::{GateResult, Side, run_gated};
use crate::core::audience::audience_on;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::time::Instant;

/// TS `debounceMs` 기본값.
pub const DEBOUNCE: Duration = Duration::from_millis(300);

/// 이 감시가 쓰는 권한 — 운영 GRANT 와 같아야 한다. 하나라도 없으면 `main.rs` 가 띄우지 않는다(TS 에 남는다).
pub const THREAD_STATUS_PRIVILEGES: &[(&str, &str)] = &[
    ("message", "SELECT"),
    ("account", "SELECT"),
    ("channel", "SELECT"),
    ("channel_member", "SELECT"),
    ("agent_wake", "SELECT"),
    ("inbox", "SELECT"),
    ("agent_presence", "SELECT"),
    ("message_reaction", "SELECT"),
    ("message_reaction", "INSERT"),
    ("message_reaction", "DELETE"),
    ("thread_status", "SELECT"),
    ("thread_status", "INSERT"),
    ("thread_status", "UPDATE"),
    ("thread_status", "DELETE"),
    ("event_outbox", "INSERT"),
];
pub const THREAD_STATUS_SEQUENCE_PRIVILEGES: &[(&str, &str)] = &[("event_outbox_id_seq", "USAGE")];

/// TS `THREAD_STATUS_EMOJI`.
pub fn status_emoji(status: &str) -> Option<&'static str> {
    Some(match status {
        "received" => "👀",
        "running" => "💬",
        "waiting" => "⏳",
        "my-turn" => "🙋",
        "stuck" => "🚨",
        "done" => "✅",
        _ => return None,
    })
}

const STATUS_EMOJIS: [&str; 6] = ["👀", "💬", "⏳", "🙋", "🚨", "✅"];

struct Sql {
    facts: String,
    sync: String,
    upsert: String,
    delete: String,
    presence_roots: String,
}

fn sql() -> &'static Sql {
    static S: std::sync::OnceLock<Sql> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let g = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_owned()
        };
        // 사실 칸은 json — sqlx 에 json 기능이 없어 글자로 받는다(값은 TS 가 받는 JSON 과 같은 글자다).
        let facts = format!(
            "select human_ask::text, failure::text, denied_mention::text, agent_wait::text, open_wake::text, \
                    open_report_wake::text, pending_mention::text, last::text, agent_involved, channel_id::text \
               from ({}) f",
            crate::core::wake_source::either_if_on(
                &g("thread_status_facts"),
                crate::core::wake_source::FACTS_FROM,
                " i join t ",
                2
            )
        );
        // 쓰기 문장(데이터를 바꾸는 WITH)은 감쌀 수 없다 — TS 문장이 글자 칸(`account_id::text`·`updated_at_iso`)을 함께 돌려준다.
        let upsert = g("thread_status_upsert");
        let sync = g("thread_status_sync_reaction");
        let presence_roots = format!(
            "select root_id::text from ({}) r",
            g("thread_status_presence_roots")
        );
        Sql {
            facts,
            sync,
            upsert,
            delete: g("thread_status_delete"),
            presence_roots,
        }
    })
}

/// TS `ThreadStatusFacts` — SQL 이 모은 사실. 칸은 JSON 그대로(없으면 null).
#[derive(Debug, Clone, Default)]
pub struct Facts {
    pub human_ask: Option<Value>,
    pub failure: Option<Value>,
    pub denied_mention: Option<Value>,
    pub agent_wait: Option<Value>,
    pub open_wake: Option<Value>,
    pub open_report_wake: Option<Value>,
    pub pending_mention: Option<Value>,
    pub last: Option<Value>,
    pub agent_involved: bool,
}

/// TS `ThreadStatusDecision`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Decision {
    pub status: &'static str,
    pub account_id: Option<String>,
    pub reason: Option<String>,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

fn d(status: &'static str, account_id: Option<String>, reason: Option<String>) -> Option<Decision> {
    Some(Decision {
        status,
        account_id,
        reason,
    })
}

/// TS `decideThreadStatus` — 위에서부터 이긴다. `live` 가 `None` 이면 「모른다」(붉게 칠하지 않는다).
pub fn decide(f: &Facts, live: Option<&HashSet<String>>) -> Option<Decision> {
    if !f.agent_involved {
        return None;
    }
    if let Some(a) = &f.human_ask {
        return d("my-turn", s(a, "askerId"), s(a, "prompt"));
    }
    if let Some(x) = &f.failure {
        let gate = x.get("gate").and_then(Value::as_bool) == Some(true);
        return d(
            if gate { "my-turn" } else { "stuck" },
            s(x, "accountId"),
            s(x, "what"),
        );
    }
    if let Some(m) = &f.denied_mention {
        // TS `targets.filter(string)` 뒤 `join(', ') || null`.
        let targets: Vec<&str> = m
            .get("targets")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let joined = targets.join(", ");
        return d(
            "stuck",
            s(m, "authorId"),
            (!joined.is_empty()).then_some(joined),
        );
    }
    let last_progress = f.last.as_ref().and_then(|l| {
        (l.get("authorIsAgent").and_then(Value::as_bool) == Some(true)
            && l.get("kind").and_then(Value::as_str) == Some("progress"))
        .then(|| s(l, "authorId"))
        .flatten()
    });
    if let (Some(p), Some(live)) = (&last_progress, live)
        && !live.contains(p)
        && f.open_wake.is_none()
        && f.agent_wait.is_none()
    {
        return d("stuck", Some(p.clone()), None);
    }
    if let Some(w) = &f.agent_wait {
        return d("waiting", s(w, "waiterId"), s(w, "blockedById"));
    }
    if let Some(w) = &f.open_wake {
        return d("waiting", s(w, "accountId"), s(w, "wakeAt"));
    }
    if let Some(w) = &f.open_report_wake {
        return d("waiting", s(w, "accountId"), s(w, "wakeAt"));
    }
    if let Some(p) = last_progress {
        return d("running", Some(p), None);
    }
    if let Some(m) = &f.pending_mention {
        return d("received", s(m, "agentId"), None);
    }
    let last_agent = f.last.as_ref().and_then(|l| {
        (l.get("authorIsAgent").and_then(Value::as_bool) == Some(true))
            .then(|| s(l, "authorId"))
            .flatten()
    });
    d("done", last_agent, None)
}

fn parse_json(t: Option<String>) -> Option<Value> {
    t.and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .filter(|v| !v.is_null())
}

type FactsRow = (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<bool>,
    Option<String>,
);

/// TS `readThreadStatusFacts` — 루트가 아니거나 없으면 `None`.
pub async fn read_facts(
    conn: &mut sqlx::PgConnection,
    root: &str,
) -> sqlx::Result<Option<(String, Facts)>> {
    let r: Option<FactsRow> = sqlx::query_as(sql().facts.as_str())
        .bind(root)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(r) = r else { return Ok(None) };
    let Some(channel) = r.9 else { return Ok(None) };
    Ok(Some((
        channel,
        Facts {
            human_ask: parse_json(r.0),
            failure: parse_json(r.1),
            denied_mention: parse_json(r.2),
            agent_wait: parse_json(r.3),
            open_wake: parse_json(r.4),
            open_report_wake: parse_json(r.5),
            pending_mention: parse_json(r.6),
            last: parse_json(r.7),
            agent_involved: r.8 == Some(true),
        },
    )))
}

/// `agent_presence` 에서 만료 전인 에이전트 — TS `presence.online()`.
async fn online(conn: &mut sqlx::PgConnection) -> sqlx::Result<HashSet<String>> {
    let ids: Vec<String> =
        sqlx::query_scalar("select account_id::text from agent_presence where expires_at > now()")
            .fetch_all(&mut *conn)
            .await?;
    Ok(ids.into_iter().collect())
}

/// 한 루트를 다시 판정한다 — TS `refreshThreadStatus`. 돌려주는 값: 바뀐 `thread_status`(`Some(Some)`=새 값, `Some(None)`=지움),
/// 안 바뀌었으면 `None`.
pub async fn refresh(pool: &PgPool, root: &str) -> sqlx::Result<Option<Option<Value>>> {
    let mut tx = pool.begin().await?;
    let Some((channel, facts)) = read_facts(&mut tx, root).await? else {
        return Ok(None);
    };
    let live = online(&mut tx).await?;
    let decision = decide(&facts, Some(&live));

    // syncStatusReaction
    let emoji = decision.as_ref().and_then(|x| status_emoji(x.status));
    let account = decision.as_ref().and_then(|x| x.account_id.clone());
    let changed: Vec<(String, String, String)> = sqlx::query_as(sql().sync.as_str())
        .bind(root)
        .bind(account.as_deref())
        .bind(emoji)
        .fetch_all(&mut *tx)
        .await?;
    let mut audience: Option<Value> = None;
    for (op, acc, em) in &changed {
        if audience.is_none() {
            audience = Some(audience_on(&mut tx, &channel).await?.to_json());
        }
        let ty = if op == "added" {
            "reaction.added"
        } else {
            "reaction.removed"
        };
        let ev = json!({
            "type": ty, "channelId": channel, "messageId": root, "emoji": em, "accountId": acc,
            "audience": audience.clone().unwrap_or(Value::Null),
        });
        crate::write::emit_event(&mut tx, &ev).await?;
    }

    let out = match &decision {
        None => {
            let del = sqlx::query(sql().delete.as_str())
                .bind(root)
                .execute(&mut *tx)
                .await?;
            if del.rows_affected() == 0 {
                None
            } else {
                let aud = match audience {
                    Some(a) => a,
                    None => audience_on(&mut tx, &channel).await?.to_json(),
                };
                let ev = json!({
                    "type": "thread.status", "channelId": channel, "rootId": root,
                    "statusReaction": Value::Null, "audience": aud,
                });
                crate::write::emit_event(&mut tx, &ev).await?;
                Some(None)
            }
        }
        Some(dec) => {
            let emoji = status_emoji(dec.status).unwrap_or_default();
            let updated: Option<(String,)> = sqlx::query_as(sql().upsert.as_str())
                .bind(root)
                .bind(dec.status)
                .bind(emoji)
                .bind(dec.account_id.as_deref())
                .bind(dec.reason.as_deref())
                .fetch_optional(&mut *tx)
                .await?;
            match updated {
                None => None,
                Some((at,)) => {
                    let reaction = json!({
                        "status": dec.status, "emoji": emoji, "accountId": dec.account_id,
                        "reason": dec.reason, "updatedAt": at,
                    });
                    let aud = match audience {
                        Some(a) => a,
                        None => audience_on(&mut tx, &channel).await?.to_json(),
                    };
                    let ev = json!({
                        "type": "thread.status", "channelId": channel, "rootId": root,
                        "statusReaction": reaction, "audience": aud,
                    });
                    crate::write::emit_event(&mut tx, &ev).await?;
                    Some(Some(reaction))
                }
            }
        }
    };
    tx.commit().await?;
    Ok(out)
}

/// 이 이벤트가 다시 판정을 부르는 루트 — TS `rootOf` + 감시의 갈래. presence 는 DB 를 봐야 해서 따로([`Trigger::Presence`]).
#[derive(Debug, PartialEq, Eq)]
pub enum Trigger {
    Root(String),
    Presence(String),
    None,
}

pub fn trigger_of(e: &Value) -> Trigger {
    let ty = e.get("type").and_then(Value::as_str).unwrap_or_default();
    let str_of = |k: &str| e.get(k).and_then(Value::as_str).map(str::to_owned);
    match ty {
        "message.created" | "message.updated" => {
            let m = e.get("message");
            let root = m
                .and_then(|m| m.get("threadRootId"))
                .and_then(Value::as_str)
                .or_else(|| m.and_then(|m| m.get("id")).and_then(Value::as_str));
            root.map_or(Trigger::None, |r| Trigger::Root(r.to_owned()))
        }
        "thread.reportWakes.changed" => str_of("rootId").map_or(Trigger::None, Trigger::Root),
        "reaction.removed" => match (str_of("emoji"), str_of("messageId")) {
            (Some(em), Some(id)) if STATUS_EMOJIS.contains(&em.as_str()) => Trigger::Root(id),
            _ => Trigger::None,
        },
        "presence.changed" => str_of("accountId").map_or(Trigger::None, Trigger::Presence),
        _ => Trigger::None,
    }
}

/// 루트를 모아 두는 자리 — 마지막 이벤트에서 [`DEBOUNCE`] 가 지나면 판정할 때가 된다.
#[derive(Default)]
pub struct Pending {
    due: HashMap<String, Instant>,
}

impl Pending {
    pub fn schedule(&mut self, root: String, now: Instant) {
        self.due.insert(root, now + DEBOUNCE);
    }
    /// 때가 된 루트(오래된 차례대로).
    pub fn take_due(&mut self, now: Instant) -> Vec<String> {
        let mut ready: Vec<(String, Instant)> = self
            .due
            .iter()
            .filter(|(_, at)| **at <= now)
            .map(|(r, at)| (r.clone(), *at))
            .collect();
        ready.sort_by_key(|(_, at)| *at);
        for (r, _) in &ready {
            self.due.remove(r);
        }
        ready.into_iter().map(|(r, _)| r).collect()
    }
    pub fn next_due(&self) -> Option<Instant> {
        self.due.values().min().copied()
    }
}

/// 감시를 띄운다. `events` 는 outbox 허브 구독.
pub fn spawn(
    gate: PgPool,
    pool: PgPool,
    mut events: broadcast::Receiver<Arc<Value>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut pending = Pending::default();
        loop {
            let wait = pending.next_due();
            tokio::select! {
                ev = events.recv() => match ev {
                    Ok(e) => match trigger_of(&e) {
                        Trigger::Root(r) => pending.schedule(r, Instant::now()),
                        Trigger::Presence(acc) => {
                            match sqlx::query_scalar::<_, String>(sql().presence_roots.as_str())
                                .bind(&acc)
                                .fetch_all(&pool)
                                .await
                            {
                                Ok(roots) => {
                                    let now = Instant::now();
                                    for r in roots {
                                        pending.schedule(r, now);
                                    }
                                }
                                Err(e) => eprintln!("loop thread.status: presence roots failed: {e}"),
                            }
                        }
                        Trigger::None => {}
                    },
                    // 밀려서 놓친 이벤트가 있다 — 그 루트들은 다음 말에서 다시 판정된다(TS 버스도 프로세스가 바쁘면 같다).
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        eprintln!("loop thread.status: lagged {n} events");
                    }
                    Err(broadcast::error::RecvError::Closed) => return,
                },
                _ = async {
                    match wait {
                        Some(at) => tokio::time::sleep_until(at).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    let roots = pending.take_due(Instant::now());
                    if roots.is_empty() {
                        continue;
                    }
                    let res = run_gated(&gate, "thread.status", Side::Rust, || async {
                        for r in &roots {
                            if let Err(e) = refresh(&pool, r).await {
                                eprintln!("loop thread.status: refresh failed: {e}");
                            }
                        }
                        Ok::<(), sqlx::Error>(())
                    })
                    .await;
                    match res {
                        // 다른 프로세스가 돌고 있다 — 버리지 않고 다음 차례에 다시.
                        GateResult::Locked => {
                            let now = Instant::now();
                            for r in roots {
                                pending.schedule(r, now);
                            }
                        }
                        GateResult::Gate(e) => eprintln!("loop thread.status: gate failed: {e}"),
                        _ => {}
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn agent_last(kind: &str, id: &str) -> Option<Value> {
        Some(json!({"kind": kind, "authorId": id, "authorIsAgent": true}))
    }

    #[test]
    fn not_involved_is_none() {
        assert_eq!(decide(&Facts::default(), None), None);
    }

    #[test]
    fn order_matches_ts() {
        let mut f = Facts {
            agent_involved: true,
            ..Facts::default()
        };
        assert_eq!(decide(&f, None).unwrap().status, "done");
        f.pending_mention = Some(json!({"agentId": "a"}));
        assert_eq!(
            decide(&f, None).unwrap(),
            Decision {
                status: "received",
                account_id: Some("a".into()),
                reason: None
            }
        );
        f.last = agent_last("progress", "p");
        assert_eq!(decide(&f, None).unwrap().status, "running");
        // 모르면 살아 있다고 둔다, 알면 죽은 에이전트의 진행은 🚨.
        let live: HashSet<String> = HashSet::new();
        assert_eq!(decide(&f, Some(&live)).unwrap().status, "stuck");
        f.open_report_wake = Some(json!({"accountId": "r", "wakeAt": "t"}));
        f.open_wake = Some(json!({"accountId": "w", "wakeAt": "t2"}));
        let x = decide(&f, Some(&live)).unwrap();
        assert_eq!((x.status, x.reason.as_deref()), ("waiting", Some("t2")));
        f.agent_wait = Some(json!({"waiterId": "x", "blockedById": null}));
        let x = decide(&f, None).unwrap();
        assert_eq!(
            (x.status, x.account_id.as_deref(), x.reason),
            ("waiting", Some("x"), None)
        );
        f.denied_mention = Some(json!({"authorId": "d", "targets": []}));
        let x = decide(&f, None).unwrap();
        assert_eq!((x.status, x.reason), ("stuck", None));
        f.denied_mention = Some(json!({"authorId": "d", "targets": ["a", 1, "b"]}));
        assert_eq!(decide(&f, None).unwrap().reason.as_deref(), Some("a, b"));
        f.failure = Some(json!({"accountId": "f", "what": null, "gate": true}));
        assert_eq!(decide(&f, None).unwrap().status, "my-turn");
        f.failure = Some(json!({"accountId": "f", "what": "boom", "gate": false}));
        assert_eq!(decide(&f, None).unwrap().status, "stuck");
        f.human_ask = Some(json!({"askerId": "h", "prompt": "q"}));
        let x = decide(&f, None).unwrap();
        assert_eq!(
            (x.status, x.account_id.as_deref(), x.reason.as_deref()),
            ("my-turn", Some("h"), Some("q"))
        );
    }

    #[test]
    fn done_owner_is_last_agent_only() {
        let f = Facts {
            agent_involved: true,
            last: Some(json!({"kind": "user", "authorId": "human", "authorIsAgent": false})),
            ..Facts::default()
        };
        assert_eq!(decide(&f, None).unwrap().account_id, None);
    }

    #[test]
    fn triggers() {
        assert_eq!(
            trigger_of(
                &json!({"type": "message.created", "message": {"id": "m", "threadRootId": "r"}})
            ),
            Trigger::Root("r".into())
        );
        assert_eq!(
            trigger_of(
                &json!({"type": "message.updated", "message": {"id": "m", "threadRootId": null}})
            ),
            Trigger::Root("m".into())
        );
        assert_eq!(
            trigger_of(&json!({"type": "reaction.removed", "messageId": "m", "emoji": "👍"})),
            Trigger::None
        );
        assert_eq!(
            trigger_of(&json!({"type": "reaction.removed", "messageId": "m", "emoji": "⏳"})),
            Trigger::Root("m".into())
        );
        assert_eq!(
            trigger_of(&json!({"type": "thread.reportWakes.changed", "rootId": "r"})),
            Trigger::Root("r".into())
        );
        assert_eq!(
            trigger_of(&json!({"type": "presence.changed", "accountId": "a", "online": false})),
            Trigger::Presence("a".into())
        );
        assert_eq!(
            trigger_of(&json!({"type": "message.deleted", "id": "m"})),
            Trigger::None
        );
    }

    #[test]
    fn debounce_collapses_and_orders() {
        let t0 = Instant::now();
        let mut p = Pending::default();
        p.schedule("a".into(), t0);
        p.schedule("b".into(), t0 + Duration::from_millis(100));
        p.schedule("a".into(), t0 + Duration::from_millis(200));
        assert!(p.take_due(t0 + Duration::from_millis(350)).is_empty());
        assert_eq!(
            p.take_due(t0 + Duration::from_millis(410)),
            vec!["b".to_string()]
        );
        assert_eq!(
            p.take_due(t0 + Duration::from_millis(510)),
            vec!["a".to_string()]
        );
        assert!(p.next_due().is_none());
    }

    #[test]
    fn golden_sql_present() {
        let s = sql();
        assert!(s.facts.contains("human_ask"));
        assert!(s.upsert.contains("insert into thread_status"));
        assert!(s.sync.contains("message_reaction"));
    }
}
