//! S5.3 C6a-3a — 받은함 목록의 기본 줄(TS `listInbox` 의 기본 SELECT 와 팀 명단). 라우트(`GET /inbox`)는 아직 잇지 않는다 —
//! 덧붙임(위임 결말·요약·넘겨받은 일·접힌 깨움·시작한 곳, C6a-3b)과 `threads=1`(C6a-3c)이 들어온 뒤에 연결해야
//! 응답 모양이 TS 와 갈리지 않는다.
//!
//! - 문장은 TS 정본 `LIST_INBOX_SQL`(갈래 다섯)·`INBOX_TEAM_ROSTER_SQL`(`services/messages.ts`) 그대로 — `golden/sql_fragments.json`
//!   에서 읽는다. TS 가 칸·조건을 고치면 `rustSqlFragments.test.ts` 가 골든 갱신을 요구한다.
//! - 행 JSON 은 Postgres 가 만든다(`row_to_json`, 칸 순서 = 열 순서). node-pg 가 `Date` 로 읽는 맨 겉 timestamptz 둘(`readAt`·
//!   `createdAt`)만 toISOString 꼴로 바꾼다. TS 가 지우는 키도 여기서 뺀다: `teamId`(늘), `viaEdit`·`bodyTruncated`(참이 아닐 때).
//! - 상한 페이지(`newest`)는 안쪽이 id 내림차순으로 자르고 겉이 id 오름차순으로 되돌린다 — TS 의 `rows.reverse()` 와 같은 순서.
//! - 팀 부름이면 맨 끝 키로 `team`({id, name, members:[{accountId, handle, specialty, disabled}]})을 붙인다 — TS 가 객체에 키를
//!   더하는 자리와 같다. 명단은 한 번에 읽는다(팀마다 왕복하지 않는다). 팀이 지워졌으면 `team` 없이 나간다.
use serde_json::Value;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::OnceLock;

/// TS `INBOX_PAGE_LIMIT` — `since`·`unread` 없는 `GET /inbox` 가 싣는 최신 줄 수.
pub const INBOX_PAGE_LIMIT: i64 = 200;

struct Sql {
    unread: String,
    unread_since: String,
    since: String,
    newest: String,
    newest_before: String,
    roster: String,
    handed: String,
    folded: String,
    started: String,
}

/// 갈래 문장을 감싼다 — 행마다 (본문 json, id, 이유, 팀 id). 겉 `order by` 는 id 오름차순(TS 응답 순서).
fn wrap(branch: &str) -> String {
    format!(
        "select (select json_object_agg(e.key, case e.key \
               when 'readAt' then to_json({}) \
               when 'createdAt' then to_json({}) \
               else e.value end order by e.ord) \
             from json_each(row_to_json(t)) with ordinality as e(key, value, ord) \
             where e.key <> 'teamId' \
               and not (e.key in ('viaEdit', 'bodyTruncated') and e.value::text <> 'true'))::text as body, \
           t.id::int8 as id, t.\"teamId\"::text as team_id, t.\"messageId\"::text as message_id, t.reason \
         from ({branch}) t order by t.id",
        crate::iso!("t.\"readAt\""),
        crate::iso!("t.\"createdAt\""),
    )
}

