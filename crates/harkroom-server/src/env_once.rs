//! 요청 길에서 읽던 env 스위치를 프로세스에서 한 번만 읽는다(s39 A).
//!
//! 이 값들은 파드가 뜬 뒤 바뀌지 않는다(바꾸려면 매니페스트를 고쳐 다시 띄운다) — 그런데 요청마다 `std::env::var` 로
//! 다시 읽고 있었다(환경 잠금 + 문자열 복사). 여기서 처음 쓸 때 한 번 읽어 쥐고, [`force_all`] 로 기동 때 미리 채운다.
//! 판정 함수(`delegation_v2`·`principal_invoke_enabled` 등)는 그대로 — 값을 어디서 가져오는지만 바뀐다.
use std::sync::LazyLock;

macro_rules! env_once {
    ($($(#[$m:meta])* $name:ident = $key:literal;)*) => {
        $(
            $(#[$m])*
            pub static $name: LazyLock<Option<String>> = LazyLock::new(|| std::env::var($key).ok());
        )*
        /// 기동 때 전부 한 번 읽는다(`routes::router`).
        pub fn force_all() {
            $( LazyLock::force(&$name); )*
        }
    };
}

env_once! {
    /// 위임 v2 스위치(`msg_post::delegation_v2`).
    DELEGATION_V2 = "HARKROOM_DELEGATION_V2";
    /// 서버 쪽 백그라운드 켜짐(`loops::bg::background_enabled`).
    BACKGROUND_ENABLED = "HARKROOM_BACKGROUND_ENABLED";
    /// 원인 제공자 부름 스위치(`mention_calls::principal_invoke_enabled`).
    PRINCIPAL_INVOKE = "HARKROOM_PRINCIPAL_INVOKE";
    /// 위임 묵시 모드(`implicit_delegation::mode`).
    DELEGATION_IMPLICIT = "HARKROOM_DELEGATION_IMPLICIT";
    /// 자기 쪼개기 스위치(`mcp::delegate_gate::self_split_on`).
    SELF_SPLIT = "HARKROOM_SELF_SPLIT";
    /// 위임장 강제(`lease_read::mandate_switch`).
    MANDATE_ENFORCE = "HARKROOM_MANDATE_ENFORCE";
    /// avcs 서버 env 값(빈 값 거르기는 쓰는 쪽이 한다).
    AVCS_BASE_URL = "AVCS_BASE_URL";
    /// 첨부 상한(`attachment_upload::max_bytes_from_env`).
    ATTACHMENT_MAX_BYTES = "ATTACHMENT_MAX_BYTES";
}

/// `Option<&str>` 꼴로 — 기존 판정 함수에 그대로 넘긴다.
pub fn get(v: &'static LazyLock<Option<String>>) -> Option<&'static str> {
    v.as_deref()
}
