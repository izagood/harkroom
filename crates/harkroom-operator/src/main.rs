//! `harkroom-operator-rs` — 아직 `merge` 하나만 한다(A1). 나머지 서브커맨드는 TS 오퍼레이터가 맡는다.
use harkroom_operator::merge::{LinkEnv, REQUEST_TIMEOUT, merge_main};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("merge") => {
            let cwd = std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().into_owned());
            let link = LinkEnv::from_env(|k| std::env::var(k).ok(), cwd);
            let (line, exit) = merge_main(&args[1..], link, REQUEST_TIMEOUT);
            println!("{line}");
            std::process::exit(exit);
        }
        other => {
            eprintln!(
                "harkroom-operator-rs: {} is not implemented yet (only `merge`)",
                other.unwrap_or("(none)")
            );
            std::process::exit(2);
        }
    }
}
