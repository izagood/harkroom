//! `harkroom-operator-rs` — `merge`(A1)와 `serve`(A2, 앱 소켓 서버)만 한다. 나머지는 TS 오퍼레이터가 맡는다.
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
        Some("serve") => {
            let (line, exit) =
                harkroom_operator::serve::serve_main(&args[1..], std::env::var("HOME").ok());
            println!("{line}");
            std::process::exit(exit);
        }
        other => {
            eprintln!(
                "harkroom-operator-rs: {} is not implemented yet (only `merge` and `serve`)",
                other.unwrap_or("(none)")
            );
            std::process::exit(2);
        }
    }
}
