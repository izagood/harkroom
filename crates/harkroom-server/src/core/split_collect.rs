//! F1b 하위 결과 모으기 — 자기 쪼개기 조각(F1a: 넘긴 쪽 = 담당인 위임)이 여럿 열려 있을 때, 조각이 하나 닫힐 때마다
//! 넘긴 쪽을 깨우지 않고 **열린 조각이 0 이 되는 순간 한 번** 깨운다. 스위치 `HARKROOM_SPLIT_COLLECT`(기본 꺼짐).
//!
//! - 판정은 [`decide`] 하나다. 닫는 길(결과 글·기한·중단)은 모두 [`turn_settle::notify_if_settled`](super::turn_settle) 를 지나고
//!   그 함수가 [`gate`] 를 부른다. 깨우지 않고 닫는 길(자동 닫힘 · 넘긴 쪽이 스스로 닫기)은 [`after_quiet_close`] 가 같은 판정을 지난다.
//!   새 위임이 앞 의무를 대체하는 길(`superseded`)은 자기 조각을 건드리지 않는다(F1a) — 지날 것이 없다.
//! - 판정은 savepoint 안에서 돈다. 실패하면 그 부분만 되돌리고 옛 동작(바로 깨움)이 된다.
//! - 보류한 조각은 그 위임 글 `meta.splitCollect.state = "held"` 로 적는다. 마지막 조각이 닫히면 보류한 조각과 함께
//!   표([`collect_body`])를 만들어 마지막 조각의 위임 글 `meta.splitCollect` 에 싣고(`state = "collected"`) 그 글로 깨운다.
//! - 동시성: 같은 (넘긴 쪽, 스레드) 는 `pg_advisory_xact_lock` 으로 줄을 세운 뒤 열린 형제를 센다. 마지막 두 조각이 동시에
//!   닫혀도 뒤에 잠금을 얻은 쪽이 앞 쪽의 커밋을 보고 한 번만 깨운다.
//! - 남에게 넘긴 보통 위임은 [`Verdict::Pass`] — 지금 동작 그대로다. 스위치가 꺼져 있으면 아무 문장도 돌지 않는다.
use serde_json::{Value, json};

/// `HARKROOM_SPLIT_COLLECT` — `on`·`1`·`true` 만 켬. 없거나 다른 값이면 꺼짐.
fn collect_on(raw: Option<&str>) -> bool {
    matches!(
        raw.map(|v| v.trim().to_ascii_lowercase()).as_deref(),
        Some("on" | "1" | "true")
    )
}

/// 스위치가 켜졌나.
pub(crate) fn enabled() -> bool {
    collect_on(crate::env_once::get(&crate::env_once::SPLIT_COLLECT))
}

/// 닫힌 위임 하나에 대한 판정.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Verdict {
    /// 지금 동작 그대로(스위치 꺼짐 · 보통 위임 · 모을 형제가 없는 조각).
    Pass,
    /// 열린 형제 조각이 남았다 — 깨우지 않고 보류로 적는다.
    Hold,
    /// 열린 형제가 0 이고 보류한 형제가 있다 — 표를 실어 한 번 깨운다.
    Collect,
}

/// 판정 순수 함수. `self_piece` 는 「넘긴 쪽 = 유일한 담당」, `open_siblings` 는 같은 넘긴 쪽·같은 스레드의 아직 열린 다른 조각 수,
/// `held_siblings` 는 보류로 적힌 다른 조각 수.
pub(crate) fn decide(
    on: bool,
    self_piece: bool,
    open_siblings: usize,
    held_siblings: usize,
) -> Verdict {
    if !on || !self_piece {
        return Verdict::Pass;
    }
    if open_siblings > 0 {
        return Verdict::Hold;
    }
    if held_siblings > 0 {
        Verdict::Collect
    } else {
        Verdict::Pass
    }
}

/// 표의 한 줄 — 조각 하나의 결말.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Piece {
    /// 조각을 연 위임 글.
    pub message_id: String,
    /// `team_delegation_item.outcome`.
    pub outcome: Option<String>,
    /// `team_delegation_item.closed_reason`.
    pub reason: Option<String>,
    /// 결과 글(`closed_by_message_id`). 기한·중단으로 닫혔으면 없다.
    pub result_message_id: Option<String>,
}

