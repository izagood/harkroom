//! 그림자 비교(S3 B2) — 러너 녹화(`AGENT_PTY_RECORD_DIR`, asciicast v2)를 다시 틀어
//! `harkroom-screen` 이 TS 러너와 **같은 자리에서 같은 판정**을 내는지 잰다.
//!
//! ## 녹화에서 읽는 것 (`packages/agent/src/ptyRecorder.ts`)
//! - `[t, "o", 글]` — 하네스가 뱉은 출력. UTF-8 바이트로 누적한다.
//! - `[t, "r", "COLSxROWS"]` — 크기 바꿈. 그 시점까지 쌓인 바이트 위치에 적용한다.
//! - `[t, "m", JSON]` — TS 판정 표지 `{kind:"screen", harness, state, bytes}`
//!   (`mentionTurn.ts` — 상태가 **바뀔 때만** 적는다). `bytes` 는 그 판정을 낼 때까지
//!   화면에 넣은 누적 바이트다. 표지는 비동기로 적혀 뒤의 `o` 줄보다 늦게 나올 수 있으므로
//!   **줄 순서가 아니라 `bytes` 로** 맞춘다.
//!
//! ## 내보내지 않는 것
//! 녹화에는 계정 이름·작업 폴더·프롬프트가 보일 수 있다. 보고에는 화면 글을 싣지 않고
//! 위치(바이트)·판정·개수만 싣는다. 녹화 파일은 켠 사람의 기계 밖으로 내보내지 않는다.
use harkroom_screen::{Harness, ScreenIdleWatch, ScreenState, facts_for};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// 녹화 한 편을 읽은 것.
#[derive(Debug, Default)]
pub struct Cast {
    pub width: u16,
    pub height: u16,
    /// 출력 바이트 전부(이어 붙인 것).
    pub bytes: Vec<u8>,
    /// (그 시점의 누적 바이트, cols, rows)
    pub resizes: Vec<(usize, u16, u16)>,
    /// TS 판정 표지(파일에 나온 순서).
    pub marks: Vec<Mark>,
    /// 읽지 못한 줄 수(깨진 JSON·모르는 꼴). 0 이 아니면 보고에 싣는다.
    pub bad_lines: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mark {
    pub harness: String,
    pub state: String,
    pub bytes: usize,
}

fn parse_size(s: &str) -> Option<(u16, u16)> {
    let (c, r) = s.split_once('x')?;
    Some((c.parse().ok()?, r.parse().ok()?))
}

/// asciicast v2 글을 읽는다. 헤더가 없거나 v2 가 아니면 Err.
pub fn parse_cast(text: &str) -> Result<Cast, String> {
    let mut lines = text.lines();
    let header: Value = lines
        .next()
        .and_then(|l| serde_json::from_str(l).ok())
        .ok_or("헤더가 없다")?;
    if header["version"].as_u64() != Some(2) {
        return Err("asciicast v2 가 아니다".into());
    }
    let mut cast = Cast {
        width: header["width"].as_u64().unwrap_or(120) as u16,
        height: header["height"].as_u64().unwrap_or(40) as u16,
        ..Cast::default()
    };
    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(Value::Array(ev)) = serde_json::from_str::<Value>(line) else {
            cast.bad_lines += 1;
            continue;
        };
        let (Some(code), Some(data)) = (
            ev.get(1).and_then(Value::as_str),
            ev.get(2).and_then(Value::as_str),
        ) else {
            cast.bad_lines += 1;
            continue;
        };
        match code {
            "o" => cast.bytes.extend_from_slice(data.as_bytes()),
            "r" => match parse_size(data) {
                Some((c, r)) => cast.resizes.push((cast.bytes.len(), c, r)),
                None => cast.bad_lines += 1,
            },
            "m" => {
                let Ok(m) = serde_json::from_str::<Value>(data) else {
                    cast.bad_lines += 1;
                    continue;
                };
                if m["kind"].as_str() != Some("screen") {
                    continue; // 다른 종류의 표지는 이 비교의 몫이 아니다
                }
                match (
                    m["harness"].as_str(),
                    m["state"].as_str(),
                    m["bytes"].as_u64(),
                ) {
                    (Some(h), Some(s), Some(b)) => cast.marks.push(Mark {
                        harness: h.into(),
                        state: s.into(),
                        bytes: b as usize,
                    }),
                    _ => cast.bad_lines += 1,
                }
            }
            _ => {}
        }
    }
    Ok(cast)
}

/// 불일치 하나 — 화면 글은 싣지 않는다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mismatch {
    pub bytes: usize,
    pub ts: String,
    pub rust: String,
}

/// 녹화 한 편의 비교 결과.
#[derive(Debug, Default)]
pub struct CastReport {
    pub harness: Option<String>,
    pub samples: usize,
    pub matched: usize,
    /// TS 판정(state)별 (표본 수, 맞은 수).
    pub by_state: BTreeMap<String, (usize, usize)>,
    pub mismatches: Vec<Mismatch>,
    /// TS 가 busy 라고 본 구간에 들어온 출력 바이트(스트리밍 덮음 정도).
    pub busy_stream_bytes: usize,
    pub total_bytes: usize,
    /// 표지가 녹화 바이트보다 뒤를 가리키는 것(녹화가 32MB 상한 등으로 잘림) — 비교하지 않고 센다.
    pub beyond_end: usize,
    pub unknown_harness: bool,
    pub bad_lines: usize,
}

