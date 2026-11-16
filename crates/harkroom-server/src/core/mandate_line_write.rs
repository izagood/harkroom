//! S5.3 C1 — 승인이 **이미 있는 위임장**에 줄 하나를 적는다(TS `addLineFromRequest` → `addMandateLine`).
//!
//! 승인 tx(요청 줄을 잠근 뒤) 안에서 부른다. 순서:
//! 1. scope 를 능력 등록부(tool = `validate_tool_rule`)로 다시 판정 — 정규형이 아니면 `bad_scope`(줄 없음).
//! 2. **위임장 줄을 `for share` 로 잠근다**(TS 와 다른 점 — 아래).
//! 3. 위임장이 지금 유효한가(`grant_valid_mandate_owner` 골든, 7일 쉼·자동화 상태) — 아니면 `mandate_invalid`.
//! 4. 갈래별 limits(`approve_turn` = 카드 글 `turnCause` + 1시간, 7일 승인 = 같은 결정의 grant 기한).
//! 5. savepoint 안에서 위임장 주인·맡긴 사람·끝남 대조 → `agent_ids` 대조 → `mandate_line` INSERT. 실패하면 savepoint 만 되돌린다.
//!
//! TS 와 다른 점(덜 여는 쪽): TS 는 위임장 줄을 잠그지 않고 `ended` 를 읽는다. 줄 INSERT 의 FK 검사는 KEY SHARE 라 위임장 끝내기
//! (NO KEY UPDATE)를 막지 못해, 끝내기와 겹치면 **끝난 위임장에 살아 있는 줄**이 남을 수 있다. 여기서는 2단계 `for share` 가 끝내기와
//! 줄 쓰기를 세운다 — 끝내기가 먼저 커밋했으면 `mandate_invalid`, 줄이 먼저면 끝내기가 그 줄을 회수한다.
use super::channels::frag;
use serde_json::{Value, json};
use sqlx::PgConnection;

/// TS `MANDATE_IDLE_MS`(7일) — [`super::grant_reads`] 와 같은 값.
const MANDATE_IDLE: &str = "7 days";

/// 2단계 — 위임장 줄 잠금(TS 에는 없음). `for share` 는 그 표의 UPDATE 권한(칸 하나라도)이 있어야 한다.
pub const LOCK_MANDATE_SHARE: &str = "select 1 from mandate where id = $1::uuid for share";

/// TS 정본 문장(골든 — `packages/server/test/rustSqlFragments.test.ts` 가 TS 상수와 대조한다)을 감싼 것들.
struct Sql {
    /// 3단계 — TS `validMandateOwner`. $2 = 결정 시각 − 7일.
    valid_owner: String,
    /// TS `addLineFromRequest` 의 위임장 주인.
    owner: String,
    /// TS `addMandateLine` 의 위임장 읽기(주인·맡긴 사람·끝남).
    mandate: String,
    /// TS `addMandateLine` 의 `agent_ids` 대조.
    agents: &'static str,
    /// TS `addMandateLine` 의 INSERT — 줄 id·scope 만 돌려받는다.
    insert: String,
}

fn sql() -> &'static Sql {
    static S: std::sync::OnceLock<Sql> = std::sync::OnceLock::new();
    S.get_or_init(|| Sql {
        valid_owner: format!(
            "select t.owner::text from ({}) t",
            frag("grant_valid_mandate_owner")
        ),
        owner: format!(
            "select t.owner::text from ({}) t",
            frag("mandate_line_from_request_owner")
        ),
        mandate: format!(
            "select t.owner::text, t.delegator::text, t.ended from ({}) t",
            frag("mandate_line_add_mandate")
        ),
        agents: frag("mandate_line_add_agents"),
        insert: format!(
            "with t as ({}) select t.id::text, t.scope from t",
            frag("mandate_line_add_insert")
        ),
    })
}

/// 결정 시각 기준 시각들(같은 tx 의 `now` 문자열에서): (7일 전 = 유효 경계, 1시간 뒤 ISO).
const LINE_TIMES: &str = "select ($1::timestamptz - $2::interval)::text, \
     to_char(($1::timestamptz + interval '1 hour') at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')";

pub const SAVEPOINT: &str = "savepoint mandate_line_from_request";
pub const ROLLBACK_SAVEPOINT: &str = "rollback to savepoint mandate_line_from_request";
pub const RELEASE_SAVEPOINT: &str = "release savepoint mandate_line_from_request";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    /// 7일 승인(tool `approve`·`approve_mandate`) — `until` 은 같은 결정의 grant 기한(ISO).
    Standing,
    /// [이번 턴만] — 카드 글 하나가 깨우는 턴.
    Turn,
}

