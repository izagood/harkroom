//! PR diff 의 지문 — 「검토한 것과 지금 것이 같은 변경인가」를 head sha 대신 **diff 내용**으로 견준다.
//!
//! base 를 merge 해서 head 만 바뀐 PR 은 변경이 그대로인데 head 가 달라 재검토가 걸린다. 지문은 unified diff 에서
//! 「같은 변경이어도 base 가 움직이면 달라지는 것」만 지우고 sha256 을 낸다:
//! - `index <blob>..<blob>` 줄 — 파일의 다른 자리가 base 에서 바뀌면 blob 이 달라진다. **이진 파일은 지우지 않는다**
//!   (내용이 diff 에 안 실려 blob id 가 유일한 증거다).
//! - `@@ -a,b +c,d @@ <함수 문맥>` — 줄 번호는 위쪽이 밀리면 달라진다. **숫자만** 지우고 꼬리(함수 문맥)는
//!   `@@ <꼬리>` 로 남긴다(git range-diff 와 같은 방식). 꼬리까지 지우면 위치가 하나도 안 남아, 앞뒤 문맥이 같은
//!   두 함수에 한 같은 변경이 한 지문이 된다. 꼬리는 위쪽 줄이 밀려도 그대로이고, base 가 그 사이에 함수를
//!   끼워 꼬리가 바뀌면 「다름」이 된다 — 다시 보는 쪽이라 괜찮다.
//!
//! 한계: 같은 함수 안에서 앞뒤 문맥까지 같은 두 자리는 구별하지 못한다(range-diff 도 같다).
//!
//! 문맥 줄(앞뒤 3줄)은 그대로 둔다 — base 가 그 근처를 고쳤으면 지문이 달라지고, 그때는 다시 보는 쪽이 맞다.
//! 판정은 읽기 전용이다. 머지 승인(head 에 묶임)과는 무관하다.

/// 지문을 내지 않는 크기(바이트). 이보다 큰 diff 는 「모름」으로 둔다. 실제로는 gh 출력 상한(`local_merge` 의
/// `EXEC_MAX_BYTES`, 4MB)이 먼저 걸린다 — 부르는 쪽(`turn_pr_status`)이 그 상한에 닿은 출력을 버린다.
pub const DIFF_MAX_BYTES: usize = 8 * 1024 * 1024;

fn is_binary_section(lines: &[&str]) -> bool {
    lines
        .iter()
        .any(|l| l.starts_with("Binary files ") || *l == "GIT binary patch")
}

/// hunk 머리 `@@ -a[,b] +c[,d] @@[ 꼬리]` 에서 줄 번호만 지운 꼴(`@@` 또는 `@@ 꼬리`). 그 꼴이 아니면 None —
/// 부르는 쪽이 줄을 그대로 둔다(모르는 꼴은 지우지 않는 쪽).
fn hunk_header(l: &str) -> Option<String> {
    let rest = l.strip_prefix("@@ ")?;
    let (ranges, tail) = rest.split_once(" @@")?;
    let mut parts = ranges.split(' ');
    let is_range = |p: &str, sign: char| {
        p.strip_prefix(sign).is_some_and(|n| {
            !n.is_empty()
                && n.split(',').count() <= 2
                && n.split(',')
                    .all(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
        })
    };
    if !(is_range(parts.next()?, '-') && is_range(parts.next()?, '+') && parts.next().is_none()) {
        return None;
    }
    if tail.is_empty() {
        return Some("@@".to_string());
    }
    // 꼬리는 ` @@` 바로 뒤 빈칸 하나로 시작한다.
    tail.starts_with(' ').then(|| format!("@@{tail}"))
}

fn push_section(out: &mut String, lines: &[&str]) {
    let binary = is_binary_section(lines);
    // 머리(첫 `@@` 앞)에서만 `index` 줄을 지운다 — 본문의 ` index …`·`+index …` 는 첫 글자가 달라 걸리지 않지만,
    // 머리 밖에서 지우는 일은 아예 없게 한다.
    let mut in_header = true;
    for l in lines {
        if l.starts_with("@@ ") || *l == "@@" {
            in_header = false;
            if let Some(h) = hunk_header(l) {
                out.push_str(&h);
                out.push('\n');
                continue;
            }
        }
        if in_header && !binary && l.starts_with("index ") {
            continue;
        }
        out.push_str(l);
        out.push('\n');
    }
}

/// base 이동에 흔들리는 줄을 지운 diff. 파일 구획(`diff --git`)마다 따로 본다.
pub fn normalize(diff: &str) -> String {
    let mut out = String::with_capacity(diff.len());
    let mut section: Vec<&str> = Vec::new();
    for l in diff.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)) {
        if l.starts_with("diff --git ") && !section.is_empty() {
            push_section(&mut out, &section);
            section.clear();
        }
        section.push(l);
    }
    // 끝의 빈 줄(마지막 개행)은 구획에 넣지 않는다.
    while section.last() == Some(&"") {
        section.pop();
    }
    if !section.is_empty() {
        push_section(&mut out, &section);
    }
    out
}

/// 지문 — 정규화한 diff 의 sha256(hex 64자). 너무 크면 None.
pub fn diff_id(diff: &str) -> Option<String> {
    if diff.len() > DIFF_MAX_BYTES {
        return None;
    }
    let d = ring::digest::digest(&ring::digest::SHA256, normalize(diff).as_bytes());
    Some(d.as_ref().iter().map(|b| format!("{b:02x}")).collect())
}

