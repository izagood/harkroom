#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! 비밀 보관은 **OS 키체인**에 맡긴다(macOS Keychain / Windows Credential Manager /
//! Linux Secret Service). Tauri 에 공식 키체인 플러그인이 없어 `keyring` 크레이트를 세 개의
//! 명령으로 노출한다 — 플러그인을 기다리는 것보다 얇고, 프런트가 보는 표면은 어차피 같다.
//!
//! 프런트는 이 세 명령이 없거나 실패하는 환경(브라우저 개발·테스트)에서 `localStorage` 로
//! 물러난다(`lib/session.ts`). 그래서 여기서는 실패를 숨기지 않고 문자열로 돌려준다 —
//! 조용히 성공한 척하면 프런트가 평문 경로로 내려갈 기회를 잃는다.

mod daemon_client;

use std::collections::HashMap;

const SERVICE: &str = "app.murmur.desktop";

fn entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// 키체인 커맨드는 **절대 메인 스레드에서 돌면 안 된다** — `#450`
//
// ## 무엇이 일어났나 (실측 2026-09-06)
//
// 앱이 러너를 하나도 안 띄우고 멎었다. `sample` 로 5초를 떴더니 **3875/3875 샘플이 한
// 지점**에 있었다:
//
// ```text
// main-thread → tauri ipc → keyring::Entry::get_password
//   → SecKeychainFindGenericPassword → CSSM_DecryptDataFinal
// ```
//
// 그리고 같은 시각 `SecurityAgent`(macOS 의 키체인 승인 대화상자) 프로세스가 떠 있었다.
//
// **키체인 읽기가 사용자 승인을 요구할 수 있다.** 재빌드로 앱 서명이 바뀌면 키체인 ACL 이
// 무효화돼 매번 물어보므로, 개발 중 반복 빌드 환경에서 특히 잘 난다.
//
// ## 왜 진단하기 어려운가 — 이것이 이 주석의 존재 이유다
//
// **앱이 죽지 않는다.** 크래시도, 에러 로그도, 예외도 없다. 프로세스는 살아 있고 창도
// 그려져 있다. 겉으로 보이는 것은 "러너가 안 뜬다"뿐이라, 러너·사이드카·PATH·소켓을
// 아무리 봐도 원인이 안 나온다(실제로 그 순서로 헤맸다). 접근성 트리조차 무응답이므로
// UI 자동화로도 안 잡힌다. **`sample` 로 스택을 떠야만 보인다.**
//
// ## 왜 `spawn_blocking` 인가 — `async fn` 만으로는 부족하다
//
// 동기 `#[tauri::command]` 는 Tauri 가 **메인 스레드에서** 실행한다. 그래서 `async fn` 으로
// 바꾸는 것이 첫 걸음이다. 그런데 `keyring` 자체가 동기라, `async fn` 안에서 그대로
// 부르면 이번에는 **async 런타임의 워커 스레드**가 블록된다 — 메인 스레드는 살았지만 그
// 워커를 쓰는 다른 커맨드들이 줄줄이 밀린다. 이 앱에서 그 줄에 서는 것이 바로
// `daemon_spawn_runner` 다(러너 기동은 키체인 읽기 **다음** 순서다).
//
// `spawn_blocking` 은 그 목적으로 있는 자리다: 블로킹 작업 전용 풀에서 돌려 메인 스레드도
// async 워커도 잡지 않는다.
//
// ## 타임아웃을 두지 않는다
//
// 승인 대화상자가 떠 있는 동안 이 호출은 **정상적으로** 오래 걸린다. 타임아웃은
// "사람이 아직 안 눌렀다"와 "고장났다"를 구분하지 못하고, 앞의 것을 실패로 처리하면
// 사람이 승인을 누른 뒤에도 앱은 이미 실패한 상태다 — 지금보다 나쁘다.
// `#431` 이 러너 유예에 상한을 두지 않은 것과 같은 판단이다.
//
// ## `async` 를 떼도 **아무것도 안 깨진다** — 타입이 막아 주지 않는다
//
// "그래도 컴파일이나 타입이 잡아 주겠지"라고 생각하기 쉬운데, **못 잡는다.** 웹뷰 쪽
// 호출은 `await invoke('secret_get', { key })`(`lib/runnerLauncher.ts`) 하나이고,
// **`invoke` 는 Rust 가 `fn` 이든 `async fn` 이든 언제나 `Promise` 를 돌려준다.** 그래서
// 누가 `async` 를 떼도 TS 는 그대로 통과하고, 조용히 메인 스레드로 돌아간다.
//
// 이것이 이 결함의 성질이기도 하다 — **처음 동기로 쓰였을 때도 아무 신호가 없었다.**
//
// ## 회귀선에 대해 — **증상을 재현하는 것은 없다**
//
// 키체인 승인 대화상자를 테스트에서 만들 방법이 없고, "메인 스레드가 안 막힌다"를 재려면
// 그 대화상자가 필요하다. 그래서 `test/runnerShellScope.test.ts` 가 **소스를 읽어
// `async fn` + `spawn_blocking` 이라는 성질만** 고정한다 — 위에서 본 대로 타입이 못 잡으니
// 그것이라도 있어야 변경이 눈에 띈다. 동기로 되돌렸을 때 RED 가 되는 것은 그 검사뿐이다.
//
// ## 이 수정이 맞다는 증거 (실측 2026-09-06)
//
// 사용자가 대화상자에 응답하자 **앱을 재시작하지 않았는데 같은 프로세스가 그대로 풀리고
// 러너 2개가 떴다.** 추정이 아니라 관측이다 — 앱은 고장난 것이 아니라 **기다리고 있었다.**
// 그 기다림은 10분을 넘겼고, 그것이 정상 동작이었다. 타임아웃을 뒀다면 사실이 아닌
// "실패"를 화면에 띄웠을 것이다.
// ---------------------------------------------------------------------------

