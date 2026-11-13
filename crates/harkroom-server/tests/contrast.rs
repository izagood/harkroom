//! TS·Rust 대조 시험(S5.2 P0 의 틀). 같은 HTTP 요청을 TS 서버와 Rust 앞단에 보내 상태·형식·본문이 같은지 본다.
//!
//! env `HARKROOM_CONTRAST_TS_URL`(TS 서버) · `HARKROOM_CONTRAST_RS_URL`(그 TS 를 상류로 둔 앞단) 둘 다 있을 때만 돈다 —
//! CI 에는 서버가 없어 건너뛴다. 묶음 PR(P1~)은 옮긴 라우트의 요청을 `cases()` 에 더하고, 로컬에서 두 서버를 띄워 돌린 결과를
//! PR 본문에 적는다. 인증이 필요한 요청은 env `HARKROOM_CONTRAST_TOKEN`(시험 DB 의 세션 토큰)을 Bearer 로 싣는다.
mod common;

use common::{Case, contrast};

fn cases(token: Option<&str>) -> Vec<Case<'_>> {
    let mut v = vec![
        // 익명 — 옮긴 라우트는 TS 와 같은 401 을 내야 한다.
        Case::get("anon /auth/me", "/auth/me"),
        Case::get("unknown path", "/no-such-route-for-contrast"),
    ];
    if let Some(t) = token {
        let _ = t; // P1 부터: Case::get(...).header("authorization", bearer) 로 옮긴 GET 을 더한다.
    }
    v.shrink_to_fit();
    v
}

#[tokio::test]
async fn ts_and_rust_answer_the_same() {
    let (Ok(ts), Ok(rs)) = (
        std::env::var("HARKROOM_CONTRAST_TS_URL"),
        std::env::var("HARKROOM_CONTRAST_RS_URL"),
    ) else {
        eprintln!("skip: HARKROOM_CONTRAST_TS_URL / HARKROOM_CONTRAST_RS_URL unset");
        return;
    };
    let token = std::env::var("HARKROOM_CONTRAST_TOKEN").ok();
    let diff = contrast(
        ts.trim_end_matches('/'),
        rs.trim_end_matches('/'),
        &cases(token.as_deref()),
    )
    .await;
    assert!(
        diff.is_empty(),
        "TS 와 Rust 의 답이 다르다:\n{}",
        diff.join("\n")
    );
}
