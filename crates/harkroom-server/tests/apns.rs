//! C5e-1 APNs 전송부 — 가짜 키(시험 중 생성)와 가짜 APNs 서버(로컬 h2c)로 잰다. 실제 키·인증서 값은 쓰지 않는다.
use base64::Engine;
use bytes::Bytes;
use harkroom_server::push::apns::*;
use http_body_util::{BodyExt, Full};
use ring::rand::SystemRandom;
use ring::signature::{
    ECDSA_P256_SHA256_FIXED, ECDSA_P256_SHA256_FIXED_SIGNING, EcdsaKeyPair, KeyPair,
    UnparsedPublicKey,
};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn fake_key() -> (String, Vec<u8>) {
    let rng = SystemRandom::new();
    let der = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &rng).unwrap();
    let kp =
        EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, der.as_ref(), &rng).unwrap();
    let b64 = base64::engine::general_purpose::STANDARD.encode(der.as_ref());
    let body: Vec<String> = b64
        .as_bytes()
        .chunks(64)
        .map(|c| String::from_utf8(c.to_vec()).unwrap())
        .collect();
    (
        format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            body.join("\n")
        ),
        kp.public_key().as_ref().to_vec(),
    )
}

fn cfg(pem: &str) -> ApnsConfig {
    ApnsConfig {
        key_id: "KEYID12345".into(),
        team_id: "TEAMID1234".into(),
        key_pem: pem.into(),
        topic: "com.example.app".into(),
    }
}

#[derive(Clone, Debug)]
struct Seen {
    path: String,
    headers: Vec<(String, String)>,
    body: String,
}

/// 가짜 APNs: 받은 요청을 적고 `reply(path)` 가 준 (상태, 본문, 지연)으로 답한다.
type Reply = Arc<dyn Fn(&str) -> (u16, &'static str, u64) + Send + Sync>;

async fn fake_apns(reply: Reply) -> (String, Arc<Mutex<Vec<Seen>>>, Arc<AtomicU64>) {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let conns = Arc::new(AtomicU64::new(0));
    let (s2, c2) = (seen.clone(), conns.clone());
    tokio::spawn(async move {
        loop {
            let (tcp, _) = l.accept().await.unwrap();
            c2.fetch_add(1, Ordering::SeqCst);
            let (seen, reply) = (s2.clone(), reply.clone());
            tokio::spawn(async move {
                let svc = hyper::service::service_fn(
                    move |req: hyper::Request<hyper::body::Incoming>| {
                        let (seen, reply) = (seen.clone(), reply.clone());
                        async move {
                            let path = req.uri().path().to_string();
                            let headers = req
                                .headers()
                                .iter()
                                .map(|(k, v)| (k.to_string(), v.to_str().unwrap().to_string()))
                                .collect();
                            let body = String::from_utf8(
                                req.into_body().collect().await.unwrap().to_bytes().to_vec(),
                            )
                            .unwrap();
                            seen.lock().unwrap().push(Seen {
                                path: path.clone(),
                                headers,
                                body,
                            });
                            let (status, b, delay) = reply(&path);
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                            Ok::<_, std::convert::Infallible>(
                                hyper::Response::builder()
                                    .status(status)
                                    .body(Full::new(Bytes::from(b)))
                                    .unwrap(),
                            )
                        }
                    },
                );
                let _ =
                    hyper::server::conn::http2::Builder::new(hyper_util::rt::TokioExecutor::new())
                        .serve_connection(hyper_util::rt::TokioIo::new(tcp), svc)
                        .await;
            });
        }
    });
    (format!("http://{addr}"), seen, conns)
}

fn header<'a>(s: &'a Seen, k: &str) -> &'a str {
    s.headers
        .iter()
        .find(|(n, _)| n == k)
        .map(|(_, v)| v.as_str())
        .unwrap_or("")
}

