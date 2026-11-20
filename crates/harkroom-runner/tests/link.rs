//! 링크 클라이언트를 가짜 오퍼레이터(진짜 unix 소켓)에 붙여 본다 — 정본 `relay.test.ts` 의 순서 약속.

use harkroom_proto::p1::RunnerLinkResponse;
use harkroom_runner::config::OperatorLink;
use harkroom_runner::link::{
    LINK_DOWN_MESSAGE, LINK_REJECTED_GIVE_UP, LinkClient, LinkOptions, LinkRequest,
};
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;

fn sock_path(tag: &str) -> PathBuf {
    // unix 소켓 경로 상한(104바이트, mac) 때문에 /tmp 바로 아래.
    let p = PathBuf::from(format!("/tmp/hkr-{tag}-{}.sock", std::process::id()));
    let _ = std::fs::remove_file(&p);
    p
}

fn opts(path: &std::path::Path) -> LinkOptions {
    let mut o = LinkOptions::new(OperatorLink {
        socket_path: path.to_string_lossy().into(),
        runner_id: "r1".into(),
        secret: "s1".into(),
    });
    o.initial_backoff_ms = 5;
    o.log = Box::new(|_| {});
    o
}

fn read_json(r: &mut BufReader<UnixStream>) -> Value {
    let mut line = String::new();
    r.read_line(&mut line).unwrap();
    serde_json::from_str(&line).unwrap()
}

#[test]
fn hello_then_announce_then_request_roundtrip() {
    let path = sock_path("rt");
    let listener = UnixListener::bind(&path).unwrap();
    let mut o = opts(&path);
    o.provider_lane = Some(false);
    o.announce_sessions = Box::new(|| vec![json!({"sessionId": "x"})]);
    let link = LinkClient::new(o);

    // 링크 전에는 즉시 status 0.
    match link.request(LinkRequest::Http {
        method: "GET".into(),
        path: "/api/me".into(),
        body: None,
        content_type: None,
    }) {
        RunnerLinkResponse::HttpResponse {
            status: 0, body, ..
        } => assert_eq!(body, LINK_DOWN_MESSAGE),
        other => panic!("{other:?}"),
    }

    link.start();
    let (s, _) = listener.accept().unwrap();
    let mut r = BufReader::new(s.try_clone().unwrap());
    let hello = read_json(&mut r);
    assert_eq!(
        hello,
        json!({"type":"hello","version":1,"role":"runner","runnerId":"r1","secret":"s1"})
    );
    let announce = read_json(&mut r);
    assert_eq!(
        announce,
        json!({"type":"announce","sessions":[{"sessionId":"x"}],"caps":["input","interactive","attention","cancel"]})
    );
    assert_eq!(
        read_json(&mut r),
        json!({"type":"providerLane.mode","on":false})
    );
    assert!(link.when_connected(Duration::from_secs(2)));

    let l2 = Arc::clone(&link);
    let h = std::thread::spawn(move || {
        l2.request(LinkRequest::Mcp {
            payload: json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
        })
    });
    let req = read_json(&mut r);
    assert_eq!(req["type"], "mcp.request");
    assert_eq!(req["payload"]["method"], "ping");
    let id = req["id"].as_str().unwrap().to_string();
    let mut w = s;
    // 모르는 id 의 응답은 버린다, 그다음 진짜 응답.
    writeln!(
        w,
        "{}",
        json!({"type":"mcp.response","id":"nope","messages":[]})
    )
    .unwrap();
    writeln!(
        w,
        "{}",
        json!({"type":"mcp.response","id":id,"messages":[{"ok":1}]})
    )
    .unwrap();
    match h.join().unwrap() {
        RunnerLinkResponse::McpResponse { messages, .. } => {
            assert_eq!(messages, vec![json!({"ok":1})])
        }
        other => panic!("{other:?}"),
    }
    link.stop();
    let _ = std::fs::remove_file(&path);
}

