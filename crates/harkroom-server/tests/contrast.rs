//! TS·Rust 대조 시험(S5.2 P0 의 틀). 같은 HTTP 요청을 TS 서버와 Rust 앞단에 보내 상태·형식·본문이 같은지 본다.
//!
//! env `HARKROOM_CONTRAST_TS_URL`(TS 서버) · `HARKROOM_CONTRAST_RS_URL`(그 TS 를 상류로 둔 앞단) 둘 다 있을 때만 돈다 —
//! env 가 없으면 건너뛴다. 묶음 PR(P1~)은 옮긴 라우트의 요청을 `cases()` 에 더한다. 결과는
//! PR 본문에 적는다. 인증이 필요한 요청은 env `HARKROOM_CONTRAST_TOKEN`(관리자 세션 토큰)·`HARKROOM_CONTRAST_MEMBER_TOKEN`
//! (grant 없는 멤버)을 Bearer 로 싣는다. P1 부터 CI 가 돌린다 — `packages/server/test/rustFrontDb.test.ts` 가 시험 DB 에 TS 서버와
//! 앞단 바이너리를 띄우고 픽스처를 넣은 뒤 이 시험을 부른다.
mod common;

use axum::http::Method;
use common::{Case, contrast, normalize, send};

/// `admin`·`member` 은 `Authorization` 값(`Bearer …`)이다. 관리자는 `audit.read` 를 가진 사람, 멤버는 grant 가 없는 사람이다.
/// `ids` 는 픽스처가 만든 팀·집합의 경로(`/teams/<HARKROOM_CONTRAST_TEAM_ID>`, `/handle-groups/<…_GROUP_ID>`)다.
fn cases<'a>(
    admin: Option<&'a str>,
    member: Option<&'a str>,
    ids: &'a [(String, String)],
) -> Vec<Case<'a>> {
    let mut v = vec![
        // 익명 — 옮긴 라우트는 TS 와 같은 401 을 내야 한다.
        Case::get("anon /auth/me", "/auth/me"),
        Case::get("unknown path", "/no-such-route-for-contrast"),
        // P1 읽기① 디렉터리.
        Case::get("anon /accounts", "/accounts"),
        Case::get("anon /dms", "/dms"),
        Case::get("anon /mcp-servers", "/mcp-servers"),
        Case::get("anon /audit", "/audit"),
        // P2 읽기② 목록.
        Case::get("anon /teams", "/teams"),
        Case::get("anon /handle-groups", "/handle-groups"),
        Case::get("anon /skills", "/skills"),
        Case::get("anon /inbox/today/open", "/inbox/today/open"),
        Case::get("anon /inbox/today/done", "/inbox/today/done"),
        Case::get("anon /settings/mention-policy", "/settings/mention-policy"),
        Case::get("anon /settings/agent-defaults", "/settings/agent-defaults"),
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
            // P2 읽기② 목록.
            h(Case::get("/teams", "/teams")),
            h(Case::get(
                "/teams missing",
                "/teams/00000000-0000-0000-0000-000000000000",
            )),
            h(Case::get("/teams notuuid", "/teams/notuuid")).ignore("/error/message"),
            h(Case::get("/handle-groups", "/handle-groups")),
            h(Case::get(
                "/handle-groups missing",
                "/handle-groups/00000000-0000-0000-0000-000000000000",
            )),
            h(Case::get("/handle-groups notuuid", "/handle-groups/x")).ignore("/error/message"),
            // P2b 인박스 「오늘」.
            h(Case::get("/inbox/today/open", "/inbox/today/open")),
            h(Case::get("/inbox/today/done", "/inbox/today/done")),
            h(Case::get(
                "/inbox/today/done limit=1",
                "/inbox/today/done?limit=1",
            )),
            h(Case::get(
                "/inbox/today/done limit=0",
                "/inbox/today/done?limit=0",
            ))
            .ignore("/error/message"),
            h(Case::get(
                "/inbox/today/done limit=51",
                "/inbox/today/done?limit=51",
            ))
            .ignore("/error/message"),
            h(Case::get(
                "/inbox/today/done since=garbage",
                "/inbox/today/done?since=garbage",
            ))
            .ignore("/error/message"),
            h(Case::get("/skills", "/skills")),
            h(Case::get("/skills pending", "/skills?state=pending")),
            h(Case::get("/skills approved", "/skills?state=approved")),
            h(Case::get("/skills disabled", "/skills?state=disabled")),
            h(Case::get("/skills alias 400", "/skills?approved=true")).ignore("/error/message"),
            h(Case::get("/skills bad state", "/skills?state=all")).ignore("/error/message"),
            h(Case::get(
                "/skills dup",
                "/skills?state=pending&state=approved",
            ))
            .ignore("/error/message"),
            h(Case::get("/skills/{slug}", "/skills/used-old")),
            h(Case::get("/skills/{slug} pending", "/skills/pending-one")),
            h(Case::get("/skills/{slug} encoded", "/skills/stale%2Done")),
            h(Case::get("/skills/{slug} missing", "/skills/no-such-skill")),
            h(Case::get(
                "/settings/agent-defaults",
                "/settings/agent-defaults",
            )),
            h(Case::get(
                "/settings/mention-policy",
                "/settings/mention-policy",
            )),
        ]);
        for (team, group) in ids {
            v.extend([
                h(Case::get("/teams/{id}", team)),
                h(Case::get("/handle-groups/{id}", group)),
            ]);
        }
    }
    if let Some(m) = member {
        let h = |c: Case<'a>| c.header("authorization", m);
        v.extend([
            h(Case::get("member /dms", "/dms")),
            h(Case::get("member /accounts", "/accounts")),
            // 권한 판정이 질의 검사보다 먼저 — 잘못된 질의도 403.
            h(Case::get("member /audit", "/audit")),
            h(Case::get("member /audit limit=0", "/audit?limit=0")),
            h(Case::get("member /teams", "/teams")),
            h(Case::get("member /skills", "/skills")),
            h(Case::get(
                "member /settings/mention-policy",
                "/settings/mention-policy",
            )),
            // 권한 판정이 먼저 — 멤버는 집합을 못 읽고(403), 잘못된 id 도 403.
            h(Case::get("member /handle-groups", "/handle-groups")),
            h(Case::get("member /inbox/today/open", "/inbox/today/open")),
            h(Case::get("member /inbox/today/done", "/inbox/today/done")),
            h(Case::get("member /handle-groups/x", "/handle-groups/x")),
            h(Case::get(
                "member /settings/agent-defaults",
                "/settings/agent-defaults",
            )),
        ]);
        for (team, group) in ids {
            v.extend([
                h(Case::get("member /teams/{id}", team)),
                h(Case::get("member /handle-groups/{id}", group)),
            ]);
        }
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
    let ids: Vec<(String, String)> = match (
        std::env::var("HARKROOM_CONTRAST_TEAM_ID"),
        std::env::var("HARKROOM_CONTRAST_GROUP_ID"),
    ) {
        (Ok(t), Ok(g)) => vec![(format!("/teams/{t}"), format!("/handle-groups/{g}"))],
        _ => vec![],
    };
    let cases = cases(admin.as_deref(), member.as_deref(), &ids);
    let diff = contrast(ts.trim_end_matches('/'), rs.trim_end_matches('/'), &cases).await;
    eprintln!("contrast: {} case(s) compared", cases.len());
    assert!(
        diff.is_empty(),
        "TS 와 Rust 의 답이 다르다:\n{}",
        diff.join("\n")
    );
}

