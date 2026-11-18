//! S5.4 A3 — MCP `turn.wake`. TS `mcpPlugin.ts` 의 같은 도구와 `services/agentWakes.ts::scheduleWake` 를 옮긴다:
//! 채널 가시성 → 보고처(가시성·머리, 앵커와 같으면 버림) → 감시면 열린 감시의 보고처 물려받기 → 위임 확인 → 연속 상한(20) →
//! 감시면 사슬 시작 지시(`watchOriginFor`) → 대기 줄 게시(`kind: 'wake'`) → 예약 행·감시 대체·닫힌 시각 → 신호.
//!
//! - **두 커밋**(TS 와 같다): 대기 줄은 [`msg_post::post_in_tx`] 가 자기 tx 로 커밋하고(`message.created` 도 그 outbox), 예약 행은 다음
//!   tx 다. 그 사이에 죽으면 「시계 없는 대기 줄」이 남는 창도 TS 와 같다(TS 주석: 예약 발송 sweep 과 같은 순서로 감수).
//!   다른 점: TS 는 `message.created` 를 예약 커밋 **뒤**에 내고, Rust 는 게시 커밋에서 낸다 — 화면에는 같은 줄이 조금 일찍 선다.
//! - **TS 로 넘기는 것**(`None` — 아무것도 쓰지 않았다): zod 가 받지 않을 인자 · 게시 전 DB 오류 · `post_in_tx` 가 TS 몫이라고 한 글.
//! - 게시가 **커밋된 뒤**의 오류는 TS 로 넘기지 않는다(넘기면 대기 줄이 두 번 선다) — `internal` 로 답한다. TS 는 같은 자리에서 던진다.
use super::msg_post::{FoldRow, closed_watch_view, fold_sql};
use super::tools::err;
use crate::auth::Account;
use crate::core::audience::audience_for;
use crate::core::cause_link;
use crate::core::msg_post::{self, Origin, Outcome, PostBody, PostState, iso_ms, now_ms};
use crate::core::msg_read::{channel_visible, is_uuid};
use crate::core::{turn_settle, wake_preempt};
use serde_json::{Map, Value, json};

/// 쓰기 풀에 이 권한이 다 있을 때만 Rust 가 답한다(`message.post` 권한에 더해) — 없으면 게시 **전에** TS 로 넘긴다.
/// 대기 줄만 서고 예약이 `internal` 로 실패하는 일을 막는다. 운영 GRANT: `grant select, insert on agent_wake` ·
/// `grant update (canceled_at) on agent_wake`.
pub const TURN_WAKE_PRIVILEGES: &[(&str, &str)] = &[
    ("agent_wake", "SELECT"),
    ("agent_wake", "INSERT"),
    ("agent_wake.canceled_at", "UPDATE"),
];

/// TS `WAKE_MIN_SEC`·`WAKE_MAX_SEC`·`MAX_CONSECUTIVE_WAKES`.
const WAKE_MIN_SEC: i64 = 60;
const WAKE_MAX_SEC: i64 = 6 * 60 * 60;
const MAX_CONSECUTIVE_WAKES: i32 = 20;
/// zod `reason.max(200)`(UTF-16).
const REASON_MAX: usize = 200;

/// TS `BAD_THREAD_MESSAGE`.
const BAD_THREAD: &str = "threadRootId must be a top-level message in this channel";

/// 골든 문장(TS `agentWakes.ts` 의 `WAKE_*`·`WATCH_ORIGIN_*` — `test/rustSqlFragments.test.ts` 가 대조한다).
struct Sql {
    report_head: String,
    delegation_held: String,
    consecutive: String,
    open_watch_report_to: String,
    origin_cause: String,
    origin_ok: String,
    insert: String,
    replace_watch: String,
}

fn sql() -> &'static Sql {
    static S: std::sync::OnceLock<Sql> = std::sync::OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        Sql {
            report_head: frag("wake_report_head"),
            delegation_held: frag("wake_delegation_held"),
            consecutive: frag("wake_consecutive"),
            open_watch_report_to: frag("wake_open_watch_report_to"),
            origin_cause: frag("watch_origin_cause"),
            origin_ok: frag("watch_origin_ok"),
            insert: frag("wake_insert"),
            replace_watch: frag("wake_replace_watch"),
        }
    })
}

