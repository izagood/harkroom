//! PTY 실행의 **프로세스 절반**(S3 B3b-2a). 정본은 `packages/agent/src/pty.ts` 의 `resolveExecutable`·`runPtyTurn` 의
//! spawn/exit/kill/write/resize 부분이다. 프롬프트 주입 상태 기계(준비·관문·제출 확인)는 B3b-2b 다.
//!
//! node-pty 대신 libc(`openpty`·`setsid`·`TIOCSCTTY`·`TIOCSWINSZ`·`kill`·`waitid`)를 직접 쓴다 — 오퍼레이터 lock 에
//! 이미 있는 판이고, 새 PTY crate 를 들이지 않는다(= 고정·14일 규칙). 정본과 달라진 점은 그 자리마다 적는다.

use std::ffi::OsString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 실행 파일 부재(정본 `ExecutableNotFoundError`, #340) — 턴 실패가 아니라 러너가 잘못 세워진 것이다.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutableNotFound {
    pub command: String,
    pub path: Option<String>,
}

impl std::fmt::Display for ExecutableNotFound {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "executable not found: {} (PATH={})",
            self.command,
            self.path.as_deref().unwrap_or("")
        )
    }
}

impl std::error::Error for ExecutableNotFound {}

fn is_executable(p: &Path) -> bool {
    let Ok(c) = std::ffi::CString::new(p.as_os_str().as_encoded_bytes()) else {
        return false;
    };
    // SAFETY: c 는 NUL 로 끝나는 유효한 C 문자열이다.
    unsafe { libc::access(c.as_ptr(), libc::X_OK) == 0 }
}

/// `command` 를 `path` 로 풀어 실행 가능한 절대 경로를 돌려준다(정본 `resolveExecutable`). execvp 규칙:
/// 이름에 `/` 가 있으면 그 경로만 보고, 빈 PATH 는 아무 데도 안 뒤진다. 왜 spawn 전에 재는지는 정본 주석.
pub fn resolve_executable(command: &str, path: Option<&str>) -> Option<PathBuf> {
    if command.contains('/') {
        let p = PathBuf::from(command);
        return is_executable(&p).then_some(p);
    }
    path.unwrap_or("")
        .split(':')
        .filter(|d| !d.is_empty())
        .map(|d| Path::new(d).join(command))
        .find(|c| is_executable(c))
}

#[derive(Debug)]
pub enum SpawnError {
    NotFound(ExecutableNotFound),
    Io(io::Error),
}

impl std::fmt::Display for SpawnError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(e) => e.fmt(f),
            Self::Io(e) => write!(f, "pty spawn: {e}"),
        }
    }
}

impl std::error::Error for SpawnError {}

pub struct SpawnSpec<'a> {
    /// 하네스 자체(감싸기 전) — 부재 사전 검사는 이것으로 한다(정본 순서).
    pub harness: &'a str,
    /// `compose_spawn` 이 낸 실제 spawn 대상·인자.
    pub command: &'a str,
    pub args: &'a [String],
    /// 자식 env 전체(정본 `plan.env` — 러너 env 를 물려주지 않는다).
    pub env: &'a [(String, String)],
    pub cwd: &'a Path,
    pub cols: u16,
    pub rows: u16,
}

/// 끝난 자식의 결과. node-pty 는 시그널로 죽으면 `exitCode` 0 에 `signal` 을 따로 준다 — 정본은 `exitCode` 만 쓴다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtyExit {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl PtyExit {
    /// 정본 `TurnResult.exitCode` 와 같은 값(node-pty unix: 시그널 종료면 0).
    pub fn node_exit_code(self) -> i32 {
        self.code.unwrap_or(0)
    }
}

struct State {
    /// waitid(WNOWAIT) 로 끝남을 본 뒤에 선다 — 이 뒤로는 kill 을 쏘지 않는다(회수 뒤 pid 재사용 방지).
    exited: bool,
    kill_escalation_armed: bool,
}

/// PTY 조작 손잡이(정본 `PtyControls`). 복제해 여러 곳(사람 입력·회수·시간 한도)이 쥔다. **전부 끝난 뒤엔 no-op 이고
/// 던지지 않는다** — 정본 `PtyWriter` 주석의 규율.
#[derive(Clone)]
pub struct PtyHandle {
    master: Arc<File>,
    pid: libc::pid_t,
    state: Arc<Mutex<State>>,
    kill_grace: Duration,
}

impl PtyHandle {
    pub fn pid(&self) -> u32 {
        self.pid as u32
    }

    pub fn write(&self, chunk: &[u8]) {
        if self.state.lock().map(|s| s.exited).unwrap_or(true) {
            return;
        }
        let _ = (&*self.master).write_all(chunk);
    }

    /// 살아 있는 PTY 에 TIOCSWINSZ — 커널이 전경 프로세스 그룹에 SIGWINCH 를 보낸다(새 프로세스 없음, #335).
    pub fn resize(&self, cols: u16, rows: u16) {
        if self.state.lock().map(|s| s.exited).unwrap_or(true) {
            return;
        }
        let ws = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        // SAFETY: master 는 열린 PTY master fd 이고 ws 는 유효한 winsize 다.
        unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ, &ws) };
    }

    fn signal(&self, sig: libc::c_int) -> bool {
        let Ok(s) = self.state.lock() else {
            return false;
        };
        if s.exited {
            return false;
        }
        // 잠금을 쥔 채로 쏜다 — waiter 는 이 잠금을 잡고 exited 를 세운 **뒤에야** 회수하므로 pid 가 아직 우리 것이다.
        // SAFETY: pid 는 회수되지 않은 우리 자식이다.
        unsafe { libc::kill(self.pid, sig) };
        true
    }

    /// 정본 `terminate`: SIGTERM 은 부탁이라 유예(`kill_grace`) 뒤 SIGKILL 로 승격한다. 승격 타이머는 한 번만 세운다.
    pub fn kill(&self, sigkill: bool) {
        if sigkill {
            self.signal(libc::SIGKILL);
            return;
        }
        if !self.signal(libc::SIGTERM) {
            return;
        }
        {
            let Ok(mut s) = self.state.lock() else { return };
            if s.kill_escalation_armed {
                return;
            }
            s.kill_escalation_armed = true;
        }
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(me.kill_grace);
            me.signal(libc::SIGKILL);
        });
    }
}

