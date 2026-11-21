//! 마이그레이션 파일 이름(정본 `crates/harkroom-server/migrations/*.sql`)을 바이너리에 굽는다.
//! 기동할 때 DB 의 `schema_migrations` 와 대조한다(`src/schema.rs`). 본문도 굽는다 — 마이그레이션 실행기(`src/migrate.rs`, 기본 꺼짐)가 쓴다.
use std::{env, fs, path::Path};

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut names: Vec<String> = fs::read_dir(&dir)
        .expect("마이그레이션 폴더")
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".sql"))
        .collect();
    names.sort();
    let body = format!("pub const KNOWN_MIGRATIONS: &[&str] = &{names:?};\n");
    let out = Path::new(&env::var("OUT_DIR").unwrap()).to_path_buf();
    fs::write(out.join("migrations.rs"), body).unwrap();
    // (이름, 본문) — `include_str!` 이 파일 하나하나를 의존으로 잡으므로 본문이 바뀌면 다시 굽는다.
    let files: Vec<String> = names
        .iter()
        .map(|n| {
            let path = dir.join(n).canonicalize().expect("마이그레이션 파일");
            format!("({n:?}, include_str!({:?}))", path.display().to_string())
        })
        .collect();
    let sql = format!(
        "pub const MIGRATION_FILES: &[(&str, &str)] = &[{}];\n",
        files.join(", ")
    );
    fs::write(out.join("migrations_sql.rs"), sql).unwrap();
    bake_release_version();
}

/// 릴리스 버전의 정본(`packages/desktop/src-tauri/tauri.conf.json` 의 `version`, TS `version.ts` 와 같은 자리)을
/// `HARKROOM_BUILD_VERSION` 으로 굽는다 — `/healthz` 의 `version`(`src/health.rs`). 파일이 없거나 칸을 못 읽으면 굽지 않는다
/// (그때 `/healthz` 는 env `HARKROOM_VERSION` 이 없으면 `null` 을 낸다 — 지어내지 않는다). 이미지 빌드는 이 파일 하나를 넘긴다(`Dockerfile`).
fn bake_release_version() {
    let conf = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/desktop/src-tauri/tauri.conf.json");
    println!("cargo:rerun-if-changed={}", conf.display());
    if let Some(v) = fs::read_to_string(&conf)
        .ok()
        .as_deref()
        .and_then(top_level_version)
    {
        println!("cargo:rustc-env=HARKROOM_BUILD_VERSION={v}");
    }
}

/// 맨 바깥 객체의 `"version": "<값>"` — 빌드 스크립트라 JSON 파서 의존을 들이지 않는다. 값에 백슬래시가 있으면 굽지 않는다.
fn top_level_version(json: &str) -> Option<&str> {
    let b = json.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'{' | b'[' => depth += 1,
            b'}' | b']' => depth = depth.saturating_sub(1),
            b'"' => {
                // 문자열 끝(이스케이프 건너뜀).
                let mut end = i + 1;
                while end < b.len() && b[end] != b'"' {
                    end += if b[end] == b'\\' { 2 } else { 1 };
                }
                let s = json.get(i + 1..end)?;
                let after = json.get(end + 1..)?.trim_start();
                if depth == 1
                    && s == "version"
                    && let Some(rest) = after.strip_prefix(':')
                    && let Some(rest) = rest.trim_start().strip_prefix('"')
                    && let Some(close) = rest.find('"')
                {
                    let v = &rest[..close];
                    return (!v.is_empty() && !v.contains('\\')).then_some(v);
                }
                i = end;
            }
            _ => {}
        }
        i += 1;
    }
    None
}
