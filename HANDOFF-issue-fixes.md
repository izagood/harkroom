# 인계 — murmur 이슈 수정 (dorado → seabass)

> dorado 워크트리 세션이 오늘 러너 재구축(PR #79)을 머지하고, 검토·도그푸딩으로 이슈 16건을
> 등록한 뒤 수정을 시작하려던 참에 넘긴다. **git 에 커밋하지 마라** — 인계용 스크래치다.
> 다 읽었으면 지워라.

## 0. 지금 무엇이 돌고 있나 (건드리기 전에 읽어라)

**사용자가 지금 이 murmur 로 도그푸딩 중이다.** 죽이지 마라.

| 것 | 어디 | 비고 |
|---|---|---|
| 서버 | `localhost:3400` | dorado 워크트리 코드에서 `pnpm --filter @murmur/server start`, nohup |
| postgres | `localhost:5432` | **`rusalka` compose 프로젝트의 컨테이너**(`rusalka-postgres-1`). 실데이터 있음 |
| 러너 | `@forge` | `~/murmur-dogfood/forge.env` (mode 600) 에 PAT |
| 데스크탑 | tauri dev | dorado 에서 기동 |
| 로그 | `~/murmur-dogfood/logs/` | server·runner-forge·desktop |
| 백업 | `~/murmur-dogfood/pre-008-*.dump` | 008 적용 **전** 덤프 |

옛 `rusalka-server-1` 컨테이너는 **정지시켜 뒀다**(3400 을 넘기려고). 되돌리려면
`docker start rusalka-server-1` 인데, 그러면 두 서버가 한 DB 를 보게 되니 먼저 새 서버를 죽여라.

마이그레이션 008 은 **컬럼 추가만**이라 옛 코드와 호환된다 — 롤백이 "되돌리기"가 아니라
"안 쓰기"다.

## 1. 무엇이 머지됐나

PR #79 (`fff3c9b`), 41 커밋. 러너를 "멘션마다 프로세스"에서 **"스레드마다 디스크 세션 +
PTY"** 로 재구축했다. 읽어야 할 것:

- `docs/specs/2026-09-01-runner-sessions-pty-design.md` — 설계와 그 근거
- `docs/plans/2026-09-01-runner-sessions-phase1.md` — 11 태스크 계획 + 하단에 **스파이크 실측
  기록**(claude/codex/gemini CLI 의 실제 플래그·세션 저장소 구조). 표를 고칠 일이 있으면 여기부터.

핵심만: 세션은 `{avcs workspace dir, harness session id, lastFedSeq, turnsRun}` 로 디스크에
있고, harness 는 PTY 안에서 돌고, **에이전트가 스스로 murmur MCP 로 발화한다**(러너는 출력을
파싱하지 않는다). 러너는 턴이 끝난 뒤 "발화가 있었나"만 확인한다.

## 2. 이슈 16건과 우선순위

전부 `izagood/murmur` 에 등록돼 있고 본문에 `file:line` 근거가 있다.

**사용을 막는 것 (도그푸딩이 찾았다 — 먼저 고칠 것)**
- **#95 새 에이전트가 `@` 자동완성에 안 보인다.** 아래 §3 에 진단과 착수 지점이 있다.
- **#93 PAT 재발급 UI 없음.** 서버엔 발급·폐기 API 가 **둘 다 있다**. UI 만 없다.
- **#94 에이전트 삭제가 서버에도 없다.** `message.author_id` FK 가 **RESTRICT**(cascade 아님)라
  하드 삭제는 FK 위반으로 실패한다 — 소프트 삭제/비활성 플래그가 현실적이다.

**조용한 실패 (팀 확대의 전제)**
- **#80 스레드 200 건 넘으면 영구 침묵.** `messages.ts:207-214` 가 `order by seq limit` 로
  **가장 오래된** N 을 준다. 바로 아래 216-227 행이 역방향 페이지에 대해 정답 패턴을 주석으로
  적어 뒀는데 스레드 분기에 안 갔다. 덤으로 `mcpPlugin.ts:31-35` 에 `limit` 키가 없어 러너가
  보낸 값이 zod 에 버려진다. **채널 최상위는 안전하다**(그 분기는 desc 로 잡아 되돌린다).
- **#81 실패 턴이 `lastFedSeq` 를 저장해 재시도가 무력화된다.** `mentionTurn.ts:223`.
  재시도가 빈 델타를 보고 하네스를 안 돌리고 성공 반환 → 멘션이 읽음 처리. `MAX_ATTEMPTS=3`
  이 죽어 있다. **권고(정밀 검토)**: 실패 턴엔 `workspaceDir` 과 codex 가 *실제로 발견한*
  `sessionId` 만 저장하고 **`turnsRun` 은 올리지 마라** — claude 의 uuid 는 러너가 발급만 했을
  뿐 등록됐다는 증거가 없어서, resume 을 걸면 두 번째 실패를 만든다. `turnsRun` 을 0 으로 두면
  `isFirstTurn` 이 true 로 남아 같은 uuid 로 `--session-id` 재실행이 되고 그게 그 플래그의 의미다.
- **#82 소진·실패한 멘션이 채널에 흔적을 안 남긴다.** #81 과 묶어 고쳐라 — 둘이 겹쳐서
  실패가 통째로 안 보인다.

**선행 조건**
- **#89 codex 가 avcs workspace 를 "신뢰되지 않은 디렉터리"로 거부한다.** 폴백 한정이 아니다 —
  `avcs workspace project` 결과물도 git repo 가 아니라 정상 경로에서도 거부된다.
  `--skip-git-repo-check` 가 `codex exec` 와 `codex exec resume` **양쪽에 있음을 확인했다**.
  고칠 때 `CODEX_PRESET` 에 **필드**로 넣어라 — `buildTurnCommand` 안에 harness 이름 분기를
  만들면 이 모듈의 설계("어댑터가 아니라 표")를 깬다.

**나머지**: #83 harness 집합 3개 불일치 · #84 Working directory 안내 문구 거짓 · #85 에이전트
PATCH 감사 누락 · #86 codex 가 전역 MCP 상속(strict 대응물 없음) · #87 `isCredentialFailure` 가
120열에서 접힌 PTY 출력을 읽음 · #88 spec §10 "수용" 층이 산문으로만 존재 · #90 한 턴 다중 발화 ·
#91 문서 드리프트 체크리스트 · #92 argv 로 지시문·대화 원문 노출.

## 3. #95 착수 지점 (여기까지 조사해 뒀다)

**교착이다.** 데스크탑은 계정 목록을 부트 시 한 번 읽고(`controller.ts:31-40`), 갱신은
`refreshAccounts()`(`controller.ts:159-167`) 하나뿐인데 호출부가 **셋뿐이고 셋 다 같은 모양**이다
(`87/102/112`): *처음 보는 계정이 이미 메시지·리액션·타이핑을 했을 때*. 새 에이전트는 아무것도
안 했고, **자동완성에 없으니 부를 수 없고, 못 부르니 활동이 없어 갱신도 안 온다.**

서버는 결백하다 — `directoryRoutes.ts:5-10` 이 필터 없이 전부 준다.

- `Composer.tsx:42-43,63-67` 이 같은 `store.accounts` 를 읽는다. `query` 가 null → 값이 되는
  순간이 자동완성이 열리는 시점이다.
- `Composer` 는 이미 `getController()` 를 쓴다(`notifyTyping`). `refreshAccounts` 가 `private`
  이라 공개만 하면 된다.
- `accountsInFlight` 합류(`controller.ts:158-166`)가 이미 있어 요청 폭주는 안 난다 — 확인됨.
- `shared/src/index.ts:135-142` 의 `WsServerEvent` 에 `account.*` 이벤트가 **없다**. 모든
  클라이언트를 고치려면 그것을 신설하는 길도 있으나 비용이 크다.
- 테스트: `packages/desktop/test/composer.test.tsx` (컨트롤러를 스텁하지 않는다 — `notifyTyping`
  이 어떻게 통과하는지 먼저 확인해라). 헬퍼는 `test/helpers/fakeApi.ts` 의 `acc()`.

## 4. 이 작업의 방법론에서 남길 것

이 브랜치는 같은 함정에 **다섯 번** 물렸고 전부 같은 모양이다: **테스트가 입력을 직접 만들어
프로덕션 생성자를 우회한다.** 가짜 harness 가 실제 CLI 가 거부하는 플래그를 받아줬고,
`hang` 픽스처가 SIGTERM 에 순순히 죽어 SIGKILL 경로가 한 번도 안 돌았고, `pty.test.ts` 가
`{...process.env}` 를 손으로 펼쳐 프로덕션의 env 결함을 가렸고, `turn.test.ts` fixture 가
`/mcp` 붙은 URL 을 써서 codex 의 미정규화를 가렸다. 마지막 둘은 **실물을 돌려서야** 나왔다.

fixture 를 쓸 때 **"이 값을 프로덕션은 어디서 얻는가"** 를 물어라.

또: spec §10 이 정의한 "수용" 층 — 조립한 argv 를 실제 CLI 가 **파싱하는지만** 확인하는 검사 —
이 저장소에 없다(#88). §4 플래그 표를 고칠 일이 있으면 그 검사부터 만드는 편이 낫다.

## 5. 상태

- 브랜치 `izagood/fix-silent-failures` 를 dorado 에서 만들었으나 **커밋 0개**다. 무시하고
  seabass 에서 새로 파도 된다(`izagood/seabass` 가 `fff3c9b` 로 main 과 같다).
- 사용자의 상시 방침: 승인 안 묻고 PR, CI 통과하면 머지. 다만 이번 브랜치처럼 큰 것은 보고 후 판단.
- 사용자가 도그푸딩하며 새 이슈를 계속 낼 것이다. 우선순위가 바뀔 수 있다.
