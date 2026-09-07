# 데스크탑의 claude 계정 풀 관리 — 설계

2026-09-08. 대상: `packages/desktop`(UI·Rust), `packages/daemon`, `packages/shared`,
`packages/agent`. **서버·DB 는 바뀌지 않는다.**

선행: `docs/specs/2026-09-07-claude-multi-account-design.md`(러너의 계정 페일오버). 그 문서 §7 이
데스크탑 UI 를 범위 밖으로 남겼고, 이 문서가 그 자리를 채우면서 **평평한 풀을 그룹으로 바꾼다.**

## 1. 무엇을 요구받았나

> "계정 풀을 그룹으로 관리해 예를 들어 회사 계정 풀 / 개인 계정 풀 이렇게 풀을 관리할 수 있고
> 기본 풀이 지정되어 있는데 특정 에이전트에 내가 따로 풀을 정하면 그것만 쓰도록 되면 좋겠어"

셋이다: **풀이라는 그룹**, **기본 풀**, **에이전트별 풀 지정**. 여기에 요청의 전제인
**데스크탑 UI 에서의 관리**(목록·추가·삭제·상태)가 붙는다.

## 2. 넘어야 하는 벽 — 웹뷰에는 로컬을 다룰 표면이 없다

**의도적으로 없다.** 이것이 이 작업의 실제 무게다.

- `packages/desktop/src-tauri/capabilities/default.json` 의 권한 전부:
  `core:default`, `core:window:allow-start-dragging`, `notification:default`,
  `shell:allow-open`, `updater:default`, `process:allow-restart`.
  `shell:allow-execute`·`shell:allow-spawn`·fs 권한이 **하나도 없다.**
- `packages/desktop/test/runnerShellScope.test.ts` 가 그것을 회귀선으로 못박았다:
  *"그래서 `shell:allow-execute` 항목이 0개다. 웹뷰에서 프로그램을 실행할 수 있는 표면이 이제
  아예 없다."* 같은 파일이 `daemon_spawn_runner` 의 **웹뷰 파라미터가 정확히 넷**임을 단언한다.
- `runnerLauncher.ts` 주석: *"러너는 더 이상 `@tauri-apps/plugin-shell` 의 `Command.create` 로
  뜨지 않는다"*, *"`@tauri-apps/plugin-shell` 을 더 이상 안 부른다(`#513`)"*. 별도 테스트가 그
  문자열이 실행기 소스에 **없는지**까지 검사한다.
- `#[tauri::command]` 는 9개뿐이고 그중 로컬 파일을 읽거나 프로그램을 띄우는 것은 없다.
  `daemon_spawn_runner` 조차 자기가 띄우지 않고 데몬에게 시킨다.

즉 이 저장소는 웹뷰의 권한을 **줄이는 방향으로 이미 한 번 리팩터했다.** 새 기능이 그 결정을
되돌리는 모양이면 안 된다.

**그래서 답은 일반적인 실행 원시연산을 여는 것이 아니라, 이름 붙은 좁은 연산을 데몬에 두는
것이다.** 데몬은 이미 "로컬 프로세스를 소유하는" 경계다(러너를 띄우는 것이 앱이 아니라
데몬이다). 웹뷰는 프로그램 경로도 인자도 넘기지 않고 `^[a-z0-9-]{1,32}$` **이름만** 넘긴다.
회귀선은 약화시키지 않고 **새 명령의 파라미터가 이름뿐이라는 단언을 더해 확장한다.**

## 3. PTY 가 필요 없다 — 실측

2026-09-07 실측, claude 2.1.263.

- `claude auth status --json` 은 `CLAUDE_CONFIG_DIR` 를 따라가고
  `{loggedIn, authMethod, projectsDirectory, email, orgId, orgName, subscriptionType}` 를 준다.
  **비밀값이 없다.** 미로그인이면 종료 코드 1 과 `loggedIn:false`.
- `claude auth login` 은 **파이프에서도 동작한다**: `Opening browser to sign in…` 뒤에 OAuth
  URL 을 찍고(OSC 8 하이퍼링크로 감싸여 URL 이 두 번 나온다), 그다음
  `Paste code here if prompted >` 로 **표준입력에서 코드를 읽는다.**
  버려지는 디렉터리에서 6초만 띄워 확인했고, 미완료 로그인은 자격증명을 남기지 않았다.

