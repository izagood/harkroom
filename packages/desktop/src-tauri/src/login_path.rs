//! 로그인 셸의 `PATH` 를 **Rust 가** 캐낸다 — `#513`.
//!
//! ## 무엇이 비어 있었나 — 러너에는 주고 daemon 에는 안 줬다
//!
//! `#305` 가 이 문제의 절반을 이미 풀어 뒀다: macOS 에서 Finder·Dock 으로 띄운 앱은
//! 로그인 셸의 `PATH` 를 물려받지 않고(launchd 가 주는 `/usr/bin:/bin:/usr/sbin:/sbin`
//! 정도다), 그래서 앱이 `sh -lc 'echo $PATH'` 를 한 번 돌려 그 값을 **러너** 자식의
//! `env.PATH` 로 넘겼다.
//!
//! 그런데 그 장치는 **웹뷰에** 있었다(`runnerLauncher.ts::tauriLoginPathReader`, shell
//! 플러그인). 그 값이 닿는 곳은 `daemon_spawn_runner` 의 러너 env 하나뿐이고,
//! **daemon 자신을 띄우는 `spawn_daemon` 에는 안 닿았다.** 실측(2026-09-06, `#513`):
//!
//! ```text
//! daemon 사이드카   #!/usr/bin/env node
//! node 실제 위치    /opt/homebrew/bin/node
//! GUI 앱의 PATH     /usr/bin:/bin:/usr/sbin:/sbin      ← Homebrew 가 없다
//! daemon 로그 끝줄  env: node: No such file or directory
//! ```
//!
//! **러너에 `PATH` 를 주는 코드가 정작 그 러너를 띄울 daemon 에는 안 닿았다.**
//!
//! ## 왜 daemon 은 웹뷰가 캐낸 값을 못 쓰나 — 순서 때문이다
//!
//! 이것이 이 모듈이 웹뷰가 아니라 Rust 에 있는 **유일한** 이유다.
//!
//! ```text
//! 앱 기동 → controller.start() → ensureDaemon()  ← daemon 이 여기서 뜬다
//!                                     ↓
//!                              (한참 뒤) startAll() → spawnRunner() → resolveChildPath()
//!                                                                         ↑ 웹뷰가 셸을 부르는 자리
//! ```
//!
//! `#431` 2단계 A 가 daemon 을 **러너의 부산물이 아니라 상주 프로세스**로 만들면서
//! `ensureDaemon` 이 앱 기동 직후로 올라왔다(`controller.ts` 의 그 자리 주석: *"러너를
//! 띄울지 정하기 전에"*). 띄울 러너가 하나도 없어도, 자동 기동 토글이 꺼져 있어도 돈다.
//! **즉 daemon 이 뜨는 시점에는 웹뷰가 아직 `PATH` 를 캐내지 않았고, 캐낼 이유도 없다.**
//!
//! 그 값을 daemon 이 기다리게 만드는 길은 있다 — 웹뷰가 먼저 셸을 부르고 그 뒤에
//! `ensureDaemon` 을 부르게 하면 된다. **그러지 않았다.** daemon 확보를 웹뷰의 준비 순서에
//! 매다는 것은 `#431` 2단계 A 가 방금 끊은 고리(*"앞단이 무엇을 판정하면 daemon 도 안 뜬다"*)를
//! 모양만 바꿔 다시 매는 것이다. daemon 은 웹뷰가 무엇을 하든 떠야 한다.
//!
//! ## 그럼 출처가 둘이 되지 않는가 — **하나로 합쳤다**
//!
//! Rust 가 스스로 캐내고 웹뷰도 계속 자기 셸을 부르면 **두 출처**가 되고, 둘은 갈릴 수
//! 있다(다른 셸, 다른 시점, 한쪽만 실패). 그래서 웹뷰의 셸 호출을 **없앴다**:
//!
//! | | 앞 판본 | 지금 |
//! |---|---|---|
//! | 셸을 부르는 자리 | 웹뷰(`Command.create('login-path', …)`) | **Rust — 이 모듈 하나** |
//! | daemon 의 `PATH` | 없음 | 이 모듈 |
//! | 러너의 `PATH` | 웹뷰가 캐낸 값 | **이 모듈** (`login_path` invoke 로 웹뷰가 읽어 간다) |
//! | `capabilities/default.json` | `shell:allow-execute` (`login-path`) | **없다** |
//!
//! 웹뷰는 이제 값을 **만들지 않고 물어본다**(`main.rs::login_path` 커맨드). 러너 env 를
//! 조립하는 자리는 여전히 웹뷰이므로(`runnerLauncher.ts::spawnRunner`) 그 표면 자체는
//! 그대로 두고, **값의 출처만** 한 곳으로 모았다.
//!
//! **부수 효과가 보안 쪽으로 났다**: `shell:allow-execute` 항목이 통째로 사라져
//! 웹뷰에서 프로그램을 실행할 수 있는 표면이 **0개**가 됐다(`#250`·`#305` 가 좁혀 온 그
//! 경계의 끝). 넓힌 것이 아니라 좁힌 것이다 — `test/runnerShellScope.test.ts` 가 그 사실을
//! 못박는다.
//!
//! ## 기동이 그만큼 느려지지 않는가 — 잰 값과 그것을 어디에 뒀는지
//!
//! 로그인 셸은 공짜가 아니다. 실측(2026-09-07, 이 기계의 `zsh` + 실제 rc):
//!
//! ```text
//! /bin/zsh -lc 'echo $PATH'   0.081s
//! ```
//!
//! 그 81ms 가 **창 표시를 늦추지 않는다**: `ensureDaemon` 은 `controller.start` 에서
//! fire-and-forget 으로 불리고(그 자리 주석: *"여기서 await 하면 소켓 왕복이 창 표시를
//! 늦춘다"*), 이 조회는 그 안쪽 `spawn_daemon` 에서 일어난다. 즉 이미 백그라운드인 경로에
//! 81ms 를 얹는 것이지 사람이 기다리는 경로에 얹는 것이 아니다.
//!
//! 그리고 **프로세스 생애 동안 한 번만 부른다**(`LOGIN_PATH` `OnceLock`). 러너를 열 개
//! 띄워도 셸은 한 번이다 — 웹뷰 쪽 `loginPathOnce` 캐시가 하던 일을 그대로 옮겨 온 것이고,
//! 이제는 daemon 과 러너가 **같은** 캐시를 공유한다(그것이 곧 "출처가 하나"의 실체다).
//!
//! **실패도 캐시한다.** 셸이 없는 환경에서 매번 다시 시도하면 그 비용이 반복된다.

