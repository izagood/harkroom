//! 끝에서 끝 시험(S5.1d)용 쓰는 쪽 — 표준 입력의 JSON 한 줄마다 **트랜잭션 하나**로 [`harkroom_bus::publish`] 를 부르고
//! 커밋한 뒤 outbox id 를 한 줄 찍는다. 줄 순서 = 커밋 순서다(Rust 라우트가 created 를 커밋한 뒤 updated 를 커밋하는 것과 같은 꼴).
//!
//! 받는 쪽 시험은 `packages/server/test/eventBusRustE2e.test.ts` 다 — 이 바이너리를 띄워 TS 서버의 WS 에 도착한 순서를 본다.
//! 접속 주소는 `HARKROOM_BUS_DATABASE_URL` 로만 받는다(인자에 넣으면 프로세스 목록에 비밀번호가 보인다).

use sqlx::Connection;
use sqlx::postgres::PgConnection;
use std::io::{BufRead, Write};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let url = std::env::var("HARKROOM_BUS_DATABASE_URL")
        .map_err(|_| "HARKROOM_BUS_DATABASE_URL 이 없다")?;
    let mut conn = PgConnection::connect(&url).await?;
    let stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let event: serde_json::Value = serde_json::from_str(&line)?;
        let mut tx = conn.begin().await?;
        let id = harkroom_bus::publish(&mut tx, &event).await?;
        tx.commit().await?;
        writeln!(stdout.lock(), "{id}")?;
    }
    conn.close().await?;
    Ok(())
}
