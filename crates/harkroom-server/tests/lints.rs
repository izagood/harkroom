//! 로컬 clippy 가 CI(1.99)보다 낮으면 `clippy::result_large_err` 를 못 잡는다 — P0·P1·P3 에서 세 번 CI 를 빨갛게 했다.
//! 이 crate 의 관례(`Result<_, Response>` 를 돌려주는 함수는 거절이 곧 axum 응답이라 `#[allow(clippy::result_large_err)]` 를 단다)를
//! 툴체인과 상관없이 `cargo test` 에서 본다. 트레잇 구현(`from_request_parts`)은 clippy 가 보지 않으므로 뺀다.
use std::path::{Path, PathBuf};

/// `src` 아래 `.rs` 전부(하위 폴더 포함 — `core/` 도 본다).
fn sources(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    for e in std::fs::read_dir(dir).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() {
            out.extend(sources(&p));
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
    out.sort();
    out
}

fn rel(p: &Path) -> String {
    p.strip_prefix(Path::new(env!("CARGO_MANIFEST_DIR")).join("src"))
        .unwrap_or(p)
        .to_string_lossy()
        .into_owned()
}

#[test]
fn functions_returning_result_response_allow_result_large_err() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut missing = vec![];
    for p in sources(&dir) {
        let text = std::fs::read_to_string(&p).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        for (i, l) in lines.iter().enumerate() {
            let returns = l.contains("-> Result<") && l.contains("Response>");
            if !returns || l.contains("from_request_parts") {
                continue;
            }
            // 함수 머리(`fn `)를 찾아 그 위 몇 줄(속성·문서)에 allow 가 있는지 본다.
            let start = (0..=i)
                .rev()
                .find(|&j| lines[j].contains("fn "))
                .unwrap_or(i);
            let from = start.saturating_sub(6);
            if !lines[from..=start]
                .iter()
                .any(|x| x.contains("allow(clippy::result_large_err)"))
            {
                missing.push(format!("{}:{}", rel(&p), i + 1));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "#[allow(clippy::result_large_err)] 이 없는 Result<_, Response> 함수: {missing:?}"
    );
}

/// 코어(`src/core/`)의 HTTP 줄은 `route_table::Table` 로만 붙인다 — 그래야 앞단 기동 기록(`front: rust core routes`)에 실려
/// CI 의 일반 CORS 대조(`packages/server/test/rustFrontDb.test.ts`)가 그 줄을 TS 와 맞춰 본다. axum 의 `.route(` 등으로 직접
/// 붙이면 목록에서 빠지고 대조가 그 줄을 못 본다(11-14 CORS 빠짐 두 번 — #2120·#2127). 소켓 줄도 `Table::socket` 으로 붙인다.
/// 정말 직접 붙여야 하는 줄이 생기면 `ALLOW` 에 `파일:줄 내용 조각` 과 까닭을 적는다(지금은 없음).
#[test]
fn core_routes_are_mounted_through_the_route_table() {
    const ALLOW: &[&str] = &[];
    const BANNED: &[&str] = &[
        ".route(",
        ".route_service(",
        ".nest(",
        ".nest_service(",
        ".fallback(",
        ".fallback_service(",
    ];
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("core");
    let mut found = vec![];
    for p in sources(&dir) {
        let text = std::fs::read_to_string(&p).unwrap();
        for (i, l) in text.lines().enumerate() {
            let code = l.split("//").next().unwrap_or("");
            if BANNED.iter().any(|b| code.contains(b)) {
                let hit = format!(
                    "core/{}:{}: {}",
                    rel(&p).trim_start_matches("core/"),
                    i + 1,
                    l.trim()
                );
                if !ALLOW.iter().any(|a| hit.contains(a)) {
                    found.push(hit);
                }
            }
        }
    }
    assert!(
        found.is_empty(),
        "core/ 에서 route_table::Table 을 거치지 않고 붙인 줄(CORS 대조 목록에서 빠짐): {found:#?}"
    );
}
