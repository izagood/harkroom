//! `<앱 데이터>/operators.json` 색인 읽기(S2 A3b). 정본은 `packages/operator/src/communityRoots.ts::readRootsIndex`·`parseIndex`.
//!
//! 규칙(TS 와 같다): 파일이 없으면 빈 색인이다. **모양이 틀리면 오류다** — 모르는 채로 빈 색인으로 치면 옛 자리(D5)를
//! 잊고 새 뿌리를 만들어 같은 커뮤니티가 두 자리로 갈린다. 키는 끝 `/` 를 걷어 맞추고, 뿌리는 절대 경로여야 하며,
//! 두 커뮤니티가 한 뿌리를 쓰는 색인은 믿지 않는다(security P1-n1). 쓰기는 앱(Tauri)·TS 오퍼레이터 몫이라 여기 없다.
use harkroom_roots::{
    OPERATOR_ROOTS_INDEX_FILE, OperatorRootEntry, OperatorRootsIndex, community_root_key, same_root,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

pub fn roots_index_path(app_data_dir: &str) -> String {
    Path::new(app_data_dir)
        .join(OPERATOR_ROOTS_INDEX_FILE)
        .to_string_lossy()
        .into_owned()
}

/// 색인 글을 읽는다(`parseIndex`).
pub fn parse_index(text: &str, path: &str) -> Result<OperatorRootsIndex, String> {
    let value: Value = serde_json::from_str(text)
        .map_err(|e| format!("오퍼레이터 색인을 못 읽었다({e}): {path}"))?;
    let shape_err = || format!("오퍼레이터 색인의 모양이 다르다: {path}");
    if value.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Err(shape_err());
    }
    let Some(communities) = value.get("communities").and_then(Value::as_object) else {
        return Err(shape_err());
    };
    let mut out = BTreeMap::new();
    for (key, raw) in communities {
        let root = match raw.get("root").and_then(Value::as_str) {
            Some(r) if r.starts_with('/') => r.to_string(),
            _ => return Err(format!("오퍼레이터 색인의 칸이 틀렸다({key}): {path}")),
        };
        let operator_id = raw
            .get("operatorId")
            .and_then(Value::as_str)
            .map(|s| Some(s.to_string()));
        let legacy = (raw.get("legacy") == Some(&Value::Bool(true))).then_some(true);
        out.insert(
            community_root_key(key).to_string(),
            OperatorRootEntry {
                root,
                operator_id,
                legacy,
            },
        );
    }
    let entries: Vec<(&String, &OperatorRootEntry)> = out.iter().collect();
    for (i, (_, a)) in entries.iter().enumerate() {
        if entries[i + 1..]
            .iter()
            .any(|(_, b)| same_root(&a.root, &b.root))
        {
            return Err(format!(
                "오퍼레이터 색인에서 두 커뮤니티가 한 뿌리를 쓴다({}): {path}",
                a.root
            ));
        }
    }
    Ok(OperatorRootsIndex {
        version: 1,
        communities: out,
    })
}

/// 색인 파일을 읽는다. 없으면 빈 색인(`readRootsIndex`).
pub fn read_roots_index(app_data_dir: &str) -> Result<OperatorRootsIndex, String> {
    let path = roots_index_path(app_data_dir);
    match std::fs::read_to_string(&path) {
        Ok(text) => parse_index(&text, &path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(OperatorRootsIndex::default()),
        Err(e) => Err(format!("오퍼레이터 색인을 못 열었다({e}): {path}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use harkroom_roots::{CommunityRootResolution, resolve_community_root};

    #[test]
    fn missing_file_is_empty_index() {
        let idx = read_roots_index("/nonexistent-hk-a3b").unwrap();
        assert!(idx.communities.is_empty());
    }

    #[test]
    fn keys_are_normalized_and_fields_kept_only_when_valid() {
        let idx = parse_index(
            r#"{"version":1,"communities":{"https://a.example.com/":{"root":"/h/a","operatorId":"op1","legacy":true},
               "https://b.example.com":{"root":"/h/b","operatorId":7,"legacy":"yes"}}}"#,
            "p",
        )
        .unwrap();
        let a = &idx.communities["https://a.example.com"];
        assert_eq!(a.operator_id, Some(Some("op1".into())));
        assert_eq!(a.legacy, Some(true));
        let b = &idx.communities["https://b.example.com"];
        assert_eq!((b.operator_id.clone(), b.legacy), (None, None));
    }

    #[test]
    fn bad_shapes_are_errors_not_empty() {
        for bad in [
            r#"{"version":2,"communities":{}}"#,
            r#"{"version":1,"communities":[]}"#,
            r#"{"version":1}"#,
            r#"{"version":1,"communities":{"k":{"root":"rel/path"}}}"#,
            r#"{"version":1,"communities":{"k":{}}}"#,
            r#"not json"#,
        ] {
            assert!(parse_index(bad, "p").is_err(), "{bad}");
        }
    }

    #[test]
    fn duplicate_root_is_refused() {
        let e = parse_index(
            r#"{"version":1,"communities":{"https://a.example.com":{"root":"/h/x"},"https://b.example.com":{"root":"/h/./x/"}}}"#,
            "p",
        )
        .unwrap_err();
        assert!(e.contains("한 뿌리"), "{e}");
    }

    #[test]
    fn index_entry_wins_over_computed_root() {
        let idx = parse_index(
            r#"{"version":1,"communities":{"https://a.example.com":{"root":"/h/legacy","legacy":true}}}"#,
            "p",
        )
        .unwrap();
        match resolve_community_root("/h", "https://a.example.com/", &idx) {
            CommunityRootResolution::Ok {
                root, from_index, ..
            } => {
                assert_eq!(root, "/h/legacy");
                assert!(from_index);
            }
            other => panic!("{other:?}"),
        }
    }
}
