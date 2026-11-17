//! S5.4 MS2c — 받은함 스레드 머리·처리 상태(TS `listInboxThreads`·`listInboxThreadStates`, `services/messages.ts`).
//!
//! - 문장은 TS 정본 `THREAD_HEADS_SQL`·`INBOX_THREAD_STATES_SQL` 그대로 — `golden/sql_fragments.json` 에서 읽는다.
//! - 바인드 형: 머리 `$1`=머리 id 들(`&[String]` → text[], 문장이 `any($1::uuid[])`), `$2`=내 id(`&str` → text, 문장이 `$2::uuid`).
//!   처리 상태 `$1`=내 id(`$1::uuid`), `$2`=머리 id 들(`any($2::uuid[])`). 맨 `$n` 이 uuid 칸과 견주는 곳은 없다(#2316 교훈).
//! - 머리 행 JSON 은 채널 목록과 같은 감싸기([`super::msg_list::wrap`], 칸 순서 = 열 순서, 겉 시각 셋은 toISOString 꼴)다.
//!   TS `listThreadHeads` 는 `planProgress` 를 붙이지 않으므로 여기서도 붙이지 않는다. 글자는 [`minify`] 로 `JSON.stringify` 꼴에 맞춘다.
//! - 처리 상태는 TS 가 `{rootId, state, until(ISO|null), updatedAt(ISO)}` 로 다시 쓴다 — 같은 키 순서로 만든다.
use crate::core::mcp::respond::minify;
use crate::core::msg_list::wrap;
use serde_json::Value;
use sqlx::PgPool;
use std::sync::OnceLock;

struct Sql {
    heads: String,
    states: String,
}

fn states_wrap(frag: &str) -> String {
    format!(
        "select json_build_object('rootId', x.\"rootId\", 'state', x.state, \
           'until', {}, 'updatedAt', {})::text \
         from ({frag}) x order by x.\"rootId\"",
        crate::iso!("x.until"),
        crate::iso!("x.\"updatedAt\""),
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
            heads: wrap(&frag("inbox_thread_heads")),
            states: states_wrap(&frag("inbox_thread_states")),
        }
    })
}

/// 처음 나온 차례로 겹침을 지운다(TS `[...new Set(ids)]`). 순서는 문장의 `order by` 가 정하므로 뜻은 없다.
fn uniq(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// TS `listInboxThreads` — 머리 행 JSON 글자들(seq 오름차순)과 그 id 들.
pub async fn thread_heads(
    pool: &PgPool,
    me: &str,
    roots: impl IntoIterator<Item = String>,
) -> sqlx::Result<Vec<(String, String)>> {
    let ids = uniq(roots);
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let rows: Vec<(String, String, i64, Option<String>, bool)> =
        sqlx::query_as(sql().heads.as_str())
            .bind(&ids)
            .bind(me)
            .fetch_all(pool)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(body, id, ..)| (minify(&body), id))
        .collect())
}

/// TS `listInboxThreadStates` — 실린 머리의 내 처리 상태 JSON 글자들(머리 id 순).
pub async fn thread_states(pool: &PgPool, me: &str, roots: &[String]) -> sqlx::Result<Vec<String>> {
    if roots.is_empty() {
        return Ok(vec![]);
    }
    let rows: Vec<String> = sqlx::query_scalar(sql().states.as_str())
        .bind(me)
        .bind(roots)
        .fetch_all(pool)
        .await?;
    Ok(rows.iter().map(|r| minify(r)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn golden_sql_loads() {
        let s = sql();
        assert!(s.heads.contains("any($1::uuid[])"));
        assert!(s.heads.contains("$2::uuid"));
        assert!(s.states.contains("s.account_id = $1::uuid"));
        assert!(s.states.contains("any($2::uuid[])"));
    }

    #[test]
    fn uniq_keeps_first() {
        let v = uniq(["b", "a", "b", "c", "a"].map(String::from));
        assert_eq!(v, ["b", "a", "c"]);
    }
}