/// zod 가 받는 인자. 모르는 키는 zod 처럼 버린다.
#[derive(Debug, PartialEq, Eq)]
struct Args {
    channel: String,
    thread: String,
    not_before_sec: i64,
    reason: String,
    report_to: Option<(String, String)>,
    watch: bool,
    delegation: Option<String>,
}

fn uuid_of(o: &Map<String, Value>, key: &str) -> Option<String> {
    o.get(key)?
        .as_str()
        .filter(|s| is_uuid(s))
        .map(str::to_owned)
}

/// zod `inputSchema` 를 그대로 받는 인자만 `Some`(틀린 꼴 → TS 가 검증 오류를 낸다).
fn parse(args: &Value) -> Option<Args> {
    let Value::Object(o) = args else { return None };
    let channel = uuid_of(o, "channelId")?;
    let thread = uuid_of(o, "threadRootId")?;
    // zod `number().int()` — JS 수라 `60.0` 도 정수다.
    let n = o.get("notBeforeSec")?.as_f64()?;
    if n.fract() != 0.0 || n < WAKE_MIN_SEC as f64 || n > WAKE_MAX_SEC as f64 {
        return None;
    }
    let reason = o.get("reason")?.as_str()?;
    let len = reason.encode_utf16().count();
    if len == 0 || len > REASON_MAX {
        return None;
    }
    let report_to = match o.get("reportTo") {
        None => None,
        Some(Value::Object(r)) => Some((uuid_of(r, "channelId")?, uuid_of(r, "threadRootId")?)),
        _ => return None,
    };
    let watch = match o.get("watch") {
        None => false,
        Some(Value::Bool(b)) => *b,
        _ => return None,
    };
    let delegation = match o.get("delegationId") {
        None => None,
        Some(_) => Some(uuid_of(o, "delegationId")?.to_lowercase()),
    };
    Some(Args {
        channel,
        thread,
        not_before_sec: n as i64,
        reason: reason.to_owned(),
        report_to,
        watch,
        delegation,
    })
}

/// TS `wake` meta — 키 순서는 jsonb 가 정하므로 뜻만 같다.
fn wake_meta(
    wake_at: &str,
    reason: &str,
    report: Option<&(String, String)>,
    watch: bool,
    origin: Option<&str>,
    delegation: Option<&str>,
) -> Map<String, Value> {
    let mut w = Map::new();
    w.insert("wakeAt".into(), Value::from(wake_at));
    w.insert("reason".into(), Value::from(reason));
    if let Some((c, t)) = report {
        w.insert(
            "reportTo".into(),
            json!({ "channelId": c, "threadRootId": t }),
        );
    }
    if watch {
        w.insert("watch".into(), Value::Bool(true));
    }
    if let Some(o) = origin {
        w.insert("origin".into(), Value::from(o));
    }
    if let Some(d) = delegation {
        w.insert("delegationId".into(), Value::from(d));
    }
    let mut meta = Map::new();
    meta.insert("kind".into(), Value::from("wake"));
    meta.insert("wake".into(), Value::Object(w));
    meta
}

/// TS `ORIGIN_ID_RE` — 대소문자 무관 uuid.
fn origin_id_ok(s: &str) -> bool {
    is_uuid(&s.to_ascii_lowercase())
}

/// TS `watchOriginFor`.
async fn watch_origin(
    st: &PostState,
    me: &str,
    channel: &str,
    thread: &str,
    chain_cause: Option<&str>,
) -> Result<Option<String>, sqlx::Error> {
    let Some(c) = chain_cause else {
        return Ok(None);
    };
    let mut conn = st.read.acquire().await?;
    let Some(cause) = cause_link::verified_cause_link(&mut conn, me, c, now_ms(), iso_ms).await?
    else {
        return Ok(None);
    };
    let row: Option<(String, Option<bool>, Option<String>)> =
        sqlx::query_as(sql().origin_cause.as_str())
            .bind(&cause)
            .fetch_optional(&mut *conn)
            .await?;
    let Some((kind, watch, origin)) = row else {
        return Ok(None);
    };
    let inherited = origin.filter(|o| kind == "wake" && watch == Some(true) && origin_id_ok(o));
    let candidate = inherited.unwrap_or(cause);
    let ok = sqlx::query(sql().origin_ok.as_str())
        .bind(&candidate)
        .bind(channel)
        .bind(thread)
        .fetch_optional(&mut *conn)
        .await?
        .is_some();
    Ok(ok.then_some(candidate))
}