fn sql() -> &'static Sql {
    static S: OnceLock<Sql> = OnceLock::new();
    S.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../golden/sql_fragments.json"))
            .expect("golden/sql_fragments.json");
        let frag = |k: &str| {
            v[k].as_str()
                .unwrap_or_else(|| panic!("golden fragment {k}"))
                .to_string()
        };
        Sql {
            unread: wrap(&frag("list_inbox_unread")),
            unread_since: wrap(&frag("list_inbox_unreadSince")),
            since: wrap(&frag("list_inbox_since")),
            newest: wrap(&frag("list_inbox_newest")),
            newest_before: wrap(&frag("list_inbox_newestBefore")),
            // 겉에서 uuid 를 글자로 바꾼다(sqlx 는 uuid 기능 없이 묶는다). 순서는 안쪽과 같은 handle.
            roster: format!(
                "select r.id::text, r.name, r.\"accountId\"::text, r.handle, r.specialty, r.disabled \
                 from ({}) r order by r.handle",
                frag("inbox_team_roster")
            ),
            handed: format!(
                "select h.message_id::text, h.\"leadHandle\", h.\"teamName\", {} from ({}) h",
                crate::iso!("h.\"deadlineAt\""),
                frag("inbox_handed")
            ),
            // 안쪽 `order by w.wake_at` 을 겉에서 다시 건다(바깥 select 는 안쪽 순서를 지킨다는 보장이 없다).
            folded: format!(
                "select f.by::text, f.reason, {}, f.\"reportTo\"::text from ({}) f order by f.\"wakeAt\"",
                crate::iso!("f.\"wakeAt\""),
                frag("inbox_folded_wakes")
            ),
            started: format!(
                "select s.\"messageId\"::text, s.\"channelId\"::text, s.\"threadRootId\"::text from ({}) s",
                frag("inbox_started_in")
            ),
        }
    })
}

/// `GET /inbox` 의 갈래(TS 라우트의 `listInbox`·`listInboxNewest` 부름과 같다).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InboxQuery {
    /// `unread=1`(러너 폴) — 안 읽은 것 전부, `since` 가 있으면 그 뒤만.
    Unread { since: Option<i64> },
    /// `since` 만 — 그 id 뒤의 것 전부(읽은 것 포함).
    Since(i64),
    /// 둘 다 없음 — 최신 `limit` 줄(`before` 가 있으면 그 id 앞에서). 문장에는 `limit + 1` 을 넘긴다.
    Newest { limit: i64, before: Option<i64> },
}

/// 받은함 한 줄 — 응답 JSON 문자열(덧붙임 포함)과 그 줄의 id.
#[derive(Debug, Clone)]
pub struct InboxRow {
    pub id: i64,
    pub body: String,
}

/// TS `listInbox` 의 기본 줄 + 팀 명단 + 덧붙임 셋(넘겨받은 일·접힌 깨움·시작한 곳). 위임 결말·요약은 C6a-3b-2.
pub async fn list_inbox(pool: &PgPool, me: &str, q: InboxQuery) -> sqlx::Result<Vec<InboxRow>> {
    let s = sql();
    let rows: Vec<BaseRow> = match q {
        InboxQuery::Unread { since: None } => {
            sqlx::query_as(s.unread.as_str())
                .bind(me)
                .fetch_all(pool)
                .await?
        }
        InboxQuery::Unread { since: Some(n) } => {
            sqlx::query_as(s.unread_since.as_str())
                .bind(me)
                .bind(n)
                .fetch_all(pool)
                .await?
        }
        InboxQuery::Since(n) => {
            sqlx::query_as(s.since.as_str())
                .bind(me)
                .bind(n)
                .fetch_all(pool)
                .await?
        }
        InboxQuery::Newest {
            limit,
            before: None,
        } => {
            sqlx::query_as(s.newest.as_str())
                .bind(me)
                .bind(limit + 1)
                .fetch_all(pool)
                .await?
        }
        InboxQuery::Newest {
            limit,
            before: Some(b),
        } => {
            sqlx::query_as(s.newest_before.as_str())
                .bind(me)
                .bind(b)
                .bind(limit + 1)
                .fetch_all(pool)
                .await?
        }
    };
    let mut team_ids: Vec<String> = rows.iter().filter_map(|r| r.2.clone()).collect();
    team_ids.sort();
    team_ids.dedup();
    let teams = if team_ids.is_empty() {
        HashMap::new()
    } else {
        let roster: Vec<(String, String, String, String, Option<String>, bool)> =
            sqlx::query_as(s.roster.as_str())
                .bind(&team_ids)
                .fetch_all(pool)
                .await?;
        team_calls(roster)
    };
    let ex = extras(pool, me, &rows).await?;
    Ok(rows
        .into_iter()
        .map(|(body, id, team, message_id, reason)| {
            let body = body.unwrap_or_else(|| "{}".into());
            let mut body = match team.as_deref().and_then(|t| teams.get(t)) {
                Some(call) => append_key(body, "team", call),
                None => body,
            };
            // TS 가 키를 붙이는 차례: team → (delegation·delegations, C6a-3b-2) → delegatedBy → canceledWakes → startedIn.
            if reason == "team_delegated"
                && let Some(v) = ex.handed.get(&message_id)
            {
                body = append_key(body, "delegatedBy", v);
            }
            if reason != "wake"
                && let Some(list) = ex.folded.get(&message_id)
            {
                body = append_key(body, "canceledWakes", &format!("[{}]", list.join(",")));
            }
            if reason != "ask_answered"
                && reason != "ask_closed"
                && let Some(v) = ex.started.get(&message_id)
            {
                body = append_key(body, "startedIn", v);
            }
            InboxRow { id, body }
        })
        .collect())
}

