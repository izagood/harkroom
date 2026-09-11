//! 앱이 **daemon 을 통해** 러너를 소유하게 만드는 자리 — `#431` 2단계-b 3/3.
//!
//! 2/3 까지 daemon 은 있었지만 앱은 그것을 쓰지 않았다(앱이 직접 `runner_spawn` 했다).
//! 이 모듈이 그 마지막 한 칸을 잇는다: 앱은 daemon 이 없으면 **띄우고**, 있으면 **붙어서**,
//! 러너를 daemon 에게 띄우라고 시킨다.
//!
//! ## 왜 이 클라이언트가 Rust 에 있나 — 선택이 아니라 필연이다
//!
//! 웹뷰는 unix 소켓을 열 수 없다. 브라우저 런타임에 그 표면 자체가 없다(있는 것은
//! `WebSocket`·`fetch` 뿐이고 둘 다 unix 소켓을 못 잡는다). 그래서 소켓을 쥐는 쪽은
//! Rust 일 수밖에 없고, 그 결과가 곧 이 이슈가 요구하는 보안 성질이 된다:
//!
//! > `main.rs::runner_spawn` 의 주석 — 실행할 프로그램 경로·인자는 `sidecar_path()` 가
//! > 고정하고, **웹뷰는 그 프로그램의 이름도 인자도 고르지 못한다.**
//!
//! daemon spawn 에도 **똑같이** 적용된다. 그리고 여기서는 한 겹이 더 있다:
//!
//! | 무엇 | 누가 정하나 |
//! |---|---|
//! | daemon 실행 파일 경로 | Rust — `sidecar_path(DAEMON_SIDECAR_NAME)` |
//! | daemon 에 넘길 인자 | Rust — 아래 `spawn_daemon` 이 리터럴로 조립한다 |
//! | **소켓·토큰·pid 경로** | Rust — `app.path().app_data_dir()` 에서 계산한다 |
//! | 토큰 값 | Rust — 토큰 **파일**에서 읽는다 |
//! | 러너 env(PAT·URL·PATH) | 웹뷰 — **값**이지 실행 표면이 아니다 |
//!
//! **경로를 웹뷰가 고르면 안 되는 이유**가 프로그램 경로와 조금 다르다: 소켓 경로를
//! 고를 수 있으면 웹뷰가 자기가 준비한 소켓을 가리켜 daemon 행세를 하는 프로세스에
//! 앱을 붙일 수 있고, 그러면 PAT 가 실린 `spawnRunner` 가 그쪽으로 간다. 토큰 경로도
//! 마찬가지다 — 자기가 아는 토큰이 든 파일을 가리키면 인증이 무의미해진다.
//! 그래서 **웹뷰가 넘기는 것은 값뿐이다.**
//!
//! ## 왜 폴백이 없나 — 조용한 이중 소유를 만들지 않는다
//!
//! daemon 기동에 실패했을 때 옛 경로(앱이 직접 spawn)로 물러나지 **않는다.** 물러나면
//! 사람은 "daemon 이 도는 줄 알았는데 아니었다"를 나중에, 그것도 다른 증상으로 알게
//! 된다 — 앱을 껐더니 러너가 같이 죽었다든가, daemon 목록에 러너가 없다든가.
//! **무엇이 러너를 소유하는지 모르는 상태**가 이 이슈가 없애려는 바로 그것이다.
//!
//! 그래서 실패는 실패로 올라가고, 사유는 지어내지 않고 원문 그대로 화면에 오른다
//! (`#368`) — `runnerLauncher` 의 `failed` + `message` 가 그 통로다.
//!
//! ## `sessions.json`·`SessionStore` 는 여기 없다 (`#431` D5)
//!
//! 이 모듈은 프로세스만 다룬다. 세션 상태를 읽지도 쓰지도 않는다 — 그 파일의 writer 는
//! 러너 하나여야 하고, 여기가 두 번째 writer 가 되면 lost update 가 조용히 난다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// daemon 사이드카의 이름. **`tauri.conf.json` 의 `bundle.externalBin` 항목과 같아야 한다**
/// — 러너 쪽 `RUNNER_SIDECAR_NAME` 과 같은 계약이다.
pub const DAEMON_SIDECAR_NAME: &str = "harkroom-daemon";

/// 소켓·pid·토큰 파일명에 박히는 프로토콜 버전. **`@murmur/shared` 의
/// `DAEMON_PROTOCOL_VERSION` 과 같은 값이어야 한다** — 다르면 앱은 `daemon-v1.sock` 을
/// 보는데 daemon 은 `daemon-v2.sock` 에 열어 서로를 영영 못 만난다.
///
/// 두 곳에 같은 상수가 있는 것은 언어가 갈려서다(Rust ↔ TS). `daemonEndpointPaths.test`
/// 성격의 회귀선을 이 자리에도 둔다 — `test/daemonEndpointContract.test.ts` 가 두 값을
/// 대조한다.
pub const DAEMON_PROTOCOL_VERSION: u32 = 1;

/// unix 소켓 경로의 커널 상한(`sockaddr_un.sun_path`).
///
/// ## 왜 이 상수가 여기 있나 — 2/3 이 밟은 자리다
///
/// 넘으면 `bind` 가 **`EINVAL`** 로 실패하는데, 그 에러 이름만으로는 원인을 알 수 없다.
/// 2/3 실물 검증에서 115바이트짜리 워크트리 경로로 실제로 밟았고, `listen EINVAL:
/// invalid argument …` 앞에서 한참 헤맸다(`packages/daemon/src/server.ts::bindTemporary`
/// 주석에 그 원문이 남아 있다).
///
/// ## 여유가 얼마나 되나 — 실측 (2026-09-06)
///
/// ```text
/// /Users/alice2/Library/Application Support/app.harkroom.desktop/daemon/daemon-v1.sock
/// = 82바이트 (여유 22)
/// ```
///
/// 디렉터리 부분(`…/daemon/`)이 68바이트, 파일명 `daemon-v1.sock` 이 14바이트다.
/// `jaebin` 이 6자이므로 **사용자 이름이 28자까지는 통과하고 29자부터 넘는다.**
///
/// **그 22바이트를 갉는 것들** — 다음 사람이 "한 단계쯤 더 넣어도 되겠지"라고 생각할 때
/// 답이 여기 있어야 한다:
///
/// | 무엇 | 얼마나 |
/// |---|---|
/// | 긴 사용자 이름 | 1자당 1바이트 |
/// | 프로토콜 버전 자릿수(`daemon-v10`) | 1바이트 — 허용 이름이 27자로 준다 |
/// | 앱 식별자(`app.harkroom.desktop`, 18자)가 길어지면 | 그만큼 |
/// | `<appDataDir>/daemon/` 밑에 단계를 더 넣으면 | 그만큼 |
///
/// **그래서 "운영 경로는 안전하다"고 단정하지 않는다.** 아래 `check_socket_path_length`
/// 가 실제 경로를 만들 때마다 재고, 넘으면 `EINVAL` 대신 **사실을 그대로** 말한다.
pub const SOCKET_PATH_MAX: usize = 104;

/// 소켓 경로가 커널 상한 안인지 본다. 넘으면 `EINVAL` 이 아니라 **원인을** 돌려준다.
///
/// 이 검사가 없으면 실패는 daemon 쪽에서 `listen EINVAL: invalid argument` 로 나고, 그
/// 문자열에는 "길이"라는 말이 한 글자도 없다. 사유를 지어내는 것이 아니라 **잰 사실을
/// 그대로** 말하는 것이 요점이다(`#368`).
pub fn check_socket_path_length(socket_path: &Path) -> Result<(), String> {
    let bytes = socket_path.as_os_str().as_encoded_bytes().len();
    if bytes > SOCKET_PATH_MAX {
        return Err(format!(
            "소켓 경로가 {bytes}바이트로 커널 상한 {SOCKET_PATH_MAX}바이트를 넘는다: `{}` — \
             이 길이로는 daemon 이 bind 조차 못 한다(커널이 `EINVAL` 을 낸다)",
            socket_path.display()
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 개발 빌드 구획 — 워크트리마다 앱 데이터 뿌리를 가른다
// ---------------------------------------------------------------------------

/// 개발 빌드에서만 듣는 탈출구. 값이 있으면 그것이 곧 앱 데이터 뿌리가 된다.
///
/// ## 왜 릴리즈에서는 안 듣나 — 공격 표면이기 때문이다
///
/// 이 뿌리 밑에 있는 것을 보라: 소켓·**토큰**·pid·장부·로그. 환경변수로 뿌리를 옮길 수
/// 있으면, 앱을 띄우는 자리에 변수 하나를 심은 쪽이 **자기가 준비한 토큰 파일과 소켓**을
/// 앱에게 보게 만들 수 있다. 그러면 앱은 그쪽을 daemon 으로 알고 붙고, `spawnRunner` 에
/// 실리는 `MURMUR_PAT` 가 그리로 간다.
///
/// 이것은 모듈 주석의 표가 **"소켓·토큰·pid 경로는 Rust 가 정한다"**로 못박은 그 성질을
/// 정확히 뒤집는 것이다 — 그 표가 웹뷰를 막은 이유("자기가 아는 토큰이 든 파일을 가리키면
/// 인증이 무의미해진다")가 환경변수에도 그대로 적용된다. 웹뷰만 막고 환경변수를 열면
/// 같은 문을 옆으로 낸 셈이다.
///
/// 개발 빌드에서는 다르다. 그 앱을 띄우는 사람이 곧 그 빌드를 만든 사람이고, 환경변수를
/// 심을 수 있는 쪽은 이미 `target/debug/` 의 실행 파일 자체를 바꿀 수 있다 — 새로 여는
/// 문이 없다. 그래서 `cfg!(debug_assertions)` 로 가른다. **런타임 플래그가 아니라 컴파일
/// 타임 갈래인 것이 요점이다**: 릴리즈 바이너리에는 이 변수를 읽는 코드가 아예 없다.
const DEV_DATA_DIR_ENV: &str = "MURMUR_DEV_DATA_DIR";

/// 개발 구획 디렉터리 이름에 붙는 해시의 길이(16진 문자 수).
///
/// ## 왜 8인가 — 104바이트 예산에서 역산했다 (실측 2026-09-06)
///
/// ```text
/// 릴리즈: …/app.harkroom.desktop/daemon/daemon-v1.sock              = 82바이트 (여유 22)
/// 개발  : …/app.harkroom.desktop/dev-XXXXXXXX/daemon/daemon-v1.sock = 95바이트 (여유 9)
/// ```
///
/// `dev-` 4자 + 해시 8자 + `/` 1자 = **13바이트**를 그 22에서 갉는다. 남는 9바이트가
/// 사용자 이름의 여유이므로 **`jaebin`(6자) 기준으로 이름이 15자까지 통과한다**
/// (릴리즈에서는 28자였다).
///
/// 12자로 늘리면 99바이트가 되어 이름 여유가 11자로 준다. **개발 빌드만 쓰는 구획이라
/// 충돌 확률보다 예산이 더 비싸다** — 한 사람의 기계에 동시에 존재하는 워크트리는 많아야
/// 수십 개이고, 32비트 공간에서 그 정도의 생일 충돌 확률은 백만분의 일 수준이다.
/// 충돌해도 잃는 것은 "두 워크트리가 한 구획을 공유한다" 뿐이고, 그것은 이 변경 **이전의
/// 상태**다 — 즉 더 나빠지지 않는다.
///
/// 이 값을 늘리려는 다음 사람에게: `check_socket_path_length` 가 실제 경로를 만들 때마다
/// 재고 있으니 **재 보고 정하라.** 그 검사를 우회하면 실패가 `EINVAL` 로 되돌아간다.
const DEV_HASH_HEX_LEN: usize = 8;

/// 개발 구획 이름의 접두어. 사람이 `ls` 로 봤을 때 **이것이 개발 부스러기임을 알아야
/// 한다** — 릴리즈 데이터(`daemon/`)와 나란히 놓이므로, 지워도 되는 것과 지우면 안 되는
/// 것이 이름으로 갈려야 한다.
const DEV_DIR_PREFIX: &str = "dev-";

/// 해시 입력 — **이 크레이트의 소스 루트**(`<워크트리>/packages/desktop/src-tauri`).
///
/// ## 왜 이것으로 갈랐나
///
/// 후보가 셋 있었고 각각 다른 이유로 떨어진다.
///
/// | 후보 | 왜 아닌가 |
/// |---|---|
/// | 프로세스 cwd | **워크트리 안 어디서 띄우느냐에 따라 달라진다.** 하위 디렉터리에서 띄우면 다른 구획이 된다 — 같은 빌드가 같은 자리를 봐야 한다는 성질이 곧바로 깨진다 |
/// | `git worktree` 루트를 런타임에 조회 | `git` 을 실행해야 하고, 그 결과가 cwd 에 다시 의존한다. 그리고 `.app` 으로 배포된 개발 빌드에는 저장소가 옆에 없을 수도 있다 |
/// | **`CARGO_MANIFEST_DIR`(채택)** | — |
///
/// `env!("CARGO_MANIFEST_DIR")` 은 **컴파일 타임 상수**다. 그래서:
///
/// - **cwd 와 무관하다.** 워크트리 안 어느 디렉터리에서 `pnpm tauri dev` 를 띄워도 같다
/// - **바이너리에 박힌다.** 그 실행 파일을 어디로 옮겨 실행해도 자기를 만든 워크트리를
///   가리킨다 — 즉 "이 빌드가 어느 체크아웃에서 나왔나"라는 물음의 답 그 자체다
/// - **`git` 을 안 부른다.** 워크트리인지 일반 클론인지 묻지 않는다. 다른 경로에서
///   컴파일했으면 다른 구획이고, 그것이 우리가 원하는 바다
///
/// **같은 경로를 재사용하면 같은 구획이 된다.** 워크트리를 지우고 같은 자리에 새로
/// 만들면 앞선 장부를 물려받는다 — 이것은 함정이 아니라 의도다. 그 자리의 daemon 이
/// 남긴 러너를 그 자리의 다음 daemon 이 채택하는 것이 `#431` 2-c 의 고아 재발견이고,
/// 매번 새 구획을 주면 그 재발견이 영영 성립하지 않는다.
///
/// ## `entryPath` 관문과의 관계 — **층이 다르다. 관문을 지우지 마라**
///
/// `same_entry_path` 주석이 자기 한계를 이미 적어 뒀다: *"진짜 격리는 소켓 경로를 갈라야
/// 하고 그건 2-e 다"*. 이 함수가 그 2-e 다. 그러면 관문이 필요 없어지는가 — **아니다.**
///
/// | | 무엇을 하나 |
/// |---|---|
/// | **이 구획**(경로 분리) | 실수 자체를 없앤다. 두 빌드가 애초에 같은 소켓을 보지 않는다 |
/// | **`entryPath` 관문** | 그래도 같은 소켓을 보게 됐을 때 **그 사실을 드러낸다** |
///
/// 구획이 안 갈리는 경로가 실제로 남아 있다:
///
/// - **설치본 두 판본을 나란히 띄우면 뿌리를 공유한다** — `/Applications/Harkroom.app` 을
///   두 벌 둘 수는 없으니 실제로는 드물지만, 남는다. (앞 판본은 여기에 *"릴리즈
///   빌드끼리는 여전히 공유한다 — 의도다"* 라고 적혀 있었고, 그 문장이 이 저장소가 실제로
///   부딪힌 결함을 미리 적어 둔 자리였다: 로컬 `tauri build` 번들과 설치본이 소켓 하나를
///   만나 `EXIT_OCCUPIED`(10) 교착이 났다(2026-09-07). 그래서 갈래를 프로파일에서
///   **설치 자리**로 옮겼다 — `BuildSite::is_installed`)
/// - **`MURMUR_DEV_DATA_DIR` 를 두 워크트리에 같은 값으로 주면 합쳐진다** — 그것이 그
///   변수의 용도이기도 하다(둘을 일부러 한자리에 모으는 것)
/// - **같은 워크트리를 지우고 같은 경로에 다시 만들면 같은 구획이다** — 위 "같은 경로를
///   재사용하면"이 그것이고, 그때 앞선 빌드의 daemon 이 남아 있으면 그대로 만난다
///
/// 그 전부에서 관문이 마지막 관측 장치다. **격리를 넣었으니 감지를 뺀다**는 것은,
/// 격리가 완전하다는 것을 증명 없이 믿는 것이다.
fn dev_partition_source() -> &'static str {
    env!("CARGO_MANIFEST_DIR")
}

/// FNV-1a 64비트. **암호학적 해시가 아니고, 그럴 필요도 없다.**
///
/// 이 값이 하는 일은 서로 다른 소스 루트를 서로 다른 디렉터리 이름으로 옮기는 것뿐이다 —
/// 아무것도 인증하지 않고, 이것을 위조해도 얻는 것이 없다(자기 구획을 남의 것과 같은
/// 이름으로 만들 수 있을 뿐이고, 그것은 경로를 직접 주는 것과 다르지 않다).
///
/// 그래서 의존성을 하나도 안 늘리는 쪽을 골랐다. `sha2` 를 끌어오면 **릴리즈 바이너리에도**
/// 들어가는데, 릴리즈는 이 코드를 아예 안 밟는다.
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

/// 소스 루트 하나를 구획 디렉터리 이름(`dev-<해시>`)으로 옮긴다.
pub fn dev_partition_name(source: &str) -> String {
    let hex = format!("{:016x}", fnv1a64(source.as_bytes()));
    format!("{DEV_DIR_PREFIX}{}", &hex[..DEV_HASH_HEX_LEN])
}

/// **이 빌드가 어디에 놓여 있나** — 공유 뿌리·공유 키체인을 쓸 자격을 정하는 값들.
///
/// ## 왜 `cfg!(debug_assertions)` 만으로는 안 되나 — 축이 틀렸다
///
/// `#486`(뿌리)과 `#515`(키체인)가 가른 축은 **빌드 프로파일**이다. 그런데 실제로 부딪히는
/// 축은 **역할**이다 — 프로덕션 설치본이냐, 로컬에서 테스트로 띄운 것이냐.
///
/// **실측(2026-09-07)**: `/Applications/Harkroom.app`(앱 0.1.6)과 워크트리에서 `tauri build`
/// 한 `…/hamlet/…/target/release/bundle/macos/Harkroom.app`(앱 0.1.7)이 소켓 하나를 공유했다.
/// 둘 다 릴리즈 프로파일이라 옛 축에서 **같은 쪽**에 떨어졌다. 그 뒤 `entryPath` 관문이
/// 붙기를 막고(제 일을 했다) 우리 daemon 은 `EXIT_OCCUPIED`(10)로 물러나 — **붙지도
/// 띄우지도 못하는 교착**이 됐다(`ensure_at`·`same_entry_path` 주석).
///
/// 그 자리에서 두 앱은 **바이너리로 구별할 수 없다**: `docs/roadmap.md` 의 결정대로 설치본도
/// 같은 `tauri build` 산출물을 `/Applications` 에 복사한 것이라 identifier·프로파일·서명이
/// 전부 같다. 다른 것은 **놓인 자리** 하나뿐이고, 그래서 그것으로 판정한다.
///
/// ## 왜 환경변수가 아니라 실행 파일 경로인가
///
/// `MURMUR_DEV_DATA_DIR` 를 릴리즈에서 막은 이유(그 주석: 변수를 심은 쪽이 **자기가 준비한
/// 토큰 파일과 소켓**을 앱에게 보게 만들 수 있다)가 여기에는 없다. 실행 파일 경로는
/// **프로세스가 스스로 아는 값**이고 웹뷰가 못 고치며, 그 경로를 바꿀 수 있는 쪽은 이미
/// 그 실행 파일 자체를 바꿀 수 있다 — 새로 여는 문이 없다.
///
/// ## 왜 값을 파라미터로 받나
///
/// `dev_app_data_root` 주석의 "왜 파라미터로 뺐나"와 같은 이유다. `current_exe()` 와
/// `cfg!` 는 한 프로세스 안에서 **두 자리를 흉내 낼 수 없는 값**이라, 열어 두지 않으면
/// 회귀선이 조각을 직접 부르게 되고 그러면 조립하는 자리를 통째로 지워도 초록이다.
#[derive(Clone, Copy, Debug)]
struct BuildSite<'a> {
    /// 이 프로세스의 실행 파일(`std::env::current_exe`). `None` 은 **못 읽었다**다.
    exe: Option<&'a Path>,
    /// 사용자 홈. `~/Applications` 설치도 설치로 세기 위해 필요하다.
    home: Option<&'a Path>,
    /// 릴리즈 프로파일인가(`!cfg!(debug_assertions)`).
    release: bool,
}

impl BuildSite<'_> {
    /// **설치된 프로덕션 앱인가** — 공유 뿌리와 공유 키체인을 쓸 유일한 자격.
    ///
    /// 두 조건을 **둘 다** 요구한다. 프로파일만 보면 이 이슈(로컬 릴리즈 번들이 설치본의
    /// 소켓을 만난다)가 나고, 자리만 보면 `#515`(`/Applications` 에 복사해 둔 개발 빌드가
    /// 공유 세션·PAT 를 읽는다)가 난다.
    fn is_installed(&self) -> bool {
        if !self.release {
            // 개발 프로파일은 **어디에 놓여 있어도** 자격이 없다.
            return false;
        }
        // **실행 파일을 못 읽었으면 공유 쪽으로 떨어진다.** 두 오답의 무게가 다르다:
        // 로컬 빌드가 공유 쪽으로 가면 이 이슈의 교착이 나는데 그것은 로그에 남아 진단이
        // 된다. 반대로 설치본이 구획 쪽으로 가면 **배포된 사용자의 장부·세션이 옛 자리에
        // 남아 보이지 않게** 되고, 사람은 데이터가 사라진 것으로 본다 — 원인에 닿을 길이 없다.
        let Some(exe) = self.exe else {
            return true;
        };
        installed_roots(self.home)
            .iter()
            .any(|root| exe.starts_with(root))
    }
}

/// 설치 자리로 인정하는 디렉터리.
///
/// macOS 설치 자리는 두 곳이다 — 시스템 전역 `/Applications` 와 사용자별 `~/Applications`.
/// **정규화하지 않는다**(`same_entry_path` 와 다른 점이다): 여기서 재는 것은 "같은 파일인가"가
/// 아니라 "**어느 디렉터리 밑인가**"이고, 그 판정은 `starts_with` 로 끝난다.
fn installed_roots(home: Option<&Path>) -> Vec<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = home {
        roots.push(home.join("Applications"));
    }
    roots
}

/// 앱 데이터 **뿌리**를 정한다 — 이 밑의 모든 것이 함께 갈린다.
///
/// ## 소켓만 가르면 절반이다
///
/// 뿌리를 가르는 이유는 소켓이 아니라 **뿌리를 공유하는 것 전부**다:
///
/// ```text
/// <뿌리>/daemon/daemon-v1.sock          소켓
/// <뿌리>/daemon/daemon-v1.token         토큰
/// <뿌리>/daemon/daemon-v1.pid           pid 레코드
/// <뿌리>/daemon/daemon-v1.log           daemon 로그
/// <뿌리>/daemon/daemon-v1-client.log    앱 클라이언트 로그
/// <뿌리>/daemon/runners-v1.json         장부
/// <뿌리>/daemon/runner-<agentId>.log    러너 로그
/// ```
///
/// **장부가 특히 그렇다.** 소켓만 갈라 두 daemon 이 각자 뜨는데 장부가 하나면, 나중에 뜬
/// 쪽이 앞선 쪽의 표를 지우고(`writeRunnerLedger` 는 통째로 덮어쓴다) 그 러너들은 영영
/// 채택되지 못하는 고아가 된다 — **갈리기 전보다 나쁘다.**
///
/// **로그도 그렇다.** 실측(2026-09-06): `daemon-v1-client.log` 하나를 두 앱이 쓰는데
/// 어느 줄이 누구 것인지 구분할 수단이 없어 **두 세션이 서로의 로그를 자기 것으로 읽고
/// 원인을 반대로 진단했다.**
///
/// 그 전부가 여기 한 자리에서 갈리는 이유는 daemon 이 `appDataDir` 를 **소켓 경로에서
/// 되짚기** 때문이다(`run.ts::appDataDirFromSocket`, 두 단계 위). 앱이
/// `<뿌리>/daemon/daemon-v1.sock` 를 넘기면 daemon 은 `<뿌리>` 를 얻고, 장부·러너 로그를
/// 전부 거기에 놓는다. **되짚기 규칙은 안 고쳐도 성립한다** — 되짚기는 "두 단계 위"라는
/// 상대 규칙이고, 우리가 바꾼 것은 그 위의 절대 위치뿐이다.
///
/// ## 설치본은 그대로다 — 바꿀 이유가 없고, 바꾸면 잃는다
///
/// 설치된 앱의 뿌리를 옮기면 **이미 쌓인 장부와 설정이 옛 자리에 남아** 보이지 않게 된다.
/// 그래서 공유 뿌리를 쓰는 자격은 `BuildSite::is_installed` 하나로 좁혀 두고, 그 자격이
/// 없는 빌드에만 구획을 붙인다.
///
/// **갈래가 프로파일이 아니라 설치 자리인 이유**는 `BuildSite` 주석에 있다 — 요약하면,
/// 로컬 `tauri build` 번들도 릴리즈 프로파일이라 프로파일로는 설치본과 갈리지 않았고,
/// 그 둘이 소켓 하나를 만나 교착이 났다(2026-09-07 실측).
pub fn app_data_root(app_data_dir: &Path) -> PathBuf {
    let exe = std::env::current_exe().ok();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    resolve_app_data_root(
        app_data_dir,
        BuildSite {
            exe: exe.as_deref(),
            home: home.as_deref(),
            release: !cfg!(debug_assertions),
        },
        dev_partition_source(),
        dev_data_dir_override(),
    )
}