그래서 로그인 흐름에 PTY 도 xterm 도 필요 없다. 필요한 것은 **spawn + stdout 스트림 +
stdin 한 줄**이다. 이것이 §2 의 "좁은 연산"을 실제로 좁게 만들어 주는 사실이다.

(참고: 데스크탑의 xterm 은 100% 서버 릴레이 → 러너 PTY 구조이고 로컬 PTY 경로가 없다.
`src/lib/terminalSink.ts` 만은 도메인을 모르는 순수 이음새라 재사용 가능하지만, 위 실측 때문에
이 설계는 그것도 쓰지 않는다.)

## 4. 디스크 모델

```
~/.murmur-agent/claude-accounts/
  pools.json          디스크가 표현할 수 없는 것만
  work/               풀 = 디렉터리
    lime/             계정 = CLAUDE_CONFIG_DIR 하나
    plum/
  personal/           풀
    gmail/
```

**멤버십은 계속 디스크가 진실이다.** 풀은 뿌리 아래 디렉터리, 계정은 풀 아래 디렉터리다.
`pools.json` 에는 디스크가 말할 수 없는 셋만 둔다:

```json
{
  "defaultPool": "work",
  "order": { "work": ["lime", "plum"] },
  "agents": { "<agent account id>": "personal" }
}
```

이 구분은 선행 설계에서 이미 세운 규율과 같다 — 목록을 파일에 이중으로 적으면 파일과 디스크가
갈리는 날이 오고 그날 러너는 없는 계정을 가리킨다. 반면 **기본 풀·순서·배정은 디스크에서
유도할 수 없으므로** 파일이 유일한 표현 수단이다.

### 4-1. 왜 이것이 "데몬은 프로세스를 소유한다" 규칙을 어기지 않는가

`packages/shared/src/daemonProtocol.ts` 머리 주석은 이렇게 못박아 뒀다:

> `sessions.json` 은 여기 없다. 이 프로토콜에 세션 상태를 실어 나르는 메시지는 **없고, 만들면
> 안 된다.** … daemon 이 그 파일의 두 번째 writer 가 되면 lost update 가 조용히 난다. daemon 이
> 소유하는 것은 **프로세스**이지 세션이 아니다.

그 규칙의 **근거는 단일 writer** 다. `sessions.json` 의 writer 는 러너이고, 데몬이 두 번째
writer 가 되는 것이 금지의 이유다.

`pools.json` 은 그 조건에 걸리지 않는다: **writer 가 데몬 하나뿐이고, 러너는 읽기만 한다.**
그래서 이 설계는 다음을 불변식으로 못박는다.

> **러너는 `pools.json` 을 절대 쓰지 않는다.** 순서·기본 풀·배정을 바꾸는 것은 데몬뿐이다.

규칙의 글자만 지키고 근거를 무시하면 틀린다 — 근거가 성립하지 않는 곳까지 금지를 넓히면 이
기능은 아무 데도 살 수 없다. 그 판단을 여기 적어 두는 이유는, 저 주석을 읽은 다음 사람이
"규칙을 어겼다"로 읽지 않게 하기 위해서다.

### 4-2. 에이전트 배정은 왜 서버가 아니라 기기 로컬인가

**풀은 이 기기에만 존재한다.** 계정 디렉터리와 그 안의 자격증명은 로컬 자산이고, 같은 murmur
에이전트를 다른 기기에서 띄우면 그 기기에는 그 풀이 없다. 배정을 서버에 두면 그 순간
**없는 풀을 가리키는 설정**이 다른 기기로 전파된다.

저장소에 같은 판례가 있다(설정 화면, `murmur-follow-ups` 19번): *"설정값은 기기 로컬이
의미론적으로 맞다 — '이 기기에서 알림 울릴까'는 계정이 아니라 기기의 속성이고, 다기기 세션이
있는 이상 서버에 두면 노트북에서 끈 게 데스크탑에서도 꺼진다."*

부수 효과가 크다: **서버 스키마·DB 마이그레이션·`AgentConfig`·서버 라우트 변경이 0 이다.**

키는 **에이전트 계정 id**(UUID)다. handle 이 아닌 이유는 선행 설계의 `stateDir.ts` 판단과
같다 — handle 은 바뀔 수 있고 서로 다른 서버의 같은 handle 은 다른 계정이다.

