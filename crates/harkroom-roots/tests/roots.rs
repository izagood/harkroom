//! 정본(TS) 골든과 같은 답 — `golden/roots.json` 은 `packages/shared/test/protoGolden.test.ts` 가 쓴다.
use harkroom_roots::*;
use serde_json::Value;

fn golden() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("golden/roots.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn constants_match_ts() {
    let c = &golden()["constants"];
    assert_eq!(c["indexFile"], OPERATOR_ROOTS_INDEX_FILE);
    assert_eq!(c["socketPathLimitBytes"], SOCKET_PATH_LIMIT_BYTES);
    assert_eq!(c["hashLength"], COMMUNITY_ROOT_HASH_LENGTH);
    assert_eq!(c["hashFallbackLength"], COMMUNITY_ROOT_HASH_FALLBACK_LENGTH);
}

#[test]
fn keys_and_hashes_match_ts() {
    for k in golden()["keys"].as_array().unwrap() {
        let b = k["baseUrl"].as_str().unwrap();
        assert_eq!(community_root_key(b), k["key"].as_str().unwrap(), "{b}");
        assert_eq!(
            community_root_hash(b, 8),
            k["hash8"].as_str().unwrap(),
            "{b}"
        );
        assert_eq!(
            community_root_hash(b, 16),
            k["hash16"].as_str().unwrap(),
            "{b}"
        );
    }
}

#[test]
fn endpoint_paths_match_ts() {
    let g = golden();
    let want: EndpointPaths = serde_json::from_value(g["endpoint"].clone()).unwrap();
    assert_eq!(
        daemon_endpoint_paths("/home/example/.harkroom-agent/c/abcd1234"),
        want
    );
}

#[test]
fn resolve_matches_ts_including_fallback_and_too_long() {
    for c in golden()["resolve"].as_array().unwrap() {
        let index: OperatorRootsIndex = serde_json::from_value(c["index"].clone()).unwrap();
        let got = resolve_community_root(
            c["home"].as_str().unwrap(),
            c["baseUrl"].as_str().unwrap(),
            &index,
        );
        assert_eq!(
            serde_json::to_value(&got).unwrap(),
            c["result"],
            "{}",
            c["baseUrl"]
        );
    }
}

#[test]
fn index_file_round_trips() {
    let g = golden();
    let index: OperatorRootsIndex = serde_json::from_value(g["indexSample"].clone()).unwrap();
    assert_eq!(serde_json::to_value(&index).unwrap(), g["indexSample"]);
}

#[test]
fn root_taken_when_both_lengths_are_owned() {
    let home = "/home/example";
    let mut index = OperatorRootsIndex::default();
    let b = "https://busy.example.com";
    for (k, len) in [("https://a.example.com", 8), ("https://b.example.com", 16)] {
        index.communities.insert(
            k.into(),
            OperatorRootEntry {
                root: computed_community_root(home, b, len),
                operator_id: None,
                legacy: None,
            },
        );
    }
    match resolve_community_root(home, b, &index) {
        CommunityRootResolution::Refused(Refusal::RootTaken { taken_by, .. }) => {
            assert_eq!(taken_by, "https://b.example.com")
        }
        other => panic!("{other:?}"),
    }
    assert!(same_root("/a/b/../b/./c", "/a//b/c"));
}
