# 러너의 claude 다중 계정 — 설계

2026-09-07. 대상: `packages/agent`. 서버·DB·데스크탑 UI 는 바뀌지 않는다.

## 1. 왜 — 관측된 결함

**러너는 `CLAUDE_CONFIG_DIR` 를 설정하지 않으므로 언제나 시스템 기본 계정(`~/.claude`)을
쓴다. 계정 전환이 그 경로로 이뤄지지 않으면 러너에 닿지 않는다.**

관측(2026-09-07):

- 러너의 env 는 데몬 env 를 통째로 상속하고 `MURMUR_PAT`·`MURMUR_URL`·`PATH` 만 덮어쓴다
  (`desktop/src/lib/runnerLauncher.ts` 의 `daemon_spawn_runner` 인자가 그 셋뿐이다).
  데몬 env 에 `CLAUDE_CONFIG_DIR` 는 없다 — 실측: `ps eww 14989`.
- macOS 의 claude 는 자격증명을 **Keychain 에서 먼저** 읽고, 서비스 이름을
  `CLAUDE_CONFIG_DIR` 경로의 `sha256` 앞 8자로 파생한다. 미설정이면 `Claude Code-credentials`,
  설정하면 `Claude Code-credentials-<hash8>`. 파일 폴백은 `<configDir>/.credentials.json`.
- 즉 config 디렉터리를 바꾸면 자격증명이 통째로 갈린다. 실측: 빈 디렉터리를
  `CLAUDE_CONFIG_DIR` 로 주고 `claude -p` 를 돌리면 `Not logged in · Please run /login`,
  종료 코드 1.
- 그날 러너 로그에 남은 것: `Failed to authenticate: OAuth session expired and could not be
  refreshed` 12건, `사용량 한도` 5건. 로그 위치는
  `~/Library/Application Support/app.murmur.desktop/daemon/runner-<agentId>.log`.

동시에 드러난 별개 결함 둘:

- **한도에 걸린 멘션은 버려진다.** `main.ts` 의 한도 분기가 통지만 남기고 `done.push` 한다.
  계정을 바꿔도 그 멘션은 다시 시도되지 않는다 — 계정을 바꾼 목적이 바로 그 멘션에 답하게
  하는 것인데 러너는 이미 소비했다.
- **미로그인 문구가 자격증명 판정에 안 걸린다.** `policy.ts::HARNESS_CREDENTIAL_PATTERNS`
  다섯 개 중 어느 것도 `Notloggedin·Pleaserun/login` 을 잡지 못한다. 그래서 3회 재시도를
  태우고 `FAILURE_NOTICE`("운영자 확인이 필요합니다")라는 엉뚱한 안내를 남긴다.

## 2. 이미 있는 대칭 — codex

`turn.ts::childEnv(pat, codexHome)` 가 codex 에 `CODEX_HOME` 을 주입하고
`codexHome.ts::ensureCodexHome` 가 그 디렉터리를 만든다. 상태 경로는
`stateDir.ts::resolveAgentStateDir` 의 `codexHomeDir` 다.

**claude 쪽에는 그 대칭물이 아예 없다.** 이 설계는 그 빈자리를 채우는 것이고, 그래서 새 구조를
만들지 않는다 — 있는 모양을 하나 더 따른다.

## 3. 왜 Orca 계정 디렉터리를 직접 쓰지 않는가

Orca 는 계정별 `CLAUDE_CONFIG_DIR`
(`~/Library/Application Support/orca/claude-accounts/<uuid>/auth`)를 쓰지만, **자격증명을 그
디렉터리에 두지 않는다.** durable 저장소는 자기 Keychain 서비스
(`Orca Claude Code Managed Credentials`, account = 계정 UUID)이고, 프로세스를 띄우기 직전에만
스코프 항목(`Claude Code-credentials-<hash8>`)으로 복사한 뒤 `finally` 로 지운다.

그래서 murmur 가 그 디렉터리만 가리키면 미로그인이 된다. 재사용하려면 남의 앱 사설
저장소를 읽어 같은 복사·삭제를 흉내내야 하고, Orca 의 삭제와 경합한다. **의존하지 않는다.**

murmur 는 자기 계정 디렉터리를 갖는다. 그 디렉터리에서 한 번 로그인하면 claude 가
`Claude Code-credentials-<hash8>` 를 durable 하게 만들어 두고 아무도 지우지 않는다.

## 4. 설계

### 4-1. 계정 풀 — 새 모듈 `claudeAccounts.ts`