fn transport(pem: &str, origin: &str, clock: Arc<AtomicU64>, timeout_ms: u64) -> ApnsTransport {
    let c = clock.clone();
    ApnsTransport::with_origins(
        cfg(pem),
        &[(ApnsEnv::Production, origin), (ApnsEnv::Sandbox, origin)],
        Some(Arc::new(move || c.load(Ordering::SeqCst))),
        Duration::from_millis(timeout_ms),
    )
    .unwrap()
}

fn send<'a>(token: &'a str, payload: &'a serde_json::Value) -> ApnsSendInput<'a> {
    ApnsSendInput {
        token,
        env: ApnsEnv::Production,
        payload,
        collapse_id: "t:abc",
    }
}

#[test]
fn config_is_all_or_none_and_never_echoes_values() {
    let (pem, _) = fake_key();
    let env = |pairs: Vec<(&'static str, String)>| {
        move |n: &str| pairs.iter().find(|(k, _)| *k == n).map(|(_, v)| v.clone())
    };
    assert!(load_apns_config(env(vec![])).unwrap().is_none());
    assert!(
        load_apns_config(env(vec![("APNS_KEY_ID", "  ".into())]))
            .unwrap()
            .is_none()
    );
    let e = load_apns_config(env(vec![
        ("APNS_KEY_ID", "K".into()),
        ("APNS_KEY_P8", pem.clone()),
    ]))
    .unwrap_err();
    assert_eq!(
        e,
        "push: APNS_TEAM_ID, APNS_TOPIC is missing (set all of APNS_KEY_ID, APNS_TEAM_ID, APNS_KEY_P8, APNS_TOPIC or none)"
    );
    let bad = "-----BEGIN PRIVATE KEY-----\nTk9UQUtFWVNFQ1JFVFZBTFVF\n-----END PRIVATE KEY-----";
    let all = |p: String| {
        vec![
            ("APNS_KEY_ID", " K ".into()),
            ("APNS_TEAM_ID", "T".into()),
            ("APNS_KEY_P8", p),
            ("APNS_TOPIC", "com.example.app".into()),
        ]
    };
    let e = load_apns_config(env(all(bad.into()))).unwrap_err();
    assert_eq!(e, "push: APNS_KEY_P8 is not a readable PEM private key");
    assert!(!e.contains("Tk9U"));
    let c = load_apns_config(env(all(pem.clone()))).unwrap().unwrap();
    assert_eq!(c.key_id, "K");
    // Debug 에 키가 안 나온다.
    assert!(!format!("{c:?}").contains("PRIVATE KEY"));
    assert_eq!(redact_token("0123456789abcdef"), "01234567…");
}

#[tokio::test]
async fn sends_like_ts_and_jwt_verifies_with_fixed_signature() {
    let (pem, public) = fake_key();
    let (origin, seen, _) = fake_apns(Arc::new(|_| (200, "", 0))).await;
    let clock = Arc::new(AtomicU64::new(1_700_000_000_000));
    let t = transport(&pem, &origin, clock, 5_000);
    let payload = serde_json::json!({"aps": {"alert": {"title": "x"}}});
    let r = t.send(send("devtoken1", &payload)).await;
    assert_eq!(
        r,
        ApnsResult {
            status: 200,
            reason: None
        }
    );
    let s = seen.lock().unwrap()[0].clone();
    assert_eq!(s.path, "/3/device/devtoken1");
    assert_eq!(header(&s, "apns-topic"), "com.example.app");
    assert_eq!(header(&s, "apns-push-type"), "alert");
    assert_eq!(header(&s, "apns-priority"), "10");
    assert_eq!(header(&s, "apns-collapse-id"), "t:abc");
    assert_eq!(header(&s, "content-type"), "application/json");
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&s.body).unwrap(),
        payload
    );
    let jwt = header(&s, "authorization")
        .strip_prefix("bearer ")
        .unwrap()
        .to_string();
    let parts: Vec<&str> = jwt.split('.').collect();
    let dec = |p: &str| {
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(p)
            .unwrap()
    };
    assert_eq!(
        String::from_utf8(dec(parts[0])).unwrap(),
        r#"{"alg":"ES256","kid":"KEYID12345"}"#
    );
    assert_eq!(
        String::from_utf8(dec(parts[1])).unwrap(),
        r#"{"iss":"TEAMID1234","iat":1700000000}"#
    );
    let sig = dec(parts[2]);
    // P1363(r‖s) 는 64바이트다 — DER 이면 70안팎이고 APNs 가 거절한다.
    assert_eq!(sig.len(), 64);
    UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, &public)
        .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
        .expect("JWT signature verifies with the public key");
}

