# 러너 재구축 — 스레드 세션 · PTY · 관찰과 개입 (통합 설계)

- 날짜: 2026-09-01 (갱신: 2026-09-04)
- 상태: Phase 1 착지 · Phase 2 는 **관찰만** 착지(#141, PR #308) — 개입(입력·인터랙티브
  기동·멘션 큐잉)은 #315 로 재개, 상세는 §5-2 와
  [`../plans/2026-09-04-runner-sessions-phase2.md`](../plans/2026-09-04-runner-sessions-phase2.md)
- **대체**: `2026-09-01-acp-harness-design.md` (bc3af87) — 기각 근거는 부록 A
- 관련: [`design.md`](../design.md) §1 §4, [`roadmap.md`](../roadmap.md) §5,
  avcs `docs/16-workspace-scope.md` · `docs/20-workspace-bridge.md`
- 후속 spec: S2 에이전트 메모리, S3 워크스페이스 스킬 (§12 가 접합면)

## 0. 요구 — 두 개가 하나로 합쳐졌다

1. **에이전트에 기억이 없다.** 러너가 멘션마다 프로세스를 띄우고 죽여, 같은 스레드의
   두 번째 멘션이 첫 대화를 모른다.
2. **에이전트 작업이 안 보인다.** 기본은 안 보이는 게 맞지만, 원할 때 들어가서
   claude code 가 실제로 뭘 하는지 보고 **직접 개입**할 수 있어야 한다. 재구성한
   뷰가 아니라 *"터미널에 들어가서 작업하는 것을 동일하게"* (사용자 원문).

둘의 답이 같은 구조에서 나온다: **세션을 디스크 위의 상태로 두고, PTY 를 그 상태를
여는 뷰로 둔다.** 기억은 세션이 주고, 관찰·개입은 뷰가 준다.

## 1. 핵심 모델 — 세션은 상태, PTY 는 뷰

**세션 = `{ avcs workspace dir, harness session-id }`** — 스레드당 하나, 둘 다 디스크에
있다. 프로세스보다 오래 산다. 러너가 죽어도 아무것도 잃지 않는다 — 다음 멘션에 resume
하면 이어진다.

PTY(프로세스)가 존재하는 경우는 셋뿐:

| 계기 | 동작 | 끝 |
|---|---|---|
| 멘션 | `resume <id> "<멘션 컨텍스트>"` 비대화형 | 턴 끝 = 프로세스 종료 |
| 사람이 [▶ 터미널] | `resume <id>` 인터랙티브 | 사람이 닫을 때 |
| 멘션 턴 중 사람이 들어옴 | 새로 안 띄움 — **그 PTY 에 attach** | 턴 끝 또는 사람이 이어받음 |

이 모델이 지우는 것: 유휴 감지, 유휴 타임아웃, 상주 프로세스, "러너 재시작 = 세션
소실". 스레드가 100개여도 프로세스는 진행 중인 턴 수만큼이다.

**부수 효과가 곧 요구 충족이다:** 사람이 인터랙티브로 개입한 내용도 같은 session-id 에
누적되므로, 다음 멘션 때 에이전트가 "사람이 뭘 고쳐줬는지"를 이미 안다.

## 2. 아키텍처

```
┌─ desktop (Tauri2 + React) ────────────────────────┐
│  스레드에 [▶ 터미널] 칩 · xterm.js 패널            │
│  칩은 러너 소유자에게만 보인다                     │
└──────────┬─────────────────────────────────────────┘
           │ ① REST: 세션 목록 · attach  ② WS: 바이트 (기존 티켓 재사용)
┌─ murmur server ───────────────────────────────────┐
│  세션 레지스트리(인메모리) · 권한 판정 · 감사       │
│  바이트 릴레이 — ★ 해석하지 않는다 (불투명 우체국)  │
└──────────┬─────────────────────────────────────────┘
           │ ③ 러너가 건 상시 outbound WS (러너는 포트를 열지 않는다)
┌─ runner (사람의 로그인 세션 안) ───────────────────┐
│  avcs workspace project → PTY spawn → 감독         │
│  ring buffer 256KB/세션 (메모리만)                 │
└──────────┬─────────────────────────────────────────┘
           │ ④ pty
    claude / codex / gemini   ← 로컬 로그인 · murmur MCP · avcs MCP
```

탈락안과 이유 (brainstorming 에서 기각):

- **B: 서버가 직접 spawn** — 작동 불가. 서버 컨테이너에는 사람의 Keychain 도 OAuth
  세션도 없다. `design.md` 의 "상주 러너 MVP 제외"와도 어긋난다.
- **C: 데스크탑 ↔ 러너 직결** — 러너가 청취 포트를 열고 인증·TLS 를 재구현해야 한다.
  관찰 하나 때문에 두 번째 보안 표면을 만들지 않는다.

A 를 고른 실제 이유는 지연이 아니라 **경계**다. 서버는 관찰자로 남고(`design.md` 결정 1),
인증 표면이 하나로 유지된다.

**avcs 경계 하나를 명시한다:** `avcs workspace project` 는 쓰기다. `design.md` 결정 1이
서버를 "오브젝트 쓰기 경로에 끼지 않는다"로 못박았으므로 **project 는 러너가 한다.**
서버의 avcs 클라이언트(`avcs/client.ts`)는 읽기 둘(`waitForChange`/`fetchSince`)로 남는다.

## 3. 세션 수명

### 스코프와 생성

