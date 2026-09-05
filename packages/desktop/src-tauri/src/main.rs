#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 비밀 보관은 **OS 키체인**에 맡긴다(macOS Keychain / Windows Credential Manager /
//! Linux Secret Service). Tauri 에 공식 키체인 플러그인이 없어 `keyring` 크레이트를 세 개의
//! 명령으로 노출한다 — 플러그인을 기다리는 것보다 얇고, 프런트가 보는 표면은 어차피 같다.
//!
//! 프런트는 이 세 명령이 없거나 실패하는 환경(브라우저 개발·테스트)에서 `localStorage` 로
//! 물러난다(`lib/session.ts`). 그래서 여기서는 실패를 숨기지 않고 문자열로 돌려준다 —
//! 조용히 성공한 척하면 프런트가 평문 경로로 내려갈 기회를 잃는다.

use std::collections::HashMap;
use std::sync::Mutex;

const SERVICE: &str = "app.murmur.desktop";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

/// 없으면 `None`. "없다"와 "읽을 수 없다"는 다르다 — 후자는 Err 로 올려야 프런트가
/// 폴백할지 로그아웃할지 판단할 수 있다.
#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

/// 없는 것을 지우는 것도 성공이다 — 결과 상태가 같으니 재시도가 안전하다.
#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

// ---------------------------------------------------------------------------
// 러너 프로세스 그룹 분리 spawn(#431 1단계 A).
//
// **왜 이것이 필요한가**(실측, 2026-09-05): 앱을 SIGKILL 해도 러너는 살아남았지만 PGID 가
// 앱 프로세스 그룹 그대로였고, `kill -TERM -<그 그룹>` 한 번에 러너 전부가 죽었다. 즉
// 러너가 살아남는 것은 "아무도 그 그룹에 시그널을 안 보내서"일 뿐이고, 앱 종료 훅에 누가
// `dispose()`류 정리를 연결하거나 launcher(pnpm)·셸·OS 가 세션 종료로 그룹에 시그널을
// 보내는 순간 이 우연한 생존은 사라진다. orca 는 daemon 을 자기 PGID 로 분리해 이 경로를
// 원천 차단한다 — 이 spawn 이 같은 일을 한다: 자식을 **자기 세션/프로세스 그룹**으로 뗀다.
//
// **`tauri-plugin-shell` 의 `Command.create` 는 이 제어를 노출하지 않는다** — 그래서
// `#425` 가 만든 패턴(웹뷰는 파라미터를 넘기지 않고 실행 대상·인자가 Rust 안에 고정되는
// invoke 커맨드)을 그대로 재사용한다. `shell:allow-spawn` 스코프의 리터럴 인자 제약과
// 같은 이유로, 여기서도 웹뷰가 프로그램·인자·옵션 중 어느 것도 고르지 못한다.
// ---------------------------------------------------------------------------

/// 띄운 자식의 핸들. `wait()` 는 **한 번만** 성공한다(`std::process::Child::wait` 의 계약) —
/// 그래서 종료를 기다리는 스레드가 끝난 뒤에는 exit code 를 여기 캐시해 두 번째 이후의
/// `runner_wait_exit` 호출(느린 IPC 재시도 등)도 같은 값을 돌려준다.
struct RunnerChild {
    child: std::sync::Arc<Mutex<std::process::Child>>,
    /// 종료 코드. `wait()` 가 끝나기 전에는 `None`. 시그널로 죽었으면 계속 `None`이다
    /// (Unix 의 `ExitStatus::code()` 계약과 같다) — 그 경우 JS 쪽 `onExit(null)` 로 이어진다.
    exit_code: std::sync::Arc<Mutex<Option<i32>>>,
}

/// 이 앱이 띄운 러너 전부. pid → 핸들. **이 앱이 띄운 것만** 담는다 — 외부 러너는 여기
/// 없고, 이 표를 거치지 않는 pid 에 대한 kill·wait 요청은 전부 거절한다(`RunnerNotFound`).
struct RunnerRegistry(Mutex<HashMap<u32, RunnerChild>>);

/// 러너 사이드카의 스코프 이름. **`tauri.conf.json` 의 `bundle.externalBin` 항목 이름과
/// 반드시 같아야 한다** — 다르면 번들 빌드가 그 이름으로 복사한 실행 파일을 여기서 못 찾는다.
const RUNNER_SIDECAR_NAME: &str = "murmur-runner";