/// 기본 줄 한 행 — (본문 json, id, 팀 id, 메시지 id, 사유).
type BaseRow = (Option<String>, i64, Option<String>, String, String);

#[derive(Default)]
struct Extras {
    /// 넘겨받은 일 — 메시지 id → `{leadHandle, teamName, deadlineAt}`.
    handed: HashMap<String, String>,
    /// 이 부름이 접은 내 깨움 — 부른 메시지 id → `{reason, wakeAt, reportTo?}` 들(깨움 시각 순).
    folded: HashMap<String, Vec<String>>,
    /// 이 일이 시작된 스레드 — 메시지 id → `{channelId, threadRootId}`.
    started: HashMap<String, String>,
}

fn uniq(ids: impl Iterator<Item = String>) -> Vec<String> {
    let mut v: Vec<String> = ids.collect();
    v.sort();
    v.dedup();
    v
}

/// TS `listInbox` 의 덧붙임 셋(넘겨받은 일·접힌 깨움·시작한 곳). 거르는 사유도 TS 와 같다 — 대상이 없으면 묻지 않는다.
async fn extras(pool: &PgPool, me: &str, rows: &[BaseRow]) -> sqlx::Result<Extras> {
    let s = sql();
    let mut ex = Extras::default();
    let handed_ids = uniq(
        rows.iter()
            .filter(|r| r.4 == "team_delegated")
            .map(|r| r.3.clone()),
    );
    if !handed_ids.is_empty() {
        let got: Vec<(String, String, Option<String>, String)> = sqlx::query_as(s.handed.as_str())
            .bind(&handed_ids)
            .fetch_all(pool)
            .await?;
        for (mid, lead, team, deadline) in got {
            ex.handed
                .insert(mid, delegated_by_json(&lead, team.as_deref(), &deadline));
        }
    }
    let call_ids = uniq(rows.iter().filter(|r| r.4 != "wake").map(|r| r.3.clone()));
    if !call_ids.is_empty() {
        let got: Vec<(String, String, String, Option<String>)> = sqlx::query_as(s.folded.as_str())
            .bind(me)
            .bind(&call_ids)
            .fetch_all(pool)
            .await?;
        for (by, reason, wake_at, report_to) in got {
            ex.folded.entry(by).or_default().push(canceled_wake_json(
                &reason,
                &wake_at,
                report_to.as_deref(),
            ));
        }
    }
    let start_ids = uniq(
        rows.iter()
            .filter(|r| r.4 != "ask_answered" && r.4 != "ask_closed")
            .map(|r| r.3.clone()),
    );
    if !start_ids.is_empty() {
        let got: Vec<(String, String, String)> = sqlx::query_as(s.started.as_str())
            .bind(me)
            .bind(&start_ids)
            .fetch_all(pool)
            .await?;
        for (mid, channel, root) in got {
            ex.started.insert(
                mid,
                format!(
                    "{{\"channelId\":{},\"threadRootId\":{}}}",
                    jstr(&channel),
                    jstr(&root)
                ),
            );
        }
    }
    Ok(ex)
}

