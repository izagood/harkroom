//! 에이전트 글 속 비밀 값 거절(D5) — TS `services/secretLeakGuard.ts` 의 `createSecretLeakGuard`(`findInTexts`·`findInBytes`·
//! `record`)를 Rust 에서 하는 공용 판정. 판정 자체는 [`crate::secrets::leak`] 에 있고, 여기는 DB 읽기(grant 걸린 비밀의 현재 값)와
//! 거절 기록(`secret_access_log` 비밀마다 `denied`/`leak_blocked` + 감사 `secret.leak.blocked`)을 붙인다.
//!
//! - 키링은 기동에 한 번 env 로 읽어 DB 확인값과 맞춘다(TS `verifySecretKeys` → `createSecretLeakGuard`). 키링이 없거나 맞지 않으면
//!   TS 처럼 검사가 꺼진다([`LeakGuard::is_on`] 이 거짓 — TS 는 `leakGuard` 가 null 이다).
//! - 쓰기마다 새로 읽는다(부여·회수·값 교체가 곧바로 반영 — TS 와 같다). 연 값은 [`LeakSecret`] 이 지운다.
//! - 쓰는 곳: 에이전트 업로드(`attachment_upload.rs`, surface `upload`). `/mcp` 입장 확인(`findInTexts`, surface `mcp:<tool>`)은 [`crate::core::mcp::route::serve`].
//! - 권한은 [`privileges`] — 비밀 **값**(`secret_version.sealed`)을 읽는 줄이다(보안 검토 대상).
use sqlx::{PgPool, Row};

use crate::secrets::keyring::{SecretAad, SecretBytes, SecretKeyring, SecretKind};
use crate::secrets::leak::{LEAK_MIN_CHARS, LeakHit, LeakSecret, find_in_bytes};
use crate::secrets::verify::{SECRET_KEY_CHECK_PRIVILEGES, load_verified_from_env};

pub(crate) use crate::secrets::leak::{SECRET_IN_BODY_CODE, SECRET_IN_BODY_MESSAGE};

/// SECURITY REVIEW: `secret_version.sealed`(봉인된 비밀 값)을 읽는다 — 이 판정만 쓴다.
pub const LEAK_GUARD_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_grant.agent_id", "SELECT"),
    ("secret_grant.secret_id", "SELECT"),
    ("secret.id", "SELECT"),
    ("secret.name", "SELECT"),
    ("secret.kind", "SELECT"),
    ("secret_version.secret_id", "SELECT"),
    ("secret_version.version", "SELECT"),
    ("secret_version.sealed", "SELECT"),
    ("secret_version.revoked_at", "SELECT"),
    ("secret_access_log.secret_id", "INSERT"),
    ("secret_access_log.secret_name", "INSERT"),
    ("secret_access_log.agent_id", "INSERT"),
    ("secret_access_log.operator_id", "INSERT"),
    ("secret_access_log.result", "INSERT"),
    ("secret_access_log.reason", "INSERT"),
    ("audit_log.action", "INSERT"),
    ("audit_log.actor_id", "INSERT"),
    ("audit_log.actor_handle", "INSERT"),
    ("audit_log.target", "INSERT"),
    ("audit_log.ip", "INSERT"),
    ("audit_log.detail", "INSERT"),
];
pub const LEAK_GUARD_SEQUENCES: &[(&str, &str)] = &[("secret_access_log_id_seq", "USAGE")];

/// 모든 표 권한(이 판정 + 기동 키 확인).
pub fn privileges() -> Vec<(&'static str, &'static str)> {
    LEAK_GUARD_PRIVILEGES
        .iter()
        .chain(SECRET_KEY_CHECK_PRIVILEGES)
        .copied()
        .collect()
}