#[derive(Debug, Clone, Copy)]
pub struct LineArgs<'a> {
    pub mandate_id: &'a str,
    pub request_id: &'a str,
    pub target: &'a str,
    pub card_message_id: Option<&'a str>,
    pub agent_id: &'a str,
    pub actor_id: &'a str,
    /// `button`·`bundle`.
    pub via: &'a str,
    pub kind: LineKind,
    /// 결정 시각(`timestamptz` 문자열 — [`super::decide_approve`] 의 `now`).
    pub now: &'a str,
    /// Standing 일 때 grant 기한 ISO.
    pub until: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LineOutcome {
    Added {
        mandate_id: String,
        line_id: String,
        scope: String,
        via: String,
    },
    Failed {
        mandate_id: String,
        code: &'static str,
        detail: Option<String>,
    },
}

impl LineOutcome {
    pub fn ok(&self) -> bool {
        matches!(self, LineOutcome::Added { .. })
    }
    pub fn code(&self) -> &'static str {
        match self {
            LineOutcome::Added { .. } => "",
            LineOutcome::Failed { code, .. } => code,
        }
    }
    pub fn line_id(&self) -> Option<&str> {
        match self {
            LineOutcome::Added { line_id, .. } => Some(line_id),
            LineOutcome::Failed { .. } => None,
        }
    }

    /// 감사 `mandate.line.added`·`mandate.line.add_failed` 의 (action, detail) — TS `auditLineOutcome` 과 같은 칸.
    pub fn audit(&self, request_id: &str) -> (&'static str, Value) {
        match self {
            LineOutcome::Added {
                mandate_id,
                line_id,
                scope,
                via,
            } => (
                "mandate.line.added",
                json!({ "mandateId": mandate_id, "lineId": line_id, "cap": "tool", "scope": scope,
                        "via": via, "requestId": request_id }),
            ),
            LineOutcome::Failed {
                mandate_id,
                code,
                detail,
            } => {
                let mut d = json!({ "mandateId": mandate_id, "cap": "tool", "code": code });
                if let Some(x) = detail {
                    d["detail"] = json!(x);
                }
                d["requestId"] = json!(request_id);
                ("mandate.line.add_failed", d)
            }
        }
    }
}

pub const LINE_AUDIT: &str = "insert into audit_log (action, actor_id, target, detail) \
     values ($1, $2::uuid, $3, $4::jsonb)";

fn failed(mandate_id: &str, code: &'static str, detail: Option<String>) -> LineOutcome {
    LineOutcome::Failed {
        mandate_id: mandate_id.to_string(),
        code,
        detail,
    }
}

/// TS `err.message.slice(0, 200)`(UTF-16 단위).
fn clip_200(s: &str) -> String {
    let mut n = 0;
    let mut out = String::new();
    for c in s.chars() {
        n += c.len_utf16();
        if n > 200 {
            break;
        }
        out.push(c);
    }
    out
}