/// TS `row.delegatedBy = { leadHandle, teamName, deadlineAt }` 과 같은 키 순서.
fn delegated_by_json(lead: &str, team: Option<&str>, deadline: &str) -> String {
    format!(
        "{{\"leadHandle\":{},\"teamName\":{},\"deadlineAt\":{}}}",
        jstr(lead),
        team.map_or_else(|| "null".into(), jstr),
        jstr(deadline)
    )
}

/// TS `{ reason, wakeAt, ...(isReportTo(r.reportTo) ? { reportTo } : {}) }` — `reportTo` 는 `channelId`·`threadRootId` 가
/// 둘 다 글자일 때만, 그때는 저장된 객체를 통째로 싣는다(TS 도 거르지 않고 그대로 싣는다).
fn canceled_wake_json(reason: &str, wake_at: &str, report_to: Option<&str>) -> String {
    let rt = report_to.filter(|t| {
        serde_json::from_str::<Value>(t).is_ok_and(|v| {
            v.is_object() && v["channelId"].is_string() && v["threadRootId"].is_string()
        })
    });
    match rt {
        Some(t) => format!(
            "{{\"reason\":{},\"wakeAt\":{},\"reportTo\":{}}}",
            jstr(reason),
            jstr(wake_at),
            t
        ),
        None => format!(
            "{{\"reason\":{},\"wakeAt\":{}}}",
            jstr(reason),
            jstr(wake_at)
        ),
    }
}

/// TS `listInboxNewest` — 최신 `limit` 줄과, 그 앞에 더 있는가(`truncated`). 오름차순이므로 넘친 한 줄은 맨 앞이다.
pub async fn list_inbox_newest(
    pool: &PgPool,
    me: &str,
    limit: i64,
    before: Option<i64>,
) -> sqlx::Result<(Vec<InboxRow>, bool)> {
    let mut rows = list_inbox(pool, me, InboxQuery::Newest { limit, before }).await?;
    let truncated = rows.len() as i64 > limit;
    if truncated {
        let cut = rows.len() - limit as usize;
        rows.drain(..cut);
    }
    Ok((rows, truncated))
}

/// 명단 행(handle 순) → 팀 id 별 `team` JSON 글자. 키 순서는 TS(`{id, name, members}`·`{accountId, handle, specialty, disabled}`)대로.
fn team_calls(
    rows: Vec<(String, String, String, String, Option<String>, bool)>,
) -> HashMap<String, String> {
    let mut order: Vec<String> = vec![];
    let mut by: HashMap<String, (String, Vec<String>)> = HashMap::new();
    for (id, name, account, handle, specialty, disabled) in rows {
        let entry = by.entry(id.clone()).or_insert_with(|| {
            order.push(id.clone());
            (name, vec![])
        });
        entry.1.push(format!(
            "{{\"accountId\":{},\"handle\":{},\"specialty\":{},\"disabled\":{}}}",
            jstr(&account),
            jstr(&handle),
            specialty.as_deref().map_or_else(|| "null".into(), jstr),
            disabled
        ));
    }
    order
        .into_iter()
        .map(|id| {
            let (name, members) = by.remove(&id).expect("team");
            let text = format!(
                "{{\"id\":{},\"name\":{},\"members\":[{}]}}",
                jstr(&id),
                jstr(&name),
                members.join(",")
            );
            (id, text)
        })
        .collect()
}

fn jstr(s: &str) -> String {
    serde_json::to_string(s).expect("string json")
}

