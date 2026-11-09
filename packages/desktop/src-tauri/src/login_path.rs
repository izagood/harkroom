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

/// 로그인 셸이 준 `PATH` 에 `node` 가 없을 때 **두 번째로** 부르는 셸의 인자. 역시 리터럴이다.
///
/// ## 왜 `-i` 가 따로 필요한가 — nvm·fnm 은 `.zshrc` 에 쓴다
///
/// `-l` 만 주면 zsh 는 `.zprofile`·`.zlogin` 은 읽지만 `.zshrc` 는 **안 읽는다** — `.zshrc` 는
/// 대화형 셸의 파일이다. 그런데 nvm·fnm 설치기는 `PATH` 줄을 `.zshrc` 에 쓴다. 그래서 nvm 으로만
/// Node 를 깐 사람은 터미널에서는 `node` 가 되는데 앱은 못 찾았다. 실측(2026-11-09, 가짜 `ZDOTDIR`
/// 의 `.zshrc` 에만 표식 디렉터리를 넣고): `zsh -lc 'echo $PATH'` 에는 0번, `zsh -ilc 'echo $PATH'`
/// 에는 1번 나온다.
///
/// ## 왜 처음부터 `-ilc` 로 부르지 않나
///
/// 대화형 rc 는 무겁고(테마·플러그인·자동 업데이트 확인) tty 를 기대하는 줄이 섞여 있을 수 있다.
/// `-lc` 로 이미 `node` 가 보이는 다수에게 그 비용·위험을 얹을 이유가 없다 — **`node` 를 못 찾았을
/// 때만** 부른다. 상한(`LOGIN_SHELL_TIMEOUT`)은 똑같이 걸린다.
pub const INTERACTIVE_SHELL_ARGS: [&str; 2] = ["-ilc", "echo $PATH"];

/// 셸 두 번으로도 `node` 를 못 찾았을 때 **실제로 `node` 가 들어 있는지 확인하고** 덧붙이는 자리.
///
/// `$HOME` 아래 경로는 `~/` 로 적었다. nvm 은 판마다 디렉터리가 달라 따로 고른다(`nvm_node_dir`).
///
/// ## 아래 `SYSTEM_PATH_FALLBACK` 주석의 "추측 목록을 만들지 않는다"와 어떻게 맞나
///
/// 그 주석이 꺼린 것은 **있는지 모르는 디렉터리를 `PATH` 에 지어 넣는 것**이다. 이 목록은 그렇게
/// 쓰지 않는다 — 디렉터리마다 실행 가능한 `node` 파일이 **실제로 있을 때만** 덧붙이고(`has_node`),
/// 로그인 셸의 `PATH` **뒤에** 붙여 사람이 고른 순서를 앞지르지 않는다. 셸 rc 에서 `PATH` 를 얻는
/// 길이 막힌 사람(nvm 을 `.zshrc` 에만 두고 대화형 rc 도 멎는 경우, `$SHELL` 이 fish 인 경우 등)에게
/// 남은 마지막 길이다.
pub const KNOWN_NODE_DIRS: [&str; 7] = [
    "~/.volta/bin",
    "~/.local/share/fnm/aliases/default/bin",
    "~/Library/Application Support/fnm/aliases/default/bin",
    "~/.asdf/shims",
    "~/.local/share/mise/shims",
    "/opt/homebrew/bin",
    "/usr/local/bin",
];

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

