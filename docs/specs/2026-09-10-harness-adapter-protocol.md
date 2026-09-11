# 하네스 어댑터 프로토콜 (2026-09-10)

## 1. 문제

murmur 는 하네스를 늘려야 한다(codex·cursor·opencode…). 그런데 하네스 차이가 **하드코딩된
이름 비교로 일곱 파일에 흩어져 있다**:

| 파일 | 이름 비교가 정하는 것 |
|---|---|
| `mentionTurn.ts:691` | `usesTui` — 실행 모드, 프롬프트 전달, 시간 한도, 탐침 |
| `pty.ts` | 준비 신호·관문 패턴(두 하네스 것이 정규식 하나에 합쳐져 있다) |
| `workspaceTrust.ts:160` | 신뢰 장부의 갈래와 자리 |
| `harnessErrors.ts:66,127` | 세션 기록을 해석하는가 |
| `policy.ts` | tail 문구로 재는 자격증명·한도 실패 |
| `interactiveTurn.ts:62` | 이어받기 거절 |
| `claudeAccounts.ts` · `mentionTurn.ts:850` | 계정 축과 페일오버 |

`turn.ts` 의 `HarnessPreset` 은 이미 옳은 모양이다 — `allowsNullSessionOnFirstTurn` 처럼
**성질을 표의 필드로** 두고 이름 비교를 하지 않는다. 그 규율이 argv 조립 밖으로 뻗지 않은
것이 문제의 전부다. 셋째 하네스를 붙이는 사람은 위 일곱 곳을 직접 찾아야 한다.

## 2. 관측 — 프로토콜은 이미 MCP 다

murmur 는 하네스의 **출력을 파싱하지 않는다.** 발화·진행·중단·질문은 에이전트가 murmur MCP
도구로 직접 한다. 그래서 하네스가 화면에 무엇을 그리든 상관없고, 요구할 것은 넷뿐이다:

1. TUI 로 뜬다
2. 프롬프트를 받을 **준비 신호**를 화면에 낸다
3. **bracketed paste** 로 여러 줄 프롬프트를 받는다
4. **MCP 서버 하나**를 붙일 수 있다

**TUI 캡슐화가 전제다.** codex 의 `exec`(headless)는 개발 과정의 산물이고 목표가 아니다 —
`exec` 으로 뜬 턴은 fd 0 이 일반 파일이라 사람이 끼어들 수 없다(관찰 전용). 터미널을 보여
주는 이유가 개입인데 그 제약을 받아들일 근거가 없다.

## 3. 계약 — 4층, T0 만 필수

`packages/agent/src/adapters/contract.ts` 가 이 표다.

| 층 | 항목 | 없으면 |
|---|---|---|
| **T0** | `command` · `executionModel` · `screen{ready,gate}` · `trust` · `mcpRegistration` · `systemPromptDelivery` · `allowsNullSessionOnFirstTurn` · `supportedMentionPermissions` | 못 붙인다 |
| **T1** | `transcript` — 기록의 자리·배치·**해석 여부** | 정지·API 에러 탐침 없음, 사용량 "모름". **돈다** |
| **T2** | `account` — config 디렉터리 env, 풀 표면 유무 | 계정 하나로 돈다(페일오버 없음) |
| **T3** | `effort` · `skillDirs` · `interactiveHandoff` | 기본값으로 돈다 |

층을 가르는 것이 이 설계의 핵심이다. T1·T2 를 필수로 두면 새 하네스마다 사용량 파서와 로그인
흐름을 먼저 만들어야 하고, 그러면 하네스 추가가 다시 몇 주 일이 된다. 없는 관측은 **"모른다"로
그린다** — 이 저장소가 이미 쓰는 규율이다(`claudeUsage.ts` 가 퍼센트를 내지 않는 이유).

### 이 표는 로직을 갖지 않는다

담는 것은 값(정규식·환경변수 이름·파일 이름·갈래 태그)뿐이다. 판정 함수는 지금 자리에
그대로 둔다. 로직을 표로 복사하면 같은 규칙이 두 벌이 되고, 그 순간 나중에 한쪽만 고치는
사고가 난다.

## 4. 검증 전략 — 옛 경로를 남긴다

**claude-code 가 안 돌면 murmur 앱 자체를 쓸 수 없다.** 그래서 표를 들이는 것과 호출부를
표로 옮기는 것을 분리한다:

1. **(이 커밋)** 표를 만들고 `test/adapterParity.test.ts` 가 표의 값이 지금 프로덕션과 **같은
   답을 내는지** 대조한다. **호출부는 하나도 바뀌지 않는다** — claude 경로는 글자 하나 안 바뀐다.
2. 호출부를 하나씩 `harnessAdaptersEnabled()`(`MURMUR_HARNESS_ADAPTERS=1`, 기본 꺼짐) 뒤로
   옮긴다. 켜지 않은 러너는 계속 옛 경로로 돈다.
3. 실물 검증(멘션 왕복·인터랙티브·중단·계정 전환)이 끝난 뒤 기본값을 켜고, **다음** 릴리스에서
   옛 분기를 걷는다.