/// `app_data_root` 의 판정 — 자격이 있으면 공유 뿌리, 없으면 구획.
fn resolve_app_data_root(
    app_data_dir: &Path,
    site: BuildSite<'_>,
    source: &str,
    override_dir: Option<std::ffi::OsString>,
) -> PathBuf {
    if site.is_installed() {
        return app_data_dir.to_path_buf();
    }
    dev_app_data_root(app_data_dir, source, override_dir)
}

/// `MURMUR_DEV_DATA_DIR` 는 **개발 프로파일에서만** 읽는다.
///
/// 이 게이트가 `app_data_root` 의 갈래와 **분리돼 있어야 한다.** 앞 판본은 갈래 자체가
/// `cfg!(debug_assertions)` 라 변수 읽기도 자동으로 개발 전용이었다. 갈래가 설치 자리로
/// 바뀐 지금 이 게이트를 명시하지 않으면 **설치되지 않은 릴리즈 번들이 변수를 읽게 된다** —
/// `DEV_DATA_DIR_ENV` 주석이 막으려던 표면(변수 하나로 토큰·소켓을 갈아끼우는 것)이
/// 그대로 열린다. `cfg!` 인 것도 그대로다: 릴리즈 바이너리에는 아래 줄이 안 남는다.
fn dev_data_dir_override() -> Option<std::ffi::OsString> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os(DEV_DATA_DIR_ENV)
}

/// `app_data_root` 의 개발 갈래.
///
/// ## 왜 `source` 와 `override_dir` 를 파라미터로 뺐나 — 회귀선이 실물을 밟게 하려고
///
/// 둘 다 프로덕션에서는 **부르는 자리가 하나뿐**이다(`app_data_root` 위). 그런데 둘 다
/// 회귀선이 안에서 못 바꾸는 값이다:
///
/// - `source` 는 `env!` 라 **컴파일 타임 상수**다. 한 프로세스 안에서 두 워크트리를
///   흉내 낼 방법이 없다
/// - `override_dir` 는 프로세스 전역 환경이라, 테스트가 실제로 설정하면 병렬로 도는
///   다른 테스트를 밟는다
///
/// 파라미터로 빼지 않으면 회귀선은 `dev_partition_name` 같은 **조각**을 직접 부르게 되고,
/// 그러면 조각을 이어 붙이는 이 함수를 통째로 지워도 초록이다 — 되돌려 RED 절차에서
/// 실제로 그렇게 통과했다(2026-09-06). 지금은 두 "빌드"가 **같은 이 함수**를 지나므로
/// 이 함수가 구획을 안 붙이면 곧바로 빨개진다.
///
/// 경계가 넓어지지는 않는다: `source` 를 넘기는 자리는 여전히 Rust 안의 컴파일 타임
/// 상수 하나뿐이고, 웹뷰가 이 함수에 닿는 경로는 없다(모듈 주석의 표).
fn dev_app_data_root(
    app_data_dir: &Path,
    source: &str,
    override_dir: Option<std::ffi::OsString>,
) -> PathBuf {
    if let Some(raw) = override_dir {
        // **빈 값은 안 준 것으로 친다.** `MURMUR_DEV_DATA_DIR=` 로 지운 흔적이 남았을 때
        // 뿌리가 `""` 가 되어 상대 경로로 떨어지는 것을 막는다.
        if !raw.is_empty() {
            return PathBuf::from(raw);
        }
    }
    app_data_dir.join(dev_partition_name(source))
}

/// 키체인 서비스 이름의 **릴리즈 값**. 번들 식별자와 같다.
///
/// ## 이 문자열은 못 바꾼다 — 이미 배포된 사용자의 세션이 여기 들어 있다
///
/// `v0.1.0`·`v0.1.1` 을 설치한 사람의 macOS 키체인에는 이 이름(`svce`)으로 세션 토큰과
/// 러너 PAT 가 들어 있다. 이름을 바꾸면 그 항목들은 **그 자리에 남은 채 앱이 못 읽는다** —
/// 다음 실행에서 로그인 화면이 뜨고, 러너 PAT 는 고아가 된다. 마이그레이션 코드로
/// 옮길 수도 있지만 그것은 **남의 자격증명을 읽어 옮기는 코드**이고, 키체인 읽기는
/// 승인 대화상자를 띄운다(`main.rs` 의 `#450` 주석). 얻는 것이 없는 위험이다.
///
/// 그래서 **릴리즈 이름은 상수로 고정하고 회귀선으로 못박는다**
/// (`릴리즈_빌드의_키체인_이름은_안_바뀐다`). 이 값을 고치려는 다음 사람에게:
/// 그 회귀선이 빨개지는 것이 신호다 — 우회하지 말고 왜 배포된 사용자를 끊어도 되는지
/// 먼저 답을 만들어라.
const KEYCHAIN_SERVICE_RELEASE: &str = "app.harkroom.desktop";

/// 키체인 서비스 이름을 정한다 — `app_data_root` 와 **같은 자리에서 같은 구획으로** 갈린다.
///
/// ```text
/// 설치본   app.harkroom.desktop
/// 그 밖    app.harkroom.desktop.dev-<해시8>
/// ```
///
/// "설치본"의 정의는 `BuildSite::is_installed` 하나에 있다 — 뿌리와 **같은 판정**을 쓴다.
///
/// ## 왜 여기 있나 — `#486` 이 절반만 갈랐고, 두 곳이 따로 정하면 그 절반이 또 난다
///
/// `#486` 은 앱 데이터 **뿌리**를 워크트리별로 갈랐다. 그 주석은 *"이 뿌리 밑에 있는 것을
/// 보라: 소켓·토큰·pid·장부·로그"* 라고 적었고, 그것은 맞다 — **그 밑에 있는 것들은**
/// 갈렸다. 그런데 키체인은 그 뿌리를 안 쓴다. `main.rs` 의 `SERVICE` 상수로 직접 갔다.
///
/// 실측(2026-09-06): 릴리즈 `v0.1.0` 을 `/Applications` 에 처음 설치하고 열었는데 로그인
/// 화면 없이 워크스페이스가 떴고, 사이드바에 개발 서버(`:3401`)의 계정들이 있었다.
/// 설치한 사람이 만든 적 없는 것들이다(`#515`).
///
/// ## 한 출처 — `dev_partition_name(dev_partition_source())`
///
/// **해시를 여기서 다시 만들지 않는다.** `app_data_root` 가 쓰는 그 함수를 그대로 부른다.
/// 두 곳이 각자 해시를 만들면 한쪽만 고쳐지는 이 버그가 그대로 재발한다 — `#513`(daemon
/// PATH)도 같은 모양이었고(러너에는 넘기는데 daemon 에는 안 넘겼다), 이 저장소에서
/// "한쪽만 고쳐지고 다른 쪽이 안 따라온" 형태가 반복됐다.
///
/// 그 성질을 회귀선이 잰다(`키체인_이름이_데이터_뿌리와_같은_구획에서_나온다`): 뿌리의
/// 마지막 한 단계와 이 이름의 접미사가 **문자 단위로 같아야** 한다. 누가 여기서 해시를
/// 따로 만들면 곧바로 빨개진다.
///
/// ## `AppHandle` 이 필요 없다 — 그래서 키체인 커맨드가 그대로 쓸 수 있다
///
/// `app_data_root` 는 `AppHandle` 이 주는 `app_data_dir()` 를 **인자로 받아** 그 밑에
/// 구획을 붙인다. 그런데 구획 **이름 자체**는 `env!("CARGO_MANIFEST_DIR")` 하나로
/// 정해지는 컴파일 타임 값이라 `AppHandle` 이 필요 없다. 키체인에는 붙일 뿌리가 없고
/// 이름 하나만 있으면 되므로, 이 함수는 인자 없이 성립한다.
///
/// `secret_get`/`secret_set`/`secret_delete` 는 `AppHandle` 을 안 받는다
/// (`#450` 때문에 `spawn_blocking` 안에서 도는데, `AppHandle` 을 그 안으로 옮기면
/// 시그니처가 넓어진다). 이 함수가 인자를 안 받으므로 **그 시그니처를 안 건드린다.**
///
/// ## 환경변수 탈출구가 여기엔 없다
///
/// `MURMUR_DEV_DATA_DIR` 는 뿌리를 통째로 옮기는 값이라 키체인 이름에 대응이 없다.
/// 억지로 대응시키면(예: 그 경로를 해시) **같은 변수로 뿌리를 모은 두 빌드가 키체인은
/// 각자 쓰는** 어긋남이 생긴다. 그 변수의 용도는 "둘을 일부러 한자리에 모으는 것"인데
/// 키체인은 안 모이면 목적이 절반만 선다. 지금은 대응을 **안 만들어** 두 빌드가 같은
/// 워크트리 경로에서 나왔을 때만 같은 키체인을 쓴다 — 필요해지면 그때 근거를 대고 넣어라.
///
/// ## 이미 쌓인 개발 항목 — **지우는 코드를 만들지 않았다**
///
/// 이 변경 뒤 `app.harkroom.desktop` 아래 남는 `murmur.runner.pat.*`·`murmur.runner.device`
/// 개발 항목들은 아무도 안 읽는 고아가 된다. 그것을 코드로 지우지 않는다:
///
/// - **같은 이름 아래에 배포된 사용자의 진짜 세션이 있다.** 개발 부스러기와 실제
///   자격증명을 이름만 보고 가를 방법이 없다 — `murmur.runner.pat.<uuid>` 는 양쪽이
///   같은 모양이다. 잘못 지우면 되돌릴 수 없다
/// - **지우려면 먼저 읽어야 하고, 읽기는 승인 대화상자를 띄운다**(`#450`). 사람이
///   자기가 만든 적 없는 것에 승인을 하게 되는데, 그것이 `#515` 가 문제 삼은 동작이다
/// - 고아는 **자리만 차지한다.** 앱이 그 이름을 다시 안 보므로 새는 경로가 없다
///
/// 사람이 지우고 싶으면 **키체인 접근 앱에서 `app.harkroom.desktop` 을 검색해 개발 중
/// 만든 항목을 골라 지운다.** `security find-generic-password -s app.harkroom.desktop`
/// 으로 목록을 볼 수 있다. 어느 것이 개발 부스러기인지는 그것을 만든 사람만 안다.
pub fn keychain_service_name() -> String {
    let exe = std::env::current_exe().ok();
    let home = std::env::var_os("HOME").map(PathBuf::from);
    resolve_keychain_service_name(
        KEYCHAIN_SERVICE_RELEASE,
        BuildSite {
            exe: exe.as_deref(),
            home: home.as_deref(),
            release: !cfg!(debug_assertions),
        },
        dev_partition_source(),
    )
}

/// `keychain_service_name` 의 판정. **`app_data_root` 와 같은 `BuildSite::is_installed` 를
/// 쓴다** — 두 곳이 각자 판정하면 `#515` 의 "절반만 갈렸다"가 그대로 재발한다.
fn resolve_keychain_service_name(base: &str, site: BuildSite<'_>, source: &str) -> String {
    if site.is_installed() {
        return base.to_string();
    }
    dev_keychain_service_name(base, source)
}

/// `keychain_service_name` 의 개발 갈래.
///
/// ## 왜 파라미터로 뺐나 — `dev_app_data_root` 와 같은 이유다
///
/// `source` 는 `env!` 라 컴파일 타임 상수이고, 한 프로세스 안에서 두 워크트리를 흉내 낼
/// 방법이 없다. 파라미터로 열지 않으면 회귀선은 `dev_partition_name` 이라는 **조각**을
/// 직접 부르게 되고, 그러면 그 조각을 이어 붙이는 이 함수를 통째로 지워도 초록이다 —
/// `#486` 이 되돌려 RED 절차에서 실제로 그렇게 통과했다(2026-09-06).
///
/// `base` 도 같이 열어 뒀다. 릴리즈 상수를 회귀선이 직접 넘겨야 "개발 이름은 릴리즈
/// 이름으로 **시작한다**"를 재는 자리가 프로덕션 조립을 그대로 밟는다.
fn dev_keychain_service_name(base: &str, source: &str) -> String {
    // **`.` 로 잇는다.** 서비스 이름은 역DNS 꼴이고, 뿌리 쪽 구획(`dev-<해시>`)이
    // 디렉터리 한 단계인 것과 같은 자리다. 접미사가 `dev-` 로 시작하므로 사람이
    // 키체인 접근에서 봤을 때 **이것이 개발 부스러기임을 이름으로 안다** —
    // `DEV_DIR_PREFIX` 가 `ls` 에서 하는 일과 같다.
    format!("{base}.{}", dev_partition_name(source))
}

/// `<appDataDir>/daemon/daemon-v<N>.{sock,pid,token}` 세 경로.
///
/// **조립 규칙이 `@murmur/shared/daemonEndpoint::daemonEndpointPaths` 와 같아야 한다** —
/// 앱이 만든 경로를 daemon 에 인자로 넘기고, daemon 은 그 경로에서 `appDataDir` 를
/// 되짚어(`run.ts::appDataDirFromSocket`) 같은 규칙으로 다시 조립한다. 두 규칙이 갈리면
/// daemon 이 앱이 보지 않는 자리에 소켓을 놓는다.
#[derive(Clone, Debug)]
pub struct EndpointPaths {
    pub dir: PathBuf,
    pub socket: PathBuf,
    pub pid: PathBuf,
    pub token: PathBuf,
    /// daemon 의 stdout·stderr 를 받는 파일. **`daemonEndpointPaths` 에는 없는, 앱 쪽 추가다.**
    ///
    /// ## 왜 필요한가 — `open` 으로 띄운 앱은 자식의 출력을 버린다
    ///
    /// 사람이 실제로 쓰는 실행 방식은 Finder/Dock 클릭(`open`)이고, 그렇게 뜬 앱의 자식
    /// 프로세스 stdout·stderr 는 아무 데도 안 남는다. `#450`(터미널로 띄우면 러너가 뜨는데
    /// `open` 으로 띄우면 안 뜬다)의 진단이 막힌 이유가 정확히 그것이다 — 실패 사유가
    /// 있어도 볼 자리가 없었다.
    ///
    /// daemon 은 기동 과정을 stdout 에 적는다(`main.ts`: 인자·소켓 경로·점유 판정, `run.ts`:
    /// 실패 사유). 그것을 파일로 돌리면 `open` 으로 띄워도 **daemon 이 왜 안 떴는지가 남는다.**
    ///
    /// ## 왜 daemon 에 `--log-file` 인자를 넣지 않았나
    ///
    /// daemon 은 그런 인자를 받지 않는다(2/3 의 `args.ts` 에 없다). 그리고 넣을 필요도
    /// 없다 — **리다이렉션이 더 많이 잡는다.** 인자로 받은 로거는 프로세스가 로거를 세우기
    /// 전에 죽거나(모듈 로드 실패), 로거를 거치지 않는 경로로 죽으면(Node 의 미처리 예외
    /// 스택, 네이티브 크래시) 아무것도 안 남긴다. 그 셋이 정확히 `#450` 류의 증상이다.
    /// 파일 디스크립터를 통째로 돌리면 그 전부가 파일에 떨어진다.
    ///
    /// **경로는 Rust 가 정한다** — 웹뷰가 고르면 임의 파일을 앱 권한으로 덮어쓸 수 있다
    /// (모듈 주석의 표와 같은 경계). 소켓 104바이트 상한과는 무관하지만(그 상한은 unix
    /// 소켓 주소에만 걸린다) 같은 디렉터리에 두어 사람이 한자리에서 본다.
    pub log: PathBuf,
}

pub fn endpoint_paths(app_data_dir: &Path) -> EndpointPaths {
    let dir = app_data_dir.join("daemon");
    let base = format!("daemon-v{DAEMON_PROTOCOL_VERSION}");
    // 앱 클라이언트 로그도 **같은 디렉터리**에 둔다 — 사람이 daemon 로그와 한자리에서
    // 대조한다(`log_line` 주석, `#456`). 경로를 여기서 정하는 것이 요점이다: 웹뷰는
    // 이 함수를 부르지 못하므로 임의 파일을 앱 권한으로 덮어쓸 수 없다.
    let _ = CLIENT_LOG.set(dir.join(format!("{base}-client.log")));
    EndpointPaths {
        socket: dir.join(format!("{base}.sock")),
        pid: dir.join(format!("{base}.pid")),
        token: dir.join(format!("{base}.token")),
        log: dir.join(format!("{base}.log")),
        dir,
    }
}

// ---------------------------------------------------------------------------
// NDJSON 프로토콜 — `@murmur/shared/daemonProtocol` 의 Rust 쪽 절반
// ---------------------------------------------------------------------------

/// 러너 하나의 세대 구분자. **문자열이다** — `#419` 가 앱 안에서 `Symbol` 로 막은 것과
/// 같은 성질을 소켓 너머로 옮긴 값이다(`daemonProtocol.ts::IncarnationId` 주석).
pub type IncarnationId = String;

#[derive(Debug, Deserialize)]
struct HelloResult {
    ok: bool,
    #[serde(default)]
    error: Option<DaemonErrorBody>,
}

#[derive(Debug, Deserialize)]
struct DaemonErrorBody {
    code: String,
    message: String,
}

#[derive(Debug, Deserialize)]
struct ResponseBody {
    id: String,
    ok: bool,
    #[serde(default)]
    payload: Option<Value>,
    #[serde(default)]
    error: Option<DaemonErrorBody>,
}

/// `runnerExit` 이벤트. **`incarnationId` 가 이 이벤트의 핵심 필드다** — 이것이 없으면
/// 옛 러너의 늦은 exit 이 새 러너를 죽은 것으로 표시한다(`daemonProtocol.ts` 주석).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunnerExitEvent {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "incarnationId")]
    pub incarnation_id: IncarnationId,
    pub code: Option<i32>,
    pub signal: Option<String>,
    /// 러너 로그의 마지막 몇 줄, **그대로**(`#473`).
    ///
    /// ## 왜 이 줄들이 필요한가 — 78 이 두 사유를 공유한다
    ///
    /// 종료 코드 78(`EX_CONFIG`)은 자격증명 거부(`#250`)와 하네스 부재(`#340`)가 같이
    /// 쓴다. 러너는 그 둘을 **로그의 마지막 줄**로만 가르고
    /// (`packages/agent/src/exit.ts`: *"그 줄이 유일한 구분자다"*), 그 줄이 앱에 닿는
    /// 경로가 없어서 앱이 78 을 전부 "PAT 가 폐기됐다"로 단정했다.
    ///
    /// ## Rust 는 이 줄들을 읽지 않는다
    ///
    /// 여기서 하는 일은 daemon 이 보낸 것을 웹뷰로 **그대로 옮기는 것**뿐이다. 문구
    /// 판정은 웹뷰(`runnerLauncher.ts::handleExit`)가 한다 — 화면 문구를 아는 곳이
    /// 거기이고, 판정을 두 곳에 두면 한쪽만 고쳐지는 날이 온다.
    ///
    /// `#[serde(default)]` 인 이유: **버전이 갈린 daemon 이 이 필드를 안 보낼 수 있다.**
    /// 없으면 exit 통지 전체를 못 읽는 것보다 꼬리만 비는 편이 낫다 — 그러면 앱은 코드만
    /// 보여 준다(`#368`: 모르는 것을 모른다고 말한다).
    #[serde(rename = "tailLines", default)]
    pub tail_lines: Vec<String>,
}

/// `spawnRunner` 의 답.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnRunnerResult {
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub pid: u32,
    #[serde(rename = "incarnationId")]
    pub incarnation_id: IncarnationId,
}

// ---------------------------------------------------------------------------
// 접속
// ---------------------------------------------------------------------------

/// 요청 하나를 기다리는 자리. id 로 답을 짝짓는다 — NDJSON 은 순서를 보장하지만
/// 이벤트가 사이에 끼므로 "다음 줄이 내 답"이라고 가정할 수 없다.
type Pending = Arc<Mutex<HashMap<String, mpsc::Sender<ResponseBody>>>>;

/// 붙어 있는 daemon 연결 하나. **읽기 스레드 하나 + 쓰기 뮤텍스 하나**다.
pub struct DaemonConnection {
    write: Mutex<UnixStream>,
    pending: Pending,
    next_id: Mutex<u64>,
    /// 이 연결이 붙은 daemon 의 pid. 실물 검증이 "붙었나 새로 띄웠나"를 이 값으로 가른다.
    pub daemon_pid: u32,
}

impl DaemonConnection {
    /// 소켓에 붙고 `hello` 로 인증한다. **토큰은 파일에서 읽는다** — 웹뷰가 고르지 않는다.
    fn connect(paths: &EndpointPaths) -> Result<Self, String> {
        check_socket_path_length(&paths.socket)?;
        let token = std::fs::read_to_string(&paths.token)
            .map_err(|e| format!("토큰 파일을 읽지 못했다: `{}`: {e}", paths.token.display()))?;
        let token = token.trim().to_string();

        let stream = UnixStream::connect(&paths.socket).map_err(|e| {
            format!(
                "daemon 소켓에 붙지 못했다: `{}`: {e}",
                paths.socket.display()
            )
        })?;
        // 답이 영영 안 오면 앱이 멈춘다 — 읽기 스레드는 무한이지만 hello 왕복만은 잰다.
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .map_err(|e| format!("읽기 타임아웃을 걸지 못했다: {e}"))?;

        let mut reader = BufReader::new(
            stream
                .try_clone()
                .map_err(|e| format!("소켓을 복제하지 못했다: {e}"))?,
        );
        let mut write = stream;

        let hello = json!({
            "type": "hello",
            "version": DAEMON_PROTOCOL_VERSION,
            "token": token,
            "role": "app",
        });
        writeln!(write, "{hello}").map_err(|e| format!("hello 를 보내지 못했다: {e}"))?;

        let mut line = String::new();
        reader
            .read_line(&mut line)
            .map_err(|e| format!("hello 응답을 읽지 못했다: {e}"))?;
        if line.trim().is_empty() {
            return Err("daemon 이 hello 에 답하지 않고 연결을 끊었다".to_string());
        }
        let result: HelloResult = serde_json::from_str(line.trim())
            .map_err(|e| format!("hello 응답을 해석하지 못했다: {e}: {}", line.trim()))?;
        if !result.ok {
            let err = result
                .error
                .map(|e| format!("{}: {}", e.code, e.message))
                .unwrap_or_else(|| "사유 없음".to_string());
            return Err(format!("daemon 이 접속을 거절했다 — {err}"));
        }
        // pid 는 pid 파일에서 읽는다. hello 응답에도 실려 오지만, 실물 검증이 "같은
        // daemon 에 붙었나"를 재는 값은 파일에 남는 그 값이어야 사람이 `ps` 로 대조할 수 있다.
        let record = read_pid_record(&paths.pid);
        let daemon_pid = record.as_ref().map(|r| r.pid).unwrap_or(0);
        // **어느 빌드가 띄운 daemon 에 붙었는지 남긴다**(`#431` D3). 앱을 업데이트하면
        // 옛 daemon 이 그대로 살아 있을 수 있고(D4), 그때 이 줄이 "지금 내가 말하는 상대는
        // 옛 빌드다"를 사람에게 알리는 유일한 자리다 — 소켓 파일명은 프로토콜 버전만 갖는다.
        log_line(&format!(
            "daemon 에 붙었다: pid {daemon_pid} appVersion={} nonce={}",
            record
                .as_ref()
                .map(|r| r.app_version.as_str())
                .unwrap_or("?"),
            record
                .as_ref()
                .map(|r| r.launch_nonce.as_str())
                .unwrap_or("?"),
        ));

        // hello 를 통과했으니 이제 읽기는 무한 대기다 — 이벤트는 언제 올지 모른다.
        let _ = write.set_read_timeout(None);

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        Ok(DaemonConnection {
            write: Mutex::new(write),
            pending,
            next_id: Mutex::new(0),
            daemon_pid,
        })
    }

    /// 읽기 스레드를 띄운다. 응답은 `pending` 으로, 이벤트는 `on_event` 로 흐른다.
    fn start_reader(
        &self,
        mut reader: BufReader<UnixStream>,
        on_event: impl Fn(&str, Value) + Send + 'static,
    ) {
        let pending = self.pending.clone();
        std::thread::spawn(move || {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break, // daemon 이 끊었다.
                    Ok(_) => {}
                    Err(_) => break,
                }
                let text = line.trim();
                if text.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(text) else {
                    // 해석 못 한 줄은 버린다 — 여기서 연결을 끊으면 멀쩡한 대화가 한 줄
                    // 때문에 죽는다. daemon 쪽 디코더가 상한·형식을 이미 지킨다.
                    continue;
                };
                if value.get("type").and_then(Value::as_str) == Some("event") {
                    // **이름으로 분기하지 않는다** — 이벤트가 둘이 되면서(러너 exit,
                    // 계정 로그인 출력) 여기서 가르면 이벤트마다 이 루프를 고쳐야 한다.
                    // 이름과 payload 를 그대로 올리고, 무엇으로 만들지는 emitter 가 정한다
                    // (그쪽이 Tauri 를 아는 유일한 자리다).
                    if let (Some(name), Some(payload)) = (
                        value.get("event").and_then(Value::as_str),
                        value.get("payload"),
                    ) {
                        on_event(name, payload.clone());
                    }
                    continue;
                }
                let Ok(resp) = serde_json::from_value::<ResponseBody>(value) else {
                    continue;
                };
                let tx = pending.lock().ok().and_then(|mut m| m.remove(&resp.id));
                if let Some(tx) = tx {
                    let _ = tx.send(resp);
                }
            }
            // 연결이 끊겼다 — 기다리던 요청들은 채널이 닫히면서 실패로 풀린다.
            if let Ok(mut m) = pending.lock() {
                m.clear();
            }
        });
    }

    /// 요청 하나를 보내고 답을 기다린다.
    fn request(&self, req_type: &str, payload: Value) -> Result<Value, String> {
        let id = {
            let mut n = self
                .next_id
                .lock()
                .map_err(|_| "요청 id 락이 깨졌다".to_string())?;
            *n += 1;
            format!("app-{n}")
        };
        let (tx, rx) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "대기표 락이 깨졌다".to_string())?
            .insert(id.clone(), tx);

        let line = json!({ "id": id, "type": req_type, "payload": payload });
        {
            let mut w = self
                .write
                .lock()
                .map_err(|_| "쓰기 락이 깨졌다".to_string())?;
            writeln!(w, "{line}").map_err(|e| format!("요청을 보내지 못했다: {e}"))?;
        }

        // 무한히 기다리지 않는다 — daemon 이 멈추면 앱의 그 조작도 멈춘다.
        let resp = rx
            .recv_timeout(Duration::from_secs(30))
            .map_err(|_| format!("daemon 이 `{req_type}` 에 답하지 않는다(30초)"))?;
        if !resp.ok {
            let err = resp
                .error
                .map(|e| format!("{}: {}", e.code, e.message))
                .unwrap_or_else(|| "사유 없음".to_string());
            return Err(format!("daemon 이 `{req_type}` 를 거절했다 — {err}"));
        }
        Ok(resp.payload.unwrap_or(Value::Null))
    }
}

