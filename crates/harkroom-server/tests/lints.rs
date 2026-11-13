//! 로컬 clippy 가 CI(1.99)보다 낮으면 `clippy::result_large_err` 를 못 잡는다 — P0·P1·P3 에서 세 번 CI 를 빨갛게 했다.
//! 이 crate 의 관례(`Result<_, Response>` 를 돌려주는 함수는 거절이 곧 axum 응답이라 `#[allow(clippy::result_large_err)]` 를 단다)를
//! 툴체인과 상관없이 `cargo test` 에서 본다. 트레잇 구현(`from_request_parts`)은 clippy 가 보지 않으므로 뺀다.
use std::path::Path;

#[test]
fn functions_returning_result_response_allow_result_large_err() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut missing = vec![];
    for e in std::fs::read_dir(&dir).unwrap() {
        let p = e.unwrap().path();
        if p.extension().is_none_or(|x| x != "rs") {
            continue;
        }
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
                missing.push(format!(
                    "{}:{}",
                    p.file_name().unwrap().to_string_lossy(),
                    i + 1
                ));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "#[allow(clippy::result_large_err)] 이 없는 Result<_, Response> 함수: {missing:?}"
    );
}