계정은 `~/.murmur-agent/claude-accounts/<name>/` 에 산다.

**러너 상태 디렉터리 밖에 두는 것이 요점이다.** 계정은 에이전트·인스턴스·서버를 가로지르는
자산이다. `resolveAgentStateDir` 아래에 두면 에이전트마다, 인스턴스마다 다시 로그인해야 한다.
`codexHomeDir` 가 러너별인 이유(개인 config 격리)와 목적이 반대다.

- 목록은 그 뿌리의 **하위 디렉터리를 읽어** 만든다. 별도 설정 파일을 두지 않는다 — 디스크가
  진실이다(`ensureCodexHome` 이 `auth.json` 존재로 판정하는 것과 같은 규율. 설정 파일을 두면
  파일과 디스크가 갈리는 날이 오고, 그날 러너는 없는 계정을 가리킨다).
- 순서는 **이름 사전순**으로 고정한다. 예측할 수 없으면 로그를 읽어도 어느 계정이 다음인지
  알 수 없다.
- `MURMUR_CLAUDE_ACCOUNTS` (쉼표 구분)로 순서와 부분집합을 뒤집을 수 있다. 목록에 없는 이름이
  오면 **기동을 실패시킨다** — `config.ts::validateInstance` 와 같은 이유다. 조용히 무시하면
  운영자가 계정 B 라고 믿고 띄운 러너가 A 로 돈다.
- 뿌리는 `MURMUR_CLAUDE_ACCOUNTS_DIR` 로 옮길 수 있다(테스트와, 계정을 다른 볼륨에 두는 경우).
- **풀이 비면 `CLAUDE_CONFIG_DIR` 를 주입하지 않는다.** 지금 동작 그대로 시스템 기본을 쓴다.
  하위 호환이 이 한 줄에 걸려 있다.

계정 이름 문법은 `[a-z0-9-]{1,32}` — `INSTANCE_PATTERN` 과 같다. 경로 세그먼트가 되므로.

### 4-2. env 주입 — `turn.ts`

`childEnv` 가 claude 하네스일 때 `CLAUDE_CONFIG_DIR` 를 넣는다. `CODEX_HOME` 과 같은 자리,
같은 모양이다.

