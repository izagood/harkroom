//! `harkroom-runner-rs` — B3a 기동 뼈대: 설정을 읽고 오퍼레이터 링크에 붙는다. 폴 루프·턴은 B3d 에서 붙는다.

use harkroom_runner::config::{load_config, process_env};
use harkroom_runner::link::{LinkClient, LinkOptions};
use std::time::Duration;

fn main() {
    let config = match load_config(&process_env()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            std::process::exit(1);
        }
    };
    let mut opts = LinkOptions::new(config.operator_link.clone());
    opts.provider_lane = Some(std::env::var("HARKROOM_PROVIDER_LANE").as_deref() == Ok("1"));
    let link = LinkClient::new(opts);
    link.start();
    // 정본 main.ts 와 같다: 10초 안에 못 붙어도 기동은 계속된다(뒤의 호출이 status 0 으로 거절된다).
    if !link.when_connected(Duration::from_secs(10)) {
        eprintln!("오퍼레이터 링크가 10초 안에 붙지 않았다 — 계속 재시도한다");
    }
    println!(
        "harkroom-runner-rs: 오퍼레이터 {} (runner {}) — B3a 뼈대, 턴은 아직 돌지 않는다",
        config.operator_link.socket_path, config.operator_link.runner_id
    );
    // 턴 코어가 붙기 전까지는 링크만 붙잡고 있는다(오퍼레이터가 SIGTERM 으로 거둔다).
    loop {
        std::thread::park();
    }
}