#[tokio::test]
async fn jwt_is_reused_for_50_minutes_then_renewed_and_connection_is_reused() {
    let (pem, _) = fake_key();
    let (origin, seen, conns) = fake_apns(Arc::new(|_| (200, "", 0))).await;
    let clock = Arc::new(AtomicU64::new(1_700_000_000_000));
    let t = transport(&pem, &origin, clock.clone(), 5_000);
    let p = serde_json::json!({});
    t.send(send("a", &p)).await;
    clock.fetch_add(APNS_JWT_TTL_MS - 1, Ordering::SeqCst);
    t.send(send("b", &p)).await;
    clock.fetch_add(1, Ordering::SeqCst);
    t.send(send("c", &p)).await;
    let s = seen.lock().unwrap().clone();
    assert_eq!(
        header(&s[0], "authorization"),
        header(&s[1], "authorization")
    );
    assert_ne!(
        header(&s[1], "authorization"),
        header(&s[2], "authorization")
    );
    assert_eq!(
        conns.load(Ordering::SeqCst),
        1,
        "one HTTP/2 connection per env"
    );
}

#[tokio::test]
async fn reasons_timeouts_and_connect_failures() {
    let (pem, _) = fake_key();
    let (origin, _, _) = fake_apns(Arc::new(|path: &str| match path {
        "/3/device/gone" => (410, r#"{"reason":"Unregistered"}"#, 0),
        "/3/device/bad" => (400, r#"{"reason":"BadDeviceToken"}"#, 0),
        "/3/device/junk" => (500, "not json", 0),
        "/3/device/slow" => (200, "", 2_000),
        _ => (200, "", 0),
    }))
    .await;
    let t = transport(
        &pem,
        &origin,
        Arc::new(AtomicU64::new(1_700_000_000_000)),
        300,
    );
    let p = serde_json::json!({});
    assert_eq!(
        t.send(send("gone", &p)).await,
        ApnsResult {
            status: 410,
            reason: Some("Unregistered".into())
        }
    );
    assert_eq!(
        t.send(send("bad", &p)).await,
        ApnsResult {
            status: 400,
            reason: Some("BadDeviceToken".into())
        }
    );
    assert_eq!(
        t.send(send("junk", &p)).await,
        ApnsResult {
            status: 500,
            reason: None
        }
    );
    assert_eq!(
        t.send(send("slow", &p)).await,
        ApnsResult {
            status: 0,
            reason: Some("timeout".into())
        }
    );
    // 시한 뒤에도 다음 요청은 새 연결로 간다.
    assert_eq!(t.send(send("ok", &p)).await.status, 200);

    // 아무도 안 듣는 포트 → connect_failed.
    let dead = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = dead.local_addr().unwrap().port();
    drop(dead);
    let t = transport(
        &pem,
        &format!("http://127.0.0.1:{port}"),
        Arc::new(AtomicU64::new(0)),
        1_000,
    );
    assert_eq!(
        t.send(send("x", &p)).await,
        ApnsResult {
            status: 0,
            reason: Some("connect_failed".into())
        }
    );
}

#[test]
fn real_origins_are_tls() {
    assert_eq!(
        APNS_ORIGINS[0],
        (ApnsEnv::Production, "https://api.push.apple.com")
    );
    assert_eq!(
        APNS_ORIGINS[1],
        (ApnsEnv::Sandbox, "https://api.sandbox.push.apple.com")
    );
    assert_eq!(ApnsEnv::parse("sandbox"), Some(ApnsEnv::Sandbox));
    assert_eq!(ApnsEnv::parse("dev"), None);
}