### 4-3. 하위 호환 — 평평한 풀

선행 설계가 어제 낸 구조는 `<뿌리>/<계정>` 이었다. 실측: **이 기기에 뿌리가 아직 없다**
(`~/.murmur-agent/claude-accounts` 부재). 그래도 README 를 보고 만든 사람이 있을 수 있으므로
깨지 않는다.

**`pools.json` 의 존재가 스위치다.** 술어 하나이고 그것뿐이다.

| `pools.json` | 뿌리 아래 디렉터리의 뜻 |
|---|---|
| 없다 | **계정** — 뿌리 자체가 단일 암묵 풀이다(어제와 완전히 같은 동작) |
| 있다 | **풀** — 풀 아래 디렉터리가 계정이다 |

디렉터리 **모양을 추측하지 않는다**(안에 `.credentials.json` 이 있나, 하위 디렉터리가 있나).
갓 만든 빈 풀과 계정은 모양이 같아서 그 추측은 원리적으로 갈리지 않는다 — 그리고 틀리는 순간
러너가 계정을 풀로, 또는 풀을 계정으로 읽는다.

UI 는 `pools.json` 이 없는 상태를 "이름 없는 기본 풀"로 보여 준다. 사용자가 풀을 처음 만드는
순간 `pools.json` 이 생기고, 그때 뿌리에 남아 있는 평평한 계정 디렉터리는 **풀이 아닌 것으로
읽혀 계정 목록에서 사라진다.** 그래서 UI 는 그 상태를 감지해(뿌리 하위에 `.credentials.json`
또는 `.claude.json` 을 가진 디렉터리가 남아 있다) 그 계정들을 풀 안으로 옮기도록 안내한다.

**이전이 로그인을 깨지 않는다 — 실측으로 확인했다(2026-09-08).** 처음에는 깬다고 적었는데
틀렸다. macOS 의 Keychain 서비스 이름이 config 디렉터리 **경로 해시**로 파생되므로 경로가
바뀌면 그 항목은 안 맞게 되지만, **파일 폴백(`<configDir>/.credentials.json`)이 디렉터리와 함께
움직인다.** 검증: 새 실제 디렉터리(따라서 다른 해시)에 자격증명 파일만 심볼릭 링크로 넣고
`claude auth status --json` 을 돌렸더니 `loggedIn: true` 였다. 비밀값을 복사하지 않았고 링크는
지웠다.

그래서 UI 가 이전을 **도울 수 있다**. 다만 무조건 성공한다고 말하지 않는다: 갓 로그인한 계정이
자격증명을 파일에 남기는지 Keychain 에만 남기는지는 로그인을 완주해야 알 수 있고 그것은
사람만 할 수 있다. 그래서 흐름을 **옮긴 뒤 확인**으로 짠다.

1. 사용자가 대상 풀을 고르고 이전을 승인한다(자동으로 시작하지 않는다).
2. 데몬이 디렉터리를 옮긴다(같은 볼륨 안의 `rename` — 복사가 아니라 이동이라 자격증명이
   두 자리에 남는 순간이 없다).
3. 옮긴 자리에서 `claude auth status --json` 을 다시 돌린다.
4. `loggedIn: false` 면 그 계정을 **미로그인으로 표시하고 다시 로그인하라고 말한다.** 되돌리지
   않는다 — 되돌려도 Keychain 항목이 다시 맞을 뿐이고, 그때는 사용자가 이전을 또 해야 한다.

`auth status` 가 보고하는 정체는 `<configDir>/.claude.json` 에서 온다(실측: 같은 자격증명
파일에 다른 `.claude.json` 을 짝지으면 다른 조직 이름이 나왔다). 즉 이 판정은 **그 계정
디렉터리에 대해 정확하다** — UI 가 계정별 정체를 그리는 근거가 이것이다.

## 5. 러너의 풀 해석 (packages/agent)

`loadClaudeAccounts` 위에 풀 축을 하나 얹는다. 해석 순서:

