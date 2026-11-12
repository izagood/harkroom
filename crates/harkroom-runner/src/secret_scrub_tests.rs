use super::*;
use std::os::unix::fs::symlink;

// 토큰 모양 리터럴은 조립한다(gitleaks).
fn value() -> String {
    format!("ghp_{}", "d".repeat(36))
}
fn multi() -> String {
    [
        "-----BEGIN TEST KEY-----".to_string(),
        "S".repeat(40),
        "T".repeat(40),
        "-----END TEST KEY-----".to_string(),
    ]
    .join("\n")
}
fn tmpdir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "hk-scrub-{tag}-{}-{}",
        std::process::id(),
        TMP_SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn plain_json_url_base64_masked_and_short_ignored() {
    let v = value();
    let needles = scrub_needles(v.as_bytes());
    let line = serde_json::json!({
        "a": format!("x {v} y"),
        "b": STANDARD.encode(v.as_bytes()),
        "c": encode_uri_component(&format!("{v}!")),
    })
    .to_string();
    let (text, replaced) = scrub_text(&line, &needles);
    assert_eq!(replaced, 3);
    assert!(!text.contains(&v));
    let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
    assert_eq!(parsed["a"], "x *** y");
    assert!(scrub_needles(b"short").is_empty());
}

#[test]
fn multiline_value_masks_escaped_whole_and_lines_jsonl_stays_json() {
    let m = multi();
    let needles = scrub_needles(m.as_bytes());
    let jsonl = [
        serde_json::json!({"type": "tool_result", "content": format!("cat k.pem\n{m}\n")}).to_string(),
        serde_json::json!({"type": "assistant", "text": format!("the second line is {}", "S".repeat(40))})
            .to_string(),
    ]
    .join("\n");
    let (text, _) = scrub_text(&jsonl, &needles);
    assert!(!text.contains(&"S".repeat(40)));
    assert!(!text.contains(&"T".repeat(40)));
    for l in text.split('\n') {
        serde_json::from_str::<serde_json::Value>(l).unwrap();
    }
}

#[test]
fn encode_uri_component_matches_js() {
    assert_eq!(encode_uri_component("a b/c?d=e&f"), "a%20b%2Fc%3Fd%3De%26f");
    assert_eq!(encode_uri_component("-_.!~*'()"), "-_.!~*'()");
    assert_eq!(encode_uri_component("가"), "%EA%B0%80");
}

#[test]
fn file_rewritten_keeping_mode_symlink_untouched() {
    let v = value();
    let dir = tmpdir("file");
    let f = dir.join("s.jsonl");
    fs::write(&f, format!("{}\n", serde_json::json!({"t": v}))).unwrap();
    fs::set_permissions(&f, fs::Permissions::from_mode(0o600)).unwrap();
    assert_eq!(scrub_file(&f, &scrub_needles(v.as_bytes())).unwrap(), 1);
    assert_eq!(fs::read_to_string(&f).unwrap(), "{\"t\":\"***\"}\n");
    assert_eq!(
        fs::metadata(&f).unwrap().permissions().mode() & 0o777,
        0o600
    );
    let target = dir.join("target.txt");
    fs::write(&target, &v).unwrap();
    symlink(&target, dir.join("link.jsonl")).unwrap();
    assert_eq!(
        scrub_file(&dir.join("link.jsonl"), &scrub_needles(v.as_bytes())).unwrap(),
        0
    );
    assert_eq!(fs::read_to_string(&target).unwrap(), v);
    assert_eq!(
        scrub_file(&dir.join("missing.jsonl"), &scrub_needles(v.as_bytes())).unwrap(),
        0
    );
    // 임시 파일이 남지 않는다.
    let left: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name())
        .collect();
    assert!(
        left.iter()
            .all(|n| !n.to_string_lossy().ends_with(".scrub")),
        "{left:?}"
    );
}