/// 결말 낱말 → 표에 적을 말.
fn outcome_label(outcome: Option<&str>, reason: Option<&str>) -> String {
    match (outcome, reason) {
        (Some("reported" | "done"), _) => "report".into(),
        (Some("failed"), _) => "fail".into(),
        (Some("timeout"), _) | (Some("closed"), Some("max_age" | "idle")) => "기한".into(),
        (Some("canceled"), _) => "중단".into(),
        (Some("closed"), Some(r)) => format!("닫힘({r})"),
        (Some(o), _) => o.to_owned(),
        (None, _) => "열림".into(),
    }
}

fn link(id: &str) -> String {
    format!("harkroom://message/{id}")
}

/// 모아 깨우는 글 본문 — 조각별 결말과 결과 글 링크의 표.
pub(crate) fn collect_body(pieces: &[Piece]) -> String {
    let mut s = format!(
        "자기 쪼개기 조각 {}개가 모두 닫혔다.\n\n| # | 조각 | 결말 | 결과 글 |\n|---|---|---|---|\n",
        pieces.len()
    );
    for (n, p) in pieces.iter().enumerate() {
        let result = p
            .result_message_id
            .as_deref()
            .map(link)
            .unwrap_or_else(|| "—".into());
        s.push_str(&format!(
            "| {} | {} | {} | {} |\n",
            n + 1,
            link(&p.message_id),
            outcome_label(p.outcome.as_deref(), p.reason.as_deref()),
            result
        ));
    }
    s
}

/// 모은 조각들의 `meta.splitCollect` 값.
fn collected_meta(pieces: &[Piece]) -> Value {
    json!({
        "state": "collected",
        "body": collect_body(pieces),
        "pieces": pieces.iter().map(|p| json!({
            "messageId": p.message_id,
            "outcome": p.outcome,
            "reason": p.reason,
            "resultMessageId": p.result_message_id,
        })).collect::<Vec<_>>(),
    })
}

/// 이 위임이 자기 조각인가 — 담당이 넘긴 쪽 하나뿐. 돌려주는 것은 (넘긴 쪽, 스레드 머리, 위임 글).
const SELF_PIECE_SQL: &str = "select d.lead_account_id::text, d.thread_root_id::text, d.message_id::text \
       from team_delegation d \
      where d.id = $1::uuid \
        and exists (select 1 from team_delegation_item i where i.delegation_id = d.id and i.delegate_account_id = d.lead_account_id) \
        and not exists (select 1 from team_delegation_item i where i.delegation_id = d.id and i.delegate_account_id <> d.lead_account_id)";

/// 같은 (넘긴 쪽, 스레드) 를 줄 세운다 — tx 가 끝나면 풀린다.
const LOCK_SQL: &str = "select pg_advisory_xact_lock(hashtextextended('split_collect:' || $1::text || ':' || $2::text, 0))";

/// 같은 넘긴 쪽·같은 스레드의 자기 조각 가운데 열린 것 · 보류로 적힌 것 · 지금 닫힌 것. 만든 차례.
const SIBLINGS_SQL: &str = "select d.id::text, d.message_id::text, i.outcome, i.closed_reason, i.closed_by_message_id::text, \
            coalesce(m.meta->'splitCollect'->>'state', '') \
       from team_delegation d \
       join team_delegation_item i on i.delegation_id = d.id \
       join message m on m.id = d.message_id \
      where d.lead_account_id = $1::uuid and d.thread_root_id = $2::uuid and i.delegate_account_id = $1::uuid \
        and not exists (select 1 from team_delegation_item o where o.delegation_id = d.id and o.delegate_account_id <> $1::uuid) \
        and (i.outcome is null or m.meta->'splitCollect'->>'state' = 'held' or d.id = $3::uuid) \
      order by d.created_at, d.id";

const STAMP_SQL: &str = "update message set meta = coalesce(meta::jsonb, '{}'::jsonb) || jsonb_build_object('splitCollect', $2::jsonb) \
      where id = any($1::uuid[])";

/// [`gate`] 가 읽은 것 — 깨울 넘긴 쪽과 깨움 글(이 위임의 위임 글).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Gate {
    pub verdict: Verdict,
    pub lead: String,
    pub message: String,
}

