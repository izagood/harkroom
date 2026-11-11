//! 키·토큰을 쓴 뒤 메모리에서 0 으로 지운다(#1881 정리). 새 의존 없이 `write_volatile` + `compiler_fence` 로
//! 최적화가 지우기를 없애지 못하게 한다. 복사본(재할당 전 버퍼·라이브러리 안쪽)까지 지우지는 못한다 — 남는 수명을 줄이는 것이다.
use std::sync::atomic::{Ordering, compiler_fence};

/// 바이트를 0 으로 덮는다.
pub fn wipe_bytes(b: &mut [u8]) {
    for x in b.iter_mut() {
        // SAFETY: `x` 는 살아 있는 `&mut u8` 이다.
        unsafe { std::ptr::write_volatile(x, 0) };
    }
    compiler_fence(Ordering::SeqCst);
}

/// 문자열을 0 으로 덮고 비운다. 0 바이트는 올바른 UTF-8 이라 덮는 사이에도 `String` 불변식이 깨지지 않는다.
pub fn wipe_string(s: &mut String) {
    // SAFETY: 0 으로만 덮으므로 UTF-8 이 유지된다.
    wipe_bytes(unsafe { s.as_bytes_mut() });
    s.clear();
}

/// 버려질 때 0 으로 지워지는 문자열.
#[derive(Default)]
pub struct WipedString(pub String);

impl Drop for WipedString {
    fn drop(&mut self) {
        wipe_string(&mut self.0);
    }
}

impl std::ops::Deref for WipedString {
    type Target = String;
    fn deref(&self) -> &String {
        &self.0
    }
}

impl std::ops::DerefMut for WipedString {
    fn deref_mut(&mut self) -> &mut String {
        &mut self.0
    }
}

/// 버려질 때 값을 0 으로 지우는 헤더 목록(`authorization` 등 키가 든 칸).
#[derive(Default)]
pub struct WipedHeaders(pub Vec<(String, String)>);

impl Drop for WipedHeaders {
    fn drop(&mut self) {
        for (_, v) in self.0.iter_mut() {
            wipe_string(v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wipe_string_zeroes_the_buffer_in_place() {
        let mut s = String::from("sk-secret-value");
        let ptr = s.as_ptr();
        let len = s.len();
        wipe_string(&mut s);
        assert!(s.is_empty());
        // 비운 뒤에도 할당은 그대로다 — 그 자리가 0 인지 본다.
        let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
        assert!(bytes.iter().all(|&b| b == 0));
    }

    #[test]
    fn wipe_bytes_zeroes() {
        let mut v = b"token".to_vec();
        wipe_bytes(&mut v);
        assert_eq!(v, vec![0; 5]);
    }
}