/// pid 파일의 내용. **`daemonEndpoint.ts::DaemonPidRecord` 와 같은 모양이어야 한다.**
///
/// `launch_nonce`·`app_version` 을 읽어 두는 이유: 붙은 daemon 이 **어느 앱 빌드가 띄운
/// 것인지**를 사람이 로그에서 대조할 수 있어야 한다(`#431` D3 — "파일 하나로 판정한다").
/// pid 만으로는 못 가린다 — OS 가 그 번호를 돌려 쓴다.
#[derive(Debug, Deserialize)]
pub struct PidRecord {
    pub pid: u32,
    #[serde(rename = "launchNonce", default)]
    pub launch_nonce: String,
    #[serde(rename = "appVersion", default)]
    pub app_version: String,
    /// 그 daemon **실행 파일의 경로**. `#431` 2단계 A 가 판정에 쓰기 시작한 필드다.
    ///
    /// daemon 이 자기 기동 인자(`--entry-path`)로 받아 pid 파일에 적는다
    /// (`daemonEndpoint.ts::DaemonPidRecord.entryPath`). 옛 daemon 은 안 적을 수 있어
    /// `default` 다 — 빈 문자열은 "모른다"이고, 아래 `same_entry_path` 가 그것을
    /// **다른 것으로** 다룬다.
    #[serde(rename = "entryPath", default)]
    pub entry_path: String,
}

pub fn read_pid_record(path: &Path) -> Option<PidRecord> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

/// 소켓을 쥐고 있는 daemon 이 **내 빌드의 것인가** — `#431` 2단계 A 가 추가한 관문.
///
/// ## 왜 이 검사가 필요해졌나 — 소켓이 워크트리를 가로지른다
///
/// `resolve_endpoint_paths` 는 `app.path().app_data_dir()` 에서 경로를 계산하고, 그 값은
/// **번들 식별자**로 정해진다(`app.harkroom.desktop`). **워크트리 성분이 없다.** 그래서
/// 같은 기계의 모든 체크아웃·모든 빌드가 소켓 **하나**를 공유한다:
///
/// ```text
/// ~/Library/Application Support/app.harkroom.desktop/daemon/daemon-v1.sock
/// ```
///
/// **실측(2026-09-06)**: 릴리즈 앱이 다른 워크트리의 **debug** daemon(pid 35721,
/// `entryPath = …/permit/…/target/debug/harkroom-daemon`)에 그대로 붙었다. 토큰도 같은
/// 파일을 공유하니 인증은 자동으로 통과한다.
///
/// ## 무엇이 위험한가 — `#250` 과 **층이 다르다**
///
/// daemon 은 러너 경로를 클라이언트에게 받지 않고 **자기 옆에서** 찾는다:
///
/// ```ts
/// // packages/daemon/src/run.ts
/// export function defaultRunnerCommand(entryPath: string): string {
///   return resolve(dirname(resolve(entryPath)), 'harkroom-runner');
/// }
/// ```
///
/// 그 주석이 이유를 적어 뒀다 — *"경로를 클라이언트에게 받지 않는다. 받으면 소켓에 붙은
/// 누구든 임의의 실행 파일을 띄울 수 있다(`#250` 의 경계)"*. **그 판단은 지금도 옳다.**
/// 다만 그때는 daemon 이 하나라는 전제가 성립했다:
///
/// | | 막는 것 |
/// |---|---|
/// | `#250` | 클라이언트가 **요청 내용**으로 실행 파일을 고르는 것 |
/// | **이 검사** | 클라이언트가 **연결 상대**를 통해 실행 파일을 고르는 것 |
///
/// 소켓 공유가 두 번째 층을 새로 만들었다. `#250` 이 부실했던 것이 아니다.
///
/// ## 이것은 **신뢰 경계가 아니다** — 오배치 감지다
///
/// **`entryPath` 는 pid 파일을 쓸 수 있는 주체면 위조할 수 있다.** 같은 uid 면 쓸 수 있고,
/// 소켓 권한(0600)과 토큰이 막는 것은 **다른 사용자**이지 같은 사용자의 다른 빌드가
/// 아니다. 즉 이 검사가 잡는 것은 *사고*(개발 빌드와 릴리즈가 섞였다)이지 *공격*이 아니다.
/// 나중에 이 함수를 보안 장치로 오해하지 마라 — 그 격리는 소켓 경로를 갈라야 성립하고,
/// 그것은 2-e 의 다른 선택지다.
///
/// ## 비교 방법 — 정규화한다
///
/// 같은 파일이 다른 표기로 적힐 수 있다(심링크·`.` 성분·`/private` 접두). 그래서
/// `canonicalize` 로 양쪽을 실체 경로로 만든 뒤 비교한다. 실패하면(파일이 이미 사라졌다)
/// 원문 문자열로 떨어진다 — 거기서 다르다고 단정하지 않고, **모르는 것은 다른 것으로**
/// 다룬다(안 붙는다).
///
/// ## "안 붙어도 잃는 것은 없다" — **그것이 틀렸다**
///
/// 앞 판본은 여기에 *"안 붙어도 잃는 것은 없다: 그 뒤 우리 daemon 을 띄우면 된다"* 라고
/// 적혀 있었다. 점유자가 **살아 있는 다른 빌드**일 때는 성립하지 않는다 — 띄운 daemon 이
/// 예외 없이 `EXIT_OCCUPIED`(10)로 물러나므로(`claimDaemonEndpoint`), 앱은 붙지도 띄우지도
/// 못한다. 실측(2026-09-07): 로컬 `tauri build` 번들이 `/Applications` 설치본의 소켓을
/// 만나 그 교착에 빠졌고, 화면에는 *"러너를 띄우지 못했다 … 종료 코드 10"* 만 왔다.
///
/// 그 자리는 `BuildSite::is_installed` 가 뿌리를 갈라 없앴다 — 두 빌드가 애초에 같은
/// 소켓을 보지 않는다. **그래도 이 관문은 남는다**: 구획이 안 갈리는 경로가 여전히 있고
/// (`dev_partition_source` 주석의 목록), 이 관문이 거기서 마지막 관측 장치다.
///
/// 남은 그 경로들에서는 지금도 같은 교착이 난다. **그때 무엇을 하라고 말할지는 정해 뒀다** —
/// `occupied_reason` 이 pid 레코드를 읽어 점유한 앱의 번들 경로·pid·버전과 "그 앱을
/// 종료하고 다시 시도하라"를 문구에 싣는다. 교착 자체를 없애지는 못한다(그것은 위 구획의
/// 몫이다). 이 관문이 하는 일은 그대로다: **사실을 드러내는 것.**
fn same_entry_path(record_entry: &str, mine: &Path) -> bool {
    if record_entry.is_empty() {
        // 옛 daemon 이라 안 적었다. **같다고 단정하지 않는다** — 그 daemon 이 어느 빌드의
        // 러너를 띄울지 알 수 없고, 모르는 채로 붙는 것이 이 검사가 없애려는 상태다.
        return false;
    }
    let theirs = Path::new(record_entry);
    let norm = |p: &Path| std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    norm(theirs) == norm(mine)
}

// ---------------------------------------------------------------------------
// 기동 — 없으면 띄우고, 있으면 붙는다
// ---------------------------------------------------------------------------

/// daemon 을 확보한 결과. **"띄웠다"와 "붙었다"를 구분한다** — 실물 검증이 재는 성질이고
/// (같은 pid 면 붙은 것), 회귀선도 이 값으로 "이미 있으면 새로 안 띄운다"를 잰다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EnsureKind {
    /// 이미 서비스 중인 daemon 에 붙었다. **새 프로세스를 띄우지 않았다.**
    Attached,
    /// 없어서 띄웠다.
    Spawned,
}

/// 앱이 들고 있는 daemon 연결. `tauri::State` 로 관리된다.
///
/// **`Option` 인 이유**: 연결은 **처음 필요해진 순간**에 만들어진다. `#431` 2단계 A 이후
/// 그 순간은 앱 기동 직후(`daemon_ensure`)이지 러너를 띄우려 할 때가 아니다 — 그러나
/// 이 타입 자체는 그 시점을 모른다. 아직 안 붙었으면 `None` 이다.
pub struct DaemonState {
    pub inner: Mutex<Option<Arc<DaemonConnection>>>,
}

impl DaemonState {
    pub fn new() -> Self {
        DaemonState {
            inner: Mutex::new(None),
        }
    }
}

/// **없으면 띄우고, 있으면 붙는다.**
///
/// ## 순서가 요점이다 — 붙기를 먼저 시도한다
///
/// 띄우기부터 하면 이미 도는 daemon 이 있을 때 두 번째 프로세스가 뜨고, 그것이
/// `EXIT_OCCUPIED`(10)로 물러날 때까지 창이 생긴다. 그 창 자체는 daemon 쪽이 원자적
/// 획득(`claimDaemonEndpoint`)으로 막지만, **앱이 굳이 그 경쟁을 유발할 이유가 없다.**
/// 그래서 먼저 붙어 보고, 안 되면 그때 띄운다(`#431` D1).
///
/// ## 실패는 폴백하지 않는다
///
/// 어느 단계에서 실패하든 `Err` 로 올라간다. 앱이 직접 러너를 띄우는 옛 경로로
/// 물러나지 않는다 — 모듈 주석의 "왜 폴백이 없나" 참조.
///
/// ## `on_event` 를 **호출자가 못 고른다** — `#431` 2단계 A 가 고친 자리
///
/// 앞 판본은 `on_event` 를 파라미터로 받았다. 그런데 **읽기 스레드는 연결당 한 번만
/// 뜨고**(`open_connection` → `start_reader`), 연결은 `DaemonState` 에 캐시된다. 즉
/// **먼저 부른 쪽의 콜백이 이긴다.** 뒤에 오는 호출은 자기 콜백을 넘겨도 조용히 버려진다.
///
/// 앞 판본에서 그 승부는 이랬다:
///
/// | 호출자 | 넘기던 콜백 |
/// |---|---|
/// | `daemon_spawn_runner` | 웹뷰로 exit 을 올리는 emitter |
/// | `daemon_kill_runner` | `\|_\| {}` |
/// | `daemon_list_runners` | `\|_\| {}` |
///
/// 러너를 띄우는 쪽이 언제나 먼저 불렸기 때문에 우연히 맞았다. **2단계 A 는 그 순서를
/// 뒤집는다** — 앱이 기동하자마자 `daemon_ensure`(→ 목록 조회)로 daemon 을 먼저 세우기
/// 때문이다. 그러면 빈 콜백이 먼저 자리를 잡고, 그 뒤 `daemon_spawn_runner` 가 넘기는
/// emitter 는 버려진다. **exit 이벤트가 앱에 영영 안 온다** — 죽은 러너가 화면에 계속
/// `running` 으로 남고, `#419`·`#473` 의 판정이 전부 굶는다.
///
/// 그래서 콜백을 파라미터에서 **없앴다.** 이 함수가 `AppHandle` 로 emitter 를 직접
/// 조립한다 — 호출자가 셋이든 열이든 붙는 콜백은 언제나 같은 하나다. "누가 먼저
/// 부르느냐"가 동작을 바꾸지 못하게 만드는 것이 이 변경의 전부다.
pub fn ensure_daemon(
    app: &tauri::AppHandle,
    state: &DaemonState,
) -> Result<(Arc<DaemonConnection>, EnsureKind), String> {
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "daemon 상태 락이 깨졌다".to_string())?;
    if let Some(conn) = guard.as_ref() {
        // 이미 붙어 있다. 살아 있는지는 `ping` 으로 확인한다 — 소켓이 조용히 끊겨 있으면
        // 다음 `spawnRunner` 가 실패하는데, 그 실패는 "daemon 이 죽었다"가 아니라
        // "요청이 안 갔다"로 보인다.
        if conn.request("ping", json!({})).is_ok() {
            return Ok((conn.clone(), EnsureKind::Attached));
        }
        *guard = None;
    }

    let paths = resolve_endpoint_paths(app)?;
    // **내 빌드의 daemon 실행 파일.** 소켓을 쥔 daemon 이 이것과 다른 것이면 안 붙는다
    // (`same_entry_path` 주석: 소켓이 워크트리를 가로질러 공유된다).
    let my_entry = crate::sidecar_path(DAEMON_SIDECAR_NAME)?;
    let launch_app = app.clone();
    let launch_paths = paths.clone();
    let (conn, kind) = ensure_at(&paths, &my_entry, runner_exit_emitter(app), move || {
        spawn_daemon(&launch_app, &launch_paths)
    })?;
    *guard = Some(conn.clone());
    Ok((conn, kind))
}

/// 러너 exit 을 웹뷰로 올리는 **유일한** 콜백.
///
/// 여기서 세대를 가리지 않는다 — daemon 이 말한 사실을 그대로 올리고, `incarnationId` 로
/// 세대를 가리는 것은 웹뷰(`runnerLauncher.ts::daemonSpawner`)의 일이다(`#419` 의 계약이
/// 소켓 너머로 이어지는 자리).
fn runner_exit_emitter(
    app: &tauri::AppHandle,
) -> impl Fn(&str, Value) + Send + Clone + 'static {
    let emitter = app.clone();
    move |name, payload| {
        use tauri::Emitter;
        match name {
            "runnerExit" => {
                // **모양을 여기서 확인한다.** `incarnationId` 가 없는 exit 통지는 앱의
                // 세대 판정(`acceptRunnerExit`)이 쓸 수 없어, 올려 보내면 웹뷰가 그것을
                // 버릴 뿐이다 — 버릴 것을 보내지 않는다.
                if let Ok(ev) = serde_json::from_value::<RunnerExitEvent>(payload) {
                    let _ = emitter.emit(crate::RUNNER_EXIT_EVENT, ev);
                }
            }
            // 로그인 출력은 **모양을 재지 않고 그대로 올린다.** 필드가 상황마다 다르고
            // (url 만, done+status, error) 판단은 화면이 한다 — Rust 가 그 모양을 알면
            // 필드가 하나 늘 때마다 여기를 고쳐야 하고 그 고침은 아무것도 지켜 주지 않는다.
            "claudeLoginOutput" => {
                let _ = emitter.emit(crate::CLAUDE_LOGIN_EVENT, payload);
            }
            // 모르는 이벤트는 버린다 — 데몬이 우리보다 새 판본일 수 있다.
            _ => {}
        }
    }
}

/// `ensure_daemon` 의 **판단 부분**. `AppHandle` 을 모른다.
///
/// ## 왜 갈라놓았나 — 회귀선이 실물을 재게 하려고
///
/// "이미 있으면 새로 안 띄운다"는 이 단계의 핵심 성질인데, `AppHandle` 을 요구하면 회귀선이
/// 이 함수를 부를 방법이 없다. 그러면 테스트는 `DaemonConnection::connect` 를 직접 부르는
/// 식으로 **분기를 우회해서** 재게 되고, 그 상태에서 "1. 붙어 본다" 블록을 통째로 지워도
/// 테스트는 초록이다(실제로 그렇게 됐고, 되돌려 RED 절차가 그 사실을 드러냈다).
///
/// `launch` 를 클로저로 받는 것도 같은 이유다 — 회귀선이 "띄우는 자리가 **불리지 않았다**"를
/// 직접 셀 수 있어야 한다. 프로덕션에서 그 클로저 안에 들어가는 것은 `spawn_daemon` 하나뿐이다.
///
/// `my_entry` 는 **내 빌드의 daemon 실행 파일 경로**다(`same_entry_path` 주석 참조).
/// 프로덕션에서는 `sidecar_path(DAEMON_SIDECAR_NAME)` 하나뿐이고, 회귀선이 "남의 경로"를
/// 만들 수 있어야 해서 파라미터로 받는다.
/// 붙은 daemon 을 **물러나게 해야 하는가** — 낡은 번들이 띄운 것인가(2026-09-07).
///
/// ## 왜 이 판정이 필요한가 (실측)
///
/// daemon 은 `setsid` 로 떠서 앱 종료에도 살아남는다(`#431` — 그것이 목적이다: 앱을
/// 닫아도 에이전트가 일한다). 소켓·pid 파일명에는 **프로토콜 버전만** 들어가므로
/// (`daemonEndpoint.ts`) 앱을 업데이트해도 새 앱은 옛 daemon 에 그냥 붙는다.
///
/// 이 기계에서 실제로 이랬다: `--app-version 0.1.6` daemon 이 13:11 부터 살아 있고,
/// 앱은 16:50 에 **0.1.26** 으로 새로 떴는데도 그 daemon 에 붙어 있었다. 그날 daemon 쪽
/// 결함(러너에게 사용자 환경을 물려주지 않던 것)을 고쳐 릴리스했지만, 사람이 터미널에서
/// 프로세스를 손으로 죽이지 않으면 **고친 코드가 실행되지 않았다.**
///
/// `#431` 이 얻은 것("앱을 닫아도 러너가 산다")의 대가가 정확히 이것이다:
/// **살아남는 것은 고쳐지지 않는다.** 이 함수가 그 대가를 갚는다.
///
/// ## 판정이 한쪽으로 기운다
///
/// `adopt.ts` 의 규율과 같다 — *"확실하지 않으면 채택하지 않는다."* 여기서는
/// **확실하지 않으면 물러나게 하지 않는다**:
///
/// - 어느 쪽이든 버전을 못 읽으면 `false`. 옛 daemon 은 `appVersion` 을 아예 안 적었을
///   수 있고(`occupied_reason` 이 그 경우를 이미 다룬다), 모르는 것을 낡았다고 단정하는
///   것은 지어내는 것이다(`#368`).
/// - 숫자가 아닌 조각(pre-release, `dev` 등)이 섞이면 `false`. 순서를 지어내는 것보다
///   붙는 편이 안전하다.
/// - 같은 버전이면 `false`. 여기서 물러나게 하면 앱을 열 때마다 daemon 이 갈리고, 그때
///   러너까지 함께 회수되어 진행 중인 턴이 매번 죽는다.
/// - 상대가 더 새것이면 `false`. 옛 번들이 새 daemon 을 죽이는 경로는 만들지 않는다.
///
/// **호출부의 경계도 함께 읽어라**: 이 판정은 `same_entry_path` 가 참인 가지 안에서만
/// 쓰인다. 즉 **내 번들이 띄운 daemon** 에만 적용된다 — 남의 워크트리·다른 빌드의
/// daemon 은 이 함수에 닿지 않는다.
fn should_retire_daemon(theirs: &str, mine: &str) -> bool {
    let (Some(theirs), Some(mine)) = (parse_version(theirs), parse_version(mine)) else {
        return false;
    };
    let len = theirs.len().max(mine.len());
    for i in 0..len {
        // 없는 자리는 0 으로 읽는다 — `0.1` 과 `0.1.0` 은 같은 버전이다.
        let a = theirs.get(i).copied().unwrap_or(0);
        let b = mine.get(i).copied().unwrap_or(0);
        if a != b {
            return a < b;
        }
    }
    false
}

/// `0.1.26` → `[0, 1, 26]`. 숫자가 아닌 조각이 하나라도 있으면 `None` —
/// 순서를 지어내지 않는다(`should_retire_daemon` 주석).
fn parse_version(text: &str) -> Option<Vec<u64>> {
    let text = text.trim();
    if text.is_empty() {
        return None;
    }
    text.split('.')
        .map(|part| part.parse::<u64>().ok())
        .collect()
}

