# 세 번째 하네스 실측 — opencode (2026-09-11)

`opencode 1.18.24`, macOS. 목적은 **계약이 옳은지 확인하는 것**이다 — 둘로는 계약이 우연히
맞으므로 세 번째 하네스를 계정 축 일반화보다 **먼저** 붙이기로 했다
(`2026-09-10-harness-adapter-protocol.md` §7 의 P4).

결론부터: **계약이 두 자리에서 틀렸고, 둘 다 이 측정이 찾아냈다.** 실행 경로를 열기 전에
찾은 것이 이 순서의 값이다.

## 1. 계약이 고쳐진 자리

### 1-1. 계정 축은 환경변수 **하나**가 아니다

claude 는 `CLAUDE_CONFIG_DIR`, codex 는 `CODEX_HOME` 하나로 config·auth·세션이 함께
움직인다. opencode 는 XDG 를 따르므로 **셋을 함께** 줘야 움직인다.

```
$ XDG_CONFIG_HOME=<c> XDG_DATA_HOME=<d> XDG_STATE_HOME=<s> opencode debug paths
config  <c>/opencode      data  <d>/opencode      state  <s>/opencode      log  <d>/opencode/log

$ OPENCODE_CONFIG_DIR=<t> opencode debug paths
… 아무것도 움직이지 않는다 (이름은 있으나 이 경로를 바꾸지 않는다)
```

하나를 빼먹으면 **반쪽 격리**가 된다 — 자격증명은 갈리는데 세션은 공유된다. 그 상태는
조용하다: 계정을 바꿨다고 믿는 러너가 남의 세션을 이어받는다. 그래서
`AccountAxis.configDirEnv` 를 `string` 에서 **`readonly string[]`**(함께 세팅해야 하는
목록)으로 바꿨다.

### 1-2. 세션 기록이 파일이 아닐 수 있다

opencode 는 세션을 **SQLite** 에 담는다(`<data>/opencode.db` — 이 기계에서 804MB). 대신
CLI 로 물어볼 표면을 준다:

| | |
|---|---|
| `opencode session list` | 세션 목록 |
| `opencode export <sessionID>` | 한 세션 전체를 JSON 으로 |
| `opencode stats` | 토큰·비용 통계 |

`TranscriptSource` 가 "config 디렉터리 아래 파일 경로 + 형식"만 표현했으므로 여기에는
없는 경로를 지어내야 했다. 갈래로 나눴다 — `TranscriptFiles`(claude·codex) /
`TranscriptCli`(opencode).

**이 갈래가 claude 보다 낫다.** claude 의 사용량을 세기 위해 `claudeUsage.ts` 는 수십 MB
JSONL 을 직접 파싱한다(*"물어볼 곳이 없다"*가 그 파일 머리의 이유다). opencode 는 물어볼
곳이 있으므로 스키마가 바뀌어도 우리 파서가 깨지지 않는다. 대신 프로세스를 띄우는 값이
비싸므로 **정지 탐침처럼 주기적으로 재는 용도에는 주기·상한을 정해야 한다.**

## 2. 측정된 T0 — 네 요구를 만족한다

| 요구 | opencode | 근거 |
|---|---|---|
| TUI 로 뜬다 | `opencode [project]` 가 **기본 커맨드**다 | `--help` |
| 준비 신호 | **`Ask anything…`** (입력 자리표시자) | 실물 PTY 캡처 → `test/fixtures/opencode-tui-ready.txt` |
| 프롬프트를 받는다 | `--prompt` 플래그 있음. **붙여넣기 주입은 미측정** | `--help` |
| MCP 를 붙인다 | `opencode mcp add` 로 config 에 기록 | `opencode mcp --help` |

**준비 신호가 지금 패턴으로는 안 잡힌다.** 프로덕션의 `DEFAULT_READY_PATTERN` 은 claude 의
`❯`+U+00A0 와 codex 의 `Ask … to do anything` 둘만 아는데, opencode 의 자리표시자는 그
어느 쪽도 아니다. 합쳐진 정규식 하나로 계속 가면 세 번째 하네스의 첫 턴은 준비 신호를 못
보고 상한에서 실패한다 — **화면 계약을 하네스별로 갈라야 하는 실물 근거다.**
회귀선: `test/adapterParity.test.ts` 의 "지금 패턴으로는 못 잡는다".

세 신호가 서로 겹치지도 않는다(그것도 회귀선으로 고정했다) — 겹치면 표가 아니라 판정
자체를 다시 설계해야 했다.