/// 없으면 `None`. "없다"와 "읽을 수 없다"는 다르다 — 후자는 Err 로 올려야 프런트가
/// 폴백할지 로그아웃할지 판단할 수 있다.
#[tauri::command]
async fn secret_get(key: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || match entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| format!("키체인 조회 스레드가 끊겼다: {e}"))?
}

#[tauri::command]
async fn secret_set(key: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        entry(&key)?.set_password(&value).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("키체인 저장 스레드가 끊겼다: {e}"))?
}

/// 없는 것을 지우는 것도 성공이다 — 결과 상태가 같으니 재시도가 안전하다.
#[tauri::command]
async fn secret_delete(key: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    })
    .await
    .map_err(|e| format!("키체인 삭제 스레드가 끊겼다: {e}"))?
}

// ---------------------------------------------------------------------------
// 프로세스 그룹 분리 spawn(#431 1단계 A) — 이제 **daemon 을 띄우는 데** 쓴다.
//
// **왜 이것이 필요한가**(실측, 2026-09-05): 앱을 SIGKILL 해도 자식은 살아남았지만 PGID 가
// 앱 프로세스 그룹 그대로였고, `kill -TERM -<그 그룹>` 한 번에 전부 죽었다. 즉 자식이
// 살아남는 것은 "아무도 그 그룹에 시그널을 안 보내서"일 뿐이고, 앱 종료 훅에 누가
// `dispose()`류 정리를 연결하거나 launcher(pnpm)·셸·OS 가 세션 종료로 그룹에 시그널을
// 보내는 순간 이 우연한 생존은 사라진다. orca 는 daemon 을 자기 PGID 로 분리해 이 경로를
// 원천 차단한다 — 이 spawn 이 같은 일을 한다: 자식을 **자기 세션/프로세스 그룹**으로 뗀다.
//
// **`tauri-plugin-shell` 의 `Command.create` 는 이 제어를 노출하지 않는다** — 그래서
// `#425` 가 만든 패턴(웹뷰는 파라미터를 넘기지 않고 실행 대상·인자가 Rust 안에 고정되는
// invoke 커맨드)을 그대로 재사용한다. `shell:allow-spawn` 스코프의 리터럴 인자 제약과
// 같은 이유로, 여기서도 웹뷰가 프로그램·인자·옵션 중 어느 것도 고르지 못한다.
//
// ## `#431` 2단계-b 3/3 — 러너를 앱이 아니라 **daemon 이** 띄운다
//
// 이 파일에 있던 `runner_spawn`·`runner_wait_exit`·`runner_kill` 과 그 pid 표
// (`RunnerRegistry`)가 **사라졌다.** 러너를 소유하는 것이 앱이 아니라 daemon 이 됐기
// 때문이다 — 앱이 여전히 러너를 직접 띄울 수 있으면 "무엇이 러너를 소유하는가"가 둘로
// 갈리고, 그 상태가 이 이슈가 없애려는 바로 그것이다.
//
// **그 자리는 폴백으로도 남기지 않았다.** 남기면 daemon 기동 실패가 조용히 옛 경로로
// 흘러 "daemon 이 도는 줄 알았는데 아니었다"가 된다(`daemon_client.rs` 모듈 주석의
// "왜 폴백이 없나"). 실패는 실패로 화면에 오른다(`#368`).
//
// `detached_command()` 는 그대로 남는다 — 이제 그것이 띄우는 것이 daemon 이고, 러너는
// daemon 이 자기 쪽에서 같은 성질(`detached`)로 띄운다(`packages/daemon/src/runners.ts`).
// ---------------------------------------------------------------------------