함께 **`HARNESS_ENV_DENYLIST` 에 인증 주입 키 넷을 더한다**:
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`,
`AWS_BEARER_TOKEN_BEDROCK`.

이유: 이 중 하나라도 부모 env 에 있으면 claude 는 그것을 먼저 쓰고 config 디렉터리 격리가
**조용히** 무력해진다. 계정을 바꿨는데 안 바뀌는 이번 결함의 다른 얼굴이다. 러너는 데몬 env
전체를 상속하므로(§1) 이 키가 어디서 들어올지 우리가 통제할 수 없다. Orca 도 같은 판단을
했다(실측: `stripAuthEnv` 의 대상 배열이 정확히 이 넷이다).

`HARNESS_ENV_DENYLIST` 주석의 규율("새로 넣을 키는 실측을 먼저 하라")을 지킨다 — 이 넷은
claude 문서가 밝힌 인증 입력이고, Orca 가 같은 목적으로 지우는 것을 실측으로 확인했다.

### 4-3. 세션 경로 — `claudeSessions.ts`

`claudeSessionFileExists` 의 `~/.claude/projects` 하드코딩을 **주입한 config 디렉터리 기준**
으로 바꾼다.

안 바꾸면: 계정 디렉터리로 돌린 세션의 파일은 `<configDir>/projects` 에 생기는데 판정은
`~/.claude/projects` 를 본다. "파일 없음"으로 읽어 다음 턴을 첫 턴으로 조립하고,
claude 는 이미 쓰인 세션 id 를 `--session-id` 로 다시 받아 `Session ID <uuid> is already
in use.` 로 즉사한다. 이 모듈 주석이 이미 그 함정을 적어 뒀다.

호출부(`interactiveTurn.ts`)가 config 디렉터리를 넘긴다. 기본값은 지금 그대로 유지해
풀이 빈 경우가 안 바뀐다.

### 4-4. 페일오버 — `main.ts` + `policy.ts`

**방아쇠 둘.** `isQuotaExhausted(err)` 가 참이거나 `isCredentialFailure(err)` 가
`harness-credential` 이면 계정을 바꾼다.

후자는 지금 `exitIfUnrecoverable` 이 러너를 죽인다. **풀에 아직 안 써 본 계정이 있으면 죽지
않는다.** 그 판단이 옳은 이유: "재시도로 낫지 않는다"가 죽는 근거였는데(`exit.ts` 주석), 계정을
바꾸는 것은 재시도가 아니라 **다른 조건으로 다시 하는 것**이다. 풀을 소진하면 그때는 원래대로
죽는다 — 근거가 되살아난다.

**같은 멘션을 그대로 다시 시도한다.** `done.push` 하지 않는다.

계정 축은 `MAX_ATTEMPTS`(재시도 회계)와 **별개**로 돌고, 계정 수만큼만 돈다. 정확히:

- 계정 전환은 `attempts` 를 **올리지 않는다**. 그 회계는 "같은 조건으로 또 해 봤다"를 세는
  것이고, 계정을 바꾼 것은 조건이 달라진 것이다.
- 한 계정에서 **한 번** 시도한다. 그 계정에서 방아쇠(한도·자격증명)를 만나면 재시도 없이 다음
  계정으로 간다 — 그 실패는 그 계정에서 재시도로 낫지 않는다는 것이 이미 판정된 사실이다.
- 방아쇠가 아닌 평범한 실패는 계정을 바꾸지 **않고** 지금의 재시도 회계로 그대로 간다.

두 축을 곱하면 계정 3개 × 재시도 3회 = 9번을 태우게 되고, 그중 8번은 이미 답을 아는 실패다.

**전환 시 그 스레드의 세션 레코드를 초기화한다** — `sessionId = null`, `turnsRun = 0`,
`lastFedSeq = 0`.

왜 버리는가: claude 세션 파일은 계정 디렉터리 안에 있어 계정을 넘어가지 않는다. 남겨 두면
`-r <id>` 가 없는 세션을 재개하려 든다. 왜 잃는 것이 적은가: `prompt.ts` 의
`isFirstTurn = lastFedSeq === 0` 이 첫 턴에 **자기 발화를 포함한 스레드 전체**를 먹인다.
claude 내부 컨텍스트는 잃지만 스레드의 사실은 프롬프트로 온전히 복원된다.

**버린 대안**: 세션을 보존하고 스레드를 계정에 못박는 길(`SessionRecord` 에 계정을 적고 그
스레드는 그 계정으로만 돌린다). 컨텍스트를 안 잃지만 한도에 걸린 그 멘션에 끝내 답할 수 없다 —
계정을 바꾼 목적 자체를 못 푼다.

풀을 전부 소진하면 지금의 통지를 그대로 남긴다(`quotaNotice` / `harnessLoginNotice`).

**`policy.ts`**: `HARNESS_CREDENTIAL_PATTERNS` 에 `/notloggedin/i` 를 더한다. 실측 문구는
`Not logged in · Please run /login`, 공백 제거 후 `Notloggedin·Pleaserun/login`.
`/login` 쪽이 아니라 `notloggedin` 을 쓰는 이유: 후자가 더 길고 특이하다 — `/login` 은 사람의
프롬프트에도 흔히 나온다(그 오탐 위험은 이 파일 주석의 `#380` 절이 이미 적어 뒀다).

### 4-5. 관측

러너 로그에 **어느 계정으로 돌렸는지** 적는다. 계정 **이름만** — 이메일·토큰·Keychain 서비스명은
적지 않는다. 전환할 때는 전환했다는 사실과 사유(한도 / 자격증명)를 적는다.

지금 로그에는 시각이 없다. 이번 조사에서 "그 턴이 재로그인 전인가 후인가"를 판정할 수 없었던
원인이 그것이다. **이 설계 범위에서는 고치지 않는다** — 별건이고, 후속으로 남긴다.

## 5. 사람이 해야 하는 일 — 계정 등록

러너가 대신 할 수 없다. OAuth 로그인은 브라우저를 요구한다.

```sh
mkdir -p ~/.murmur-agent/claude-accounts/lime
CLAUDE_CONFIG_DIR=~/.murmur-agent/claude-accounts/lime claude
# 뜬 화면에서 /login → 브라우저에서 그 계정으로 로그인 → 닫는다
```

계정마다 한 번씩. **두 번째 계정부터는 브라우저 시크릿 창**을 써야 한다 — 그러지 않으면 기존
세션 쿠키를 재사용해 같은 계정으로 다시 로그인된다.

확인:

```sh
CLAUDE_CONFIG_DIR=~/.murmur-agent/claude-accounts/lime \
  claude -p 'reply with OK'   # → OK
```

## 6. 테스트

