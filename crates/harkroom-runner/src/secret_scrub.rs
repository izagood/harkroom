//! 정본 `secretScrub.ts` — 턴 기록 가리기(비밀 보관소 D7, PR 3b). 마운트한 비밀·턴 열쇠의 값이 하네스 기록(claude 세션
//! jsonl·codex rollout·세션 디렉터리의 `tool-results`·`subagents`)에 남았으면 `***` 로 바꿔 쓴다.
//!
//! 한계(정본과 같다): 모델이 값을 출력했다면 그 값은 이미 모델 제공사에 갔다. 이것이 지키는 것은 이 머신의 디스크에
//! 남는 사본이다 — 백업·동기화·나중의 resume·다른 에이전트의 셸.
//!
//! 형태: 평문, **JSON 문자열 안의 평문**(jsonl 은 줄바꿈·따옴표를 이스케이프해 적는다), URL 인코딩
//! (`encodeURIComponent`), base64(표준·패딩 없음·url-safe). 여러 줄 값은 16자 이상 줄마다 따로 본다. 8바이트 미만 값은
//! 보지 않는다(짧은 값은 정상 글을 망가뜨린다).
//!
//! 쓰기: 심링크는 따라가지 않는다(파일·디렉터리 모두). 같은 디렉터리에 임시 파일을 `create_new` 로 쓰고 rename 한다 —
//! 도중에 죽어도 반쪽 파일이 남지 않는다. 원래 mode 를 지킨다. 깊이·파일 크기에 상한을 둔다.

use std::collections::BTreeSet;
use std::fs;
use std::io::{self, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};

/// 정본 `SCRUB_MIN_BYTES` — 이보다 짧은 값은 보지 않는다.
pub const SCRUB_MIN_BYTES: usize = 8;
const LINE_MIN_CHARS: usize = 16;
/// 정본 `SCRUB_MASK`.
pub const SCRUB_MASK: &str = "***";
/// 정본 `SCRUB_MAX_DEPTH` — claude 세션 디렉터리는 `tool-results/`·`subagents/` 한두 단이다.
pub const SCRUB_MAX_DEPTH: usize = 4;
/// 정본 `SCRUB_MAX_FILE_BYTES` — 이보다 큰 파일은 읽지 않는다(통째로 메모리에 올리지 않는다).
pub const SCRUB_MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

/// JS `encodeURIComponent` — 남기는 글자: `A-Z a-z 0-9 - _ . ! ~ * ' ( )`. 나머지는 UTF-8 바이트마다 `%XX`(대문자).
fn encode_uri_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// JS `JSON.stringify(s).slice(1, -1)` — JSON 문자열 안에 적힌 꼴.
fn json_inner(s: &str) -> String {
    let q = serde_json::to_string(s).unwrap_or_default();
    q.get(1..q.len().saturating_sub(1))
        .unwrap_or_default()
        .to_string()
}

/// 정본 `scrubNeedles` — 한 값에서 찾을 글자 바늘들. 긴 것부터(짧은 바늘이 긴 바늘의 일부를 먼저 지워 긴 것이 남는 일을
/// 막는다).
pub fn scrub_needles(value: &[u8]) -> Vec<String> {
    if value.len() < SCRUB_MIN_BYTES {
        return Vec::new();
    }
    let mut out: BTreeSet<String> = BTreeSet::new();
    let mut add = |s: String| {
        if s.len() >= SCRUB_MIN_BYTES {
            out.insert(s);
        }
    };
    let b64 = STANDARD.encode(value);
    add(b64.trim_end_matches('=').to_string());
    add(b64);
    add(URL_SAFE_NO_PAD.encode(value));
    if let Ok(text) = std::str::from_utf8(value) {
        let trimmed = text.trim();
        let mut forms: Vec<&str> = vec![text, trimmed];
        if trimmed.contains('\n') {
            for line in trimmed.split('\n') {
                let line = line.strip_suffix('\r').unwrap_or(line).trim();
                if line.chars().count() >= LINE_MIN_CHARS {
                    forms.push(line);
                }
            }
        }
        for f in forms {
            add(f.to_string());
            add(json_inner(f));
            add(encode_uri_component(f));
        }
    }
    let mut v: Vec<String> = out.into_iter().collect();
    v.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    v
}