/// JSON 객체 글자 끝에 키 하나를 더한다(TS 가 객체에 키를 붙이는 것처럼 맨 끝에). 덧붙임(C6a-3b)도 이것을 쓴다.
pub(crate) fn append_key(mut obj: String, key: &str, value_json: &str) -> String {
    debug_assert!(obj.ends_with('}'));
    obj.pop();
    if !obj.ends_with('{') {
        obj.push(',');
    }
    obj.push_str(&jstr(key));
    obj.push(':');
    obj.push_str(value_json);
    obj.push('}');
    obj
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_sql_loads() {
        let s = sql();
        for q in [
            &s.unread,
            &s.unread_since,
            &s.since,
            &s.newest,
            &s.newest_before,
        ] {
            assert!(q.contains("i.account_id = $1::uuid"), "{q}");
            assert!(q.contains("cm_vis.account_id = $1::uuid"), "{q}");
            assert!(q.ends_with("order by t.id"), "{q}");
        }
        assert!(s.unread.contains("i.read_at is null") && !s.unread.contains("$2"));
        assert!(s.unread_since.contains("i.id > $2::bigint"));
        assert!(s.since.contains("i.id > $2::bigint") && !s.since.contains("read_at is null"));
        assert!(s.newest.contains("order by i.id desc limit $2::int"));
        assert!(
            s.newest_before.contains("i.id < $2::bigint")
                && s.newest_before.contains("limit $3::int")
        );
        // 간추림·임대 거르기는 GET /inbox 갈래에 없다(보드·MCP 몫).
        for q in [&s.unread, &s.since, &s.newest] {
            assert!(!q.contains("as \"bodyTruncated\"") && !q.contains("claimed_until"));
        }
        assert!(s.roster.contains("t.id = any($1::uuid[])"));
        assert!(s.handed.contains("d.message_id = any($1::uuid[])"));
        assert!(
            s.folded.contains("w.account_id = $1::uuid")
                && s.folded.contains("any($2::uuid[])")
                && s.folded.ends_with("order by f.\"wakeAt\"")
        );
        assert!(
            s.started.contains("m.id = any($2::uuid[])")
                && s.started.contains("cm_vis.account_id = $1::uuid")
                && s.started.contains("ha.kind = 'human'")
        );
    }

    #[test]
    fn team_json_keeps_ts_key_order() {
        let calls = team_calls(vec![
            (
                "t1".into(),
                "Ops \"A\"".into(),
                "a1".into(),
                "alpha".into(),
                Some("db".into()),
                false,
            ),
            (
                "t1".into(),
                "Ops \"A\"".into(),
                "a2".into(),
                "beta".into(),
                None,
                true,
            ),
        ]);
        assert_eq!(
            calls["t1"],
            r#"{"id":"t1","name":"Ops \"A\"","members":[{"accountId":"a1","handle":"alpha","specialty":"db","disabled":false},{"accountId":"a2","handle":"beta","specialty":null,"disabled":true}]}"#
        );
    }

    #[test]
    fn extras_json_keeps_ts_shape() {
        assert_eq!(
            delegated_by_json("lead", None, "2026-01-01T00:00:00.000Z"),
            r#"{"leadHandle":"lead","teamName":null,"deadlineAt":"2026-01-01T00:00:00.000Z"}"#
        );
        assert_eq!(
            canceled_wake_json("CI \"확인\"", "2026-01-01T00:00:00.000Z", None),
            r#"{"reason":"CI \"확인\"","wakeAt":"2026-01-01T00:00:00.000Z"}"#
        );
        // reportTo 가 모자라면 키째 뺀다(TS isReportTo).
        assert_eq!(
            canceled_wake_json("r", "t", Some(r#"{"channelId": "c"}"#)),
            r#"{"reason":"r","wakeAt":"t"}"#
        );
        assert_eq!(
            canceled_wake_json("r", "t", Some("null")),
            r#"{"reason":"r","wakeAt":"t"}"#
        );
        assert_eq!(
            canceled_wake_json("r", "t", Some(r#"{"channelId": "c", "threadRootId": "x"}"#)),
            r#"{"reason":"r","wakeAt":"t","reportTo":{"channelId": "c", "threadRootId": "x"}}"#
        );
    }

    #[test]
    fn append_key_at_end() {
        assert_eq!(
            append_key(r#"{"a":1}"#.into(), "team", "{}"),
            r#"{"a":1,"team":{}}"#
        );
        assert_eq!(append_key("{}".into(), "k", "true"), r#"{"k":true}"#);
    }
}