/// 러너 사이드카의 스코프 이름. **`tauri.conf.json` 의 `bundle.externalBin` 항목 이름과
/// 반드시 같아야 한다** — 다르면 번들 빌드가 그 이름으로 복사한 실행 파일을 여기서 못 찾는다.
///
/// **`#[cfg(test)]` 인 이유**: `#433` 을 닫으면서 프로덕션 경로에서 이 이름을 쓰는 자리가
/// 사라졌다. 러너를 실제로 띄우는 것은 daemon 이고, daemon 은 **자기 위치에서** 러너 경로를
/// 계산한다(`packages/daemon/src/run.ts` — 같은 디렉터리에 있다는 계약을 daemon 쪽이 안다).
/// 앱은 배치에 더 이상 관여하지 않는다.
///
/// 그래도 지우지 않는 이유는 회귀선이 이 이름으로 **실행 위치의 사이드카를 실물로 띄우기**
/// 때문이다 — 그 테스트가 `#433` 이 재려던 것("빌드 위치가 아니라 실행 위치에서 해석되는가")
/// 을 계속 잰다.
#[cfg(test)]
const RUNNER_SIDECAR_NAME: &str = "murmur-runner";

/// 이 실행 파일(앱)과 같은 디렉터리에서 사이드카를 찾는다. Tauri 의 `externalBin` 번들링이
/// `<name>-<target-triple>` 을 `<name>` 으로 이름을 바꿔 앱 실행 파일과 **같은 디렉터리**에
/// 복사한다(`tauri-build::copy_binaries`) — 그래서 `current_exe()` 의 부모 디렉터리를 그대로
/// 쓴다. 개발 모드(`cargo run`)에서도 `cargo-tauri`가 빌드된 사이드카를 `target/debug/` 로
/// 미리 복사해 두므로 같은 경로 규칙이 그대로 통한다.
///
/// ## `name` 파라미터는 웹뷰의 입력이 아니다 (`#431` 2단계-b 3/3)
///
/// daemon 도 사이드카가 되면서 이 함수가 이름을 받게 됐다. **그 이름을 넘기는 자리는 둘
/// 뿐이고 둘 다 Rust 안의 상수다** — `RUNNER_SIDECAR_NAME` 과 `DAEMON_SIDECAR_NAME`.
/// 웹뷰가 이 함수에 닿는 경로는 없다: 커맨드 시그니처 어디에도 프로그램 이름을 받는
/// 파라미터가 없고, 그 성질을 `test/runnerShellScope.test.ts` 가 소스를 읽어 못박는다.
///
/// 이름을 파라미터로 뺀 것이 경계를 넓히지 **않는** 이유가 그것이다 — 넓히는 것은
/// "웹뷰가 값을 고를 수 있는가"이지 "함수가 인자를 받는가"가 아니다.
fn sidecar_path(name: &str) -> Result<std::path::PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("실행 파일 경로를 얻지 못했다: {e}"))?;
    let dir = exe
        .parent()
        .ok_or_else(|| "실행 파일에 부모 디렉터리가 없다".to_string())?;
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    Ok(dir.join(file))
}

