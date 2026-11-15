//! TS 정본이 낸 결과(`golden/secret_keyring.json`·`secret_leak.json`)와 한 줄씩 대조한다. 골든은 읽기만 한다 — 다시 만드는 것은
//! `packages/server/scripts/genRustSecretGolden.ts` 이고, TS 쪽 시험(`packages/server/test/rustSecretGolden.test.ts`)이 그 파일이 지금
//! TS 와 같은지 본다. 입력은 글자가 아니라 만드는 법으로 적혀 있다(시험 키를 파일에 적지 않는다) — 만드는 법은
//! `packages/server/test/helpers/secretGoldenInputs.ts` 와 같다.
use std::fs;
use std::path::PathBuf;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;

use super::keyring::*;
use super::leak::*;

fn golden(name: &str) -> Value {
    let text = match name {
        "keyring" => include_str!("../../golden/secret_keyring.json"),
        _ => include_str!("../../golden/secret_leak.json"),
    };
    serde_json::from_str(text).expect("golden json")
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_else(|| panic!("golden field {k}"))
}

fn pattern(p: &Value) -> Vec<u8> {
    let from = p["from"].as_u64().expect("from");
    let len = p["len"].as_u64().unwrap_or(32);
    (0..len).map(|i| ((from + i) & 0xff) as u8).collect()
}

const B64: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// `secretGoldenInputs.ts` 의 `keyText` 와 같은 규칙.
fn key_text(spec: &Value) -> String {
    if let Some(t) = spec["text"].as_str() {
        return t.to_owned();
    }
    let k = pattern(&spec["key"]);
    let mut t = match spec["enc"].as_str() {
        Some("hexUpper") => hex::encode_upper(&k),
        Some("hexMixed") => hex::encode(&k)
            .chars()
            .enumerate()
            .map(|(i, c)| {
                if i % 2 == 1 {
                    c.to_ascii_uppercase()
                } else {
                    c
                }
            })
            .collect(),
        Some("b64") => STANDARD.encode(&k),
        _ => hex::encode(&k),
    };
    if let Some(r) = spec["replace"].as_array() {
        t = t.replacen(r[0].as_str().unwrap(), r[1].as_str().unwrap(), 1);
    }
    if spec["bumpLast"].as_bool() == Some(true) {
        let i = t.len() - 2;
        let c = t.as_bytes()[i];
        let idx = B64.iter().position(|x| *x == c).unwrap();
        let mut b = t.into_bytes();
        b[i] = B64[idx | 1];
        t = String::from_utf8(b).unwrap();
    }
    if let Some(n) = spec["cut"].as_u64() {
        t.truncate(n as usize);
    }
    if let Some(a) = spec["add"].as_str() {
        t.push_str(a);
    }
    format!(
        "{}{}{}",
        spec["pre"].as_str().unwrap_or(""),
        t,
        spec["post"].as_str().unwrap_or("")
    )
}

fn value_bytes(v: &Value) -> Vec<u8> {
    let one = match v["text"].as_str() {
        Some(t) => t.as_bytes().to_vec(),
        None => hex::decode(v["hex"].as_str().unwrap_or("")).unwrap(),
    };
    one.repeat(v["repeat"].as_u64().unwrap_or(1) as usize)
}

fn key_from(p: &Value) -> MasterKey {
    parse_key(&hex::encode(pattern(p))).expect("pattern key")
}

fn same_key(a: &MasterKey, b: &MasterKey) -> bool {
    key_check_value(a) == key_check_value(b)
}

#[test]
fn parse_key_matches_ts() {
    let g = golden("keyring");
    for c in g["parseKey"].as_array().unwrap() {
        let name = s(c, "name");
        let got = parse_key(&key_text(&c["input"]));
        assert_eq!(got.is_some(), c["ok"].as_bool().unwrap(), "parseKey {name}");
        if let Some(k) = got {
            assert!(
                same_key(&k, &key_from(&c["input"]["key"])),
                "parseKey {name}: 다른 키"
            );
        }
    }
}

#[test]
fn key_check_value_matches_ts() {
    let g = golden("keyring");
    for c in g["kcv"].as_array().unwrap() {
        assert_eq!(
            hex::encode(key_check_value(&key_from(&c["key"]))),
            s(c, "kcvHex")
        );
    }
}

/// 시험마다 새 임시 디렉터리(`secretGoldenInputs.ts` 의 `buildLoadDir` 와 같음). 끝나면 지운다.
struct TempDir(PathBuf);
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn temp_dir(tag: usize) -> TempDir {
    static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let p = std::env::temp_dir().join(format!(
        "hr-secret-golden-rs-{}-{tag}-{n}",
        std::process::id()
    ));
    let _ = fs::remove_dir_all(&p);
    fs::create_dir_all(&p).unwrap();
    TempDir(p)
}

