//! S5.3 C4b — 에이전트 쓰기 검사(`scanWrite`)의 Rust 포트. 정본은 TS `packages/server/src/services/contentScan.ts` 다.
//! 기억·스레드 메모 쓰기(set·merge·restore 재검사 포함)는 **이 모듈 하나만** 부른다(security W4 — 걸림 판정을 도구마다 옮기지 않는다).
//! 걸려도 거절하지 않고 표시만 한다(TS 와 같다).
//!
//! TS 정규식은 `u` 없이(`invisible` 만 `u`) 돈다. 그래서 그대로 옮기면 갈리는 곳을 아래처럼 맞춘다:
//! - `\b` 는 ASCII 낱말 경계다 → `(?-u:\b)`(한글·`ſ` 옆에서도 경계가 선다).
//! - `i` 는 ASCII 만 접는다(`ſ`·`K`(켈빈) 를 `s`·`k` 로 보지 않는다) → 낱말 부분만 `(?i-u:…)`.
//! - `\s` 는 JS 공백 표다(`U+FEFF` 포함, `U+0085` 제외) → [`JS_WS`].
//! - 틈 길이 `{0,40}` 등은 UTF-16 단위로 센다 → 판정 전에 BMP 밖 글자 하나를 자리표 두 글자로 바꾼 글([`utf16_shape`])에 건다.
//!   `invisible`(`u` 플래그, 코드 포인트로 센다)만 원문에 건다.
//!
//! 같은 입력에 같은 답을 내는지는 `golden/content_scan.json`(TS 가 만든 결과, `scripts/genRustContentScanGolden.ts`)이 고정한다.
//! 골든에는 TS 규칙 원문(`source`·`flags`)도 실려 있고, 아래 [`RULES`] 의 `ts_source` 와 대조한다 — TS 규칙이 바뀌면 여기가 빨개진다.

use std::sync::LazyLock;

use regex::Regex;

/// JS `\s`(ECMAScript WhiteSpace + LineTerminator).
const JS_WS: &str = r"[\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}]";
/// BMP 밖 글자(서로게이트 둘)의 자리표. 어느 규칙의 글자 표에도 없고 ASCII 낱말 글자도 아니다.
const SURROGATE_STANDIN: char = '\u{E000}';

pub struct ScanRule {
    pub id: &'static str,
    /// 사람이 읽는 이유 — 화면과 도구 응답에 그대로 실린다(TS 와 같은 글자).
    pub label: &'static str,
    /// TS 정본의 `re.source`·`re.flags` — 골든과 대조해 TS 규칙이 바뀐 것을 잡는다.
    pub ts_source: &'static str,
    pub ts_flags: &'static str,
    /// true 면 원문(코드 포인트)에, false 면 UTF-16 꼴로 바꾼 글에 건다.
    code_points: bool,
    re: LazyLock<Regex>,
}

macro_rules! rule {
    ($id:expr, $label:expr, $src:expr, $flags:expr, $cp:expr, $re:expr) => {
        ScanRule {
            id: $id,
            label: $label,
            ts_source: $src,
            ts_flags: $flags,
            code_points: $cp,
            re: LazyLock::new(|| Regex::new(&$re).expect("content_scan 규칙")),
        }
    };
}

const B: &str = r"(?-u:\b)";

pub static RULES: [ScanRule; 6] = [
    rule!(
        "override-en",
        "앞선 지시를 무시하라는 문장(영문)",
        r"\b(?:ignore|disregard|forget|override)\b[^\n.]{0,40}\b(?:previous|prior|above|earlier|all|any|system|your)\b[^\n.]{0,20}\b(?:instructions?|prompts?|rules?|directives?|guidelines?)\b",
        "i",
        false,
        format!(
            r"{B}(?i-u:ignore|disregard|forget|override){B}[^\n.]{{0,40}}{B}(?i-u:previous|prior|above|earlier|all|any|system|your){B}[^\n.]{{0,20}}{B}(?i-u:instructions?|prompts?|rules?|directives?|guidelines?){B}"
        )
    ),
    rule!(
        "override-ko",
        "앞선 지시를 무시하라는 문장(한글)",
        r"(?:이전|앞의|앞선|위의|기존|모든|시스템)\s*(?:지시|지침|명령|규칙|프롬프트)[^\n.]{0,12}(?:무시|잊어|따르지\s*마)",
        "",
        false,
        format!(
            r"(?:이전|앞의|앞선|위의|기존|모든|시스템){JS_WS}*(?:지시|지침|명령|규칙|프롬프트)[^\n.]{{0,12}}(?:무시|잊어|따르지{JS_WS}*마)"
        )
    ),
    rule!(
        "role-tag",
        "시스템·지시 블록을 흉내 낸 태그",
        r"<\/?\s*(?:system|system-reminder|instructions?|developer)\s*>|\[\/?(?:SYSTEM|INST)\]|<\|im_start\|>",
        "i",
        false,
        format!(
            r"</?{JS_WS}*(?i-u:system|system-reminder|instructions?|developer){JS_WS}*>|\[/?(?i-u:SYSTEM|INST)\]|<\|(?i-u:im_start)\|>"
        )
    ),
    rule!(
        "secret",
        "비밀 토큰 값",
        r"\bsk-ant-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----",
        "",
        false,
        format!(
            r"{B}sk-ant-[A-Za-z0-9_-]{{20,}}|{B}gh[pousr]_[A-Za-z0-9]{{30,}}|{B}github_pat_[A-Za-z0-9_]{{30,}}|{B}AKIA[0-9A-Z]{{16}}{B}|{B}xox[abprs]-[A-Za-z0-9-]{{10,}}|-----BEGIN [A-Z ]*PRIVATE KEY-----"
        )
    ),
    rule!(
        "exfil",
        "비밀을 밖으로 보내는 명령",
        r"\b(?:curl|wget|nc|Invoke-WebRequest)\b[^\n]{0,200}(?:\$\{?[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\b|~?\/\.ssh\/|\$\(\s*gh auth token)",
        "i",
        false,
        format!(
            r"{B}(?i-u:curl|wget|nc|Invoke-WebRequest){B}[^\n]{{0,200}}(?:\$\{{?(?i-u:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)){B}|~?/\.ssh/|\$\({JS_WS}*(?i-u:gh auth token))"
        )
    ),
    rule!(
        "invisible",
        "보이지 않는 글자(방향 제어·태그 문자 등)",
        "[\u{200B}\u{200E}\u{200F}\u{202A}-\u{202E}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{FEFF}\\u{E0000}-\\u{E007F}]",
        "u",
        true,
        String::from(
            r"[\x{200B}\x{200E}\x{200F}\x{202A}-\x{202E}\x{2060}-\x{2064}\x{2066}-\x{2069}\x{FEFF}\x{E0000}-\x{E007F}]"
        )
    ),
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScanHit {
    /// 걸린 규칙들의 사람용 이유, `; ` 로 잇는다.
    pub reason: String,
    pub rules: Vec<&'static str>,
}

/// BMP 밖 글자를 자리표 두 글자로 — JS(`u` 없음)가 서로게이트 둘로 세는 길이와 같게 한다.
fn utf16_shape(text: &str) -> std::borrow::Cow<'_, str> {
    if text.chars().all(|c| (c as u32) <= 0xFFFF) {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut s = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        if (c as u32) > 0xFFFF {
            s.push(SURROGATE_STANDIN);
            s.push(SURROGATE_STANDIN);
        } else {
            s.push(c);
        }
    }
    std::borrow::Cow::Owned(s)
}