// ---------------------------------------------------------------------------
// `#433` — **여기 있던 `ensure_node_pty_alongside_sidecar()` 는 걷어냈다.**
//
// 그 함수는 앱이 뜰 때 번들 안에 심볼릭 링크를 만들어 `externalBin` 자리와
// `bundle.resources` 자리를 이었다:
//
//   Contents/MacOS/node_modules → <절대경로>/Contents/Resources/node_modules
//
// 그 함수의 주석이 **"릴리스 파이프라인(서명·공증)이 들어오는 시점에는 이 함수를 반드시
// 걷어내야 한다"** 고 예고했고, 지금이 그 시점이다. 예고대로 두 가지가 실제로 터졌다(실측):
//
//   codesign --verify → a sealed resource is missing or invalid
//                       file added: …/murmur.app/Contents/MacOS/node_modules
//   xcrun stapler staple → rejected (invalid destination for symbolic link in bundle)
//
// 두 번째가 결정적이다. **공증 자체는 통과했다**(`notarytool submit` → `status: Accepted`).
// 그런데 티켓을 앱에 박는 `stapler` 가 번들 바깥을 가리키는 절대 경로 링크를 거절한다.
// 티켓이 안 박히면 오프라인에서 Gatekeeper 를 통과하지 못하므로, "공증은 됐다"만으로는
// 배포가 성립하지 않는다.
//
// **대신 무엇을 하는가** — 예고 주석이 제시한 첫 번째 안 그대로다: 사이드카가 리소스
// 경로에서 `node-pty` 를 직접 해석한다(`packages/agent/src/nodePtyLoader.ts`). 러너가 자기
// 파일 위치에서 `../Resources/node_modules/node-pty` 를 계산해 `createRequire` 로 부른다.
// **번들에 아무것도 쓰지 않으므로** 봉인도 링크 검사도 건드리지 않는다.
//
// 그래서 이 파일에는 이제 그 자리가 없다 — `daemon_spawn_runner` 도 러너를 띄우기 전에
// 아무 배치 작업을 하지 않는다. 배치를 아는 것은 러너 자신뿐이다.
//
// 회귀선: `packages/desktop/test/bundleSignable.test.ts`(번들에 심볼릭 링크가 없다),
// `packages/agent/test/nodePtyLoader.test.ts`(후보 경로와 해석).
// ---------------------------------------------------------------------------

/// 프로세스 그룹 분리를 건 `Command` 를 만든다. **`daemon_client::daemon_command()` 와
/// `tests::` 아래 회귀 테스트가 이 함수 하나를 공유한다** — 실물 커맨드 안에 인라인해 두면
/// 테스트가 `tauri::State`·`AppHandle` 없이는 이 로직을 부를 수 없고, 그러면 "PGID 가 자기
/// 자신인지"를 실제 프로세스로 재는 자리가 이 파일에 없어진다.
///
/// **공유가 회귀선의 전제다.** 3/3 구현 중 실제로 겪었다: 테스트가 커맨드를 자기 손으로
/// 다시 조립하던 동안에는 `detached_command` 를 걷어내도 **초록이었다** — 재는 대상과 도는
/// 대상이 갈려 있었기 때문이다. 이 함수를 공유시킨 뒤에야 되돌려 RED 가 섰다.
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