/// 두 diff 가 같은 변경인가. 한쪽이라도 지문을 못 내면 None(모름 — 다시 보는 쪽).
pub fn same_change(reviewed: &str, current: &str) -> Option<bool> {
    Some(diff_id(reviewed)? == diff_id(current)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "diff --git a/src/x.rs b/src/x.rs\nindex 1111111..2222222 100644\n--- a/src/x.rs\n+++ b/src/x.rs\n@@ -10,3 +10,4 @@ fn old_ctx() {\n ctx\n+added\n ctx2\n ctx3\n";

    #[test]
    fn base_moved_only_is_same() {
        // base 가 위쪽에 줄을 더했다: blob·줄 번호만 다르고 함수 문맥은 그대로다.
        let b = A.replace("1111111..2222222", "aaaaaaa..bbbbbbb").replace(
            "@@ -10,3 +10,4 @@ fn old_ctx() {",
            "@@ -42,3 +57,4 @@ fn old_ctx() {",
        );
        assert_eq!(same_change(A, &b), Some(true));
        assert_eq!(diff_id(A).unwrap().len(), 64);
        // 꼬리 없는 hunk 머리(파일 맨 위, 줄 수 생략 꼴 포함)도 숫자만 다르면 같다.
        let top = A.replace("@@ -10,3 +10,4 @@ fn old_ctx() {", "@@ -1 +1,2 @@");
        let top2 = A.replace("@@ -10,3 +10,4 @@ fn old_ctx() {", "@@ -3,3 +3,4 @@");
        assert_eq!(same_change(&top, &top2), Some(true));
    }

    #[test]
    fn same_lines_in_another_function_are_different() {
        // 앞뒤 문맥·바뀐 줄이 글자까지 같아도 함수 문맥(꼬리)이 다르면 다른 변경이다 — 숫자가 같든 다르든.
        let other = A.replace(
            "@@ -10,3 +10,4 @@ fn old_ctx() {",
            "@@ -42,3 +42,4 @@ fn other() {",
        );
        assert_eq!(same_change(A, &other), Some(false));
        let same_numbers = A.replace("fn old_ctx() {", "fn other() {");
        assert_eq!(same_change(A, &same_numbers), Some(false));
        // 꼬리가 있는 것과 없는 것도 다르다.
        let no_tail = A.replace(" fn old_ctx() {", "");
        assert_eq!(same_change(A, &no_tail), Some(false));
        assert_eq!(
            normalize(A).lines().nth(3),
            Some("@@ fn old_ctx() {"),
            "숫자만 지우고 꼬리는 남긴다"
        );
        assert_eq!(normalize(&no_tail).lines().nth(3), Some("@@"));
    }

    #[test]
    fn unknown_hunk_header_shapes_are_kept_whole() {
        // hunk 머리 꼴이 아니면 숫자를 지우지 않는다(모르는 꼴은 「다름」 쪽).
        for odd in [
            "@@ -10,3 +10,4",
            "@@ nonsense @@ fn old_ctx() {",
            "@@ -10,3 +10,4 @@fn old_ctx() {",
            "@@ -1,2,3 +1 @@",
        ] {
            let x = A.replace("@@ -10,3 +10,4 @@ fn old_ctx() {", odd);
            assert!(normalize(&x).contains(&format!("{odd}\n")), "{odd}");
        }
    }

    #[test]
    fn content_or_context_change_is_different() {
        assert_eq!(same_change(A, &A.replace("+added", "+added!")), Some(false));
        assert_eq!(same_change(A, &A.replace(" ctx2", " ctx2x")), Some(false));
        assert_eq!(same_change(A, &A.replace("x.rs", "y.rs")), Some(false));
        assert_eq!(
            same_change(A, &format!("{A}{}", A.replace("x.rs", "z.rs"))),
            Some(false)
        );
        assert_eq!(same_change(A, ""), Some(false));
        assert_eq!(same_change("", ""), Some(true));
    }

    #[test]
    fn mode_and_rename_lines_count() {
        let m = A.replace(
            "index 1111111",
            "old mode 100644\nnew mode 100755\nindex 1111111",
        );
        assert_eq!(same_change(A, &m), Some(false));
    }

    #[test]
    fn binary_keeps_blob_ids() {
        let b1 = "diff --git a/i.png b/i.png\nindex 1111111..2222222 100644\nBinary files a/i.png and b/i.png differ\n";
        let b2 = b1.replace("2222222", "3333333");
        assert_eq!(same_change(b1, &b2), Some(false));
        assert_eq!(same_change(b1, b1), Some(true));
        // 이진 구획 옆의 글 구획은 여전히 blob 을 지운다.
        let mix1 = format!("{b1}{A}");
        let mix2 = format!("{b1}{}", A.replace("1111111..2222222", "9999999..8888888"));
        assert_eq!(same_change(&mix1, &mix2), Some(true));
    }

    #[test]
    fn body_lines_that_look_like_headers_are_kept() {
        // 본문에 더한 줄이 `index …` 로 보여도(앞에 `+`) 지우지 않고, 머리 밖의 맨 `index ` 줄도 지우지 않는다.
        let x = A.replace("+added", "+index 1..2");
        let y = A.replace("+added", "+index 3..4");
        assert_eq!(same_change(&x, &y), Some(false));
        let n = normalize(&format!("{A}index zzz\n"));
        assert!(n.contains("index zzz"));
        assert!(!n.contains("1111111"));
    }

    #[test]
    fn crlf_and_trailing_newline_do_not_matter_but_size_does() {
        assert_eq!(same_change(A, &A.replace('\n', "\r\n")), Some(true));
        assert_eq!(same_change(A, A.trim_end()), Some(true));
        let big = "x".repeat(DIFF_MAX_BYTES + 1);
        assert_eq!(diff_id(&big), None);
        assert_eq!(same_change(A, &big), None);
    }
}