#[test]
fn pending_requests_fail_on_disconnect_and_poll_stopped_is_sticky() {
    let path = sock_path("dc");
    let listener = UnixListener::bind(&path).unwrap();
    let link = LinkClient::new(opts(&path));
    link.start();
    let (s, _) = listener.accept().unwrap();
    let mut r = BufReader::new(s.try_clone().unwrap());
    read_json(&mut r); // hello
    read_json(&mut r); // announce
    assert!(link.when_connected(Duration::from_secs(2)));
    let l2 = Arc::clone(&link);
    let h = std::thread::spawn(move || {
        l2.request(LinkRequest::Http {
            method: "POST".into(),
            path: "/x".into(),
            body: Some("{}".into()),
            content_type: None,
        })
    });
    assert_eq!(read_json(&mut r)["type"], "http.forward");
    link.notify_poll_stopped(&[7], &[]);
    assert_eq!(
        read_json(&mut r),
        json!({"type":"runner.pollStopped","holding":[7]})
    );
    drop(r);
    s.shutdown(std::net::Shutdown::Both).unwrap();
    match h.join().unwrap() {
        RunnerLinkResponse::HttpResponse {
            status: 0, body, ..
        } => assert!(body.starts_with(LINK_DOWN_MESSAGE)),
        other => panic!("{other:?}"),
    }
    // 다시 붙으면 announce 뒤에 pollStopped 를 다시 보낸다.
    let (s2, _) = listener.accept().unwrap();
    let mut r2 = BufReader::new(s2);
    assert_eq!(read_json(&mut r2)["type"], "hello");
    assert_eq!(read_json(&mut r2)["type"], "announce");
    assert_eq!(
        read_json(&mut r2),
        json!({"type":"runner.pollStopped","holding":[7]})
    );
    link.stop();
    let _ = std::fs::remove_file(&path);
}

