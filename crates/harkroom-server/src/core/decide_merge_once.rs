//! S5.4 — 머지 거절 카드의 [이번 한 번](merge `approve_once`)을 Rust 로 옮기기 위한 순수 조각(아직 라우트에 잇지 않음).
//!
//! TS 정본: `decisions.ts` `onceFromCard`, `mergeDenials.ts` `insertApprovalFromDenial`·`sameNames`·`GH_LOGIN_RE`.
//! 지금은 [`super::decide_core::rust_takes`] 가 `once` 있는 결정을 처음부터 TS 로 넘긴다 — 이 모듈은 그 갈래를 맡을 때 쓸
//! 판정(쓰기 전)과 문장·필요 권한을 미리 고정한다. 쓰기 갈래를 붙일 때 [`MERGE_ONCE_PRIVILEGES`] 가 다 있어야만 Rust 가 맡는다.
use serde_json::Value;
use std::collections::BTreeSet;

/// 승인 풀에 있어야 하는 칸(fail-closed — 하나라도 없으면 「permission merge once core off」, 그 꼴은 TS).
/// 요청 줄·카드·감사 칸은 [`super::decide_approve::APPROVE_PRIVILEGES`] 가 이미 요구한다.
pub const MERGE_ONCE_PRIVILEGES: &[(&str, &str)] = &[
    ("merge_denial.id", "SELECT"),
    ("merge_denial.agent_id", "SELECT"),
    ("merge_denial.scope", "SELECT"),
    ("merge_denial.pr_number", "SELECT"),
    ("merge_denial.head_sha", "SELECT"),
    ("merge_denial.channel_id", "SELECT"),
    ("merge_denial.thread_root_id", "SELECT"),
    ("merge_denial.expires_at", "SELECT"),
    ("merge_denial.used_at", "SELECT"),
    ("merge_denial.reason", "SELECT"),
    ("merge_denial.failed_checks", "SELECT"),
    ("merge_denial.obsoleted_at", "SELECT"),
    ("merge_denial.used_at", "UPDATE"),
    ("merge_denial.used_by", "UPDATE"),
    ("merge_approval.id", "SELECT"),
    ("merge_approval.denial_id", "INSERT"),
    ("merge_approval.agent_id", "INSERT"),
    ("merge_approval.scope", "INSERT"),
    ("merge_approval.pr_number", "INSERT"),
    ("merge_approval.head_sha", "INSERT"),
    ("merge_approval.gh_user", "INSERT"),
    ("merge_approval.relax_checks", "INSERT"),
    ("merge_approval.channel_id", "INSERT"),
    ("merge_approval.thread_root_id", "INSERT"),
    ("merge_approval.approved_by", "INSERT"),
    ("merge_approval.approved_at", "INSERT"),
    ("merge_approval.expires_at", "INSERT"),
    ("merge_approval.ci_override", "INSERT"),
    ("merge_approval.approved_checks", "INSERT"),
];

static MERGE_ONCE_CORE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 머지 거절 카드의 [이번 한 번]을 Rust 가 맡는가 — 기동 때 [`check_merge_once_core`] 가 정한다.
pub fn merge_once_on() -> bool {
    MERGE_ONCE_CORE.load(std::sync::atomic::Ordering::Relaxed)
}

/// 승인 풀에 [`MERGE_ONCE_PRIVILEGES`] 가 다 있는가 — 기동 때 한 번.
pub async fn check_merge_once_core(pool: &sqlx::PgPool) -> bool {
    let on = match crate::write::missing_in(pool, MERGE_ONCE_PRIVILEGES, &[]).await {
        Ok(m) if m.is_empty() => true,
        Ok(m) => {
            eprintln!("front: permission merge once core off — missing privileges {m:?}");
            false
        }
        Err(e) => {
            eprintln!(
                "front: permission merge once core off — privilege check failed ({})",
                e.as_database_error().map_or("io", |_| "db")
            );
            false
        }
    };
    MERGE_ONCE_CORE.store(on, std::sync::atomic::Ordering::Relaxed);
    on
}

/// 1회 승인 감사(TS `repo.merge.approved_once`, target 은 저장소 scope).
pub const MERGE_ONCE_AUDIT: &str = "insert into audit_log (action, actor_id, target, detail) \
     values ('repo.merge.approved_once', $1::uuid, $2, $3::jsonb)";

/// 요청 줄 — TS 는 1회 머지에 기한·grantMode 를 적지 않는다(`grantExpiresAt` null).
pub const MERGE_ONCE_UPDATE_REQUEST: &str = "update permission_request set status = 'approved_once', \
     decided_at = $3::timestamptz, decided_by = $2::uuid, grant_expires_at = null, grant_mode = null where id = $1::uuid";

/// TS `answerOptionId` 후보 `[approve_once, approve_mandate, approve_new_mandate, approve, approve_once]`(뒤 중복 뺌).
pub const ANSWER_MERGE_ONCE: &[&str] = &[
    "approve_once",
    "approve_mandate",
    "approve_new_mandate",
    "approve",
];

