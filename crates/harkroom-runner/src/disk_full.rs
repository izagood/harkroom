//! 디스크가 가득 찼을 때의 실패 문장 — 준비 실패가 「스레드 읽기 또는 지시문 파일」로만 보여 원인을 못 찾던 것을 가른다.
//!
//! 판정은 둘 중 하나다: 쓰기 오류가 `StorageFull`(ENOSPC·EDQUOT)이거나, 준비가 실패한 그때 상태 폴더 자리의 여유가
//! [`DISK_FULL_BYTES`] 밑이다. 문장에는 남은 용량만 싣는다 — 경로·오류 원문은 싣지 않는다.
//! 이 문장은 서버로 가는 실패 글에 실린다(네트워크). 디스크에 쓸 자리가 없어도 나간다.

use std::io;
use std::path::Path;

const MIB: u64 = 1024 * 1024;
/// 이 밑이면 준비 실패의 원인을 디스크로 본다. 지시문·세션 기록은 수 MB 면 되지만, 하네스가 뜨면서 쓰는 몫까지 본 값이다.
pub const DISK_FULL_BYTES: u64 = 512 * MIB;

/// 쓰기 오류가 「자리 없음」인가(ENOSPC·EDQUOT).
pub fn is_storage_full(e: &io::Error) -> bool {
    matches!(
        e.kind(),
        io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded
    )
}

/// `path` 가 놓인 자리의 여유(바이트). 아직 없는 경로면 있는 윗폴더로 올라가 잰다.
#[cfg(unix)]
pub fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    path.ancestors().find_map(|p| {
        let c = std::ffi::CString::new(p.as_os_str().as_bytes()).ok()?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return None;
        }
        // 두 칸의 폭이 OS 마다 다르다(u32/u64) — u64 로 올려 곱한다.
        #[allow(clippy::unnecessary_cast)]
        (st.f_bavail as u64).checked_mul(st.f_frsize as u64)
    })
}

#[cfg(not(unix))]
pub fn free_bytes(_path: &Path) -> Option<u64> {
    None
}

/// 사람이 보는 문장. 여유를 못 쟀으면 용량을 뺀다.
pub fn notice(free: Option<u64>) -> String {
    let left = match free {
        Some(b) => format!("(남은 {:.1}GB)", b as f64 / (1024.0 * MIB as f64)),
        None => String::new(),
    };
    format!(
        "디스크가 가득 차 턴을 준비하지 못했다{left} — 이 기기의 디스크를 비운 뒤 다시 불러 주세요"
    )
}

/// 준비 실패의 원인이 디스크면 그 문장. `storage_full` 은 실패한 쓰기가 [`is_storage_full`] 이었는가.
pub fn prepare_failure(free: Option<u64>, storage_full: bool) -> Option<String> {
    (storage_full || free.is_some_and(|b| b < DISK_FULL_BYTES)).then(|| notice(free))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_full_kinds() {
        assert!(is_storage_full(&io::Error::from_raw_os_error(libc::ENOSPC)));
        assert!(is_storage_full(&io::Error::from_raw_os_error(libc::EDQUOT)));
        assert!(!is_storage_full(&io::Error::from_raw_os_error(
            libc::EACCES
        )));
    }

    #[test]
    fn low_free_or_storage_full_names_the_disk() {
        // 넉넉하고 쓰기 오류도 아니면 디스크 탓이 아니다.
        assert_eq!(prepare_failure(Some(100 * 1024 * MIB), false), None);
        assert_eq!(prepare_failure(None, false), None);
        // 여유가 기준 밑.
        let m = prepare_failure(Some(300 * MIB), false).unwrap();
        assert!(
            m.contains("디스크가 가득 차") && m.contains("(남은 0.3GB)"),
            "{m}"
        );
        // 쓰기가 자리 없음으로 실패했으면 여유가 얼마로 읽히든(그 사이 비워졌어도) 디스크다.
        let m = prepare_failure(Some(8 * 1024 * MIB), true).unwrap();
        assert!(m.contains("(남은 8.0GB)"), "{m}");
        // 못 쟀으면 용량 없이.
        let m = prepare_failure(None, true).unwrap();
        assert!(
            m.starts_with("디스크가 가득 차 턴을 준비하지 못했다 —"),
            "{m}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn free_bytes_climbs_to_an_existing_dir() {
        assert!(free_bytes(Path::new("/")).is_some());
        assert!(free_bytes(Path::new("/no/such/dir/for/harkroom/x")).is_some());
    }
}
