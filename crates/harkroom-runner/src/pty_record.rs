//! PTY 원시 출력 녹화(기본 꺼짐, S3 B3b-2a). 정본은 `packages/agent/src/ptyRecorder.ts` — 형식(asciicast v2)·남기지
//! 않는 것(입력·명령·인자·환경)·실패 규율(녹화만 멈추고 턴은 산다)은 정본 머리 주석이 정본이다.
//!
//! 이식에서 달라진 점(security B3b-2 요구 — 파일 권한·위치·지우기):
//! - **위치**: 절대 경로만. 폴더는 0700 으로 만들고, 이미 있던 폴더라도 **심볼릭 링크이거나 남의 것이면 열지 않는다**.
//! - **파일**: 0600·`create_new`(O_EXCL)·`O_NOFOLLOW` — 같은 이름의 링크로 다른 파일에 쓰게 할 수 없다.
//! - **지우기**: 열 때 이 폴더의 `*.cast` 중 새것 [`PTY_RECORD_KEEP`] 개만 남기고 지운다(정본은 지우지 않았다).
//! - 정본은 node-pty 가 디코드한 문자열을 적는다. 여기는 바이트를 받으므로 청크 경계에서 잘린 UTF-8 은 다음 청크로
//!   넘겨 이어 디코드한다 — 같은 화면 판정 입력이 되게.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::Path;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};

/// 파일 하나의 상한(정본 `PTY_RECORD_MAX_BYTES`).
pub const PTY_RECORD_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// 폴더에 남길 녹화 수 — 열 때 넘친 옛것부터 지운다. 32MB × 50 = 최대 1.6GB.
pub const PTY_RECORD_KEEP: usize = 50;

fn safe_label(label: &str) -> String {
    let s: String = label
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(40)
        .collect();
    if s.is_empty() { "pty".into() } else { s }
}

/// `2026-11-11T16-33-50-123Z` — 정본의 `toISOString().replace(/[:.]/g, '-')`.
fn stamp(ms: u128) -> String {
    let secs = (ms / 1000) as i64;
    let (days, sod) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // civil_from_days(Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}-{:03}Z",
        sod / 3600,
        sod % 3600 / 60,
        sod % 60,
        ms % 1000
    )
}

fn dir_is_safe(dir: &Path) -> bool {
    match fs::symlink_metadata(dir) {
        // SAFETY: geteuid 는 실패하지 않는다.
        Ok(m) => m.file_type().is_dir() && m.uid() == unsafe { libc::geteuid() },
        Err(_) => false,
    }
}

/// 이 폴더의 `*.cast` 정규 파일 중 새것 `keep` 개만 남긴다. 이름 앞이 시각이라 이름순이 시간순이다.
fn prune(dir: &Path, keep: usize) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut casts: Vec<_> = rd
        .filter_map(Result::ok)
        .filter(|e| e.file_name().to_string_lossy().ends_with(".cast"))
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    if casts.len() <= keep {
        return;
    }
    casts.sort();
    for p in &casts[..casts.len() - keep] {
        let _ = fs::remove_file(p);
    }
}

pub struct PtyRecorder {
    file: Option<File>,
    written: u64,
    started: Instant,
    /// 앞 청크 끝에서 잘린 UTF-8 조각(최대 3바이트).
    carry: Vec<u8>,
}

impl PtyRecorder {
    /// `dir` 아래에 녹화 파일 하나를 연다(정본 `openPtyRecorder`). 꺼짐·안전하지 않은 폴더·열기 실패면 None.
    pub fn open(dir: Option<&Path>, label: &str, cols: u16, rows: u16) -> Option<Self> {
        let dir = dir.filter(|d| d.is_absolute())?;
        let mut b = fs::DirBuilder::new();
        b.recursive(true);
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
        b.create(dir).ok()?;
        if !dir_is_safe(dir) {
            return None;
        }
        // 0700 보다 넓게 열린 폴더면 좁힌다(다른 사용자가 목록을 보지 못하게).
        if let Ok(m) = fs::metadata(dir)
            && m.permissions().mode() & 0o077 != 0
        {
            let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        }
        prune(dir, PTY_RECORD_KEEP.saturating_sub(1));
        let now = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
        let name = format!(
            "{}-{}-{}.cast",
            stamp(now.as_millis()),
            safe_label(label),
            std::process::id()
        );
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(dir.join(name))
            .ok()?;
        let mut r = Self {
            file: Some(file),
            written: 0,
            started: Instant::now(),
            carry: Vec::new(),
        };
        r.line(&json!({
            "version": 2,
            "width": cols,
            "height": rows,
            "timestamp": now.as_secs(),
            "env": { "TERM": "xterm-256color" },
        }));
        Some(r)
    }

    fn elapsed(&self) -> f64 {
        (self.started.elapsed().as_millis() as f64).round() / 1000.0
    }

