//! `harkroom-operator-rs` — `merge`(A1)·`serve`(A2, 앱 소켓 서버)·`mcp-bridge`(s21b-2b)만 한다. 나머지는 TS 오퍼레이터가 맡는다.
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
        Some("api") => {
            let cwd = std::env::current_dir().ok();
            let link = LinkEnv::from_env(
                |k| std::env::var(k).ok(),
                cwd.as_ref().map(|p| p.to_string_lossy().into_owned()),
            );
            let base = cwd.unwrap_or_default();
            let (line, exit) = harkroom_operator::api_cli::api_main(
                &args[1..],
                link,
                |p| std::fs::read(base.join(p)),
                REQUEST_TIMEOUT,
            );
            println!("{line}");
            std::process::exit(exit);
        }
        Some("mcp-bridge") => {
            std::process::exit(harkroom_operator::mcp_bridge::mcp_bridge_main());
        }
        Some("serve") => {
            let (line, exit) =
                harkroom_operator::serve::serve_main(&args[1..], std::env::var("HOME").ok());
            println!("{line}");
            std::process::exit(exit);
        }
        other => {
            eprintln!(
                "harkroom-operator-rs: {} is not implemented yet (only `merge`, `api`, `mcp-bridge` and `serve`)",
                other.unwrap_or("(none)")
            );
            std::process::exit(2);
        }
    }
}