/// 게시 전 판정 — `Ok(Err(답))` 은 거절 글자, `Err` 는 DB 오류(→ TS).
async fn pre_checks(
    st: &PostState,
    me: &str,
    a: &Args,
) -> Result<Result<Option<(String, String)>, String>, sqlx::Error> {
    if !channel_visible(&st.read, me, &a.channel).await? {
        return Ok(Err(err("forbidden", "not a member of this channel")));
    }
    // 보고처는 내가 쓸 수 있는 스레드 머리여야 한다. 앵커와 같으면 싣지 않는다(TS 는 글자 그대로 견준다).
    let mut report = None;
    if let Some((rc, rt)) = a.report_to.as_ref().filter(|(_, t)| *t != a.thread) {
        if !channel_visible(&st.read, me, rc).await? {
            return Ok(Err(err(
                "forbidden",
                "reportTo: not a member of that channel",
            )));
        }
        let head = sqlx::query(sql().report_head.as_str())
            .bind(rt)
            .bind(rc)
            .fetch_optional(&st.read)
            .await?
            .is_some();
        if !head {
            return Ok(Err(err(
                "bad_report_to",
                "reportTo.threadRootId 는 그 채널의 최상위 글(스레드 머리) id 여야 한다",
            )));
        }
        report = Some((rc.clone(), rt.clone()));
    }
    // TS `scheduleWake` — 대체될 감시의 보고처를 물려받는다(새 예약이 말하지 않았다고 다른 스레드의 약속이 사라지지 않게).
    if report.is_none() && a.watch {
        let v: Option<Option<Value>> = sqlx::query_scalar(sql().open_watch_report_to.as_str())
            .bind(&a.thread)
            .bind(me)
            .fetch_optional(&st.read)
            .await?;
        report = v.flatten().as_ref().and_then(turn_settle::report_to);
    }
    if let Some(d) = a.delegation.as_deref() {
        let held = sqlx::query(sql().delegation_held.as_str())
            .bind(d)
            .bind(me)
            .fetch_optional(&st.read)
            .await?
            .is_some();
        if !held {
            return Ok(Err(err(
                "bad_delegation",
                "내가 넘겼고 아직 결말이 안 난 위임만 적을 수 있다 — 결말이 났으면 예약이 필요 없다",
            )));
        }
    }
    let already: i32 = sqlx::query_scalar(sql().consecutive.as_str())
        .bind(&a.thread)
        .bind(me)
        .fetch_one(&st.read)
        .await?;
    if already >= MAX_CONSECUTIVE_WAKES {
        return Ok(Err(err(
            "wake_limit",
            &format!(
                "이 스레드에서 사람의 새 발화 없이 이미 {already}번 기다렸다 — 사람에게 알려라(message.fail)"
            ),
        )));
    }
    Ok(Ok(report))
}