/// `PATH` 를 정하는 순서. 캐시를 거치지 않는다.
///
/// 1. `-lc` 로 얻은 값에 `node` 가 있으면 그것.
/// 2. 없으면 `-ilc`(`.zshrc` 까지) 로 한 번 더 — 거기 `node` 가 있으면 그것.
/// 3. 그래도 없으면 얻은 값(없으면 폴백) 뒤에 `node` 가 **실제로 있는** 알려진 자리를 덧붙인다.
///
/// 어느 단계에서도 `node` 를 못 찾으면 1·2 에서 얻은 값을 그대로 준다 — 그때의 사유는
/// `daemon_client::node_missing_reason` 이 화면에 말한다.
fn read_login_path() -> Option<String> {
    let shell = shell_program();
    let login = run_and_log(&shell, false);
    if login.as_deref().is_some_and(has_node) {
        return login;
    }
    let interactive = run_and_log(&shell, true);
    if interactive.as_deref().is_some_and(has_node) {
        crate::daemon_client::log_line("`node` 는 대화형 셸(.zshrc 등)의 PATH 에서 찾았다");
        return interactive;
    }
    let base = login.or(interactive);
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let extra = known_node_dirs(home.as_deref());
    if extra.is_empty() {
        crate::daemon_client::log_line("셸의 PATH 에도 알려진 자리에도 `node` 가 없다");
        return base;
    }
    crate::daemon_client::log_line(&format!(
        "셸의 PATH 에 `node` 가 없어 알려진 자리를 덧붙인다: {}",
        extra.join(":")
    ));
    Some(append_dirs(base.as_deref().unwrap_or(SYSTEM_PATH_FALLBACK), &extra))
}

/// `PATH` 안 어느 디렉터리에 실행 가능한 `node` 가 있는가.
fn has_node(path: &str) -> bool {
    path.split(':')
        .filter(|seg| !seg.is_empty())
        .any(|seg| is_executable(&Path::new(seg).join("node")))
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    // 심링크(volta·asdf shim, nvm alias)는 따라간다 — `metadata` 가 그렇게 한다.
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

/// `KNOWN_NODE_DIRS` + nvm 중 `node` 가 실제로 있는 디렉터리. `home` 이 없으면 `~/` 자리는 건너뛴다.
fn known_node_dirs(home: Option<&Path>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut push = |dir: std::path::PathBuf| {
        if is_executable(&dir.join("node")) {
            let s = dir.to_string_lossy().into_owned();
            if !out.contains(&s) {
                out.push(s);
            }
        }
    };
    if let Some(h) = home {
        if let Some(d) = nvm_node_dir(h) {
            push(d);
        }
    }
    for raw in KNOWN_NODE_DIRS {
        match raw.strip_prefix("~/") {
            Some(rest) => {
                if let Some(h) = home {
                    push(h.join(rest));
                }
            }
            None => push(std::path::PathBuf::from(raw)),
        }
    }
    out
}

/// nvm 이 깐 판 중 **가장 높은** 판의 `bin`. nvm 의 `default` 별칭은 판 이름이 아니라
/// `lts/*`·`22` 같은 식일 수 있어 그것을 풀지 않고 디렉터리 이름(`v22.11.0`)으로 고른다.
fn nvm_node_dir(home: &Path) -> Option<std::path::PathBuf> {
    let root = home.join(".nvm/versions/node");
    let mut best: Option<((u64, u64, u64), std::path::PathBuf)> = None;
    for entry in std::fs::read_dir(&root).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(ver) = parse_version(&name) else { continue };
        if best.as_ref().map_or(true, |(b, _)| ver > *b) {
            best = Some((ver, entry.path().join("bin")));
        }
    }
    best.map(|(_, p)| p)
}