#[test]
fn rejected_first_line_gives_up_after_limit_and_other_frames_route() {
    let path = sock_path("rj");
    let listener = UnixListener::bind(&path).unwrap();
    let mut o = opts(&path);
    let (gave_tx, gave_rx) = mpsc::channel();
    let gave_tx = std::sync::Mutex::new(gave_tx);
    o.on_rejected_give_up = Box::new(move || gave_tx.lock().unwrap().send(()).unwrap());
    let frames = Arc::new(AtomicU32::new(0));
    let f2 = Arc::clone(&frames);
    o.on_frame = Box::new(move |v| {
        assert_eq!(v["type"], "viewer.count");
        f2.fetch_add(1, Ordering::SeqCst);
    });
    let link = LinkClient::new(o);
    link.start();

    // 첫 연결: 받아 준 뒤 서버 프레임 하나, 그 뒤의 link.rejected 꼴은 거절이 아니다.
    let (mut s, _) = listener.accept().unwrap();
    writeln!(
        s,
        "{}",
        json!({"type":"viewer.count","sessionId":"a","count":1})
    )
    .unwrap();
    writeln!(
        s,
        "{}",
        json!({"type":"link.rejected","reason":"unknown_runner"})
    )
    .unwrap();
    std::thread::sleep(Duration::from_millis(50));
    drop(s);

    // 그다음은 첫 줄 거절이 LINK_REJECTED_GIVE_UP 번.
    for _ in 0..LINK_REJECTED_GIVE_UP {
        let (mut s, _) = listener.accept().unwrap();
        writeln!(
            s,
            "{}",
            json!({"type":"link.rejected","reason":"unknown_runner"})
        )
        .unwrap();
        drop(s);
    }
    gave_rx
        .recv_timeout(Duration::from_secs(20))
        .expect("물러나야 한다");
    assert_eq!(frames.load(Ordering::SeqCst), 1);
    // 물러난 뒤에는 다시 두드리지 않는다.
    listener.set_nonblocking(true).unwrap();
    std::thread::sleep(Duration::from_millis(200));
    assert!(listener.accept().is_err());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn over_long_line_is_skipped() {
    let path = sock_path("ol");
    let listener = UnixListener::bind(&path).unwrap();
    let link = LinkClient::new(opts(&path));
    link.start();
    let (s, _) = listener.accept().unwrap();
    let mut r = BufReader::new(s.try_clone().unwrap());
    read_json(&mut r);
    read_json(&mut r);
    let l2 = Arc::clone(&link);
    let h = std::thread::spawn(move || l2.request(LinkRequest::Mcp { payload: json!({}) }));
    let id = read_json(&mut r)["id"].as_str().unwrap().to_string();
    let mut w = s;
    let big = "x".repeat(harkroom_runner::link::RUNNER_LINK_MAX_LINE_BYTES + 10);
    writeln!(w, "{big}").unwrap();
    writeln!(
        w,
        "{}",
        json!({"type":"mcp.error","id":id,"status":401,"message":"no"})
    )
    .unwrap();
    match h.join().unwrap() {
        RunnerLinkResponse::McpError { status: 401, .. } => {}
        other => panic!("{other:?}"),
    }
    link.stop();
    let _ = std::fs::remove_file(&path);
}

#[test]
fn relay_sessions_wired_into_link_announce_output_replay() {
    use harkroom_runner::relay_session::{OpenSessionInput, RelaySessions};
    let path = sock_path("rs");
    let listener = UnixListener::bind(&path).unwrap();
    let sessions = RelaySessions::new(None, Box::new(|_| {}));
    let o = sessions.wire(opts(&path));
    let link = LinkClient::new(o);
    sessions.attach_link(&link);

    let cancels = Arc::new(AtomicU32::new(0));
    let c = cancels.clone();
    // 링크 전에 연 세션 — ring 에 쌓이고, 붙으면 announce 에 실린다.
    let h = sessions.open_session(OpenSessionInput {
        agent_account_id: "a1".into(),
        channel_id: "c1".into(),
        harness: "claude".into(),
        on_cancel: Some(Arc::new(move |_| {
            c.fetch_add(1, Ordering::SeqCst);
        })),
        ..Default::default()
    });
    h.push(b"before");

    link.start();
    let (s, _) = listener.accept().unwrap();
    let mut r = BufReader::new(s.try_clone().unwrap());
    let _hello = read_json(&mut r);
    let announce = read_json(&mut r);
    assert_eq!(announce["sessions"][0]["sessionId"], h.session_id());
    assert!(link.when_connected(Duration::from_secs(2)));

    h.push(b"after");
    let out = read_json(&mut r);
    assert_eq!(out["type"], "output");
    assert_eq!(out["data"], "YWZ0ZXI="); // "after"
    let mut w = s;
    writeln!(
        w,
        "{}",
        json!({"type":"replay.request","sessionId":h.session_id()})
    )
    .unwrap();
    let replay = read_json(&mut r);
    assert_eq!(replay["type"], "replay");
    assert_eq!(replay["data"], "YmVmb3JlYWZ0ZXI="); // "beforeafter"
    h.close();
    assert_eq!(read_json(&mut r)["type"], "session.ended");
    link.stop();
    assert_eq!(cancels.load(Ordering::SeqCst), 0);
    let _ = std::fs::remove_file(&path);
}

/// 쓰기가 막혀 있어도(오퍼레이터가 소켓을 안 읽는다) 이미 보낸 요청의 응답은 배달되고 `connected` 도 답한다 —
/// 쓰기 잠금과 대기 요청 표가 다른 잠금이어야 한다.
#[test]
fn response_is_delivered_while_a_writer_is_blocked() {
    let path = sock_path("hol");
    let listener = UnixListener::bind(&path).unwrap();
    let link = LinkClient::new(opts(&path));
    link.start();
    let (s, _) = listener.accept().unwrap();
    let mut r = BufReader::new(s.try_clone().unwrap());
    assert_eq!(read_json(&mut r)["type"], "hello");
    assert_eq!(read_json(&mut r)["type"], "announce");
    assert!(link.when_connected(Duration::from_secs(2)));

    let l2 = Arc::clone(&link);
    let req = std::thread::spawn(move || {
        l2.request(LinkRequest::Mcp {
            payload: json!({"jsonrpc":"2.0","id":1,"method":"ping"}),
        })
    });
    let id = read_json(&mut r)["id"].as_str().unwrap().to_string();

    // 이제 오퍼레이터가 읽기를 멈춘다. 소켓 버퍼가 찰 때까지 프레임을 밀어 넣어 쓰기 하나를 막는다.
    let sent = Arc::new(AtomicU32::new(0));
    let (l3, sent2) = (Arc::clone(&link), Arc::clone(&sent));
    let flood = std::thread::spawn(move || {
        let frame = json!({"type":"output","sessionId":"x","data":"A".repeat(64 * 1024)});
        for _ in 0..512 {
            l3.send_frame(&frame);
            sent2.fetch_add(1, Ordering::SeqCst);
        }
    });
    let mut last = u32::MAX;
    for _ in 0..200 {
        std::thread::sleep(Duration::from_millis(50));
        let now = sent.load(Ordering::SeqCst);
        if now == last {
            break;
        }
        last = now;
    }
    assert!(last < 512, "쓰기가 막히지 않았다 — 시험 전제가 깨졌다");

    let mut w = s.try_clone().unwrap();
    writeln!(
        w,
        "{}",
        json!({"type":"mcp.response","id":id,"messages":[{"ok":1}]})
    )
    .unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(req.join().unwrap());
    });
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(RunnerLinkResponse::McpResponse { messages, .. }) => {
            assert_eq!(messages, vec![json!({"ok":1})])
        }
        other => panic!("막힌 쓰기 뒤에서 응답이 배달되지 않았다: {other:?}"),
    }
    let l4 = Arc::clone(&link);
    let (ctx, crx) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = ctx.send(l4.connected());
    });
    assert_eq!(crx.recv_timeout(Duration::from_secs(5)), Ok(true));

    // 오퍼레이터가 다시 읽으면 막혔던 프레임이 순서대로, 줄이 섞이지 않고 다 온다.
    for _ in 0..512 {
        let f = read_json(&mut r);
        assert_eq!(f["type"], "output");
        assert_eq!(f["data"].as_str().unwrap().len(), 64 * 1024);
    }
    flood.join().unwrap();
    link.stop();
}

