//! C4b B1c — `memory.search`(TS `mcpPlugin.ts` 의 같은 이름 도구 + `services/memory.ts` `searchMemory`). 낱말 뽑기·순위는
//! [`crate::core::mem_search`](TS 골든 대조)에 있고, 여기는 인자 판정·문장·답 글자다. 약속은 [`super::mem_writes`] 와 같다 —
//! zod 모양 밖이면 `None`(TS), 쓰기 전 DB 오류도 `None`, recall 셈(`recordTop`, 쓰기)을 시작한 뒤의 오류는 고정 문장 `internal`.
use super::mem_writes::internal;
use super::respond::text_result;
use crate::auth::Account;
use crate::core::mem_search::{
    Candidate, excluded_names_from, is_thread_state_slug, like_pattern, rank_recall, recall_terms,
    search_terms,
};
use serde_json::Value;
use sqlx::{PgPool, Row};
use std::collections::HashSet;

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 선택 정수(`z.number().int().min(lo).max(hi).optional()`). 없음 `Some(None)`, 모양 밖 `None`.
#[allow(clippy::option_option)]
fn opt_int(args: &Value, key: &str, lo: i64, hi: i64) -> Option<Option<i64>> {
    match args.get(key) {
        None => Some(None),
        Some(v) => {
            let n = v.as_f64()?;
            if n.fract() != 0.0 || n < lo as f64 || n > hi as f64 {
                return None;
            }
            #[allow(clippy::cast_possible_truncation)]
            Some(Some(n as i64))
        }
    }
}

#[allow(clippy::option_option)]
fn opt_bool(args: &Value, key: &str) -> Option<Option<bool>> {
    match args.get(key) {
        None => Some(None),
        Some(v) => Some(Some(v.as_bool()?)),
    }
}

/// 선택 문자열(UTF-16 길이 lo..=hi).
#[allow(clippy::option_option)]
fn opt_str<'a>(args: &'a Value, key: &str, lo: usize, hi: usize) -> Option<Option<&'a str>> {
    match args.get(key) {
        None => Some(None),
        Some(v) => {
            let s = v.as_str()?;
            (lo..=hi).contains(&utf16_len(s)).then_some(Some(s))
        }
    }
}

struct Args<'a> {
    query: &'a str,
    limit: i64,
    include_value: bool,
    recall: bool,
    exclude: Vec<&'a str>,
    record_top: i64,
    focus: Option<&'a str>,
    include_archived: bool,
}

fn parse(args: &Value) -> Option<Args<'_>> {
    let query = opt_str(args, "query", 1, 2000)??;
    let limit = opt_int(args, "limit", 1, 20)?.unwrap_or(5);
    let include_value = opt_bool(args, "includeValue")?.unwrap_or(false);
    let recall = opt_bool(args, "recall")?.unwrap_or(false);
    let exclude = match args.get("exclude") {
        None => vec![],
        Some(v) => {
            let a = v.as_array()?;
            if a.len() > 200 {
                return None;
            }
            let mut out = Vec::with_capacity(a.len());
            for x in a {
                let s = x.as_str()?;
                if utf16_len(s) > 300 {
                    return None;
                }
                out.push(s);
            }
            out
        }
    };
    let record_top = opt_int(args, "recordTop", 0, 5)?.unwrap_or(0);
    let focus = opt_str(args, "focus", 0, 2000)?;
    let include_archived = opt_bool(args, "includeArchived")?.unwrap_or(false);
    Some(Args {
        query,
        limit,
        include_value,
        recall,
        exclude,
        record_top,
        focus,
        include_archived,
    })
}

fn str_arr(v: &[String]) -> String {
    Value::from(v.to_vec()).to_string()
}

fn opt_json(s: Option<&str>) -> String {
    s.map_or(Value::Null, Value::from).to_string()
}

pub async fn search(read: &PgPool, write: &PgPool, me: &Account, args: &Value) -> Option<String> {
    let a = parse(args)?;
    if a.recall {
        return recall(read, write, me, &a).await;
    }
    let terms = search_terms(a.query, None);
    if terms.is_empty() {
        return Some(text_result("{\"hits\":[]}"));
    }
    let patterns: Vec<String> = terms.iter().map(|t| like_pattern(t)).collect();
    let sql = format!(
        "select slug, description, kind, {} \
           (select coalesce(sum( \
              case when lower(m.slug) like p or lower(coalesce(m.description, '')) like p then 3 else 0 end \
              + case when lower(m.value) like p then 1 else 0 end), 0) \
            from unnest($2::text[]) as p)::int as score \
         from agent_memory m \
         where account_id = $1::uuid and slug <> 'core' and flagged_at is null and ($4 or archived_at is null) \
         order by score desc, updated_at desc \
         limit $3",
        if a.include_value { "value," } else { "" }
    );
    // 끼우는 것은 고정 낱말 `value,` 하나뿐이다(인자 값은 bind).
    let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
        .bind(&me.id)
        .bind(&patterns)
        .bind(a.limit)
        .bind(a.include_archived)
        .fetch_all(read)
        .await
        .ok()?;
    let mut hits = Vec::new();
    for r in rows {
        let score: i32 = r.try_get("score").ok()?;
        if score <= 0 {
            continue;
        }
        let slug: String = r.try_get("slug").ok()?;
        let desc: Option<String> = r.try_get("description").ok()?;
        let kind: String = r.try_get("kind").ok()?;
        let value = if a.include_value {
            let v: String = r.try_get("value").ok()?;
            format!("\"value\":{},", Value::from(v))
        } else {
            String::new()
        };
        hits.push(format!(
            "{{\"slug\":{},\"description\":{},\"kind\":{},{value}\"score\":{score}}}",
            Value::from(slug),
            opt_json(desc.as_deref()),
            Value::from(kind)
        ));
    }
    Some(text_result(&format!("{{\"hits\":[{}]}}", hits.join(","))))
}