#[cfg(unix)]
#[test]
fn load_matches_ts() {
    let g = golden("keyring");
    for (i, c) in g["load"].as_array().unwrap().iter().enumerate() {
        let name = s(c, "name");
        let tmp = temp_dir(i);
        let dir: Option<String> = match s(c, "dir") {
            "unset" => None,
            "blank" => Some("   ".into()),
            "missing" => Some(tmp.0.join("nope").to_string_lossy().into_owned()),
            _ => {
                for e in c["entries"].as_array().unwrap() {
                    let p = tmp.0.join(s(e, "name"));
                    if e["dir"].as_bool() == Some(true) {
                        fs::create_dir_all(&p).unwrap();
                    } else if let Some(l) = e["link"].as_str() {
                        std::os::unix::fs::symlink(l, &p).unwrap();
                    } else {
                        fs::write(&p, key_text(&e["content"])).unwrap();
                    }
                }
                Some(tmp.0.to_string_lossy().into_owned())
            }
        };
        let got = load_secret_keys(dir.as_deref(), c["active"].as_str());
        let exp = &c["expect"];
        match got {
            Ok(None) => assert_eq!(exp["none"].as_bool(), Some(true), "load {name}: None"),
            Err(e) => {
                assert_eq!(Some(e.code()), exp["error"].as_str(), "load {name}: {e}");
                let msg = e.to_string();
                assert!(
                    !msg.contains(&hex::encode(pattern(&serde_json::json!({"from": 0x20})))),
                    "{name}: 오류 글귀에 키"
                );
            }
            Ok(Some(l)) => {
                let mut kids: Vec<&str> = l.keys.iter().map(|(k, _)| k.as_str()).collect();
                kids.sort();
                let want: Vec<&str> = exp["kids"]
                    .as_array()
                    .unwrap_or_else(|| panic!("load {name}: {exp}"))
                    .iter()
                    .map(|v| v.as_str().unwrap())
                    .collect();
                assert_eq!(kids, want, "load {name}");
                assert_eq!(l.active_kid, s(exp, "active"), "load {name}");
                for (kid, key) in &l.keys {
                    assert!(
                        same_key(key, &key_from(&exp["keys"][kid])),
                        "load {name}: {kid}"
                    );
                }
            }
        }
    }
}

/// UTF-8 이 아닌 파일 이름은 fail-closed(TS 골든에는 없다 — macOS 파일 시스템은 그런 이름을 만들지 못한다).
#[cfg(target_os = "linux")]
#[test]
fn load_rejects_non_utf8_name() {
    use std::os::unix::ffi::OsStrExt;
    let tmp = temp_dir(9999);
    fs::write(
        tmp.0.join(std::ffi::OsStr::from_bytes(b"k\xff")),
        hex::encode([7u8; 32]),
    )
    .unwrap();
    let e = load_secret_keys(tmp.0.to_str(), None).unwrap_err();
    assert_eq!(e.code(), "bad_file_name");
}

#[test]
fn keyring_new_matches_ts() {
    let g = golden("keyring");
    for c in g["keyring"].as_array().unwrap() {
        let name = s(c, "name");
        let keys = c["kids"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(i, k)| {
                (
                    k.as_str().unwrap().to_owned(),
                    key_from(&serde_json::json!({ "from": i })),
                )
            })
            .collect();
        let got = SecretKeyring::new(LoadedSecretKeys {
            keys,
            active_kid: s(c, "active").to_owned(),
        });
        let code = match &got {
            Ok(_) => "ok",
            Err(e) => e.code(),
        };
        assert_eq!(code, s(c, "expect"), "keyring {name}");
    }
}

fn open_ring(g: &Value) -> SecretKeyring {
    let keys = g["open"]["keys"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, p)| (k.clone(), key_from(p)))
        .collect();
    SecretKeyring::new(LoadedSecretKeys {
        keys,
        active_kid: "k1".into(),
    })
    .unwrap()
}

#[test]
fn open_matches_ts() {
    let g = golden("keyring");
    let ring = open_ring(&g);
    let mut intended = 0;
    for c in g["open"]["cases"].as_array().unwrap() {
        let name = s(c, "name");
        let a = &c["aad"];
        let kind = if s(a, "kind") == "file" {
            SecretKind::File
        } else {
            SecretKind::Text
        };
        let aad = SecretAad {
            secret_id: s(a, "secretId"),
            version: a["version"].as_i64().unwrap(),
            kind,
        };
        let got = ring
            .open(s(c, "sealed"), &aad)
            .map(|v| hex::encode(v.as_bytes()));
        assert_eq!(got.as_deref(), c["rust"].as_str(), "open {name}");
        if c["intended"].is_string() {
            intended += 1;
            assert!(
                c["ts"].is_string() && c["rust"].is_null(),
                "open {name}: 의도된 차이는 TS 만 연다"
            );
        } else {
            assert_eq!(c["rust"], c["ts"], "open {name}: 의도된 차이가 아닌데 갈림");
        }
    }
    assert!(intended >= 1, "의도된 차이 b 가 골든에 있다");
}

