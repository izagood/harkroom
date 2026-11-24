//! 오퍼레이터 박동(`status` 프레임) — 서버 기기 표지가 읽는 지금 값: 도는 턴·동시 턴 상한·메모리·**디스크 여유**.
//!
//! 서버는 `parse_operator_status` 가 허용한 칸만 남긴다. 여기서도 그 칸만 만든다 — 경로·이름·오류 원문은 싣지 않는다.
//! - `turns.running`(필수)·`turns.max`(상한 없음 = null)
//! - `platform`: 서버가 받는 낱말(`darwin`·`linux`·`win32`)로 옮긴다. 그 밖의 OS 는 싣지 않는다.
//! - `memory`·`disk`: `{ totalBytes, freeBytes }`. 못 읽었거나 여유가 전체보다 크면 그 칸만 뗀다(서버도 그렇게 버린다).
//!
//! 디스크는 턴이 쓰는 자리(오퍼레이터 데이터 디렉터리)가 놓인 디스크다 — 없으면 홈. 디스크가 가득 차면 러너가 턴을 준비하지
//! 못하는데, 이 값이 서버에 있어야 「집을 러너 없음」 글이 그 까닭을 적을 수 있다.
//!
//! 주기는 [`BEAT_EVERY`]. 끊겨 있으면 보내지 않는다(`send` 의 false 는 실패가 아니다) — 다시 붙으면 다음 박동이 싣는다.

use crate::device_capacity::{Capacity, disk_usage, measure};
use crate::server_link::ServerLink;
use crate::turn_slots::TurnSlots;
use harkroom_proto::p2::OperatorToServerFrame;
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 박동 주기. 서버는 10초에 한 번만 처리한다 — 그보다 느리게 보낸다.
pub const BEAT_EVERY: Duration = Duration::from_secs(30);

/// 서버가 받는 플랫폼 낱말. 모르는 OS 는 `None`.
pub fn platform_word(os: &str) -> Option<&'static str> {
    match os {
        "macos" => Some("darwin"),
        "linux" => Some("linux"),
        "windows" => Some("win32"),
        _ => None,
    }
}

fn bytes(total: Option<u64>, free: Option<u64>) -> Option<Value> {
    let (total, free) = (total?, free?);
    (free <= total).then(|| json!({ "totalBytes": total, "freeBytes": free }))
}

/// 박동 본문. 순수 함수 — 잰 값만 받는다.
pub fn build(
    started_at: &str,
    os: &str,
    running: usize,
    max: Option<u32>,
    cap: &Capacity,
    disk: Option<(u64, u64)>,
) -> Value {
    let mut out = Map::new();
    out.insert("startedAt".into(), json!(started_at));
    if let Some(p) = platform_word(os) {
        out.insert("platform".into(), json!(p));
    }
    out.insert("turns".into(), json!({ "running": running, "max": max }));
    if let Some(m) = bytes(cap.mem_total, cap.mem_available) {
        out.insert("memory".into(), m);
    }
    if let Some(d) = bytes(disk.map(|d| d.0), disk.map(|d| d.1)) {
        out.insert("disk".into(), d);
    }
    Value::Object(out)
}

/// 디스크를 잴 자리 — 오퍼레이터 데이터 디렉터리, 없으면 홈.
fn disk_paths(home: Option<&Path>) -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(h) = home {
        v.push(h.join(".harkroom-agent"));
        v.push(h.to_path_buf());
    }
    v
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 한 번 재서 본문을 만든다.
pub fn measure_now(started_at: &str, slots: &Mutex<TurnSlots>, home: Option<&Path>) -> Value {
    let (running, max) = match slots.lock() {
        Ok(s) => (s.in_use(), s.max()),
        Err(_) => (0, None),
    };
    let paths = disk_paths(home);
    let refs: Vec<&Path> = paths.iter().map(PathBuf::as_path).collect();
    let cap = measure(&refs);
    let disk = refs.iter().find_map(|p| disk_usage(p));
    build(started_at, std::env::consts::OS, running, max, &cap, disk)
}

/// 박동 스레드. 프로세스가 사는 동안 돈다.
pub fn spawn(link: ServerLink, slots: Arc<Mutex<TurnSlots>>, home: Option<PathBuf>) {
    let started_at = crate::local_merge::iso_from_ms(now_ms());
    std::thread::spawn(move || {
        loop {
            let status = measure_now(&started_at, &slots, home.as_deref());
            let _ = link.send(&OperatorToServerFrame::Status {
                status,
                machine: None,
            });
            std::thread::sleep(BEAT_EVERY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cap(total: Option<u64>, avail: Option<u64>) -> Capacity {
        Capacity {
            mem_total: total,
            mem_available: avail,
            disk_free: None,
        }
    }

    #[test]
    fn carries_turns_memory_and_disk() {
        let v = build(
            "2026-01-01T00:00:00.000Z",
            "macos",
            3,
            Some(8),
            &cap(Some(100), Some(40)),
            Some((1000, 250)),
        );
        assert_eq!(v["startedAt"], "2026-01-01T00:00:00.000Z");
        assert_eq!(v["platform"], "darwin");
        assert_eq!(v["turns"], json!({ "running": 3, "max": 8 }));
        assert_eq!(v["memory"], json!({ "totalBytes": 100, "freeBytes": 40 }));
        assert_eq!(v["disk"], json!({ "totalBytes": 1000, "freeBytes": 250 }));
    }

    #[test]
    fn unread_or_inconsistent_values_drop_only_that_field() {
        let v = build("t", "plan9", 0, None, &cap(Some(10), None), Some((5, 9)));
        assert_eq!(v["turns"], json!({ "running": 0, "max": null }));
        for k in ["platform", "memory", "disk"] {
            assert!(v.get(k).is_none(), "{k}");
        }
        let v = build("t", "linux", 0, None, &cap(None, None), None);
        assert_eq!(v["platform"], "linux");
        assert!(v.get("disk").is_none());
    }

    #[test]
    fn only_allowed_keys_are_sent() {
        let v = build(
            "t",
            "linux",
            1,
            Some(2),
            &cap(Some(2), Some(1)),
            Some((2, 1)),
        );
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(keys, ["disk", "memory", "platform", "startedAt", "turns"]);
    }

    #[test]
    fn measures_the_disk_under_a_real_directory() {
        let dir = std::env::temp_dir();
        let slots = Mutex::new(TurnSlots::new(Some(4), || 0, |_| {}));
        let v = measure_now("t", &slots, Some(&dir));
        assert_eq!(v["turns"], json!({ "running": 0, "max": 4 }));
        #[cfg(unix)]
        {
            let d = &v["disk"];
            assert!(d["freeBytes"].as_u64().unwrap() <= d["totalBytes"].as_u64().unwrap());
        }
    }
}
