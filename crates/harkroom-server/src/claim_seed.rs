//! 워크스페이스 클레임 토큰 해시 심기 — TS `services/claimToken.ts::seedClaimToken` 을 옮긴 것(s34b 앞, TS 를 끄기 전에 필요).
//!
//! 호스팅 워크스페이스를 만드는 쪽(harkroom-gate)이 `CLAIM_TOKEN_HASH`(sha256 hex) 를 env 로 준다. 기동 때 한 번
//! `claim_token` 에 넣고, `POST /claim` 이 그 행을 소비한다. 규칙은 TS 와 같다:
//! - 비었으면(셀프호스트) 아무것도 하지 않는다.
//! - sha256 hex 64자가 아니면 **기동을 거절한다** — 원문을 잘못 넣으면 어떤 토큰으로도 클레임이 안 되는데, 그 사실이
//!   클레임을 시도할 때까지 드러나지 않는다.
//! - `on conflict (token_hash) do nothing` — 재시작이 소진 기록(`used_at`)을 덮어 토큰을 되살리지 못하게 막는 유일한 장치다.

/// 심기에 쓰는 연결에 있어야 하는 칸 권한 — homelab GRANT 와 같아야 한다.
/// `grant select (token_hash), insert (token_hash) on claim_token`
/// (`select` 는 `on conflict (token_hash)` 의 충돌 대상 칸을 읽는 데 든다 — 쓰기 역할에는 [`crate::core::auth_signup::AUTH_SIGNUP_PRIVILEGES`] 로 이미 있다).
pub const CLAIM_SEED_PRIVILEGES: &[(&str, &str)] = &[
    ("claim_token.token_hash", "SELECT"),
    ("claim_token.token_hash", "INSERT"),
];

/// env 값을 읽는다. 비었거나 없으면 `Ok(None)`, 형식이 틀리면 `Err`(기동 거절). 앞뒤 공백을 떼고 소문자로 맞춘다(TS 와 같다).
pub fn parse(raw: Option<&str>) -> Result<Option<String>, String> {
    let hash = raw.unwrap_or("").trim().to_ascii_lowercase();
    if hash.is_empty() {
        return Ok(None);
    }
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(
            "CLAIM_TOKEN_HASH must be a sha256 hex digest (64 hex chars) — not the token itself"
                .into(),
        );
    }
    Ok(Some(hash))
}

/// 해시를 심는다. 새 행을 넣었으면 `true`, 이미 있었으면(소진됐어도) `false` — 있던 행은 건드리지 않는다.
pub async fn seed<'e, E: sqlx::PgExecutor<'e>>(ex: E, hash: &str) -> Result<bool, sqlx::Error> {
    let r = sqlx::query(
        "insert into claim_token (token_hash) values ($1) on conflict (token_hash) do nothing",
    )
    .bind(hash)
    .execute(ex)
    .await?;
    Ok(r.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::parse;

    const H: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn empty_or_missing_skips() {
        assert_eq!(parse(None), Ok(None));
        assert_eq!(parse(Some("")), Ok(None));
        assert_eq!(parse(Some("  \n")), Ok(None));
    }

    #[test]
    fn digest_is_trimmed_and_lowercased() {
        assert_eq!(
            parse(Some(&format!(" {} \n", H.to_uppercase()))),
            Ok(Some(H.into()))
        );
    }

    #[test]
    fn wrong_shape_refuses_start() {
        // 원문 토큰·짧은 값·긴 값·hex 가 아닌 글자.
        for bad in [
            "hk_claim_rawtoken",
            &H[..63],
            &format!("{H}0"),
            &format!("{}g", &H[..63]),
        ] {
            let e = parse(Some(bad)).unwrap_err();
            assert!(e.contains("sha256 hex digest"), "{bad}: {e}");
        }
    }
}