pub const DENIAL_USED_MESSAGE: &str = "the merge refusal behind this card was already used";

/// TS `APPROVAL_TTL_MS`(24시간).
pub const APPROVAL_TTL: &str = "24 hours";

/// TS `readDenial(client, id, now, true)` — 거절 기록을 잠그고 읽는다(`headMoved` 는 obsolete 문구에만 쓰여 뺐다: obsolete 면 TS).
/// $1 거절 id, $2 결정 시각.
pub const READ_DENIAL_LOCKED_SQL: &str = "select id::text, agent_id::text, scope, pr_number::bigint, head_sha, channel_id::text, \
     thread_root_id::text, expires_at <= $2::timestamptz as expired, reason, failed_checks, obsoleted_at is not null as obsolete \
     from merge_denial d where id = $1::uuid for update of d";

/// TS 의 거절 기록 소모(같은 문장).
pub const USE_DENIAL_SQL: &str = "update merge_denial set used_at = $2::timestamptz, used_by = $3::uuid \
     where id = $1::uuid and used_at is null returning id::text";

/// TS 의 1회 승인 INSERT(같은 칸·같은 차례).
pub const INSERT_APPROVAL_SQL: &str = "insert into merge_approval (denial_id, agent_id, scope, pr_number, head_sha, gh_user, \
     relax_checks, channel_id, thread_root_id, approved_by, approved_at, expires_at, ci_override, approved_checks) \
     values ($1::uuid, $2::uuid, $3, $4::int, $5, $6, $7, $8::uuid, $9::uuid, $10::uuid, $11::timestamptz, $12::timestamptz, $13, $14) \
     returning id::text";

/// 카드가 보여 준 1회 머지 값 — TS `DecideInput['once']`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Once {
    pub gh_user: Option<String>,
    pub relax_checks: bool,
    pub number: i64,
    pub head_sha: String,
    pub failed_checks: Option<Vec<String>>,
}

/// TS `onceFromCard` — 카드 meta 의 `permissionRequest.once`. number 는 JS number(정수가 아닌 값은 TS 도 대조에서 떨어진다 —
/// 여기서는 정수만 받고 나머지는 `None` = TS 로 넘긴다).
pub fn once_from_card(meta: &Value) -> Option<Once> {
    let o = meta.get("permissionRequest")?.get("once")?;
    let number = o.get("number")?.as_i64()?;
    let head_sha = o.get("headSha")?.as_str()?.to_owned();
    let failed_checks = o.get("failedChecks").and_then(Value::as_array).map(|a| {
        a.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    });
    Some(Once {
        gh_user: None,
        relax_checks: o.get("reason").and_then(Value::as_str) == Some("ci_not_green"),
        number,
        head_sha,
        failed_checks,
    })
}

/// TS `GH_LOGIN_RE` — `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`.
pub fn gh_login_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 39
        && b[0].is_ascii_alphanumeric()
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'-')
}

/// TS `sameNames` — 집합으로 같은가. 카드에 목록이 없으면 다르다.
pub fn same_names(card: Option<&[String]>, denial: &[String]) -> bool {
    let Some(card) = card else { return false };
    let x: BTreeSet<&str> = card.iter().map(String::as_str).collect();
    let y: BTreeSet<&str> = denial.iter().map(String::as_str).collect();
    x == y
}

/// 잠근 거절 기록에서 판정에 쓰는 값.
#[derive(Debug, Clone)]
pub struct DenialView<'a> {
    pub agent_id: &'a str,
    pub expired: bool,
    pub obsolete: bool,
    pub number: i64,
    pub head_sha: &'a str,
    pub reason: &'a str,
    pub failed_checks: &'a [String],
}

/// 쓰기 전 판정의 결과.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OnceCheck {
    /// 거절 기록을 소모하고 승인을 써도 된다. `ci_override` 는 CI 거절 카드인가.
    Go { ci_override: bool },
    Refused {
        status: u16,
        code: &'static str,
        message: &'static str,
    },
    /// TS 가 따로 문구를 만드는 갈래(`obsoleteRefusal`) — 쓰기 전이므로 TS 로 넘긴다.
    HandToTs,
}

const fn refused(status: u16, code: &'static str, message: &'static str) -> OnceCheck {
    OnceCheck::Refused {
        status,
        code,
        message,
    }
}

