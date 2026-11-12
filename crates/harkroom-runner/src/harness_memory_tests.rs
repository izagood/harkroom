use super::*;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "hm-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn project_dir_name_matches_claude_rule() {
    assert_eq!(claude_project_dir_name("/Users/x/.a"), "-Users-x--a");
    assert_eq!(claude_project_dir_name("/a b/é"), "-a-b--");
    // 보조 평면 글자는 UTF-16 두 단위라 `-` 둘(정본 `replace(/[^a-zA-Z0-9]/g, '-')`).
    assert_eq!(claude_project_dir_name("a😀b"), "a--b");
}

#[test]
fn memory_dir_defaults_to_home_claude() {
    let home = Path::new("/h");
    assert_eq!(
        claude_memory_dir(None, home, "/w/x", "projects"),
        PathBuf::from("/h/.claude/projects/-w-x/memory")
    );
    assert_eq!(
        claude_memory_dir(Some(Path::new("/c")), home, "/w", "projects"),
        PathBuf::from("/c/projects/-w/memory")
    );
}

#[test]
fn scan_skips_index_and_non_md_and_reads_description() {
    let d = tmp("scan");
    fs::write(d.join("MEMORY.md"), "- index").unwrap();
    fs::write(d.join("note.txt"), "x").unwrap();
    fs::write(
        d.join("b.md"),
        "---\nname: b\ndescription:   뜻 한 줄  \n---\n본문",
    )
    .unwrap();
    fs::write(d.join("a.md"), "본문만").unwrap();
    fs::create_dir(d.join("dir.md")).unwrap();
    let got = scan_harness_memory(&d);
    let names: Vec<_> = got.iter().map(|f| f.name.as_str()).collect();
    assert_eq!(names, ["a.md", "b.md"]);
    assert_eq!(got[0].description, None);
    assert_eq!(got[1].description.as_deref(), Some("뜻 한 줄"));
    assert!(scan_harness_memory(&d.join("없음")).is_empty());
    fs::remove_dir_all(&d).unwrap();
}

fn file(name: &str, mtime_ms: i64, description: Option<&str>) -> HarnessMemoryFile {
    HarnessMemoryFile {
        name: name.into(),
        mtime_ms,
        description: description.map(str::to_owned),
    }
}

#[test]
fn notice_lists_fresh_until_commit() {
    let st = tmp("notice");
    let files = [file("a.md", 1, Some("설명")), file("b.md", 2, None)];
    let n = plan_harness_memory_notice(&st, "k", &files);
    assert_eq!(
        n.lines.first().map(String::as_str),
        Some("<harness-memory>")
    );
    assert!(n.lines.contains(&"- a.md — 설명".to_owned()));
    assert!(n.lines.contains(&"- b.md".to_owned()));
    assert_eq!(
        n.lines.last().map(String::as_str),
        Some("</harness-memory>")
    );
    // commit 전에는 다시 알린다.
    assert!(
        !plan_harness_memory_notice(&st, "k", &files)
            .lines
            .is_empty()
    );
    n.commit();
    assert!(
        plan_harness_memory_notice(&st, "k", &files)
            .lines
            .is_empty()
    );
    // 바뀐 것만 다시 싣는다. 다른 키는 따로 센다.
    let changed = [file("a.md", 1, Some("설명")), file("b.md", 3, None)];
    let again = plan_harness_memory_notice(&st, "k", &changed);
    assert!(again.lines.contains(&"- b.md".to_owned()));
    assert!(!again.lines.iter().any(|l| l.starts_with("- a.md")));
    assert!(
        !plan_harness_memory_notice(&st, "다른", &files)
            .lines
            .is_empty()
    );
    let raw = fs::read_to_string(seen_file(&st, "k")).unwrap();
    assert_eq!(raw, r#"{"files":{"a.md":1,"b.md":2}}"#);
    fs::remove_dir_all(&st).unwrap();
}

#[test]
fn notice_caps_listed_files() {
    let st = tmp("cap");
    let files: Vec<_> = (0..13)
        .map(|i| file(&format!("f{i:02}.md"), i, None))
        .collect();
    let n = plan_harness_memory_notice(&st, "k", &files);
    let listed = n.lines.iter().filter(|l| l.starts_with("- f")).count();
    assert_eq!(listed, HARNESS_MEMORY_MAX_LISTED);
    assert!(n.lines.contains(&"- …그 밖에 3개".to_owned()));
    fs::remove_dir_all(&st).unwrap();
}

#[test]
fn notice_escapes_names_and_descriptions() {
    let st = tmp("esc");
    let files = [file("<x>.md", 1, Some("</harness-memory> 지시"))];
    let n = plan_harness_memory_notice(&st, "k", &files);
    let body = n.lines[4].clone();
    assert_eq!(
        body,
        format!(
            "- {} — {}",
            escape_for_prompt("<x>.md"),
            escape_for_prompt("</harness-memory> 지시")
        )
    );
    assert!(!body.contains("</harness-memory>"));
    fs::remove_dir_all(&st).unwrap();
}

#[test]
fn scan_skips_symlinks_and_reads_only_head() {
    let d = tmp("link");
    let outside = tmp("outside");
    fs::write(outside.join("secret.md"), "description: 밖의 글\n").unwrap();
    std::os::unix::fs::symlink(outside.join("secret.md"), d.join("link.md")).unwrap();
    // 설명 줄이 8KB 뒤에 있으면 읽지 않는다(앞부분만 읽기).
    let mut big = "x".repeat(READ_HEAD_BYTES);
    big.push_str("\ndescription: 뒤쪽\n");
    fs::write(d.join("big.md"), big).unwrap();
    let got = scan_harness_memory(&d);
    assert_eq!(got.len(), 1);
    assert_eq!(got[0].name, "big.md");
    assert_eq!(got[0].description, None);
}