    fn line(&mut self, v: &Value) {
        let Some(f) = self.file.as_mut() else { return };
        let mut buf = v.to_string().into_bytes();
        buf.push(b'\n');
        if self.written + buf.len() as u64 > PTY_RECORD_MAX_BYTES {
            self.close();
            return;
        }
        if f.write_all(&buf).is_ok() {
            self.written += buf.len() as u64;
        } else {
            self.close();
        }
    }

    pub fn output(&mut self, chunk: &[u8]) {
        if self.file.is_none() {
            return;
        }
        let mut bytes = std::mem::take(&mut self.carry);
        bytes.extend_from_slice(chunk);
        let text = match std::str::from_utf8(&bytes) {
            Ok(s) => s.to_string(),
            Err(e) if e.error_len().is_none() => {
                // 끝이 잘린 문자 — 그 조각은 다음 청크와 잇는다.
                let ok = e.valid_up_to();
                self.carry = bytes[ok..].to_vec();
                String::from_utf8_lossy(&bytes[..ok]).into_owned()
            }
            Err(_) => String::from_utf8_lossy(&bytes).into_owned(),
        };
        if text.is_empty() {
            return;
        }
        let t = self.elapsed();
        self.line(&json!([t, "o", text]));
    }

    pub fn resize(&mut self, cols: u16, rows: u16) {
        let t = self.elapsed();
        self.line(&json!([t, "r", format!("{cols}x{rows}")]));
    }

    pub fn mark(&mut self, data: &Value) {
        let t = self.elapsed();
        self.line(&json!([t, "m", data.to_string()]));
    }

    pub fn close(&mut self) {
        self.file = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stamp_matches_iso_with_dashes() {
        // 2026-11-11T16:33:50.123Z
        assert_eq!(stamp(1_794_414_830_123), "2026-11-11T16-33-50-123Z");
        assert_eq!(stamp(0), "1970-01-01T00-00-00-000Z");
    }

    #[test]
    fn safe_label_strips_path_chars() {
        assert_eq!(safe_label("../claude"), "___claude");
        assert_eq!(safe_label(""), "pty");
    }

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("hk-rec-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn only_cast(dir: &Path) -> std::path::PathBuf {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.path())
            .find(|p| p.extension().is_some_and(|x| x == "cast"))
            .unwrap()
    }

    #[test]
    fn writes_asciicast_with_0600_file_and_0700_dir_and_joins_split_utf8() {
        let d = tmp("ok").join("nested");
        let mut r = PtyRecorder::open(Some(&d), "/usr/bin/claude", 120, 40).unwrap();
        let han = "한".as_bytes();
        r.output(&han[..2]);
        r.output(&[&han[2..], b"!".as_slice()].concat());
        r.resize(80, 24);
        r.mark(&json!({"k": "ready"}));
        r.close();
        r.output(b"after-close");
        let f = only_cast(&d);
        assert_eq!(
            fs::metadata(&f).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&d).unwrap().permissions().mode() & 0o777,
            0o700
        );
        let body = fs::read_to_string(&f).unwrap();
        let lines: Vec<Value> = body
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(lines[0]["version"], 2);
        assert_eq!(lines[0]["width"], 120);
        assert!(lines[0].get("command").is_none());
        assert_eq!(lines[1][1], "o");
        assert_eq!(lines[1][2], "한!");
        assert_eq!(lines[2][2], "80x24");
        assert_eq!(lines[3][2], "{\"k\":\"ready\"}");
        assert_eq!(lines.len(), 4);
        let _ = fs::remove_dir_all(d.parent().unwrap());
    }

    #[test]
    fn refuses_relative_dir_and_symlinked_dir() {
        assert!(PtyRecorder::open(Some(Path::new("rel")), "x", 1, 1).is_none());
        assert!(PtyRecorder::open(None, "x", 1, 1).is_none());
        let base = tmp("link");
        fs::create_dir_all(base.join("real")).unwrap();
        std::os::unix::fs::symlink(base.join("real"), base.join("ln")).unwrap();
        assert!(PtyRecorder::open(Some(&base.join("ln")), "x", 1, 1).is_none());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn prunes_to_keep_newest_casts_only() {
        let d = tmp("prune");
        fs::create_dir_all(&d).unwrap();
        for i in 0..PTY_RECORD_KEEP + 5 {
            fs::write(d.join(format!("2000-01-01T00-00-{i:02}-000Z-x-1.cast")), "").unwrap();
        }
        fs::write(d.join("keep.txt"), "").unwrap();
        let _r = PtyRecorder::open(Some(&d), "x", 1, 1).unwrap();
        let names: Vec<String> = fs::read_dir(&d)
            .unwrap()
            .filter_map(Result::ok)
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            names.iter().filter(|n| n.ends_with(".cast")).count(),
            PTY_RECORD_KEEP
        );
        assert!(names.contains(&"keep.txt".to_string()));
        assert!(!names.iter().any(|n| n.starts_with("2000-01-01T00-00-00-")));
        let _ = fs::remove_dir_all(&d);
    }
}