/// 게시 뒤 tx — 예약 행 → 감시 대체·닫힌 시각 → 신호(outbox). 돌려주는 것은 (예약 id, `replaced` 조각들).
async fn schedule_tx(
    st: &PostState,
    me: &str,
    a: &Args,
    report: Option<&(String, String)>,
    message_id: &str,
    wake_at: &str,
) -> Result<(String, Vec<String>), sqlx::Error> {
    let mut tx = st.write.begin().await?;
    let target = report
        .map(|(_, t)| t.as_str())
        .unwrap_or(&a.thread)
        .to_lowercase();
    if a.watch {
        // 앵커와 보고처 둘 다로 줄 세운다 — 정렬해서 잡아 서로 기다리지 않게(TS 와 같은 키).
        let mut keys = vec![a.thread.to_lowercase(), target.clone()];
        keys.sort();
        keys.dedup();
        for t in keys {
            sqlx::query("select pg_advisory_xact_lock(hashtextextended($1, 0))")
                .bind(format!("agent_wake:watch:{me}:{t}"))
                .execute(&mut *tx)
                .await?;
        }
    }
    let id: String = sqlx::query_scalar(sql().insert.as_str())
        .bind(me)
        .bind(&a.channel)
        .bind(message_id)
        .bind(wake_at)
        .fetch_one(&mut *tx)
        .await?;
    let mut signal = wake_preempt::Preempted::default();
    let mut replaced = Vec::new();
    if a.watch {
        let rows: Vec<FoldRow> = sqlx::query_as(sql().replace_watch.as_str())
            .bind(&a.thread)
            .bind(me)
            .bind(&target)
            .bind(&id)
            .fetch_all(&mut *tx)
            .await?;
        if !rows.is_empty() {
            let ids: Vec<String> = rows.iter().map(|r| r.2.clone()).collect();
            let at = turn_settle::now_iso(&mut tx).await?;
            sqlx::query(fold_sql().1.as_str())
                .bind(&ids)
                .bind(at)
                .bind("canceledAt")
                .execute(&mut *tx)
                .await?;
        }
        for (wid, w_at, mid, body, deleted, report_to, root) in rows {
            let r = report_to.as_ref().and_then(turn_settle::report_to);
            replaced.push(closed_watch_view(
                &wid,
                &w_at,
                &mid,
                body.as_deref(),
                deleted,
                r.as_ref(),
                &root,
            ));
            if let Some(r) = r {
                signal.report.push(r);
            }
            signal.rows.push(mid);
        }
    }
    // TS `announceReportWakes([report, ...replaced 보고처])` — 새 예약의 보고처가 먼저다.
    if let Some(r) = report {
        signal.report.insert(0, r.clone());
    }
    wake_preempt::announce(&mut tx, &signal).await?;
    tx.commit().await?;
    Ok((id, replaced))
}