use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;
use std::time::Duration;

/// `PATH` 를 얻기 위해 부르는 셸의 인자. **리터럴이다.**
///
/// `-l`(로그인 셸)이 요점이다 — `.zprofile`·`.bash_profile` 처럼 Homebrew·nvm·asdf 가
/// `PATH` 를 심는 파일은 로그인 셸에서만 읽힌다. `-c` 만 주면 GUI 가 물려준 그
/// 빈약한 `PATH` 를 그대로 되돌려받는다.
///
/// **`echo $PATH` 말고 다른 것을 여기 넣지 마라.** 이 배열이 리터럴인 것이 곧 "셸을
/// 쓰되 임의 명령을 실행하지는 않는다"의 전부다(`#250`·`#305` 가 지켜 온 경계).
pub const LOGIN_SHELL_ARGS: [&str; 2] = ["-lc", "echo $PATH"];

/// `$SHELL` 이 없을 때 쓸 셸. **`/bin/sh` 다.**
///
/// POSIX 가 있으라고 못박은 유일한 경로이고, macOS·Linux 어디에나 있다. `#305` 의 웹뷰
/// 판본도 `sh` 를 불렀으므로 동작이 바뀌지 않는다.
pub const DEFAULT_SHELL: &str = "/bin/sh";

/// 로그인 셸 조회를 포기하는 시각.
///
/// ## 왜 상한이 필요한가 — 셸 rc 는 남의 코드다
///
/// `.zshrc`·`.bash_profile` 에 무엇이 들어 있는지 우리는 모른다. 네트워크를 타는 줄
/// (`nvm` 자동 로드, 회사 VPN 점검, `oh-my-zsh` 업데이트 확인)이 흔하고, 그것이 멎으면
/// **`spawn_daemon` 이 영영 안 끝난다.** 그러면 증상은 `#513` 이 고치려는 바로 그것 —
/// *"daemon 이 안 뜬다"* — 으로 되돌아가고, 이번에는 로그에 `env: node:` 조차 안 남는다.
///
/// 5초는 실측 81ms 의 60배다. 정상 셸이 여기 걸릴 일은 없고, 걸렸다면 그것은 느린 것이
/// 아니라 **멎은 것**이다. 넘으면 폴백으로 물러난다 — 기다리는 것보다 뜨는 것이 낫다.
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// 로그인 셸의 `PATH` 를 못 얻었을 때 쓰는 기본 디렉터리들.
///
/// **`@harkroom/shared` 의 `SYSTEM_PATH_FALLBACK` 과 같은 값이어야 한다.** 두 곳에 있는
/// 것은 언어가 갈려서다(Rust ↔ TS) — `test/runnerLoginPath.test.tsx` 가 이 파일을 읽어
/// 두 값을 대조한다(`daemonEndpointContract` 가 프로토콜 버전에 하는 것과 같은 방식).
///
/// ## 왜 이 값 그대로인가 — Homebrew 를 **안 넣었다**
///
/// `#513` 의 증상이 정확히 *"Homebrew 의 `/opt/homebrew/bin` 이 GUI `PATH` 에 없다"*
/// 였으므로 그것을 여기 넣고 싶어진다. 넣지 않았다. 이유가 셋이다:
///
/// 1. **이 값은 조회가 실패했을 때만 쓰인다.** 조회가 성공하면 로그인 셸의 `PATH` 가
///    이 자리를 통째로 대신하고, 그 값에는 Homebrew 가 이미 들어 있다(실측: 위 모듈
///    주석의 `zsh -lc` 출력 첫 항목이 `/opt/homebrew/bin` 이다). 즉 `#513` 이 고치는 것은
///    **조회를 하게 만든 것**이지 폴백을 살찌운 것이 아니다.
/// 2. **Homebrew 만 넣는 것은 특정 도구 편들기다.** 이 기계의 실제 로그인 `PATH` 에는
///    `volta`·`asdf`·`fnm`·`mise`·`pnpm`·`bun`·`nix` 의 자리가 함께 있다(실측 2026-09-07).
///    Homebrew 한 줄을 넣으면 나머지를 안 넣은 이유를 댈 수 없고, 다 넣으면 그것은 폴백이
///    아니라 **추측 목록**이다 — 남의 기계 배치를 우리가 지어내는 것이고 `#368` 이 막는
///    바로 그것이다.
/// 3. **없는 디렉터리를 `PATH` 에 넣는 것은 공짜가 아니다.** Intel 맥의 Homebrew 는
///    `/usr/local/bin`(이미 여기 있다)이고 Apple Silicon 은 `/opt/homebrew/bin` 이다.
///    아키텍처를 우리가 판정해 갈라 넣기 시작하면 그 판정이 틀리는 날이 온다.
///
/// **폴백이 부족한 경우는 남는다 — 그리고 이 기계가 바로 그 경우다.**
///
/// 실측(2026-09-07, 진짜 daemon 사이드카를 세 가지 `PATH` 로 띄워 봤다):
///
/// ```text
/// ① GUI PATH  /usr/bin:/bin:/usr/sbin:/sbin      → 죽었다(127) env: node: No such file…
/// ② 로그인 셸 PATH                                 → 살았다, 소켓 서비스 시작
/// ③ 이 폴백    /usr/local/bin:/usr/bin:/bin:…     → 죽었다(127) env: node: No such file…
/// ```
///
/// **③ 이 이 상수를 부풀리지 않기로 한 결정의 값을 보여 준다.** 이 기계의 `node` 는
/// Homebrew(`/opt/homebrew/bin`)에만 있어서 폴백으로는 안 뜬다. 그러니 폴백을 살찌우면
/// ③ 이 초록이 될 것 같지만 — 그것은 **이 기계에서만** 그렇다. 다음 사람의 `node` 는
/// `nvm` 밑이거나 `asdf` 밑이거나 `/usr/local` 이고, 그 목록을 우리가 계속 좇는 것은
/// 위 2번이 말한 추측 목록이 된다.
///
/// **③ 에서 진짜로 필요한 것은 화면이 사유를 말하는 것**이고, 그것이 `#513` 의 나머지
/// 절반이다(`daemon_client::node_missing_reason` — 종료 코드 127 과 그 로그 줄을 보고
/// *"`node` 를 못 찾았다 + 여기서 받아라 + 이때 쓴 PATH 는 이것이다"* 를 말한다).
/// 조용히 실패하지 않는 것이 답이지, 폴백을 부풀리는 것이 답이 아니다.
pub const SYSTEM_PATH_FALLBACK: &str = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/// 조회 결과 캐시. **성공도 실패도 캐시한다**(모듈 주석 참조).
static LOGIN_PATH: OnceLock<Option<String>> = OnceLock::new();

