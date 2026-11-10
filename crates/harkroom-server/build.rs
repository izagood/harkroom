//! TS 서버의 마이그레이션 파일 이름(정본 `packages/server/src/db/migrations/*.sql`)을 바이너리에 굽는다.
//! 기동할 때 DB 의 `schema_migrations` 와 대조한다(`src/schema.rs`).
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
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("migrations.rs"),
        body,
    )
    .unwrap();
}
