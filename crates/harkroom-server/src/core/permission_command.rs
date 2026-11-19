//! P6-2c — `permission.request` kind=command(TS `openCommandRequest`)의 순수 조각: 오퍼레이터가 잰 파일 해시 헤더 읽기
//! (`parseCommandFilesHeader`), 명령이 읽는 파일과 잰 파일 맞추기(`matchFileDigests`), 저장 꼴(`canonicalDigests`),
//! 카드 본문의 파일 줄(`filesBlock`·`neutralizePreview`), 카드 줄·선택지(`cardLine('command')`·`permissionCardOptions('command')`).
//!
//! JS 와 길이·순서를 맞추려고 문자열 길이는 UTF-16 단위로, 경로 정렬은 UTF-16 코드 단위 순으로 잰다.
use harkroom_proto::tool_rules::CommandFileArg;
use serde_json::{Value, json};

/// shared `COMMAND_FILES_HEADER`.
pub const COMMAND_FILES_HEADER: &str = "x-harkroom-command-files";

/// TS `COMMAND_GRANT_TTL_MS` — [이번 한 번] grant 의 기한.
pub const COMMAND_GRANT_TTL_MS: i64 = 3_600_000;

/// 오퍼레이터가 잰 파일 하나(shared `CommandFileDigest`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Digest {
    pub path: String,
    pub sha256: String,
    pub size: u64,
    pub preview: Option<String>,
}

fn u16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// 헤더 읽기의 결과. `ToTs` 는 TS 와 같은 판정을 장담 못 하는 꼴(느슨한 base64·깨진 UTF-8) — 그 요청은 TS 에 넘긴다.
#[derive(Debug, PartialEq, Eq)]
pub enum Header {
    /// TS 가 `null` 을 내는 꼴(헤더 없음·모양 틀림).
    Absent,
    Digests(Vec<Digest>),
    ToTs,
}

/// TS `parseCommandFilesHeader`. 오퍼레이터를 거친 요청에서만 부른다(아니면 `Absent`).
pub fn parse_header(raw: Option<&[u8]>) -> Header {
    use base64::Engine;
    let Some(raw) = raw else {
        return Header::Absent;
    };
    // TS 는 `typeof raw !== 'string'` 이면 null — 헤더 값이 글자가 아니면(비 ASCII 바이트) 같은 판정을 장담 못 한다.
    let Ok(raw) = std::str::from_utf8(raw) else {
        return Header::ToTs;
    };
    if raw.len() > 64 * 1024 {
        return Header::Absent;
    }
    // Node `Buffer.from(s, 'base64')` 는 틀린 글자를 건너뛰는 느슨한 해독이다 — 엄격 해독이 실패하면 TS 에 맡긴다.
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(raw) else {
        return Header::ToTs;
    };
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Header::ToTs;
    };
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return Header::Absent;
    };
    let Some(arr) = v.as_array() else {
        return Header::Absent;
    };
    if arr.len() > 16 {
        return Header::Absent;
    }
    let mut out = Vec::with_capacity(arr.len());
    for d in arr {
        let Some(o) = d.as_object() else {
            return Header::Absent;
        };
        let (Some(path), Some(sha)) = (
            o.get("path").and_then(Value::as_str),
            o.get("sha256").and_then(Value::as_str),
        ) else {
            return Header::Absent;
        };
        if u16_len(path) > 1024
            || sha.len() != 64
            || !sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Header::Absent;
        }
        let Some(size) = o.get("size").and_then(Value::as_f64) else {
            return Header::Absent;
        };
        if size.fract() != 0.0 || !(0.0..=1_048_576.0).contains(&size) {
            return Header::Absent;
        }
        let preview = match o.get("preview") {
            None => None,
            Some(Value::String(p)) if u16_len(p) <= 4096 => Some(p.clone()),
            Some(_) => return Header::Absent,
        };
        out.push(Digest {
            path: path.to_owned(),
            sha256: sha.to_owned(),
            size: size as u64,
            preview,
        });
    }
    Header::Digests(out)
}

/// 카드·요청 meta 에 싣는 파일 하나(TS `matchFileDigests` 의 `files[i]`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MatchedFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
    pub secret: bool,
    pub preview: Option<String>,
}

impl MatchedFile {
    pub fn meta(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("path".into(), json!(self.path));
        m.insert("size".into(), json!(self.size));
        m.insert("sha256".into(), json!(self.sha256));
        m.insert("secret".into(), json!(self.secret));
        if let Some(p) = &self.preview {
            m.insert("preview".into(), json!(p));
        }
        Value::Object(m)
    }
}