### 부팅 시간 — 처음 잰 값이 틀렸다 (2026-09-11 정정)

`script(1)` 로 잰 첫 측정은 *"12초에 스플래시, 30초에 입력창"* 이었다. **프로덕션 경로로
다시 재니 2.5초였다.** `certify`(node-pty + `runPtyTurn`, 곧 러너가 쓰는 그 코드)로 두 번
돌려 2.5초·2.4초를 봤다.

차이의 원인은 재는 도구다 — `script` 는 창 크기를 안 주고 TERM 도 다르다. **하네스를
프로덕션이 쓰지 않는 방법으로 재면 프로덕션과 다른 답이 나온다**는 것이 이 정정의 교훈이고,
`certify` 가 판정 함수와 PTY 를 베끼지 않고 그대로 부르는 이유이기도 하다.

비교: 같은 방법으로 claude 는 0.3초다.

### 신뢰 대화상자가 없다

`git init` 한 빈 임시 디렉터리에서 바로 입력창까지 갔다 — codex 처럼 폴더 신뢰를 묻는
화면이 없었다. (git 저장소가 아닌 디렉터리는 아직 안 재 봤다.)

## 3. 측정된 나머지

| 층 | 항목 | 값 |
|---|---|---|
| T0 | 세션 사전 할당 | **불가.** `session` 에 `list`·`delete` 만 있고 `create` 가 없다 → codex 처럼 `allowsNullSessionOnFirstTurn: true` |
| T0 | resume 문법 | `-s, --session <id>` / `-c, --continue` / `--fork` (플래그 존재 확인, 왕복은 미측정) |
| T0 | 권한 `auto` | `--auto` (*"auto-approve permissions that are not explicitly denied (dangerous!)"*) |
| T0 | 권한 `readonly` | **미측정.** `--agent` 나 config 의 permission 키일 수 있다 |
| T2 | auth 자리 | `<data>/auth.json` **0600** — codex 와 같은 모양이므로 `ensureCodexHome` 의 "로그인만 링크로 재사용" 수법이 그대로 옮겨진다 |
| T2 | 로그인 | `opencode providers`(별칭 `auth`) — **앱 안에서 몰 수 있는 후보가 있다** |
| T3 | effort | `--variant`(*"provider-specific reasoning effort, e.g. high, max, minimal"*) |
| T3 | 모델 | `-m provider/model` |
| T3 | 스킬 | `opencode debug skill` 로 목록을 볼 수 있다(자리는 미측정) |

## 4. 아직 재지 않은 것 — `certify` 가 할 일

지어내지 않고 목록으로 남긴다. 이 목록이 곧 `certify` 의 검사 항목이다.

1. **bracketed paste 주입이 먹히는가** (T0 의 세 번째 요구). 플래그(`--prompt`)로는 되지만
   그것은 argv 라 `ps` 에 샌다(#92) — murmur 가 쓰는 길은 주입이다.
2. **resume 왕복** — `-s <id>` 가 앞 턴의 사실을 유지하는가.
3. **세션 id 발견** — 첫 턴 뒤 방금 만든 세션을 어떻게 고르는가(`session list` 출력 형식).
4. **`readonly` 권한**의 실제 수단.
5. **MCP 등록** — `mcp add` 가 쓰는 config 형식, 그리고 턴별 오버라이드가 가능한지
   (불가능하면 계정 config 를 우리가 써야 하고, 그러면 `mcpRegistration` 에 갈래가 하나 더 붙는다).
6. **`Ctrl+C` 중단**이 턴만 끊는가.
7. **XDG 셋으로 격리한 홈에서 실제로 첫 턴이 도는가** — 1-1 은 `debug paths` 로만 확인했다.

## 5. 여담 — opencode 에는 ACP 가 있다

`opencode acp` 는 Agent Client Protocol 서버를 띄우고, `opencode serve` 는 headless 서버다.
murmur 가 지금 하는 일(TUI 를 PTY 로 몰기)과 **다른 층의 통합 경로**다. 지금 범위는 아니지만
기록해 둔다: 그 길이 성립하면 화면 계약(준비 신호·관문 판정)이 필요 없어진다. 다만 그것은
하네스마다 ACP 를 지원해야 하는 이야기이고, PTY 는 지원 여부를 묻지 않는다는 것이 지금
설계가 PTY 를 고른 이유다.