/// TS `insertApprovalFromDenial` 의 쓰기 전 대조 — 같은 차례·같은 문구.
pub fn check_once(agent_id: &str, once: &Once, denial: Option<&DenialView<'_>>) -> OnceCheck {
    if let Some(u) = once.gh_user.as_deref()
        && !gh_login_ok(u)
    {
        return refused(403, "bad_gh_user", "ghUser must be a GitHub login");
    }
    let Some(d) = denial.filter(|d| d.agent_id == agent_id) else {
        return refused(404, "not_found", "no such merge denial for this agent");
    };
    if d.expired {
        return refused(
            409,
            "denial_expired",
            "the merge refusal behind this card expired — the agent has to try again",
        );
    }
    if d.obsolete {
        return OnceCheck::HandToTs;
    }
    if d.number != once.number || d.head_sha != once.head_sha {
        return refused(
            409,
            "card_stale",
            "the card changed since it was shown (a different PR or head) — look at it again",
        );
    }
    let ci_override = d.reason == "ci_not_green";
    if ci_override && !once.relax_checks {
        return refused(
            400,
            "relax_required",
            "a CI-failure card approves the merge with the CI check skipped — relaxChecks must be true",
        );
    }
    if ci_override && !same_names(once.failed_checks.as_deref(), d.failed_checks) {
        return refused(
            409,
            "card_stale",
            "the failing checks changed since the card was shown — look at it again",
        );
    }
    OnceCheck::Go { ci_override }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn once(reason_ci: bool) -> Once {
        Once {
            gh_user: None,
            relax_checks: reason_ci,
            number: 7,
            head_sha: "abc".into(),
            failed_checks: Some(vec!["lint".into(), "test".into()]),
        }
    }

    fn denial<'a>(reason: &'a str, checks: &'a [String]) -> DenialView<'a> {
        DenialView {
            agent_id: "a",
            expired: false,
            obsolete: false,
            number: 7,
            head_sha: "abc",
            reason,
            failed_checks: checks,
        }
    }

    #[test]
    fn once_from_card_reads_meta() {
        let m = json!({"permissionRequest": {"once": {"number": 7, "headSha": "abc", "reason": "ci_not_green", "failedChecks": ["lint", 3]}}});
        let o = once_from_card(&m).unwrap();
        assert_eq!(o.number, 7);
        assert!(o.relax_checks);
        assert_eq!(o.failed_checks, Some(vec!["lint".to_owned()]));
        assert_eq!(o.gh_user, None);
        assert!(
            once_from_card(
                &json!({"permissionRequest": {"once": {"number": "7", "headSha": "abc"}}})
            )
            .is_none()
        );
        assert!(once_from_card(&json!({"permissionRequest": {}})).is_none());
        let plain = once_from_card(&json!({"permissionRequest": {"once": {"number": 1, "headSha": "x", "reason": "no_grant"}}})).unwrap();
        assert!(!plain.relax_checks);
        assert_eq!(plain.failed_checks, None);
    }

    #[test]
    fn gh_login_shape() {
        assert!(gh_login_ok("octo-cat"));
        assert!(gh_login_ok("a"));
        assert!(!gh_login_ok("-a"));
        assert!(!gh_login_ok(""));
        assert!(!gh_login_ok("a_b"));
        assert!(gh_login_ok(&"a".repeat(39)));
        assert!(!gh_login_ok(&"a".repeat(40)));
    }

    #[test]
    fn same_names_is_set_equality() {
        let d = vec!["b".to_owned(), "a".to_owned()];
        assert!(same_names(Some(&["a".into(), "b".into(), "a".into()]), &d));
        assert!(!same_names(Some(&["a".into()]), &d));
        assert!(!same_names(None, &d));
    }

    #[test]
    fn check_order_matches_ts() {
        let checks = vec!["test".to_owned(), "lint".to_owned()];
        let d = denial("ci_not_green", &checks);
        assert_eq!(
            check_once("a", &once(true), Some(&d)),
            OnceCheck::Go { ci_override: true }
        );
        let mut bad = once(true);
        bad.gh_user = Some("-x".into());
        assert!(matches!(
            check_once("a", &bad, Some(&d)),
            OnceCheck::Refused {
                code: "bad_gh_user",
                status: 403,
                ..
            }
        ));
        assert!(matches!(
            check_once("b", &once(true), Some(&d)),
            OnceCheck::Refused {
                code: "not_found",
                ..
            }
        ));
        assert!(matches!(
            check_once("a", &once(true), None),
            OnceCheck::Refused {
                code: "not_found",
                ..
            }
        ));
        let exp = DenialView {
            expired: true,
            ..d.clone()
        };
        assert!(matches!(
            check_once("a", &once(true), Some(&exp)),
            OnceCheck::Refused {
                code: "denial_expired",
                ..
            }
        ));
        let obs = DenialView {
            obsolete: true,
            ..d.clone()
        };
        assert_eq!(
            check_once("a", &once(true), Some(&obs)),
            OnceCheck::HandToTs
        );
        let other = DenialView {
            head_sha: "def",
            ..d.clone()
        };
        assert!(matches!(
            check_once("a", &once(true), Some(&other)),
            OnceCheck::Refused {
                code: "card_stale",
                ..
            }
        ));
        assert!(matches!(
            check_once("a", &once(false), Some(&d)),
            OnceCheck::Refused {
                code: "relax_required",
                status: 400,
                ..
            }
        ));
        let mut changed = once(true);
        changed.failed_checks = Some(vec!["lint".into()]);
        assert!(matches!(
            check_once("a", &changed, Some(&d)),
            OnceCheck::Refused {
                code: "card_stale",
                ..
            }
        ));
        let plain = denial("no_grant", &[]);
        assert_eq!(
            check_once("a", &once(false), Some(&plain)),
            OnceCheck::Go { ci_override: false }
        );
    }
}
