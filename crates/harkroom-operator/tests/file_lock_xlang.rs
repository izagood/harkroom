//! P5 파일 잠금을 TS(`packages/operator/src/fileLock.ts`)와 Rust 가 **한 잠금 파일로 번갈아** 잡는지 — 두 프로세스가
//! 같은 카운터 파일을 잠금 안에서 읽고 +1 해 쓴다. 하나라도 잠금을 어기면 증가가 사라져 합이 모자란다.
//!
//! Node 가 있어야 하므로 `HARKROOM_XLANG_TSX=<tsx 경로>` 가 있을 때만 돈다(crates CI 에는 Node 가 없다).
//!   HARKROOM_XLANG_TSX=$PWD/../../packages/operator/node_modules/.bin/tsx cargo test --test file_lock_xlang
use harkroom_operator::file_lock::{FileLockOptions, with_file_lock};
use std::process::Command;
use std::time::Duration;

const ROUNDS: u32 = 200;

#[test]
fn ts_and_rust_take_turns_on_one_lock() {
    let Ok(tsx) = std::env::var("HARKROOM_XLANG_TSX") else {
        eprintln!("HARKROOM_XLANG_TSX 가 없어 건너뛴다");
        return;
    };
    let dir = std::env::temp_dir().join(format!("hk-lock-xlang-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let lock = dir.join("usage.json.lock");
    let counter = dir.join("counter");
    std::fs::write(&counter, "0").unwrap();
    let file_lock_ts = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/operator/src/fileLock.ts");
    let script = format!(
        r#"import {{ readFile, writeFile }} from 'node:fs/promises';
const {{ withFileLock }} = await import({ts:?});
for (let i = 0; i < {ROUNDS}; i++) {{
  await withFileLock({lock:?}, async () => {{
    const n = Number(await readFile({counter:?}, 'utf8'));
    await new Promise((r) => setImmediate(r));
    await writeFile({counter:?}, String(n + 1));
  }}, {{ retryMs: 1, timeoutMs: 20000 }});
}}
"#,
        ts = file_lock_ts.canonicalize().unwrap().to_string_lossy(),
        lock = lock.to_string_lossy(),
        counter = counter.to_string_lossy(),
    );
    let script_path = dir.join("ts-side.mts");
    std::fs::write(&script_path, script).unwrap();
    let mut child = Command::new(tsx).arg(&script_path).spawn().unwrap();
    let opts = FileLockOptions {
        retry: Duration::from_millis(1),
        timeout: Duration::from_secs(20),
        ..Default::default()
    };
    for _ in 0..ROUNDS {
        with_file_lock(&lock, &opts, || {
            let n: u32 = std::fs::read_to_string(&counter)
                .unwrap()
                .trim()
                .parse()
                .unwrap();
            std::thread::yield_now();
            std::fs::write(&counter, (n + 1).to_string()).unwrap();
        })
        .unwrap();
    }
    assert!(child.wait().unwrap().success(), "TS 쪽이 실패했다");
    assert_eq!(
        std::fs::read_to_string(&counter).unwrap(),
        (ROUNDS * 2).to_string()
    );
    assert!(!lock.exists(), "잠금 파일이 남았다");
    let _ = std::fs::remove_dir_all(&dir);
}