/// TS `addLineFromRequest`(tool 줄만 — merge·command 는 C1 범위 밖). 승인 tx 안에서 부른다.
/// DB 오류는 savepoint 안의 것만 `error` 로 삼키고(TS 와 같음) 나머지는 그대로 올린다.
pub async fn add_line_from_request(
    conn: &mut PgConnection,
    a: LineArgs<'_>,
) -> sqlx::Result<LineOutcome> {
    use harkroom_proto::tool_rules::{ToolRuleVerdict, validate_tool_rule};
    let m = a.mandate_id;
    let scope = match validate_tool_rule(a.target) {
        ToolRuleVerdict::Ok { rule, .. } => rule,
        ToolRuleVerdict::Refused(code) => {
            return Ok(failed(m, "bad_scope", Some(code.to_string())));
        }
    };
    // 2단계 — TS 와 다른 점(덜 여는 쪽).
    sqlx::query(LOCK_MANDATE_SHARE)
        .bind(m)
        .execute(&mut *conn)
        .await?;
    let (idle_cutoff, hour_iso): (String, String) = sqlx::query_as(LINE_TIMES)
        .bind(a.now)
        .bind(MANDATE_IDLE)
        .fetch_one(&mut *conn)
        .await?;
    let owner: Option<(String,)> = sqlx::query_as(sql().valid_owner.as_str())
        .bind(m)
        .bind(&idle_cutoff)
        .fetch_optional(&mut *conn)
        .await?;
    if owner.is_none() {
        return Ok(failed(m, "mandate_invalid", None));
    }
    let limits = match a.kind {
        LineKind::Turn => {
            let Some(card) = a.card_message_id else {
                return Ok(failed(m, "no_turn", None));
            };
            json!({ "turnCause": card, "until": hour_iso })
        }
        LineKind::Standing => {
            let Some(until) = a.until else {
                return Ok(failed(m, "no_until", None));
            };
            json!({ "until": until })
        }
    };
    sqlx::query(SAVEPOINT).execute(&mut *conn).await?;
    match write_line(conn, a, &scope, &limits).await {
        Ok(Ok(out)) => {
            sqlx::query(RELEASE_SAVEPOINT).execute(&mut *conn).await?;
            Ok(out)
        }
        Ok(Err(out)) => {
            sqlx::query(ROLLBACK_SAVEPOINT).execute(&mut *conn).await?;
            Ok(out)
        }
        Err(e) => {
            sqlx::query(ROLLBACK_SAVEPOINT).execute(&mut *conn).await?;
            let msg = e
                .as_database_error()
                .map(|d| d.message().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            eprintln!("front: permission mandate line add failed");
            Ok(failed(m, "error", Some(clip_200(&msg))))
        }
    }
}

/// savepoint 안 — `Ok(Err)` 는 TS `addMandateLine` 의 `{ ok: false }`(savepoint 되돌림).
async fn write_line(
    conn: &mut PgConnection,
    a: LineArgs<'_>,
    scope: &str,
    limits: &Value,
) -> sqlx::Result<Result<LineOutcome, LineOutcome>> {
    let m = a.mandate_id;
    let m_owner: Option<(String,)> = sqlx::query_as(sql().owner.as_str())
        .bind(m)
        .fetch_optional(&mut *conn)
        .await?;
    let narrow = match &m_owner {
        Some((o,)) if a.actor_id != o => true,
        _ => a.kind == LineKind::Turn,
    };
    let row: Option<(String, String, bool)> = sqlx::query_as(sql().mandate.as_str())
        .bind(m)
        .fetch_optional(&mut *conn)
        .await?;
    let Some((owner, delegator, ended)) = row else {
        return Ok(Err(failed(m, "no_mandate", None)));
    };
    if ended {
        return Ok(Err(failed(m, "mandate_ended", None)));
    }
    if a.actor_id != owner && a.actor_id != delegator {
        return Ok(Err(failed(m, "not_owner", None)));
    }
    let agent_ids: Option<Vec<&str>> = narrow.then(|| vec![a.agent_id]);
    if let Some(ids) = &agent_ids {
        let n = sqlx::query(sql().agents)
            .bind(ids)
            .bind(&owner)
            .fetch_all(&mut *conn)
            .await?
            .len();
        if n != 1 {
            return Ok(Err(failed(m, "bad_agent", None)));
        }
    }
    let (line_id, stored_scope): (String, String) = sqlx::query_as(sql().insert.as_str())
        .bind(m)
        .bind("tool")
        .bind(scope)
        .bind(limits.to_string())
        .bind(agent_ids)
        .bind(a.actor_id)
        .bind(a.via)
        .bind(a.request_id)
        .bind(a.now)
        .fetch_one(&mut *conn)
        .await?;
    Ok(Ok(LineOutcome::Added {
        mandate_id: m.to_string(),
        line_id,
        scope: stored_scope,
        via: a.via.to_string(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_counts_utf16() {
        assert_eq!(clip_200(&"a".repeat(250)).len(), 200);
        let s = "😀".repeat(150);
        assert_eq!(clip_200(&s).chars().count(), 100);
    }

    #[test]
    fn audit_keys_follow_ts() {
        let ok = LineOutcome::Added {
            mandate_id: "m".into(),
            line_id: "l".into(),
            scope: "s".into(),
            via: "button".into(),
        };
        let (a, d) = ok.audit("r");
        assert_eq!(a, "mandate.line.added");
        assert_eq!(
            d,
            json!({"mandateId":"m","lineId":"l","cap":"tool","scope":"s","via":"button","requestId":"r"})
        );
        let (a, d) = failed("m", "mandate_invalid", None).audit("r");
        assert_eq!(a, "mandate.line.add_failed");
        assert_eq!(
            d,
            json!({"mandateId":"m","cap":"tool","code":"mandate_invalid","requestId":"r"})
        );
    }
}