스위치를 1단계에 함께 넣는 이유: 나중에 넣으면 그 커밋이 "표를 읽게 바꾸는 것"과 "스위치를
만드는 것" 두 변경을 겹치게 되고, 문제가 났을 때 어느 쪽 탓인지 가릴 수 없다.

### 패리티 테스트가 재는 방법

**가능한 곳에서는 값이 아니라 행동으로 잰다.** `effort` 는 태그를 비교하지 않고 그 태그로부터
기대 argv 를 만들어 `buildTurnCommand` 의 실제 출력과 대조하고, `trust` 는 실제로
`ensureWorkspaceTrusted` 를 돌려 표가 말한 파일이 적혔는지 본다. 태그만 비교하면 표와
프로덕션이 같은 오해를 공유해도 초록이다.

행동으로 잴 수 없는 자리(`executionModel.mention`·`account.pooled`·`interactiveHandoff`)는
**잠금**으로 둔다 — 그 사실이 아직 호출부의 지역 표현이라 표에서 끌어낼 수 없다. 잠금은 두 곳이
함께 움직이도록 강제하는 것이 목적이고, 호출부가 표를 읽게 되는 조각에서 행동 테스트로
교체하고 지운다.

테스트에 이빨이 있는지는 **돌연변이로 확인했다**: codex 어댑터의 `trust.file`·`transcript.parsed`
·`effort.key`·`skillDirs` 를 각각 틀린 값으로 바꿨더니 정확히 그 넷을 재는 테스트만 빨개졌다.

## 5. 자동화 — 하네스 추가를 반나절로

새 하네스를 붙이는 사람의 할 일을 **어댑터 하나 + 화면 fixture 몇 장**으로 줄인다. 검사는
이미 있는 두 층이 한다:

- `test/acceptance-cli.test.ts` — 조립한 argv 를 **실물 `--help` 의 옵션 목록과 정적 대조**한다
  (CLI 가 없는 CI 는 건너뛴다). codex 의 `-s` 사고 3건이 여기서 잡힌다.
- `test/fixtures/*.txt` — 실물 화면. 준비 신호·관문 판정이 여기 고정된다.

여기에 **`certify <harness>`** 를 더한다(다음 조각): 실물 CLI 로 왕복을 태운다 — TUI 부팅 →
준비 신호 → 주입 → murmur MCP 로 발화 → resume → `Ctrl+C` 중단. 지금 `RUNNABLE_HARNESSES` 에
들어가는 기준이 *"실물로 첫 턴+resume 왕복을 봤는가"* 인데 그 확인이 사람 손이다.

## 6. codex 의 실행 모드에 대해

`CODEX_ADAPTER.executionModel.mention` 은 아직 `'exec'` 이다. **목표가 아니라 현재 상태다.**
`'tui'` 로 바꾸는 데 필요한 것은 대체로 이미 있다:

- 신뢰 대화상자 — `workspaceTrust.ts::trustForCodex` 가 격리된 `<CODEX_HOME>/config.toml` 에
  `trust_level = "trusted"` 를 적고, `ensureWorkspaceTrusted` 가 codex 에도 배선돼 있다.
  (이것이 없어서 전환을 보류했다는 판단이 한때 있었는데, 그 사이 구현됐다.)
- 준비 신호 — `Ask <이름> to do anything` 이 `codex-tui-ready.txt` fixture 로 고정돼 있다.

남은 것은 실물 왕복 확인이고 그것이 `certify` 의 일이다. `exec` 경로(`stdinFile` ·
`composeSpawn` 의 `sh -c '… < 파일'` 래핑)는 **지우지 않는다** — 준비 신호를 아직 측정하지
못한 신규 하네스의 임시 발판으로 남긴다.

## 7. 단계

| | 내용 | 선행 |
|---|---|---|
| **P0** | 이 커밋 — 계약 + 두 어댑터 + 패리티 테스트 (호출부 무변화) | 없음 |
| P1 | `certify` + 적합성 스위트 일반화 | P0 |
| P2 | 호출부를 스위치 뒤로 이설, eslint 로 `adapters/` 밖 이름 비교 금지 | P0 |
| P3 | codex 를 TUI 로 | P1·P2 |
| P4 | **세 번째 하네스로 계약을 증명** — 둘로는 계약이 우연히 맞는다 | P3 |
| P5 | T2 계정 축 일반화(하네스별 풀·로그인·사용량) | P4 |

P4 를 P5 앞에 두는 이유: 계정 축을 먼저 일반화하면 그 설계가 claude·codex 둘의 모양에만
맞춰지고, 세 번째 하네스가 그 모양을 깨면 두 번 만들게 된다.

## 8. 범위 밖

- **desktop 의 계정 풀 UI 수정.** `AgentsSettings.tsx` 가 하네스를 보지 않아 codex 에이전트에도
  claude 풀 선택을 그리는 결함은 이 계약과 **독립**이다(어댑터의 `account.pooled` 가 그 답을
  들고 있지만, 화면을 고치는 것은 별 커밋이다).
- **`policy.ts` 의 tail 문구 목록.** 하네스별로 갈라야 하지만 codex 의 실제 한도·자격증명
  문구를 측정한 적이 없다 — 지어내지 않고 P1 의 `certify` 가 실물에서 걷어 오게 한다.
