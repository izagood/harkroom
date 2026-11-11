//! `harkroom-operator-rs` — `merge`(A1)·`serve`(A2, 앱 소켓 서버)·`mcp-bridge`(s21b-2b)·`api`(3d-3a)·`hook`(3d-3b-2a)만 한다.
//! 나머지는 TS 오퍼레이터가 맡는다.
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use harkroom_operator::hook_cli::HOOK_TIMEOUT_MS;
use harkroom_operator::hook_run::{
    HookArgs, HookIo, HookOutcome, hook_fallback, parse_hook_args, run_hook,
};
use harkroom_operator::merge::{LinkEnv, REQUEST_TIMEOUT, call_operator_tool_as, merge_main};
use harkroom_proto::p1::RunnerLinkKind;

/// 결과를 쓰고 끝내는 것은 한 번뿐이다 — 본 갈래와 시한 갈래가 겹치면 먼저 잡은 쪽만 쓴다.
static FINISHED: AtomicBool = AtomicBool::new(false);

fn finish(o: HookOutcome) -> ! {
    if FINISHED.swap(true, Ordering::SeqCst) {
        // 다른 갈래가 쓰고 끝내는 중이다 — 그쪽의 exit 를 기다린다.
        loop {
            std::thread::park();
        }
    }
    // 동기로 쓴다(잘린 채 끝나면 「결정 없음」이 된다). 써지지 않아도 종료 코드가 막는다.
    if let Some(s) = o.stdout {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(s.as_bytes());
        let _ = out.flush();
    }
    if let Some(s) = o.stderr {
        let _ = std::io::stderr().lock().write_all(s.as_bytes());
    }
    std::process::exit(o.exit);
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `hook <event>` — 시한(10초)·패닉도 그 hook 의 실패 갈래(`hook_fallback`)로 끝낸다. 막는 hook 이 패닉 종료 코드(101)로
/// 끝나면 하네스가 막지 않고 넘기므로(fail-open) 패닉도 반드시 이 길로 온다.
fn hook_entry(argv: &[String]) -> ! {
    let args: HookArgs = parse_hook_args(argv);
    let env = |k: &str| std::env::var(k).ok();
    let temp = std::env::temp_dir();
    {
        let args = args.clone();
        let temp = temp.clone();
        std::panic::set_hook(Box::new(move |_| {
            finish(hook_fallback(
                &args,
                &|k| std::env::var(k).ok(),
                &temp,
                now_ms(),
                "uncaught",
            ));
        }));
    }
    {
        let args = args.clone();
        let temp = temp.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(HOOK_TIMEOUT_MS));
            finish(hook_fallback(
                &args,
                &|k| std::env::var(k).ok(),
                &temp,
                now_ms(),
                "timeout",
            ));
        });
    }
    let cwd = std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let link = LinkEnv::from_env(env, cwd);
    let ask = |name: &str, a: serde_json::Value| {
        link.as_ref()
            .map(|l| call_operator_tool_as(l, name, a, REQUEST_TIMEOUT, RunnerLinkKind::Hook))
    };
    let mut stdin = std::io::stdin().lock();
    let mut io = HookIo {
        env: &env,
        stdin: &mut stdin,
        now_ms: now_ms(),
        temp_dir: temp,
        ask: &ask,
    };
    finish(run_hook(&args, &mut io))
}

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
        Some("hook") => hook_entry(&args[1..]),
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
                "harkroom-operator-rs: {} is not implemented yet (only `merge`, `api`, `hook`, `mcp-bridge` and `serve`)",
                other.unwrap_or("(none)")
            );
            std::process::exit(2);
        }
    }
}