/// 답 글자. `None` 이면 TS 로 넘긴다(아무것도 쓰지 않았다).
pub async fn answer(
    st: &PostState,
    me: &Account,
    args: &Value,
    cause: Option<&str>,
    turn: Option<&str>,
    operator: bool,
) -> Option<String> {
    let a = parse(args)?;
    let report = match pre_checks(st, &me.id, &a).await.ok()? {
        Ok(r) => r,
        Err(refused) => return Some(refused),
    };
    // TS `chainCause`·`storedTurnId` — 오퍼레이터를 거친 요청의 헤더만. 깊이 원인(`causeMessageId`)은 싣지 않는다(TS 와 같다).
    let chain_cause = cause.filter(|_| operator);
    let wake_at = iso_ms(now_ms() + a.not_before_sec * 1_000);
    let origin_id = if a.watch {
        watch_origin(st, &me.id, &a.channel, &a.thread, chain_cause)
            .await
            .ok()?
    } else {
        None
    };
    let meta = wake_meta(
        &wake_at,
        &a.reason,
        report.as_ref(),
        a.watch,
        origin_id.as_deref(),
        a.delegation.as_deref(),
    );
    let is_dm = msg_post::channel_is_dm(&st.read, &a.channel).await.ok()?;
    let audience = audience_for(&st.read, &a.channel).await.ok()?.to_json();
    let origin = Origin {
        cause: None,
        chain_cause,
        turn_id: turn.filter(|_| operator),
        meta,
        server_notice: false,
        closes_delegation: false,
        delegation: None,
        system: false,
        progress: false,
        wake: true,
    };
    let post = PostBody {
        body: a.reason.clone(),
        attachment_ids: vec![],
        thread_root: Some(a.thread.clone()),
        also_in_channel: false,
    };
    let out = msg_post::post_in_tx(
        st,
        &a.channel,
        &me.id,
        me.kind == "agent",
        &post,
        None,
        &audience,
        is_dm,
        &origin,
    )
    .await
    .ok()?;
    let row = match out {
        Outcome::ToTs | Outcome::Replayed(_) | Outcome::ChainLimit => return None,
        Outcome::BadThread => return Some(err("bad_thread", BAD_THREAD)),
        // 깨움은 첨부를 받지 않는다 — TS 는 게시 거절을 이 글자로 답한다.
        Outcome::BadAttachment => {
            return Some(err("wake_limit", "wake 메시지를 게시할 수 없다"));
        }
        Outcome::Posted { row, .. } => row,
    };
    let message: Value = serde_json::from_str(&row).ok()?;
    let message_id = message.get("id").and_then(Value::as_str)?.to_owned();
    // 여기부터는 대기 줄이 이미 커밋됐다 — TS 로 넘기면 두 번 선다.
    let Ok((id, replaced)) =
        schedule_tx(st, &me.id, &a, report.as_ref(), &message_id, &wake_at).await
    else {
        return Some(err(
            "internal",
            "the wait line was posted but the wake could not be scheduled",
        ));
    };
    let wake = json!({ "id": id, "wakeAt": wake_at, "messageId": message_id }).to_string();
    let replaced = if replaced.is_empty() {
        String::new()
    } else {
        format!(",\"replaced\":[{}]", replaced.join(","))
    };
    // 행 글자는 그대로 싣는다 — 키 순서가 TS `JSON.stringify(row)` 와 같다.
    Some(super::respond::text_result(&format!(
        "{{\"wake\":{wake},\"message\":{row}{replaced}}}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    const C: &str = "11111111-1111-1111-1111-111111111111";
    const R: &str = "22222222-2222-2222-2222-222222222222";

    #[test]
    fn parse_like_zod() {
        let ok = parse(&json!({ "channelId": C, "threadRootId": R, "notBeforeSec": 60.0, "reason": "r", "extra": 1 })).unwrap();
        assert_eq!(ok.not_before_sec, 60);
        assert!(!ok.watch && ok.report_to.is_none() && ok.delegation.is_none());
        for bad in [
            json!({ "channelId": C, "threadRootId": R, "notBeforeSec": 59, "reason": "r" }),
            json!({ "channelId": C, "threadRootId": R, "notBeforeSec": 21601, "reason": "r" }),
            json!({ "channelId": C, "threadRootId": R, "notBeforeSec": 60.5, "reason": "r" }),
            json!({ "channelId": C, "threadRootId": R, "notBeforeSec": 60, "reason": "" }),
            json!({ "channelId": C, "threadRootId": R, "notBeforeSec": 60, "reason": "a".repeat(201) }),
            json!({ "channelId": C, "threadRootId": R, "notBeforeSec": 60, "reason": "r", "watch": null }),
            json!({ "channelId": C, "threadRootId": R, "notBeforeSec": 60, "reason": "r", "reportTo": { "channelId": C } }),
            json!({ "channelId": C, "threadRootId": R, "notBeforeSec": 60, "reason": "r", "delegationId": "x" }),
            json!({ "channelId": C, "threadRootId": "x", "notBeforeSec": 60, "reason": "r" }),
        ] {
            assert!(parse(&bad).is_none(), "{bad}");
        }
        // 200자는 UTF-16 으로 센다 — BMP 밖 글자는 2.
        assert!(parse(&json!({ "channelId": C, "threadRootId": R, "notBeforeSec": 60, "reason": "😀".repeat(100) })).is_some());
        assert!(parse(&json!({ "channelId": C, "threadRootId": R, "notBeforeSec": 60, "reason": "😀".repeat(101) })).is_none());
        let full = parse(&json!({
            "channelId": C, "threadRootId": R, "notBeforeSec": 21600, "reason": "r", "watch": true,
            "reportTo": { "channelId": C, "threadRootId": C, "x": 1 },
            "delegationId": "AAAAAAAA-1111-1111-1111-111111111111",
        }))
        .unwrap();
        assert!(full.watch);
        assert_eq!(full.report_to, Some((C.into(), C.into())));
        assert_eq!(
            full.delegation.as_deref(),
            Some("aaaaaaaa-1111-1111-1111-111111111111")
        );
    }

    #[test]
    fn golden_sql_loads() {
        let s = sql();
        assert!(s.insert.contains("insert into agent_wake"));
        assert!(s.replace_watch.contains("w.id <> $4::uuid"));
    }

    #[test]
    fn meta_like_ts() {
        let m = wake_meta("2030-01-01T00:00:00.000Z", "r", None, false, None, None);
        assert_eq!(
            Value::Object(m),
            json!({ "kind": "wake", "wake": { "wakeAt": "2030-01-01T00:00:00.000Z", "reason": "r" } })
        );
        let rt = (C.to_owned(), R.to_owned());
        let m = wake_meta("w", "r", Some(&rt), true, Some("o"), Some("d"));
        assert_eq!(
            Value::Object(m),
            json!({ "kind": "wake", "wake": { "wakeAt": "w", "reason": "r",
                "reportTo": { "channelId": C, "threadRootId": R }, "watch": true, "origin": "o", "delegationId": "d" } })
        );
    }
}
