//! S5.3 C1c-4b — **정체 홉**(연쇄 한도 재설계 ②) 판정. 정본은 shared `chainStall.ts` 이고, 여기는 그 포트다. 규칙을 새로 정하지 않는다 —
//! 같은 본문에 같은 답을 내는지는 `golden/chain_stall.json`(TS 가 만든 결과, `packages/server/test/rustChainStallGolden.test.ts`)과
//! 대조하는 시험이 본다.
//!
//! 포트에서 갈라지기 쉬운 자리:
//! - **JS `\b`·`\w`·`\d`.** JS(u 플래그 없음)는 ASCII 낱말 경계다. Rust 의 기본은 유니코드라 `로`·`ｃ` 같은 글자를 낱말로 본다 —
//!   그래서 경계·낱말·숫자는 모두 ASCII(`(?-u:…)`)로 적는다.
//! - **JS `/i`.** u 플래그 없는 대소문자 무시는 ASCII 밖 글자를 ASCII 로 접지 않는다(`ſ`≠`s`, `K`(켈빈)≠`k`). Rust 의 유니코드
//!   대소문자 무시는 접는다 — `(?i-u)` 로 ASCII 만 접는다.
//! - **JS `\s`.** ISSUE_REF 앞 글자 집합은 JS 집합 그대로([`super::mention_parse`] 와 같은 이유).
use regex::Regex;
use std::collections::{BTreeSet, HashSet};
use std::sync::LazyLock;

/// TS `STALL_HOP_LIMIT` — 새 결과물 없이 이어진 에이전트 홉이 이만큼이면 막았을 부름을 그림자로 적는다.
pub const STALL_HOP_LIMIT: i32 = 4;
/// TS `STALL_LOOKBACK` — 결과물을 견주는 앞 줄 수(문장은 골든 `stall_recent_bodies` 에 박혀 있다).
pub const STALL_LOOKBACK: i64 = 10;

/// JS 정규식 `\s` 의 집합(ECMAScript WhiteSpace + LineTerminator).
const JS_WS: &str = r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

static SHA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i-u)\b[0-9a-f]{7,40}\b").expect("sha"));
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b")
        .expect("uuid")
});
static ISSUE_REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?:^|[{JS_WS}(\[,])((?-u:(?:[0-9A-Za-z_.\-]+/[0-9A-Za-z_.\-]+)?#[0-9]{{1,7}}\b))"
    ))
    .expect("issue ref")
});
static MESSAGE_LINK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i-u)harkroom://message/([0-9a-f\-]{36})").expect("message link")
});
static GITHUB_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i-u)https://github\.com/[0-9A-Za-z_.\-]+/[0-9A-Za-z_.\-]+/(?:pull|issues|commit)/[0-9a-f]+",
    )
    .expect("github url")
});

/// TS `UUID_EXACT`(소문자만 — 부르는 쪽이 이미 소문자로 맞췄다).
fn uuid_exact(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}

/// TS `messageLinkIds` — 본문의 `harkroom://message/<id>` 가 가리키는 id(소문자, 처음 나온 순서, uuid 꼴만).
pub fn message_link_ids(body: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for c in MESSAGE_LINK.captures_iter(body) {
        let id = c[1].to_ascii_lowercase();
        if seen.insert(id.clone()) && uuid_exact(&id) {
            out.push(id);
        }
    }
    out
}

/// TS `chainArtifacts` — 본문의 결과물 표지(소문자, sha 는 앞 7자리). 같은 스레드 글로 가는 링크·맨 uuid 는 결과물이 아니다.
pub fn chain_artifacts(body: &str, own_thread_ids: &HashSet<String>) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let rest = MESSAGE_LINK.replace_all(body, |c: &regex::Captures| {
        if !own_thread_ids.contains(&c[1].to_ascii_lowercase()) {
            out.insert(format!("msg:{}", c[0].to_ascii_lowercase()));
        }
        " "
    });
    let rest = GITHUB_URL.replace_all(&rest, |c: &regex::Captures| {
        let m = c[0].to_ascii_lowercase();
        let mut tail = m.rsplit('/');
        let last = tail.next().unwrap_or_default();
        let kind = tail.next().unwrap_or_default();
        out.insert(if kind == "commit" {
            format!("sha:{}", &last[..last.len().min(7)])
        } else {
            format!("ref:#{last}")
        });
        " "
    });
    let rest = UUID.replace_all(&rest, " ");
    for m in SHA.find_iter(&rest) {
        let w = m.as_str().to_ascii_lowercase();
        if w.bytes().any(|c| c.is_ascii_digit()) && w.bytes().any(|c| (b'a'..=b'f').contains(&c)) {
            out.insert(format!("sha:{}", &w[..7]));
        }
    }
    for c in ISSUE_REF.captures_iter(&rest) {
        let r = c[1].to_ascii_lowercase();
        // TS `.replace(/^.*#/, '#')` — 마지막 `#` 부터(줄바꿈은 들 수 없다).
        let at = r.rfind('#').unwrap_or_default();
        out.insert(format!("ref:{}", &r[at..]));
    }
    out
}