스코프 = `(channelId, threadRootId)`. 스레드 안의 멘션은 그 스레드의 루트 id 를 쓰고,
**채널 최상위 멘션은 그 멘션 메시지 자신을 루트로 삼는다**(#98). 그래서 이 값은 프로덕션
경로에서 항상 non-null 이다.

초판은 스코프를 `(channelId, threadRootId ?? '_root')` 로 두고 그 근거를 "`design.md` §4
멘션 고정의 '대화 단위'와 같은 선"이라고만 적었다. 그 근거는 세션 스코프를 논증한 자리가
아니었고(§4 는 어떤 handle 이 다음 메시지에 자동으로 붙는가를 다룬다), 실제 영향은 이랬다:
한 채널의 **모든** 최상위 멘션이 `_root` 하나로 뭉쳐 서로 무관한 요청이 하네스 세션 하나에
누적됐다. README 가 새 사용자에게 안내하는 첫 진입점(채널에서 `@handle` 부르기)이 정확히
그 경로였다.

멘션 자신을 루트로 삼으면 두 가지가 함께 해결된다:

1. **세션 격리** — 멘션마다 키가 달라 맥락이 섞이지 않는다. 그 스레드 안의 후속 멘션은
   이미 `threadRootId` 를 갖고 있어 같은 키로 이어진다.
2. **채널 가독성** — 여러 문단짜리 답이 채널 본문이 아니라 스레드에 들어간다.

서버 변경은 필요 없다 — `message.post` 가 이미 `threadRootId` 를 받는다. 실패 통지
(`FAILURE_NOTICE`)도 **같은 앵커**를 써야 한다: 답은 스레드로 가는데 통지만 채널 최상위에
남으면 부른 사람이 스레드를 보는 동안 실패를 놓친다.

첫 멘션 시 러너가:

1. `avcs workspace project murmur-<agentHandle>-<threadShort> --out <dir>` — 물리 격리.
   이름에 handle 이 들어가는 이유: 한 스레드에 에이전트 여럿이 붙으면 스레드만으로는
   이름이 겹쳐 두 번째 project 가 실패하거나 격리가 무너진다. workspace 는 **에이전트당**이다.
   git worktree 를 쓰지 않는 이유: murmur 의 전제가 "기층이 git 이 아니라 avcs"다
   (avcs `docs/16`: *"git worktree 우회는 avcs 단독 버전관리 전제에 어긋난다"*).
2. session-id 확보 — harness 에 따라 갈린다 (§4 표):
   - claude·gemini: **러너가 UUID 를 발급**해 `--session-id` 로 준다
   - codex: 사전 할당이 없다. 첫 턴 종료 후 발견해 저장한다. 초판은 발견처를
     `~/.codex/session_index.jsonl` 로 적었는데 **실측이 뒤집었다** — 그 파일에는 cwd
     필드가 없고 `codex exec` 세션은 애초에 거기 기록되지도 않는다. 진짜 저장소는
     `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<uuid>.jsonl` 이고, 첫 줄
     (`session_meta`)의 payload 에 cwd 가 있다(`codexSessions.ts` 상단 주석 — `--json`
     파싱 대안을 기각한 이유 포함)
3. 러너 로컬 상태 파일에 기록: `~/.murmur-agent/<agentHandle>/sessions.json` —
   `{threadKey: {workspaceDir, sessionId, harness, lastFedSeq}}`. **러너 머신의 사실은 러너 머신에
   둔다** — workspace 경로는 서버가 알 필요도, 알아서도 안 되는 값이다(경로 유출).
   서버는 러너가 접속 시 알려주는 세션 **목록**(id·스레드·상태)만 인메모리로 안다.

### 갱신과 폐기

- **지시문·모델 반영은 자동으로 유지된다.** 프로세스가 턴마다 새로 뜨고 지시문은
  매 턴 `--append-system-prompt` 로 주입되므로, UI 수정이 다음 답변부터 반영되는
  기존 성질(로드맵 §1)이 **세션 무효화 장치 없이** 산다. (ACP 안이 필요로 했던
  "정의 변경 시 전량 폐기"가 여기서는 아예 불필요하다 — 부록 A.)
- workspace 정리(land 후 디렉터리 삭제)는 v1 수동. 에이전트가 avcs 로 스스로 land
  하는 것은 기존 도그푸딩 흐름 그대로다.
- `--fork-session` 은 쓰지 않는다 — resume 시 새 id 를 만들어 맥락이 갈린다.

### 동시성

멘션 턴은 러너당 **한 번에 하나**(현행 poll 배치의 순차 처리 유지). 스레드가 달라도
줄 세운다 — 로컬 로그인 하나가 rate limit 을 공유하므로 병렬의 실제 상한은 계정
한도이고, v1 에서 병렬화는 이득보다 폭주 위험이 크다. 사람 인터랙티브 턴은 예외로
동시에 존재할 수 있다(사람이 자기 눈으로 본다).

사람이 조종 중인 스레드에 멘션이 오면: 큐에 두고 스레드에 메시지 —
*"@fizz 는 지금 jaebin 이 직접 조종 중 — 대기 1건"*. 사람이 닫으면 러너가 처리한다.

**에이전트가 여럿이면 그 격리·경합은 이렇게 갈린다.** 같은 스레드에 @forge 와
@scout 이 붙으면 러너가 서로 다른 프로세스이므로 둘은 병렬로 돈다(직렬화는 러너
안에서만). 각자 자기 workspace·세션을 가지며(위 이름 규칙), 서로의 스레드 발화는
`lastFedSeq` 경계(§4)로 다음 턴에 들어온다. **코드 경합은 murmur 가 아니라 avcs 가
관리한다** — lease·intent·decision 이 그 용도다(`design.md` §1). murmur 층에서 두
에이전트의 채팅 발화는 그냥 독립 메시지다.

## 4. 턴 실행 — harness 플래그 표

어댑터가 아니라 **표**다. 러너는 하네스의 출력을 해석하지 않는다.

아래 표는 **실측으로 확정됐다**(스파이크, 계획 문서의 "스파이크 결과" 절). 초판의
추정값 네 곳이 틀렸고 여기에 반영돼 있다.

| | claude | codex | gemini |
|---|---|---|---|
| 새 세션 | `--session-id <uuid>` (우리가 발급) | 사전 할당 불가 — 첫 턴 후 발견 | 미지원 (아래) |
| 멘션 턴 (비대화형) | `-p -r <id> "<ctx>"` | `codex exec resume <id> "<ctx>"` | — |
| 사람 턴 (인터랙티브) | `-r <id>` | `codex resume <id>` | — |
| 지시문 주입 | `--append-system-prompt` | 프롬프트 앞 접두 | — |
| MCP 등록 | `--mcp-config <파일>` | 턴별 `-c mcp_servers.*` | — |
| 권한: auto | `--permission-mode bypassPermissions` | `-c sandbox_mode="workspace-write"` | — |
| 권한: readonly | `--permission-mode plan` | `-c sandbox_mode="read-only"` | — |

세 칸이 초판과 다른 이유를 남긴다.

- **codex 의 MCP 는 `codex mcp add` 가 아니다.** 그 명령은 `~/.codex/config.toml` 을
  **영구 변경**하는데, §6 이 금지한 "하네스 밖에 정책을 쌓는 행위"가 정확히 그것이다.
  턴별 `-c mcp_servers.*` 오버라이드가 같은 일을 하고 흔적을 남기지 않는다(실측 확인).
- **`codex exec` 에는 `-a`/`--ask-for-approval` 이 없다.** 권한은 sandbox 단독이고,
  `danger-full-access` 는 쓰지 않는다 — 멘션 턴은 사람이 보지 않는 턴이라 workspace 경계를
  넘길 이유가 없고, 그 경계가 §3 의 avcs workspace 격리와 정확히 겹친다.

  **그런데 `-s` 플래그로는 안 된다.** 이 표의 첫 수정판은 `-s workspace-write` 로 적었는데,
  리뷰가 실제 CLI 로 돌려 깨뜨렸다: `codex exec resume <id> -s workspace-write` →
  `error: unexpected argument '-s' found`. `-s` 는 **비-resume `codex exec` 에만** 있고
  `codex exec resume` 의 옵션 목록에는 없다(`-c`, `-m`, `--last`, `--all` 등뿐). 즉 이 표의
  "새 세션" 행과 "권한" 행이 codex 에서는 **직교하지 않는다** — 첫 턴에 통하는 플래그가
  resume 턴에서 파싱 오류를 낸다.

  그래서 **두 턴 모두 `-c sandbox_mode="…"` 하나로 간다.** `sandbox_mode` 는 codex 자신의
  마이그레이션 문서가 쓰는 실제 설정 키이고(`sandbox_mode = "workspace-write"`), `-c` 는
  `codex exec` 와 `codex exec resume` 양쪽에 있다. 기전을 하나로 두면 직교하지 않는 조합이
  애초에 생기지 않는다.

  **남길 교훈**: 플래그가 부모 서브커맨드에 있다는 사실이 자식 서브커맨드에도 있다는 뜻이
  아니다. 스파이크는 `codex exec --help` 만 보고 exec 계열 전체로 일반화했고, `codex exec
  resume --help` 의 실제 목록은 자기 기록 안에 있었으나 결론에 반영되지 않았다.
- **gemini 는 이번 범위에서 미지원이다.** `-r` 이 UUID 가 아니라 `"latest"` 또는 인덱스를
  받아 `--session-id` 와 짝을 이루지 못한다. 게다가 개발 머신의 gemini 계정이 API 접근을
  잃어 왕복 측정 자체가 불가였다. `AGENT_HARNESSES` 에는 남기되 `buildTurnCommand` 가
  **명확한 미지원 에러로 거절**한다 — `design.md` §4 의 "없는 것을 있다고 표시하지 않는다".

**MCP 설정은 `--strict-mcp-config` 와 함께 간다** (§7). 러너가 생성하는 설정에는
murmur(http, `${MURMUR_PAT}`)와 avcs(stdio, `avcs mcp`) 둘만 들어간다.

#### argv 노출 — 해소됨 (#92, #117)

초판은 이 절을 "알려진 한계"로 적었다 — 지시문·스레드 델타가 argv 로 나가고, *"PTY 안에서
stdin 파이프를 쓸 수 없으므로(pty는 터미널이다)"* 구조적 한계라고 했다. **그 전제가 실측으로
뒤집혔다**: claude·codex 모두 exec/print 모드에서 stdin 에 TTY 를 요구하지 않는다. 지금은
프롬프트가 argv 에 실리지 않는다.

- **지시문**: `writeSystemPromptFile()` 이 0600 파일로 쓰고 claude 는
  `--append-system-prompt-file <path>` 로 받는다(#92). codex 는 지시문을 stdin 파일에
  합쳐 받는다.
- **스레드 델타(대화 본문)**: `writePromptFile()` 이 0600 파일로 쓰고, `composeSpawn`
  (`pty.ts`)이 `sh -c 'exec <argv…> < <file>'` 리다이렉트로 감싼다(#117). `exec` 을 반드시
  넣어 시그널이 sh 가 아니라 하네스에 닿는다.
- `stdinFile` 이 `null` 인 턴(인터랙티브)은 감싸지 않는다 — 그 턴의 stdin 은 PTY 여야 한다.

부수 효과로 초판이 걱정한 `ARG_MAX` 초과(긴 대화의 스폰 실패)도 함께 사라졌다 — 본문이
argv 에 없다.

멘션 턴의 프롬프트 컨텍스트(`<ctx>`)는 기존 `reply.ts::buildReplyRequest` 산출물을
문자열로 넘긴다 — 이 순수 로직은 그대로 산다. 단 세션이 맥락을 이미 가지므로
**resume 턴에는 새 메시지들만** 넘긴다(전체 스레드 재전송은 첫 턴만).

*새*의 기준은 상태 파일의 `lastFedSeq` 다 — 이 세션에 마지막으로 넘긴 메시지 seq.
resume 턴은 그 이후의 스레드 메시지 **전부**(다른 에이전트·사람 발화 포함)를 넘기고
값을 전진시킨다. 이 경계가 없으면 다중 에이전트 스레드에서 각 에이전트가 자기와
대화한 사람만 기억하고 **동료 에이전트가 한 일을 모른다** — 같은 스레드에서 협업이
아니라 독백 두 개가 된다. 사람 인터랙티브 턴도 끝나면 `lastFedSeq` 를 당긴다(사람이
터미널에서 한 말은 스레드 밖이므로 세지 않고, 그 사이 스레드에 쌓인 것만).

### 발화 경로

에이전트가 PTY 안에서 murmur MCP 로 **스스로 `message.post`** 한다. 러너는 화면을
읽지 않는다 — TUI 스크린 스크레이핑은 하네스 버전마다 깨진다.

**대가와 대책:** 지금은 러너가 발화를 보장한다. 자율 발화는 에이전트가 조용히 끝낼
수 있다 — 회귀다. 프로세스 종료가 곧 턴 종료이므로 정확히 판정할 수 있다: 러너가
exit 후 그 스레드를 `message.read` 로 읽어 **턴 시작 이후 자기 메시지가 있는지** 확인,
없으면 시스템이 아니라 **러너가 에이전트 계정으로** 스레드에 남긴다:
*"(답 없이 턴을 끝냈습니다 — exit 0, 발화 없음)"*. 조용한 실패를 조용히 두지 않는
기존 방침(`policy.ts` 의 자격증명 처리)과 같은 판단이다.

### 턴 타임아웃

비대화형 턴은 `AGENT_TURN_TIMEOUT_MS`(기본 30분) 를 넘기면 SIGTERM → 5초 → SIGKILL.
avcs 작업은 정당하게 길 수 있어 짧게 잡지 않되, 무한 대기(예: 하네스가 플래그를
무시하고 입력을 기다림)는 반드시 끊는다.

초판은 *"타임아웃도 '발화 없음' 검사를 거친다"* 고 적었는데 구현이 의도적으로 다르게
착지했다(`mentionTurn.ts`): 실패 턴(타임아웃·exit ≠ 0)은 발화 여부를 **관측만** 해서
`lastFedSeq` 전진 판단에 쓰고, "(답 없이 턴을 끝냈습니다)" 통지는 **정상 종료(exit 0)
턴에만** 올린다. 실패 턴은 `MAX_ATTEMPTS` 소진 후 `FAILURE_NOTICE` 가 한 번 통지하므로,
실패마다 "발화 없음"을 또 올리면 같은 실패가 스레드에 두 번 뜬다 — 이중 통지 방지가
근거다. 이 문서가 코드를 따라간다.

## 5. 관찰과 개입 (attach)

### 소유자

**attach 는 러너 소유자만.** 다른 멤버에게는 칩 자체가 안 뜬다 — "기본은 안 보임"
이라는 원 요구와 맞고, 내 맥의 셸이 워크스페이스 멤버십만으로 열리지 않는다.

서버가 소유자를 알아야 하므로 `agent_config.owner_account_id` 를 추가한다(§6
마이그레이션에 동승). 에이전트 생성 시 생성자로 기본 설정, admin 이 변경 가능,
null 이면 아무에게도 칩이 없다(기존 행 backfill 은 하지 않는다 — 추측 소유자는
소유자가 아니다).

**터미널은 스레드당 하나가 아니다.** 세션이 (에이전트, 스레드)당 하나이므로 한
스레드에 세션이 N개일 수 있다 — 칩은 **에이전트별로** 뜬다(`[▶ forge]` `[▶ scout]`),
각각 소유자 판정을 따로 받는다. `GET /agent-sessions` 응답이 sessionId 단위인 것과
같은 결이다.

### 릴레이

- **러너 → 서버**: 상시 outbound WS `GET /agent-relay` (신규). 인증은 **PAT 헤더** —
  러너는 브라우저가 아니라 헤더를 실을 수 있으므로 티켓이 필요 없다(티켓은 URL 노출
  문제의 해법이었다). 접속 시 세션 목록을 announce 하고, 이후 변동(턴 시작/끝)을 알린다.
- **데스크탑 → 서버**: `GET /agent-sessions`(내 소유 러너의 것만) →
  `POST /agent-sessions/:id/attach` → 기존 `ws/tickets.ts` 단회용 티켓 → WS.
- 메시지 형 (JSON, 서버는 `data` 를 열지 않는다):
  - 서버→데스크탑: `{type:'output', data:base64}` · `{type:'status', state:'running|ended|runner-offline'}`
  - 데스크탑→서버: `{type:'input', data:base64}` · `{type:'resize', cols, rows}`
- **이벤트 버스를 타지 않는다.** `events.ts` 는 단일 브로드캐스트 + audience 필터라
  세션 바이트를 흘리면 전 클라이언트 홍수다. 릴레이는 서버 안의 전용 맵
  `(sessionId → runnerSocket, Set<viewerSocket>)` 으로 소켓 쌍을 직결한다.
- **스크롤백**: 러너의 ring buffer(세션당 최근 256KB, 프로세스 살아있는 동안만) 를
  attach 시 재생 → xterm 이 화면을 재구성. **DB 에 저장하지 않는다** — PTY 출력에
  비밀이 섞인다.
- **writer 규칙**: 마지막 attach 가 writer, 나머지 읽기 전용, resize 는 writer 를 따른다.
  (**"resize 는 writer 를 따른다"는 §5-3 에서 좁아졌다** — 관찰 전용 세션에는 침범당할
  writer 가 없어, 차례를 가진 창이면 못 쳐도 폭은 정한다, #369.)
  초판은 근거를 "소유자만 붙으므로 동시 attach 는 같은 사람"이라 적었는데, 서버 구현은
  admin 의 attach 도 허용한다(`checkOwnerOrAdmin`) — 사람이 달라도 규칙은 같다(마지막
  attach 가 이긴다). 소유자와 admin 이 동시에 타이핑하는 경합은 잠금이 아니라 이 규칙
  하나로 정리한다: 바이트가 섞이는 상태 자체를 만들지 않는다.
- **감사**: attach / detach / 입력 바이트 **수**만 `audit_log` 에 남긴다. 입력 내용은
  남기지 않는다(프롬프트에 비밀이 들어갈 수 있다) — "감사에 본문을 복사하지 않는다"는
  기존 원칙 그대로.
- PTY 크기: 비대화형 턴 기본 `120x40`. attach 시 writer 의 크기로 resize.

### §5-2. 개입 — 착지 현황과 확정 결정 (2026-09-04)

Phase 2 는 **관찰까지만** 착지했다(#141, PR #308): 릴레이·소유자 게이트·ring 재생·status
통지가 위 서술대로 돌고, `input`/`resize` 는 코드가 "범위 밖" 주석으로 유예했다
(`shared/src/index.ts` `RelayServerFrame` 주석, `agentRelayRoutes.ts`, `TerminalPanel.tsx`).
유예의 이유였던 미결 질문(#315)에 답이 정해졌고(2026-09-04, 사용자 확정), 개입 구현은
[`../plans/2026-09-04-runner-sessions-phase2.md`](../plans/2026-09-04-runner-sessions-phase2.md)
가 계획한다. 여기에는 **결정만** 남긴다.

같은 날 PR #338 이 input 절반을 먼저 구현했다 — 결정 1 은 그대로 구현됐고, 결정 2(writer
규칙·caps)와 결정 3(감사 방식)은 그 PR 이 다르게 착지해 조정이 필요하다(차이는 PR #338
코멘트에 기록). **어긋나면 이 문서가 우선이다**(운영자 확정).

1. **멘션 턴에 입력을 허용하고, 그 턴의 권한 모드는 유지한다.** **← 폐기됐다(§5-3, #369).**
   전제("사람이 그 턴의 프롬프트에 답할 수 있다")가 프로덕션 경로에서 성립하지 않는다 —
   아래 문단은 그 결정이 무엇이었는지 남겨 두는 기록이다. §6 표 3행("모드 변경
   불가")이 그대로 산다 — `readonly` 로 도는 턴의 프롬프트에 사람이 답할 수는 있지만
   턴의 플래그는 바뀌지 않는다. attach 가 소유자·admin 으로 좁혀져 있으므로 이것은
   "내 머신의 내 에이전트에 대한 개입"이다.
2. **프레임 계약.** 뷰어→서버 `AttachClientFrame`(`input`/`resize`, base64) 신설,
   서버→뷰어에 `{type:'writer', writer}` 통지 추가, 서버→러너 `RelayServerFrame` 을
   유니온으로(`input`·`resize`·`viewer.count`·`interactive.open`), 러너→서버에
   `interactive.opened`/`interactive.error`, announce 에 `caps: ['input','interactive']`.
   서버는 여전히 `data` 를 열지 않는다 — 입력 바이트 수도 base64 길이 **산술**로 센다.
   구/신 조합 4방향 전부 안전해야 한다: 구 러너는 미지 프레임을 버리고(caps 부재를 서버가
   보고 포워딩 안 함), 신 데스크탑은 `writer` 프레임이 안 오면 읽기 전용으로 남는다.
3. **입력 감사는 detach 시 합산 1회.** 키 입력마다 감사 행을 쓰면 행 타임스탬프가 곧
   키스트로크 타이밍이라 그 자체가 부채널이다. 기존 `agent.detached` detail 에
   `inputBytes` 를 싣는다 — 내용은 여전히 남기지 않는다(§5 원칙).
4. **인터랙티브 기동.** `POST /agent-sessions/interactive`(소유자·admin, attach 와 같은
   술어) → 서버가 러너로 `interactive.open` 프레임 → 러너가 세션을 확보(없으면 생성)해
   인터랙티브 턴을 띄우고 `interactive.opened` 로 응답 → 서버가 attach 티켓 반환.
   감사 액션 `agent.interactive.opened` 신설 — 셸을 여는 것은 관찰보다 강한 행위다.
5. **인터랙티브 턴의 끝은 둘이다.** 1차: 프로세스 exit(사람이 하네스 안에서 종료 — "프로세스
   종료 = 턴의 끝" 원칙 유지). 2차: viewer 가 0 이 된 뒤 유예(기본 60초) 지나면 러너가
   SIGTERM→SIGKILL 로 회수한다 — 패널 닫힘·소켓 단절·앱 강제종료가 서버 관점에서 전부
   "viewer 소멸" 하나로 수렴하고, 세션은 디스크라 kill 로 잃는 것이 없다. 명시적 종료
   프레임은 두지 않는다.
6. **멘션 큐잉은 inbox 가 곧 큐다.** 사람이 인터랙티브로 조종 중인 스레드(§3)의 멘션은
   `markRead` 도 attempts 증가도 없이 건너뛴다 — inbox 의 at-least-once 가 그대로 큐가
   되고, 러너가 재시작하면 인터랙티브 PTY 도 함께 죽으므로 유예가 저절로 풀린다. 통지
   ("지금 {handle} 이(가) 직접 조종 중 — 대기 N건")는 러너가 에이전트 계정으로 entry 당
   1회만 올린다. 유예 대상은 **인터랙티브 턴뿐** — 멘션 턴에 사람이 attach 만 한 경우
   그 턴은 어차피 돌고 있으므로 막지 않는다.
7. **인터랙티브 턴이 끝나면 `lastFedSeq` 를 전진하되, 대기 멘션의 min seq − 1 로
   클램프한다.** 클램프 없이 전진하면 큐에서 나온 멘션 턴의 델타 프롬프트가 비어 그 부름이
   조용히 소실된다 — §3 의 "사람이 닫으면 러너가 처리한다"와 "인터랙티브 턴도 lastFedSeq 를
   당긴다"가 교차하는 지점이다.
8. **codex 인터랙티브는 게이트가 있다.** `codex resume` 이 `--ignore-user-config` 를 받지
   못하면(§13 스파이크로 확정) codex 인터랙티브 턴은 **명확한 에러로 거절**한다 — 무방비로
   운영자 config.toml(개인 MCP 포함)을 상속하는 경로를 열지 않는다. gemini 의 "없는 것을
   있다고 표시하지 않는다" 판례와 같은 결.

   **2026-09-04 후속 결정:** codex-cli 0.153.2에서도 실제 파서는 그 플래그를 거부했지만,
   러너별 `CODEX_HOME`에 기존 auth만 연결하면 개인 config/MCP 없이 대화형 resume이
   완주했다. 따라서 게이트의 보안 조건을 이 격리로 충족하고 codex 인터랙티브를 연다.
   상세 증거와 수용 기준은 `docs/plans/2026-09-04-codex-harness-activation.md`에 있다.

### §5-3. 결정 1 은 폐기됐다 — 멘션 턴은 관찰 전용이다 (#369, 2026-09-04)

결정 1("멘션 턴에 입력을 허용한다")은 **전제가 틀렸다.** 그 결정은 "사람이 그 턴의 프롬프트에
답할 수 있다"를 전제했는데, 프로덕션 멘션 턴에는 답할 자리가 없다: §4 의 argv 노출 해소(#117)
이후 프롬프트는 파일로 가고, 그래서 `composeSpawn` 이 `sh -c 'exec <하네스> ... < <파일>'` 로
감싼다 — 자식의 fd 0 은 PTY slave 가 아니라 **일반 파일**이다. 파일이 EOF 에 닿은 뒤 PTY
master 에 쓴 바이트는 자식에게 도달하지 않는다(#369 재현·회귀선 고정).

그래서 **`stdinFile` 이 non-null 인 턴에는 writer 차례를 주지 않는다.** 판정은 하네스 종류
(`claude -p` 인지)가 아니라 fd 0 의 정체 하나로 한다 — 원인이 하네스가 아니므로, 하네스가
늘어도 이 판정은 안 깨진다. 러너가 그 사실(`AgentSessionView.acceptsInput`)을 announce 에
실어 보내고, 게이트는 서버 한 곳이다(화면만 막으면 attach 소켓을 직접 여는 경로가 뚫린다).

**§5 의 "resize 는 writer 를 따른다"도 여기서 좁아진다.** 그 규칙의 근거는 "읽기 전용 창이
폭을 줄이면 writer 의 작업 환경이 좁아진다"였고, 그것은 writer 가 **존재할 때만** 성립한다.
관찰 전용 세션에는 침범당할 writer 가 없고, 폭은 stdin 과 무관하게 ioctl 로 자식에 그대로
닿는다. 그래서 차례 하나가 능력 둘을 나른다: 폭은 차례를 가진 창이면 언제나, 입력은 그
세션이 실제로 받을 수 있을 때만. 순서 규칙(마지막 attach 가 차례)은 하나 그대로다.

그리고 **화면이 이유를 말한다**(`WriterDeniedReason`). `writer:false` 만 보내면 화면이 원인을
지어내고, 실제로 그랬다 — 아무도 안 붙은 멘션 턴에서 "다른 창이 입력 중"이라고 적혔다.
러너가 `acceptsInput` 을 아예 안 싣는 구 러너면 이유는 `'observe-only'` 가 아니라
`'runner-outdated'` 다: 확인한 적 없는 사실을 확인한 척하지 않는다.

§1 표 3행("멘션 턴 중 사람이 들어옴 → 그 PTY 에 attach")의 의미는 **관찰**로 좁아진다.
사람이 진행 중인 턴을 이어받는 길(같은 하네스 세션 id 의 인터랙티브 resume 으로 handoff)은
**#380 / 후속 이슈**로 따로 서 있다 — 이 결정은 그것을 막지 않는다. handoff 가 생기면
writer 를 여는 조건이 "stdinFile 이 없다"에서 "인터랙티브 턴이다"로 바뀔 뿐이다.

## 6. 권한 — 턴 종류로 갈라진다

같은 세션이라도 **누가 화면 앞에 있느냐**로 답이 달라진다:

| 턴 | 화면 앞에 | 정책 |
|---|---|---|
| 멘션 (비대화형) | 없음 — 물으면 영원히 멈춘다 | `mention_permission` 컬럼: `auto`(기본) / `readonly` → §4 플래그 표 |
| 사람 인터랙티브 | 있음 — 묻는 게 곧 "직접 개입"의 값 | **플래그를 아예 안 준다** = 하네스 기본(묻는다). 사람이 터미널에서 답한다 |
| 멘션 턴에 attach | 있지만 프로세스는 이미 떠 있음 | 모드 변경 불가 — 그 턴의 모드 유지(명시적 한계) |

컬럼 이름을 `mention_permission` 으로 **턴 종류에 스코프** 해 둔다 — 나중에 attach
턴용 정책이 필요해지면 열이 하나 더 생기는 것이지 의미가 갈라지는 게 아니다.

```sql
-- 008_agent_runner.sql
alter table agent_config
  add column mention_permission text not null default 'auto',
  add column owner_account_id uuid references account(id) on delete set null;
```

값 검증은 애플리케이션(004 의 harness 판례). **배포 노트: 기존 에이전트의 권한이
넓어진다** — `claude -p` 기본값에 막히던 도구가 `auto`(bypass) 아래서 통과한다.
좁힐 에이전트는 배포 후 `readonly` 로 바꾼다.

ACP 안의 "`allow_always` 금지"에 해당하는 원칙의 번역: **하네스의 영구 설정을 바꾸는
플래그·명령을 쓰지 않는다.** 권한은 매 턴 플래그로만 준다 — murmur 밖에 정책이
쌓이면 UI 스위치가 장식이 된다.

## 7. 자격증명

- **모델 자격증명은 murmur 를 통과하지 않는다.** 하네스가 사람의 로컬 로그인
  (claude: Keychain+`~/.claude/.credentials.json`, codex: `~/.codex/auth.json`)을 쓴다.
  `agent_config` 에 키 컬럼이 없는 것은 누락이 아니라 정답이다.
- **PAT 는 env 로 간다.** MCP 설정 파일에는 `${MURMUR_PAT}` 플레이스홀더만 두고
  (파일은 비밀이 아니다), 실값은 PTY 자식 env 로 넘긴다. **실측 확인 완료** — 리스너로
  실제 도착 헤더가 `Bearer <실값>` 임을 확인했다. 현행 `mkdtemp`+평문 `mcp.json`+
  미삭제(누적 결함)가 이것으로 사라진다. argv 로 JSON 문자열을 넘기는 방식은 쓰지
  않는다 — `ps` 에 PAT 가 뜬다.
- **`--strict-mcp-config` 를 쓰고, 설정에 murmur + avcs 만 넣는다.** 이 문서의 초판은
  반대로 적었다 — "에이전트가 avcs MCP 도 물어야 하므로 strict 는 그것을 끊는다". **거짓
  전제였다.** 설정 파일을 우리가 만들므로 avcs 를 그 안에 넣으면 된다(`avcs mcp`, stdio,
  env 없음 — 실측 확인).

  틀린 채로 뒀을 때의 대가가 실측으로 드러났다. strict 없이 띄우면 하네스가 **운영자의
  전역 MCP 목록 전체를 상속한다.** 개발 머신에서 확인한 실제 목록: Slack·Gmail·Google
  Drive·Calendar 가 `connected`. 즉 채널에서 `@handle` 을 부를 수 있는 사람이면 누구나
  에이전트를 시켜 운영자의 메일을 읽을 수 있다 — **murmur 멤버십이 곧 운영자 개인 계정
  접근이 된다.** §5 가 attach 를 소유자로 좁혀 "내 맥에 남의 셸이 열리는 것"을 막았는데,
  이 구멍은 셸 없이 같은 곳에 도달한다.

  좁혀서 잃는 것은 "에이전트에 MCP 를 더 붙이는 표면"이고 `agent_config` 필드로 나중에
  열 수 있다. 넓힌 채 두어서 잃는 것은 자격증명이다. 비대칭이 크다.
- 러너는 사람의 로그인 세션에서 돈다. launchd 데몬화 시 Keychain 접근은 별건 검증(§13).

## 8. 실패 처리

| 상황 | 처리 |
|---|---|
| harness 실행 파일 없음 | 즉시 크게 실패(러너 종료) — 재시도로 낫지 않는다 |
| 자격증명 실패 (exit + stderr 패턴) | `policy.ts::isCredentialFailure` 유지 — 러너 종료 + 로그인 안내 |
| 턴 exit ≠ 0 | 항목 실패 계상(`MAX_ATTEMPTS`), stderr 꼬리를 러너 로그에 |
| exit 0 + 발화 없음 | 에이전트 계정으로 "(답 없이 턴을 끝냈습니다)" (§4) |
| 턴 타임아웃 | SIGTERM→SIGKILL, 실패 계상 |
| 러너 재시작 | **무손실** — 세션은 디스크. 재접속 후 announce 로 레지스트리 복원 |
| 서버 재시작 | 러너 relay WS 백오프 재접속(기존 poll 계약과 같은 규약). viewer 는 재-attach |
| attach 중 러너 사망 | viewer 에 `{type:'status', state:'runner-offline'}` — 조용한 멈춤 금지 |
| attach 중 턴 종료 | `{type:'status', state:'ended'}` + 소켓 유지(스크롤백 열람) |
| codex 첫 턴 후 id 발견 실패 | 그 스레드는 세션 없이 동작(매번 새로) + 러너 로그 경고 — 기능 후퇴이지 정지가 아니다 |

## 9. 파일별 변경 지점

| 패키지 | 변경 |
|---|---|
| `shared` | `AgentConfig.mentionPermission` · `AgentView.ownerAccountId` · 릴레이 메시지 타입 |
| `server` | `008_agent_runner.sql` · `routes/agentRelayRoutes.ts`(목록·attach·러너 WS·viewer WS — 초판이 적은 `agentSessionRoutes.ts` 는 이 이름으로 착지) · `ws/relay.ts`(소켓 쌍 허브 — 초판의 `relayPlugin.ts`) · `services/agents.ts` COLS 확장 · audit 이벤트 |
| `agent` | 신규: `sessions.ts`(디스크 상태) · `workspace.ts`(avcs project) · `pty.ts`(node-pty 래핑) · `turn.ts`(플래그 표 + exit 판정) · `relay.ts`(상시 WS + ring buffer) · `mentionTurn.ts`(턴 조립 — `main.ts` 가 top-level await 라 테스트 가능한 분리가 필요했다). 제거: `harness/claudeCode.ts` 의 `parseClaudeResult`·`buildClaudeArgs`(플래그 표로 대체), `main.ts` 의 stdout 수집 경로 |
| `desktop` | `[▶ 터미널]` 칩(스레드 헤더, 소유자만) · xterm.js 패널 · attach 흐름 |
| 의존성 | agent: `node-pty` / desktop: `@xterm/xterm` |

## 10. 테스트 전략

| 층 | 대상 | 방법 |
|---|---|---|
| 순수 | 플래그 표 · 세션 상태 전이 · writer 규칙 · "발화 있었나" 판정 · ring buffer | 함수 호출 |
| 계약 (러너) | `turn.ts`·`pty.ts` | **가짜 harness 스크립트**(node)를 실제 PTY 로 띄운다 — 즉시 exit / MCP post 흉내 / 입력 대기(타임아웃 검증) / 비정상 종료 각 1개 |
| 서버 | 릴레이 | 소켓 쌍: 가짜 러너 WS + 가짜 viewer WS 로 바이트 왕복·권한 거부·runner-offline 통지 |
| 실물 | claude 상대 세션 연속성·attach e2e | 로컬 전용 태그, CI 제외 (CLI 부재) |
| **수용** | 조립된 argv 를 실제 CLI 가 **받아들이는가** | 아래 |
| 회귀 | `reply.ts`·`policy.ts` 기존 테스트 | 그대로 유지 |

가짜 harness 가 실제 자식 프로세스여야 하는 이유: 인메모리 stub 은 PTY 의 실제 결함
원천(개행·부분 읽기·시그널·exit 경합)을 재현하지 못한다.

**"수용" 층은 실물로 깨진 뒤에 생겼다.** 단위 테스트가 argv 의 *모양*만 단언하면(배열에 이
플래그가 있다) CLI 가 그 조합을 거부해도 전부 초록이다. 실제로 `codex exec resume <id>
-s workspace-write` 가 `unexpected argument '-s'` 로 죽는데 관련 테스트 21개가 통과했다 —
`-s` 는 비-resume `codex exec` 에만 있고 resume 서브커맨드에는 없기 때문이다. 플래그가 부모
서브커맨드에 있다는 사실이 자식에도 있다는 뜻이 아니다.

그래서 러너가 조립하는 각 `(harness, mode, isFirstTurn)` 조합마다 **CLI 가 인자를 파싱하는지만**
확인하는 검사를 둔다. 모델을 부르지 않고 파싱 단계에서 끝나는 형태를 쓴다 — 존재하지 않는
세션 id 로 불러 파싱은 통과하되 세션 조회에서 실패하게 하고, 종료 코드가 아니라 **stderr 에
`unexpected argument` 류가 없는지**를 본다(둘을 혼동하면 정상 실패를 파싱 실패로 읽는다).
CLI 가 필요하므로 로컬 전용 태그로 두되, **§4 표를 고칠 때마다 반드시 돌린다.** 이 검사가
없으면 표의 오류는 실사용 첫 턴에서야 드러난다.

**구현:** `packages/agent/test/acceptance-cli.test.ts` — `pnpm --filter @murmur/agent test` 로
함께 돌아간다. `plan.command` 가 PATH 에 없으면 건너뛰고 **왜 건너뛰는지 경고를 남긴다**
(조용히 통과하면 이 층이 있다는 사실 자체가 잊힌다). CI·VM 에는 CLI 가 없어 항상 skip 이다 —
§4 표를 고쳤다면 CLI 가 있는 개발 머신에서 반드시 한 번 돌려라.

**어떻게 확인하는가:** 조립한 argv 를 그대로 **실행하지 않는다.** 실행하면 claude 는 모델을
호출하고 codex 는 실제로 명령을 돌린다(`sandbox_mode=workspace-write`). 대신 그 서브커맨드의
`--help` 가 열거하는 옵션과 argv 의 롱 플래그를 대조하고, 도움말에 없는 플래그만 값 없이
붙여 파서를 세워 `unknown option` 인지 확인한다. `claude --append-system-prompt-file` 처럼
**존재하지만 `--help` 에 안 나오는 숨은 플래그**가 있어서 대조만으로는 오탐이 난다.

⚠️ 조립한 argv **뒤에 `--help` 를 붙이는** 방법은 쓸 수 없다(실측):
`codex exec resume <uuid> --skip-git-repo-check --help` 는 도움말을 내고 통과하지만, `--help`
없이 같은 인자를 주면 `unexpected argument` 로 죽는다 — `--help` 가 나머지 검증을 건너뛴다.

이 층이 실제로 동작하는지는 #89 의 결함(`--skip-git-repo-check` 를 인터랙티브 턴에도 붙임)을
되살려 확인했다 — 두 플래그를 정확히 지목하며 실패한다.

## 11. 구현 페이즈

- **Phase 1 — 세션 코어**: §3 + §4 + §6 + §7. 멘션 응답이 새 구조로 완결.
  성공 기준 1·2·5·6·7 이 여기서 닫힌다. — **착지 완료**
  ([phase1 계획](../plans/2026-09-01-runner-sessions-phase1.md))
- **Phase 2 — 관찰·개입**: §5. 성공 기준 3·4. — **관찰(기준 3)만 착지**(#141, PR #308).
  개입(기준 4)은 §5-2 의 확정 결정에 따라
  [phase2 계획](../plans/2026-09-04-runner-sessions-phase2.md)이 이어받는다(#315)

Phase 1 만으로 배포 가능하고 Phase 2 는 순수 추가라 롤백 반경이 분리된다.

## 12. S2 메모리 · S3 스킬 접합면

| 후속 | 자리 | 이 설계가 주는 것 |
|---|---|---|
| S2 주입 | 턴 시작 시 `<core-memory>` | `--append-system-prompt` 조립 지점 (`turn.ts`) — 이스케이프 필수 |
| S2 갱신 | 메모리 변경 반영 | 매 턴 재주입이므로 무효화 장치 불필요 (§3과 같은 이유) |
| S3 물질화 | 스킬 파일 배치 | **workspace 밖** 홈 nest 에 두고 링크한다 — cwd(workspace) 안에 쓰면 `land` 가 스킬 파일을 저장소로 쓸어갈 위험 (§13 검증) |

## 13. 구현 전 검증 항목 (spec 승인 후 첫 작업)

1. 인터랙티브 PTY + `--mcp-config`(env 확장) 로 murmur MCP 가 실제로 붙는가 (print 모드만
   확인됨) · claude `-p -r <id>` 조합의 비대화형 resume (플래그 각각만 확인됨)
2. codex: `exec resume` 존재 여부 · MCP 설정 형식 · 지시문 주입구 · `session_index.jsonl` 스키마
3. gemini: 비대화형 resume(`-r <id> -p`) · 권한 플래그 · 지시문 주입구
4. `avcs workspace land` 가 미추적 파일(스킬·상태 파일)을 어떻게 다루나
5. launchd 데몬화 시 Keychain 접근 (러너 감독 문서 §7 갱신과 함께)

**Phase 2 후반(개입, §5-2) 구현 전 검증 — 2026-09-04 추가:**

6. `codex resume --help` 에 `--ignore-user-config` 가 있는가. `turn.ts` 주석은 "못 받는다"
   로 적어 뒀지만(codex-cli 0.148.0 에서 `--skip-git-repo-check` 부재는 실측, 이 플래그는
   추정) 버전이 갱신됐을 수 있다 — 있으면 인터랙티브 턴에 붙이고, 없으면 §5-2 결정 8대로
   codex 인터랙티브를 거절한다. 당시 `CODEX_HOME` 격리 대안은 auth와 sessions가 함께
   바뀐다는 이유로 기각했으나, 2026-09-04 후속 실측에서 auth 링크 + 격리 sessions 조합이
   동작해 §5-2 결정 8의 후속 결정으로 대체됐다.
7. claude 인터랙티브 **첫** 턴: `claude --session-id <uuid>`(`-p` 없음)가 인터랙티브로 뜨고
   그 uuid 로 이후 `-r` resume 이 되는가 — "세션 없는 스레드에서 [▶ 터미널]"의 전제
8. node-pty `resize()` 가 자식에게 SIGWINCH 로 전달되는가 (fake-harness 로)

## 14. 성공 기준

1. 같은 스레드에서 두 번 부르면 두 번째가 첫 대화를 기억한다
2. **러너를 재시작해도** 1 이 성립한다 (세션 = 디스크)
3. 소유자가 [▶ 터미널] 로 진행 중 턴의 실제 화면을 본다. 소유자가 아니면 칩이 없다
4. 사람이 attach 해 고친 내용을 다음 멘션 턴이 알고 있다
5. 답 없이 끝난 턴이 스레드에 보인다 ("답 없이 턴을 끝냈습니다")
6. `readonly` 에이전트의 쓰기 시도가 거부된다 (러너 로그로 확인)
7. PAT 가 디스크에도 argv 에도 없다
8. claude 외 harness 하나 — **codex** — 가 같은 멘션에 답한다. 로드맵 §5 "harness
   다양성"을 실측으로 닫는다. 초판은 gemini 를 골랐고 근거를 "id 할당형이라 claude 에
   가깝다"로 적었는데, 그 근거는 `--session-id` 플래그의 존재에서 **추론한 것**이었고
   실측이 뒤집었다(`-r` 이 그 id 를 받지 않는다). codex 를 고르는 근거는 모양이 가깝다는
   것이 아니라 — codex 는 오히려 id 할당이 안 되는 쪽이다 — **resume 왕복이 실제로
   도는 것을 확인한 유일한 비-claude harness** 라는 사실이다
9. 다른 스레드는 서로의 맥락을 모른다 (workspace·세션 격리)
10. **한 스레드에 에이전트 둘**이 각자 세션·workspace 로 동시에 답하고, 다음 턴에
    서로의 발화를 알고 있다 — `design.md` §8 성공 기준 1("에이전트 2개 이상")의
    스레드판이며, 로드맵 §5 "에이전트 여러 대 동시 운영" 미확인 항목을 함께 닫는다

## 부록 A — ACP(Agent Client Protocol) 를 왜 쓰지 않았나

bc3af87 이 ACP 어댑터 설계를 커밋했으나 이 문서가 대체한다. 기각 근거:

1. **stdio 는 하나다.** ACP 로 쓰면 사람이 들어가 볼 터미널이 없다 — 요구 원문
   ("터미널에 들어가서 동일하게")과 원리적으로 충돌하고, 특히 "진행 중 턴에 들어가
   본다"는 ACP 아래서 성립 불가다.
2. **ACP 가 사려던 것을 PTY 가 전부 흡수했다.** harness 다양성 → 플래그 표(§4),
   스레드당 세션 → 디스크 상태(§1, 러너 재시작 무손실이라 더 강함), 권한 프로그래머블
   응답 → CLI 플래그(§6), PAT 임시파일 제거 → env 확장(§7, 실측). ACP 의 고유 잔여
   가치는 구조화된 진행 이벤트(tool_call·plan)뿐인데 그것은 v1 스코프 밖이었다.
3. **성숙도가 뒤집혀 있다.** PTY 가 쓰는 CLI 셋은 이 머신에 있고 플래그를 실측했다.
   `claude-agent-acp`·`codex-acp` 는 설치돼 있지도 않은 별도 브리지다.
4. ACP 안이 필요로 했던 장치들 — 세션 풀·유휴 타임아웃·LRU·정의 변경 시 전량 폐기·
   장수 프로세스의 좀비 관리 — 이 "세션=디스크, 프로세스=턴" 모델에서 **전부 불필요**해졌다.

다시 꺼낼 조건: murmur 가 하네스의 도구 호출·플랜을 **구조화된 데이터로** 소비해야
하는 요구(작업 현황판의 세밀한 진행 표시 등)가 실제로 생기는 날. 그때는 멘션 턴만
ACP 로 돌리는 혼합이 후보가 되며, 전제(ACP 세션 저장소가 CLI 와 호환되는가)를 먼저
검증해야 한다.