1. `MURMUR_CLAUDE_POOL` env — 운영자 강제. 없는 풀이면 **기동 실패**(사람이 방금 타이핑한 의도다).
2. `pools.json` 의 `agents[<내 계정 id>]` — 이 에이전트에 지정된 풀.
3. `pools.json` 의 `defaultPool` — 기본 풀.
4. 둘 다 없으면 §4-3 의 암묵 풀(뿌리 자체).
5. 그래도 계정이 없으면 **계정 지정 없음** → 자식은 시스템 기본 `~/.claude` 를 쓴다(어제와 같다).

풀 안의 순서는 `pools.json` 의 `order[풀]`, 없으면 이름 사전순. `MURMUR_CLAUDE_ACCOUNTS` 는
그 위를 덮는다(기존 동작 유지).

### 5-1. 관용성이 갈린다 — 파일과 env 는 다르게 다룬다

| 출처 | 없는 이름을 만나면 |
|---|---|
| `MURMUR_CLAUDE_POOL`, `MURMUR_CLAUDE_ACCOUNTS` (env) | **기동 실패** |
| `pools.json` (UI 가 쓴 파일) | **경고하고 무시** |

env 는 사람이 방금 타이핑한 의도라, 조용히 무시하면 계정 B 라고 믿고 띄운 러너가 A 로 돈다
(`config.ts::validateInstance` 판례).

`pools.json` 은 다르다. UI 가 쓴 뒤 사람이 파인더에서 디렉터리를 지울 수 있고, 그때 러너가
뜨지 않으면 **사용자는 앱에서 고칠 방법이 없다** — 앱이 뜨려면 러너가 떠야 하는 순환이 아니지만,
"러너가 안 뜬다"는 화면은 사용자가 원인을 찾을 수 없는 자리다. 그래서 무시하고 다음 단계로
떨어진다(지정 풀 없음 → 기본 풀 → 암묵 풀 → 계정 지정 없음). 무시했다는 사실은 러너 로그에
남긴다.

### 5-2. 풀은 기동 시 1회 읽는다 — 이 설계 범위에서 바꾸지 않는다

지금 `main.ts` 가 최상단에서 한 번 읽고, 인터랙티브 매니저가 쓰는 값도 생성 시점에 고정된다.
UI 로 계정을 바꾸면 **러너 재시작 전에는 반영되지 않는다.**

핫리로드를 이번에 하지 않는 이유: `InteractiveTurnDeps.claudeConfigDir` 를 값에서 함수로
바꿔야 하고, 그것은 인터랙티브 턴의 계정 고정 규칙(어제 설계 §4-4)을 다시 논해야 하는 일이다.
대신 **UI 가 그 사실을 말하고 기존 재기동 버튼을 쓴다** — 앱에는 이미 러너 상태 표시와
재기동 표면이 있다(`RunnerStatusLine`, `restartStaleRunners`, `reissueRunnerPat`,
`Profile.tsx` 의 재기동). 후속으로 남긴다.

## 6. 데몬 연산 (packages/shared + packages/daemon)

프로토콜 메서드는 지금 다섯이다(`spawnRunner`·`killRunner`·`listRunners`·`ping`·`adoptRunner`).
여덟을 더한다. **모두 이름 붙은 연산이고 경로·프로그램·인자를 받지 않는다.**

| 메서드 | 파라미터 | 하는 일 |
|---|---|---|
| `claudeAccountsList` | 없음 | 풀·계정·로그인 상태·기본 풀·배정을 한 번에 읽어 준다 |
| `claudeAccountsConfigure` | `{defaultPool, order, agents}` | `pools.json` 을 **원자적으로** 쓴다. 없는 풀 디렉터리는 만든다 |
| `claudeAccountLoginStart` | `{pool, account}` | 디렉터리를 만들고 `claude auth login` 을 그 `CLAUDE_CONFIG_DIR` 로 띄운다. `loginId` 반환 |
| `claudeAccountLoginSubmit` | `{loginId, code}` | 그 프로세스의 stdin 에 코드를 한 줄 쓴다 |
| `claudeAccountLoginCancel` | `{loginId}` | 그 프로세스를 회수한다(SIGTERM→유예→SIGKILL, 러너 회수와 같은 규율) |
| `claudeAccountRemove` | `{pool, account}` | 그 계정 디렉터리를 지운다 |
| `claudePoolRemove` | `{pool}` | 그 풀 디렉터리를 지운다(안의 계정까지) |
| `claudeAccountMove` | `{account, toPool}` | 평평한 계정을 풀 안으로 옮긴다(§4-3). 같은 볼륨 `rename` |

