//! `--version` 한 줄 — 오퍼레이터와 러너가 같은 꼴로 찍는다.
//!
//! 릴리스 묶음은 컴파일 때 `HARKROOM_BUILD_VERSION`(판)·`HARKROOM_BUILD_COMMIT`(커밋)을 굽는다. 굽지 않은 빌드(로컬·앱 번들의
//! 사이드카)는 crate 판만 알기에 그 사실을 줄에 적는다 — crate 판(`0.1.0`)을 릴리스 판처럼 읽지 않게.

/// 이 인자가 판을 묻는 것인가(`--version`·`-V`·`version`).
pub fn is_version_arg(arg: &str) -> bool {
    matches!(arg, "--version" | "-V" | "version")
}

/// `<이름> <판> (<커밋 앞 12자>)`. `build_version`·`commit` 은 컴파일 때 구운 값(없거나 비면 None 으로 본다).
pub fn version_line(
    name: &str,
    build_version: Option<&str>,
    crate_version: &str,
    commit: Option<&str>,
) -> String {
    let clean = |v: Option<&str>| {
        v.map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let mut line = match clean(build_version) {
        Some(v) => format!("{name} {v}"),
        None => format!("{name} {crate_version} (unreleased build)"),
    };
    if let Some(c) = clean(commit) {
        let short: String = c.chars().take(12).collect();
        line.push_str(&format!(" ({short})"));
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_build_prints_version_and_short_commit() {
        assert_eq!(
            version_line(
                "harkroom-operator",
                Some("0.5.42"),
                "0.1.0",
                Some("0123456789abcdef0123456789abcdef01234567")
            ),
            "harkroom-operator 0.5.42 (0123456789ab)"
        );
    }

    #[test]
    fn unbaked_build_says_so_instead_of_passing_the_crate_version_off() {
        assert_eq!(
            version_line("harkroom-runner", None, "0.1.0", None),
            "harkroom-runner 0.1.0 (unreleased build)"
        );
        assert_eq!(
            version_line("harkroom-runner", Some("  "), "0.1.0", Some("")),
            "harkroom-runner 0.1.0 (unreleased build)"
        );
    }

    #[test]
    fn only_the_three_spellings_ask_for_the_version() {
        for a in ["--version", "-V", "version"] {
            assert!(is_version_arg(a), "{a}");
        }
        for a in ["-v", "--Version", "serve", ""] {
            assert!(!is_version_arg(a), "{a}");
        }
    }
}