/// 닫힌 위임 하나를 판정하고 보류·모음 표지를 적는다. 자기 조각이 아니거나 스위치가 꺼졌으면 `None`(지금 동작 그대로).
/// 부르는 쪽은 그 위임의 항목을 **이미 닫은 같은 tx** 에서 부른다.
///
/// 판정은 savepoint 안에서 돈다 — 읽기·표지 쓰기가 실패하면(권한 등) 그 부분만 되돌리고 `None` 을 돌려준다.
/// 판정 실패는 본 tx 를 깨지 않고 옛 동작(바로 깨움)이 된다.
pub(crate) async fn gate(
    conn: &mut sqlx::PgConnection,
    delegation: &str,
) -> Result<Option<Gate>, sqlx::Error> {
    if !enabled() {
        return Ok(None);
    }
    sqlx::query("savepoint split_collect")
        .execute(&mut *conn)
        .await?;
    match gate_in(conn, delegation).await {
        Ok(g) => {
            sqlx::query("release savepoint split_collect")
                .execute(&mut *conn)
                .await?;
            Ok(g)
        }
        Err(e) => {
            eprintln!("split_collect: gate failed, waking as before: {e}");
            sqlx::query("rollback to savepoint split_collect")
                .execute(&mut *conn)
                .await?;
            sqlx::query("release savepoint split_collect")
                .execute(&mut *conn)
                .await?;
            Ok(None)
        }
    }
}

/// [`gate`] 의 몸통(savepoint 안).
async fn gate_in(
    conn: &mut sqlx::PgConnection,
    delegation: &str,
) -> Result<Option<Gate>, sqlx::Error> {
    let piece: Option<(String, String, String)> = sqlx::query_as(SELF_PIECE_SQL)
        .bind(delegation)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((lead, root, message)) = piece else {
        return Ok(None);
    };
    sqlx::query(LOCK_SQL)
        .bind(&lead)
        .bind(&root)
        .execute(&mut *conn)
        .await?;
    type Row = (
        String,
        String,
        Option<String>,
        Option<String>,
        Option<String>,
        String,
    );
    let rows: Vec<Row> = sqlx::query_as(SIBLINGS_SQL)
        .bind(&lead)
        .bind(&root)
        .bind(delegation)
        .fetch_all(&mut *conn)
        .await?;
    let open = rows
        .iter()
        .filter(|r| r.0 != delegation && r.2.is_none())
        .count();
    let held = rows
        .iter()
        .filter(|r| r.0 != delegation && r.2.is_some() && r.5 == "held")
        .count();
    let verdict = decide(true, true, open, held);
    match verdict {
        Verdict::Pass => {}
        Verdict::Hold => {
            sqlx::query(STAMP_SQL)
                .bind(vec![message.clone()])
                .bind(json!({ "state": "held" }).to_string())
                .execute(&mut *conn)
                .await?;
        }
        Verdict::Collect => {
            let pieces: Vec<Piece> = rows
                .into_iter()
                .filter(|r| r.2.is_some())
                .map(|r| Piece {
                    message_id: r.1,
                    outcome: r.2,
                    reason: r.3,
                    result_message_id: r.4,
                })
                .collect();
            let earlier: Vec<String> = pieces
                .iter()
                .filter(|p| p.message_id != message)
                .map(|p| p.message_id.clone())
                .collect();
            sqlx::query(STAMP_SQL)
                .bind(&earlier)
                .bind(json!({ "state": "collected", "into": message }).to_string())
                .execute(&mut *conn)
                .await?;
            sqlx::query(STAMP_SQL)
                .bind(vec![message.clone()])
                .bind(collected_meta(&pieces).to_string())
                .execute(&mut *conn)
                .await?;
        }
    }
    Ok(Some(Gate {
        verdict,
        lead,
        message,
    }))
}