/// 이 실행 파일(앱)과 같은 디렉터리에서 사이드카를 찾는다. Tauri 의 `externalBin` 번들링이
/// `<name>-<target-triple>` 을 `<name>` 으로 이름을 바꿔 앱 실행 파일과 **같은 디렉터리**에
/// 복사한다(`tauri-build::copy_binaries`) — 그래서 `current_exe()` 의 부모 디렉터리를 그대로
/// 쓴다. 개발 모드(`cargo run`)에서도 `cargo-tauri`가 빌드된 사이드카를 `target/debug/` 로
/// 미리 복사해 두므로 같은 경로 규칙이 그대로 통한다.
fn sidecar_path() -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("실행 파일 경로를 얻지 못했다: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "실행 파일에 부모 디렉터리가 없다".to_string())?;
    let name = if cfg!(windows) {
        format!("{RUNNER_SIDECAR_NAME}.exe")
    } else {
        RUNNER_SIDECAR_NAME.to_string()
    };
    Ok(dir.join(name))
}

/// 프로세스 그룹 분리를 건 `Command` 를 만든다. **`runner_spawn` 과 `tests::` 아래 회귀
/// 테스트가 이 함수 하나를 공유한다** — 실물 커맨드 안에 인라인해 두면 테스트가
/// `tauri::State`·`AppHandle` 없이는 이 로직을 부를 수 없고, 그러면 "PGID 가 자기 자신인지"
/// 를 실제 프로세스로 재는 자리가 이 파일에 없어진다.
///
/// **핵심 한 줄**: 자식을 새 세션의 리더로 만든다 — `setsid(2)` 는 새 세션과 새 프로세스
/// 그룹을 만들고 그 그룹의 PGID 를 자기 pid 로 세운다. `fork` 뒤·`exec` 전에 자식 프로세스
/// 안에서 불러야 하므로 `pre_exec` 훅을 쓴다(`exec` 뒤에는 이 프로세스 자신이 사라지므로
/// 다른 자리가 없다).
///
/// Windows 의 대응 개념은 `CREATE_NEW_PROCESS_GROUP` 이다 — 콘솔 이벤트(Ctrl+C 등)가 새
/// 그룹에 전파되지 않게 분리한다. Windows 에는 POSIX 프로세스 그룹이 없어 완전히 같은
/// 것은 아니지만, "부모 콘솔·잡(job)에 딸린 시그널이 자식에 안 가게 한다"는 목적은 같다.
fn detached_command(program: &std::path::Path) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);

    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                // -1 은 "이미 세션 리더다"(그럴 리 없다 — 방금 fork 된 자식은 부모의
                // 그룹에 있다) 뿐이라 여기서는 사실상 일어나지 않는다. 혹시 나면 자식은
                // 원래 그룹에 남을 뿐 exec 자체는 계속 진행되게 둔다 — spawn 자체를
                // 막을 이유는 아니다(이어지는 PGID 회귀선이 그 실패를 그대로 잡아낸다).
                if libc::setsid() == -1 {
                    // errno 를 그대로 남긴다 — 여기서 이유를 지어내지 않는다(#368).
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }

    cmd
}