fn parse_version(name: &str) -> Option<(u64, u64, u64)> {
    let mut it = name.strip_prefix('v')?.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next().unwrap_or("0").parse().ok()?;
    let patch = it.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// 사람이 고른 순서를 지키려고 **뒤에** 붙인다. 이미 있는 디렉터리는 다시 넣지 않는다.
fn append_dirs(base: &str, extra: &[String]) -> String {
    let mut parts: Vec<&str> = base.split(':').filter(|s| !s.is_empty()).collect();
    for d in extra {
        if !parts.contains(&d.as_str()) {
            parts.push(d);
        }
    }
    parts.join(":")
}

/// 셸 한 번을 부르고 결과를 로그에 남긴다.
fn run_and_log(shell: &str, interactive: bool) -> Option<String> {
    let flag = if interactive { INTERACTIVE_SHELL_ARGS[0] } else { LOGIN_SHELL_ARGS[0] };
    match run_login_shell(shell, interactive) {
        Ok(value) => {
            crate::daemon_client::log_line(&format!(
                "로그인 셸에서 PATH 를 얻었다: `{shell} {flag}` ({}자)",
                value.len()
            ));
            Some(value)
        }
        Err(reason) => {
            // **사유를 남긴다.** 이 실패는 조용히 폴백으로 이어지므로, 남기지 않으면
            // "폴백을 쓰고 있다"는 사실 자체를 아무도 모른다 — `#456` 이 고친 침묵과
            // 같은 모양이다.
            crate::daemon_client::log_line(&format!(
                "로그인 셸에서 PATH 를 얻지 못했다: `{shell} {flag}`: {reason}"
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
///
/// 인자는 **받지 않고 고른다** — 두 리터럴 중 하나다. 배열을 파라미터로 받으면 그것이 곧
/// 임의 인자의 문이 된다(`test/runnerShellScope.test.ts` 가 이 모양을 못박는다).
fn run_login_shell(shell: &str, interactive: bool) -> Result<String, String> {
    use std::process::Stdio;

    let mut child = Command::new(shell)
        .args(if interactive { INTERACTIVE_SHELL_ARGS } else { LOGIN_SHELL_ARGS })
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
    let line = last_line(&out).ok_or_else(|| "셸이 빈 PATH 를 돌려줬다".to_string())?;
    let dropped = relative_entries(line);
    if !dropped.is_empty() {
        // 버린 것을 남긴다 — 「내 PATH 의 `.` 이 왜 안 먹나」를 사람이 로그에서 찾을 수 있게.
        crate::daemon_client::log_line(&format!(
            "셸의 PATH 에서 절대 경로가 아닌 항목 {}개를 뺐다: {}",
            dropped.len(),
            dropped.join(":")
        ));
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
///
/// ## 왜 상대 항목을 빼나 — 오퍼레이터·러너는 남의 폴더에서 명령을 찾는다
///
/// `.`·`node_modules/.bin`·`bin` 같은 상대 항목은 **그 순간의 작업 폴더**를 기준으로 풀린다.
/// 러너는 에이전트가 일하는 저장소 폴더에서 `git`·`node`·하네스를 찾으므로, 상대 항목이 남아
/// 있으면 그 저장소가 심어 둔 같은 이름의 파일이 먼저 집힐 수 있다. `.zshrc` 를 읽는 `-ilc`
/// 를 들인 뒤로 이런 줄을 만날 일이 늘었다(security 권고, 2026-11-09). 그래서 **절대 경로 항목만**
/// 남기고, 버린 것은 `run_login_shell` 이 로그에 적는다. 빈 항목(`::`)도 현재 폴더를 뜻하므로 뺀다.
fn sanitize(raw: &str) -> Option<String> {
    let line = last_line(raw)?;
    let kept: Vec<&str> = line
        .split(':')
        .filter(|seg| Path::new(seg).is_absolute())
        .collect();
    if kept.is_empty() {
        return None;
    }
    Some(kept.join(":"))
}

/// 셸 출력의 마지막 비어 있지 않은 줄.
fn last_line(raw: &str) -> Option<&str> {
    let line = raw.lines().rev().find(|l| !l.trim().is_empty())?.trim();
    (!line.is_empty()).then_some(line)
}

/// `sanitize` 가 버리는 항목(절대 경로가 아닌 것). 빈 항목은 `(빈 항목)` 으로 적는다.
fn relative_entries(line: &str) -> Vec<String> {
    line.split(':')
        .filter(|seg| !Path::new(seg).is_absolute())
        .map(|seg| if seg.is_empty() { "(빈 항목)".to_string() } else { seg.to_string() })
        .collect()
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

    /// **상대 항목은 자식에게 넘기지 않는다**(security 권고) — `.`·`node_modules/.bin`·빈 항목은
    /// 작업 폴더 기준으로 풀려, 러너가 남의 저장소에서 같은 이름의 파일을 집을 수 있다.
    #[test]
    fn 절대_경로가_아닌_항목은_뺀다() {
        let raw = "/opt/homebrew/bin:.:node_modules/.bin::/usr/bin:bin\n";
        assert_eq!(sanitize(raw), Some("/opt/homebrew/bin:/usr/bin".to_string()));
        assert_eq!(
            relative_entries(last_line(raw).unwrap()),
            vec![".", "node_modules/.bin", "(빈 항목)", "bin"]
        );
        // 다 절대 경로면 그대로다.
        assert_eq!(sanitize("/a/bin:/usr/bin\n"), Some("/a/bin:/usr/bin".to_string()));
        assert!(relative_entries("/a/bin:/usr/bin").is_empty());
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "hk-login-path-{tag}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn fake_node(dir: &Path, exec: bool) {
        use std::os::unix::fs::PermissionsExt;
        std::fs::create_dir_all(dir).unwrap();
        let f = dir.join("node");
        std::fs::write(&f, "#!/bin/sh\n").unwrap();
        let mode = if exec { 0o755 } else { 0o644 };
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    /// **nvm·volta 처럼 `$HOME` 밑에만 있는 `node` 를 찾는다** — 실행 가능한 파일이 있을 때만.
    #[test]
    fn 홈_아래_node_자리를_실제로_있을_때만_찾는다() {
        let home = scratch("home");
        // 아무것도 없으면 홈 자리는 하나도 안 나온다(시스템 자리는 기계마다 달라 거른다).
        let homed = |v: Vec<String>| -> Vec<String> {
            v.into_iter().filter(|d| d.starts_with(&*home.to_string_lossy())).collect()
        };
        assert!(homed(known_node_dirs(Some(&home))).is_empty());

        // nvm: 판 여럿 중 가장 높은 것(문자열 순서로는 v9 가 v22 보다 크다 — 숫자로 비교해야 한다).
        fake_node(&home.join(".nvm/versions/node/v9.11.2/bin"), true);
        fake_node(&home.join(".nvm/versions/node/v22.11.0/bin"), true);
        fake_node(&home.join(".nvm/versions/node/v20.18.1/bin"), true);
        // volta: 실행 비트가 없으면 넣지 않는다.
        fake_node(&home.join(".volta/bin"), false);
        let got = homed(known_node_dirs(Some(&home)));
        assert_eq!(
            got,
            vec![home.join(".nvm/versions/node/v22.11.0/bin").to_string_lossy().into_owned()]
        );

        fake_node(&home.join(".volta/bin"), true);
        let got = homed(known_node_dirs(Some(&home)));
        assert_eq!(got.len(), 2);
        assert!(got[1].ends_with(".volta/bin"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn path_에_node_가_있는지_본다() {
        let d = scratch("has");
        let bin = d.join("bin");
        fake_node(&bin, true);
        let with = format!("/nonexistent-hk:{}", bin.display());
        assert!(has_node(&with));
        assert!(!has_node("/nonexistent-hk:/nonexistent-hk2"));
        let noexec = d.join("noexec");
        fake_node(&noexec, false);
        assert!(!has_node(&noexec.to_string_lossy()));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 덧붙이기는 **뒤에**, 겹치지 않게 — 사람이 고른 `node` 가 먼저다.
    #[test]
    fn 알려진_자리는_뒤에_붙고_겹치지_않는다() {
        let got = append_dirs("/opt/homebrew/bin:/usr/bin", &["/a/bin".into(), "/usr/bin".into()]);
        assert_eq!(got, "/opt/homebrew/bin:/usr/bin:/a/bin");
        assert_eq!(parse_version("v22.11.0"), Some((22, 11, 0)));
        assert_eq!(parse_version("system"), None);
    }

    /// 조회 인자가 리터럴이고 **로그인 셸**이다. `-l` 이 빠지면 GUI 가 준 빈약한 `PATH`
    /// 를 그대로 되돌려받아 이 모듈 전체가 아무 일도 안 하게 된다.
    #[test]
    fn 로그인_셸_인자가_고정_리터럴이다() {
        assert_eq!(LOGIN_SHELL_ARGS, ["-lc", "echo $PATH"]);
        assert_eq!(INTERACTIVE_SHELL_ARGS, ["-ilc", "echo $PATH"]);
    }
}
