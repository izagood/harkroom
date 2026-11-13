//! TS·Rust 대조 시험(S5.2 P0 의 틀). 같은 HTTP 요청을 TS 서버와 Rust 앞단에 보내 상태·형식·본문이 같은지 본다.
//!
//! env `HARKROOM_CONTRAST_TS_URL`(TS 서버) · `HARKROOM_CONTRAST_RS_URL`(그 TS 를 상류로 둔 앞단) 둘 다 있을 때만 돈다 —
//! env 가 없으면 건너뛴다. 묶음 PR(P1~)은 옮긴 라우트의 요청을 `cases()` 에 더한다. 결과는
//! PR 본문에 적는다. 인증이 필요한 요청은 env `HARKROOM_CONTRAST_TOKEN`(관리자 세션 토큰)·`HARKROOM_CONTRAST_MEMBER_TOKEN`
//! (grant 없는 멤버)을 Bearer 로 싣는다. P1 부터 CI 가 돌린다 — `packages/server/test/rustFrontDb.test.ts` 가 시험 DB 에 TS 서버와
//! 앞단 바이너리를 띄우고 픽스처를 넣은 뒤 이 시험을 부른다.
mod common;

use common::{Case, contrast};

/// `admin`·`member` 은 `Authorization` 값(`Bearer …`)이다. 관리자는 `audit.read` 를 가진 사람, 멤버는 grant 가 없는 사람이다.
fn cases<'a>(admin: Option<&'a str>, member: Option<&'a str>) -> Vec<Case<'a>> {
    let mut v = vec![
        // 익명 — 옮긴 라우트는 TS 와 같은 401 을 내야 한다.
        Case::get("anon /auth/me", "/auth/me"),
        Case::get("unknown path", "/no-such-route-for-contrast"),
        // P1 읽기① 디렉터리.
        Case::get("anon /accounts", "/accounts"),
        Case::get("anon /dms", "/dms"),
        Case::get("anon /mcp-servers", "/mcp-servers"),
        Case::get("anon /audit", "/audit"),
    ];
    if let Some(a) = admin {
        let h = |c: Case<'a>| c.header("authorization", a);
        v.extend([
            h(Case::get("/accounts", "/accounts")),
            h(Case::get("/dms", "/dms")),
            h(Case::get("/mcp-servers", "/mcp-servers")),
            h(Case::get("/audit", "/audit")),
            h(Case::get(
                "/audit limit+action",
                "/audit?limit=2&action=auth.login",
            )),
            h(Case::get("/audit limit", "/audit?limit=2")),
            h(Case::get("/audit before", "/audit?before=3&limit=500")),
            h(Case::get("/audit unknown key", "/audit?zzz=1")),
            // 400 — 문구는 zod 의 오류 JSON 이라 따라 쓰지 않는다(directory.rs `parse_audit_query`).
            h(Case::get("/audit limit=0", "/audit?limit=0")).ignore("/error/message"),
            h(Case::get("/audit before=x", "/audit?before=x")).ignore("/error/message"),
            h(Case::get("/audit dup", "/audit?limit=1&limit=2")).ignore("/error/message"),
        ]);
    }
    if let Some(m) = member {
        let h = |c: Case<'a>| c.header("authorization", m);
        v.extend([
            h(Case::get("member /dms", "/dms")),
            h(Case::get("member /accounts", "/accounts")),
            // 권한 판정이 질의 검사보다 먼저 — 잘못된 질의도 403.
            h(Case::get("member /audit", "/audit")),
            h(Case::get("member /audit limit=0", "/audit?limit=0")),
        ]);
    }
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
    let bearer = |k: &str| std::env::var(k).ok().map(|t| format!("Bearer {t}"));
    let admin = bearer("HARKROOM_CONTRAST_TOKEN");
    let member = bearer("HARKROOM_CONTRAST_MEMBER_TOKEN");
    let cases = cases(admin.as_deref(), member.as_deref());
    let diff = contrast(ts.trim_end_matches('/'), rs.trim_end_matches('/'), &cases).await;
    eprintln!("contrast: {} case(s) compared", cases.len());
    assert!(
        diff.is_empty(),
        "TS 와 Rust 의 답이 다르다:\n{}",
        diff.join("\n")
    );
}