/// 걸리면 이유를, 아니면 None 을 준다. 여러 칸(본문·요약)을 한 번에 본다 — 빈 칸·None 은 빼고 `\n` 으로 잇는다(TS 와 같다).
pub fn scan_write(parts: &[Option<&str>]) -> Option<ScanHit> {
    let text = parts
        .iter()
        .filter_map(|p| p.filter(|s| !s.is_empty()))
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        return None;
    }
    let shaped = utf16_shape(&text);
    let hit: Vec<&ScanRule> = RULES
        .iter()
        .filter(|r| r.re.is_match(if r.code_points { &text } else { &shaped }))
        .collect();
    if hit.is_empty() {
        return None;
    }
    Some(ScanHit {
        reason: hit.iter().map(|r| r.label).collect::<Vec<_>>().join("; "),
        rules: hit.iter().map(|r| r.id).collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn golden() -> Value {
        serde_json::from_str(include_str!("../../golden/content_scan.json"))
            .expect("golden/content_scan.json")
    }

    /// 골든의 TS 규칙(id·이유·원문·플래그)이 이 표와 한 글자도 다르지 않다 — TS 규칙이 바뀌었으면 여기서 멈춘다.
    #[test]
    fn rules_match_ts_source() {
        let g = golden();
        let ts = g["rules"].as_array().unwrap();
        assert_eq!(ts.len(), RULES.len());
        for (t, r) in ts.iter().zip(RULES.iter()) {
            assert_eq!(t["id"], r.id);
            assert_eq!(t["label"], r.label, "{}", r.id);
            assert_eq!(t["source"], r.ts_source, "{} 원문", r.id);
            assert_eq!(t["flags"], r.ts_flags, "{} 플래그", r.id);
        }
    }

    /// TS `scanWrite` 가 낸 판정과 한 줄씩 같다.
    #[test]
    fn matches_ts_golden() {
        let g = golden();
        let cases = g["cases"].as_array().unwrap();
        assert!(cases.len() >= 500, "사례가 줄었다: {}", cases.len());
        let (mut hits, mut misses) = (0, 0);
        for c in cases {
            let parts: Vec<Option<String>> = c["parts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| {
                    p.as_array()
                        .map(|a| a.iter().map(|x| x.as_str().unwrap()).collect::<String>())
                })
                .collect();
            let refs: Vec<Option<&str>> = parts.iter().map(|p| p.as_deref()).collect();
            let got = scan_write(&refs)
                .map(|h| serde_json::json!({ "reason": h.reason, "rules": h.rules }));
            let want = if c["want"].is_null() {
                None
            } else {
                Some(c["want"].clone())
            };
            if want.is_some() {
                hits += 1
            } else {
                misses += 1
            }
            assert_eq!(got, want, "scanWrite({parts:?})");
        }
        // 걸림·안 걸림 둘 다 넉넉히 탄다(한쪽만 타는 골든은 판정이 뒤집혀도 못 잡는다).
        assert!(hits >= 100 && misses >= 100, "hits {hits} misses {misses}");
    }

    /// 규칙마다 걸리는 사례가 골든에 있다(규칙 하나를 통째로 빼면 빨개진다).
    #[test]
    fn every_rule_is_hit_by_golden() {
        let g = golden();
        for r in RULES.iter() {
            let n = g["cases"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| {
                    c["want"]["rules"]
                        .as_array()
                        .is_some_and(|a| a.iter().any(|x| x == r.id))
                })
                .count();
            assert!(n >= 3, "{} 를 타는 사례 {n}", r.id);
        }
    }
}