#[test]
fn non_utf8_file_still_masked_other_bytes_kept() {
    let v = value();
    let dir = tmpdir("bin");
    let f = dir.join("mixed.jsonl");
    let mut data = vec![0xff, 0xfe, b'\n'];
    data.extend_from_slice(v.as_bytes());
    data.push(0x80);
    fs::write(&f, &data).unwrap();
    assert_eq!(scrub_file(&f, &scrub_needles(v.as_bytes())).unwrap(), 1);
    assert_eq!(
        fs::read(&f).unwrap(),
        [&[0xff, 0xfe, b'\n'][..], b"***", &[0x80]].concat()
    );
}

#[test]
fn t1_session_dir_tool_results_and_subagents_masked_symlinks_and_depth_skipped() {
    let v = value();
    let root = tmpdir("sess");
    let sess = root.join("11111111-2222-4333-8444-555555555555");
    fs::create_dir_all(sess.join("tool-results")).unwrap();
    fs::create_dir_all(sess.join("subagents")).unwrap();
    let tool = sess.join("tool-results").join("toolu_01.txt");
    let sub = sess.join("subagents").join("agent-1.jsonl");
    fs::write(&tool, format!("long output\n{v}\nmore")).unwrap();
    fs::write(&sub, format!("{}\n", serde_json::json!({"text": v}))).unwrap();
    let outside = root.join("outside.txt");
    fs::write(&outside, &v).unwrap();
    symlink(&outside, sess.join("tool-results").join("link.txt")).unwrap();
    symlink(&root, sess.join("loop")).unwrap();
    let mut deep = sess.clone();
    for i in 0..SCRUB_MAX_DEPTH {
        deep = deep.join(format!("d{i}"));
    }
    fs::create_dir_all(&deep).unwrap();
    fs::write(deep.join("too-deep.txt"), &v).unwrap();
    let mut skipped = Vec::new();
    let n = scrub_path(&sess, &scrub_needles(v.as_bytes()), &mut |p| {
        skipped.push(p.to_path_buf())
    })
    .unwrap();
    assert_eq!(n, 2);
    assert_eq!(fs::read_to_string(&tool).unwrap(), "long output\n***\nmore");
    assert!(!fs::read_to_string(&sub).unwrap().contains(&v));
    assert_eq!(fs::read_to_string(&outside).unwrap(), v);
    assert_eq!(fs::read_to_string(deep.join("too-deep.txt")).unwrap(), v);
    assert!(skipped.is_empty());
    assert_eq!(
        scrub_path(
            &root.join("nope"),
            &scrub_needles(v.as_bytes()),
            &mut |_| {}
        )
        .unwrap(),
        0
    );
}

#[test]
fn over_64mb_skipped_with_path_reported() {
    let v = value();
    let dir = tmpdir("big");
    let big = dir.join("big.txt");
    let f = fs::File::create(&big).unwrap();
    f.set_len(SCRUB_MAX_FILE_BYTES + 1).unwrap(); // 희소 파일
    let mut skipped = Vec::new();
    assert_eq!(
        scrub_path(&dir, &scrub_needles(v.as_bytes()), &mut |p| skipped
            .push(p.to_path_buf()))
        .unwrap(),
        0
    );
    assert_eq!(skipped, vec![big]);
}

#[test]
fn turn_keys_scrubbed_across_paths_and_empty_needles_noop() {
    let bridge = format!("hkt_bridge_{}", "b".repeat(30));
    let shell = format!("hkt_shell_{}", "s".repeat(30));
    let needles = turn_key_needles(&[&bridge, &shell]);
    let dir = tmpdir("keys");
    let a = dir.join("a.jsonl");
    let b = dir.join("sess");
    fs::create_dir_all(&b).unwrap();
    fs::write(&a, format!("{bridge} {shell}")).unwrap();
    fs::write(b.join("t.txt"), &shell).unwrap();
    assert_eq!(
        scrub_turn_keys("k", &[a.clone(), b.clone(), dir.join("missing")], &needles),
        3
    );
    assert_eq!(fs::read_to_string(&a).unwrap(), "*** ***");
    assert_eq!(scrub_turn_keys("k", &[a], &[]), 0);
}

#[test]
fn needles_longest_first() {
    let n = scrub_needles(value().as_bytes());
    assert!(n.windows(2).all(|w| w[0].len() >= w[1].len()));
}