/// 정본 `scrubText` — 바늘을 전부 가리고 바꾼 횟수를 함께 준다.
pub fn scrub_text(text: &str, needles: &[String]) -> (String, usize) {
    let mut replaced = 0;
    let mut out = text.to_string();
    for n in needles {
        if n.is_empty() || !out.contains(n.as_str()) {
            continue;
        }
        replaced += out.matches(n.as_str()).count();
        out = out.replace(n.as_str(), SCRUB_MASK);
    }
    (out, replaced)
}

/// 바이트 판 [`scrub_text`].
fn scrub_bytes(data: &[u8], needles: &[String]) -> (Vec<u8>, usize) {
    let mut replaced = 0;
    let mut out = data.to_vec();
    for n in needles {
        let n = n.as_bytes();
        if n.is_empty() || out.len() < n.len() {
            continue;
        }
        let mut next = Vec::with_capacity(out.len());
        let mut i = 0;
        let mut hit = 0;
        while i < out.len() {
            if out[i..].starts_with(n) {
                next.extend_from_slice(SCRUB_MASK.as_bytes());
                i += n.len();
                hit += 1;
            } else {
                next.push(out[i]);
                i += 1;
            }
        }
        if hit > 0 {
            replaced += hit;
            out = next;
        }
    }
    (out, replaced)
}

static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

fn tmp_name(dir: &Path) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(
        ".{:x}{:x}{:x}.scrub",
        std::process::id(),
        nanos,
        seq
    ))
}

/// 정본 `scrubFile` — 파일 하나를 가린다. 없거나 일반 파일이 아니면(심링크 포함) 0. 바이트로 찾아 바꾼다 — UTF-8 이
/// 아닌 조각이 섞인 기록도 건너뛰지 않고, 바늘 밖 바이트는 그대로 둔다(정본은 손실 변환해 다시 쓴다).
pub fn scrub_file(path: &Path, needles: &[String]) -> io::Result<usize> {
    if needles.is_empty() {
        return Ok(0);
    }
    let Ok(info) = fs::symlink_metadata(path) else {
        return Ok(0);
    };
    if !info.file_type().is_file() {
        return Ok(0);
    }
    let before = fs::read(path)?;
    let (text, replaced) = scrub_bytes(&before, needles);
    if replaced == 0 {
        return Ok(0);
    }
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let tmp = tmp_name(dir);
    let write = || -> io::Result<()> {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(info.permissions().mode() & 0o777)
            .open(&tmp)?;
        f.write_all(&text)?;
        f.sync_all()?;
        // umask 가 mode 를 깎았을 수 있다 — 원래 mode 로 맞춘다.
        fs::set_permissions(
            &tmp,
            fs::Permissions::from_mode(info.permissions().mode() & 0o777),
        )?;
        fs::rename(&tmp, path)
    };
    if let Err(e) = write() {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(replaced)
}

/// 가리기 결과 — 바꾼 곳 수와, 오류로 가리지 못한 파일 수.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ScrubTally {
    pub replaced: usize,
    pub failed: usize,
}

impl std::ops::AddAssign for ScrubTally {
    fn add_assign(&mut self, o: Self) {
        self.replaced += o.replaced;
        self.failed += o.failed;
    }
}