/// TS `matchFileDigests`. `Err(code)` 는 `files_unmeasured`·`files_mismatch`.
pub fn match_files(
    want: &[CommandFileArg],
    got: Option<&[Digest]>,
) -> Result<Vec<MatchedFile>, &'static str> {
    if want.is_empty() {
        return Ok(Vec::new());
    }
    let Some(got) = got else {
        return Err("files_unmeasured");
    };
    // TS `new Map(got.map(...))` — 같은 경로가 둘이면 뒤의 것이 이긴다.
    let mut by_path: std::collections::HashMap<&str, &Digest> = std::collections::HashMap::new();
    for d in got {
        by_path.insert(d.path.as_str(), d);
    }
    if got.len() != want.len()
        || by_path.len() != want.len()
        || want.iter().any(|w| !by_path.contains_key(w.path.as_str()))
    {
        return Err("files_mismatch");
    }
    Ok(want
        .iter()
        .map(|w| {
            let d = by_path[w.path.as_str()];
            MatchedFile {
                path: w.path.clone(),
                size: d.size,
                sha256: d.sha256.clone(),
                secret: w.secret,
                preview: if w.secret { None } else { d.preview.clone() },
            }
        })
        .collect())
}

/// TS 거절 글(`files_unmeasured`·`files_mismatch`).
pub fn files_refusal_message(code: &str) -> &'static str {
    if code == "files_unmeasured" {
        "this command reads files — it can only be requested through an up-to-date operator that measures them"
    } else {
        "the measured files do not match the files this command reads"
    }
}

/// TS `canonicalDigests` — `{path, sha256}` 만, 경로의 UTF-16 코드 단위 순. `JSON.stringify` 와 같은 글자.
pub fn canonical_digests_json(files: &[MatchedFile]) -> String {
    let mut v: Vec<&MatchedFile> = files.iter().collect();
    v.sort_by(|a, b| a.path.encode_utf16().cmp(b.path.encode_utf16()));
    let arr: Vec<Value> = v
        .iter()
        .map(|f| {
            let mut m = serde_json::Map::new();
            m.insert("path".into(), json!(f.path));
            m.insert("sha256".into(), json!(f.sha256));
            Value::Object(m)
        })
        .collect();
    Value::Array(arr).to_string()
}

/// TS `neutralizePreview` — 서식 글자 지움 → 펜스(``` ```·`~~~` 3개 이상)를 `‵` 같은 수로 → `@` 를 전각 → `harkroom://` 를 끊는다.
pub fn neutralize_preview(text: &str) -> String {
    static CF: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static FENCE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static LINK: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let cf = CF.get_or_init(|| regex::Regex::new(r"\p{Cf}").unwrap());
    let fence = FENCE.get_or_init(|| regex::Regex::new(r"`{3,}|~{3,}").unwrap());
    let link = LINK.get_or_init(|| regex::Regex::new(r"(?i)harkroom://").unwrap());
    let s = cf.replace_all(text, "");
    let s = fence.replace_all(&s, |c: &regex::Captures<'_>| {
        "‵".repeat(c[0].chars().count())
    });
    let s = s.replace('@', "＠");
    link.replace_all(&s, "harkroom∶//").into_owned()
}

/// TS `filesBlock` — 파일이 없으면 빈 글자.
pub fn files_block(files: &[MatchedFile]) -> String {
    if files.is_empty() {
        return String::new();
    }
    let mut lines = vec![format!(
        "\n파일 {}개 — 내용은 요청 시점에 고정됨(바뀌면 열리지 않는다):",
        files.len()
    )];
    for f in files {
        lines.push(format!(
            "· {} ({}B, sha256 {}…){}",
            f.path,
            f.size,
            &f.sha256[..12],
            if f.secret { " — 내용 비공개" } else { "" }
        ));
        if let Some(p) = &f.preview {
            lines.push("```".into());
            lines.push(neutralize_preview(p));
            lines.push("```".into());
        }
    }
    lines.join("\n")
}

/// TS `permissionCardBody`(kind=command).
pub fn card_body(
    agent_handle: &str,
    command: &str,
    warnings: &[&str],
    files: &[MatchedFile],
    reason: &str,
) -> String {
    let warn = crate::core::permission_card::body_warning_line(warnings)
        .map_or(String::new(), |l| format!("\n{l}"));
    format!(
        "권한 요청 · {agent_handle}\n정확히 이 명령 하나 `{command}` — 이 스레드에서만 · 「이번 한 번」{warn}{}\n이유: {}",
        files_block(files),
        crate::core::permission_card::one_line_reason(reason)
    )
}

/// TS `cardLine('command', command, undefined, _)` — 위임장 여부와 상관없이 [이번 한 번] 하나.
pub fn card_line(command: &str) -> Value {
    json!({ "cap": "command", "scope": command,
        "limits": { "approve_once": { "untilMs": COMMAND_GRANT_TTL_MS, "uses": 1 } } })
}

