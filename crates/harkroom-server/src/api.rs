//! 서버 ↔ UI 경계(P6) 의 응답 타입. 정본은 여기(Rust)이고, UI 용 TS 는 ts-rs 가 `packages/shared/src/generated/` 에 쓴다.
//!
//! `cargo test` 가 생성 파일을 다시 쓰고, CI(`Rust crates`)는 그 뒤 `git diff` 로 커밋된 것과 다르면 실패한다 —
//! 타입을 고치고 생성 파일을 안 올리면 PR 이 막힌다. 라우트를 Rust 로 옮길 때(S5.2) 그 묶음의 응답 타입을 여기 더한다.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// `#[ts(export)]`(환경 변수 `TS_RS_*` 를 읽는 자동 시험)는 쓰지 않는다 — 누가 어디서 돌려도 같은 파일이 나오도록
/// 아래 `p6_bindings` 시험이 설정을 고정해 직접 쓴다. 새 타입은 `p6!` 로 감싸고 `p6_bindings` 의 목록에 더한다.
macro_rules! p6 {
    ($item:item) => {
        #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
        $item
    };
}

p6! {
/// 오류 응답 본문 — TS 서버와 같은 `{ error: { code, message } }` 꼴.
pub struct ApiErrorBody {
    pub error: ApiErrorDetail,
}
}

p6! {
/// 오류의 기계용 코드(`unauthorized`·`forbidden` …)와 사람용 문구.
pub struct ApiErrorDetail {
    pub code: String,
    pub message: String,
}
}

#[cfg(test)]
mod p6_bindings {
    use super::*;
    use std::fmt::Write as _;
    use std::path::PathBuf;
    use ts_rs::Config;

    /// 생성 파일을 다시 쓴다. CI 는 이 시험 뒤 `git status --porcelain packages/shared/src/generated` 가 비어 있어야 통과한다.
    #[test]
    fn write_generated_ts() {
        let dir =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/shared/src/generated");
        // NodeNext 라 import 에 `.js` 가 있어야 하고, JSON 숫자는 bigint 가 아니다.
        let cfg = Config::new()
            .with_out_dir(&dir)
            .with_import_extension(Some("js"))
            .with_large_int("number");
        // 지운 타입의 파일이 남지 않게 비우고 다시 쓴다.
        if dir.exists() {
            for e in std::fs::read_dir(&dir).unwrap() {
                let p = e.unwrap().path();
                if p.extension().is_some_and(|x| x == "ts") {
                    std::fs::remove_file(p).unwrap();
                }
            }
        }
        ApiErrorBody::export_all(&cfg).unwrap();
        ApiErrorDetail::export_all(&cfg).unwrap();

        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| {
                let n = e.unwrap().file_name().into_string().unwrap();
                n.strip_suffix(".ts").map(str::to_owned)
            })
            .collect();
        names.sort();
        let mut index = String::from(
            "// 생성 파일 — `crates/harkroom-server/src/api.rs` 를 고치고 `cargo test` 로 다시 쓴다. 손으로 고치지 마라.\n",
        );
        for n in names {
            writeln!(index, "export type * from './{n}.js';").unwrap();
        }
        std::fs::write(dir.join("index.ts"), index).unwrap();
    }
}