/// 자식에게 넘길 `PATH`. **여기서는 절대 실패하지 않는다.**
///
/// 1. 로그인 셸의 `PATH` 를 **한 번** 캐낸다.
/// 2. 못 캐냈으면 `SYSTEM_PATH_FALLBACK` 으로 물러난다.
///
/// **빈 문자열을 돌려주지 않는다.** 빈 `PATH` 를 자식 env 에 넣으면 그 자식은 `PATH` 가
/// 없는 것보다 **더 나쁜** 상태가 된다 — `execvp` 가 confstr 기본값으로도 물러나지 못하고
/// 아무것도 못 찾는다. `#513` 의 증상(`env: node: No such file or directory`)을 폴백 경로에
/// 그대로 재현하는 셈이라, 이 성질이 이 함수의 계약이다.
pub fn child_path() -> String {
    or_fallback(login_path())
}

/// 조회 결과를 자식에게 줄 값으로 바꾼다. **판단은 이 한 줄이 전부다.**
///
/// ## 왜 `child_path` 에서 떼어냈나 — 되돌려 RED 가 안 섰다
///
/// 처음에는 `child_path` 안에 `unwrap_or_else` 로 인라인돼 있었다. 그런데
/// **되돌려 RED 를 실제로 돌려 보니 안 빨개졌다**(2026-09-07):
///
/// ```text
/// child_path 의 unwrap_or_else → unwrap_or_default 로 바꿈 → cargo test → 35 passed
/// ```
///
/// 이유가 명확하다. 이 기계에서는 로그인 셸 조회가 **성공**하므로 `login_path()` 가
/// 언제나 `Some` 이고, **폴백 분기에 아예 안 들어간다.** 즉 그 회귀선은 조회가 실패하는
/// 기계에서만 서고, 여기서는 아무것도 안 지켰다.
///
/// `ensure_at` 이 `launch` 를 클로저로 받는 것과 같은 처방이다(그 주석: *"회귀선이 실물을
/// 재게 하려고"*). 조회 결과를 **인자로** 받으면 회귀선이 `None` 을 직접 만들어 넣을 수
/// 있고, 그러면 조회가 성공하는 기계에서도 폴백 분기가 실제로 돈다.
fn or_fallback(looked_up: Option<String>) -> String {
    looked_up.unwrap_or_else(|| SYSTEM_PATH_FALLBACK.to_string())
}