/// TS `newArtifacts` — 이 본문의 결과물 가운데 앞 줄들에 없던 것.
pub fn new_artifacts(
    body: &str,
    recent: &[String],
    own_thread_ids: &HashSet<String>,
) -> BTreeSet<String> {
    let mine = chain_artifacts(body, own_thread_ids);
    if mine.is_empty() {
        return mine;
    }
    let seen: HashSet<String> = recent
        .iter()
        .flat_map(|b| chain_artifacts(b, own_thread_ids))
        .collect();
    mine.into_iter().filter(|a| !seen.contains(a)).collect()
}

/// TS `StallStep`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct StallStep {
    pub stall_depth: i32,
    pub link_only_reset: bool,
}

/// TS `stallStep` — 사슬 밖이면 0, 첨부·새 결과물이면 0, 아니면 앞 고리 + 1.
pub fn stall_step(
    mention_depth: i32,
    prev_stall: i32,
    body: &str,
    recent: &[String],
    has_attachment: bool,
    own_thread_ids: &HashSet<String>,
) -> StallStep {
    if mention_depth <= 0 || has_attachment {
        return StallStep::default();
    }
    let fresh = new_artifacts(body, recent, own_thread_ids);
    if fresh.is_empty() {
        return StallStep {
            stall_depth: prev_stall + 1,
            link_only_reset: false,
        };
    }
    StallStep {
        stall_depth: 0,
        link_only_reset: fresh.iter().all(|a| a.starts_with("msg:")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn strs(v: &Value) -> Vec<String> {
        v.as_array()
            .unwrap()
            .iter()
            .map(|x| x.as_str().unwrap().to_string())
            .collect()
    }

    /// TS 가 만든 `golden/chain_stall.json` 과 한 줄씩 대조한다.
    #[test]
    fn matches_ts_golden() {
        let g: Value = serde_json::from_str(include_str!("../../golden/chain_stall.json"))
            .expect("golden/chain_stall.json");
        assert_eq!(g["hopLimit"].as_i64(), Some(STALL_HOP_LIMIT as i64));
        assert_eq!(g["lookback"].as_i64(), Some(STALL_LOOKBACK));
        let own: HashSet<String> = ["1e086e53-91c5-4745-99f4-446432722094".to_string()].into();
        for c in g["artifacts"].as_array().unwrap() {
            let body = c["body"].as_str().unwrap();
            let got: Vec<String> = chain_artifacts(body, &HashSet::new()).into_iter().collect();
            assert_eq!(got, strs(&c["artifacts"]), "artifacts {body:?}");
            let got: Vec<String> = chain_artifacts(body, &own).into_iter().collect();
            assert_eq!(got, strs(&c["ownArtifacts"]), "ownArtifacts {body:?}");
            assert_eq!(
                message_link_ids(body),
                strs(&c["linkIds"]),
                "linkIds {body:?}"
            );
        }
        for s in g["steps"].as_array().unwrap() {
            let own: HashSet<String> = strs(&s["own"]).into_iter().collect();
            let got = stall_step(
                s["mentionDepth"].as_i64().unwrap() as i32,
                s["prevStall"].as_i64().unwrap() as i32,
                s["body"].as_str().unwrap(),
                &strs(&s["recentBodies"]),
                s["hasAttachment"].as_bool().unwrap(),
                &own,
            );
            assert_eq!(
                (got.stall_depth as i64, got.link_only_reset),
                (
                    s["out"]["stallDepth"].as_i64().unwrap(),
                    s["out"]["linkOnlyReset"].as_bool().unwrap()
                ),
                "step {s}"
            );
        }
    }
}