/// 깨우지 않고 닫는 길(자동 닫힘)의 뒤처리 — 닫힌 위임이 마지막 자기 조각이었고 보류한 형제가 있으면 모아 깨운다.
/// 깨운 넘긴 쪽을 돌려준다. 보류한 형제가 없으면 그 길의 지금 동작(깨우지 않음) 그대로다.
pub(crate) async fn after_quiet_close(
    conn: &mut sqlx::PgConnection,
    delegations: &[String],
) -> Result<Vec<String>, sqlx::Error> {
    let mut woke = Vec::new();
    if !enabled() {
        return Ok(woke);
    }
    for d in delegations {
        let Some(g) = gate(conn, d).await? else {
            continue;
        };
        if g.verdict == Verdict::Collect {
            // 이 길의 역할에 inbox 쓰기가 없을 수 있다 — 실패해도 닫기 tx 는 깨지 않는다(그 길의 옛 동작: 깨우지 않음).
            sqlx::query("savepoint split_collect_wake")
                .execute(&mut *conn)
                .await?;
            let put = sqlx::query(
                "insert into inbox (account_id, message_id, reason) values ($1::uuid, $2::uuid, 'delegation_done')",
            )
            .bind(&g.lead)
            .bind(&g.message)
            .execute(&mut *conn)
            .await;
            if let Err(e) = &put {
                eprintln!("split_collect: collected wake failed: {e}");
                sqlx::query("rollback to savepoint split_collect_wake")
                    .execute(&mut *conn)
                    .await?;
            } else {
                super::wake_write::along_one(conn, &g.message, &g.lead).await;
            }
            sqlx::query("release savepoint split_collect_wake")
                .execute(&mut *conn)
                .await?;
            if put.is_ok() {
                woke.push(g.lead);
            }
        }
    }
    Ok(woke)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn switch_is_off_unless_explicit() {
        assert!(!collect_on(None));
        assert!(!collect_on(Some("")));
        assert!(!collect_on(Some("off")));
        assert!(collect_on(Some("on")));
        assert!(collect_on(Some(" TRUE ")));
        assert!(collect_on(Some("1")));
    }

    #[test]
    fn off_or_ordinary_delegation_passes() {
        assert_eq!(decide(false, true, 3, 2), Verdict::Pass);
        assert_eq!(decide(true, false, 3, 2), Verdict::Pass);
    }

    #[test]
    fn holds_while_a_sibling_is_open() {
        assert_eq!(decide(true, true, 1, 0), Verdict::Hold);
        assert_eq!(decide(true, true, 2, 5), Verdict::Hold);
    }

    /// 마지막 조각은 닫힌 길(report·fail·기한·중단)을 가리지 않고 같은 판정을 받는다 — 판정은 결말을 입력으로 받지 않는다.
    #[test]
    fn last_piece_collects_whatever_closed_it() {
        assert_eq!(decide(true, true, 0, 2), Verdict::Collect);
    }

    #[test]
    fn single_piece_wakes_as_before() {
        assert_eq!(decide(true, true, 0, 0), Verdict::Pass);
    }

    #[test]
    fn body_lists_each_piece_with_outcome_and_link() {
        let p = |m: &str, o: &str, r: Option<&str>, res: Option<&str>| Piece {
            message_id: m.into(),
            outcome: Some(o.into()),
            reason: r.map(Into::into),
            result_message_id: res.map(Into::into),
        };
        let body = collect_body(&[
            p("m1", "reported", None, Some("r1")),
            p("m2", "failed", None, Some("r2")),
            p("m3", "timeout", None, None),
            p("m4", "canceled", None, None),
            p("m5", "closed", Some("max_age"), None),
        ]);
        assert!(body.starts_with("자기 쪼개기 조각 5개가 모두 닫혔다."));
        assert!(body.contains("| 1 | harkroom://message/m1 | report | harkroom://message/r1 |"));
        assert!(body.contains("| 2 | harkroom://message/m2 | fail | harkroom://message/r2 |"));
        assert!(body.contains("| 3 | harkroom://message/m3 | 기한 | — |"));
        assert!(body.contains("| 4 | harkroom://message/m4 | 중단 | — |"));
        assert!(body.contains("| 5 | harkroom://message/m5 | 기한 | — |"));
    }

    /// 넘긴 쪽이 스스로 닫은 조각(`delegator_close`)이 마지막이어도 보류한 형제가 있으면 모은다 — 표에는 닫힌 까닭이 적힌다.
    #[test]
    fn delegator_closed_last_piece_still_collects_held_siblings() {
        assert_eq!(decide(true, true, 0, 1), Verdict::Collect);
        let body = collect_body(&[
            Piece {
                message_id: "m1".into(),
                outcome: Some("reported".into()),
                reason: None,
                result_message_id: Some("r1".into()),
            },
            Piece {
                message_id: "m2".into(),
                outcome: Some("closed".into()),
                reason: Some("delegator_close".into()),
                result_message_id: None,
            },
        ]);
        assert!(body.contains("| 1 | harkroom://message/m1 | report | harkroom://message/r1 |"));
        assert!(body.contains("| 2 | harkroom://message/m2 | 닫힘(delegator_close) | — |"));
    }

    #[test]
    fn collected_meta_carries_body_and_pieces() {
        let v = collected_meta(&[Piece {
            message_id: "m1".into(),
            outcome: Some("done".into()),
            reason: None,
            result_message_id: Some("r1".into()),
        }]);
        assert_eq!(v["state"], "collected");
        assert_eq!(v["pieces"][0]["resultMessageId"], "r1");
        assert!(
            v["body"]
                .as_str()
                .unwrap()
                .contains("harkroom://message/r1")
        );
    }
}