/// 오퍼레이터가 바뀌면(새 프로세스의 턴 열쇠 장부는 비어 있다) 다시 붙은 링크로 열린 턴의 열쇠를 다시 맡긴다.
/// 빠지면 도는 턴의 MCP 다리가 새 오퍼레이터에서 받아들여지지 않아 그 턴의 도구 호출이 전부 시한까지 기다린다.
#[test]
fn reopened_link_re_registers_open_turn_keys() {
    use harkroom_runner::mention_clients::{AgentClients, ClientsCell, turn_keys_relink};
    use harkroom_runner::rest::{OpenTurn, issue_turn_keys};

    let path = sock_path("relink");
    let listener = UnixListener::bind(&path).unwrap();
    let cell: ClientsCell<Arc<LinkClient>> = Arc::default();
    let mut o = opts(&path);
    o.on_link_open = turn_keys_relink(cell.clone());
    let link = LinkClient::new(o);
    let clients = Arc::new(AgentClients::new(Arc::clone(&link), "test"));
    cell.set(Arc::clone(&clients)).ok().unwrap();
    link.start();

    // 한 연결을 받아 hello·announce 를 넘기고, 턴 열쇠 맡기기 한 줄을 200 으로 답한 뒤 그 본문을 돌려준다.
    let serve_one = |listener: &UnixListener| -> (UnixStream, Value) {
        let (s, _) = listener.accept().unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut r = BufReader::new(s.try_clone().unwrap());
        assert_eq!(read_json(&mut r)["type"], "hello");
        assert_eq!(read_json(&mut r)["type"], "announce");
        let req = read_json(&mut r);
        assert_eq!(req["type"], "http.forward");
        assert_eq!(req["path"], "/agent/turn-keys");
        let mut w = s.try_clone().unwrap();
        writeln!(
            w,
            "{}",
            json!({"type":"http.response","id":req["id"],"status":200,"body":"{\"ok\":true}"})
        )
        .unwrap();
        let body: Value = serde_json::from_str(req["body"].as_str().unwrap()).unwrap();
        (s, body)
    };

    let keys = issue_turn_keys();
    let c2 = Arc::clone(&clients);
    let k2 = keys.clone();
    let h = std::thread::spawn(move || {
        assert!(c2.link().when_connected(Duration::from_secs(2)));
        c2.rest().register_turn_keys(OpenTurn {
            turn_id: "t1".into(),
            cause: Some("m1".into()),
            keys: k2,
        })
    });
    let (first, sent) = serve_one(&listener);
    h.join().unwrap().unwrap();
    assert_eq!(sent["turnId"], "t1");

    // 오퍼레이터 교체 — 연결이 끊기고 새 연결이 선다. 러너가 스스로 같은 열쇠를 다시 맡겨야 한다.
    drop(first);
    let (_second, again) = serve_one(&listener);
    assert_eq!(again, sent);
    assert_eq!(again["keys"]["bridge"], keys.bridge);
    link.stop();
}

/// 고리는 기동 코드가 링크에 꽂아야 쓸모가 있다 — 함수만 있고 부르는 곳이 없던 것이 이 시험의 까닭이다.
#[test]
fn runner_main_wires_turn_key_relink() {
    let main = include_str!("../src/main.rs");
    assert!(
        main.contains("opts.on_link_open = harkroom_runner::mention_clients::turn_keys_relink(")
    );
    assert!(main.contains("clients_cell.set("));
}
