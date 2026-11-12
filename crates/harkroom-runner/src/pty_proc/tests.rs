use super::*;
use std::sync::mpsc;
use std::time::Instant;

fn env() -> Vec<(String, String)> {
    vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("TERM".into(), "xterm-256color".into()),
    ]
}

fn run(
    cmd: &str,
    args: &[&str],
    cols: u16,
    rows: u16,
) -> (PtyHandle, mpsc::Receiver<Vec<u8>>, PtyProcess) {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let env = env();
    let spec = SpawnSpec {
        harness: cmd,
        command: cmd,
        args: &args,
        env: &env,
        cwd: Path::new("/"),
        cols,
        rows,
    };
    let p = spawn_pty(&spec, Duration::from_millis(300)).expect("spawn");
    let (tx, rx) = mpsc::channel();
    let reader = p.reader.try_clone().unwrap();
    std::thread::spawn(move || {
        read_until_closed(reader, |c| {
            let _ = tx.send(c.to_vec());
        })
    });
    (p.handle.clone(), rx, p)
}

fn collect(rx: &mpsc::Receiver<Vec<u8>>) -> String {
    let mut out = Vec::new();
    while let Ok(c) = rx.recv_timeout(Duration::from_secs(2)) {
        out.extend(c);
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[test]
fn resolve_executable_follows_execvp_rules() {
    assert_eq!(
        resolve_executable("sh", Some("/nope:/bin")),
        Some(PathBuf::from("/bin/sh"))
    );
    assert_eq!(resolve_executable("sh", Some("")), None);
    assert_eq!(resolve_executable("sh", None), None);
    assert_eq!(
        resolve_executable("/bin/sh", None),
        Some(PathBuf::from("/bin/sh"))
    );
    assert_eq!(
        resolve_executable("./definitely-missing", Some("/bin")),
        None
    );
}

#[test]
fn missing_harness_is_not_found_before_spawn() {
    let env = env();
    let args = vec!["-c".to_string(), "exec nope".to_string()];
    let spec = SpawnSpec {
        harness: "harkroom-no-such-harness",
        command: "/bin/sh",
        args: &args,
        env: &env,
        cwd: Path::new("/"),
        cols: 80,
        rows: 24,
    };
    match spawn_pty(&spec, Duration::from_secs(1)) {
        Err(SpawnError::NotFound(e)) => assert_eq!(e.command, "harkroom-no-such-harness"),
        other => panic!("{:?}", other.err()),
    }
}

#[test]
fn child_sees_tty_size_env_and_exit_code() {
    let (_h, rx, p) = run(
        "/bin/sh",
        &[
            "-c",
            "test -t 0 && echo TTY; stty size; echo \"T=$TERM\"; exit 7",
        ],
        101,
        33,
    );
    let exit = p.wait().unwrap();
    let out = collect(&rx);
    assert!(out.contains("TTY"), "{out:?}");
    assert!(out.contains("33 101"), "{out:?}");
    assert!(out.contains("T=xterm-256color"), "{out:?}");
    assert_eq!(
        exit,
        PtyExit {
            code: Some(7),
            signal: None
        }
    );
    assert_eq!(exit.node_exit_code(), 7);
}

#[test]
fn write_reaches_stdin_and_resize_reaches_child() {
    let (h, rx, p) = run(
        "/bin/sh",
        &["-c", "read a; stty size; echo \"GOT=$a\""],
        80,
        24,
    );
    std::thread::sleep(Duration::from_millis(200));
    h.resize(132, 50);
    h.write(b"hello\r");
    let exit = p.wait().unwrap();
    let out = collect(&rx);
    assert!(out.contains("GOT=hello"), "{out:?}");
    assert!(out.contains("50 132"), "{out:?}");
    assert_eq!(exit.code, Some(0));
    // 끝난 뒤 조작은 no-op 이고 던지지 않는다.
    h.write(b"x");
    h.resize(10, 10);
    h.kill(true);
}

#[test]
fn sigterm_escalates_to_sigkill_after_grace() {
    let (h, _rx, p) = run(
        "/bin/sh",
        &["-c", "trap '' TERM; while :; do sleep 0.05; done"],
        80,
        24,
    );
    std::thread::sleep(Duration::from_millis(200));
    let t = Instant::now();
    h.kill(false);
    h.kill(false); // 두 번째는 유예를 늘리지 않는다
    let exit = p.wait().unwrap();
    assert_eq!(exit.signal, Some(libc::SIGKILL));
    assert_eq!(exit.node_exit_code(), 0);
    let el = t.elapsed();
    assert!(
        el >= Duration::from_millis(280) && el < Duration::from_secs(3),
        "{el:?}"
    );
}

#[test]
fn master_is_not_leaked_into_child() {
    let (h, _rx, p) = run("/bin/sh", &["-c", "ls /dev/fd"], 80, 24);
    let _ = h;
    // 자식이 master 를 쥐고 있으면 wait 뒤 reader 가 끝나지 않는다 — 끝남 자체가 확인이다.
    let exit = p.wait().unwrap();
    assert_eq!(exit.code, Some(0));
}

#[test]
fn not_found_message_hides_local_path() {
    let e = ExecutableNotFound {
        command: "claude".into(),
        path: Some("/opt/secret-dir/bin:/usr/bin".into()),
    };
    let shown = e.to_string();
    assert_eq!(shown, "executable not found: claude");
    assert!(!format!("{}", SpawnError::NotFound(e.clone())).contains("secret-dir"));
    assert!(e.local_detail().contains("PATH=/opt/secret-dir/bin"));
}

#[test]
fn reader_stops_on_flag_even_if_never_closed() {
    use std::sync::atomic::{AtomicBool, Ordering};
    // 쓰는 끝을 쥔 채 두는 파이프 = 손자가 slave 를 쥔 PTY 와 같은 모양(읽기 끝이 영영 안 닫힘).
    let mut fds = [0; 2];
    assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
    let reader = unsafe { File::from_raw_fd(fds[0]) };
    let writer = unsafe { File::from_raw_fd(fds[1]) };
    (&writer).write_all(b"hi").unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = std::sync::mpsc::channel();
    let s2 = stop.clone();
    std::thread::spawn(move || {
        let mut got = Vec::new();
        read_until_closed_or_stopped(reader, &s2, |c| got.extend_from_slice(c));
        tx.send(got).unwrap();
    });
    assert!(
        rx.recv_timeout(Duration::from_millis(300)).is_err(),
        "깃발 전엔 끝나면 안 된다"
    );
    stop.store(true, Ordering::Release);
    let got = rx
        .recv_timeout(Duration::from_secs(2))
        .expect("깃발 뒤엔 끝나야 한다");
    assert_eq!(got, b"hi");
    drop(writer);
}