// ---------------------------------------------------------------------------
// daemon 커맨드(#431 2단계-b 3/3) — 앱이 daemon 을 통해 러너를 소유한다.
//
// **세 커맨드가 웹뷰에서 받는 것은 전부 값이다.** 프로그램 경로도, 소켓·토큰 경로도,
// daemon 인자도 아니다 — 그것들은 `daemon_client` 가 `sidecar_path()`·`app_data_dir()`
// 에서 계산한다(`daemon_client.rs` 모듈 주석의 표). 이것이 `runner_spawn` 이 지키던
// 성질을 daemon 쪽으로 그대로 이은 자리다.
// ---------------------------------------------------------------------------

/// 웹뷰가 러너 exit 을 듣는 이벤트 이름. **`incarnationId` 를 그대로 실어 보낸다** —
/// 세대를 가리는 것은 앱 쪽(`runnerLauncher.handleExit`)의 일이고, Rust 는 daemon 이
/// 말한 사실을 옮기기만 한다(`#419` 의 계약이 소켓 너머로 이어지는 자리).
const RUNNER_EXIT_EVENT: &str = "murmur://runner-exit";

/// daemon 을 확보하고 러너를 띄우라고 시킨다.
///
/// **daemon 이 없으면 띄우고 있으면 붙는다**(`ensure_daemon`). 실패하면 그대로 `Err` 다 —
/// 앱이 직접 러너를 띄우는 폴백은 **없다**(이 파일 위쪽 "그 자리는 폴백으로도 남기지
/// 않았다" 참조). 그 `Err` 문자열이 화면의 `failed` + `message` 로 그대로 올라간다.
#[tauri::command]
fn daemon_spawn_runner(
    app: tauri::AppHandle,
    state: tauri::State<daemon_client::DaemonState>,
    agent_id: String,
    murmur_pat: String,
    murmur_url: String,
    path: String,
) -> Result<daemon_client::SpawnRunnerResult, String> {
    use tauri::Emitter;

    // **여기서 배치를 손보지 않는다**(`#433` — 위의 큰 주석). `node-pty` 를 찾는 것은
    // 러너 자신의 일이 됐고(`nodePtyLoader.ts`), 그래서 이 커맨드는 daemon 을 확보해
    // 러너를 띄우라고 말하는 것만 한다. 번들에 쓰는 자리가 없어야 서명·공증이 성립한다.
    let emitter = app.clone();
    let (conn, _kind) = daemon_client::ensure_daemon(&app, &state, move |event| {
        // 여기서 세대를 가리지 않는다 — daemon 이 말한 사실을 그대로 올린다.
        let _ = emitter.emit(RUNNER_EXIT_EVENT, event);
    })?;

    let mut env = HashMap::new();
    env.insert("MURMUR_PAT".to_string(), murmur_pat);
    env.insert("MURMUR_URL".to_string(), murmur_url);
    env.insert("PATH".to_string(), path);
    conn.spawn_runner(&agent_id, env)
}

/// **세대를 실어 보낸다** — 없으면 daemon 이 "지금 것"을 죽이고, 그 사이 새로 뜬 러너가
/// 대신 죽을 수 있다(`daemon_client::DaemonConnection::kill_runner` 주석).
///
/// **회수는 종료가 아니다**(`#337`). 여기서 하는 것은 daemon 에 SIGTERM 을 보내라고
/// 말하는 것뿐이고, 유예를 자르거나 SIGKILL 로 승격하는 경로는 이쪽에도 daemon 쪽에도
/// 없다 — 러너만이 자기 턴이 끝났는지 안다.
#[tauri::command]
fn daemon_kill_runner(
    app: tauri::AppHandle,
    state: tauri::State<daemon_client::DaemonState>,
    agent_id: String,
    incarnation_id: Option<String>,
) -> Result<(), String> {
    let (conn, _) = daemon_client::ensure_daemon(&app, &state, |_| {})?;
    conn.kill_runner(&agent_id, incarnation_id.as_deref())
}

