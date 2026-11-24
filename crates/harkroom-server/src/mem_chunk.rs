//! 기억 본문을 임베딩할 조각으로 나눈다(기억 벡터 V3). DB·네트워크를 모른다.
//!
//! - 경계는 제목(`#`)과 빈 줄이다. [`MIN_CHARS`] 를 넘긴 조각은 제목에서 끊고, [`MAX_CHARS`] 를 넘기 전에 끊는다.
//! - 조각 앞에 `이름 — 요약` 한 줄을 붙여 임베딩한다(자리·길이에는 안 든다). 붙인 줄까지 [`MAX_CHARS`] 안에 들도록 본문 몫을 줄이되
//!   [`MIN_CHARS`] 아래로는 줄이지 않는다.
//! - 요약이 있으면 요약만의 조각을 하나 더 만든다.

/// 나누는 규칙의 판 — 규칙을 바꾸면 올린다(문서 해시에 들어가 전부 다시 만든다).
pub const CHUNK_VERSION: &str = "1";
pub const MIN_CHARS: usize = 400;
pub const MAX_CHARS: usize = 800;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    /// `body` | `description`.
    pub source: &'static str,
    pub idx: i32,
    /// 본문 안의 자리(글자 수). `description` 은 0.
    pub start: i32,
    pub len: i32,
    /// 임베딩 서비스에 보낼 글.
    pub text: String,
}

/// 기억 하나의 조각. `body` 조각은 본문이 비어도 하나 있다.
pub fn chunks(slug: &str, description: Option<&str>, value: &str) -> Vec<Chunk> {
    let description = description.map(str::trim).filter(|d| !d.is_empty());
    let head = match description {
        Some(d) => format!("{slug} — {d}"),
        None => slug.to_owned(),
    };
    let limit = MAX_CHARS
        .saturating_sub(head.chars().count() + 1)
        .max(MIN_CHARS);
    let chars: Vec<char> = value.chars().collect();
    let mut out: Vec<Chunk> = spans(&chars, limit)
        .into_iter()
        .filter(|(s, e)| chars[*s..*e].iter().any(|c| !c.is_whitespace()))
        .enumerate()
        .map(|(i, (s, e))| {
            let body: String = chars[s..e].iter().collect();
            Chunk {
                source: "body",
                idx: i as i32,
                start: s as i32,
                len: (e - s) as i32,
                text: format!("{head}\n{}", body.trim()),
            }
        })
        .collect();
    if out.is_empty() {
        out.push(Chunk {
            source: "body",
            idx: 0,
            start: 0,
            len: 0,
            text: head,
        });
    }
    if let Some(d) = description {
        out.push(Chunk {
            source: "description",
            idx: 0,
            start: 0,
            len: d.chars().count() as i32,
            text: d.to_owned(),
        });
    }
    out
}

/// 빈틈도 겹침도 없는 `[시작, 끝)` 들.
fn spans(chars: &[char], limit: usize) -> Vec<(usize, usize)> {
    let mut out = vec![];
    let mut start = 0;
    let mut end = 0;
    for (s, e, heading) in blocks(chars) {
        if end > start && (e - start > limit || (heading && s - start >= MIN_CHARS.min(limit))) {
            out.push((start, end));
            start = s;
        }
        end = e;
        // 문단 하나가 상한보다 길면 자른다 — 줄 끝, 빈칸 순으로 뒤쪽 절반에서 찾고 없으면 글자에서.
        while end - start > limit {
            let cut = cut_at(&chars[start..start + limit]);
            out.push((start, start + cut));
            start += cut;
        }
    }
    if end > start {
        out.push((start, end));
    }
    out
}

fn cut_at(window: &[char]) -> usize {
    let half = window.len() / 2;
    let last = |f: fn(&char) -> bool| {
        window
            .iter()
            .rposition(f)
            .map(|i| i + 1)
            .filter(|i| *i > half)
    };
    last(|c| *c == '\n')
        .or_else(|| last(|c| c.is_whitespace()))
        .unwrap_or(window.len())
}

/// 문단들 `(시작, 끝, 제목으로 시작하나)`. 빈 줄은 앞 문단에 붙는다.
fn blocks(chars: &[char]) -> Vec<(usize, usize, bool)> {
    let mut out: Vec<(usize, usize, bool)> = vec![];
    let mut blank = true;
    let mut at = 0;
    while at < chars.len() {
        let end = chars[at..]
            .iter()
            .position(|c| *c == '\n')
            .map_or(chars.len(), |i| at + i + 1);
        let line = &chars[at..end];
        let empty = line.iter().all(|c| c.is_whitespace());
        let heading = line.first() == Some(&'#');
        match out.last_mut() {
            Some(last) if empty || !(blank || heading) => last.1 = end,
            _ => out.push((at, end, heading)),
        }
        blank = empty;
        at = end;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body(v: &str) -> Vec<Chunk> {
        chunks("mem/a", None, v)
    }

    #[test]
    fn short_memory_is_one_chunk_plus_description() {
        let c = chunks("mem/a", Some(" 요약 "), "본문\n\n둘째");
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].text, "mem/a — 요약\n본문\n\n둘째");
        assert_eq!((c[0].source, c[0].start, c[0].len), ("body", 0, 6));
        assert_eq!((c[1].source, c[1].text.as_str()), ("description", "요약"));
    }

    #[test]
    fn blank_body_still_has_a_chunk() {
        for v in ["", " \n\n"] {
            let c = body(v);
            assert_eq!(c.len(), 1);
            assert_eq!(c[0].text, "mem/a");
        }
    }

    #[test]
    fn heading_starts_a_chunk_once_min_is_reached() {
        let v = format!("# 가\n{}\n# 나\n짧음", "x".repeat(450));
        let c = body(&v);
        assert_eq!(c.len(), 2);
        assert!(c[1].text.ends_with("# 나\n짧음"));
        // 아직 짧으면 제목에서 끊지 않는다.
        assert_eq!(body("# 가\nx\n# 나\ny").len(), 1);
    }

    #[test]
    fn spans_cover_everything_within_limit() {
        let long = "가나다 ".repeat(900);
        let mixed = format!(
            "# t\n{}\n\n{}\n\n{}",
            "a".repeat(700),
            "나".repeat(2000),
            "z\n".repeat(600)
        );
        for v in [long, mixed] {
            let chars: Vec<char> = v.chars().collect();
            let s = spans(&chars, 700);
            assert_eq!(s[0].0, 0);
            assert_eq!(s.last().unwrap().1, chars.len());
            assert!(s.windows(2).all(|w| w[0].1 == w[1].0));
            assert!(s.iter().all(|(a, b)| b > a && b - a <= 700));
        }
    }

    #[test]
    fn prefix_counts_toward_max_but_body_keeps_min() {
        let v = "가".repeat(3000);
        let d = "요".repeat(200);
        for c in chunks("mem/a", Some(&d), &v) {
            assert!(c.text.chars().count() <= MAX_CHARS, "{}", c.text.len());
        }
        let slug = format!("mem/{}", "a".repeat(250));
        let c = chunks(&slug, Some(&"요".repeat(400)), &v);
        assert_eq!(c[0].len as usize, MIN_CHARS);
    }
}