async fn recall(read: &PgPool, write: &PgPool, me: &Account, a: &Args<'_>) -> Option<String> {
    let names = sqlx::query(
        "select handle, display_name, kind from account where deleted_at is null and kind = 'human'",
    )
    .fetch_all(read)
    .await
    .ok()?;
    let mut name_rows: Vec<(String, Option<String>, String)> = Vec::with_capacity(names.len());
    for r in names {
        name_rows.push((
            r.try_get("handle").ok()?,
            r.try_get("display_name").ok()?,
            r.try_get("kind").ok()?,
        ));
    }
    let excluded = excluded_names_from(
        name_rows
            .iter()
            .map(|(h, d, k)| (h.as_str(), d.as_deref(), k.as_str())),
    );
    let (terms, focus_terms) = recall_terms(a.query, a.focus, &excluded);
    let tail = match &focus_terms {
        Some(f) => format!(
            ",\"terms\":{},\"focusTerms\":{}}}",
            str_arr(&terms),
            str_arr(f)
        ),
        None => format!(",\"terms\":{}}}", str_arr(&terms)),
    };
    if terms.is_empty() || focus_terms.as_ref().is_some_and(Vec::is_empty) {
        return Some(text_result(&format!("{{\"hits\":[]{tail}")));
    }
    let patterns: Vec<String> = terms.iter().map(|t| like_pattern(t)).collect();
    let rows = sqlx::query(
        "select slug, description, kind, value, \
           to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as updated_at \
         from agent_memory m \
         where account_id = $1::uuid and slug <> 'core' and kind <> 'journal' and flagged_at is null and archived_at is null \
           and exists (select 1 from unnest($2::text[]) as p \
                       where lower(m.slug) like p or lower(coalesce(m.description, '')) like p)",
    )
    .bind(&me.id)
    .bind(&patterns)
    .fetch_all(read)
    .await
    .ok()?;
    let skip: HashSet<&str> = a.exclude.iter().copied().collect();
    let mut cands = Vec::with_capacity(rows.len());
    for r in rows {
        let c = Candidate {
            slug: r.try_get("slug").ok()?,
            description: r.try_get("description").ok()?,
            kind: r.try_get("kind").ok()?,
            value: r.try_get("value").ok()?,
            updated_at: r.try_get("updated_at").ok()?,
        };
        let key = format!("{}@{}", c.slug, c.updated_at);
        if skip.contains(c.slug.as_str())
            || skip.contains(key.as_str())
            || is_thread_state_slug(&c.slug)
        {
            continue;
        }
        cands.push(c);
    }
    let focus_set: Option<HashSet<String>> = focus_terms.clone().map(|v| v.into_iter().collect());
    #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
    let hits = rank_recall(&terms, &cands, a.limit as usize, focus_set.as_ref());
    if a.record_top > 0 {
        #[allow(clippy::cast_sign_loss, clippy::cast_possible_truncation)]
        let mut slugs: Vec<String> = Vec::new();
        for h in hits.iter().take(a.record_top as usize) {
            if h.slug != "core" && !slugs.contains(&h.slug) {
                slugs.push(h.slug.clone());
            }
        }
        if !slugs.is_empty()
            && sqlx::query(
                "update agent_memory set recall_count = recall_count + 1, last_recalled_at = now() \
                 where account_id = $1::uuid and slug = any($2::text[])",
            )
            .bind(&me.id)
            .bind(&slugs)
            .execute(write)
            .await
            .is_err()
        {
            return Some(internal());
        }
    }
    let out: Vec<String> = hits
        .iter()
        .map(|h| {
            let value = if a.include_value {
                format!(",\"value\":{}", Value::from(h.value.as_str()))
            } else {
                String::new()
            };
            format!(
                "{{\"slug\":{},\"description\":{},\"kind\":{},\"score\":{},\"nameHits\":{},\"termHits\":{}{value},\"updatedAt\":{}}}",
                Value::from(h.slug.as_str()),
                opt_json(h.description.as_deref()),
                Value::from(h.kind.as_str()),
                h.score,
                h.name_hits,
                str_arr(&h.term_hits),
                Value::from(h.updated_at.as_str())
            )
        })
        .collect();
    Some(text_result(&format!(
        "{{\"hits\":[{}]{tail}",
        out.join(",")
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn args_follow_zod_shape() {
        assert!(parse(&json!({})).is_none());
        assert!(parse(&json!({ "query": "" })).is_none());
        assert!(parse(&json!({ "query": "x", "limit": 21 })).is_none());
        assert!(parse(&json!({ "query": "x", "limit": 1.5 })).is_none());
        assert!(parse(&json!({ "query": "x", "recordTop": 6 })).is_none());
        assert!(parse(&json!({ "query": "x", "recall": "yes" })).is_none());
        assert!(parse(&json!({ "query": "x", "exclude": [1] })).is_none());
        let v = json!({ "query": "x", "focus": "", "unknown": 1 });
        let a = parse(&v).unwrap();
        assert_eq!((a.limit, a.focus, a.recall), (5, Some(""), false));
    }
}