/// 낡은 daemon 에게 `SIGTERM` 을 보내고 **엔드포인트가 비기를 기다린다.**
///
/// `SIGTERM` 인 이유: daemon 의 핸들러가 소켓·pid·토큰 세 파일을 걷어내고 물러난다
/// (`daemon/src/main.ts` — *"`SIGTERM`/`SIGINT` 를 받으면 엔드포인트만 정리하고
/// 물러난다"*). `SIGKILL` 은 그 잔해를 남긴다. 즉 이것은 강제 종료가 아니라 **설계된
/// 퇴장 경로**다.
///
/// **러너에게는 아무 시그널도 가지 않는다**(daemon 의 shutdown 계약). 살아남은 러너는
/// 새 daemon 이 장부로 판정한다 — 낡은 세대의 러너를 어떻게 다룰지는 그쪽의 결정이고
/// (`adopt.ts`), 여기서 프로세스를 훑어 죽이면 그 판정을 앱이 가로채는 셈이 된다.
///
/// 비지 않으면 `false`. 그때도 호출부는 그대로 띄우러 간다 — 우리 daemon 이 뜨면
/// `claimDaemonEndpoint` 의 3중 증거가 "점유 중"을 보고 `EXIT_OCCUPIED` 로 물러나고,
/// 앱은 `occupied_reason` 으로 사람에게 누가 쥐고 있는지 말한다. 즉 실패도 **이미 있는
/// 경로**로 흐른다.
fn retire_daemon(paths: &EndpointPaths, pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // SAFETY: pid 는 pid 레코드에서 읽은 값이고, 이 함수는 `same_entry_path` 가 참인
    // 가지에서만 불린다 — 즉 내 번들이 띄운 daemon 이다.
    let sent = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
    if sent != 0 {
        log_line(&format!("낡은 daemon 에 SIGTERM 을 못 보냈다: pid {pid}"));
        return false;
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < deadline {
        // 세 파일 중 소켓·토큰이 사라지면 엔드포인트가 빈 것이다 — 그 둘이 붙기의 조건이다.
        if !paths.socket.exists() && !paths.token.exists() {
            log_line(&format!("낡은 daemon 이 물러났다: pid {pid}"));
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    log_line(&format!(
        "낡은 daemon 이 5초 안에 물러나지 않았다: pid {pid} — 그대로 띄워 본다"
    ));
    false
}

fn ensure_at(
    paths: &EndpointPaths,
    my_entry: &Path,
    on_event: impl Fn(&str, Value) + Send + Clone + 'static,
    launch: impl FnOnce() -> Result<DaemonExitWatch, String>,
) -> Result<(Arc<DaemonConnection>, EnsureKind), String> {
    // ── 1. 붙어 본다 — 다만 **내 빌드의 daemon 에만** ──────────────────────────
    if paths.socket.exists() && paths.token.exists() {
        // **붙기 전에 pid 레코드를 읽는다.** 소켓·토큰은 워크트리를 가로질러 공유되므로
        // (`same_entry_path` 주석의 실측) 파일이 있다는 것만으로는 "내 daemon" 이 아니다.
        //
        // 여기서 **아무것도 회수하지 않는다.** 남의 daemon 은 살아 있는 채로 두고 우리는
        // 우리 것을 띄우려 한다 — 그 뒤 daemon 쪽 `claimDaemonEndpoint` 의 3중 증거가
        // "붙었다 → 점유 중이다"를 보고 **물러난다**(`EXIT_OCCUPIED`). 즉 살아 있는 남의
        // daemon 을 죽이는 경로는 이 변경으로 생기지 않는다.
        let record = read_pid_record(&paths.pid);
        let theirs = record.as_ref().map(|r| r.entry_path.as_str()).unwrap_or("");
        if !same_entry_path(theirs, my_entry) {
            // **사유를 값으로 남긴다. 화면 문구는 만들지 않는다**(`#443`·`#460` 범위).
            // 로그에 두 경로를 함께 찍는 이유: 이 로그 파일은 지금 여러 빌드가 공유하고
            // 있어 누가 쓴 줄인지 모른다(별건). `entryPath` 가 그 줄의 출처를 말해 준다.
            log_line(&format!(
                "소켓을 쥔 daemon 이 다른 빌드의 것이라 붙지 않았다: 그쪽 entryPath=`{theirs}` \
                 내 entryPath=`{}` (pid {})",
                my_entry.display(),
                record.as_ref().map(|r| r.pid).unwrap_or(0),
            ));
        } else if should_retire_daemon(
            record.as_ref().map(|r| r.app_version.as_str()).unwrap_or(""),
            env!("CARGO_PKG_VERSION"),
        ) {
            // ── 낡은 번들이 띄운 daemon 이다 — 물러나게 하고 우리 것을 띄운다 ──────
            //
            // 이 가지가 없으면 daemon 쪽 수정은 릴리스를 타고도 사람에게 도달하지 않는다
            // (`should_retire_daemon` 주석의 실측). 붙어 버리면 그 순간 옛 코드가 계속
            // 러너를 띄우고, 앱은 그 사실을 로그 한 줄로만 남긴다.
            let their_pid = record.as_ref().map(|r| r.pid).unwrap_or(0);
            log_line(&format!(
                "소켓을 쥔 daemon 이 낡은 번들의 것이다(앱 {} < 내 {}) — 물러나게 한다: pid {their_pid}",
                record.as_ref().map(|r| r.app_version.as_str()).unwrap_or("?"),
                env!("CARGO_PKG_VERSION"),
            ));
            retire_daemon(paths, their_pid);
        } else {
            match open_connection(paths, on_event.clone()) {
                Ok(conn) => return Ok((conn, EnsureKind::Attached)),
                Err(err) => {
                    // 붙지 못했다 — 잔해일 수 있다. daemon 을 띄우면 그쪽이 3중 증거로
                    // 판정해 회수하거나 물러난다(`claimDaemonEndpoint`). 여기서 소켓 파일을
                    // 지우지 않는 것이 요점이다: 살아 있는 daemon 의 소켓을 앱이 날릴 수 있다.
                    log_line(&format!("daemon 에 붙지 못했다(띄워 본다): {err}"));
                }
            }
        }
    }

    // ── 2. 띄운다 ───────────────────────────────────────────────────────────
    let watch = launch()?;

    // daemon 이 소켓·토큰을 올릴 때까지 기다린다. **폴링이지 고정 대기가 아니다** —
    // 고정 `sleep` 은 느린 기기에서 모자라고 빠른 기기에서 낭비다.
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let mut last_err = "daemon 이 소켓을 올리지 않았다".to_string();
    while std::time::Instant::now() < deadline {
        // **자식이 이미 죽었으면 10초를 채우지 않는다**(`#513`).
        //
        // 셔뱅이 가리키는 `node` 를 못 찾으면 daemon 은 **즉시** 127 로 끝난다. 그때
        // 남은 9초를 소켓이 생기기를 기다리며 보내는 것은 순전한 낭비이고, 무엇보다
        // 그렇게 기다려 얻은 문구가 *"소켓을 올리지 않았다"* 였다 — 진짜 사유가 daemon
        // 로그에만 남고 화면에는 안 오던 그 침묵이다(`#443`·`#476` 계열).
        if let Some(reason) = watch.death_reason() {
            return Err(reason);
        }
        if paths.socket.exists() && paths.token.exists() {
            // **여기서도 같은 관문을 지난다.** 우리가 띄운 daemon 이 소켓을 잡기 전에
            // 남의 daemon 이 아직 쥐고 있을 수 있고(우리 것이 `EXIT_OCCUPIED` 로 물러났다면
            // 계속 그렇다), 그때 붙으면 1번 관문을 통과한 것과 같은 상태가 된다.
            let theirs = read_pid_record(&paths.pid)
                .map(|r| r.entry_path)
                .unwrap_or_default();
            if same_entry_path(&theirs, my_entry) {
                match open_connection(paths, on_event.clone()) {
                    Ok(conn) => return Ok((conn, EnsureKind::Spawned)),
                    Err(err) => last_err = err,
                }
            } else {
                last_err = format!(
                    "소켓을 다른 빌드의 daemon 이 쥐고 있다: 그쪽 entryPath=`{theirs}` \
                     내 entryPath=`{}`",
                    my_entry.display(),
                );
            }
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    // 10초를 다 썼는데도 자식이 그 사이에 죽었을 수 있다(마지막 `sleep` 동안). 한 번 더 본다.
    if let Some(reason) = watch.death_reason() {
        return Err(reason);
    }
    Err(format!(
        "daemon 을 띄웠지만 10초 안에 붙지 못했다: {last_err} — 소켓 `{}`",
        paths.socket.display()
    ))
}

fn open_connection(
    paths: &EndpointPaths,
    on_event: impl Fn(&str, Value) + Send + 'static,
) -> Result<Arc<DaemonConnection>, String> {
    let conn = DaemonConnection::connect(paths)?;
    let reader = BufReader::new(
        conn.write
            .lock()
            .map_err(|_| "쓰기 락이 깨졌다".to_string())?
            .try_clone()
            .map_err(|e| format!("소켓을 복제하지 못했다: {e}"))?,
    );
    conn.start_reader(reader, on_event);
    Ok(Arc::new(conn))
}

/// **소켓·토큰·pid 경로를 Rust 가 계산한다** — 웹뷰는 이 값을 못 고른다(모듈 주석 표 참조).
///
/// `app_data_dir()` 는 macOS 에서 `$HOME/Library/Application Support/<identifier>` 다
/// (`dirs::data_dir()` + `tauri.conf.json` 의 `identifier`). 이 디렉터리는 앱이 처음
/// 쓰는 것이므로 여기서 만든다 — 없으면 daemon 이 소켓을 열 자리가 없다.
///
/// **설치되지 않은 빌드에서는 그 밑의 워크트리 구획이 뿌리가 된다**(`app_data_root`).
/// `identifier` 는 안 건드린다 — 그 값은 키체인 서비스 이름과 묶여 있어(`#515`) 건드리면
/// 배포된 사용자의 세션이 끊긴다. 격리는 identifier **아래**, 이 뿌리에서 갈린다.
pub fn resolve_endpoint_paths(app: &tauri::AppHandle) -> Result<EndpointPaths, String> {
    use tauri::Manager;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("앱 데이터 디렉터리를 찾지 못했다: {e}"))?;
    let paths = endpoint_paths(&app_data_root(&app_data_dir));
    // **길이를 여기서 잰다.** 넘으면 daemon 쪽에서 `EINVAL` 로 나는데 그 이름에는
    // "길이"라는 말이 없다(위 `SOCKET_PATH_MAX` 주석의 실측 참조).
    check_socket_path_length(&paths.socket)?;
    std::fs::create_dir_all(&paths.dir).map_err(|e| {
        format!(
            "daemon 디렉터리를 만들지 못했다: `{}`: {e}",
            paths.dir.display()
        )
    })?;
    Ok(paths)
}

/// daemon 을 띄운다. **`detached_command()` 로 띄운다 — 앱이 죽어도 daemon 이 살아야 한다.**
///
/// `#431` D2 가 이 이슈의 핵심 메커니즘이라고 못박은 자리다. 실측(2026-09-05)이 근거다:
/// 앱을 SIGKILL 해도 자식은 살아남았지만 PGID 가 앱 그룹 그대로였고,
/// `kill -TERM -<앱 PGID>` 한 번에 전부 죽었다. orca 는 daemon 을 자기 PGID 로 분리해
/// (실측: `Orca Helper(1096) pgid=1096`) 그 경로를 원천 차단한다.
///
/// **인자는 전부 Rust 가 조립한다.** 웹뷰는 이 함수에 아무것도 못 넘긴다 —
/// 프로그램 경로도, 소켓·토큰·pid 경로도, nonce 도 여기서 만든다.
fn spawn_daemon(app: &tauri::AppHandle, paths: &EndpointPaths) -> Result<DaemonExitWatch, String> {
    let program = crate::sidecar_path(DAEMON_SIDECAR_NAME)?;
    if !program.is_file() {
        return Err(format!(
            "daemon 사이드카를 찾지 못했다: `{}` — 빌드가 externalBin 을 이 이름으로 넣었는지 확인하라",
            program.display()
        ));
    }

    let nonce = new_nonce();
    let app_version = app.package_info().version.to_string();

    let mut cmd = daemon_command(&program, paths, &nonce, &app_version);

    // **자식을 기다리지 않는다** — daemon 은 상주 프로세스다. 다만 핸들을 떨어뜨리면
    // 좀비가 남으므로, 종료를 거두는 스레드 하나만 붙여 둔다. 그 스레드가 하는 일은
    // `wait()` 뿐이고 러너에는 아무 영향도 주지 않는다.
    let mut child = cmd
        .spawn()
        .map_err(|e| spawn_failure_reason(&program, &e))?;
    let pid = child.id();
    log_line(&format!("daemon 을 띄웠다: pid {pid}"));

    // **그 스레드가 이제 종료 코드를 남긴다**(`#513`). 앞 판본은 `let _ = child.wait();`
    // 로 버렸는데, 그 버려진 값이 정확히 `ensure_at` 이 못 하던 말이었다 — 사이드카가
    // `node` 를 못 찾으면 daemon 은 127 로 **즉시** 끝나고, 그 사실을 아는 자리는 여기
    // 하나뿐이다(`spawn()` 은 성공한다 — 커널이 `execve` 한 것은 `/usr/bin/env` 이고
    // 그것은 있다).
    let watch = DaemonExitWatch::new(program.clone(), paths.pid.clone());
    let slot = watch.slot.clone();
    let log_path = paths.log.clone();
    std::thread::spawn(move || {
        let status = child.wait();
        if let Ok(mut guard) = slot.lock() {
            *guard = Some(match status {
                Ok(s) => DaemonExit {
                    code: s.code(),
                    tail: log_tail(&log_path),
                },
                // 거두지 못한 것은 죽은 것이 아니다 — 모르는 것을 죽었다고 말하지 않는다.
                Err(_) => return,
            });
        }
    });
    Ok(watch)
}

/// daemon 로그의 **마지막 비어 있지 않은 줄**. 없으면 `None` — 지어내지 않는다(`#368`).
///
/// ## 왜 로그를 읽나 — 종료 코드만으로는 사유를 못 가른다
///
/// 127 은 "명령을 못 찾았다"의 관례적 코드이지만 그것을 낸 것은 daemon 이 아니라
/// `/usr/bin/env` 다. 그리고 daemon 자신도 자기 사정으로 죽으며 코드를 낼 수 있다
/// (`EXIT_OCCUPIED`(10) 등). **그 줄을 읽는 것이 둘을 가르는 유일한 길**이고, 그것이
/// 이미 `daemon_command` 가 stdout·stderr 를 이 파일로 돌려 둔 이유다(`#450`).
///
/// 한 줄만 가져온다 — 화면에 오르는 값이므로 로그 전체를 실을 수는 없고, `env` 가
/// 뱉는 것도 정확히 한 줄이다(`env: node: No such file or directory`).
fn log_tail(log: &Path) -> Option<String> {
    let text = std::fs::read_to_string(log).ok()?;
    Some(
        text.lines()
            .rev()
            .find(|l| !l.trim().is_empty())?
            .trim()
            .to_string(),
    )
}

/// daemon 자식이 **죽었는지, 죽었다면 왜인지**. `#513`.
///
/// ## 왜 이것이 필요했나 — 화면이 소켓 이야기만 했다
///
/// `.dmg` 를 설치하고 Finder 로 연 사람이 받던 문구가 이것이었다(실측 2026-09-06):
///
/// > daemon 을 띄웠지만 10초 안에 붙지 못했다: daemon 이 소켓을 올리지 않았다
///
/// **전부 사실이지만 사람이 할 수 있는 일이 하나도 없다.** 진짜 사유(`env: node: No such
/// file or directory`)는 daemon 로그 파일에만 있었고, 그 파일이 어디 있는지는 개발자만
/// 안다. `#443`·`#476` 이 반복해서 고쳐 온 침묵과 같은 모양이다.
///
/// ## 왜 `spawn_failure_reason` 만으로는 안 되나 — **`spawn` 이 성공한다**
///
/// `spawn_failure_reason` 은 이미 `NotFound` 를 다루고 설치 주소까지 말한다(`#476`).
/// 그런데 그 분기는 **`#513` 의 조건에서 안 불린다.** 실측(2026-09-07):
///
/// ```text
/// $ env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin ./셔뱅스크립트
/// env: node: No such file or directory
/// exit=127
/// ```
///
/// 커널이 `execve` 하는 것은 셔뱅의 첫 낱말인 `/usr/bin/env` 이고 **그것은 있다.**
/// 그래서 `spawn()` 은 성공하고, `node` 를 못 찾는 것은 그 뒤 `env` 가 자식 안에서
/// 겪는 일이다. `ENOENT` 는 부모에게 안 온다.
///
/// 즉 같은 사유가 **두 자리**에서 서로 다른 모습으로 난다:
///
/// | 언제 | 어떻게 드러나나 | 누가 말하나 |
/// |---|---|---|
/// | 사이드카 자체를 exec 못 함 | `spawn()` 이 `ENOENT` | `spawn_failure_reason` (`#476`) |
/// | **셔뱅의 `node` 를 못 찾음** | **자식이 127 로 종료** | **이 구조체** (`#513`) |
///
/// 문구는 **한 자리에서 만든다**(`node_missing_reason`) — 둘로 나뉘면 한쪽만 고쳐지는
/// 날이 온다.
pub struct DaemonExitWatch {
    program: PathBuf,
    /// 점유로 물러났을 때 **누가 쥐고 있는지**를 읽을 자리(`EndpointPaths::pid`).
    ///
    /// 그 순간 이 파일은 **우리 것이 아니다.** 우리 daemon 은 점유를 보고 아무것도
    /// claim 하지 않은 채 물러났으므로(`claimDaemonEndpoint`), 여기 적혀 있는 것은
    /// 살아서 소켓을 쥐고 있는 쪽이다 — 그래서 그것을 사람에게 말할 수 있다.
    pid_path: PathBuf,
    slot: Arc<Mutex<Option<DaemonExit>>>,
}

struct DaemonExit {
    code: Option<i32>,
    tail: Option<String>,
}

/// 셸이 "명령을 못 찾았다"에 쓰는 관례적 종료 코드. `/usr/bin/env` 도 이것을 쓴다
/// (실측: 위 `DaemonExitWatch` 주석의 `exit=127`).
const EXIT_COMMAND_NOT_FOUND: i32 = 127;

/// daemon 이 **점유를 보고 물러났다**는 종료 코드.
///
/// **출처는 `packages/daemon/src/run.ts` 의 `EXIT_OCCUPIED` 다.** 그 값이 이 상수와
/// 갈리면 앱은 점유를 다른 사유로 읽고(또는 그 반대로) 사람에게 엉뚱한 말을 한다.
/// 두 언어를 가로질러 값을 공유할 방법이 없으므로 **회귀선이 두 파일을 읽어 대조한다** —
/// `packages/desktop/test/daemonExitCodes.test.ts`.
///
/// daemon 쪽에서 이 코드는 **실패가 아니다**(`daemon/src/main.ts`: *"앱은 그쪽에 붙으면
/// 된다"*). 앱이 그 조언을 실행할 수 있는 자리에서는 애초에 여기까지 오지 않는다 —
/// `ensure_at` 의 1번 관문이 먼저 붙는다. 여기 온 것은 **붙을 수 없는 상대**가 쥐고
/// 있다는 뜻이고, 그때 사람이 할 일은 `occupied_reason` 이 말한다.
const EXIT_OCCUPIED: i32 = 10;

impl DaemonExitWatch {
    fn new(program: PathBuf, pid_path: PathBuf) -> Self {
        DaemonExitWatch {
            program,
            pid_path,
            slot: Arc::new(Mutex::new(None)),
        }
    }

    /// **회귀선이 쓰는 생성자** — "띄웠고 아직 살아 있다". `launch` 클로저가 진짜
    /// 프로세스를 안 띄우는 테스트(붙기 분기만 재는 것들)가 이것을 돌려준다.
    #[cfg(test)]
    fn alive() -> Self {
        DaemonExitWatch::new(PathBuf::from("<테스트>"), PathBuf::from("<테스트>.pid"))
    }

    /// **회귀선이 쓰는 생성자** — 자식을 실제로 띄우지 않고 "이렇게 죽었다"를 만든다.
    /// 진짜 daemon 을 `node` 없는 `PATH` 로 띄워 재는 것은 통합 테스트의 몫이고,
    /// 문구 판정은 이 값 하나로 잴 수 있어야 한다.
    #[cfg(test)]
    fn exited(program: &str, code: Option<i32>, tail: Option<&str>) -> Self {
        // pid 경로는 **없는 자리**를 준다 — 점유 사유가 아닌 갈래를 재는 생성자이고,
        // 점유 갈래는 `exited_at` 이 실물 파일을 놓고 잰다.
        Self::exited_at(program, PathBuf::from("<없는 pid 파일>"), code, tail)
    }

    /// **회귀선이 쓰는 생성자** — `exited` 에 pid 레코드 자리를 더한 것. 점유 사유
    /// (`EXIT_OCCUPIED`)의 문구는 그 파일을 읽어야 나오므로 그 갈래는 이것으로 잰다.
    #[cfg(test)]
    fn exited_at(program: &str, pid_path: PathBuf, code: Option<i32>, tail: Option<&str>) -> Self {
        let watch = DaemonExitWatch::new(PathBuf::from(program), pid_path);
        *watch.slot.lock().unwrap() = Some(DaemonExit {
            code,
            tail: tail.map(str::to_string),
        });
        watch
    }

    /// 자식이 죽었으면 그 사유를, 아직 살아 있으면 `None`.
    ///
    /// **아직 안 죽은 것을 죽었다고 하지 않는다** — 이 함수가 `Some` 을 내는 순간
    /// `ensure_at` 이 기다리기를 그만두므로, 여기서 성급하면 정상 기동이 실패로 뒤집힌다.
    fn death_reason(&self) -> Option<String> {
        let guard = self.slot.lock().ok()?;
        let exit = guard.as_ref()?;
        // **점유 사유일 때만 pid 레코드를 읽는다.** 다른 사유에서는 그 파일이 우리
        // 것일 수도 있고 아예 없을 수도 있어, 읽어 봐야 사람에게 할 말이 안 나온다.
        let occupant = if exit.code == Some(EXIT_OCCUPIED) {
            read_pid_record(&self.pid_path)
        } else {
            None
        };
        Some(exit_reason(
            &self.program,
            exit.code,
            exit.tail.as_deref(),
            occupant.as_ref(),
        ))
    }
}

/// daemon 이 **일찍 죽은** 사유를 사람이 읽을 말로 바꾼다(`#513`).
///
/// `node` 를 못 찾은 것으로 **단정하는 조건이 좁다** — 종료 코드가 127 이고, 로그의
/// 마지막 줄이 그 사실을 실제로 말할 때만이다. 둘 중 하나라도 어긋나면 코드와 로그
/// 원문을 그대로 올린다. 사유를 지어내지 않는 것이 `#368` 이고, 여기서 넓게 잡으면
/// "무엇이 죽어도 Node 를 설치하라고 한다"가 된다 — `#473` 이 고친 오진과 같은 종류다.
fn exit_reason(
    program: &Path,
    code: Option<i32>,
    tail: Option<&str>,
    occupant: Option<&PidRecord>,
) -> String {
    if code == Some(EXIT_COMMAND_NOT_FOUND) {
        if let Some(line) = tail {
            if looks_like_missing_node(line) {
                return node_missing_reason(program, line);
            }
        }
    }
    let what = match code {
        Some(c) => format!("종료 코드 {c}"),
        None => "시그널".to_string(),
    };
    let 증거 = match tail {
        Some(line) => format!("daemon 이 뜨자마자 {what} 로 끝났다 — 로그 마지막 줄: {line}"),
        None => format!(
            "daemon 이 뜨자마자 {what} 로 끝났고 로그에 아무것도 안 남았다 — 사이드카 `{}`",
            program.display()
        ),
    };
    // **점유는 사유가 아니라 상태다.** 증거를 지우지 않고 그 앞에 사람이 할 일을 얹는다.
    if code == Some(EXIT_OCCUPIED) {
        return format!("{}. {증거}", occupied_reason(occupant));
    }
    증거
}

/// daemon 이 **점유로 물러났다**(`EXIT_OCCUPIED`)는 사유의 앞 문장.
///
/// ## 왜 종료 코드만으로는 못 쓰는 말이었나
///
/// 이 갈래가 없던 판본의 화면 문구는 이랬다(실측 2026-09-07):
///
/// ```text
/// 러너를 띄우지 못했다: daemon 이 뜨자마자 종료 코드 10 로 끝났다 —
/// 로그 마지막 줄: 이미 서비스 중인 daemon 이 있다: …/daemon-v1.sock — 물러난다
/// ```
///
/// 사람이 여기서 할 수 있는 일이 없다. *"이미 서비스 중인 daemon"* 이 **어느 앱인지**
/// 안 적혀 있고, 그 답은 pid 레코드에 이미 있었다. daemon 쪽에서 이 코드는 실패가
/// 아니라 *"앱은 그쪽에 붙으면 된다"* 는 조언인데(`daemon/src/main.ts`), 앱이 그 조언을
/// 실행할 수 없는 자리(`entryPath` 관문이 막은 뒤)에서 그대로 사람에게 올라왔다.
///
/// ## 무엇을 말하나 — **종료할 앱**이다
///
/// `entryPath` 는 daemon **실행 파일**이지만(`…/Harkroom.app/Contents/MacOS/harkroom-daemon`),
/// 사람이 종료할 수 있는 것은 `.app` 이다. 그래서 `app_bundle_of` 로 번들까지 줄여 말한다.
///
/// **모르는 것은 지어내지 않는다**(`#368`). 레코드를 못 읽었거나 `entryPath` 가 비어
/// 있으면(옛 daemon) 그 사실을 말하고, 할 일만 남긴다.
fn occupied_reason(occupant: Option<&PidRecord>) -> String {
    let known = occupant.filter(|r| !r.entry_path.is_empty());
    let Some(record) = known else {
        return "이미 다른 daemon 이 엔드포인트를 쥐고 있다(pid 레코드를 못 읽어 어느 앱인지는 \
                모른다) — 실행 중인 murmur 를 모두 종료하고 다시 시도하라"
            .to_string();
    };
    // 앱 버전은 옛 daemon 이 안 적었을 수 있다 — 없으면 그 자리를 비운다.
    let version = if record.app_version.is_empty() {
        String::new()
    } else {
        format!(", 앱 {}", record.app_version)
    };
    format!(
        "이미 다른 murmur 가 daemon 을 쥐고 있다: `{}` (pid {}{version}) — 그 앱을 \
         종료하고 다시 시도하라",
        app_bundle_of(&record.entry_path),
        record.pid,
    )
}

/// `.app` 번들 안의 실행 파일 경로를 **번들 경로**로 줄인다.
///
/// ```text
/// /Applications/Harkroom.app/Contents/MacOS/harkroom-daemon  →  /Applications/Harkroom.app
/// ```
///
/// **모양이 안 맞으면 원문을 그대로 돌려준다.** `tauri dev` 로 띄운 빌드의 사이드카는
/// 번들 안에 없다(`target/debug/harkroom-daemon`) — 그때 억지로 자르면 없는 경로를
/// 사람에게 말하게 된다.
fn app_bundle_of(entry: &str) -> &str {
    const INSIDE_BUNDLE: &str = "/Contents/MacOS/";
    match entry.find(INSIDE_BUNDLE) {
        Some(i) if entry[..i].ends_with(".app") => &entry[..i],
        _ => entry,
    }
}

/// 이 줄이 *"`node` 를 못 찾았다"* 인가.
///
/// **두 낱말을 다 요구한다.** `node` 만 보면 daemon 이 뱉은 다른 줄(모듈 이름·스택
/// 트레이스에 `node` 가 흔하다)까지 걸리고, "못 찾았다"만 보면 daemon 이 **다른 것**을
/// 못 찾은 경우까지 걸린다. 둘이 함께 있어야 이 판정이 성립한다.
///
/// `env` 가 내는 실제 문구가 근거다(실측 2026-09-07):
///
/// ```text
/// env: node: No such file or directory
/// ```
///
/// 셸이 셔뱅을 대신 해석하는 경로에서는 `node: command not found` 로도 난다. 둘 다 본다.
fn looks_like_missing_node(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    if !lower.contains("node") {
        return false;
    }
    lower.contains("no such file or directory") || lower.contains("not found")
}

/// **`node` 가 없다**는 사유의 문구. `spawn_failure_reason` 과 같은 말을 한다.
///
/// 설치 안내는 `@murmur/shared::installHint('node')` 가 이미 갖고 있는 그 문장이다
/// (`#476`). 새로 만들지 않았다 — 다만 Rust 에서 그 TS 함수를 부를 수 없어 문자열이
/// 두 벌 존재하고, `test/missingToolchainNotice.test.tsx` 가 이 파일을 읽어 둘이
/// 같은 주소를 말하는지 대조한다.
///
/// **`PATH` 를 함께 적는다.** `#513` 을 고친 뒤에도 이 문구가 나온다면 그것은
/// *"우리가 준 `PATH` 안에 정말로 `node` 가 없다"* 는 뜻이고, 그때 사람이 알아야 할
/// 다음 사실이 바로 그 `PATH` 다. 값 없이 "설치하라"고만 하면, 이미 설치한 사람은
/// 다시 설치하러 간다.
fn node_missing_reason(program: &Path, tail: &str) -> String {
    format!(
        "daemon 이 뜨자마자 끝났다 — 사이드카(`{}`)는 있는데 그것을 실행할 `node` 를 찾지 못했다. \
         murmur 는 Node.js 를 동봉하지 않는다. \
         Node.js 를 설치하라(LTS 판이면 된다): https://nodejs.org/en/download \
         (daemon 로그: {tail} / 이때 쓴 PATH: {})",
        program.display(),
        crate::login_path::child_path(),
    )
}

/// daemon 사이드카를 못 띄운 사유를 **사람이 읽을 말로** 바꾼다(`#476`).
///
/// ## 무엇이 문제였나 — 파일이 있는데 "파일이 없다"고 했다
///
/// 앞 판본은 이랬다:
///
/// ```text
/// daemon 을 띄우지 못했다: No such file or directory (os error 2)
/// ```
///
/// **이 문구를 받은 사람은 사이드카를 찾으러 간다. 그리고 사이드카는 거기 있다.**
/// 바로 위 `is_file()` 검사가 이미 통과했기 때문이다.
///
/// 없는 것은 **인터프리터**다. 사이드카는 셔뱅으로 시작하고
/// (`#!/usr/bin/env node` — `build-sidecars.mjs` 가 그렇게 낸다), 셔뱅 스크립트를
/// `execve` 할 때 커널은 **해석기를 못 찾아도 `ENOENT`** 를 돌려준다. 즉 이 자리의
/// `ENOENT` 는 두 가지 뜻을 갖는데, 앞의 것(사이드카 부재)은 이미 배제돼 있으므로
/// **남은 뜻은 하나다.**
///
/// murmur 는 `node` 를 동봉하지 않는다(2026-09-06 방침: *"자기 것만 배포하고 남의 것은
/// 사용자가 설치한다"*). 그래서 **`.dmg` 를 받은 사람의 기본 상태가 이것**일 수 있고,
/// 그때 화면이 아무 말도 안 하면 사람이 할 수 있는 일이 없다.
///
/// ## 사유를 지어내지 않는다
///
/// `ENOENT` 가 아닌 오류는 **그대로 올린다.** 권한(`EACCES`)·실행 형식(`ENOEXEC`) 등은
/// 다른 이야기이고, 그것들까지 "node 가 없다"로 접으면 이 함수가 곧 `#368` 이 된다.
/// `ENOENT` 일 때도 원문(`{e}`)을 지우지 않고 함께 남긴다 — 판정이 틀렸을 때 사람이
/// 그것을 알아볼 수 있어야 한다.
fn spawn_failure_reason(program: &Path, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        return format!(
            "daemon 을 띄우지 못했다 — 사이드카(`{}`)는 있는데 그것을 실행할 `node` 를 찾지 못했다. \
             murmur 는 Node.js 를 동봉하지 않는다. \
             Node.js 를 설치하라(LTS 판이면 된다): https://nodejs.org/en/download (원문: {e})",
            program.display()
        );
    }
    format!("daemon 을 띄우지 못했다: {e}")
}

/// daemon 을 띄울 `Command` 를 조립한다 — **프로그램·인자·리다이렉션이 전부 여기서 정해진다.**
///
/// ## 왜 `spawn_daemon` 에서 떼어냈나 — 회귀선이 실물을 재게 하려고
///
/// 이 함수가 `spawn_daemon` 안에 인라인돼 있으면 `AppHandle` 없이는 부를 수 없고, 그러면
/// 회귀선이 daemon 을 띄우기 위해 **자기 손으로 커맨드를 다시 조립**하게 된다. 그 사본은
/// 프로덕션 코드가 아니므로, `detached_command` 를 `Command::new` 로 바꿔도 사본은 그대로
/// 초록이다 — 즉 `setsid` 회귀선이 아무것도 안 지킨다(이 구조를 만들기 전에 실제로 그렇게
/// 됐고, 되돌려 RED 가 통과하는 것으로 그 사실이 드러났다).
///
/// `detached_command()` 가 `main.rs` 에서 `runner_spawn` 과 테스트에 공유되던 것과 같은
/// 이유다 — **재는 대상과 도는 대상이 같아야 한다.**
fn daemon_command(
    program: &Path,
    paths: &EndpointPaths,
    nonce: &str,
    app_version: &str,
) -> std::process::Command {
    use std::process::Stdio;

    let mut cmd = crate::detached_command(program);

    // **`PATH` 를 명시한다 — `#513` 이 고치는 한 줄이 이것이다.**
    //
    // daemon 사이드카는 셔뱅 스크립트(`#!/usr/bin/env node`)이고, Finder·Dock 으로 띄운
    // 앱이 물려받는 `PATH` 는 `/usr/bin:/bin:/usr/sbin:/sbin` 정도다 — Homebrew 도
    // nvm 도 거기 없다. 실측(2026-09-06)에서 daemon 로그의 마지막 줄이
    // `env: node: No such file or directory` 였고, 그것이 "모든 에이전트가 기동 실패"의
    // 유일한 원인이었다.
    //
    // **값은 웹뷰가 주지 않는다.** daemon 은 웹뷰보다 먼저 뜨므로(`#431` 2단계 A —
    // `controller.start` 가 `ensureDaemon` 을 기동 직후 부른다) 웹뷰가 캐낸 값을 기다릴
    // 수 없다. Rust 가 스스로 캐낸다 — 그 근거와 "출처가 둘이 되지 않게 한 방법"은
    // `login_path.rs` 모듈 주석에 있다.
    //
    // **여기서 `env_clear()` 를 하지 않는다.** daemon 이 물려받아야 할 것이 `PATH` 만은
    // 아니다(`HOME` 이 없으면 앱 데이터 자리를 못 찾고, `TMPDIR`·로케일도 그대로여야
    // 한다). 고치는 것은 비어 있던 한 칸이지 환경 전체가 아니다.
    cmd.env("PATH", crate::login_path::child_path());

    cmd.arg("--socket")
        .arg(&paths.socket)
        .arg("--token")
        .arg(&paths.token)
        .arg("--pid-record")
        .arg(&paths.pid)
        .arg("--launch-nonce")
        .arg(nonce)
        .arg("--entry-path")
        .arg(program)
        .arg("--app-version")
        .arg(app_version)
        .stdin(Stdio::null());

    // **stdout·stderr 를 파일로 돌린다** — `EndpointPaths::log` 주석의 이유다.
    // `open` 으로 띄운 앱의 자식 출력은 그러지 않으면 어디에도 안 남는다(`#450`).
    //
    // **여기서 실패해도 daemon 기동 자체는 막지 않는다.** 로그는 진단 수단이지 기동 조건이
    // 아니고, 로그 파일을 못 열었다고 daemon 을 안 띄우면 이 진단 장치가 오히려 사고를
    // 만든다. 못 열면 출력을 버리되 그 사실을 남긴다(사유를 지어내지 않는다, `#368`).
    match std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&paths.log)
    {
        Ok(file) => match file.try_clone() {
            Ok(err_file) => {
                cmd.stdout(Stdio::from(file)).stderr(Stdio::from(err_file));
            }
            Err(e) => {
                log_line(&format!("로그 파일을 복제하지 못해 stderr 를 버린다: {e}"));
                cmd.stdout(Stdio::from(file)).stderr(Stdio::null());
            }
        },
        Err(e) => {
            log_line(&format!(
                "daemon 로그 파일을 열지 못해 출력을 버린다: `{}`: {e}",
                paths.log.display()
            ));
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    cmd
}

/// 기동 난스. daemon 이 pid 레코드에 그대로 적고, 앱이 "내가 방금 띄운 그 daemon 인가"를
/// 이 값으로 가린다(pid 는 OS 가 돌려 쓰므로 그것만으로는 못 가린다).
fn new_nonce() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{now:x}-{:x}", std::process::id())
}

/// 앱 클라이언트 로그의 파일 경로. **`endpoint_paths()` 가 한 번 세운다.**
///
/// 웹뷰가 고르지 못하게 하는 것이 요점이다(모듈 주석의 표) — 그래서 `OnceLock` 이고,
/// 값을 넣는 곳이 경로를 계산하는 그 자리 하나뿐이다.
static CLIENT_LOG: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();

/// 앱이 daemon 을 어떻게 다뤘는지 남긴다. **stderr 와 파일 양쪽에 쓴다.**
///
/// ## 왜 `eprintln!` 만으로는 부족한가 (`#456`)
///
/// **`open` 으로 띄운 앱은 stderr 가 버려진다.** 그리고 그것이 사용자의 실사용 조건이다
/// (Dock·Finder 클릭). 그래서 daemon 이 안 떴을 때 아래 줄들이 전부 사라진다:
///
/// - `"daemon 에 붙지 못했다(띄워 본다)"` — **붙기를 시도했다가 실패한 것**과
///   **애초에 시도조차 안 한 것**을 가르는 유일한 단서다
/// - `"daemon 을 띄웠다: pid …"` / `"daemon 에 붙었다: …"`
///
/// 실측(2026-09-06): 실사용 조건에서 daemon 이 안 뜬 채 145초가 지났는데 **아무 단서도
/// 없었다.** 원인을 가른 것은 daemon 을 손으로 띄워 본 것이었고, 그것은 개발자만 할 수 있다.
///
/// **`eprintln!` 을 지우지 않는다** — 개발 중 터미널 실행에서는 즉시 보이는 쪽이 편하다.
/// 파일은 그 대체가 아니라 추가다.
///
/// ## 실패해도 조용히 넘어간다
///
/// 로그를 못 남기는 것이 앱 기동을 막을 이유는 아니다. 다만 그 사실 자체는 stderr 에
/// 남긴다 — 터미널 실행에서는 보인다.
pub fn log_line(line: &str) {
    eprintln!("[daemon-client] {line}");

    let Some(path) = CLIENT_LOG.get() else { return };
    // **디렉터리를 여기서 만든다.** daemon 기동 경로(`spawn_daemon`)도 만들지만 그것은
    // 이 로그보다 **뒤**다 — 가장 중요한 줄("daemon 에 붙지 못했다(띄워 본다)")이
    // 그 앞에서 나오므로, 여기서 안 만들면 정확히 그 줄이 파일에 안 남는다.
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    use std::io::Write;
    let opened = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path);
    match opened {
        Ok(mut f) => {
            if let Err(e) = writeln!(f, "[daemon-client] {line}") {
                eprintln!("[daemon-client] 로그 파일에 쓰지 못했다: {e}");
            }
        }
        Err(e) => eprintln!("[daemon-client] 로그 파일을 열지 못했다: {e}"),
    }
}

// ---------------------------------------------------------------------------
// 요청 — `spawnRunner`·`killRunner`·`listRunners`
// ---------------------------------------------------------------------------

impl DaemonConnection {
    // ── claude 계정 풀(2026-09-08) ────────────────────────────────────────────
    //
    // **전부 소켓으로 넘기는 일만 한다.** 계정 풀은 로컬 디렉터리이고 로그인은 로컬
    // 프로세스인데 그 실행은 데몬이 한다 — 웹뷰에 프로그램 실행 표면을 열지 않기
    // 위해서다(`runnerShellScope.test.ts` 가 그 회귀선을 들고 있다).
    //
    // 응답을 `Value` 로 그대로 돌려주는 것들이 있다: 계정 목록은 필드가 많고 UI 만 읽으며,
    // Rust 는 그 모양에 대해 아무 판단도 하지 않는다. 여기서 구조체로 받으면 필드가 하나
    // 늘 때마다 Rust 를 고쳐야 하고, 그 고침은 아무것도 지켜 주지 않는다.
    pub fn claude_accounts_list(&self) -> Result<Value, String> {
        self.request("claudeAccountsList", json!({}))
    }

    /// 사용량. **인자가 없다** — 어느 계정을 셀지는 데몬이 디스크를 보고 정한다.
    pub fn claude_accounts_usage(&self) -> Result<Value, String> {
        self.request("claudeAccountsUsage", json!({}))
    }

    pub fn claude_accounts_configure(&self, config: Value) -> Result<Value, String> {
        self.request("claudeAccountsConfigure", config)
    }

    pub fn claude_account_login_start(&self, pool: &str, account: &str) -> Result<Value, String> {
        self.request(
            "claudeAccountLoginStart",
            json!({ "pool": pool, "account": account }),
        )
    }

    pub fn claude_account_login_submit(&self, login_id: &str, code: &str) -> Result<Value, String> {
        // **코드를 로그에 적지 않는다.** `request` 는 payload 를 안 적는다(spawnRunner 가
        // env 에 PAT 를 실어 보내는 것과 같은 이유) — 그 성질에 기댄다.
        self.request(
            "claudeAccountLoginSubmit",
            json!({ "loginId": login_id, "code": code }),
        )
    }

    pub fn claude_account_login_cancel(&self, login_id: &str) -> Result<Value, String> {
        self.request("claudeAccountLoginCancel", json!({ "loginId": login_id }))
    }

    pub fn claude_account_remove(&self, pool: &str, account: &str) -> Result<Value, String> {
        self.request(
            "claudeAccountRemove",
            json!({ "pool": pool, "account": account }),
        )
    }

    pub fn claude_pool_remove(&self, pool: &str) -> Result<Value, String> {
        self.request("claudePoolRemove", json!({ "pool": pool }))
    }

    pub fn claude_account_move(&self, account: &str, to_pool: &str) -> Result<Value, String> {
        self.request(
            "claudeAccountMove",
            json!({ "account": account, "toPool": to_pool }),
        )
    }

    pub fn spawn_runner(
        &self,
        agent_id: &str,
        env: HashMap<String, String>,
    ) -> Result<SpawnRunnerResult, String> {
        let payload = self.request("spawnRunner", json!({ "agentId": agent_id, "env": env }))?;
        serde_json::from_value(payload)
            .map_err(|e| format!("spawnRunner 응답을 해석하지 못했다: {e}"))
    }

    /// **세대를 실어 보낸다.** 실지 않으면 daemon 은 "지금 것"을 죽이는데, 앱이 옛 세대를
    /// 죽이라고 보낸 명령이 그 사이 새로 뜬 러너를 데려갈 수 있다
    /// (`daemonProtocol.ts::KillRunnerParams.incarnationId` 주석).
    pub fn kill_runner(&self, agent_id: &str, incarnation_id: Option<&str>) -> Result<(), String> {
        let mut payload = json!({ "agentId": agent_id });
        if let Some(id) = incarnation_id {
            payload["incarnationId"] = json!(id);
        }
        match self.request("killRunner", payload) {
            Ok(_) => Ok(()),
            // 이미 없는 러너를 죽이라는 것은 결과 상태가 같다 — 재시도가 안전해야 한다
            // (`main.rs::runner_kill` 의 "표에 없으면 성공" 과 같은 논리).
            Err(err) if err.contains("no-such-runner") => Ok(()),
            Err(err) => Err(err),
        }
    }

    pub fn list_runners(&self) -> Result<Value, String> {
        self.request("listRunners", json!({}))
    }
}

// `libc::getpgid` 를 쓰는 회귀선이 있어 unix 로 좁힌다 — `main.rs` 의 테스트 모듈과 같다.
#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// **회귀선 — 낡은 번들이 띄운 daemon 은 물러나게 한다** (2026-09-07).
    ///
    /// 왜 필요한가(실측): 이 기계에서 `--app-version 0.1.6` daemon 이 13:11 부터 살아
    /// 있었고, 앱은 16:50 에 **0.1.26** 으로 새로 떴는데도 그 daemon 에 그냥 붙었다.
    /// daemon 은 `setsid` 로 떠서 앱 종료에도 살아남고(`#431`), 소켓·pid 파일명에는
    /// 프로토콜 버전만 들어가므로(`daemonEndpoint.ts`) 앱 버전은 **정보로만** 적혀 있었다.
    ///
    /// 그 결과가 이날의 forge 장애다: daemon 쪽 결함(`fix(daemon): 러너에게 사용자
    /// 환경을 물려준다`)을 고쳐 릴리스했는데도, 사람이 터미널에서 프로세스를 손으로
    /// 죽이지 않으면 **고친 코드가 실행되지 않았다.** 살아남는 것은 고쳐지지 않는다.
    ///
    /// 판정을 순수 함수로 뽑아 재는 이유: 이 결정의 어려움은 프로세스 조작이 아니라
    /// **"언제 물러나게 해도 되는가"** 이고, 그 경계는 실물 daemon 없이 잴 수 있다.
    #[test]
    fn 낡은_버전이면_물러나게_한다() {
        assert!(should_retire_daemon("0.1.6", "0.1.26"));
        assert!(should_retire_daemon("0.1.26", "0.1.27"));
        assert!(should_retire_daemon("0.1.9", "0.2.0"));
    }

    #[test]
    fn 같거나_새_버전이면_그대로_붙는다() {
        // 같은 버전 — 정상 경로다. 여기서 물러나게 하면 앱을 열 때마다 daemon 이 갈리고,
        // 그 순간 러너가 함께 회수되어 진행 중인 턴이 매번 죽는다.
        assert!(!should_retire_daemon("0.1.27", "0.1.27"));
        // 상대가 더 새것 — 옛 번들이 새 daemon 을 죽이는 경로는 만들지 않는다.
        // 다운그레이드 실행이나 두 빌드가 섞인 상태에서 최신 daemon 을 잃는다.
        assert!(!should_retire_daemon("0.1.28", "0.1.27"));
    }

    #[test]
    fn 버전을_못_읽으면_건드리지_않는다() {
        // 옛 daemon 은 `appVersion` 을 아예 안 적었을 수 있다(`occupied_reason` 이 그
        // 경우를 이미 다룬다). 모르는 것을 낡았다고 단정하지 않는다(`#368`).
        assert!(!should_retire_daemon("", "0.1.27"));
        assert!(!should_retire_daemon("0.1.6", ""));
        // 숫자가 아닌 조각이 섞이면(pre-release 등) 비교를 포기한다 — 순서를 지어내는
        // 것보다 붙는 편이 안전하다.
        assert!(!should_retire_daemon("0.1.27-rc.1", "0.1.27"));
        assert!(!should_retire_daemon("dev", "0.1.27"));
    }

    #[test]
    fn 조각_수가_달라도_숫자로_비교한다() {
        // `0.1.6` vs `0.1.6.1` 같은 조합. 없는 자리는 0 으로 읽는다.
        assert!(should_retire_daemon("0.1", "0.1.1"));
        assert!(!should_retire_daemon("0.1.1", "0.1"));
        assert!(!should_retire_daemon("0.1", "0.1.0"));
    }

    /// **회귀선 — 소켓 경로 길이 상한**(`#431` 2/3 이 밟은 자리).
    ///
    /// `bind` 를 실제로 부르지 않고 잰다. 부르면 재는 것이 "커널이 EINVAL 을 낸다"가 되고,
    /// 그것은 이미 아는 사실이다 — 여기서 재야 할 것은 **우리가 그 원인을 말하는가**다.
    /// `#456`: 앱 클라이언트 로그가 **파일에도** 남는지 잰다.
    ///
    /// `eprintln!` 만 있으면 `open` 으로 띄운 앱에서 전부 사라진다 — 그리고 그것이
    /// 사용자의 실사용 조건이다. **이 테스트가 없으면 누가 파일 쓰기를 지워도
    /// 아무것도 안 깨진다**(로그는 실패해도 조용히 넘어가므로).
    ///
    /// 재는 것은 "`log_line` 이 파일에 쓴다"이지 "무엇을 쓴다"가 아니다 — 문구는 바뀔 수
    /// 있고, 바뀌어도 이 성질은 유지돼야 한다.
    #[test]
    fn 클라이언트_로그가_파일에도_남는다() {
        let dir = std::env::temp_dir().join(format!("mmr-log-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let paths = endpoint_paths(&dir);

        // `CLIENT_LOG` 는 `OnceLock` 이라 프로세스당 한 번만 세워진다. 다른 테스트가
        // 먼저 세웠다면 그 경로를 쓴다 — 어느 쪽이든 **파일에 남는가**를 재면 된다.
        let target = CLIENT_LOG
            .get()
            .cloned()
            .unwrap_or_else(|| paths.dir.join("fallback.log"));
        let before = std::fs::read_to_string(&target).unwrap_or_default();

        log_line("회귀선 표식");

        let after = std::fs::read_to_string(&target).unwrap_or_else(|e| {
            panic!(
                "클라이언트 로그 파일을 읽지 못했다({}): {e}",
                target.display()
            )
        });
        assert!(
            after.len() > before.len() && after.contains("회귀선 표식"),
            "log_line 이 파일에 남기지 않았다 — `{}` 에 표식이 없다",
            target.display()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 소켓_경로가_상한을_넘으면_길이를_사유로_말한다() {
        let long = PathBuf::from(format!("/tmp/{}/daemon-v1.sock", "a".repeat(120)));
        let err = check_socket_path_length(&long).expect_err("상한을 넘었는데 통과했다");
        assert!(
            err.contains("104"),
            "상한 값이 사유에 없다 — 사람이 무엇을 줄여야 하는지 모른다: {err}"
        );
        assert!(
            err.contains(&long.as_os_str().as_encoded_bytes().len().to_string()),
            "실제 길이가 사유에 없다: {err}"
        );
    }

    #[test]
    fn 상한_안의_경로는_통과한다() {
        let ok = PathBuf::from(
            "/Users/alice2/Library/Application Support/app.harkroom.desktop/daemon/daemon-v1.sock",
        );
        assert_eq!(
            ok.as_os_str().as_encoded_bytes().len(),
            82,
            "실측 값이 바뀌었다"
        );
        check_socket_path_length(&ok).expect("82바이트가 막혔다");
    }

    /// 조립 규칙이 `@murmur/shared/daemonEndpoint::daemonEndpointPaths` 와 같아야 한다.
    #[test]
    fn 엔드포인트_경로_조립이_shared_와_같은_규칙이다() {
        let paths = endpoint_paths(Path::new("/tmp/appdata"));
        assert_eq!(paths.dir, PathBuf::from("/tmp/appdata/daemon"));
        assert_eq!(
            paths.socket,
            PathBuf::from("/tmp/appdata/daemon/daemon-v1.sock")
        );
        assert_eq!(
            paths.pid,
            PathBuf::from("/tmp/appdata/daemon/daemon-v1.pid")
        );
        assert_eq!(
            paths.token,
            PathBuf::from("/tmp/appdata/daemon/daemon-v1.token")
        );
        // 로그는 `daemonEndpointPaths` 에 없는 앱 쪽 추가다 — 같은 디렉터리에 둔다.
        assert_eq!(
            paths.log,
            PathBuf::from("/tmp/appdata/daemon/daemon-v1.log")
        );
    }

    // -----------------------------------------------------------------------
    // 개발 구획 회귀선 — 워크트리마다 앱 데이터 뿌리가 갈린다
    //
    // 여기서 재는 것은 **경로 계산**이다. 그 밑의 daemon 이 그 뿌리를 실제로 쓰는지는
    // `packages/daemon` 의 회귀선(`appDataDirFromSocket` 되짚기)과 아래 실물 daemon
    // 회귀선이 잰다.
    // -----------------------------------------------------------------------

    /// 실측 기준의 앱 데이터 디렉터리. 문자열을 그대로 쓰는 이유는 이 파일의 다른
    /// 길이 회귀선(`상한_안의_경로는_통과한다`)과 같은 기준을 쓰기 위해서다.
    const REAL_APP_DATA_DIR: &str = "/Users/alice2/Library/Application Support/app.harkroom.desktop";

    /// 실측(2026-09-07)이 밟은 **두 자리** 그대로다. 이 두 문자열이 이 이슈다:
    /// 앞은 `/Applications` 의 설치본(앱 0.1.6), 뒤는 워크트리에서 `tauri build` 한
    /// 로컬 번들(앱 0.1.7). 둘이 소켓 하나를 공유해 `EXIT_OCCUPIED`(10) 교착이 났다.
    const INSTALLED_EXE: &str = "/Applications/Harkroom.app/Contents/MacOS/harkroom-desktop";
    const LOCAL_BUNDLE_EXE: &str = "/Users/alice2/wt/hamlet/packages/desktop/src-tauri/\
target/release/bundle/macos/Harkroom.app/Contents/MacOS/harkroom-desktop";
    const REAL_HOME: &str = "/Users/alice2";

    /// `exe` 자리에 놓인 빌드. **프로덕션과 같은 `BuildSite` 를 만든다** — 회귀선이
    /// 판정 조각(`is_installed`)을 직접 부르지 않고 조립 자리를 지나게 하려는 것이다.
    fn 자리(exe: &'static str, release: bool) -> BuildSite<'static> {
        BuildSite {
            exe: Some(Path::new(exe)),
            home: Some(Path::new(REAL_HOME)),
            release,
        }
    }

    /// **회귀선 ① — 워크트리가 다르면 경로가 다르다.**
    ///
    /// 이 변경 전에는 두 워크트리가 `app_data_dir()` 하나를 공유했고, 실측(2026-09-06)에서
    /// 한 워크트리의 앱이 다른 워크트리의 daemon 에 그대로 붙었다.
    #[test]
    fn 개발_빌드에서_워크트리가_다르면_뿌리가_다르다() {
        let root = Path::new(REAL_APP_DATA_DIR);

        // ── 두 워크트리의 빌드를 **같은 프로덕션 함수**로 흉내 낸다 ────────────────
        // `dev_partition_source()` 가 컴파일 타임 상수라 한 프로세스 안에서 두 워크트리를
        // 실제로 만들 수는 없다. 그래서 그 상수가 들어가는 자리를 파라미터로 열어 두고
        // (`dev_app_data_root` 주석의 "왜 파라미터로 뺐나"), 두 소스 루트를 각각 넣는다.
        //
        // **경로 조립 전체를 밟는 것이 요점이다.** `dev_partition_name` 만 두 번 부르면
        // 구획을 붙이는 자리를 통째로 지워도 이 회귀선은 초록이다 — 되돌려 RED 절차에서
        // 실제로 그렇게 통과했다(2026-09-06).
        let 알파 = dev_app_data_root(root, "/Users/x/wt/alpha/packages/desktop/src-tauri", None);
        let 베타 = dev_app_data_root(root, "/Users/x/wt/beta/packages/desktop/src-tauri", None);

        assert_ne!(
            알파, 베타,
            "다른 워크트리의 빌드가 같은 뿌리를 얻었다 — 소켓·장부·로그가 그대로 공유된다"
        );
        assert_ne!(endpoint_paths(&알파).socket, endpoint_paths(&베타).socket);

        // 그리고 **둘 다 `app_data_dir` 밖으로 안 나간다** — 구획은 그 밑 한 단계다.
        for r in [&알파, &베타] {
            assert_eq!(r.parent(), Some(root));
        }
    }

    /// **회귀선 ② — 같은 워크트리면 같은 경로다. ①의 대조군이다.**
    ///
    /// 이것이 없으면 ①은 "매번 랜덤한 이름을 준다"로도 통과한다. 그리고 매번 랜덤이면
    /// 앱을 다시 띄울 때마다 새 구획이 생겨 **자기가 앞서 띄운 daemon 에도 못 붙는다** —
    /// 장부의 고아 재발견(`#431` 2-c)이 영영 성립하지 않는다.
    #[test]
    fn 같은_워크트리면_같은_뿌리다_대조군() {
        let base = Path::new(REAL_APP_DATA_DIR);

        // 같은 빌드가 두 번 물으면 같은 답이다.
        assert_eq!(
            app_data_root(base),
            app_data_root(base),
            "같은 빌드가 두 번 물었는데 다른 뿌리를 얻었다"
        );

        // ── 하위 디렉터리에서 띄워도 같아야 한다 ────────────────────────────────
        //
        // **cwd 를 실제로 바꿔 재지 않는다.** `set_current_dir` 은 프로세스 전역이라
        // 이 바이너리의 다른 테스트(실물 daemon 을 띄운다)와 병렬로 돌면 서로를 밟고,
        // 그 실패는 재현이 안 되는 형태로 나온다.
        //
        // 대신 **해시 입력이 이 크레이트의 소스 루트임을 직접 못박는다.**
        // `dev_partition_source` 가 `env!("CARGO_MANIFEST_DIR")` 인 한 프로세스의 cwd 는
        // 이 값에 닿을 수 없다 — 컴파일 타임에 바이너리 안으로 들어간 문자열이기 때문이다.
        //
        // **`cargo test` 는 cwd 가 곧 이 소스 루트라서 "cwd 와 다르다"로는 못 가른다**
        // (구현 중 실측 — 그렇게 쓴 단언이 곧바로 빨개졌다). 그래서 "무엇이 아닌가"가
        // 아니라 **"무엇인가"**를 잰다: 이 값이 소스 루트를 가리키는 한, 어느 하위
        // 디렉터리에서 앱을 띄워도 같은 구획이 나온다.
        let src = dev_partition_source();
        assert!(
            src.ends_with("packages/desktop/src-tauri"),
            "해시 입력이 이 크레이트의 소스 루트가 아니다 — cwd 나 다른 런타임 값으로 \
             바뀌었나: {src}"
        );
        assert!(
            Path::new(src).is_absolute(),
            "해시 입력이 상대 경로다 — 부르는 자리에 따라 달라진다: {src}"
        );

        // 같은 입력은 언제나 같은 이름이다(랜덤이 아니다). 랜덤이면 앱을 다시 띄울 때마다
        // 새 구획이 생겨 **자기가 앞서 띄운 daemon 에도 못 붙는다.**
        let src = "/Users/x/wt/alpha/packages/desktop/src-tauri";
        assert_eq!(dev_partition_name(src), dev_partition_name(src));
    }

    /// **회귀선 ③ — 설치된 앱의 경로는 안 바뀐다.**
    ///
    /// 이 변경이 사용자 환경을 안 건드렸음을 고정한다. 뿌리를 옮기면 이미 설치된 앱의
    /// 장부·설정이 옛 자리에 남아 보이지 않게 된다.
    ///
    /// **`cfg!` 갈래가 사라졌다.** 앞 판본은 `cargo test` 가 debug 로 도는 탓에 릴리즈
    /// 갈래를 실행할 수 없어 단언 자체를 `cfg!` 로 갈랐다(즉 한 판에서 절반만 재고 있었다).
    /// 프로파일이 `BuildSite` 의 필드가 된 지금은 **한 판 안에서 두 프로파일을 다 밟는다.**
    #[test]
    fn 릴리즈_빌드의_뿌리는_안_바뀐다() {
        let base = Path::new(REAL_APP_DATA_DIR);
        let src = "/Users/x/wt/alpha/packages/desktop/src-tauri";

        assert_eq!(
            resolve_app_data_root(base, 자리(INSTALLED_EXE, true), src, None),
            base,
            "릴리즈 빌드가 뿌리를 옮겼다 — 기존 설치의 장부·설정을 잃는다"
        );

        // 그 밖의 자리에는 구획이 붙고, **그 이름이 지워도 되는 것임을 말한다.**
        let got = resolve_app_data_root(base, 자리(LOCAL_BUNDLE_EXE, true), src, None);
        assert_eq!(
            got.parent(),
            Some(base),
            "구획은 앱 데이터 디렉터리 **바로 밑** 한 단계여야 한다 — \
             더 깊어지면 104바이트 예산이 그만큼 준다"
        );
        let name = got.file_name().unwrap().to_string_lossy().into_owned();
        assert!(
            name.starts_with(DEV_DIR_PREFIX),
            "구획 이름이 `{DEV_DIR_PREFIX}` 로 시작해야 사람이 지워도 되는 것을 안다: {name}"
        );
    }

    /// **회귀선 ⑥ — 로컬 릴리즈 번들은 설치본과 뿌리가 갈린다.**
    ///
    /// **이 이슈 자체다.** 실측(2026-09-07): `/Applications/Harkroom.app`(앱 0.1.6)이 소켓을
    /// 쥔 상태에서 워크트리의 `target/release/bundle/…/Harkroom.app`(앱 0.1.7)을 띄웠다.
    /// 둘 다 릴리즈 프로파일이라 옛 축(`cfg!(debug_assertions)`)에서 같은 쪽에 떨어졌고,
    /// 소켓 경로가 같아서 `entryPath` 관문이 붙기를 막은 뒤 우리 daemon 은
    /// `EXIT_OCCUPIED`(10)로 물러났다 — 붙지도 띄우지도 못하는 교착.
    ///
    /// 재는 것이 "구획이 붙는다"가 아니라 **"두 자리의 소켓이 다르다"**인 것이 요점이다.
    /// 교착을 만든 것은 구획의 유무가 아니라 **소켓 하나를 공유한 사실**이다.
    #[test]
    fn 로컬_릴리즈_번들은_설치본과_뿌리가_갈린다() {
        let base = Path::new(REAL_APP_DATA_DIR);
        let src = "/Users/x/wt/hamlet/packages/desktop/src-tauri";

        let 설치본 = resolve_app_data_root(base, 자리(INSTALLED_EXE, true), src, None);
        let 로컬 = resolve_app_data_root(base, 자리(LOCAL_BUNDLE_EXE, true), src, None);

        // **대조군이 먼저다.** 이것이 없으면 아래 단언은 "둘 다 옮겼다"로도 통과한다.
        assert_eq!(
            설치본, base,
            "설치된 앱의 뿌리가 움직였다 — 배포된 사용자의 장부·세션이 옛 자리에 남아 안 보인다"
        );
        assert_ne!(
            로컬, 설치본,
            "로컬 릴리즈 번들이 설치본과 같은 뿌리를 얻었다 — 소켓 하나를 두고 \
             EXIT_OCCUPIED(10) 교착이 난다"
        );
        assert_ne!(
            endpoint_paths(&로컬).socket,
            endpoint_paths(&설치본).socket,
            "뿌리는 갈렸는데 소켓이 같다 — 교착을 만든 것은 그 소켓이다"
        );
    }

    /// **회귀선 ⑦ — 공유 자격은 프로파일과 설치 위치를 *둘 다* 요구한다.**
    ///
    /// 세 갈래를 한자리에서 잰다. 셋 다 "어느 쪽으로 떨어지는가"의 무게가 다른 자리다.
    #[test]
    fn 공유_자격은_릴리즈_프로파일과_설치_위치를_둘_다_요구한다() {
        let base = Path::new(REAL_APP_DATA_DIR);
        let src = "/Users/x/wt/alpha/packages/desktop/src-tauri";

        // ① 사용자별 설치 자리(`~/Applications`)도 설치다.
        const HOME_INSTALLED_EXE: &str =
            "/Users/alice2/Applications/Harkroom.app/Contents/MacOS/harkroom-desktop";
        assert_eq!(
            resolve_app_data_root(base, 자리(HOME_INSTALLED_EXE, true), src, None),
            base,
            "`~/Applications` 설치를 로컬 빌드로 봤다 — 그 사용자는 자기 세션·장부를 잃는다"
        );

        // ② 개발 프로파일은 **어디에 놓여 있어도** 자격이 없다. `/Applications` 에 debug
        //    빌드를 복사해 둔 상태가 정확히 `#515` 가 문제 삼은 사고다(설치한 앱이 개발
        //    중 쌓인 세션·PAT 를 읽었다).
        assert_ne!(
            resolve_app_data_root(base, 자리(INSTALLED_EXE, false), src, None),
            base,
            "`/Applications` 에 놓인 개발 빌드가 공유 뿌리를 얻었다 — `#515` 가 재발한다"
        );

        // ③ 실행 파일을 못 읽었으면 **공유 쪽**이다. 두 오답의 무게가 다르다: 로컬 빌드가
        //    공유 쪽으로 떨어지면 교착이 로그에 남아 진단이 되고, 설치본이 구획 쪽으로
        //    떨어지면 **사람이 원인을 알 수 없다**(데이터가 조용히 사라진 것처럼 보인다).
        let 모름 = BuildSite {
            exe: None,
            home: Some(Path::new(REAL_HOME)),
            release: true,
        };
        assert_eq!(
            resolve_app_data_root(base, 모름, src, None),
            base,
            "실행 파일을 못 읽었다고 설치본의 뿌리를 옮겼다 — 무게가 가벼운 쪽으로 안 떨어졌다"
        );
    }

    /// **회귀선 ④ — 구획을 넣고도 소켓 길이가 상한 안이다.**
    ///
    /// `DEV_HASH_HEX_LEN` 을 늘리는 사람이 예산을 밟으면 여기서 빨개진다. 그 실패는
    /// 실물에서 `EINVAL` 로 나고 그 문자열에는 "길이"라는 말이 없다.
    #[test]
    fn 구획을_넣어도_소켓이_상한_안이다() {
        let root = Path::new(REAL_APP_DATA_DIR).join(dev_partition_name(
            "/Users/x/wt/alpha/packages/desktop/src-tauri",
        ));
        let socket = endpoint_paths(&root).socket;
        let bytes = socket.as_os_str().as_encoded_bytes().len();
        assert_eq!(bytes, 95, "실측 값이 바뀌었다: {}", socket.display());
        check_socket_path_length(&socket).expect("구획을 넣었더니 상한을 넘었다");
        // 릴리즈 82바이트에서 **13바이트**를 갉는다(`dev-` 4 + 해시 8 + `/` 1).
        assert_eq!(bytes - 82, 13);
    }

    /// **회귀선 ⑤ — 장부·로그가 소켓과 **함께** 갈린다.**
    ///
    /// 소켓만 갈리고 장부가 공유되면 갈리기 전보다 나쁘다: 두 daemon 이 각자 뜨는데
    /// 나중에 뜬 쪽이 장부를 통째로 덮어써(`writeRunnerLedger`) 앞선 쪽의 러너를
    /// 영영 못 찾는 고아로 만든다.
    ///
    /// 여기서 재는 것은 **뿌리 밑에 함께 있는가**다. 장부·러너 로그의 실제 경로 계산은
    /// daemon 쪽(`runnerLedgerPath`·`runnerLogPath`)에 있고 그것은 소켓에서 되짚은
    /// `appDataDir` 를 쓴다 — 즉 뿌리가 갈리면 자동으로 함께 갈린다. 그 "자동"이
    /// 성립하려면 **소켓이 뿌리 밑 정확히 두 단계**여야 하고, 그것을 못박는다.
    #[test]
    fn 장부와_로그가_소켓과_함께_갈린다() {
        let root = Path::new(REAL_APP_DATA_DIR).join(dev_partition_name(
            "/Users/x/wt/alpha/packages/desktop/src-tauri",
        ));
        let paths = endpoint_paths(&root);

        // daemon 의 되짚기(`run.ts::appDataDirFromSocket`)와 **같은 규칙**으로 되짚는다.
        // 이 단언이 깨지면 daemon 은 앱이 의도한 것과 다른 자리에 장부·러너 로그를 놓는다.
        let back = paths.socket.parent().and_then(|p| p.parent());
        assert_eq!(
            back,
            Some(root.as_path()),
            "소켓에서 두 단계 위를 되짚었더니 뿌리가 안 나왔다 — \
             daemon 이 장부를 엉뚱한 자리에 놓는다"
        );

        // 뿌리를 공유하는 것 전부가 그 밑에 있다.
        for p in [&paths.socket, &paths.pid, &paths.token, &paths.log] {
            assert!(p.starts_with(&root), "{} 가 구획 밖에 있다", p.display());
        }
        // 앱 클라이언트 로그도 같은 자리다(`#456` 의 오독이 이 파일에서 났다).
        assert_eq!(paths.dir, root.join("daemon"));
    }

    /// **환경변수 탈출구** — 개발 빌드에서 주면 그것이 뿌리가 된다.
    ///
    /// 실제 환경변수를 설정하지 않는다. 프로세스 전역 상태라 병렬 테스트가 서로를 밟고,
    /// 그 실패는 재현이 안 되는 형태로 나온다.
    #[test]
    fn 환경변수가_있으면_그것이_뿌리다() {
        let base = Path::new(REAL_APP_DATA_DIR);
        let got = dev_app_data_root(
            base,
            dev_partition_source(),
            Some("/tmp/mmr-elsewhere".into()),
        );
        assert_eq!(got, PathBuf::from("/tmp/mmr-elsewhere"));
    }

    /// 빈 값은 **안 준 것**이다. `MURMUR_DEV_DATA_DIR=` 로 지운 흔적이 남았을 때
    /// 뿌리가 `""` 가 되어 상대 경로로 떨어지는 것을 막는다.
    #[test]
    fn 빈_환경변수는_안_준_것으로_친다() {
        let base = Path::new(REAL_APP_DATA_DIR);
        assert_eq!(
            dev_app_data_root(base, dev_partition_source(), Some("".into())),
            dev_app_data_root(base, dev_partition_source(), None),
        );
    }

    // -----------------------------------------------------------------------
    // 키체인 서비스 이름 회귀선 — `#515`
    //
    // `#486` 이 뿌리를 갈랐는데 키체인은 안 갈렸다. 여기서 재는 것은 **이름 계산**과
    // 그것이 뿌리와 **같은 출처**에서 나오는가다.
    // -----------------------------------------------------------------------

    /// **회귀선 ① — 개발 빌드의 키체인 이름이 릴리즈와 다르다.**
    ///
    /// 이 변경 전에는 둘이 같은 `app.harkroom.desktop` 이었고, 실측(2026-09-06)에서
    /// 처음 설치한 릴리즈 `.app` 이 개발 중 쌓인 세션·PAT 를 그대로 읽었다.
    ///
    /// **두 "빌드"를 같은 프로덕션 함수로 흉내 낸다** — `dev_partition_name` 조각을
    /// 직접 부르면 조립하는 함수를 통째로 지워도 초록이다(`#486` 실측).
    #[test]
    fn 개발_빌드의_키체인_이름이_릴리즈와_다르다() {
        let 알파 = dev_keychain_service_name(
            KEYCHAIN_SERVICE_RELEASE,
            "/Users/x/wt/alpha/packages/desktop/src-tauri",
        );
        let 베타 = dev_keychain_service_name(
            KEYCHAIN_SERVICE_RELEASE,
            "/Users/x/wt/beta/packages/desktop/src-tauri",
        );

        assert_ne!(
            알파, KEYCHAIN_SERVICE_RELEASE,
            "개발 빌드가 릴리즈와 같은 키체인 이름을 쓴다 — 설치한 앱이 개발 세션·PAT 를 읽는다"
        );
        assert_ne!(
            베타, KEYCHAIN_SERVICE_RELEASE,
            "개발 빌드가 릴리즈와 같은 키체인 이름을 쓴다"
        );
        // 워크트리끼리도 갈린다 — 뿌리가 갈리는 그 단위와 같아야 한다.
        assert_ne!(
            알파, 베타,
            "다른 워크트리의 개발 빌드가 같은 키체인 이름을 얻었다"
        );

        // 릴리즈 이름으로 **시작한다**: 사람이 키체인 접근에서 `app.harkroom.desktop` 을
        // 검색하면 개발 부스러기도 함께 보인다(고아를 사람이 지울 수 있는 근거다 —
        // `keychain_service_name` 주석의 "이미 쌓인 개발 항목").
        assert!(
            알파.starts_with(KEYCHAIN_SERVICE_RELEASE),
            "개발 이름이 릴리즈 이름으로 안 시작한다 — 사람이 한 번에 못 찾는다: {알파}"
        );
        // 그리고 `dev-` 로 이어져 **지워도 되는 것**임을 이름으로 안다.
        assert!(
            알파[KEYCHAIN_SERVICE_RELEASE.len()..].starts_with(&format!(".{DEV_DIR_PREFIX}")),
            "개발 접미사가 `.{DEV_DIR_PREFIX}` 로 안 시작한다: {알파}"
        );
    }

    /// **회귀선 ② — 대조군: 릴리즈 빌드의 이름은 `app.harkroom.desktop` 그대로다.**
    ///
    /// **이것이 없으면 ①은 "둘 다 바뀌었다"로도 통과한다.** 그리고 릴리즈 이름이 바뀌면
    /// 이미 배포된 `v0.1.0`·`v0.1.1` 사용자의 세션 토큰과 러너 PAT 를 앱이 못 읽는다 —
    /// 다음 실행에서 로그인 화면이 뜨고 러너 PAT 는 고아가 된다.
    ///
    /// `릴리즈_빌드의_뿌리는_안_바뀐다` 와 같은 방식으로 **컴파일 타임 갈래 그대로** 잰다:
    /// `cargo test` 는 debug 로 도니 여기서 릴리즈 갈래를 실행할 수 없다. 두 단언 중
    /// 하나는 언제나 실행되고, `cargo test --release` 가 아래쪽을 실제로 밟는다.
    #[test]
    fn 릴리즈_빌드의_키체인_이름은_안_바뀐다() {
        // 상수 자체를 못박는다 — 이 문자열이 배포된 사용자의 키체인에 들어 있는 `svce` 다.
        assert_eq!(
            KEYCHAIN_SERVICE_RELEASE, "app.harkroom.desktop",
            "릴리즈 키체인 서비스 이름이 바뀌었다 — 배포된 v0.1.0·v0.1.1 사용자의 \
             세션과 러너 PAT 를 앱이 못 읽게 된다"
        );

        // **`cfg!` 갈래가 사라졌다** — `릴리즈_빌드의_뿌리는_안_바뀐다` 와 같은 이유다.
        let src = "/Users/x/wt/alpha/packages/desktop/src-tauri";
        assert_eq!(
            resolve_keychain_service_name(KEYCHAIN_SERVICE_RELEASE, 자리(INSTALLED_EXE, true), src),
            KEYCHAIN_SERVICE_RELEASE,
            "설치된 앱이 키체인 이름을 옮겼다 — 배포된 사용자의 세션이 끊긴다"
        );
        assert_ne!(
            resolve_keychain_service_name(
                KEYCHAIN_SERVICE_RELEASE,
                자리(INSTALLED_EXE, false),
                src
            ),
            KEYCHAIN_SERVICE_RELEASE,
            "`/Applications` 에 놓인 개발 빌드가 릴리즈 키체인 이름을 쓴다 — `#515` 다"
        );
    }

    /// **회귀선 ⑤ — 로컬 릴리즈 번들은 설치본과 키체인이 갈린다.**
    ///
    /// 뿌리를 가르면서 키체인을 안 가르면 `#515` 의 "절반만 갈렸다"가 이 축에서 재발한다 —
    /// 로컬 테스트 앱이 **프로덕션 세션 토큰과 러너 PAT** 를 읽고 덮어쓸 수 있다.
    ///
    /// 마지막 단언이 이 회귀선의 핵심이다: 두 곳이 **같은 판정**을 쓰는지를 문자 단위로
    /// 잰다. 누가 한쪽만 고치면(예: 키체인은 `cfg!` 로 되돌리면) 곧바로 빨개진다.
    #[test]
    fn 로컬_릴리즈_번들은_설치본과_키체인이_갈린다() {
        let src = "/Users/x/wt/hamlet/packages/desktop/src-tauri";
        let 설치본 =
            resolve_keychain_service_name(KEYCHAIN_SERVICE_RELEASE, 자리(INSTALLED_EXE, true), src);
        let 로컬 = resolve_keychain_service_name(
            KEYCHAIN_SERVICE_RELEASE,
            자리(LOCAL_BUNDLE_EXE, true),
            src,
        );

        assert_eq!(
            설치본, KEYCHAIN_SERVICE_RELEASE,
            "대조군: 설치본은 릴리즈 이름 그대로다"
        );
        assert_ne!(
            로컬, 설치본,
            "로컬 릴리즈 번들이 설치본과 같은 키체인을 쓴다 — 테스트가 프로덕션 세션 토큰과 \
             러너 PAT 를 읽고 덮어쓸 수 있다"
        );

        // 뿌리와 **같은 구획**이어야 한다 — 두 판정이 갈리면 그것이 `#515` 다.
        let 뿌리_구획 = resolve_app_data_root(
            Path::new(REAL_APP_DATA_DIR),
            자리(LOCAL_BUNDLE_EXE, true),
            src,
            None,
        )
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
        let 키체인_구획 = 로컬
            .strip_prefix(&format!("{KEYCHAIN_SERVICE_RELEASE}."))
            .unwrap_or_else(|| panic!("키체인 이름이 릴리즈 이름 + `.` 꼴이 아니다: {로컬}"));
        assert_eq!(
            키체인_구획, 뿌리_구획,
            "키체인 구획과 뿌리 구획이 다르다 — 두 곳이 각자 판정하고 있다"
        );
    }

    /// **회귀선 ③ — 같은 워크트리면 같은 이름이다. ①의 대조군이다.**
    ///
    /// 이것이 없으면 ①은 "매번 랜덤한 이름을 준다"로도 통과한다. 매번 랜덤이면 앱을
    /// 다시 띄울 때마다 새 서비스 이름이 되어 **개발 중에도 로그인이 안 유지된다** —
    /// 그리고 키체인에 고아가 실행 횟수만큼 쌓인다.
    #[test]
    fn 같은_워크트리면_같은_키체인_이름이다_대조군() {
        // 같은 빌드가 두 번 물으면 같은 답이다.
        assert_eq!(
            keychain_service_name(),
            keychain_service_name(),
            "같은 빌드가 두 번 물었는데 다른 키체인 이름을 얻었다 — 로그인이 안 유지된다"
        );

        // 같은 입력이면 언제나 같다.
        let src = "/Users/x/wt/alpha/packages/desktop/src-tauri";
        assert_eq!(
            dev_keychain_service_name(KEYCHAIN_SERVICE_RELEASE, src),
            dev_keychain_service_name(KEYCHAIN_SERVICE_RELEASE, src),
        );
    }

    /// **회귀선 ④ — 키체인 이름이 데이터 뿌리와 *같은 출처*에서 나온다.**
    ///
    /// 이것이 `#515` 의 핵심이다. `#486` 은 뿌리를 갈랐는데 키체인은 `main.rs` 의 별도
    /// 상수로 갔고, 그래서 절반만 갈렸다. 누가 여기서 해시를 **따로** 만들면(다른 입력,
    /// 다른 길이, 다른 해시 함수) 그 절반이 그대로 재발한다.
    ///
    /// 그래서 재는 것이 "둘 다 갈린다"가 아니라 **"둘의 구획 이름이 문자 단위로 같다"**다.
    #[test]
    fn 키체인_이름이_데이터_뿌리와_같은_구획에서_나온다() {
        let base = Path::new(REAL_APP_DATA_DIR);
        let src = "/Users/x/wt/alpha/packages/desktop/src-tauri";

        // 뿌리 쪽 구획 — `app_data_dir` 밑 마지막 한 단계.
        let 뿌리_구획 = dev_app_data_root(base, src, None)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();

        // 키체인 쪽 구획 — 릴리즈 이름 뒤의 `.` 다음.
        let 이름 = dev_keychain_service_name(KEYCHAIN_SERVICE_RELEASE, src);
        let 키체인_구획 = 이름
            .strip_prefix(&format!("{KEYCHAIN_SERVICE_RELEASE}."))
            .unwrap_or_else(|| panic!("개발 키체인 이름이 릴리즈 이름 + `.` 꼴이 아니다: {이름}"));

        assert_eq!(
            키체인_구획, 뿌리_구획,
            "키체인 이름의 구획이 데이터 뿌리의 구획과 다르다 — 두 곳이 각자 해시를 \
             만들고 있다. `#515` 가 바로 그 어긋남이었다(`#486` 이 뿌리만 갈랐다)"
        );
    }

    /// **릴리즈 바이너리는 환경변수를 아예 안 읽는다.**
    ///
    /// `app_data_root` 가 `cfg!(debug_assertions)` 에서 곧바로 돌아가므로 릴리즈에서는
    /// `dev_app_data_root` 에 닿는 경로가 없다. 그 성질을 릴리즈 빌드에서 직접 잰다 —
    /// debug 에서는 재려 해도 잴 것이 없으므로 갈래를 나눈다.
    #[test]
    fn 릴리즈에서는_환경변수가_안_듣는다() {
        if cfg!(debug_assertions) {
            return; // 개발 빌드다 — `릴리즈_빌드의_뿌리는_안_바뀐다` 가 그쪽을 잰다.
        }
        let base = Path::new(REAL_APP_DATA_DIR);
        // **`base` 와 비교하지 않는다.** 이 테스트 바이너리는 `/Applications` 밖에 있어
        // 릴리즈 프로파일에서도 구획이 붙는다(그것이 맞는 동작이다). 재는 것은 뿌리의
        // 절대 위치가 아니라 **환경변수가 그 값을 움직이지 못한다**는 성질이다.
        let 심기_전 = app_data_root(base);
        std::env::set_var(DEV_DATA_DIR_ENV, "/tmp/mmr-should-be-ignored");
        let got = app_data_root(base);
        std::env::remove_var(DEV_DATA_DIR_ENV);
        assert_eq!(got, 심기_전, "릴리즈가 환경변수로 데이터 위치를 옮겼다");
        assert_ne!(
            got,
            Path::new("/tmp/mmr-should-be-ignored"),
            "릴리즈가 환경변수 값을 그대로 뿌리로 썼다 — `dev_data_dir_override` 게이트가 뚫렸다"
        );
    }

    // -----------------------------------------------------------------------
    // 실물 daemon 회귀선 — **진짜 사이드카를 띄운다**
    //
    // 여기 있는 성질들은 목으로는 못 잰다. "이미 있으면 새로 안 띄운다"를 목으로 재면
    // 재는 것이 "내가 짠 분기가 내가 짠 대로 돈다"가 되고, 정작 daemon 이 소켓을 언제
    // 올리는지·토큰이 언제 쓰이는지는 하나도 안 걸린다.
    //
    // 사이드카가 없으면(=`build:sidecar` 전) **실패 대신 건너뛴다** — `main.rs` 의
    // `사이드카_실행_위치에서_node_pty_가_해석된다` 와 같은 방식이다.
    // -----------------------------------------------------------------------

    fn daemon_sidecar() -> Option<PathBuf> {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("debug");
        let p = dir.join(DAEMON_SIDECAR_NAME);
        if p.is_file() {
            Some(p)
        } else {
            None
        }
    }

    /// 짧은 임시 앱 데이터 디렉터리. **`/tmp` 밑에 짧게 만든다** — 워크트리 경로에
    /// 만들면 소켓 경로가 104바이트를 넘어 `bind` 가 `EINVAL` 로 죽는다(2/3 이 그것을
    /// 실제로 밟았다, 위 `SOCKET_PATH_MAX` 주석).
    fn temp_app_data_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mmr-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("임시 디렉터리를 못 만들었다");
        dir
    }

    /// 테스트가 띄운 daemon 과 임시 디렉터리를 **반드시** 거둔다.
    ///
    /// ## 왜 `Drop` 인가 — 실측으로 배웠다 (2026-09-06)
    ///
    /// 처음에는 테스트 끝에 `child.kill()` 을 적어 뒀다. 그런데 **되돌려 RED 절차에서
    /// 테스트가 패닉하면 그 줄에 닿지 못한다** — 실제로 그렇게 daemon 둘이 `ppid=1` 로
    /// 남았고, 다른 세션이 그것을 발견했다. daemon 은 `setsid` 로 떠 있으니(그것이 이
    /// 기능의 핵이다) 테스트 프로세스가 죽어도 함께 죽지 않는다.
    ///
    /// **즉 이 기능을 재는 테스트는 구조적으로 고아를 남긴다.** `Drop` 은 패닉 언와인딩
    /// 중에도 불리므로 그 경로를 막는 유일한 자리다.
    struct DaemonGuard {
        child: std::process::Child,
        dir: PathBuf,
    }

    impl Drop for DaemonGuard {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    /// daemon 을 띄운다. **`spawn_daemon` 과 같은 `daemon_command()` 를 쓴다** —
    /// 여기서 커맨드를 다시 조립하면 재는 대상과 도는 대상이 갈리고, 그러면
    /// `detached_command` 를 빼도 이 테스트가 초록으로 통과한다(그 함수 주석 참고).
    /// `AppHandle` 이 필요한 것은 프로그램 경로와 앱 버전뿐이라 그 둘만 여기서 준다.
    fn launch_daemon(program: &Path, paths: &EndpointPaths, nonce: &str) -> std::process::Child {
        // `"test"` 는 **숫자가 아니라** `should_retire_daemon` 이 비교를 포기한다 — 그래서
        // 기존 회귀선들은 버전 판정에 걸리지 않고 붙기·띄우기만 잰다. 판정을 재는 쪽은
        // 아래 `launch_daemon_versioned` 로 버전을 명시한다.
        launch_daemon_versioned(program, paths, nonce, "test")
    }

    fn launch_daemon_versioned(
        program: &Path,
        paths: &EndpointPaths,
        nonce: &str,
        app_version: &str,
    ) -> std::process::Child {
        daemon_command(program, paths, nonce, app_version)
            .spawn()
            .expect("daemon 을 못 띄웠다")
    }

    fn wait_for_endpoint(paths: &EndpointPaths) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            if paths.socket.exists() && paths.token.exists() && paths.pid.exists() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// **회귀선 — 낡은 번들이 띄운 daemon 은 갈린다** (2026-09-07, 배선).
    ///
    /// 판정 자체는 `낡은_버전이면_물러나게_한다` 가 순수 함수로 재고, 여기서는 그 판정이
    /// **실제로 서는가**를 진짜 daemon 으로 잰다: 낡은 버전으로 띄운 daemon 이 도는 중에
    /// `ensure_at` 을 부르면 붙지 않고 **물러나게 한 뒤 우리 것을 띄운다.**
    ///
    /// 이 배선이 없으면(=`should_retire_daemon` 가지를 지우면) `EnsureKind::Attached` 가
    /// 되어 이 단언이 빨개진다. 그것이 2026-09-07 의 상태였다: `--app-version 0.1.6`
    /// daemon 에 0.1.26 앱이 붙어, 고쳐 릴리스한 daemon 코드가 실행되지 않았다.
    #[test]
    fn 낡은_버전의_daemon_은_갈린다() {
        let Some(program) = daemon_sidecar() else {
            eprintln!("건너뜀: daemon 사이드카가 없다 — `pnpm --filter @murmur/desktop build:sidecar` 먼저");
            return;
        };
        let dir = temp_app_data_dir("stale-version");
        let paths = endpoint_paths(&dir);
        std::fs::create_dir_all(&paths.dir).unwrap();

        // 낡은 세대. `0.0.1` 은 어떤 실제 버전보다 낮다.
        //
        // **가드로 감싸는 것이 필수다.** 이 파일이 이미 배운 교훈이다(`DaemonGuard` 주석,
        // 2026-09-06): 되돌려 RED 절차에서 아래 단언이 패닉하면 `wait()` 줄에 닿지 못하고,
        // daemon 은 `setsid` 로 떠 있어 테스트 프로세스와 함께 죽지 않는다 — 실제로 이
        // 테스트를 처음 쓸 때 `0.0.1` daemon 하나를 그렇게 남겼다(pid 79993).
        //
        // 물러나게 하는 데 성공하면 이 가드의 `kill` 은 이미 죽은 자식에게 가고 조용히
        // 실패한다 — 그것이 맞는 동작이다.
        let 낡은 = launch_daemon_versioned(&program, &paths, "nonce-stale", "0.0.1");
        let 낡은_pid = 낡은.id();
        let _낡은_가드 = DaemonGuard {
            child: 낡은,
            dir: dir.clone(),
        };
        assert!(wait_for_endpoint(&paths), "낡은 daemon 이 엔드포인트를 올리지 않았다");

        let child = std::sync::Mutex::new(None::<std::process::Child>);
        let outcome = ensure_at(
            &paths,
            &program,
            |_| {},
            || {
                *child.lock().unwrap() = Some(launch_daemon(&program, &paths, "nonce-fresh"));
                Ok(DaemonExitWatch::alive())
            },
        );
        let _guard = child.lock().unwrap().take().map(|c| DaemonGuard {
            child: c,
            dir: dir.clone(),
        });

        let (conn, kind) = outcome.expect("낡은 daemon 을 갈고도 못 붙었다");
        assert_eq!(kind, EnsureKind::Spawned, "낡은 daemon 에 그냥 붙었다");
        assert!(
            conn.daemon_pid > 0 && conn.daemon_pid != 낡은_pid,
            "새 daemon 이 아니라 낡은 것(pid {낡은_pid})에 붙어 있다"
        );
    }

    /// **회귀선 2 — daemon 이 이미 있으면 새로 안 띄운다.**
    ///
    /// 붙기를 먼저 시도하는 것이 `ensure_daemon` 의 첫 단계이고, 이 테스트는 그 단계가
    /// 실제로 **선다**는 것을 진짜 소켓으로 잰다: 이미 도는 daemon 에 붙어 `ping` 이
    /// 오가고, 그 pid 가 처음 띄운 그 pid 다.
    ///
    /// 되돌려 RED: `ensure_daemon` 의 "1. 붙어 본다" 블록을 지우면 두 번째 daemon 이 뜨고
    /// 그것은 `EXIT_OCCUPIED`(10)로 물러난다 — 즉 붙는 데 실패하거나(소켓은 첫 daemon 것)
    /// 아무 daemon 에도 못 붙는다.
    #[test]
    fn 이미_있는_daemon_에는_붙고_새로_띄우지_않는다() {
        let Some(program) = daemon_sidecar() else {
            eprintln!("건너뜀: daemon 사이드카가 없다 — `pnpm --filter @murmur/desktop build:sidecar` 먼저");
            return;
        };
        let dir = temp_app_data_dir("attach");
        let paths = endpoint_paths(&dir);
        std::fs::create_dir_all(&paths.dir).unwrap();
        // 이 경로 자체가 상한 안이어야 테스트가 성립한다 — 아니면 아래 실패가 길이 탓인지
        // 로직 탓인지 못 가린다.
        check_socket_path_length(&paths.socket).expect("임시 소켓 경로가 이미 상한을 넘는다");

        // **가드가 먼저다** — 아래 어느 단언이 패닉해도 이 daemon 은 거둬진다.
        let _guard = DaemonGuard {
            child: launch_daemon(&program, &paths, "nonce-1"),
            dir: dir.clone(),
        };
        assert!(
            wait_for_endpoint(&paths),
            "daemon 이 엔드포인트를 올리지 않았다"
        );

        let record = read_pid_record(&paths.pid).expect("pid 레코드를 못 읽었다");
        let first_pid = record.pid;

        // **`ensure_at` 을 부른다** — 프로덕션이 도는 그 판단이다. 여기서
        // `DaemonConnection::connect` 를 직접 부르면 "붙어 본다" 분기를 우회하게 되고,
        // 그 분기를 통째로 지워도 테스트가 초록이다(그 함수 주석의 근거).
        let launched = std::sync::atomic::AtomicBool::new(false);
        let (conn, kind) = ensure_at(
            &paths,
            &program,
            |_| {},
            || {
                launched.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(DaemonExitWatch::alive())
            },
        )
        .expect("붙지 못했다");

        assert_eq!(
            kind,
            EnsureKind::Attached,
            "이미 서비스 중인 daemon 이 있는데 `Attached` 가 아니다"
        );
        assert!(
            !launched.load(std::sync::atomic::Ordering::SeqCst),
            "이미 daemon 이 도는데 띄우는 자리가 불렸다 — 두 번째 daemon 이 뜬다"
        );
        assert_eq!(
            conn.daemon_pid, first_pid,
            "붙은 daemon 의 pid 가 처음 띄운 것과 다르다 — 새로 띄운 것이다"
        );
        // 실제로 말이 오가는지도 본다. 붙기만 하고 인증이 안 됐으면 여기서 걸린다.
        conn.request("ping", json!({})).expect("ping 이 안 돌았다");

        // 두 번째 daemon 을 같은 엔드포인트로 띄우면 **점유로 물러난다**(코드 10).
        let second = launch_daemon(&program, &paths, "nonce-2")
            .wait()
            .expect("두 번째 daemon 을 기다리지 못했다");
        assert_eq!(
            second.code(),
            Some(10),
            "이미 서비스 중인데 두 번째 daemon 이 물러나지 않았다 — 소유권이 갈린다"
        );
        // 그리고 첫 daemon 은 그대로 살아 있다.
        assert!(read_pid_record(&paths.pid).map(|r| r.pid) == Some(first_pid));
        // 정리는 `_guard` 의 `Drop` 이 한다 — 패닉해도 불린다.
    }

    /// **회귀선 2 의 반대편 — 없으면 띄운다.**
    ///
    /// "붙기를 먼저 시도한다"가 "없을 때도 안 띄운다"로 잘못 굳는 것을 막는다. 앞 테스트만
    /// 있으면 `ensure_at` 이 항상 `Attached` 를 돌려주게 만들어도 초록이다.
    #[test]
    fn daemon_이_없으면_띄우고_그_daemon_에_붙는다() {
        let Some(program) = daemon_sidecar() else {
            eprintln!("건너뜀: daemon 사이드카가 없다 — `pnpm --filter @murmur/desktop build:sidecar` 먼저");
            return;
        };
        let dir = temp_app_data_dir("spawn");
        let paths = endpoint_paths(&dir);
        std::fs::create_dir_all(&paths.dir).unwrap();
        assert!(!paths.socket.exists(), "빈 디렉터리에 소켓이 이미 있다");

        // 띄우는 자리는 프로덕션과 같은 `daemon_command()` 를 쓴다.
        let child = std::sync::Mutex::new(None::<std::process::Child>);
        let outcome = ensure_at(
            &paths,
            &program,
            |_| {},
            || {
                *child.lock().unwrap() = Some(launch_daemon(&program, &paths, "nonce-spawn"));
                Ok(DaemonExitWatch::alive())
            },
        );
        // **단언보다 먼저 가드로 감싼다** — `ensure_at` 이 성공했든 아니든 띄운 daemon 은
        // 이미 있고, 아래 단언이 패닉하면 그것을 거둘 자리가 여기밖에 없다.
        let _guard = child.lock().unwrap().take().map(|c| DaemonGuard {
            child: c,
            dir: dir.clone(),
        });

        let (conn, kind) = outcome.expect("daemon 을 띄우고도 못 붙었다");
        assert_eq!(kind, EnsureKind::Spawned, "없는데 붙었다고 한다");
        assert!(conn.daemon_pid > 0, "붙은 daemon 의 pid 를 못 읽었다");
        conn.request("ping", json!({})).expect("ping 이 안 돌았다");
    }

    /// **회귀선 5 — exit 이벤트가 앱까지 온다** (`#431` 2단계 A 가 밟을 뻔한 자리).
    ///
    /// ## 이 테스트가 없으면 무엇이 조용히 깨지나
    ///
    /// 읽기 스레드는 **연결당 한 번만** 뜨고(`open_connection` → `start_reader`), 연결은
    /// `DaemonState` 에 캐시된다. 즉 **`ensure_daemon` 을 먼저 부른 쪽의 콜백이 이긴다.**
    ///
    /// 앞 판본에서는 그 승부가 우연히 맞았다 — `daemon_spawn_runner`(emitter 를 넘긴다)가
    /// 언제나 첫 호출자였기 때문이다. **2단계 A 가 그 순서를 뒤집는다**: 앱 기동 직후
    /// `daemon_list_runners` 가 먼저 붙는데, 그쪽은 `|_| {}` 를 넘기고 있었다. 그러면
    /// 빈 콜백이 자리를 잡고 exit 통지가 **영영 앱에 안 온다** — 죽은 러너가 화면에 계속
    /// `running` 으로 남고 `#419`·`#473` 의 판정이 전부 굶는다.
    ///
    /// 고친 방법은 콜백을 파라미터에서 없앤 것이다(`ensure_daemon` 주석). 이 테스트는
    /// 그 성질을 **실물 daemon 과 실물 러너로** 잰다: `ensure_at` 이 세운 콜백 하나가
    /// spawn → exit 을 끝까지 실어 나르는가.
    ///
    /// ## 왜 `listRunners` 를 먼저 부르나
    ///
    /// 그것이 2단계 A 의 실제 순서이기 때문이다. 콜백을 다시 파라미터로 되돌리고
    /// 목록 조회에 `|_| {}` 를 넘기면 이 테스트가 빨개진다 — 그것이 되돌려 RED 다.
    #[test]
    fn exit_이벤트가_목록조회를_먼저_해도_앱에_온다() {
        let Some(program) = daemon_sidecar() else {
            eprintln!("건너뜀: daemon 사이드카가 없다 — `pnpm --filter @murmur/desktop build:sidecar` 먼저");
            return;
        };
        let dir = temp_app_data_dir("exit-event");
        let paths = endpoint_paths(&dir);
        std::fs::create_dir_all(&paths.dir).unwrap();

        let _guard = DaemonGuard {
            child: launch_daemon(&program, &paths, "nonce-exit"),
            dir: dir.clone(),
        };
        assert!(
            wait_for_endpoint(&paths),
            "daemon 이 엔드포인트를 올리지 않았다"
        );

        // **콜백은 여기서 한 번 세워진다** — 프로덕션의 `runner_exit_emitter` 자리다.
        let seen: Arc<Mutex<Vec<RunnerExitEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let (conn, _) = ensure_at(
            &paths,
            &program,
            // 콜백이 `(name, payload)` 로 일반화됐다(이벤트가 둘이 됐다) — 이 테스트는
            // 러너 exit 만 보므로 그 이름만 걸러 옛 단언을 그대로 유지한다.
            move |name, payload| {
                if name != "runnerExit" {
                    return;
                }
                if let Ok(ev) = serde_json::from_value::<RunnerExitEvent>(payload) {
                    if let Ok(mut v) = sink.lock() {
                        v.push(ev);
                    }
                }
            },
            || Err("띄우면 안 된다 — 이미 있다".to_string()),
        )
        .expect("daemon 에 붙지 못했다");

        // **2단계 A 의 순서를 그대로 밟는다**: 목록 조회가 먼저다.
        conn.list_runners().expect("listRunners 가 안 돌았다");

        // 그 다음 러너를 띄운다. PAT·URL 은 아무 값이어도 된다 — 이 테스트가 재는 것은
        // 러너가 무엇을 하는가가 아니라 **그 종료가 여기까지 오는가**다. 자격증명이
        // 틀렸으니 러너는 곧 스스로 물러나고, 그 종료가 곧 우리가 기다리는 이벤트다.
        let mut env = HashMap::new();
        env.insert("MURMUR_PAT".to_string(), "murp_회귀선".to_string());
        env.insert(
            "MURMUR_URL".to_string(),
            "http://127.0.0.1:1/".to_string(), // 아무도 안 듣는 포트 — 러너가 빨리 물러난다
        );
        env.insert(
            "PATH".to_string(),
            "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string(),
        );
        let spawned = match conn.spawn_runner("regress-exit", env) {
            Ok(s) => s,
            Err(err) => {
                // 러너 사이드카가 없으면 daemon 이 띄우지 못한다 — 이 기계의 배치 문제이지
                // 이 회귀선이 재는 성질이 아니다. **초록으로 위장하지 않고 건너뛴다.**
                eprintln!("건너뜀: daemon 이 러너를 띄우지 못했다 — {err}");
                return;
            }
        };

        // 러너가 물러날 때까지 기다린다. 고정 `sleep` 이 아니라 폴링이다 — 기기마다 다르다.
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            if seen.lock().map(|v| !v.is_empty()).unwrap_or(false) {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }

        let events = seen.lock().expect("이벤트 락이 깨졌다");
        assert!(
            !events.is_empty(),
            "러너가 끝났는데 exit 이벤트가 콜백에 오지 않았다 — \
             목록 조회가 먼저 붙으면서 빈 콜백이 자리를 잡은 그 회귀다"
        );
        assert_eq!(
            events[0].agent_id, "regress-exit",
            "다른 러너의 exit 이 왔다"
        );
        assert_eq!(
            events[0].incarnation_id, spawned.incarnation_id,
            "exit 이벤트의 세대가 spawn 이 돌려준 것과 다르다 — `#419` 의 판정이 굶는다"
        );
    }

    /// **회귀선 6 — 다른 빌드의 daemon 에는 붙지 않는다.**
    ///
    /// ## 무엇을 재는가
    ///
    /// 소켓·토큰·pid 는 **번들 식별자**로 정해지는 한 자리를 모든 워크트리가 공유한다
    /// (`same_entry_path` 주석). 실측(2026-09-06): 릴리즈 앱이 다른 워크트리의 debug
    /// daemon(pid 35721)에 그대로 붙었고, 토큰도 같은 파일이라 인증이 자동으로 통과했다.
    ///
    /// 그 daemon 은 **자기 옆에서** 러너를 찾는다(`daemon/src/run.ts::defaultRunnerCommand`).
    /// 즉 붙는 순간 이 앱의 러너가 아니라 그쪽 빌드의 러너가 뜬다.
    ///
    /// ## 실물 daemon 을 띄운다 — 그것이 요점이다
    ///
    /// pid 파일만 손으로 써 두고 재면 "붙지 않는다"가 **소켓이 없어서**인지 판정 때문인지
    /// 못 가린다. 그래서 진짜 daemon 을 띄워 진짜 소켓이 서비스 중인 상태를 만들고,
    /// 그 상태에서 `my_entry` 만 남의 경로로 준다.
    ///
    /// 되돌려 RED: `ensure_at` 의 `same_entry_path` 관문을 지우면 붙어 버려서 빨개진다.
    #[test]
    fn 다른_entry_path_의_daemon_에는_붙지_않는다() {
        let Some(program) = daemon_sidecar() else {
            eprintln!("건너뜀: daemon 사이드카가 없다 — `pnpm --filter @murmur/desktop build:sidecar` 먼저");
            return;
        };
        let dir = temp_app_data_dir("entry-mismatch");
        let paths = endpoint_paths(&dir);
        std::fs::create_dir_all(&paths.dir).unwrap();

        let guard = DaemonGuard {
            child: launch_daemon(&program, &paths, "nonce-entry"),
            dir: dir.clone(),
        };
        assert!(
            wait_for_endpoint(&paths),
            "daemon 이 엔드포인트를 올리지 않았다"
        );
        let their_pid = guard.child.id();

        // **내 빌드의 daemon 은 다른 자리에 있다고 말한다** — 다른 워크트리의 체크아웃이
        // 이 자리에 오는 그 상황이다. 파일이 실재하지 않아도 된다: 판정은 경로 비교이고,
        // `canonicalize` 실패는 원문 비교로 떨어진다(`same_entry_path` 주석).
        let my_entry = dir.join("other-build").join(DAEMON_SIDECAR_NAME);

        // 붙지 못하면 그 다음은 "띄운다"인데, 여기서는 띄우지 않고 **불렸는지만** 센다 —
        // 살아 있는 남의 daemon 을 건드리지 않는 것이 이 회귀선의 절반이다.
        let launched = std::sync::atomic::AtomicBool::new(false);
        let outcome = ensure_at(
            &paths,
            &my_entry,
            |_| {},
            || {
                launched.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(DaemonExitWatch::alive())
            },
        );

        assert!(
            launched.load(std::sync::atomic::Ordering::SeqCst),
            "남의 빌드 daemon 에 그대로 붙었다 — 띄우는 자리에 닿지도 않았다"
        );
        assert!(
            outcome.is_err(),
            "남의 daemon 이 소켓을 쥐고 있는데 붙었다고 한다"
        );

        // **회귀선 8 — 강탈하지 않는다.** 안 붙었다고 남의 daemon 을 죽이거나 소켓을
        // 날리지 않는다. 그쪽은 그대로 살아 있어야 한다.
        assert_eq!(
            read_pid_record(&paths.pid).map(|r| r.pid),
            Some(their_pid),
            "안 붙은 뒤 남의 daemon 의 pid 레코드가 사라지거나 바뀌었다 — 강탈했다"
        );
        assert_eq!(
            unsafe { libc::kill(their_pid as libc::pid_t, 0) },
            0,
            "안 붙은 뒤 남의 daemon 이 죽었다 — 살아 있는 daemon 을 죽이는 경로가 생겼다"
        );
        assert!(paths.socket.exists(), "남의 소켓 파일을 지웠다");
    }

    /// **회귀선 7 — 대조군: 같은 `entryPath` 면 붙는다.**
    ///
    /// **이것이 없으면 회귀선 6 은 무의미하다.** `same_entry_path` 가 언제나 `false` 를
    /// 돌려줘도 6은 초록이기 때문이다 — "아무것도 안 붙는다"로도 통과한다.
    ///
    /// 위 `이미_있는_daemon_에는_붙고_새로_띄우지_않는다` 와 겹쳐 보이지만 **재는 것이
    /// 다르다**: 그쪽은 "붙기를 먼저 시도한다"를, 이쪽은 "경로 관문이 내 것을 막지
    /// 않는다"를 잰다. 관문을 `false` 로 고정하면 이쪽만 빨개진다.
    #[test]
    fn 같은_entry_path_의_daemon_에는_붙는다() {
        let Some(program) = daemon_sidecar() else {
            eprintln!("건너뜀: daemon 사이드카가 없다 — `pnpm --filter @murmur/desktop build:sidecar` 먼저");
            return;
        };
        let dir = temp_app_data_dir("entry-match");
        let paths = endpoint_paths(&dir);
        std::fs::create_dir_all(&paths.dir).unwrap();

        let _guard = DaemonGuard {
            child: launch_daemon(&program, &paths, "nonce-match"),
            dir: dir.clone(),
        };
        assert!(
            wait_for_endpoint(&paths),
            "daemon 이 엔드포인트를 올리지 않았다"
        );

        let launched = std::sync::atomic::AtomicBool::new(false);
        let (conn, kind) = ensure_at(
            &paths,
            &program,
            |_| {},
            || {
                launched.store(true, std::sync::atomic::Ordering::SeqCst);
                Ok(DaemonExitWatch::alive())
            },
        )
        .expect("내 빌드의 daemon 인데 붙지 못했다");

        assert_eq!(kind, EnsureKind::Attached, "같은 빌드인데 안 붙었다");
        assert!(
            !launched.load(std::sync::atomic::Ordering::SeqCst),
            "같은 빌드의 daemon 이 도는데 새로 띄웠다"
        );
        conn.request("ping", json!({})).expect("ping 이 안 돌았다");
    }

    /// 경로 판정 자체의 성질 — 프로세스 없이 잰다.
    ///
    /// **빈 문자열이 `false` 인 것이 의도다.** 옛 daemon 은 `entryPath` 를 안 적을 수 있고,
    /// 그때 "같다고 단정"하면 이 관문이 옛 daemon 앞에서 통째로 열린다.
    #[test]
    fn entry_path_비교는_모르는_것을_다른_것으로_다룬다() {
        let mine = Path::new("/tmp/mmr-a/harkroom-daemon");
        assert!(!same_entry_path("", mine), "빈 entryPath 를 같다고 했다");
        assert!(
            !same_entry_path("/tmp/mmr-b/harkroom-daemon", mine),
            "다른 경로를 같다고 했다"
        );
        assert!(
            same_entry_path("/tmp/mmr-a/harkroom-daemon", mine),
            "같은 경로를 다르다고 했다"
        );
        // `.` 성분이 낀 표기도 같은 파일이다 — 정규화가 그것을 흡수한다.
        assert!(
            same_entry_path("/tmp/mmr-a/./harkroom-daemon", mine),
            "정규화 전 표기가 다르다고 갈렸다"
        );
    }

    /// **`#476` 회귀선 — `node` 가 없을 때 화면이 무슨 일인지 말한다.**
    ///
    /// 앞 판본은 `daemon 을 띄우지 못했다: No such file or directory (os error 2)` 였고,
    /// 그 문구를 받은 사람은 사이드카를 찾으러 갔다. **사이드카는 거기 있다** — 바로 위
    /// `is_file()` 검사가 이미 통과했기 때문이다. 없는 것은 셔뱅이 가리키는 `node` 이고,
    /// murmur 는 그것을 동봉하지 않는다(2026-09-06 방침).
    ///
    /// 되돌려 RED: `spawn_failure_reason` 의 `NotFound` 분기를 지우면 설치 주소가 사라져
    /// 빨개진다.
    #[test]
    fn node_가_없으면_어디서_받는지까지_말한다() {
        let e = std::io::Error::new(std::io::ErrorKind::NotFound, "os error 2");
        let msg = spawn_failure_reason(Path::new("/A/harkroom-daemon"), &e);
        assert!(msg.contains("node"), "무엇이 없는지 말해야 한다: {msg}");
        assert!(
            msg.contains("https://nodejs.org/en/download"),
            "**어디서 받는지**가 이 이슈의 답이다: {msg}"
        );
        // 원문을 삼키지 않는다 — 판정이 틀렸을 때 사람이 알아볼 수 있어야 한다(`#368`).
        assert!(msg.contains("os error 2"), "원문이 남아 있어야 한다: {msg}");
    }

    /// **대조군 — 다른 사유는 다른 문구다(`#476`).**
    ///
    /// 없으면 위 회귀선은 "모든 spawn 실패에 Node 설치를 권하는" 구현으로도 통과한다.
    /// 권한 오류인 사람이 Node 를 다시 설치하러 가는 것은 `#473` 이 고친 결함과 같은
    /// 종류다 — 사유가 다르면 사람이 할 일도 다르다.
    #[test]
    fn enoent_가_아닌_실패에는_node_이야기를_붙이지_않는다() {
        let e = std::io::Error::new(std::io::ErrorKind::PermissionDenied, "denied");
        let msg = spawn_failure_reason(Path::new("/A/harkroom-daemon"), &e);
        assert!(!msg.contains("nodejs.org"), "지어내지 않는다: {msg}");
        assert!(msg.contains("denied"), "원문은 그대로 올린다: {msg}");
    }

    // -----------------------------------------------------------------------
    // `#513` — daemon 이 `node` 를 못 찾은 사유가 화면에 온다
    // -----------------------------------------------------------------------

    /// **회귀선 1 — `spawn_daemon` 이 `PATH` 를 env 로 넘긴다**(`#513`).
    ///
    /// 이것이 이 이슈의 한 줄이다. 빠지면 Finder 로 띄운 앱의 daemon 이
    /// `/usr/bin:/bin:/usr/sbin:/sbin` 만 들고 뜨고, 셔뱅의 `node` 를 못 찾아
    /// **모든 에이전트가** 기동에 실패한다(실측 2026-09-06).
    ///
    /// `daemon_command()` 가 조립한 실물 `Command` 를 잰다 — 커맨드를 손으로 다시
    /// 조립하면 프로덕션 코드를 걷어내도 초록이 된다(이 파일이 반복해서 겪은 실패
    /// 모드이고, `daemon_command` 를 떼어낸 이유가 그것이다).
    ///
    /// 되돌려 RED: `daemon_command` 의 `cmd.env("PATH", …)` 한 줄을 지우면 빨개진다.
    #[test]
    fn daemon_커맨드가_path_를_env_로_넘긴다() {
        let dir = std::env::temp_dir().join(format!("mmr-env-{}", std::process::id()));
        let paths = endpoint_paths(&dir);
        let cmd = daemon_command(Path::new("/A/harkroom-daemon"), &paths, "n", "0.0.0");

        let path = cmd
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("PATH"))
            .and_then(|(_, v)| v)
            .expect("daemon 커맨드에 PATH 가 없다 — 그러면 셔뱅의 `node` 를 못 찾는다");
        let path = path.to_string_lossy();

        // **회귀선 2 — 빈 PATH 를 넘기지 않는다.** 조회가 실패한 환경에서도 이 단언이
        // 서야 한다: 빈 `PATH` 는 없는 것보다 나쁘다(`login_path::child_path` 주석).
        assert!(!path.trim().is_empty(), "빈 PATH 를 넘겼다");
        assert!(
            path.split(':').any(|d| Path::new(d).is_absolute()),
            "절대 경로가 하나도 없다: {path}"
        );
        // 조회가 실패했다면 폴백이어야 한다 — 그 둘 중 하나이지 제3의 값이 아니다.
        let looks_like_fallback = path == crate::login_path::SYSTEM_PATH_FALLBACK;
        let looks_like_login = crate::login_path::login_path().as_deref() == Some(path.as_ref());
        assert!(
            looks_like_fallback || looks_like_login,
            "로그인 셸 값도 폴백도 아닌 값을 넘겼다: {path}"
        );
    }

    /// **회귀선 2 — 로그인 셸 조회가 실패해도 폴백 `PATH` 가 나간다**(`#513`).
    ///
    /// `login_path.rs` 쪽에서도 같은 성질을 재지만(그쪽은 `child_path()` 자체),
    /// **여기서 다시 재는 이유**는 재는 대상이 다르기 때문이다: 그 값이 실제로
    /// daemon 커맨드까지 **닿는가**. 함수는 옳은 값을 돌려주는데 커맨드가 그것을 안
    /// 쓰는 상태가 바로 `#513` 이전의 상태였다.
    #[test]
    fn 조회가_실패해도_daemon_은_폴백_path_로_뜬다() {
        // 조회 실패를 이 프로세스에서 강제할 수는 없다(`OnceLock` 이고, 실패를 주입하면
        // 그것은 캐시에 남아 다른 테스트를 오염시킨다). 대신 **폴백 값 자체**가 daemon 이
        // 뜨는 데 쓸 수 있는 값인지 잰다 — 조회 실패 시 커맨드에 들어가는 것이 정확히
        // 이 값이라는 것은 위 `daemon_커맨드가_path_를_env_로_넘긴다` 가 못박는다.
        let fallback = crate::login_path::SYSTEM_PATH_FALLBACK;
        assert!(!fallback.is_empty());
        assert!(fallback.split(':').any(|d| d == "/usr/bin"));
    }

    /// **회귀선 3 — daemon 이 `node` 를 못 찾은 사유가 화면에 온다**(`#513`).
    ///
    /// 앞 판본이 사람에게 준 문구는 이것뿐이었다:
    ///
    /// > daemon 을 띄웠지만 10초 안에 붙지 못했다: daemon 이 소켓을 올리지 않았다
    ///
    /// 전부 사실이지만 **사람이 할 수 있는 일이 없다.** 진짜 사유는 daemon 로그에만
    /// 있었고 그 파일이 어디 있는지는 개발자만 안다.
    ///
    /// `spawn_failure_reason` 이 이 자리를 못 메운 이유는 `DaemonExitWatch` 주석에
    /// 있다 — 셔뱅 스크립트에서는 `spawn()` 이 **성공**한다(exec 된 것은 `/usr/bin/env`
    /// 이고 그것은 있다). 실패는 자식의 종료 코드 127 로만 드러난다.
    ///
    /// 되돌려 RED: `exit_reason` 의 `looks_like_missing_node` 분기를 지우면 설치
    /// 주소가 사라져 빨개진다.
    #[test]
    fn daemon_이_node_를_못_찾으면_그_사실이_사유로_나온다() {
        let watch = DaemonExitWatch::exited(
            "/A/harkroom-daemon",
            Some(127),
            Some("env: node: No such file or directory"),
        );
        let msg = watch.death_reason().expect("죽었는데 사유가 없다");

        assert!(msg.contains("node"), "무엇이 없는지 말해야 한다: {msg}");
        assert!(
            msg.contains("https://nodejs.org/en/download"),
            "**어디서 받는지**가 `#476` 이 정한 답이다: {msg}"
        );
        // 소켓 이야기만 하지 않는다 — 그것이 이 회귀선의 이름이다.
        assert!(
            !msg.contains("소켓을 올리지 않았다"),
            "소켓 이야기로 덮으면 안 된다: {msg}"
        );
        // 원문을 삼키지 않는다(`#368`).
        assert!(msg.contains("env: node:"), "로그 원문이 남아야 한다: {msg}");
        // 고친 뒤에도 이 문구가 나오면 사람이 알아야 할 다음 사실이 `PATH` 다.
        assert!(msg.contains("PATH"), "이때 쓴 PATH 를 말해야 한다: {msg}");
    }

    /// **대조군 ① — 정상일 때는 그 문구가 안 뜬다**(`#513` 회귀선 4).
    ///
    /// **이것이 없으면 회귀선 3 은 "항상 Node 를 설치하라고 한다"로도 통과한다.**
    /// 이 저장소가 반복해서 겪은 실패 모드다(`#476`·`#473` 이 같은 자리에서 걸렸다).
    ///
    /// daemon 이 살아 있으면 `death_reason()` 은 `None` 이고, 그러면 `ensure_at` 은
    /// 평소대로 소켓을 기다린다.
    #[test]
    fn 살아_있는_daemon_에는_아무_사유도_안_붙는다() {
        let watch = DaemonExitWatch::alive();
        assert!(
            watch.death_reason().is_none(),
            "안 죽었는데 죽었다고 말하면 정상 기동이 실패로 뒤집힌다"
        );
    }

    /// **대조군 ② — 다른 사유로 죽으면 Node 이야기를 안 한다**(`#513` 회귀선 4).
    ///
    /// daemon 은 자기 사정으로도 죽는다(`EXIT_OCCUPIED`(10) 등). 그때까지 "Node 를
    /// 설치하라"고 하면 이미 설치한 사람이 다시 설치하러 가고, 그것은 `#473` 이 고친
    /// 오진(하네스 부재를 PAT 문제로 말한 것)과 같은 종류다.
    #[test]
    fn 다른_사유로_죽으면_node_이야기를_안_한다() {
        // 코드가 127 이 아니다.
        let occupied = DaemonExitWatch::exited(
            "/A/harkroom-daemon",
            Some(10),
            Some("소켓을 다른 daemon 이 쥐고 있다"),
        );
        let msg = occupied.death_reason().unwrap();
        assert!(!msg.contains("nodejs.org"), "지어내지 않는다: {msg}");
        assert!(msg.contains("10"), "종료 코드를 그대로 말한다: {msg}");
        assert!(
            msg.contains("소켓을 다른 daemon"),
            "로그 원문이 남는다: {msg}"
        );

        // **127 이어도 로그가 다른 이야기면 단정하지 않는다.** 코드만 보고 판정하면
        // daemon 이 127 로 끝나는 다른 경우까지 전부 Node 탓이 된다.
        let other127 = DaemonExitWatch::exited(
            "/A/harkroom-daemon",
            Some(127),
            Some("설정 파일을 읽지 못했다"),
        );
        let msg = other127.death_reason().unwrap();
        assert!(
            !msg.contains("nodejs.org"),
            "127 만으로 단정하지 않는다: {msg}"
        );

        // 로그가 아예 없어도 마찬가지다.
        let silent = DaemonExitWatch::exited("/A/harkroom-daemon", Some(127), None);
        let msg = silent.death_reason().unwrap();
        assert!(
            !msg.contains("nodejs.org"),
            "모르는 것을 단정하지 않는다: {msg}"
        );
    }

    /// **점유 회귀선 ① — 누가 쥐고 있는지와 할 일을 말한다.**
    ///
    /// 앞 판본의 화면 문구는 종료 코드 10 과 로그 원문뿐이었고, 그 답(어느 앱인가)은
    /// **pid 레코드에 이미 있었다.** 실측 2026-09-07: 사람이 할 수 있는 일이 없었다.
    #[test]
    fn 점유로_물러나면_누가_쥐고_있는지와_할_일을_말한다() {
        let dir = temp_app_data_dir("occupied");
        let pid_path = dir.join("daemon-v1.pid");
        // **실측한 레코드 원문 그대로다.** 구조체를 만들어 직렬화하지 않는 이유는
        // 필드 이름까지 daemon 이 쓴 그대로인지 함께 재기 위해서다.
        std::fs::write(&pid_path, r#"{"pid":17109,"startedAtMs":1788754303745,"entryPath":"/Applications/Harkroom.app/Contents/MacOS/harkroom-daemon","appVersion":"0.1.6","launchNonce":"ccf30441-045b-4497-b203-5835ededda34"}"#).unwrap();

        let watch = DaemonExitWatch::exited_at(
            "/A/harkroom-daemon",
            pid_path,
            Some(EXIT_OCCUPIED),
            Some("이미 서비스 중인 daemon 이 있다: /tmp/x/daemon-v1.sock — 물러난다"),
        );
        let msg = watch.death_reason().unwrap();

        // ① 종료할 대상을 **번들 경로**로 말한다 — 사람이 종료할 수 있는 것이 그것이다.
        assert!(
            msg.contains("`/Applications/Harkroom.app`"),
            "점유한 앱을 번들 경로로 말하지 않는다: {msg}"
        );
        assert!(
            !msg.contains("/Contents/MacOS/"),
            "실행 파일 경로를 그대로 말했다 — 사람이 종료할 대상이 아니다: {msg}"
        );
        // ② 누구인지 못박는다 — 같은 앱이 여러 개 떠 있을 때 pid 가 유일한 구분자다.
        assert!(
            msg.contains("17109") && msg.contains("0.1.6"),
            "pid·앱 버전을 안 말한다: {msg}"
        );
        // ③ **할 일**이 있다. 이 문장이 없던 것이 이 후속 작업의 이유였다.
        assert!(
            msg.contains("종료하고 다시 시도"),
            "사람이 할 일을 안 말한다: {msg}"
        );
        // ④ 증거를 지우지 않았다(`#368`) — 종료 코드와 로그 원문이 그대로 남는다.
        assert!(msg.contains("10"), "종료 코드가 사라졌다: {msg}");
        assert!(
            msg.contains("이미 서비스 중인 daemon 이 있다"),
            "로그 원문이 사라졌다: {msg}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **점유 회귀선 ② — 상대를 모르면 지어내지 않는다**(`#368`).
    #[test]
    fn 점유_상대를_모르면_지어내지_않는다() {
        // pid 레코드가 없다 — 그 daemon 이 물러나며 지웠거나, 애초에 못 읽는다.
        let 없음 = DaemonExitWatch::exited(
            "/A/harkroom-daemon",
            Some(EXIT_OCCUPIED),
            Some("이미 서비스 중인 daemon 이 있다"),
        );
        let msg = 없음.death_reason().unwrap();
        assert!(
            !msg.contains(".app"),
            "레코드가 없는데 앱 경로를 말했다: {msg}"
        );
        assert!(msg.contains("모른다"), "모른다는 사실을 말해야 한다: {msg}");
        assert!(msg.contains("모두 종료"), "그래도 할 일은 남는다: {msg}");

        // `entryPath` 를 안 적는 **옛 daemon** 도 같다 — 빈 문자열을 경로로 말하지 않는다.
        let dir = temp_app_data_dir("occupied-legacy");
        let pid_path = dir.join("daemon-v1.pid");
        std::fs::write(&pid_path, r#"{"pid":17109}"#).unwrap();
        let 옛것 =
            DaemonExitWatch::exited_at("/A/harkroom-daemon", pid_path, Some(EXIT_OCCUPIED), None);
        let msg = 옛것.death_reason().unwrap();
        assert!(
            msg.contains("모른다"),
            "빈 `entryPath` 를 경로로 말했다: {msg}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **점유 회귀선 ③ — 대조군: 점유가 아니면 그 말을 안 한다.**
    ///
    /// 이것이 없으면 "무엇이 죽어도 다른 앱을 종료하라고 한다"가 된다 — `#473` 이 고친
    /// 오진(하네스 부재를 PAT 문제로 말한 것)과 같은 종류다. 레코드가 **있어도** 사유가
    /// 점유가 아니면 읽지 않는다는 것이 요점이다.
    #[test]
    fn 점유가_아니면_점유_문구를_안_붙인다() {
        let dir = temp_app_data_dir("occupied-other");
        let pid_path = dir.join("daemon-v1.pid");
        std::fs::write(&pid_path, r#"{"pid":17109,"startedAtMs":1788754303745,"entryPath":"/Applications/Harkroom.app/Contents/MacOS/harkroom-daemon","appVersion":"0.1.6","launchNonce":"ccf30441-045b-4497-b203-5835ededda34"}"#).unwrap();

        let watch = DaemonExitWatch::exited_at(
            "/A/harkroom-daemon",
            pid_path,
            Some(78),
            Some("자격증명을 거부했다"),
        );
        let msg = watch.death_reason().unwrap();
        assert!(
            !msg.contains("Harkroom.app"),
            "점유가 아닌데 점유한 앱을 말했다: {msg}"
        );
        assert!(
            !msg.contains("종료하고 다시 시도"),
            "점유가 아닌데 앱을 종료하라고 한다: {msg}"
        );
        assert!(
            msg.contains("78") && msg.contains("자격증명"),
            "사유는 그대로 올라간다: {msg}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `app_bundle_of` 의 경계. **모양이 안 맞으면 원문 그대로다.**
    #[test]
    fn 번들_밖의_실행_파일은_경로를_그대로_말한다() {
        assert_eq!(
            app_bundle_of("/Applications/Harkroom.app/Contents/MacOS/harkroom-daemon"),
            "/Applications/Harkroom.app"
        );

        // `tauri dev` 빌드의 사이드카는 번들 안에 없다 — 억지로 자르면 **없는 경로**를
        // 사람에게 말하게 된다.
        let dev = "/Users/x/wt/a/packages/desktop/src-tauri/target/debug/harkroom-daemon";
        assert_eq!(app_bundle_of(dev), dev);

        // `.app` 이 아닌 디렉터리가 `/Contents/MacOS/` 를 품고 있어도 안 자른다.
        let 이상 = "/tmp/notabundle/Contents/MacOS/harkroom-daemon";
        assert_eq!(app_bundle_of(이상), 이상);
    }

    /// `looks_like_missing_node` 의 경계. **두 낱말을 다 요구한다** — 한쪽만 보면
    /// 대조군이 무너진다.
    #[test]
    fn node_부재_판정은_두_낱말을_다_본다() {
        assert!(looks_like_missing_node(
            "env: node: No such file or directory"
        ));
        assert!(looks_like_missing_node("node: command not found"));
        // `node` 는 있는데 다른 것이 없다.
        assert!(!looks_like_missing_node(
            "env: python3: No such file or directory"
        ));
        // "못 찾았다"가 아니라 그냥 `node` 가 나오는 줄.
        assert!(!looks_like_missing_node("node 모듈을 불러왔다"));
    }

    /// **`#513` 실물 회귀선 — `PATH` 를 비운 채 daemon 사이드카를 띄우면 127 로 죽는다.**
    ///
    /// 위 문구 테스트들은 전부 `DaemonExitWatch::exited` 로 만든 값을 잰다 — 즉
    /// *"127 + 그 줄이 오면 이렇게 말한다"* 만 재고 **"실제로 그런 일이 나는가"** 는
    /// 안 잰다. 이 테스트가 그 칸을 메운다: 진짜 사이드카를, GUI 가 주는 그 빈약한
    /// `PATH` 로 띄워 본다.
    ///
    /// 실측(2026-09-07, 이 테스트를 만들며):
    ///
    /// ```text
    /// $ env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin ./harkroom-daemon-aarch64-apple-darwin --version
    /// env: node: No such file or directory
    /// exit=127
    /// ```
    ///
    /// **이것이 `#513` 의 전부다.** 그리고 같은 사이드카를 로그인 셸 `PATH` 로 띄우면
    /// 인자를 파싱하고 자기 말을 한다(아래 대조군).
    #[test]
    fn 빈약한_path_로는_사이드카가_뜨지_않고_충분한_path_로는_뜬다() {
        let Some(program) = daemon_sidecar() else {
            eprintln!("건너뜀: daemon 사이드카가 없다 — `pnpm --filter @murmur/desktop build:sidecar` 먼저");
            return;
        };

        // ── 고치기 전의 조건 — GUI 가 주는 PATH ────────────────────────────
        let poor = std::process::Command::new(&program)
            .arg("--version")
            .env_clear()
            .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
            .output()
            .expect("사이드카를 띄우지 못했다");
        // **`spawn` 자체는 성공한다** — 그것이 `spawn_failure_reason` 이 이 자리를 못
        // 메우는 이유다(`DaemonExitWatch` 주석의 표).
        assert_eq!(
            poor.status.code(),
            Some(EXIT_COMMAND_NOT_FOUND),
            "GUI PATH 로도 떴다면 이 기계의 `/usr/bin` 에 node 가 있다는 뜻이다 — \
             그러면 이 테스트가 재는 조건이 성립하지 않는다"
        );
        let stderr = String::from_utf8_lossy(&poor.stderr);
        assert!(
            looks_like_missing_node(stderr.trim()),
            "실패 사유가 `node` 부재가 아니다: {stderr}"
        );
        // **그 줄에 우리 문구가 붙는가** — 회귀선 3 이 재는 판정을 실물 출력에 건다.
        let watch = DaemonExitWatch::exited(
            &program.to_string_lossy(),
            poor.status.code(),
            Some(stderr.trim()),
        );
        assert!(
            watch
                .death_reason()
                .unwrap()
                .contains("https://nodejs.org/en/download"),
            "실물 실패에 안내가 안 붙었다"
        );

        // ── 대조군: 고친 뒤의 조건 — 앱이 넘기는 그 PATH ────────────────────
        let rich = std::process::Command::new(&program)
            .arg("--version")
            .env_clear()
            .env("PATH", crate::login_path::child_path())
            .output()
            .expect("사이드카를 띄우지 못했다");
        if rich.status.code() == Some(EXIT_COMMAND_NOT_FOUND) {
            // 이 기계에는 `node` 가 정말 없다 — `#513` 을 고쳐도 안 뜨는 그 경우이고,
            // 그때 화면이 답하는 것이 회귀선 3 이다. 여기서 실패로 칠 일은 아니다.
            eprintln!("건너뜀: 앱이 넘기는 PATH 안에도 node 가 없다 — 이 기계에는 node 가 없다");
            return;
        }
        let err = String::from_utf8_lossy(&rich.stderr);
        assert!(
            !looks_like_missing_node(err.trim()),
            "앱이 넘기는 PATH 로도 node 를 못 찾았다: {err}"
        );
    }

    /// **회귀선 5 — 앱이 죽어도 daemon 이 산다: `setsid` 가 걸렸는가.**
    ///
    /// `detached_command()` 로 띄우므로 daemon 은 자기 세션/프로세스 그룹의 리더가 된다.
    /// 그러면 앱 프로세스 그룹에 오는 시그널이 daemon 에 닿지 않는다 — `#431` D2 가 이
    /// 설계의 핵심 메커니즘이라고 못박은 자리이고, 실측(2026-09-05)이 그 근거다.
    ///
    /// 되돌려 RED: `daemon_command` 의 `crate::detached_command(program)` 를
    /// `std::process::Command::new(program)` 로 바꾸면 PGID 가 이 테스트 프로세스의 것과
    /// 같아져 빨개진다.
    #[test]
    fn daemon_의_pgid_는_자기_자신이다() {
        let Some(program) = daemon_sidecar() else {
            eprintln!("건너뜀: daemon 사이드카가 없다 — `pnpm --filter @murmur/desktop build:sidecar` 먼저");
            return;
        };
        let dir = temp_app_data_dir("pgid");
        let paths = endpoint_paths(&dir);
        std::fs::create_dir_all(&paths.dir).unwrap();

        // **가드가 먼저다** — 이 테스트가 바로 되돌려 RED 로 패닉시키는 자리이고,
        // 실제로 그때 daemon 이 `ppid=1` 로 남았다(`DaemonGuard` 주석의 실측).
        let guard = DaemonGuard {
            child: launch_daemon(&program, &paths, "nonce-pgid"),
            dir: dir.clone(),
        };
        let pid = guard.child.id();
        assert!(
            wait_for_endpoint(&paths),
            "daemon 이 엔드포인트를 올리지 않았다"
        );

        let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        let own = unsafe { libc::getpgid(0) };
        assert_ne!(
            pgid, own,
            "daemon 의 PGID({pgid})가 이 프로세스의 PGID({own})와 같다 — setsid 가 빠졌다. \
             그러면 앱 그룹에 오는 시그널 한 번에 daemon 이 함께 죽는다(`#431` D2)."
        );
        assert_eq!(
            pgid, pid as libc::pid_t,
            "PGID 가 자기 pid 와도 다르다 — 분리는 됐지만 세션 리더가 아니다"
        );
        // 정리는 `guard` 의 `Drop` 이 한다 — 패닉해도 불린다.
        drop(guard);
    }
}