/// TS `LEAK_NEEDLES_SQL` — uuid·int 칸을 text·int8 로 읽는다.
const NEEDLES_SQL: &str = "select q.id::text, q.name, q.kind, q.version::int8, q.sealed from (\
     select distinct s.id, s.name, s.kind, v.version, v.sealed \
       from secret_grant g join secret s on s.id = g.secret_id \
       join secret_version v on v.secret_id = s.id and v.revoked_at is null and v.sealed is not null \
      where g.agent_id = $1::uuid) q";

/// [`NEEDLES_SQL`] 의 행이 있는가만.
const HAS_NEEDLES_SQL: &str = "select exists (select 1 \
       from secret_grant g join secret s on s.id = g.secret_id \
       join secret_version v on v.secret_id = s.id and v.revoked_at is null and v.sealed is not null \
      where g.agent_id = $1::uuid)";

const RECORD_SQL: &str = "insert into secret_access_log (secret_id, secret_name, agent_id, operator_id, result, reason) \
     values ($1::uuid, $2, $3::uuid, $4::uuid, 'denied', 'leak_blocked')";

/// 누가 막혔는지(감사 줄의 행위자 — TS `actorOf(req)`).
pub struct LeakActor<'a> {
    pub agent_id: &'a str,
    /// TS `record(null, …)`(`/mcp` 입장 확인)은 `null` 이다.
    pub agent_handle: Option<&'a str>,
    pub operator_id: Option<&'a str>,
    pub ip: Option<&'a str>,
}

pub struct LeakGuard {
    pool: PgPool,
    keyring: Option<SecretKeyring>,
}

impl LeakGuard {
    /// 기동 한 번. env 가 잘못됐으면 `Err`(그 줄은 TS 에 남는다).
    pub async fn load(pool: PgPool) -> Result<Self, String> {
        let v = load_verified_from_env(&pool).await?;
        Ok(Self {
            pool,
            keyring: v.and_then(|v| v.keyring),
        })
    }

    pub fn is_on(&self) -> bool {
        self.keyring.is_some()
    }

    /// 이 에이전트에게 grant 로 걸린, 아직 살아 있는 봉인 값이 하나라도 있는가 — [`NEEDLES_SQL`] 과 같은 조건(값은 읽지 않는다).
    /// 키링이 없는 가드에서 쓴다: 없으면 무엇을 검사해도 찾을 것이 없다(TS 가드도 같은 결과).
    pub async fn has_needles(&self, agent_id: &str) -> sqlx::Result<bool> {
        sqlx::query_scalar(HAS_NEEDLES_SQL)
            .bind(agent_id)
            .fetch_one(&self.pool)
            .await
    }

    /// 키링이 있을 때만 가드를 돌려준다. 키 env 가 없어 꺼진 가드를 쥐면 에이전트 업로드가 비밀 값 검사 없이 Rust 에서 저장되므로,
    /// 그때는 `None` — 그 줄을 TS 에 남긴다(모듈 문서 「키 env 를 켤 수 없으면 TS」, api_checks `load_secret_opener` 와 같은 꼴).
    pub fn into_active(self) -> Option<Self> {
        self.is_on().then_some(self)
    }