파괴적 연산을 **다형으로 만들지 않는다** — `claudeAccountRemove` 에 `account` 를 생략하면
풀이 지워지는 설계는, 프론트의 버그 하나가 계정 하나 대신 풀 전체를 날리게 한다.

`claudeAccountsList` 가 상태를 함께 주는 이유: 계정마다 `claude auth status --json` 을 돌려야
로그인 여부와 정체를 알 수 있고, 그것을 프론트가 계정별로 따로 물으면 N 왕복이 된다.
**비밀값은 그 출력에 없다**(§3) — 그대로 실어도 된다.

### 6-1. 로그인 출력은 이벤트로 흘린다

`EVENT_NAMES` 는 지금 `['runnerExit']` 하나다. `claudeLoginOutput` 을 더한다.

경로는 러너 종료 통지가 이미 쓰는 길과 같다: 데몬이 소켓에
`{type:'event', event:'claudeLoginOutput', payload}` 를 쓰고 → Rust
(`daemon_client.rs` 의 이벤트 분기) → 웹뷰에 Tauri 이벤트로 emit → 프론트가 listen.

payload 는 `{loginId, url?, prompt?, done?, error?}`. **원시 바이트를 그대로 흘리지 않는다** —
데몬이 stdout 에서 URL 을 뽑아 구조화한다. 이유: OSC 8 이스케이프 때문에 URL 이 두 번 나오고
(실측), 프론트가 그 파싱을 하면 하이퍼링크 규격을 프론트가 알아야 한다. **파싱은 한 곳에서 한다.**

### 6-2. 이름 검증은 데몬이 다시 한다

프론트가 검증하더라도 데몬이 `^[a-z0-9-]{1,32}$` 를 **다시** 잰다. 이 이름은 경로 세그먼트가
되고, 데몬은 웹뷰를 신뢰하는 자리가 아니다(그 신뢰 경계가 §2 의 전부다). 어긋나면 `bad-request`
갈래로 거절한다.

## 7. Rust 표면 (packages/desktop/src-tauri)

`#[tauri::command]` 여덟을 더해 §6 의 메서드로 각각 넘긴다. 이름은 프론트가 부르는 그대로:
`claude_accounts_list`, `claude_accounts_configure`, `claude_account_login_start`,
`claude_account_login_submit`, `claude_account_login_cancel`, `claude_account_remove`,
`claude_pool_remove`, `claude_account_move`.

- `invoke_handler`(`main.rs` 의 `generate_handler![...]`)에 여덟을 등록한다.
- 이벤트 상수 하나를 더한다(`RUNNER_EXIT_EVENT` 옆에 `CLAUDE_LOGIN_EVENT`).
- **capability 변경 0.** shell 실행 권한도 fs 권한도 필요 없다 — 실행하는 것은 데몬이다.

### 7-1. 회귀선은 확장한다, 약화시키지 않는다

`test/runnerShellScope.test.ts` 는 세 가지를 본다: (a) `shell:allow-execute` 가 0개,
(b) `main.rs`·`daemon_client.rs`·`login_path.rs` 에서 프로세스를 실행하는 자리를 감시,
(c) `daemon_spawn_runner` 의 웹뷰 파라미터가 정확히 넷.

- (a) 는 그대로 유지된다 — 이 설계는 shell 권한을 안 쓴다.
- (b) 는 그대로 유지된다 — 새 Rust 명령은 프로세스를 띄우지 않고 소켓으로 넘긴다.
- (c) 에 **같은 모양의 단언을 여덟 개 더한다**: 새 명령들의 웹뷰 파라미터가 이름·코드·id
  뿐이고 경로나 프로그램이 없다는 것. 이것이 이 설계가 그 회귀선을 "확장"한다는 말의 실체다.

`test/invokeCommands.test.ts` 는 프론트의 `invoke('...')` 이름이 `main.rs` 에 있는지 소스로
대조한다 — 여덟을 더하면 자동으로 검사 대상이 된다.

## 8. UI (packages/desktop/src)

### 8-1. 새 설정 섹션 — `claude-accounts`

`src/components/settings/sections.ts` 의 `SectionId` 에 값 하나, `SETTINGS_GROUPS` 의
**App 그룹**에 항목 하나. `SettingsScreen.tsx` 에 import 한 줄과 렌더 분기 한 줄.
새 컴포넌트 `src/components/settings/ClaudeAccountsSettings.tsx`.

