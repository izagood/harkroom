//! 푸시 발송 sweep(`loops::push`)이 TS `pushJobs.ts::createPushSweeper` 와 같은 일을 하는지 실제 Postgres 로 본다.
//! `HARKROOM_TEST_DATABASE_URL` 이 없으면 건너뛴다(CI 는 `packages/server/test/rustFrontDb.test.ts` 가 넘긴다).
//! 장면(사람·채널·글·기기)은 TS 가 TS 서비스로 깐다 — 여기서는 sweep 한 번을 돌리고 가짜 전송부가 받은 것을 찍는다.
//! - `HARKROOM_TEST_WRITE_DATABASE_URL` 이 있으면 sweep 은 그 역할(`PUSH_PRIVILEGES` 만 가진 쓰기 역할)로 돈다.
//! - `HARKROOM_PUSH_LOOP_REPLY=<status>[:<reason>]` 이면 장면 모드 — 그 답을 주는 가짜로 sweep 한 번, 받은 것을
//!   `push-loop sent <json>` 줄로, 끝에 `push-loop done swept <n> degraded <bool>` 를 찍는다(판정은 TS 쪽).
//!   `HARKROOM_PUSH_LOOP_KEYS_DIR`(+`HARKROOM_PUSH_LOOP_KEY_ID`)이 있으면 그 키링으로 누출 검사를 켠다.
//! - `HARKROOM_PUSH_DUAL=1` 이면 이중 실행 모드 — TS sweep 과 **동시에** 때가 된 job 이 없을 때까지 쓸고 보낸 수를 찍는다.
use harkroom_server::loops::push::{LeakGuard, PUSH_PRIVILEGES, PushSender, PushSweeper};
use harkroom_server::push::apns::{ApnsResult, ApnsSendInput};
use sqlx::PgPool;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::future::Future;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
struct Fake {
    reply: ApnsResult,
    sent: Arc<Mutex<Vec<serde_json::Value>>>,
}

impl PushSender for Fake {
    fn send<'a>(
        &'a self,
        input: ApnsSendInput<'a>,
    ) -> impl Future<Output = ApnsResult> + Send + 'a {
        self.sent.lock().unwrap().push(serde_json::json!({
            "token": input.token,
            "env": format!("{:?}", input.env),
            "payload": input.payload,
            "collapseId": input.collapse_id,
        }));
        let r = self.reply.clone();
        async move { r }
    }
}

fn fake(reply: &str) -> Fake {
    let (status, reason) = match reply.split_once(':') {
        Some((s, r)) => (s, Some(r.to_string())),
        None => (reply, None),
    };
    Fake {
        reply: ApnsResult {
            status: status.parse().expect("status"),
            reason,
        },
        sent: Arc::new(Mutex::new(vec![])),
    }
}

async fn due_jobs(pool: &PgPool) -> i64 {
    sqlx::query_scalar("select count(*) from push_job where not_before <= now()")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn push_loop_like_ts() {
    let Ok(url) = std::env::var("HARKROOM_TEST_DATABASE_URL") else {
        eprintln!("skip: HARKROOM_TEST_DATABASE_URL unset");
        return;
    };
    let write_url =
        std::env::var("HARKROOM_TEST_WRITE_DATABASE_URL").unwrap_or_else(|_| url.clone());
    let admin = PgPool::connect(&url).await.unwrap();
    let opts = PgConnectOptions::from_str(&write_url)
        .unwrap()
        .application_name("harkroom-push-dual");
    let w = PgPoolOptions::new()
        .max_connections(3)
        .connect_with(opts)
        .await
        .unwrap();
    let missing = harkroom_server::write::missing_in(&w, PUSH_PRIVILEGES, &[])
        .await
        .unwrap();
    assert!(missing.is_empty(), "write role lacks {missing:?}");

    if std::env::var("HARKROOM_PUSH_DUAL").is_ok() {
        let f = fake("200");
        let s = PushSweeper::new(w.clone(), f.clone(), LeakGuard::off());
        let mut overlapped = 0u64;
        // TS 가 이 연결을 본 뒤에 job 을 때가 되게 한다 — 그때까지 기다린다(빈 큐에서 바로 끝나지 않게).
        let t0 = std::time::Instant::now();
        while due_jobs(&admin).await == 0 {
            assert!(t0.elapsed().as_secs() < 120, "no due push_job");
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        loop {
            let before = due_jobs(&admin).await;
            let n = s.sweep().await.unwrap();
            if before > 0 {
                overlapped += 1;
            }
            if n == 0 && due_jobs(&admin).await == 0 {
                break;
            }
        }
        let sent = f.sent.lock().unwrap();
        for p in sent.iter() {
            println!("push-dual sent {}", p["collapseId"].as_str().unwrap_or(""));
        }
        println!("push-dual rust sent {} overlapped {overlapped}", sent.len());
        return;
    }

    if let Ok(reply) = std::env::var("HARKROOM_PUSH_LOOP_REPLY") {
        let guard = match std::env::var("HARKROOM_PUSH_LOOP_KEYS_DIR") {
            Ok(dir) => {
                let kid = std::env::var("HARKROOM_PUSH_LOOP_KEY_ID").ok();
                let g = LeakGuard::load(Some(&dir), kid.as_deref()).unwrap();
                assert!(g.is_on());
                g
            }
            Err(_) => LeakGuard::off(),
        };
        let f = fake(&reply);
        let s = PushSweeper::new(w.clone(), f.clone(), guard);
        let n = s.sweep().await.unwrap();
        for p in f.sent.lock().unwrap().iter() {
            println!("push-loop sent {p}");
        }
        println!("push-loop done swept {n} degraded {}", s.health.degraded());
        return;
    }

    // 장면 없이 — 빈 큐면 아무것도 보내지 않고, 소리 기록 정리도 권한 안에서 돈다.
    let f = fake("200");
    let s = PushSweeper::new(w.clone(), f.clone(), LeakGuard::off());
    assert_eq!(s.sweep().await.unwrap(), 0);
    assert!(f.sent.lock().unwrap().is_empty());
    assert!(!s.health.degraded());
}
