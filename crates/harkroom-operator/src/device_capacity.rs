//! 기기 자원으로 동시 턴 상한을 정한다(I0) — `HARKROOM_MAX_TURNS` 가 없을 때의 길.
//!
//! 고정값을 두지 않는다. 기기마다 메모리·디스크가 달라서, 한 숫자는 작은 기기에서는 바닥을 내고 큰 기기에서는 놀린다.
//!
//! 계산([`decide`]):
//! - 천장 = 전체 메모리의 절반 ÷ 턴 하나 메모리([`TURN_MEM_BYTES`]). 기기가 바뀌지 않는 한 그대로다.
//! - 지금 더 띄울 수 있는 수 = (가용 메모리 − 남겨 둘 몫) ÷ 턴 하나 메모리, (디스크 여유 − 남겨 둘 몫) ÷ 턴 하나 디스크.
//! - 상한 = min(천장, 도는 턴 + 더 띄울 수 있는 수) 를 [`MIN_TURNS`]..=[`MAX_TURNS_CAP`] 로 자른다.
//!
//! 「도는 턴 + 여유」로 세는 까닭: 가용 메모리는 이미 도는 턴이 쓴 뒤의 값이다. 여유만으로 상한을 잡으면 턴이 돌수록
//! 상한이 내려가 도는 턴 수 밑으로 떨어진다.
//!
//! 읽는 곳 — 새 의존성 없이 libc 만 쓴다:
//! - macOS: `hw.memsize`(전체), `kern.memorystatus_level`(가용 비율 %, 메모리 압박 판정이 쓰는 값 — 압축·캐시를 반영한다).
//! - 리눅스: `/proc/meminfo` 의 `MemTotal`·`MemAvailable`. cgroup 한도는 보지 않는다.
//! - 디스크: `statvfs` 의 `f_bavail × f_frsize`(둘 다 같다).
//!
//! 못 읽은 값은 제약에서 빠진다. 전체 메모리를 못 읽으면 천장은 [`FALLBACK_TURNS`] 다.

use std::path::Path;

const MIB: u64 = 1024 * 1024;
const GIB: u64 = 1024 * MIB;

/// 턴 하나가 쓰는 메모리. 실측: macOS arm64 에서 도는 claude 턴 프로세스 3개의 RSS 가 408·435·457MB 였다(2026-11).
/// 턴 MCP·도구 자식 프로세스 몫을 얹어 512MB 로 올려 잡는다. 빌드처럼 무거운 도구는 턴마다 달라 여기 넣지 않고,
/// 가용 메모리를 다시 재는 것으로 받는다.
pub const TURN_MEM_BYTES: u64 = 512 * MIB;
/// 턴들이 쓸 수 있는 전체 메모리의 몫(1/N). 나머지는 OS·앱·사람이 쓰는 프로그램 몫이다.
pub const MEM_SHARE_DIV: u64 = 2;
/// 가용 메모리에서 남겨 둘 몫(전체의 1/N). 전체를 못 읽으면 [`MEM_RESERVE_FALLBACK`].
pub const MEM_RESERVE_DIV: u64 = 8;
pub const MEM_RESERVE_FALLBACK: u64 = GIB;
/// 턴 하나가 쓰는 디스크 — 실측이 아니라 어림값이다(세션 기록·턴 워크스페이스·받은 첨부).
pub const TURN_DISK_BYTES: u64 = GIB;
/// 디스크 여유에서 남겨 둘 몫 — 이 밑이면 새 턴을 더 받지 않는다(하한까지는 받는다).
pub const DISK_RESERVE_BYTES: u64 = 5 * GIB;
/// 하한 — 자원이 바닥이어도 사람이 부른 턴 하나와 그 턴이 부른 턴 하나는 돈다.
pub const MIN_TURNS: u32 = 2;
/// 너무 큰 값의 상한 — 메모리가 아무리 커도 이 위로는 안 간다(계정 한도·API 속도가 먼저 걸린다).
pub const MAX_TURNS_CAP: u32 = 32;
/// 전체 메모리를 못 읽은 기기의 천장.
pub const FALLBACK_TURNS: u32 = 4;

/// 한 번 잰 값. 못 읽은 칸은 `None`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Capacity {
    pub mem_total: Option<u64>,
    pub mem_available: Option<u64>,
    pub disk_free: Option<u64>,
}

/// 상한을 누른 것 — 로그에 적는다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Bound {
    MemTotal,
    MemAvailable,
    DiskFree,
    Floor,
    Cap,
    Unknown,
}