그 파일 머리 주석이 이미 이 절차를 적어 뒀다 — 목차의 진실은 `SETTINGS_GROUPS` 하나다.

화면 구성:

- 풀 목록. 각 풀에 계정과 로그인 상태. 상태는 `● jaebin@rebellions.ai · Rebellions-Lime · team`
  또는 `○ 미로그인` 으로 그린다(§3 의 필드).
- 기본 풀 표시와 변경.
- 풀 안 계정 순서 변경(페일오버 순서).
- 계정 추가 흐름(§8-2).
- 계정·풀 삭제. **확인 단계를 둔다** — 자격증명이 사라지는 일이고 되돌리려면 다시 로그인해야
  한다. `AgentsSettings` 의 비활성화 확인 단계와 같은 모양을 쓴다.
- 러너 반영 안내(§5-2)와 기존 재기동 표면으로의 연결.

**UI 문자열은 영어다** — 저장소 관례이고 한 번 어겨 되돌린 적이 있다(`murmur-follow-ups`).
주석은 한국어다.

### 8-2. 계정 추가 흐름

1. 풀과 이름을 받는다(`^[a-z0-9-]{1,32}$` 를 입력 단계에서 안내).
2. `claude_account_login_start` → `loginId`.
3. `claudeLoginOutput` 이벤트로 URL 이 오면 **클릭 가능한 링크**로 보여 준다
   (`src/lib/openExternal.ts` 의 기존 경로 — `shell:allow-open` 하나로 충분하다).
4. **두 번째 계정부터 시크릿 창이 필요하다는 안내를 그 자리에 적는다.** 그러지 않으면 기존
   세션 쿠키를 재사용해 같은 계정으로 다시 로그인된다 — 링크를 직접 보여 주는 이유의 절반이
   이것이다(브라우저가 자동으로 열리면 시크릿 창을 못 고른다).
5. 코드 입력란 → `claude_account_login_submit`.
6. 끝나면 목록을 다시 읽어 상태가 초록으로 바뀐다. 취소는 `claude_account_login_cancel`.

### 8-3. 에이전트별 풀 지정

`AgentsSettings.tsx` 상세 화면의 **실행 묶음**(`FieldGroup`)에 "Account pool" 선택을 더한다.
값은 풀 이름 또는 "기본 풀 사용"(`null`). 쓰기는 `claude_accounts_configure` 의 `agents` 맵.

**서버로 가지 않는다**(§4-2). 그래서 이 필드는 `AgentConfig` 의 다른 필드들과 저장 경로가
다르다 — 그 사실을 화면에 적는다(*"This machine only"*), 안 그러면 다른 기기에서 안 보이는
것을 버그로 읽는다.

### 8-4. 상태 스토어

`AgentsSettings` 의 관행을 따른다: 읽기는 `useActiveStore`, 쓰기와 왕복은 `getController()`.
계정 풀 상태는 컨트롤러가 `claude_accounts_list` 를 불러 스토어에 밀어 넣고 **화면은 읽기만**
한다(러너 상태가 이미 그 모양이다 — `RunnerLauncher` 가 밀고 화면이 읽는다).

Tauri 표면이 없는 환경(웹·테스트)에서는 **섹션이 "이 빌드에서는 쓸 수 없다"를 말한다.**
`'__TAURI_INTERNALS__' in window` 판정은 이미 쓰이는 패턴이다(`NotificationSettings`,
`useUpdateCheck`).

## 9. 테스트

| 층 | 무엇 |
|---|---|
| `packages/agent` | 풀 해석 5단계(env·배정·기본·암묵·없음), 관용성 갈림(§5-1), 순서 |
| `packages/shared` | 새 메서드·이벤트의 파싱·검증, 이름 문법 거절 |
| `packages/daemon` | `pools.json` 원자적 쓰기, 로그인 프로세스 수명(spawn·stdin·회수), URL 추출(OSC 8 포함 실측 바이트), 이름 재검증, 이전 후 상태 재확인(§4-3 4단계) |
| `packages/desktop` Rust 회귀선 | §7-1 의 여덟 단언 + `invokeCommands` 자동 편입 |
| `packages/desktop` UI | 섹션 목차 편입, 풀·계정 렌더, 추가 흐름(이벤트 목킹), 삭제 확인, Tauri 부재 시 안내 |