RED 먼저 쓴다.

| 대상 | 확인 |
|---|---|
| `policy.ts` | `Not logged in · Please run /login` → `harness-credential`. PTY 소프트랩(개행 삽입)에도 걸린다 |
| `claudeAccounts.ts` | 하위 디렉터리 목록·사전순, 빈 풀은 빈 배열, `MURMUR_CLAUDE_ACCOUNTS` 순서·부분집합, 없는 이름은 throw, 이름 문법 위반은 throw |
| `turn.ts` | claude 는 `CLAUDE_CONFIG_DIR` 주입, codex 는 미주입, 풀 없으면 미주입, denylist 넷이 자식 env 에서 사라진다 |
| `claudeSessions.ts` | 주어진 config 디렉터리의 `projects` 를 본다, 기본값은 `~/.claude/projects` 그대로 |
| `main.ts` 통합 | 첫 계정 한도 → 둘째 계정으로 **같은 멘션** 성공, 세션 레코드 초기화 확인, 전부 소진 시 통지 1건, 계정 축이 `MAX_ATTEMPTS` 를 곱하지 않는다 |

실물 검증(테스트가 대신할 수 없는 것): 계정 둘을 등록하고 러너를 띄워, 첫 계정을 일부러
못 쓰게 만든 뒤 멘션이 둘째 계정으로 답되는지 본다.

## 7. 범위 밖

- 서버·DB·데스크탑 UI. 계정 선택을 에이전트 정의(`AgentConfig`)에 넣는 것은 별건이다.
- Orca 계정 재사용(§3).
- 러너 로그의 타임스탬프(§4-5).
- codex 다중 계정. 같은 모양으로 확장할 수 있지만 이번 요구가 아니다.

## 8. 실물 검증 결과 (2026-09-07)

실제 `claude` 2.1.263 바이너리와 러너의 실제 코드 경로(`loadClaudeAccounts` →
`buildTurnCommand` → `runPtyTurn` → `switchesAccount` → `withAccountFailover`)를 엮어
확인했다. murmur 서버·PAT 없이 돌렸다 — 살아 있는 러너를 띄우면 진짜 멘션을 집는다.

**통한 것.**

- 풀 로드와 사전순: 두 계정이 이름순으로 나왔고, `MURMUR_CLAUDE_ACCOUNTS="zdead,lime"` 이
  순서를 뒤집었다.
- `CLAUDE_CONFIG_DIR` 가 계정마다 실제로 자식 env 에 들어갔다.
- 인증 주입 키 넷이 자식 env 에서 사라졌다(부모에 심어 두고 확인).
- 미로그인 계정에서 실제 claude 가 `Not logged in · Please run /login` / 종료 1 을 냈고,
  `switchesAccount` 가 참을 돌려줬다 — §4-4 의 새 패턴이 실물 출력에 걸린다.
- **핵심 시나리오**: 못 쓰는 계정을 먼저 두면 `zdead → lime` 전환이 일어나고 살아 있는
  계정이 답했다. 첫 계정이 멀쩡하면 전환 없이 첫 계정에서 끝났다(둘째를 건드리지 않았다).
- 모든 계정이 방아쇠에 걸리면 마지막 오류가 호출자에게 전달됐다 — 기존 한도·자격증명 경로가
  그대로 받는다.

**안 통해서 고친 것.**

- **심볼릭 링크 계정이 목록에서 빠졌다.** `Dirent.isDirectory()` 는 심볼릭 링크에 대해
  거짓이다(실측: `isDirectory=false, isSymbolicLink=true`). 이미 로그인된 config 디렉터리를
  이름 붙여 풀에 넣는 것은 정당한 구성이고(`codexHome.ts` 도 auth.json 을 링크로 재사용한다),
  그 구성이 조용히 무시됐다. `stat`(링크를 따라간다)으로 다시 재도록 고쳤다 — 끊어진 링크와
  파일을 가리키는 링크는 계속 걸러진다.

**검증하지 못한 것.**

- 두 개의 **서로 다른 실제 계정**으로 도는 페일오버. 계정 등록은 브라우저 OAuth 를 요구해
  사람만 할 수 있다(§5). 성공 경로는 시스템 기본 로그인을 심볼릭 링크로 풀에 넣어 확인했다 —
  자격증명을 복사하지 않았다.
- 데스크탑 앱이 띄운 실제 러너에서의 동작. 기동 로그의 계정 목록 줄과 전환 줄은 코드 배선까지만
  확인했다.
