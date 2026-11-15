//! C4a-6b — `message.search`. [`super::tools`] 와 같은 약속이다 — TS 와 **같은 글자**(대조: `rustFrontDb.test.ts` 의 MCP 줄),
//! zod 가 그대로 받는 인자만, DB 오류·모르는 꼴은 TS 로.
//!
//! - 문장은 TS 정본 `SEARCH_MESSAGES_SQL`(`services/messages.ts`, 정렬 두 갈래)을 `golden/sql_fragments.json` 에서 읽는다.
//!   가시성 술어·스코프·거르기는 그 문장 안에 있다.
//! - 답하지 않고 TS 로 넘기는 것(보수적으로):
//!   - 질의에 `@` 가 있으면 — TS `normalizeSearchQuery` 가 `@handle` 을 `<@id>` 로 바꾼다(shared `mentionedHandles`·
//!     `normalizeMentions` 의 JS 규칙). `@` 가 없으면 그 함수는 질의를 그대로 돌려준다.
//!   - `after`·`before` 가 있으면 — zod `datetime({ offset: true })` 판정을 옮기지 않는다.
//! - 결과: TS `searchMessages` 처럼 `limit + 1`(51)을 떠서 50 을 싣고, `hasMore` 는 `searchHasMore`(천장 1000).
//!   그 뒤 `message.read` 와 같은 `denormalizeBodies` → `markSystemLines`([`super::tools::denormalize_marked`]).
use super::respond::{minify, text_result};
use super::tools::{denormalize_marked, err, opt_int, opt_uuid};
use crate::auth::Account;
use serde_json::Value;
use sqlx::PgPool;

/// TS `SEARCH_MAX_OFFSET`.
const SEARCH_MAX_OFFSET: i64 = 1000;
/// TS `SEARCH_MAX_AUTHORS`.
const SEARCH_MAX_AUTHORS: usize = 10;
/// TS MCP 는 `limit` 을 주지 않는다 — `searchMessages` 의 기본 50.
const LIMIT: i64 = 50;

/// 골든 문장을 감싸 행마다 JSON 글자 하나를 낸다. 맨 겉 `createdAt`·`editedAt` 만 JS `toISOString()` 꼴로(첨부 요약 안에는
/// 시각 칸이 없다). 행 순서는 TS 문장의 `order by` 그대로 — 정렬된 부분 질의를 `json_agg` 로 모으고 `with ordinality` 로 펼친다.
fn rows_sql(golden: &str) -> String {
    format!(
        "select (select json_object_agg(e.key, case \
             when e.key in ('createdAt', 'editedAt') and json_typeof(e.value) = 'string' \
               then to_json(to_char((e.value #>> '{{}}')::timestamptz at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')) \
             else e.value end order by e.ord) \
           from json_each(r.v) with ordinality as e(key, value, ord))::text \
         from (select coalesce(json_agg(t), '[]'::json) as j from ({golden}) t) a, \
              json_array_elements(a.j) with ordinality as r(v, n) \
         order by r.n"
    )
}

fn sql(recent: bool) -> &'static str {
    static S: std::sync::OnceLock<(String, String)> = std::sync::OnceLock::new();
    let s = S.get_or_init(|| {
        let f = crate::core::channels::frag;
        (
            rows_sql(f("search_messages_relevance")),
            rows_sql(f("search_messages_recent")),
        )
    });
    if recent { &s.1 } else { &s.0 }
}

/// TS `searchHasMore`.
fn has_more(fetched: usize, limit: i64, offset: i64) -> bool {
    fetched as i64 > limit && offset + limit <= SEARCH_MAX_OFFSET
}

/// 인자 — zod 스키마(`searchInput` 조각)가 그대로 받는 것만. 틀린 꼴이나 TS 에 맡길 것은 `None`.
#[derive(Debug, PartialEq)]
struct Args {
    query: String,
    channel: Option<String>,
    thread: Option<String>,
    offset: i64,
    authors: Option<Vec<String>>,
    has_attachment: Option<bool>,
    recent: bool,
}

fn parse(args: &Value) -> Option<Args> {
    let o = args.as_object()?;
    // `z.string().min(1).max(256)` — JS 길이(UTF-16 단위).
    let query = o.get("query")?.as_str()?;
    let n = query.encode_utf16().count();
    if !(1..=256).contains(&n) || query.contains('@') {
        return None;
    }
    if o.contains_key("after") || o.contains_key("before") {
        return None;
    }
    let authors = match o.get("authorIds") {
        None => None,
        Some(v) => {
            let a = v.as_array()?;
            if a.len() > SEARCH_MAX_AUTHORS {
                return None;
            }
            let ids = a
                .iter()
                .map(|x| {
                    x.as_str()
                        .filter(|s| crate::core::channels::is_uuid(s))
                        .map(str::to_owned)
                })
                .collect::<Option<Vec<_>>>()?;
            // TS: `authorIds?.length ? … : null` — 빈 배열은 거르지 않는다.
            (!ids.is_empty()).then_some(ids)
        }
    };
    let has_attachment = match o.get("hasAttachment") {
        None => None,
        Some(v) => Some(v.as_bool()?),
    };
    let recent = match o.get("sort") {
        None => false,
        Some(Value::String(s)) if s == "relevance" => false,
        Some(Value::String(s)) if s == "recent" => true,
        Some(_) => return None,
    };
    Some(Args {
        query: query.to_owned(),
        channel: opt_uuid(args, "channelId")?,
        thread: opt_uuid(args, "threadRootId")?,
        offset: opt_int(args, "offset", 0, SEARCH_MAX_OFFSET)?.unwrap_or(0),
        authors,
        has_attachment,
        recent,
    })
}

