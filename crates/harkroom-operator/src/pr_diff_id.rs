//! PR diff 의 지문 — 「검토한 것과 지금 것이 같은 변경인가」를 head sha 대신 **diff 내용**으로 견준다.
//!
//! base 를 merge 해서 head 만 바뀐 PR 은 변경이 그대로인데 head 가 달라 재검토가 걸린다. 지문은 unified diff 에서
//! 「같은 변경이어도 base 가 움직이면 달라지는 것」만 지우고 sha256 을 낸다:
//! - `index <blob>..<blob>` 줄 — 파일의 다른 자리가 base 에서 바뀌면 blob 이 달라진다. **이진 파일은 지우지 않는다**
//!   (내용이 diff 에 안 실려 blob id 가 유일한 증거다).
//! - `@@ -a,b +c,d @@ <함수 문맥>` — 줄 번호와 꼬리 문맥은 위쪽이 밀리면 달라진다. `@@` 만 남긴다.
//!
//! 문맥 줄(앞뒤 3줄)은 그대로 둔다 — base 가 그 근처를 고쳤으면 지문이 달라지고, 그때는 다시 보는 쪽이 맞다.
//! 판정은 읽기 전용이다. 머지 승인(head 에 묶임)과는 무관하다.

/// 지문을 내지 않는 크기(바이트). 이보다 큰 diff 는 「모름」으로 둔다.
pub const DIFF_MAX_BYTES: usize = 8 * 1024 * 1024;

fn is_binary_section(lines: &[&str]) -> bool {
    lines
        .iter()
        .any(|l| l.starts_with("Binary files ") || *l == "GIT binary patch")
}

fn push_section(out: &mut String, lines: &[&str]) {
    let binary = is_binary_section(lines);
    // 머리(첫 `@@` 앞)에서만 `index` 줄을 지운다 — 본문의 ` index …`·`+index …` 는 첫 글자가 달라 걸리지 않지만,
    // 머리 밖에서 지우는 일은 아예 없게 한다.
    let mut in_header = true;
    for l in lines {
        if l.starts_with("@@ ") || *l == "@@" {
            in_header = false;
            out.push_str("@@\n");
            continue;
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
        // base 가 위쪽에 줄을 더했다: blob·줄 번호·함수 문맥만 다르다.
        let b = A.replace("1111111..2222222", "aaaaaaa..bbbbbbb").replace(
            "@@ -10,3 +10,4 @@ fn old_ctx() {",
            "@@ -42,3 +42,4 @@ fn other() {",
        );
        assert_eq!(same_change(A, &b), Some(true));
        assert_eq!(diff_id(A).unwrap().len(), 64);
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