/// 로그인 셸이 말한 `PATH`. 못 얻었으면 `None` — **여기서 지어내지 않는다**(`#368`).
///
/// `None` 을 폴백으로 바꾸는 판단은 `or_fallback` 하나가 한다. 그 둘을 갈라 둔 이유는
/// 회귀선이 *"조회가 실패했다"* 와 *"그때 폴백을 준다"* 를 따로 잴 수 있어야 해서다.
pub fn login_path() -> Option<String> {
    LOGIN_PATH.get_or_init(read_login_path).clone()
}

/// 실제로 셸을 부르는 자리. 캐시를 거치지 않는다 — 회귀선이 이 함수를 직접 잰다.
fn read_login_path() -> Option<String> {
    let shell = shell_program();
    match run_login_shell(&shell) {
        Ok(value) => {
            crate::daemon_client::log_line(&format!(
                "로그인 셸에서 PATH 를 얻었다: `{shell}` ({}자)",
                value.len()
            ));
            Some(value)
        }
        Err(reason) => {
            // **사유를 남긴다.** 이 실패는 조용히 폴백으로 이어지므로, 남기지 않으면
            // "폴백을 쓰고 있다"는 사실 자체를 아무도 모른다 — `#456` 이 고친 침묵과
            // 같은 모양이다.
            crate::daemon_client::log_line(&format!(
                "로그인 셸에서 PATH 를 얻지 못해 폴백을 쓴다: `{shell}`: {reason}"
            ));
            None
        }
    }
}

