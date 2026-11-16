//! TS 서버의 마이그레이션 파일 이름(정본 `packages/server/src/db/migrations/*.sql`)을 바이너리에 굽는다.
//! 기동할 때 DB 의 `schema_migrations` 와 대조한다(`src/schema.rs`). 본문도 굽는다 — 마이그레이션 실행기(`src/migrate.rs`, 기본 꺼짐)가 쓴다.
use std::{env, fs, path::Path};

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/server/src/db/migrations");
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
}