/// TS `permissionCardOptions('command')`.
pub fn card_options() -> Value {
    json!([{ "id": "approve_once", "label": "이번 한 번" }, { "id": "deny", "label": "거절" }])
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn b64(s: &str) -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .encode(s)
            .into_bytes()
    }
    const SHA: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn header_shapes() {
        assert_eq!(parse_header(None), Header::Absent);
        let ok = format!(r#"[{{"path":"/a","sha256":"{SHA}","size":3,"preview":"x"}}]"#);
        let Header::Digests(d) = parse_header(Some(&b64(&ok))) else {
            panic!()
        };
        assert_eq!(d[0].size, 3);
        assert_eq!(d[0].preview.as_deref(), Some("x"));
        // 정수 꼴 실수(3.0)는 JS 에서도 정수다.
        let f = format!(r#"[{{"path":"/a","sha256":"{SHA}","size":3.0}}]"#);
        assert!(matches!(parse_header(Some(&b64(&f))), Header::Digests(_)));
        for bad in [
            format!(r#"[{{"path":"/a","sha256":"{}","size":3}}]"#, SHA.to_uppercase()),
            format!(r#"[{{"path":"/a","sha256":"{SHA}","size":-1}}]"#),
            format!(r#"[{{"path":"/a","sha256":"{SHA}","size":1.5}}]"#),
            format!(r#"[{{"path":"/a","sha256":"{SHA}","size":1048577}}]"#),
            format!(r#"[{{"path":"/a","sha256":"{SHA}","size":1,"preview":3}}]"#),
            r#"{"path":"/a"}"#.to_owned(),
            "not json".to_owned(),
        ] {
            assert_eq!(parse_header(Some(&b64(&bad))), Header::Absent, "{bad}");
        }
        // 엄격 base64 가 못 읽는 꼴은 TS 에 맡긴다.
        assert_eq!(parse_header(Some(b"%%%")), Header::ToTs);
    }

    fn arg(p: &str, secret: bool) -> CommandFileArg {
        CommandFileArg {
            path: p.into(),
            flag: "-f".into(),
            secret,
        }
    }
    fn dig(p: &str, preview: Option<&str>) -> Digest {
        Digest {
            path: p.into(),
            sha256: SHA.into(),
            size: 5,
            preview: preview.map(Into::into),
        }
    }

    #[test]
    fn matching() {
        assert_eq!(match_files(&[], None), Ok(vec![]));
        assert_eq!(match_files(&[arg("/a", false)], None), Err("files_unmeasured"));
        assert_eq!(
            match_files(&[arg("/a", false)], Some(&[dig("/b", None)])),
            Err("files_mismatch")
        );
        assert_eq!(
            match_files(&[arg("/a", false)], Some(&[dig("/a", None), dig("/a", None)])),
            Err("files_mismatch")
        );
        let m = match_files(
            &[arg("/s", true), arg("/a", false)],
            Some(&[dig("/a", Some("hi")), dig("/s", Some("secret"))]),
        )
        .unwrap();
        assert_eq!(m[0].preview, None); // 비밀 자리의 미리 보기는 버린다
        assert_eq!(m[1].preview.as_deref(), Some("hi"));
        assert_eq!(
            canonical_digests_json(&m),
            format!(r#"[{{"path":"/a","sha256":"{SHA}"}},{{"path":"/s","sha256":"{SHA}"}}]"#)
        );
    }

    #[test]
    fn utf16_sort_matches_js() {
        // JS `<` 는 UTF-16 코드 단위 순 — U+FF01(BMP) 가 U+1F600(대리쌍 D83D…) 보다 뒤다. 바이트 순이면 반대다.
        let f = |p: &str| MatchedFile {
            path: p.into(),
            size: 0,
            sha256: SHA.into(),
            secret: false,
            preview: None,
        };
        let j = canonical_digests_json(&[f("/\u{FF01}"), f("/\u{1F600}")]);
        assert!(j.find('\u{1F600}').unwrap() < j.find('\u{FF01}').unwrap());
    }

    #[test]
    fn preview_neutralized() {
        assert_eq!(
            neutralize_preview("a\u{200B}b ```` ~~~ @x HarkRoom://m"),
            "ab ‵‵‵‵ ‵‵‵ ＠x harkroom∶//m"
        );
    }

    #[test]
    fn body_and_line() {
        let files = vec![MatchedFile {
            path: "/a".into(),
            size: 5,
            sha256: SHA.into(),
            secret: true,
            preview: None,
        }];
        assert_eq!(
            card_body("@bot", "ls -l", &[], &files, "why\nnot"),
            "권한 요청 · @bot\n정확히 이 명령 하나 `ls -l` — 이 스레드에서만 · 「이번 한 번」\n파일 1개 — 내용은 요청 시점에 고정됨(바뀌면 열리지 않는다):\n· /a (5B, sha256 0123456789ab…) — 내용 비공개\n이유: why not"
        );
        assert_eq!(card_line("ls")["limits"]["approve_once"]["uses"], 1);
        assert_eq!(card_options()[0]["id"], "approve_once");
    }
}