/// 띄운 PTY 하나. `reader` 는 master 의 읽기 끝(호출자의 읽기 스레드가 가져간다), `wait` 은 끝을 기다린다.
pub struct PtyProcess {
    pub handle: PtyHandle,
    pub reader: File,
    child: Child,
}

impl PtyProcess {
    /// 자식이 끝날 때까지 막는다. 회수 전에 `exited` 를 세워 그 뒤의 kill·write·resize 를 막는다.
    pub fn wait(mut self) -> io::Result<PtyExit> {
        let pid = self.handle.pid;
        loop {
            // SAFETY: 0 으로 채운 siginfo_t 는 유효하다. WNOWAIT 라 회수하지 않는다.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let r = unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOWAIT,
                )
            };
            if r == 0 {
                break;
            }
            let e = io::Error::last_os_error();
            if e.kind() != io::ErrorKind::Interrupted {
                return Err(e);
            }
        }
        if let Ok(mut s) = self.handle.state.lock() {
            s.exited = true;
        }
        let status = self.child.wait()?;
        use std::os::unix::process::ExitStatusExt;
        Ok(PtyExit {
            code: status.code(),
            signal: status.signal(),
        })
    }
}

fn cvt(r: libc::c_int) -> io::Result<libc::c_int> {
    if r == -1 {
        Err(io::Error::last_os_error())
    } else {
        Ok(r)
    }
}

/// PTY 를 열고 자식을 띄운다(정본 `nodePty().spawn`). 하네스 부재는 spawn **전에** 잰다(정본 순서·이유).
pub fn spawn_pty(spec: &SpawnSpec<'_>, kill_grace: Duration) -> Result<PtyProcess, SpawnError> {
    let path = spec
        .env
        .iter()
        .find(|(k, _)| k == "PATH")
        .map(|(_, v)| v.as_str());
    let not_found = || {
        SpawnError::NotFound(ExecutableNotFound {
            command: spec.harness.to_string(),
            path: path.map(str::to_string),
        })
    };
    if resolve_executable(spec.harness, path).is_none() {
        return Err(not_found());
    }
    // execvp 와 같게 PATH 로 푼다 — Command 는 부모 PATH 로 찾으므로 자식 env 의 PATH 로 직접 푼 절대 경로를 준다.
    let program = resolve_executable(spec.command, path).ok_or_else(not_found)?;

    let mut master: libc::c_int = -1;
    let mut slave: libc::c_int = -1;
    let mut ws = libc::winsize {
        ws_row: spec.rows,
        ws_col: spec.cols,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    // SAFETY: 출력 포인터는 유효하고, termios 는 null(기본), winsize 는 유효하다.
    cvt(unsafe {
        libc::openpty(
            &mut master,
            &mut slave,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut ws,
        )
    })
    .map_err(SpawnError::Io)?;
    // SAFETY: openpty 가 막 연 fd 다 — 소유권을 여기서 넘겨받는다.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    // master 는 자식에게 새면 안 된다(자식이 쥐고 있으면 EOF 가 오지 않는다).
    for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
        // SAFETY: 열린 fd 에 FD_CLOEXEC 를 세운다.
        cvt(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) }).map_err(SpawnError::Io)?;
    }

    let mut cmd = Command::new(&program);
    cmd.arg0(OsString::from(spec.command))
        .args(spec.args)
        .env_clear()
        .envs(spec.env.iter().map(|(k, v)| (k, v)))
        .current_dir(spec.cwd)
        .stdin(Stdio::from(slave.try_clone().map_err(SpawnError::Io)?))
        .stdout(Stdio::from(slave.try_clone().map_err(SpawnError::Io)?))
        .stderr(Stdio::from(slave.try_clone().map_err(SpawnError::Io)?));
    // SAFETY: pre_exec 안에서는 async-signal-safe 호출(setsid·ioctl)만 한다.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            // stdin(=slave)을 제어 터미널로 — 하네스의 Ctrl-C·SIGWINCH 가 여기서 산다.
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd.spawn().map_err(|e| {
        // 사전 검사와 spawn 사이의 경쟁 등 — 결론이 같으니 같은 타입으로 올린다(정본 ENOENT 승격).
        if e.kind() == io::ErrorKind::NotFound {
            not_found()
        } else {
            SpawnError::Io(e)
        }
    })?;
    drop(slave);
    let master = File::from(master);
    let reader = master.try_clone().map_err(SpawnError::Io)?;
    let handle = PtyHandle {
        master: Arc::new(master),
        pid: child.id() as libc::pid_t,
        state: Arc::new(Mutex::new(State {
            exited: false,
            kill_escalation_armed: false,
        })),
        kill_grace,
    };
    Ok(PtyProcess {
        handle,
        reader,
        child,
    })
}

/// master 를 끝까지 읽는다 — 자식 쪽이 모두 닫히면 macOS·Linux 모두 EIO(또는 0)로 끝난다. 그것은 오류가 아니라 끝이다.
pub fn read_until_closed(mut reader: File, mut on_chunk: impl FnMut(&[u8])) {
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => return,
            Ok(n) => on_chunk(&buf[..n]),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return,
        }
    }
}

#[cfg(test)]
mod tests;