/// daemon 이 지금 들고 있는 러너들. **관측이지 판단이 아니다** — daemon 은
/// "이렇게 되어 있다"만 말한다(`daemonProtocol.ts::RunnerInfo` 주석).
///
/// 응답에 daemon 자신의 사실(`daemonPid`·`attached`·경로들)을 함께 싣는다. 러너 목록만
/// 주면 "러너가 0개다"와 "daemon 이 방금 떴다"를 구분할 수 없고, 그 구분이 없으면 사람이
/// `ps` 로 밖에서 대조해야 한다 — 실물 검증이 "같은 pid 면 붙은 것"으로 재는 그 값이다.
#[tauri::command]
fn daemon_list_runners(
    app: tauri::AppHandle,
    state: tauri::State<daemon_client::DaemonState>,
) -> Result<serde_json::Value, String> {
    let paths = daemon_client::resolve_endpoint_paths(&app)?;
    let (conn, kind) = daemon_client::ensure_daemon(&app, &state, |_| {})?;
    let runners = conn.list_runners()?;
    Ok(serde_json::json!({
        "daemonPid": conn.daemon_pid,
        "attached": kind == daemon_client::EnsureKind::Attached,
        "socketPath": paths.socket,
        "logPath": paths.log,
        "runners": runners.get("runners").cloned().unwrap_or(serde_json::Value::Null),
    }))
}