impl Bound {
    fn label(self) -> &'static str {
        match self {
            Bound::MemTotal => "전체 메모리",
            Bound::MemAvailable => "가용 메모리",
            Bound::DiskFree => "디스크 여유",
            Bound::Floor => "하한",
            Bound::Cap => "최대값",
            Bound::Unknown => "메모리를 못 읽음",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Decision {
    pub limit: u32,
    pub bound: Bound,
}

fn turns(bytes: u64, per_turn: u64) -> u32 {
    u32::try_from(bytes / per_turn).unwrap_or(u32::MAX)
}

/// 지금 도는 턴이 `in_use` 개일 때의 상한.
pub fn decide(cap: &Capacity, in_use: usize) -> Decision {
    let in_use = u32::try_from(in_use).unwrap_or(u32::MAX);
    let (mut limit, mut bound) = match cap.mem_total {
        Some(t) => (turns(t / MEM_SHARE_DIV, TURN_MEM_BYTES), Bound::MemTotal),
        None => (FALLBACK_TURNS, Bound::Unknown),
    };
    if let Some(avail) = cap.mem_available {
        let reserve = cap
            .mem_total
            .map_or(MEM_RESERVE_FALLBACK, |t| t / MEM_RESERVE_DIV);
        let n = in_use.saturating_add(turns(avail.saturating_sub(reserve), TURN_MEM_BYTES));
        if n < limit {
            (limit, bound) = (n, Bound::MemAvailable);
        }
    }
    if let Some(free) = cap.disk_free {
        let n = in_use.saturating_add(turns(
            free.saturating_sub(DISK_RESERVE_BYTES),
            TURN_DISK_BYTES,
        ));
        if n < limit {
            (limit, bound) = (n, Bound::DiskFree);
        }
    }
    if limit < MIN_TURNS {
        (limit, bound) = (MIN_TURNS, Bound::Floor);
    } else if limit > MAX_TURNS_CAP {
        (limit, bound) = (MAX_TURNS_CAP, Bound::Cap);
    }
    Decision { limit, bound }
}

fn gb(v: Option<u64>) -> String {
    match v {
        Some(b) => format!("{:.1}GB", b as f64 / GIB as f64),
        None => "모름".to_string(),
    }
}

/// 로그 한 줄 — 「동시 턴 상한: N (메모리 전체 …·가용 …, 디스크 여유 …, 도는 턴 …, 기준 …)」.
pub fn describe(d: &Decision, cap: &Capacity, in_use: usize) -> String {
    format!(
        "동시 턴 상한: {} (메모리 전체 {}·가용 {}, 디스크 여유 {}, 도는 턴 {}, 기준 {})",
        d.limit,
        gb(cap.mem_total),
        gb(cap.mem_available),
        gb(cap.disk_free),
        in_use,
        d.bound.label(),
    )
}

/// `/proc/meminfo` 에서 (MemTotal, MemAvailable) 바이트. 값은 kB 로 적혀 있다.
pub fn parse_meminfo(text: &str) -> (Option<u64>, Option<u64>) {
    let field = |name: &str| {
        text.lines().find_map(|l| {
            let rest = l.strip_prefix(name)?.strip_prefix(':')?;
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            kb.checked_mul(1024)
        })
    };
    (field("MemTotal"), field("MemAvailable"))
}

#[cfg(target_os = "macos")]
fn sysctl_u64(name: &std::ffi::CStr) -> Option<u64> {
    let mut buf = [0u8; 8];
    let mut len = buf.len();
    // 값은 4바이트(int) 또는 8바이트다 — 커널이 len 에 쓴 길이로 가른다.
    let rc = unsafe {
        libc::sysctlbyname(
            name.as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    match len {
        4 => Some(u64::from(u32::from_ne_bytes([
            buf[0], buf[1], buf[2], buf[3],
        ]))),
        8 => Some(u64::from_ne_bytes(buf)),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn memory() -> (Option<u64>, Option<u64>) {
    let total = sysctl_u64(c"hw.memsize").filter(|t| *t > 0);
    let level = sysctl_u64(c"kern.memorystatus_level").filter(|l| *l <= 100);
    let available = total.zip(level).map(|(t, l)| t / 100 * l);
    (total, available)
}

#[cfg(target_os = "linux")]
fn memory() -> (Option<u64>, Option<u64>) {
    match std::fs::read_to_string("/proc/meminfo") {
        Ok(text) => parse_meminfo(&text),
        Err(_) => (None, None),
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn memory() -> (Option<u64>, Option<u64>) {
    (None, None)
}

#[cfg(unix)]
fn disk_free(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    // 두 칸의 폭이 OS 마다 다르다(u32/u64) — u64 로 올려 곱한다.
    #[allow(clippy::unnecessary_cast)]
    (st.f_bavail as u64).checked_mul(st.f_frsize as u64)
}

#[cfg(not(unix))]
fn disk_free(_path: &Path) -> Option<u64> {
    None
}

/// 지금 값을 잰다. 디스크는 `disk_paths` 중 처음 읽히는 자리의 여유다(턴이 쓰는 자리 → 홈 순으로 준다).
pub fn measure(disk_paths: &[&Path]) -> Capacity {
    let (mem_total, mem_available) = memory();
    Capacity {
        mem_total,
        mem_available,
        disk_free: disk_paths.iter().find_map(|p| disk_free(p)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(total_gb: u64, avail_gb: u64, disk_gb: u64) -> Capacity {
        Capacity {
            mem_total: Some(total_gb * GIB),
            mem_available: Some(avail_gb * GIB),
            disk_free: Some(disk_gb * GIB),
        }
    }

    #[test]
    fn ceiling_follows_total_memory() {
        // 넉넉한 기기: 전체의 절반 ÷ 512MB.
        for (total, want) in [(8, 8), (16, 16), (24, 24)] {
            let d = decide(&cap(total, total, 500), 0);
            assert_eq!((d.limit, d.bound), (want, Bound::MemTotal), "{total}GB");
        }
        // 큰 기기는 최대값에서 멈춘다.
        let d = decide(&cap(128, 128, 500), 0);
        assert_eq!((d.limit, d.bound), (MAX_TURNS_CAP, Bound::Cap));
    }

    #[test]
    fn low_available_memory_holds_new_turns_but_keeps_running_ones() {
        // 16GB 기기, 가용 3GB: 남겨 둘 2GB 를 빼면 1GB → 2개 더.
        let c = cap(16, 3, 500);
        let d = decide(&c, 5);
        assert_eq!((d.limit, d.bound), (7, Bound::MemAvailable));
        // 가용이 남겨 둘 몫 밑이면 도는 수에서 멈춘다 — 도는 턴 밑으로는 안 내려간다.
        let d = decide(&cap(16, 1, 500), 5);
        assert_eq!((d.limit, d.bound), (5, Bound::MemAvailable));
        // 아무것도 안 도는데 바닥이면 하한.
        let d = decide(&cap(16, 1, 500), 0);
        assert_eq!((d.limit, d.bound), (MIN_TURNS, Bound::Floor));
    }

    #[test]
    fn low_disk_holds_new_turns() {
        let d = decide(&cap(16, 16, 8), 1);
        assert_eq!((d.limit, d.bound), (4, Bound::DiskFree));
        let d = decide(&cap(16, 16, 2), 3);
        assert_eq!((d.limit, d.bound), (3, Bound::DiskFree));
        let d = decide(&cap(16, 16, 2), 0);
        assert_eq!((d.limit, d.bound), (MIN_TURNS, Bound::Floor));
    }

    #[test]
    fn unreadable_values_do_not_constrain() {
        let d = decide(&Capacity::default(), 0);
        assert_eq!((d.limit, d.bound), (FALLBACK_TURNS, Bound::Unknown));
        let only_total = Capacity {
            mem_total: Some(16 * GIB),
            ..Capacity::default()
        };
        assert_eq!(decide(&only_total, 9).limit, 16);
        // 전체를 못 읽어도 가용·디스크는 누른다.
        let no_total = Capacity {
            mem_total: None,
            mem_available: Some(GIB + 512 * MIB),
            disk_free: None,
        };
        let d = decide(&no_total, 2);
        assert_eq!((d.limit, d.bound), (3, Bound::MemAvailable));
        // 아주 작은 기기도 하한은 받는다.
        assert_eq!(decide(&cap(1, 1, 500), 0).limit, MIN_TURNS);
    }

    #[test]
    fn meminfo_is_read_in_kb() {
        let text = "MemTotal:       16314180 kB\nMemFree:          219184 kB\nMemAvailable:    9120304 kB\nSwapTotal: 0 kB\n";
        assert_eq!(
            parse_meminfo(text),
            (Some(16_314_180 * 1024), Some(9_120_304 * 1024))
        );
        // 옛 커널에는 MemAvailable 이 없다.
        assert_eq!(
            parse_meminfo("MemTotal: 1024 kB\n"),
            (Some(1024 * 1024), None)
        );
        assert_eq!(parse_meminfo("garbage"), (None, None));
    }

    #[test]
    fn describe_names_the_inputs() {
        let c = cap(24, 19, 140);
        let line = describe(&decide(&c, 3), &c, 3);
        assert_eq!(
            line,
            "동시 턴 상한: 24 (메모리 전체 24.0GB·가용 19.0GB, 디스크 여유 140.0GB, 도는 턴 3, 기준 전체 메모리)"
        );
        let line = describe(&decide(&Capacity::default(), 0), &Capacity::default(), 0);
        assert!(line.contains("메모리 전체 모름·가용 모름, 디스크 여유 모름"));
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    #[test]
    fn this_device_is_measurable() {
        let c = measure(&[Path::new("/")]);
        let total = c.mem_total.expect("mem_total");
        let avail = c.mem_available.expect("mem_available");
        assert!(total >= 256 * MIB && avail <= total);
        assert!(c.disk_free.is_some());
        // 없는 자리는 다음 자리로 넘어간다.
        let c = measure(&[Path::new("/no/such/dir/for/harkroom"), Path::new("/")]);
        assert!(c.disk_free.is_some());
        eprintln!("{}", describe(&decide(&c, 0), &c, 0));
    }
}
