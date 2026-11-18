//! 기동 때 키 묶음을 DB 의 키 확인값(104 `secret_key_check`)과 맞춰 본다 — TS `services/secretKeyCheck.ts` 의
//! `verifySecretKeys` 그대로. 비밀 REST 쓰기 코어가 기동에 한 번 부르고 그 키링을 들고 있는다.
//!
//! - 행이 있으면 마운트한 키의 KCV 와 비교해, 다르면 그 kid 를 뺀다.
//! - 행이 없으면 그 kid 로 봉인된 값이 있을 때 그중 하나를 실제로 풀어 본 뒤에만 넣는다(`on conflict do nothing` 뒤 다시 읽어 비교).
//! - 활성 kid 가 빠지면 키링은 `None` 이고 `mismatch` 가 true 다.
use super::keyring::{
    LoadedSecretKeys, MasterKey, SecretAad, SecretKeyring, SecretKind, key_check_value,
    load_secret_keys_from_env,
};
use sqlx::PgPool;

/// 쓰는 칸 권한 — 확인값 읽기·넣기와 봉인된 값 하나 읽기.
pub const SECRET_KEY_CHECK_PRIVILEGES: &[(&str, &str)] = &[
    ("secret_key_check.kid", "SELECT"),
    ("secret_key_check.kcv", "SELECT"),
    ("secret_key_check.kid", "INSERT"),
    ("secret_key_check.kcv", "INSERT"),
    ("secret_version.secret_id", "SELECT"),
    ("secret_version.version", "SELECT"),
    ("secret_version.sealed", "SELECT"),
    ("secret.id", "SELECT"),
    ("secret.kind", "SELECT"),
];

const KCV_SQL: &str = "select kcv from secret_key_check where kid = $1";
const KCV_INSERT_SQL: &str =
    "insert into secret_key_check (kid, kcv) values ($1, $2) on conflict (kid) do nothing";
const EXISTING_SQL: &str = "select v.secret_id::text, v.version, s.kind, v.sealed \
       from secret_version v join secret s on s.id = v.secret_id \
      where v.sealed is not null and split_part(v.sealed, '.', 1) = 'v2' and split_part(v.sealed, '.', 2) = $1 \
      limit 1";

/// TS `VerifiedSecretKeys`.
#[derive(Debug)]
pub(crate) struct VerifiedSecretKeys {
    pub keyring: Option<SecretKeyring>,
    /// 활성 kid 가 DB 의 확인값과 맞지 않아 보관소를 껐다.
    pub mismatch: bool,
    /// 로그용 — 화면에 싣지 않는다.
    pub rejected_kids: Vec<String>,
}

pub(crate) fn kind_of(s: &str) -> Option<SecretKind> {
    match s {
        "text" => Some(SecretKind::Text),
        "file" => Some(SecretKind::File),
        _ => None,
    }
}

/// 같은 길이에서 시간 차가 없는 비교.
pub(crate) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// TS `verifySecretKeys`.
pub(crate) async fn verify_secret_keys(
    pool: &PgPool,
    loaded: LoadedSecretKeys,
) -> sqlx::Result<VerifiedSecretKeys> {
    let active = loaded.active_kid;
    let mut accepted: Vec<(String, MasterKey)> = Vec::new();
    let mut rejected_kids = Vec::new();
    for (kid, key) in loaded.keys {
        let (ok, key) = key_matches(pool, kid.clone(), key).await?;
        if ok {
            accepted.push((kid, key));
        } else {
            rejected_kids.push(kid);
        }
    }
    if !accepted.iter().any(|(k, _)| *k == active) {
        return Ok(VerifiedSecretKeys {
            keyring: None,
            mismatch: true,
            rejected_kids,
        });
    }
    let keyring = SecretKeyring::new(LoadedSecretKeys {
        keys: accepted,
        active_kid: active,
    })
    .ok();
    Ok(VerifiedSecretKeys {
        mismatch: keyring.is_none(),
        keyring,
        rejected_kids,
    })
}

/// 키를 받아 판정과 함께 돌려준다(키는 복제하지 않는다).
async fn key_matches(
    pool: &PgPool,
    kid: String,
    key: MasterKey,
) -> sqlx::Result<(bool, MasterKey)> {
    let mine = key_check_value(&key);
    let mut stored: Option<Vec<u8>> = sqlx::query_scalar(KCV_SQL)
        .bind(&kid)
        .fetch_optional(pool)
        .await?;
    let mut key = key;
    if stored.is_none() {
        let (opens, k) = opens_existing_value(pool, kid.clone(), key).await?;
        key = k;
        if !opens {
            return Ok((false, key));
        }
        sqlx::query(KCV_INSERT_SQL)
            .bind(&kid)
            .bind(&mine[..])
            .execute(pool)
            .await?;
        stored = sqlx::query_scalar(KCV_SQL)
            .bind(&kid)
            .fetch_optional(pool)
            .await?;
    }
    Ok((stored.is_some_and(|s| ct_eq(&s, &mine)), key))
}

/// 이 kid 로 봉인된 값이 없으면 true, 있으면 그중 하나가 이 키로 풀리는지.
async fn opens_existing_value(
    pool: &PgPool,
    kid: String,
    key: MasterKey,
) -> sqlx::Result<(bool, MasterKey)> {
    let row: Option<(String, i32, String, String)> = sqlx::query_as(EXISTING_SQL)
        .bind(&kid)
        .fetch_optional(pool)
        .await?;
    let ring = SecretKeyring::new(LoadedSecretKeys {
        keys: vec![(kid.clone(), key)],
        active_kid: kid,
    })
    .expect("kid came from a loaded key set");
    let ok = match &row {
        None => true,
        Some((id, version, kind, sealed)) => kind_of(kind).is_some_and(|kind| {
            ring.open(
                sealed,
                &SecretAad {
                    secret_id: id,
                    version: i64::from(*version),
                    kind,
                },
            )
            .is_some()
        }),
    };
    let key = ring
        .into_keys()
        .pop()
        .map(|(_, k)| k)
        .expect("one key in, one key out");
    Ok((ok, key))
}

/// 기동 한 번: env 로 키를 읽어 DB 확인값과 맞춘다. env 가 없으면 `Ok(None)`(보관소 꺼짐 — `mismatch` 아님).
/// 오류 글귀에는 파일 이름·kid 만 있다.
pub(crate) async fn load_verified_from_env(
    pool: &PgPool,
) -> Result<Option<VerifiedSecretKeys>, String> {
    let Some(loaded) = load_secret_keys_from_env().map_err(|e| format!("{e}"))? else {
        return Ok(None);
    };
    verify_secret_keys(pool, loaded)
        .await
        .map(Some)
        .map_err(|e| format!("key check failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ct_eq_works() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
    }

    #[test]
    fn existing_sql_never_touches_automation() {
        for q in [KCV_SQL, KCV_INSERT_SQL, EXISTING_SQL] {
            assert!(!q.contains("ingress"), "{q}");
        }
    }
}