/// P2b — `Case` 가 보지 않는 것: ETag 를 서로 바꿔 끼워도 304 인지(태그 재료가 같은지), 그리고 `nextCursor` 로 이어 받기.
#[tokio::test]
async fn inbox_today_etag_and_cursor_cross() {
    let (Ok(ts), Ok(rs), Ok(tok)) = (
        std::env::var("HARKROOM_CONTRAST_TS_URL"),
        std::env::var("HARKROOM_CONTRAST_RS_URL"),
        std::env::var("HARKROOM_CONTRAST_TOKEN"),
    ) else {
        eprintln!("skip: HARKROOM_CONTRAST_TS_URL / HARKROOM_CONTRAST_RS_URL unset");
        return;
    };
    let (ts, rs) = (ts.trim_end_matches('/'), rs.trim_end_matches('/'));
    let auth = format!("Bearer {tok}");
    let mut tokens = vec![auth.clone()];
    if let Ok(m) = std::env::var("HARKROOM_CONTRAST_MEMBER_TOKEN") {
        tokens.push(format!("Bearer {m}"));
    }
    for a in &tokens {
        for path in ["/inbox/today/open", "/inbox/today/done"] {
            let h = [("authorization", a.as_str())];
            let (s1, h1, _) = send(ts, Method::GET, path, &h, "").await;
            let (s2, h2, _) = send(rs, Method::GET, path, &h, "").await;
            assert_eq!((s1.as_u16(), s2.as_u16()), (200, 200), "{path}");
            let e1 = h1
                .get("etag")
                .expect("ts etag")
                .to_str()
                .unwrap()
                .to_string();
            let e2 = h2
                .get("etag")
                .expect("rs etag")
                .to_str()
                .unwrap()
                .to_string();
            assert_eq!(e1, e2, "{path}: 태그가 다르다");
            assert_eq!(
                h1.get("cache-control"),
                h2.get("cache-control"),
                "{path}: cache-control"
            );
            // 교차: TS 의 태그를 Rust 에, Rust 의 태그를 TS 에 — 둘 다 304·본문 없음·같은 머리.
            for (base, tag) in [(rs, &e1), (ts, &e2)] {
                let list = format!("\"zzz\", {tag}");
                for inm in [tag.as_str(), list.as_str()] {
                    let hh = [("authorization", a.as_str()), ("if-none-match", inm)];
                    let (s, hdr, body) = send(base, Method::GET, path, &hh, "").await;
                    assert_eq!(s.as_u16(), 304, "{base}{path} If-None-Match {inm}");
                    assert!(body.is_empty(), "{base}{path}: 304 에 본문");
                    assert_eq!(
                        hdr.get("etag").map(|v| v.to_str().unwrap()),
                        Some(tag.as_str())
                    );
                }
                // 다른 태그면 200.
                let hh = [("authorization", a.as_str()), ("if-none-match", "\"nope\"")];
                assert_eq!(send(base, Method::GET, path, &hh, "").await.0.as_u16(), 200);
            }
        }
    }
    // nextCursor 로 끝까지 이어 받기 — 매 쪽이 같아야 한다.
    let h = [("authorization", auth.as_str())];
    let mut path = "/inbox/today/done?limit=1".to_string();
    let mut pages = 0;
    loop {
        let (s1, h1, t1) = send(ts, Method::GET, &path, &h, "").await;
        let (s2, h2, t2) = send(rs, Method::GET, &path, &h, "").await;
        let (a, b) = (normalize(s1, &h1, &t1, &[]), normalize(s2, &h2, &t2, &[]));
        assert_eq!(a, b, "{path}");
        pages += 1;
        let v: serde_json::Value = serde_json::from_str(&t1).unwrap();
        match v.get("nextCursor").and_then(|c| c.as_str()) {
            Some(c) if pages < 50 => path = format!("/inbox/today/done?limit=1&since={c}"),
            _ => break,
        }
    }
    assert!(
        pages >= 2,
        "이어 받기를 한 번도 안 했다 — 픽스처에 끝난 것이 2개 이상 있어야 한다"
    );
    eprintln!("inbox today cross: {pages} page(s)");
}