실물 검증(테스트가 대신할 수 없는 것): 앱에서 풀 둘을 만들고 각각에 계정을 등록해, 에이전트
하나를 개인 풀에 배정한 뒤 그 에이전트가 그 풀의 계정으로 도는지 러너 로그로 확인한다.

## 10. 범위 밖

- **핫리로드**(§5-2). 러너가 풀을 턴마다 다시 읽게 하는 것. 인터랙티브 턴의 계정 고정 규칙을
  다시 논해야 한다.
- **서버·DB·`AgentConfig`**. §4-2 의 판단이 유지되는 한 필요 없다.
- **자동 이전**(§4-3). 이전 연산은 있지만 **사용자가 승인해야** 시작한다. 앱이 기동하면서
  몰래 옮기지 않는다.
- **계정 로그아웃**. 삭제(디렉터리 제거)로 갈음한다. `claude auth logout` 을 따로 부르지 않는
  이유: 디렉터리를 지우면 그 안의 자격증명 파일도 사라지고, macOS Keychain 항목은 그 경로 해시로
  파생돼 다른 config 디렉터리와 겹치지 않는다(선행 설계 §1 실측). 남는 Keychain 항목은 고아이고
  아무도 읽지 않는다 — **다만 이것을 후속으로 적어 둔다**(고아 항목 청소는 별건이다).
- **codex 계정 풀**. 같은 모양으로 확장할 수 있다.

## 11. 실물 검증 결과 (2026-09-08)

데몬 포트를 **실제 파일시스템과 실제 `claude` 바이너리**로 돌렸다(`runStatus` 를 주입하지
않아 `claude auth status --json` 이 진짜로 돌았다). 앱 UI 는 테스트로만 확인했다.

**통한 것.**

- 빈 뿌리에서 시작해 `configure` 로 풀 둘(`work`·`personal`)이 생겼다 — **설정 쓰기가 풀
  생성 경로**라는 §6 의 결정이 실제로 성립한다.
- `mode` 가 `flat` 에서 `pools` 로 넘어갔다. `pools.json` 의 존재가 스위치라는 §4-3 그대로다.
- 로그인된 계정의 정체를 읽었다: `work/lime loggedIn=true org=Rebellions-Lychee`.
  자격증명을 **복사하지 않고** 심볼릭 링크로 넣었고, 링크를 지운 뒤 원본
  (`~/.claude/.credentials.json`)이 그대로 남아 로그인도 유지됐다.
- 미로그인 계정이 목록에 남았다(`personal/empty loggedIn=false`) — 숨기지 않는다는 §8-1 대로다.
- **러너가 같은 디스크를 읽어 배정을 따랐다.** 기본 풀 에이전트는 `work`, 배정된 에이전트는
  `personal` 로 갔다. 데몬이 쓴 것을 러너가 읽는 이 왕복이 이 설계의 핵심이고, 그것이 실제로
  돈다.
- 없는 풀을 지우려 하면 거절했다(`풀이 없다: ghost`) — 조용히 성공하지 않는다는 §6 대로다.

**검증하지 못한 것.**

- **앱 UI 에서의 실제 조작.** 설정 화면과 에이전트별 선택은 vitest(Tauri 표면 위조) 로만
  확인했다. 실제 앱에서 눌러 보려면 이 변경이 담긴 앱을 빌드해 설치해야 한다.
- **`claude auth login` 을 완주하는 로그인.** 브라우저 OAuth 는 사람만 할 수 있다. 프로세스
  수명·URL 추출·코드 전달은 가짜 프로세스로 재고(그중 청크 경계 결함을 실제로 잡았다),
  파이프에서 URL 을 찍고 stdin 을 읽는다는 사실은 2026-09-07 에 실물로 측정했다.
- **이전(`move`) 후 실제 로그인 유지.** 파일 폴백이 디렉터리와 함께 움직인다는 것은 §4-3 에서
  측정했지만, 갓 로그인한 계정이 파일을 남기는지 Keychain 에만 남기는지는 로그인을 완주해야
  알 수 있다 — 그래서 코드가 "성공했다"고 말하지 않고 옮긴 뒤 다시 재서 사실을 돌려준다.
