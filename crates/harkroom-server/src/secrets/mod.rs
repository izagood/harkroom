//! 비밀 보관소의 값 열기(S5.3, Rust 전환). TS 정본은 `packages/server/src/services/secretKeyring.ts`(v2 봉투·키 디렉터리)와
//! `secretLeakGuard.ts`(에이전트 글 속 비밀 값 찾기)다.
//!
//! **아직 어디에도 붙이지 않는다** — 붙이는 것은 푸시 루프(C5e-2)·MCP 본문 거절에서 따로 한다. 그래서 시험 밖에서는
//! 쓰는 곳이 없고 `dead_code` 를 끈다(붙이는 PR 에서 그 줄을 지운다).
//!
//! 지키는 것:
//! - 마스터 키·비밀 값은 `Zeroizing` 에만 두고, 키를 담은 타입의 `Debug` 는 손으로 짜서 kid 만 보인다. 오류 글귀에는 파일 이름·
//!   kid 만 싣는다.
//! - TS 와 같은 입력에서 같은 판정이 나오는지는 `golden/secret_keyring.json`·`secret_leak.json`(TS 가 만든 결과, 생성은
//!   `packages/server/scripts/genRustSecretGolden.ts`)으로 대조한다. Rust 가 일부러 더 엄격한 곳(「의도된 차이」)은 골든에
//!   `intended` 로 표시한다: 봉투 칸의 표준 base64 하나.
mod js;
pub(crate) mod keyring;
pub(crate) mod leak;
pub(crate) mod secret_box;
pub(crate) mod verify;

#[cfg(test)]
mod golden;