/// 러너를 자기 세션/프로세스 그룹으로 분리해 띄운다. **파라미터는 환경변수 값 두 개뿐이다**
/// (PAT·서버 주소) — 실행할 프로그램 경로·인자는 `sidecar_path()`가 고정하고, 웹뷰는 그
/// 프로그램의 이름도 인자도 고르지 못한다. `env` 는 값이지 실행 표면이 아니다(플러그인
/// 셸 스코프의 인자 리터럴 제약과 다른 층위).
///
/// **회귀선이 재는 것**: `tests::setsid_로_띄운_자식의_pgid_는_자기_자신이다` 가 실제
/// 프로세스를 `detached_command()` 로 띄워 그 PGID 가 **자기 자신과 같은지** 확인한다.
/// 앱 PGID 와 같으면 `setsid` 가 빠졌거나 깨졌다는 뜻이고 그것이 곧 이 스폰의 실패다 —
/// §5(앱 업데이트와 러너 생존이 무관하다)가 다시 우연이 된다.
#[tauri::command]
fn runner_spawn(
    registry: tauri::State<RunnerRegistry>,
    murmur_pat: String,
    murmur_url: String,
    path: String,
) -> Result<u32, String> {
    use std::process::Stdio;

    let program = sidecar_path()?;
    if !program.is_file() {
        return Err(format!(
            "러너 사이드카를 찾지 못했다: `{}` — 빌드가 externalBin 을 이 이름으로 넣었는지 확인하라",
            program.display()
        ));
    }

    let mut cmd = detached_command(&program);
    cmd.env("MURMUR_PAT", murmur_pat)
        .env("MURMUR_URL", murmur_url)
        .env("PATH", path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = cmd
        .spawn()
        .map_err(|e| format!("러너를 띄우지 못했다: {e}"))?;
    let pid = child.id();

    let mut map = registry
        .0
        .lock()
        .map_err(|_| "레지스트리 락이 깨졌다".to_string())?;
    map.insert(
        pid,
        RunnerChild {
            child: std::sync::Arc::new(Mutex::new(child)),
            exit_code: std::sync::Arc::new(Mutex::new(None)),
        },
    );

    Ok(pid)
}

/// 이 pid 의 종료를 기다린다. **자식보다 오래 걸릴 수 있으므로 블로킹 스레드로 돌린다** —
/// `tauri::async_runtime::spawn_blocking` 이 그 자리다. JS 는 `runner_spawn` 직후 이
/// 커맨드를 fire-and-forget 으로 불러 그 Promise 해소를 `onExit` 통지로 쓴다
/// (`runnerLauncher.ts::tauriSpawner`) — `#419` 의 세대 토큰 판정은 여전히 JS 쪽
/// `RunnerLauncher.handleExit` 이 맡는다. 여기는 "언젠가 끝났다"만 사실대로 전한다.
///
/// **동시에 기다리는 호출자**는 캐시된 값을 즉시 돌려받는다 — `wait()` 는 한 번만 성공하는
/// 계약이라, 다시 부르면 이미 사라진 자식을 기다리다 잘못된 값을 줄 수 있다. 표에서 항목을
/// 빼기 전에 `Arc` 를 이미 복제해 두므로(아래 `entry` 블록), 종료 관측과 겹쳐 들어온 호출도
/// 같은 `exit_code` 를 본다.
///
/// 종료를 관측한 **뒤에** 처음 부르면 표에 항목이 없어 `Err` 가 된다 — 그 pid 는 이 앱이
/// 지금 들고 있는 자식이 아니기 때문이다(OS 가 그 번호를 이미 다른 프로세스에 줬을 수도
/// 있다). JS 쪽은 spawn 직후 한 번만 부르므로(`tauriSpawner`) 이 경로로 들어오지 않고,
/// 들어오더라도 `.catch` 가 `onExit(null)` 로 받아 세대 토큰이 그것을 거른다.
#[tauri::command]
async fn runner_wait_exit(
    registry: tauri::State<'_, RunnerRegistry>,
    pid: u32,
) -> Result<Option<i32>, String> {
    let entry = {
        let map = registry
            .0
            .lock()
            .map_err(|_| "레지스트리 락이 깨졌다".to_string())?;
        map.get(&pid)
            .map(|r| (r.child.clone(), r.exit_code.clone()))
    };
    let Some((child, exit_code)) = entry else {
        return Err(format!("이 앱이 띄운 러너가 아니다: pid {pid}"));
    };

    if let Some(code) = *exit_code
        .lock()
        .map_err(|_| "종료 코드 락이 깨졌다".to_string())?
    {
        return Ok(Some(code));
    }

    let status = tauri::async_runtime::spawn_blocking(move || {
        child
            .lock()
            .map_err(|_| "자식 락이 깨졌다".to_string())?
            .wait()
            .map_err(|e| format!("종료를 기다리는 중 오류: {e}"))
    })
    .await
    .map_err(|e| format!("대기 스레드가 끊겼다: {e}"))??;

    let code = status.code();
    *exit_code
        .lock()
        .map_err(|_| "종료 코드 락이 깨졌다".to_string())? = code;

    // 끝난 자식은 표에서 뺀다. 안 빼면 앱이 도는 내내 pid 마다 항목이 쌓이고, 무엇보다
    // **OS 가 pid 를 재사용한다**는 사실과 어긋난 표가 남는다 — 죽은 pid 가 표에 살아 있으면
    // `runner_kill` 이 그 pid 를 "이 앱 것"이라고 판정하는 창이 생긴다. 종료를 관측한 이 자리가
    // 그 항목을 지울 유일하게 정확한 시점이다(`runner_kill` 의 "표에 없으면 성공" 논리는
    // 이 제거가 있어야 비로소 사실이 된다).
    //
    // 종료 코드는 위에서 `exit_code`(Arc)에 이미 넣었고 이 함수가 그 값을 그대로 돌려주므로,
    // 표에서 빠져도 지금 대기 중인 호출자들은 같은 값을 받는다.
    if let Ok(mut map) = registry.0.lock() {
        map.remove(&pid);
    }
    Ok(code)
}

/// 이 앱이 띄운 러너를 죽인다. **이 표에 없는 pid 는 거절한다** — 앱은 자기가 띄운 것만
/// 죽일 수 있고, 죽여서도 안 된다(`RunnerLauncher.runners` 주석과 같은 경계).
#[tauri::command]
fn runner_kill(registry: tauri::State<RunnerRegistry>, pid: u32) -> Result<(), String> {
    let map = registry
        .0
        .lock()
        .map_err(|_| "레지스트리 락이 깨졌다".to_string())?;
    let Some(entry) = map.get(&pid) else {
        // 이미 종료를 관측해 `runner_wait_exit` 이 표에서 뺐거나, 애초에 이 앱 것이 아니다.
        // 어느 쪽이든 **여기서 그 pid 에 시그널을 보내지 않는다** — 표에 없는 번호를 죽이면
        // OS 가 그 번호를 재사용해 붙인 남의 프로세스를 죽일 수 있다. 이미 없는 것을 지우는
        // 것과 같은 논리로(`secret_delete`) 성공으로 본다 — 재시도가 안전하다.
        return Ok(());
    };
    let mut child = entry
        .child
        .lock()
        .map_err(|_| "자식 락이 깨졌다".to_string())?;
    // 이미 죽은 자식에 `kill()` 을 부르면 플랫폼에 따라 오류가 날 수 있다 — 그 상태 자체는
    // "성공"과 같은 결과이므로(둘 다 "이제 안 산다"), `try_wait()` 로 먼저 확인해 늦은
    // kill 이 사람에게 거짓 오류를 보이지 않게 한다(`secret_delete` 와 같은 재시도-안전 논리).
    if matches!(child.try_wait(), Ok(Some(_))) {
        return Ok(());
    }
    child
        .kill()
        .map_err(|e| format!("러너를 종료하지 못했다: {e}"))
}

fn main() {
    tauri::Builder::default()
        // 멘션 알림 표면. 권한은 capabilities/default.json 에서 허용한다.
        .plugin(tauri_plugin_notification::init())
        // 링크를 OS 로 넘기는 표면. 권한은 capabilities/default.json 에서 허용한다.
        .plugin(tauri_plugin_shell::init())
        .manage(RunnerRegistry(Mutex::new(HashMap::new())))
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_delete,
            runner_spawn,
            runner_wait_exit,
            runner_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running murmur");
}

#[cfg(all(test, unix))]
mod tests {
    //! `#431` 1단계 A 의 회귀선 — **PGID 가 자기 자신인지**를 실제 프로세스로 잰다.
    //!
    //! 왜 이것이 필요한가(실측, 2026-09-05): 앱을 SIGKILL 해도 러너는 살아남았지만 PGID 가
    //! 앱 프로세스 그룹 그대로였고, `kill -TERM -<그 그룹>` 한 번에 러너 전부가 죽었다.
    //! `setsid` 가 빠지면 이 테스트가 그 회귀를 그대로 재현한다 — "되돌려 RED" 절차가
    //! 확인하는 것이 정확히 이것이다.
    use super::detached_command;
    use std::process::Stdio;
    use std::{thread, time::Duration};

    /// 이 프로세스(테스트 러너) 자신의 PGID. 자식이 이것과 **다르면** 분리가 된 것이다.
    fn own_pgid() -> libc::pid_t {
        unsafe { libc::getpgid(0) }
    }

    fn child_pgid(pid: u32) -> libc::pid_t {
        unsafe { libc::getpgid(pid as libc::pid_t) }
    }

    #[test]
    fn setsid_로_띄운_자식의_pgid_는_자기_자신이다() {
        // `sleep` 은 어느 유닉스 기기에도 있고, PGID 를 잴 동안 살아 있게 붙잡아 두는
        // 용도로 충분하다 — 사이드카 자체를 여기서 띄우지 않는 이유는 이 테스트가
        // "분리 메커니즘"만 재기 때문이다(사이드카 존재 여부는 `build:sidecar`의 몫).
        let mut cmd = detached_command(std::path::Path::new("/bin/sleep"));
        cmd.arg("2")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let mut child = cmd
            .spawn()
            .expect("sleep 을 못 띄웠다 — /bin/sleep 이 있는지 확인하라");
        let pid = child.id();

        // fork 직후 pre_exec 가 setsid 를 걸 시간을 준다 — 경쟁을 피하려고 살짝 기다린다.
        thread::sleep(Duration::from_millis(50));

        let pgid = child_pgid(pid);
        assert_ne!(
            pgid,
            own_pgid(),
            "자식의 PGID({pgid})가 이 테스트 프로세스의 PGID({})와 같다 — \
             setsid 가 빠졌거나 깨졌다는 뜻이다. 이것이 §5(앱 종료와 러너 생존이 무관하다)가 \
             다시 우연이 되는 그 실패다.",
            own_pgid()
        );
        // 분리된 세션의 리더는 자기 자신의 pid 가 곧 PGID 다(setsid(2) 의 계약).
        assert_eq!(
            pgid, pid as libc::pid_t,
            "PGID 가 자기 자신의 pid 와도 다르다 — 분리는 됐지만 세션 리더가 아니다",
        );

        let _ = child.kill();
        let _ = child.wait();
    }
}
