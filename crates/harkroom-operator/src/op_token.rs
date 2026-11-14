//! 이 커뮤니티의 오퍼레이터 토큰 한 칸(s9b). 서버 링크(접속할 때)·러너 요청 전달·임대 끝내기·작업 폴더 청소·`/operators/self` 가
//! **쓸 때마다** 여기서 읽는다 — 다시 등록(`operatorRegister`)이 새 토큰을 넣으면 오퍼레이터를 다시 띄우지 않고 다음 요청부터 새 토큰이 간다
//! (TS `startOne`: 토큰이 바뀌면 떠 있던 연결을 내리고 새 토큰으로 다시 붙는다).
//! 값은 `Debug` 에 찍히지 않는다.
use std::sync::{Arc, RwLock};

#[derive(Clone, Default)]
pub struct SharedToken(Arc<RwLock<String>>);

impl SharedToken {
    pub fn new(token: impl Into<String>) -> Self {
        SharedToken(Arc::new(RwLock::new(token.into())))
    }

    /// 지금 값.
    pub fn get(&self) -> String {
        self.0.read().unwrap_or_else(|e| e.into_inner()).clone()
    }

    /// 새 값을 넣는다 — 이 칸을 나눠 가진 모두가 다음 읽기부터 새 값을 본다.
    pub fn set(&self, token: impl Into<String>) {
        *self.0.write().unwrap_or_else(|e| e.into_inner()) = token.into();
    }
}

impl From<String> for SharedToken {
    fn from(t: String) -> Self {
        SharedToken::new(t)
    }
}

impl From<&str> for SharedToken {
    fn from(t: &str) -> Self {
        SharedToken::new(t)
    }
}

impl std::fmt::Debug for SharedToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SharedToken(<redacted>)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clones_share_one_value_and_debug_hides_it() {
        let a = SharedToken::new("old-tok");
        let b = a.clone();
        b.set("new-tok");
        assert_eq!(a.get(), "new-tok");
        assert!(!format!("{a:?}").contains("tok"));
    }
}