    async fn secrets(
        &self,
        keyring: &SecretKeyring,
        agent_id: &str,
    ) -> sqlx::Result<Vec<LeakSecret>> {
        let rows = sqlx::query(NEEDLES_SQL)
            .bind(agent_id)
            .fetch_all(&self.pool)
            .await?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let id: String = r.get(0);
            let name: String = r.get(1);
            let kind = match r.get::<String, _>(2).as_str() {
                "file" => SecretKind::File,
                _ => SecretKind::Text,
            };
            let version: i64 = r.get(3);
            let sealed: String = r.get(4);
            let Some(value): Option<SecretBytes> = keyring.open(
                &sealed,
                &SecretAad {
                    secret_id: &id,
                    version,
                    kind,
                },
            ) else {
                continue;
            };
            out.push(LeakSecret::new(LeakHit { id, name }, value));
        }
        Ok(out)
    }

    /// TS `findInTexts`(`/mcp` 입장 확인 — 인자의 글을 [`crate::secrets::leak::collect_strings`] 로 모아 넘긴다).
    pub(crate) async fn find_in_texts(
        &self,
        agent_id: &str,
        texts: &[&str],
    ) -> sqlx::Result<Vec<LeakHit>> {
        let Some(keyring) = &self.keyring else {
            return Ok(vec![]);
        };
        let secrets = self.secrets(keyring, agent_id).await?;
        Ok(crate::secrets::leak::find_in_texts(&secrets, texts))
    }

    /// TS `findInBytes`.
    pub(crate) async fn find_in_bytes(
        &self,
        agent_id: &str,
        bytes: &[u8],
    ) -> sqlx::Result<Vec<LeakHit>> {
        let Some(keyring) = &self.keyring else {
            return Ok(vec![]);
        };
        if bytes.len() < LEAK_MIN_CHARS {
            return Ok(vec![]);
        }
        let secrets = self.secrets(keyring, agent_id).await?;
        Ok(find_in_bytes(&secrets, bytes))
    }

    /// TS `record` — 비밀마다 access_log 한 줄 + 감사 한 줄(감사 실패는 막지 않는다).
    pub(crate) async fn record(
        &self,
        who: &LeakActor<'_>,
        hits: &[LeakHit],
        surface: &str,
    ) -> sqlx::Result<()> {
        for h in hits {
            sqlx::query(RECORD_SQL)
                .bind(&h.id)
                .bind(&h.name)
                .bind(who.agent_id)
                .bind(who.operator_id)
                .execute(&self.pool)
                .await?;
        }
        let secrets: Vec<_> = hits
            .iter()
            .map(|h| serde_json::json!({ "id": h.id, "name": h.name }))
            .collect();
        crate::write::record_audit(
            &self.pool,
            crate::write::AuditEntry {
                action: "secret.leak.blocked",
                actor_id: Some(who.agent_id),
                actor_handle: who.agent_handle,
                target: Some(who.agent_id),
                ip: who.ip,
                detail: serde_json::json!({ "surface": surface, "secrets": secrets }),
            },
        )
        .await;
        Ok(())
    }
}

/// TS `SECRET_IN_BODY` 400.
pub(crate) fn secret_in_body() -> axum::response::Response {
    crate::directory::json_err(
        axum::http::StatusCode::BAD_REQUEST,
        SECRET_IN_BODY_CODE,
        SECRET_IN_BODY_MESSAGE,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn needles_sql_matches_ts() {
        let ts = include_str!("../../../../packages/server/src/services/secretLeakGuard.ts");
        let norm = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
        let inner = "select distinct s.id, s.name, s.kind, v.version, v.sealed \
       from secret_grant g join secret s on s.id = g.secret_id \
       join secret_version v on v.secret_id = s.id and v.revoked_at is null and v.sealed is not null \
      where g.agent_id = $1::uuid";
        assert!(norm(NEEDLES_SQL).contains(&norm(inner)));
        assert!(norm(ts).contains(&norm(inner)));
        assert!(ts.contains("'denied', 'leak_blocked'"));
        assert!(ts.contains("action: 'secret.leak.blocked'"));
        // 키링 없는 가드의 「걸린 비밀이 있나」는 같은 from·where 를 본다.
        let from_where = &inner[inner.find("from").unwrap()..];
        assert!(norm(HAS_NEEDLES_SQL).contains(&norm(from_where)));
    }

    /// 키 env 가 없어 꺼진 가드는 쥐지 않는다 → 에이전트 업로드는 TS 가 받는다(security #2353 막음 #1).
    #[tokio::test]
    async fn guard_without_keyring_is_not_active() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://x@127.0.0.1:1/x")
            .unwrap();
        let off = LeakGuard {
            pool,
            keyring: None,
        };
        assert!(!off.is_on());
        assert!(off.into_active().is_none());
    }
}
