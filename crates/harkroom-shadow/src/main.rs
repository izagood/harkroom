//! `harkroom-shadow <녹화 폴더 또는 .cast 파일>...` — 집계 JSON 한 줄을 stdout 에 낸다.
//! 불일치가 있으면 exit 1. 보고에는 화면 글·파일 이름이 없다(녹화는 로컬에만 둔다).
use std::path::{Path, PathBuf};

fn collect(p: &Path, out: &mut Vec<PathBuf>) {
    if p.is_dir() {
        if let Ok(rd) = std::fs::read_dir(p) {
            let mut v: Vec<_> = rd.flatten().map(|e| e.path()).collect();
            v.sort();
            for q in v {
                collect(&q, out);
            }
        }
    } else if p.extension().is_some_and(|e| e == "cast") {
        out.push(p.to_path_buf());
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: harkroom-shadow <dir|file.cast>...");
        std::process::exit(2);
    }
    let mut files = Vec::new();
    for a in &args {
        collect(Path::new(a), &mut files);
    }
    let mut reports = Vec::new();
    let mut unreadable = 0usize;
    for f in &files {
        match std::fs::read_to_string(f)
            .map_err(|e| e.to_string())
            .and_then(|t| harkroom_shadow::parse_cast(&t))
        {
            Ok(c) => reports.push(harkroom_shadow::compare(&c)),
            Err(_) => unreadable += 1,
        }
    }
    let mut s = harkroom_shadow::summarize(&reports);
    s["unreadableCasts"] = unreadable.into();
    println!("{s}");
    let bad = s["mismatched"].as_u64().unwrap_or(0) > 0;
    std::process::exit(i32::from(bad));
}