fn main() {
    tauri::Builder::default()
        // 멘션 알림 표면. 권한은 capabilities/default.json 에서 허용한다.
        .plugin(tauri_plugin_notification::init())
        // 링크를 OS 로 넘기는 표면. 권한은 capabilities/default.json 에서 허용한다.
        .plugin(tauri_plugin_shell::init())
        .manage(daemon_client::DaemonState::new())
        .invoke_handler(tauri::generate_handler![
            secret_get,
            secret_set,
            secret_delete,
            daemon_spawn_runner,
            daemon_kill_runner,
            daemon_list_runners,
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
    use super::{detached_command, RUNNER_SIDECAR_NAME};
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

    // -----------------------------------------------------------------------
    // `#433` 회귀선 — **실행 위치**에서 `node-pty` 가 해석되는지를 잰다.
    //
    // `#431` 1단계가 이 결함을 놓친 이유가 "빌드 위치(`src-tauri/binaries/`)에서만
    // 확인했다"이기 때문이다(이슈 본문 "왜 테스트가 못 잡았나" 참고). 그래서 이 테스트는
    // **앱이 실제로 사이드카를 찾는 그 자리** — `cargo build`/`cargo test` 가 공유하는
    // `target/<profile>/`(`sidecar_path()`가 `current_exe()`의 부모로 계산하는 것과 같은
    // 디렉터리) — 에서 사이드카를 직접 spawn 해 `node-pty` 로딩이 성공하는지 확인한다.
    // -----------------------------------------------------------------------

    /// `cargo test` 가 만드는 테스트 바이너리는 `target/<profile>/deps/` 에 있어 그 부모를
    /// 그대로 쓸 수 없다 — 대신 `CARGO_MANIFEST_DIR`(이 크레이트 루트) 기준으로 `target/`
    /// 다음에 프로파일 이름을 붙인다. `cargo test`/`cargo build` 는 기본적으로 `debug`
    /// 프로파일을 쓰고, 이 회귀선이 재려는 자리도 정확히 그 프로파일의 `target/debug/`다
    /// (실물 확인 절차의 `target/debug/murmur-runner` 와 같은 자리).
    fn target_debug_dir() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("debug")
    }

    #[test]
    fn 사이드카_실행_위치에서_node_pty_가_해석된다() {
        let dir = target_debug_dir();
        let program = dir.join(RUNNER_SIDECAR_NAME);

        // `build:sidecar` + `cargo build` 를 아직 안 돌렸으면 이 자리에 사이드카가 없다 —
        // 이 테스트가 재려는 것은 "배치가 맞으면 통과"이지 "빌드를 대신 해준다"가 아니므로,
        // 그 경우는 실패 대신 사람이 알아볼 수 있는 이유로 건너뛴다(CI 는 `build:sidecar` 를
        // cargo 전에 반드시 돌리므로 정상 경로에서는 항상 존재한다).
        if !program.is_file() {
            eprintln!(
                "건너뜀: 사이드카가 `{}` 에 없다 — 먼저 `pnpm --filter @murmur/desktop build:sidecar` \
                 와 `cargo build` 를 돌려라",
                program.display()
            );
            return;
        }

        // **되돌려 RED 로 확인한 배치 계약**: 개발 빌드에서는 `node_modules` 가 사이드카와
        // 같은 디렉터리에 있어야 한다 — 그것이 `nodePtyLoader.ts` 의 **첫 번째 후보**이고,
        // 개발 빌드에는 `Contents/Resources` 라는 두 번째 후보가 아예 없다. 여기가 비면
        // 아래 spawn 이 로더의 "node-pty 를 찾지 못했다" 로 죽는다.
        //
        // 배포 번들의 두 번째 후보는 이 자리에서 잴 수 없다(`.app` 이 있어야 한다) —
        // 그쪽은 `test/bundleSignable.test.ts` 와 실물 검증 절차가 맡는다.
        assert!(
            dir.join("node_modules").join("node-pty").is_dir(),
            "`{}` 옆에 `node_modules/node-pty` 가 없다 — `tauri.conf.json` 의 \
             `bundle.resources` 가 사이드카와 같은 자리로 배치되는지 확인하라",
            program.display()
        );

        let child = std::process::Command::new(&program)
            .env("MURMUR_PAT", "test-fake-pat")
            // 접속하지 않는 포트 — node-pty 로딩 이후 단계(서버 접속)에서 무엇이 나든
            // 이 테스트가 관심 있는 것은 그 전 단계(모듈 해석)뿐이다.
            .env("MURMUR_URL", "http://127.0.0.1:1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("사이드카를 못 띄웠다");

        let output = child
            .wait_with_output()
            .expect("사이드카 종료를 기다리지 못했다");
        let stderr = String::from_utf8_lossy(&output.stderr);

        // **무엇을 찾는지가 바뀌었다.** 예전에는 정적 `import` 가 실패해
        // `ERR_MODULE_NOT_FOUND` 가 났다. 지금은 러너가 `createRequire` 로 직접 해석하므로
        // (`nodePtyLoader.ts`) 그 오류 코드는 **영영 안 난다** — 그것만 계속 보고 있으면 이
        // 회귀선은 배치가 깨져도 초록으로 남는다. 그래서 **로더 자신이 던지는 문구**를 잰다.
        //
        // `ERR_MODULE_NOT_FOUND` 도 함께 본다: 누군가 정적 `import pty from 'node-pty'` 로
        // 되돌리면 배포 번들에서 그 오류가 되살아나고, 그것도 이 회귀선이 잡아야 하는 결함이다.
        assert!(
            !stderr.contains("node-pty 를 찾지 못했다") && !stderr.contains("ERR_MODULE_NOT_FOUND"),
            "사이드카가 실행 위치(`{}`)에서 `node-pty` 를 못 찾았다 — Tauri 는 \
             `externalBin` 파일 하나만 복사하고 옆의 `node_modules` 는 안 가져간다(#433). \
             stderr:\n{}",
            program.display(),
            stderr,
        );
    }
}