/// 녹화를 다시 틀어 표지마다 Rust 판정과 대조한다.
pub fn compare(cast: &Cast) -> CastReport {
    let mut rep = CastReport {
        total_bytes: cast.bytes.len(),
        bad_lines: cast.bad_lines,
        ..CastReport::default()
    };
    let Some(first) = cast.marks.first() else {
        return rep;
    };
    rep.harness = Some(first.harness.clone());
    let Some(h) = Harness::from_name(&first.harness) else {
        rep.unknown_harness = true;
        return rep;
    };
    let mut watch = ScreenIdleWatch::with_size(facts_for(h), cast.width, cast.height);
    let mut marks = cast.marks.clone();
    marks.sort_by_key(|m| m.bytes); // 표지는 비동기라 순서가 섞일 수 있다
    let mut fed = 0usize;
    let mut ri = 0usize;
    let mut busy_from: Option<usize> = None;
    for m in &marks {
        if m.bytes > cast.bytes.len() {
            rep.beyond_end += 1;
            continue;
        }
        // 표지 위치까지 그린다 — 크기 바꿈은 녹화된 바이트 자리에서 적용한다.
        // (크기 바꿈만으로는 판정을 다시 재지 않는다 — TS 도 다음 바이트가 와야 다시 잰다.)
        while fed < m.bytes {
            match cast.resizes.get(ri) {
                Some(&(at, c, r)) if at <= fed => {
                    watch.resize(c, r);
                    ri += 1;
                }
                next => {
                    let stop = next.map_or(m.bytes, |&(at, _, _)| at.min(m.bytes));
                    watch.feed(&cast.bytes[fed..stop], 0);
                    fed = stop;
                }
            }
        }
        let rust = watch.current();
        rep.samples += 1;
        let e = rep.by_state.entry(m.state.clone()).or_default();
        e.0 += 1;
        if rust.as_str() == m.state {
            rep.matched += 1;
            e.1 += 1;
        } else {
            rep.mismatches.push(Mismatch {
                bytes: m.bytes,
                ts: m.state.clone(),
                rust: rust.as_str().into(),
            });
        }
        if let Some(from) = busy_from.take() {
            rep.busy_stream_bytes += m.bytes - from;
        }
        if m.state == ScreenState::Busy.as_str() {
            busy_from = Some(m.bytes);
        }
    }
    if let Some(from) = busy_from {
        rep.busy_stream_bytes += cast.bytes.len().saturating_sub(from);
    }
    rep
}

/// 여러 편을 합친 집계(JSON). 파일 이름·화면 글은 싣지 않는다.
pub fn summarize(reports: &[CastReport]) -> Value {
    let mut by_state: BTreeMap<String, (usize, usize)> = BTreeMap::new();
    let mut by_harness: BTreeMap<String, (usize, usize, usize)> = BTreeMap::new();
    let (mut samples, mut matched, mut busy_bytes, mut total_bytes) = (0, 0, 0, 0);
    let (mut beyond, mut bad, mut unknown, mut no_marks) = (0, 0, 0, 0);
    let mut kinds: BTreeMap<String, usize> = BTreeMap::new();
    for r in reports {
        samples += r.samples;
        matched += r.matched;
        busy_bytes += r.busy_stream_bytes;
        total_bytes += r.total_bytes;
        beyond += r.beyond_end;
        bad += r.bad_lines;
        unknown += usize::from(r.unknown_harness);
        no_marks += usize::from(r.harness.is_none());
        for (k, (n, ok)) in &r.by_state {
            let e = by_state.entry(k.clone()).or_default();
            e.0 += n;
            e.1 += ok;
        }
        if let Some(h) = &r.harness {
            let e = by_harness.entry(h.clone()).or_default();
            e.0 += 1;
            e.1 += r.samples;
            e.2 += r.matched;
        }
        for m in &r.mismatches {
            *kinds
                .entry(format!("ts={} rust={}", m.ts, m.rust))
                .or_default() += 1;
        }
    }
    let states: Value = ["busy", "gate", "idle", "unknown"]
        .iter()
        .map(|s| {
            let (n, ok) = by_state.get(*s).copied().unwrap_or_default();
            (s.to_string(), json!({ "samples": n, "matched": ok }))
        })
        .collect::<serde_json::Map<_, _>>()
        .into();
    json!({
        "casts": reports.len(),
        "castsWithoutMarks": no_marks,
        "samples": samples,
        "matched": matched,
        "mismatched": samples - matched,
        "byState": states,
        "byHarness": by_harness.iter().map(|(h, (c, n, ok))| (h.clone(), json!({ "casts": c, "samples": n, "matched": ok }))).collect::<serde_json::Map<_, _>>(),
        "mismatchKinds": kinds,
        "streaming": { "busyBytes": busy_bytes, "totalBytes": total_bytes },
        "marksBeyondRecording": beyond,
        "unknownHarnessCasts": unknown,
        "badLines": bad,
    })
}
