# 러너 재구축 — 스레드 세션 · PTY · 관찰과 개입 (통합 설계)

- 날짜: 2026-09-01
- 상태: 초안 (사용자 리뷰 대기)
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

스코프 = `(channelId, threadRootId ?? '_root')`. `design.md` §4 멘션 고정의 "대화 단위"와
같은 선이다.

첫 멘션 시 러너가:

1. `avcs workspace project murmur-<agentHandle>-<threadShort> --out <dir>` — 물리 격리.
   이름에 handle 이 들어가는 이유: 한 스레드에 에이전트 여럿이 붙으면 스레드만으로는
   이름이 겹쳐 두 번째 project 가 실패하거나 격리가 무너진다. workspace 는 **에이전트당**이다.
   git worktree 를 쓰지 않는 이유: murmur 의 전제가 "기층이 git 이 아니라 avcs"다
   (avcs `docs/16`: *"git worktree 우회는 avcs 단독 버전관리 전제에 어긋난다"*).
2. session-id 확보 — harness 에 따라 갈린다 (§4 표):
   - claude·gemini: **러너가 UUID 를 발급**해 `--session-id` 로 준다
   - codex: 사전 할당이 없다. 첫 턴 종료 후 `~/.codex/session_index.jsonl` 에서
     발견해 저장한다 (구현 시 실측 — §13)
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

| | claude | codex | gemini |
|---|---|---|---|
| 새 세션 | `--session-id <uuid>` | (첫 턴 후 id 발견) | `--session-id <uuid>` |
| 멘션 턴 (비대화형) | `-p -r <id> "<ctx>"` | `codex exec resume <id> "<ctx>"`(§13 검증) | `-r <id> -p "<ctx>"`(§13 검증) |
| 사람 턴 (인터랙티브) | `-r <id>` | `codex resume <id>` | `-r <id>` |
| 지시문 주입 | `--append-system-prompt` | §13 검증 | §13 검증 |
| 권한: auto | `--permission-mode bypassPermissions` | `-s danger-full-access -a never`(§13) | §13 검증 |
| 권한: readonly | `--permission-mode plan` | `-s read-only -a never` | §13 검증 |

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
무시하고 입력을 기다림)는 반드시 끊는다. 타임아웃도 "발화 없음" 검사를 거친다.

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
- **writer 규칙**: 소유자만 붙으므로 동시 attach 는 같은 사람의 창 여러 개다.
  마지막 attach 가 writer, 나머지 읽기 전용, resize 는 writer 를 따른다.
- **감사**: attach / detach / 입력 바이트 **수**만 `audit_log` 에 남긴다. 입력 내용은
  남기지 않는다(프롬프트에 비밀이 들어갈 수 있다) — "감사에 본문을 복사하지 않는다"는
  기존 원칙 그대로.
- PTY 크기: 비대화형 턴 기본 `120x40`. attach 시 writer 의 크기로 resize.

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
| `server` | `008_agent_runner.sql` · `routes/agentSessionRoutes.ts`(목록·attach) · `ws/relayPlugin.ts`(러너측 `/agent-relay` + viewer 승격, 소켓 쌍 맵) · `services/agents.ts` COLS 확장 · audit 이벤트 3종 |
| `agent` | 신규: `sessions.ts`(디스크 상태) · `workspace.ts`(avcs project) · `pty.ts`(node-pty 래핑) · `turn.ts`(플래그 표 + exit 판정) · `relay.ts`(상시 WS + ring buffer). 제거: `harness/claudeCode.ts` 의 `parseClaudeResult`·`buildClaudeArgs`(플래그 표로 대체), `main.ts` 의 stdout 수집 경로 |
| `desktop` | `[▶ 터미널]` 칩(스레드 헤더, 소유자만) · xterm.js 패널 · attach 흐름 |
| 의존성 | agent: `node-pty` / desktop: `@xterm/xterm` |

## 10. 테스트 전략

| 층 | 대상 | 방법 |
|---|---|---|
| 순수 | 플래그 표 · 세션 상태 전이 · writer 규칙 · "발화 있었나" 판정 · ring buffer | 함수 호출 |
| 계약 (러너) | `turn.ts`·`pty.ts` | **가짜 harness 스크립트**(node)를 실제 PTY 로 띄운다 — 즉시 exit / MCP post 흉내 / 입력 대기(타임아웃 검증) / 비정상 종료 각 1개 |
| 서버 | 릴레이 | 소켓 쌍: 가짜 러너 WS + 가짜 viewer WS 로 바이트 왕복·권한 거부·runner-offline 통지 |
| 실물 | claude 상대 세션 연속성·attach e2e | 로컬 전용 태그, CI 제외 (CLI 부재) |
| 회귀 | `reply.ts`·`policy.ts` 기존 테스트 | 그대로 유지 |

가짜 harness 가 실제 자식 프로세스여야 하는 이유: 인메모리 stub 은 PTY 의 실제 결함
원천(개행·부분 읽기·시그널·exit 경합)을 재현하지 못한다.

## 11. 구현 페이즈

- **Phase 1 — 세션 코어**: §3 + §4 + §6 + §7. 멘션 응답이 새 구조로 완결.
  성공 기준 1·2·5·6·7 이 여기서 닫힌다.
- **Phase 2 — 관찰·개입**: §5. 성공 기준 3·4.

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

## 14. 성공 기준

1. 같은 스레드에서 두 번 부르면 두 번째가 첫 대화를 기억한다
2. **러너를 재시작해도** 1 이 성립한다 (세션 = 디스크)
3. 소유자가 [▶ 터미널] 로 진행 중 턴의 실제 화면을 본다. 소유자가 아니면 칩이 없다
4. 사람이 attach 해 고친 내용을 다음 멘션 턴이 알고 있다
5. 답 없이 끝난 턴이 스레드에 보인다 ("답 없이 턴을 끝냈습니다")
6. `readonly` 에이전트의 쓰기 시도가 거부된다 (러너 로그로 확인)
7. PAT 가 디스크에도 argv 에도 없다
8. claude 외 harness 하나(gemini 우선 — id 할당형이라 가깝다)가 같은 멘션에 답한다 — 로드맵 §5 "harness 다양성"을 실측으로 닫는다
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