/// 어느 셸을 부를 것인가. `$SHELL` 이 있으면 그것, 없으면 `/bin/sh`.
///
/// ## `$SHELL` 은 GUI 앱에도 있다 — 실측이 근거다
///
/// 이 함수가 `$SHELL` 을 믿어도 되는지가 관건이다. launchd 가 GUI 앱에 주는 환경은
/// 빈약하지만 `$SHELL` 은 사용자 레코드(`dscl . -read /Users/<me> UserShell`)에서 오고
/// **`PATH` 와 달리 로그인 셸의 것이 그대로 온다.** 없으면 `/bin/sh` 로 물러나는데,
/// 그것도 로그인 셸로 부르면(`-l`) `/etc/profile`·`~/.profile` 을 읽으므로 아무것도 안
/// 하는 것보다는 낫다.
///
/// **경로 검사를 여기서 하지 않는다.** `$SHELL` 이 이상한 값이면 `spawn` 이 실패하고,
/// 그 실패는 위 `read_login_path` 가 사유로 남긴 뒤 폴백으로 간다 — 우리가 미리
/// 판정하는 것보다 실제로 부딪힌 결과가 정확하다(`#368`).
fn shell_program() -> String {
    match std::env::var("SHELL") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => DEFAULT_SHELL.to_string(),
    }
}

/// 셸을 실제로 돌려 한 줄을 받는다. **상한 안에 안 끝나면 죽이고 포기한다.**
///
/// ## 왜 `output()` 이 아니라 손으로 기다리나
///
/// `Command::output()` 에는 상한이 없다 — 셸 rc 가 멎으면 이 호출도 함께 멎고,
/// 그러면 `spawn_daemon` 이 영영 안 끝난다(`LOGIN_SHELL_TIMEOUT` 주석의 그 사고다).
/// 표준 라이브러리에는 타임아웃이 달린 `wait` 가 없으므로 `try_wait` 로 폴링한다.
///
/// **죽일 때 `kill` 로 충분한가**: 이 자식은 `setsid` 를 걸지 않았으므로 우리 프로세스
/// 그룹에 있고, `Child::kill`(SIGKILL)은 셸 자신만 죽인다. 셸이 띄운 손자가 남을 수는
/// 있지만 그것은 rc 가 띄운 것이지 우리가 띄운 것이 아니고, 여기서 프로세스 그룹째
/// 죽이면 **우리 자신이 든 그룹**을 죽이게 된다.
fn run_login_shell(shell: &str) -> Result<String, String> {
    use std::process::Stdio;

    let mut child = Command::new(shell)
        .args(LOGIN_SHELL_ARGS)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        // **stderr 를 버린다.** rc 가 뱉는 잡소리(`nvm` 경고 등)가 stdout 에 섞이면
        // 그것이 `PATH` 인 줄 알고 자식에게 넘어간다.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("셸을 띄우지 못했다: {e}"))?;

    let deadline = std::time::Instant::now() + LOGIN_SHELL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(format!("셸이 {status} 로 끝났다"));
                }
                break;
            }
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "셸이 {}초 안에 끝나지 않아 포기했다 — rc 파일이 멎었을 수 있다",
                        LOGIN_SHELL_TIMEOUT.as_secs()
                    ));
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(format!("셸의 종료를 기다리지 못했다: {e}")),
        }
    }

    let mut out = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        use std::io::Read;
        stdout
            .read_to_string(&mut out)
            .map_err(|e| format!("셸의 출력을 읽지 못했다: {e}"))?;
    }
    sanitize(&out).ok_or_else(|| "셸이 빈 PATH 를 돌려줬다".to_string())
}