pub async fn answer(pool: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let a = parse(args)?;
    // 볼 수 없는 채널을 범위로 주면 REST 의 403 과 같은 거절(TS 와 같은 문장).
    if let Some(ch) = a.channel.as_deref()
        && !crate::core::channels::visible(pool, &me.id, ch)
            .await
            .ok()?
    {
        return Some(err("forbidden", "not a member of this channel"));
    }
    let rows: Vec<String> = sqlx::query_scalar::<_, String>(sql(a.recent))
        .bind(&a.query)
        .bind(LIMIT + 1)
        .bind(&me.id)
        .bind(a.channel.as_deref())
        .bind(a.thread.as_deref())
        .bind(a.offset)
        .bind(a.authors.as_deref())
        .bind(None::<String>)
        .bind(None::<String>)
        .bind(a.has_attachment)
        .fetch_all(pool)
        .await
        .ok()?;
    let more = has_more(rows.len(), LIMIT, a.offset);
    let page: Vec<String> = rows
        .iter()
        .take(LIMIT as usize)
        .map(|r| minify(r))
        .collect();
    let arr = denormalize_marked(pool, &page).await?;
    Some(text_result(&format!(
        "{{\"messages\":{arr},\"hasMore\":{more}}}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const U: &str = "00000000-0000-4000-8000-000000000001";

    #[test]
    fn args_follow_zod_or_go_to_ts() {
        let ok = parse(&json!({ "query": "검색", "extra": 1 })).unwrap();
        assert_eq!((ok.offset, ok.recent, ok.authors), (0, false, None));
        let full = parse(&json!({
            "query": "x", "channelId": U, "threadRootId": U, "offset": 1000,
            "authorIds": [U], "hasAttachment": false, "sort": "recent",
        }))
        .unwrap();
        assert_eq!(full.authors, Some(vec![U.to_owned()]));
        assert!(full.recent && full.has_attachment == Some(false));
        assert_eq!(
            parse(&json!({ "query": "x", "authorIds": [] }))
                .unwrap()
                .authors,
            None
        );
        // 256 UTF-16 단위까지 — 이모지 하나는 2 단위.
        assert!(parse(&json!({ "query": "가".repeat(256) })).is_some());
        assert!(parse(&json!({ "query": "😀".repeat(129) })).is_none());
        for bad in [
            json!({}),
            json!({ "query": "" }),
            json!({ "query": 1 }),
            json!({ "query": "@bot 찾기" }),
            json!({ "query": "x", "after": "2026-11-15T00:00:00Z" }),
            json!({ "query": "x", "before": "2026-11-15T00:00:00Z" }),
            json!({ "query": "x", "offset": 1001 }),
            json!({ "query": "x", "offset": -1 }),
            json!({ "query": "x", "offset": 1.5 }),
            json!({ "query": "x", "offset": null }),
            json!({ "query": "x", "channelId": "nope" }),
            json!({ "query": "x", "authorIds": ["nope"] }),
            json!({ "query": "x", "authorIds": vec![U; 11] }),
            json!({ "query": "x", "hasAttachment": "true" }),
            json!({ "query": "x", "sort": "old" }),
            json!("x"),
        ] {
            assert!(parse(&bad).is_none(), "{bad}");
        }
    }

    #[test]
    fn has_more_stops_at_ceiling() {
        assert!(has_more(51, 50, 0));
        assert!(!has_more(50, 50, 0));
        assert!(has_more(51, 50, 950));
        assert!(!has_more(51, 50, 951));
    }

    #[test]
    fn golden_statements_load() {
        assert!(sql(false).contains("ts_rank"));
        assert!(sql(true).contains("m.created_at desc, m.seq desc"));
    }

    /// TS 원본과 상수가 같은지.
    #[test]
    fn constants_follow_ts() {
        let ts = include_str!("../../../../../packages/server/src/services/messages.ts");
        assert!(ts.contains(&format!(
            "export const SEARCH_MAX_OFFSET = {SEARCH_MAX_OFFSET};"
        )));
        assert!(ts.contains(&format!(
            "export const SEARCH_MAX_AUTHORS = {SEARCH_MAX_AUTHORS};"
        )));
        assert!(ts.contains("const limit = Math.min(scope.limit ?? 50, 100);"));
    }
}