/// 키·값이 Debug·오류 글귀로 새지 않는다.
#[test]
fn debug_hides_key_and_value() {
    let g = golden("keyring");
    let ring = open_ring(&g);
    let dump = format!("{ring:?}");
    for p in g["open"]["keys"].as_object().unwrap().values() {
        let k = pattern(p);
        assert!(
            !dump.contains(&hex::encode(&k)) && !dump.contains(&hex::encode_upper(&k)),
            "{dump}"
        );
        assert!(!dump.contains(&STANDARD.encode(&k)), "{dump}");
        assert!(
            !dump.contains(&format!("{:?}", &k[..4]).trim_end_matches(']').to_string()),
            "{dump}"
        );
    }
    assert!(
        dump.contains("k1") && dump.contains("k2"),
        "kid 는 보인다: {dump}"
    );

    let c = &g["open"]["cases"][0];
    let a = &c["aad"];
    let v = ring
        .open(
            s(c, "sealed"),
            &SecretAad {
                secret_id: s(a, "secretId"),
                version: 1,
                kind: SecretKind::Text,
            },
        )
        .unwrap();
    let plain = String::from_utf8(v.as_bytes().to_vec()).unwrap();
    assert!(!format!("{v:?}").contains(&plain));
    let k = key_from(&g["open"]["keys"]["k1"]);
    assert_eq!(format!("{k:?}"), "MasterKey(<redacted>)");
    let leak = LeakSecret::new(
        LeakHit {
            id: "i".into(),
            name: "n".into(),
        },
        v,
    );
    let d = format!("{leak:?}");
    assert!(
        !d.contains(&plain) && !d.contains(&STANDARD.encode(plain.as_bytes())),
        "{d}"
    );
}

#[test]
fn leak_constants_match_ts() {
    let g = golden("leak");
    assert_eq!(g["minChars"].as_u64(), Some(LEAK_MIN_CHARS as u64));
    assert_eq!(g["lineMinChars"].as_u64(), Some(LINE_MIN_CHARS as u64));
    assert_eq!(s(&g["refusal"], "code"), SECRET_IN_BODY_CODE);
    assert_eq!(s(&g["refusal"], "message"), SECRET_IN_BODY_MESSAGE);
}

#[test]
fn needles_match_ts() {
    let g = golden("leak");
    for c in g["needles"].as_array().unwrap() {
        let got: Vec<String> = needles_for(&value_bytes(&c["value"]))
            .iter()
            .map(|n| n.to_string())
            .collect();
        let want: Vec<&str> = c["needles"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(got, want, "needles {}", s(c, "name"));
    }
}

#[test]
fn collect_strings_match_ts() {
    let g = golden("leak");
    for c in g["collect"].as_array().unwrap() {
        // serde_json 은 객체 키를 정렬해 읽는다 — 순서가 아니라 모음으로 비교한다.
        let mut got = collect_strings(&c["json"]);
        got.sort();
        let mut want: Vec<&str> = c["strings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        want.sort();
        assert_eq!(got, want, "collect {}", s(c, "name"));
    }
}

fn leak_secrets(c: &Value) -> Vec<LeakSecret> {
    c["secrets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| {
            LeakSecret::new(
                LeakHit {
                    id: s(x, "id").into(),
                    name: s(x, "name").into(),
                },
                SecretBytes::from_vec(value_bytes(&x["value"])),
            )
        })
        .collect()
}

fn ids(h: Vec<LeakHit>) -> Vec<String> {
    h.into_iter().map(|h| h.id).collect()
}

fn want_ids(c: &Value) -> Vec<String> {
    c["hits"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn find_in_texts_matches_ts() {
    let g = golden("leak");
    for c in g["texts"].as_array().unwrap() {
        let texts: Vec<&str> = c["texts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(
            ids(find_in_texts(&leak_secrets(c), &texts)),
            want_ids(c),
            "texts {}",
            s(c, "name")
        );
    }
}

#[test]
fn find_in_bytes_matches_ts() {
    let g = golden("leak");
    for c in g["bytes"].as_array().unwrap() {
        assert_eq!(
            ids(find_in_bytes(&leak_secrets(c), &value_bytes(&c["bytes"]))),
            want_ids(c),
            "bytes {}",
            s(c, "name")
        );
    }
}