/// 정본 `scrubPath` — 파일이면 가리고, 디렉터리면 그 아래 **일반 파일**을 전부 가린다(security T1). 심링크는 따라가지
/// 않고, 깊이와 파일 크기에 상한을 둔다. 크기로 건너뛴 파일은 `on_skip` 에 경로만 알린다(값은 아니다).
///
/// **파일 하나가 실패해도 멈추지 않는다**(#2010 security 낮음): 권한·잠금·디스크 오류는 `on_error` 에 그 경로를 알리고
/// 다음 파일로 간다 — 가운데서 멈추면 뒤 파일에 열쇠가 남는다(가리기가 열린 쪽으로 실패). 합계와 실패 수를 돌려준다.
pub fn scrub_path(
    path: &Path,
    needles: &[String],
    on_skip: &mut dyn FnMut(&Path),
    on_error: &mut dyn FnMut(&Path, &io::Error),
) -> ScrubTally {
    let mut tally = ScrubTally::default();
    scrub_path_at(path, needles, on_skip, on_error, 0, &mut tally);
    tally
}

fn scrub_path_at(
    path: &Path,
    needles: &[String],
    on_skip: &mut dyn FnMut(&Path),
    on_error: &mut dyn FnMut(&Path, &io::Error),
    depth: usize,
    tally: &mut ScrubTally,
) {
    if needles.is_empty() {
        return;
    }
    let Ok(info) = fs::symlink_metadata(path) else {
        return;
    };
    let ft = info.file_type();
    if ft.is_file() {
        if info.len() > SCRUB_MAX_FILE_BYTES {
            on_skip(path);
            return;
        }
        match scrub_file(path, needles) {
            Ok(n) => tally.replaced += n,
            Err(e) => {
                tally.failed += 1;
                on_error(path, &e);
            }
        }
        return;
    }
    if !ft.is_dir() || depth >= SCRUB_MAX_DEPTH {
        return;
    }
    let rd = match fs::read_dir(path) {
        Ok(rd) => rd,
        Err(e) => {
            // 디렉터리를 못 열면 그 아래는 하나도 못 가렸다 — 조용히 넘기지 않는다.
            tally.failed += 1;
            on_error(path, &e);
            return;
        }
    };
    let mut names: Vec<PathBuf> = rd.filter_map(|e| e.ok().map(|e| e.path())).collect();
    names.sort();
    for p in names {
        scrub_path_at(&p, needles, on_skip, on_error, depth + 1, tally);
    }
}

/// 정본 `turnKeyNeedles` — 턴 열쇠 값들의 바늘.
pub fn turn_key_needles(values: &[&str]) -> Vec<String> {
    let mut all: BTreeSet<String> = BTreeSet::new();
    for v in values {
        all.extend(scrub_needles(v.as_bytes()));
    }
    let mut v: Vec<String> = all.into_iter().collect();
    v.sort_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    v
}

/// 정본 `scrubTurnKeys` — 턴이 끝난 뒤 기록 경로마다 턴 열쇠를 가린다. 실패는 턴을 실패로 만들지 않는다(로그만).
/// 로그에는 경로·횟수·오류 종류만 남기고 값은 찍지 않는다. 합계와 실패 수를 돌려준다.
pub fn scrub_turn_keys(key: &str, paths: &[PathBuf], needles: &[String]) -> ScrubTally {
    let mut total = ScrubTally::default();
    if needles.is_empty() {
        return total;
    }
    for path in paths {
        let mut skip = |p: &Path| {
            eprintln!(
                "[mentionTurn] {key}: {}: 너무 커서 턴 열쇠를 가리지 못했다",
                p.display()
            );
        };
        let mut err = |p: &Path, e: &io::Error| {
            eprintln!(
                "[mentionTurn] {key}: 턴 열쇠 가리기 실패({}) — {:?}",
                p.display(),
                e.kind()
            );
        };
        let t = scrub_path(path, needles, &mut skip, &mut err);
        if t.replaced > 0 {
            eprintln!(
                "[mentionTurn] {key}: {}: 턴 열쇠 {}곳을 가렸다",
                path.display(),
                t.replaced
            );
        }
        if t.failed > 0 {
            eprintln!(
                "[mentionTurn] {key}: {}: 실패 {}곳 — 나머지는 계속 가렸다",
                path.display(),
                t.failed
            );
        }
        total += t;
    }
    total
}

#[cfg(test)]
#[path = "secret_scrub_tests.rs"]
mod tests;