/// 셸이 뱉은 것을 `PATH` 로 쓸 수 있는지 본다. **못 쓰면 `None` — 고쳐 쓰지 않는다.**
///
/// ## 왜 마지막 줄인가
///
/// rc 가 `stdout` 에 무언가 찍는 일이 있다(`Last login:` 류, 도구 배너). `echo $PATH` 는
/// **맨 끝**에 실행되므로 우리가 원하는 줄은 언제나 마지막 비어 있지 않은 줄이다.
/// 첫 줄을 잡으면 배너를 `PATH` 로 착각한다.
///
/// ## 왜 `:` 를 요구하나 — 대조군이 없으면 배너도 통과한다
///
/// 마지막 줄이라는 것만으로는 부족하다. `PATH` 는 최소한 콜론으로 이어 붙인 절대 경로
/// 목록이고, 그것을 안 보면 `Welcome!` 한 줄짜리 출력도 통과한다. **비어 있지 않고,
/// `/` 로 시작하는 항목이 하나라도 있어야** 받아들인다 — 지어내지 않되 명백히 아닌 것은
/// 거른다.
fn sanitize(raw: &str) -> Option<String> {
    let line = raw.lines().rev().find(|l| !l.trim().is_empty())?.trim();
    if line.is_empty() {
        return None;
    }
    if !line.split(':').any(|seg| Path::new(seg).is_absolute()) {
        return None;
    }
    Some(line.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// **회귀선 2 — 조회가 실패하면 폴백이 나온다. 빈 `PATH` 가 아니다**(`#513`).
    ///
    /// ## 이 테스트가 `or_fallback` 을 직접 부르는 이유
    ///
    /// 앞 판본은 `child_path()` 를 불러 결과가 비어 있지 않은지만 봤다. **되돌려 RED 를
    /// 실제로 돌려 보니 안 빨개졌다**(2026-09-07): 이 기계에서는 조회가 성공해서
    /// `child_path()` 가 폴백 분기에 아예 안 들어갔고, `unwrap_or_default()` 로 바꿔도
    /// 35개가 전부 초록이었다. **조회가 실패하는 기계에서만 서는 회귀선**이었던 것이다.
    ///
    /// 그래서 판단을 `or_fallback(Option<String>)` 으로 떼어냈다 — 여기서 `None` 을
    /// 직접 넣으면 조회 결과와 무관하게 그 분기가 돈다.
    ///
    /// 되돌려 RED: `or_fallback` 의 `unwrap_or_else` 를 `unwrap_or_default()` 로 바꾸면
    /// 빈 문자열이 나와 빨개진다(이번에는 **이 기계에서도** 빨개진다).
    #[test]
    fn 조회가_실패하면_폴백이_나온다() {
        // **이것이 `#513` 회귀선 2 의 본체다.**
        let path = or_fallback(None);
        assert!(
            !path.trim().is_empty(),
            "빈 PATH 를 자식에게 넘기면 안 된다"
        );
        assert_eq!(path, SYSTEM_PATH_FALLBACK);
        assert!(path.split(':').any(|seg| Path::new(seg).is_absolute()));

        // 대조군: 얻었으면 그 값이 폴백을 **대신한다** — 겹쳐 붙이지 않는다.
        let got = or_fallback(Some("/opt/homebrew/bin:/usr/bin".to_string()));
        assert_eq!(got, "/opt/homebrew/bin:/usr/bin");
        assert!(!got.contains(SYSTEM_PATH_FALLBACK));
    }

    /// **회귀선 2 — 폴백 값 자체가 자식이 쓸 수 있는 것인가.**
    ///
    /// 위 테스트가 *"폴백이 나온다"* 를 재고, 이것은 *"그 폴백이 쓸모 있는가"* 를 잰다.
    #[test]
    fn 폴백은_비어_있지_않고_표준_디렉터리를_담는다() {
        assert!(!SYSTEM_PATH_FALLBACK.is_empty());
        let dirs: Vec<&str> = SYSTEM_PATH_FALLBACK.split(':').collect();
        // 디렉터리 하나만 남기면 안 된다 — 러너가 부르는 `claude`·`codex`·`avcs`·`git`
        // 이 이 안에서 발견돼야 한다(`#305` 가 적어 둔 이유 그대로다).
        assert!(
            dirs.len() >= 4,
            "표준 경로가 너무 적다: {SYSTEM_PATH_FALLBACK}"
        );
        assert!(dirs.contains(&"/usr/bin"), "{SYSTEM_PATH_FALLBACK}");
        assert!(dirs.contains(&"/bin"), "{SYSTEM_PATH_FALLBACK}");
        for d in dirs {
            assert!(Path::new(d).is_absolute(), "상대 경로가 섞였다: {d}");
        }
    }

    /// **회귀선 2 — `child_path()` 는 어떤 경우에도 빈 값을 안 준다.**
    ///
    /// 이 테스트가 도는 환경에서는 셸 조회가 성공할 수도 실패할 수도 있다(CI 에는
    /// 로그인 셸 rc 가 없을 수 있다). **둘 다 통과해야 하는 것이 요점이다** — 어느
    /// 갈래로 가든 자식에게 쓸 수 있는 `PATH` 가 나와야 한다.
    #[test]
    fn 자식에게_주는_path_는_언제나_쓸_수_있는_값이다() {
        let p = child_path();
        assert!(!p.trim().is_empty(), "빈 PATH 를 자식에게 넘기면 안 된다");
        assert!(
            p.split(':').any(|seg| Path::new(seg).is_absolute()),
            "절대 경로가 하나도 없다: {p}"
        );
    }

    /// 셸을 실제로 부른다. **여기서 값을 단정하지 않는다** — 기계마다 다르다.
    /// 재는 것은 *"성공했다면 그 값이 `PATH` 모양인가"* 다.
    #[test]
    fn 셸이_준_값은_path_모양이다() {
        let Some(value) = read_login_path() else {
            eprintln!("건너뜀: 이 환경에서는 로그인 셸 PATH 를 못 얻었다(폴백 경로가 산다)");
            return;
        };
        assert!(value.split(':').any(|seg| Path::new(seg).is_absolute()));
        assert!(!value.contains('\n'), "여러 줄이 섞였다: {value}");
    }

    /// **대조군 — 배너 한 줄을 `PATH` 로 착각하지 않는다.**
    ///
    /// 없으면 `sanitize` 가 "마지막 줄을 그대로 준다"로도 통과하고, 그러면 rc 가 찍은
    /// 인사말이 자식의 `PATH` 가 된다.
    #[test]
    fn path_가_아닌_출력은_받아들이지_않는다() {
        assert_eq!(
            sanitize("/usr/bin:/bin\n"),
            Some("/usr/bin:/bin".to_string())
        );
        // 배너 뒤에 진짜 값이 오면 **뒤엣것**을 잡는다.
        assert_eq!(
            sanitize("Last login: ...\n/opt/homebrew/bin:/usr/bin\n"),
            Some("/opt/homebrew/bin:/usr/bin".to_string())
        );
        assert_eq!(sanitize(""), None);
        assert_eq!(sanitize("   \n \n"), None);
        assert_eq!(sanitize("Welcome!\n"), None);
        assert_eq!(sanitize("relative:paths\n"), None);
    }

    /// 조회 인자가 리터럴이고 **로그인 셸**이다. `-l` 이 빠지면 GUI 가 준 빈약한 `PATH`
    /// 를 그대로 되돌려받아 이 모듈 전체가 아무 일도 안 하게 된다.
    #[test]
    fn 로그인_셸_인자가_고정_리터럴이다() {
        assert_eq!(LOGIN_SHELL_ARGS, ["-lc", "echo $PATH"]);
    }
}
