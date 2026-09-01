# ACP harness 층 — 설계 (S1)

- 날짜: 2026-09-01
- 상태: 초안 (사용자 리뷰 대기)
- 관련: [`design.md`](../design.md) §1 §4 §5, [`roadmap.md`](../roadmap.md) §5,
  [`buzz-comparison.md`](../buzz-comparison.md) §3.4, [`operations.md`](../operations.md) §7
- 후속 spec: S2 에이전트 메모리 층, S3 워크스페이스 스킬 층 (각각 별도)

## 0. 왜 harness 층이 먼저인가

출발점은 "에이전트가 스킬을 스스로 만들고 메모리를 축적한다"였다. 그 앞에 사실이 하나 있다.

**지금 러너에는 기억을 담을 자리가 없다.** `main.ts` 는 멘션마다 `claude -p` 를 새 프로세스로
띄우고 답이 나오면 죽인다. 맥락은 그때 읽은 스레드 30건이 전부이고, 세션도 재개도 없다.
메모리를 넣으려면 "세션 생성 시 주입"할 자리가 필요한데 그 자리 자체가 없다. 지금 harness 에
주입을 욱여넣으면 프로토콜을 바꿀 때 그 코드를 버린다.

동시에 이 교체는 이미 열려 있던 부채를 닫는다. `roadmap.md` §5:

> **harness 다양성** — `claude-code` 하나만 구현했다. UI의 나머지 선택지는 '지원 예정'으로
> 비활성이며, 그것들을 붙일 때 `buildClaudeArgs` 상당의 어댑터가 harness마다 필요한지
> 아니면 공통 형태로 수렴하는지 모른다

답은 "수렴한다"이고, 수렴시키는 규약이 ACP다. block/buzz 가 goose·codex·claude 를 어댑터
하나로 붙여 이미 실증했다(`crates/buzz-acp`).

## 1. 이름 주의 — ACP 는 두 개다

| 이름 | 주소 | 하는 일 | 이 문서 |
|---|---|---|---|
| **Agent Client Protocol** | agentclientprotocol.com | 클라이언트가 **로컬 harness 를 stdio 로 구동**한다 | **이것** |
| Agent Communication Protocol | agentcommunicationprotocol.dev | 서비스 간 REST 인터옵. 현재 A2A(Linux Foundation)로 흡수됐다 | 아님 |

후자는 `design.md` §6이 v2로 미룬 "외부 프로토콜 상호운용 어댑터"에 해당하며 이 spec 밖이다.
이름이 같아 혼동이 잦으므로 코드 주석과 커밋 메시지에서 **항상 "Agent Client Protocol"로
풀어 쓴다**.

## 2. 범위

**바뀌는 것**

| 대상 | 내용 |
|---|---|
| `packages/agent` | harness 층 전면 교체 (§4) |
| `packages/server` | 마이그레이션 1개 + `AgentView` 필드 2개 (§6, §5) |
| `packages/shared` | `AgentConfig` 에 `permissionMode`, `AgentView` 에 `configUpdatedAt` |
| `packages/desktop` | `AgentManager` 에 권한 스위치 1개, harness 선택지 활성화 |
| `docs/operations.md` | §7 러너 감독의 `PATH` 항목 (§10) |

**안 바뀌는 것**: MCP 도구 표면, 메시지·inbox·투영·WS, 인증. 서버는 여전히 에이전트 런타임을
모른다(`design.md` §1) — 서버가 새로 아는 것은 "이 에이전트에게 쓰기를 허용하는가"라는 **정책**
하나뿐이고, 그것을 집행하는 주체는 러너다.

## 3. 결정 요약

| # | 결정 | 근거 |
|---|---|---|
| 1 | 프로토콜은 Agent Client Protocol | §1 |
| 2 | 세션 스코프 = `(channelId, threadRootId ?? '_root')` | §5 |
| 3 | 에이전트 정의가 바뀌면 그 에이전트의 세션을 **전량 폐기** | §5 |
| 4 | 권한은 자동 허락(`allow_once`), 에이전트별 `readonly` 스위치 | §6 |
| 5 | MCP 전달은 HTTP 우선, 미지원 harness 는 임시파일 폴백 + **반드시 정리** | §7 |

## 4. 어댑터 구조

```
packages/agent/src/harness/
  acp/
    client.ts      # JSON-RPC 2.0 / ndjson — 프레이밍과 id 매칭만
    session.ts     # initialize → session/new → session/prompt 한 턴
    permission.ts  # session/request_permission 응답 선택 (순수 함수)
    presets.ts     # harness id → { command, args }
    pool.ts        # 스코프별 세션 맵과 무효화 (순수 상태 기계)
  index.ts         # HarnessAdapter — 호출부가 보는 유일한 얼굴
```

`client.ts` 는 **ACP 를 모른다.** 줄 단위 JSON 프레이밍, 요청/응답 id 매칭, 알림 라우팅만
한다. ACP 의미론은 `session.ts` 가 안다. 이 경계가 있어야 프로세스를 띄우지 않고 계약을
검증할 수 있다 — 지금 `buildClaudeArgs`/`parseClaudeResult` 가 순수 함수라 테스트되는 것과
같은 성질이고, 리팩터가 그 성질을 잃으면 후퇴다.

`presets.ts`:

| harness | command | 비고 |
|---|---|---|
| `claude-code` | `claude-agent-acp` | claude CLI 의 로그인 자격증명을 그대로 쓴다 |
| `goose` | `goose acp` | |
| `codex` | `codex-acp` | |

**탐지 UI 는 만들지 않는다.** `design.md` §4가 이미 판정했다 — buzz 의 "Agent runtimes 탐지 +
Install" 목록을 의도적으로 베끼지 않은 이유는, murmur 에서 목록에 없는 harness 의 원인이
사용자 머신이 아니라 murmur 의 미구현이기 때문이다. 커맨드가 없으면 실행 시점에 "harness 를
실행할 수 없다"로 정직하게 실패한다.

### 사라지는 것

| 사라짐 | 대체 |
|---|---|
| `buildClaudeArgs` · `parseClaudeResult` | `session.ts` 의 프롬프트 조립과 `session/update` 누적 |
| `spawn('claude', …)` + stdout 수집 | 장수 프로세스 + JSON-RPC |
| `mkdtemp` + `mcp.json` | `session/new` 의 `mcpServers` (§7) |

`reply.ts`(순수 로직) · `policy.ts`(백오프·자격증명 판정) · `murmur.ts`(MCP 접속) · poll 루프
골격은 harness 와 무관하므로 그대로 산다.

## 5. 세션 수명

### 스코프

**`(channelId, threadRootId ?? '_root')`.** 대화 단위다.

채널 단위로 잡으면 무관한 스레드가 한 컨텍스트에 섞인다 — 점심 대화를 물고 배포를 판단하는
에이전트가 된다. 멘션 단위로 잡으면 ACP 를 쓸 이유가 없다. 그리고 이 경계는 murmur 가 이미
쓰는 것이다: `design.md` §4의 멘션 고정이 *"고정은 대화 단위다(채널 / 스레드) — 앞 채널에서
부르던 에이전트가 따라가면 엉뚱한 곳에서 깨어난다"* 로 같은 선을 그었다. 여기서 다른 선을
그으면 규칙이 두 벌이 된다.

프로세스는 **에이전트당 1개**, 그 안에 세션 N개다. ACP 가 `sessionId` 로 다중화하므로
스레드마다 harness 를 띄울 이유가 없다.

### 무효화

| 조건 | 처리 |
|---|---|
| `agent_config.updated_at` 변경 | 그 에이전트의 **모든** 세션 폐기 |
| harness 프로세스 사망 | 전 세션 폐기 후 다음 턴에 재기동 |
| 유휴 30분 | 해당 스코프 세션만 폐기 |
| 세션 수 상한(에이전트당 8) 초과 | LRU 폐기 |

**정의 변경 시 전량 폐기가 필수인 이유.** 로드맵 §1이 확인해 둔 성질 — *"지시문을 고치면
러너를 재시작하지 않고 다음 답변부터 반영된다"* — 은 매 답변이 새 프로세스라서 성립했다.
세션을 재사용하면 시스템 프롬프트가 **세션 생성 시점에 고정**되므로 이 성질이 조용히 죽는다.
사용자는 지시문을 고치고도 그 스레드에서 옛 인격을 계속 만나며, 화면에는 아무 단서가 없다.

막는 법은 이미 있는 컬럼을 노출하는 것이다. `agent_config.updated_at` 을 `AgentView` 에
`configUpdatedAt` 으로 싣고(현재 `services/agents.ts` 의 `COLS` 에 없다), 러너가 매 턴 읽는
`GET /agent/config` 의 값이 세션에 새긴 값과 다르면 폐기한다.

**폐기는 손실이 아니다.** 세션이 없으면 지금과 똑같이 `readThread` 로 스레드를 다시 읽어
프롬프트를 만든다. 즉 **세션은 최적화이지 진실의 원천이 아니다.** 이 성질이 무효화를 마음껏
할 수 있게 만든다. (`session/load` 로 재개하는 길이 있으나 harness capability 의존이고,
`sessionId` 를 어디에 영속할지라는 질문이 따라온다. v1 에서는 쓰지 않는다.)

### 직렬화

한 세션에 프롬프트 두 개를 동시에 보낼 수 없다. 현재 poll 배치가 `for` 루프로 순차 처리하므로
자연히 지켜진다. 스코프별 병렬화는 하지 않는다 — 필요가 실측되기 전에는 YAGNI 이고,
`answer()` 의 실패 격리가 순차를 전제로 쓰여 있다.

## 6. 권한

ACP 는 harness 가 `session/request_permission` 으로 **클라이언트에게 묻는다.** 러너가 답하지
않으면 작업이 그 자리에서 멈춘다. 지금은 이 판단이 murmur 밖에 있었다 — `buildClaudeArgs` 는
권한 관련 인자를 하나도 넘기지 않아 claude CLI 의 기본값에 맡겼다. 교체하면 판단이 러너로
넘어온다.

### 정책

`agent_config.permission_mode` — `auto`(기본) 또는 `readonly`.

| 모드 | 응답 |
|---|---|
| `auto` | 옵션 중 `kind == "allow_once"` 를 고른다 |
| `readonly` | 옵션 중 `kind == "reject_once"` 를 고른다 |

**`allow_always` 는 어떤 모드에서도 고르지 않는다.** 그것을 고르면 harness 쪽 설정에 영구
규칙이 쌓이고, 이후 murmur 에서 정책을 좁혀도 이미 쌓인 규칙이 계속 통과시킨다. 정책이
murmur 밖으로 새는 순간 UI 의 스위치는 장식이 된다.

**`optionId` 는 절대 하드코딩하지 않는다.** harness 가 매번 자기 마음대로 짓는 값이고
(`opt-always-7` 같은), 규약으로 고정된 것은 `kind` 뿐이다. 박아 두면 harness 를 바꾸는 순간
승인이 조용히 실패하고 에이전트가 아무 작업도 못 하게 된다. 요청한 `kind` 가 옵션에 없으면
프로토콜 오류로 그 턴을 실패시킨다 — 임의의 다른 옵션을 고르는 것이 최악이다.

### 마이그레이션

```sql
-- 008_agent_permission_mode.sql
alter table agent_config
  add column permission_mode text not null default 'auto';
```

값 검증은 애플리케이션이 한다 — `004_agent_config.sql` 이 `harness` 에 대해 내린 판례
(*"harness 목록은 코드와 함께 늘어나므로 스키마 제약으로 굳히지 않는다"*)를 따른다.

**배포 노트에 반드시 적는다: 이 마이그레이션은 기존 에이전트의 권한을 넓힌다.** `claude -p`
아래에서 harness 기본값에 막히던 도구가 `auto` 아래에서는 허용된다. 좁히려면 배포 후
해당 에이전트를 `readonly` 로 바꾼다.

## 7. MCP 전달과 PAT

### 지금의 결함

`main.ts` 가 PAT 를 임시 디렉터리의 `mcp.json` 에 평문으로 쓴다(`mode: 0o600`). 그리고
**종료 시 지우지 않는다.** 러너를 열 번 재시작하면 tmp 에 PAT 파일이 열 개 남는다. 이 spec 이
이것을 고친다.

### 전달

`session/new` 의 `mcpServers` 는 세 transport 를 갖는다. murmur MCP 는 Streamable HTTP 이므로
`type: "http"` 가 정확히 맞는다:

```jsonc
{
  "type": "http",
  "name": "murmur",
  "url": "http://localhost:3400/mcp",
  "headers": [{ "name": "Authorization", "value": "Bearer murp_…" }]
}
```

파일이 없으므로 PAT 가 디스크에 닿지 않는다.

단 HTTP transport 는 **capability 의존**이다. harness 가 `initialize` 응답으로 http 지원을
선언하지 않으면 stdio 만 쓸 수 있다(정확한 capability 필드명은 구현 시 실제 `initialize`
응답을 찍어 확인한다 — 문서만 보고 이름을 추측해 분기하면 미지원을 지원으로 오판한다).
그때는 지금 방식으로 폴백한다:

1. `mkdtemp` + `mode 0o600` 으로 설정 파일을 쓴다
2. **`process.on('exit')` 과 SIGINT/SIGTERM 경로에서 반드시 지운다**
3. 어느 경로를 탔는지 기동 로그에 남긴다 — 폴백이 조용하면 "PAT 가 왜 디스크에 있지"의 답을
   찾을 수 없다

폴백을 없애지 않는 이유는 S1 의 목표가 "goose·codex 도 붙는다"이기 때문이다. HTTP 만
지원하면 그 목표가 harness 사정으로 깨진다.

## 8. 실패 처리

| 상황 | 처리 |
|---|---|
| harness 실행 파일 없음 | 즉시 크게 실패(러너 종료). 재시도로 낫지 않는다 |
| `authenticate` 요구 / auth 오류 | `policy.ts` 의 `isCredentialFailure` 경로 — 러너 종료 + 안내 |
| `stopReason: "refusal"` | 채널에 사실로 남긴다. `extractReply` 의 기존 규약과 같다 |
| `stopReason: "max_tokens"` | 받은 만큼 올리되 잘렸음을 표시 |
| 턴 타임아웃 | `session/cancel` → 그 항목 실패로 계상(`MAX_ATTEMPTS` 적용) |
| 프로세스 사망 | 세션 맵 비우고 다음 턴에 재기동. 진행 중이던 항목은 실패 계상 |
| SIGTERM | 진행 중 세션에 `session/cancel` → 프로세스 종료 → 폴백 파일 삭제 |

`session/update` 의 `agent_thought_chunk` 는 **채널로 나가지 않는다.** `reply.ts` 가 이미
같은 판단을 하고 있다(*"thinking 블록은 내부 추론이다 — 채널에 나가면 안 된다"*). ACP 에서
사고와 발화가 별도 알림으로 분리돼 오므로 오히려 판정이 쉬워진다.

`tool_call` / `plan` 알림도 v1 에서는 채널에 투영하지 않는다. 투영은 avcs 가 하는 일이고
(`design.md` §3), harness 의 도구 호출까지 채팅에 흘리면 두 벌이 된다.

## 9. 테스트 전략

`design.md` §5가 avcs 어댑터에서 얻은 교훈을 그대로 적용한다 — *"fake 상대로 통과하는 테스트는
wire 드리프트를 잡지 못한다"*. 다만 실제 harness 는 CI 에 없다. 그래서 세 층으로 나눈다.

| 층 | 대상 | 방법 |
|---|---|---|
| 순수 | `permission.ts`, `pool.ts` 무효화 규칙 | 프로세스 없이 함수 호출 |
| 계약 | `session.ts` | 스크립트로 만든 **최소 ACP 에이전트**(node, ndjson)를 실제 자식 프로세스로 띄운다 |
| 실물 | `claude-agent-acp` 상대 | 로컬 전용 태그. CI 에서 건너뛴다(CLI 부재) |

계약 층이 실제 자식 프로세스여야 하는 이유: 인메모리 stub 은 ndjson 프레이밍·부분 읽기·
프로세스 사망을 재현하지 못하는데, 그 셋이 이 층의 실제 결함 원천이다.

반드시 있어야 할 케이스:

- `optionId` 를 `kind` 로 찾는다 / `allow_always` 를 고르지 않는다 / 요청한 `kind` 부재 시 실패
- 정의 `configUpdatedAt` 변경 → 세션 전량 폐기 → 다음 턴이 새 지시문으로 간다
- 프로세스 사망 → 다음 턴이 재기동하고 답을 낸다
- 폴백 파일이 종료 후 남지 않는다
- 스코프가 다른 두 스레드가 서로의 맥락을 보지 못한다

## 10. 운영 영향

**`PATH` 함정이 재현된다.** `operations.md` §7이 launchd 러너 감독에서 적어 둔 것 —
*"launchd 는 로그인 셸의 PATH 를 물려받지 않아 `claude` 를 못 찾는다. 이것이 '러너는 살아
있는데 답을 못 하는' 조용한 실패의 흔한 원인이다"* — 이 그대로 적용되되 **대상이 바뀐다.**
찾아야 하는 것은 `claude` 가 아니라 `claude-agent-acp`(또는 `goose`, `codex-acp`)다.
`operations.md` §7 을 함께 고친다.

**좀비 프로세스가 가설에서 상시 조건이 된다.** 로드맵 §5의 미확인 항목 — *"러너가 오래 도는
것 … 좀비 `claude` 프로세스가 어떻게 되는지는 모른다"* — 은 지금까지 프로세스가 멘션마다
죽어 자연 청소됐기에 잠재적이었다. ACP 는 **장수 프로세스가 설계의 전제**다. 그래서 v1 에
다음을 넣는다:

- 유휴 30분 세션 폐기(§5)와 **유휴 2시간 프로세스 종료** — 세션이 없으면 프로세스도 없앤다
- 프로세스 사망 감지 시 `child.kill()` 로 반드시 거둔다(`exit` 리스너에서 맵 정리)
- 기동 로그에 harness PID 를 남긴다 — `launchctl list` 의 러너 PID 와 다르므로 감독이
  거두지 못하는 자식이 있다는 사실이 보여야 한다

**백로그 게이지가 이 변경의 관측 수단이다.** main 에 들어온 "미처리 부름 나이 게이지"가
세션 재사용으로 답변이 느려지거나 멈추는 것을 숫자로 드러낸다. 별도 지표를 추가하지 않는다.

## 11. 스코프 제외

- `session/load` 기반 세션 영속 (capability 의존, sessionId 저장 위치 미결)
- 권한 요청을 채널 메시지로 사람에게 묻는 것 — 서버·UI 변경을 수반하므로 별도 spec
- `tool_call` / `plan` 의 채널 투영
- harness 탐지·설치 UI (`design.md` §4가 이미 기각)
- Agent Communication Protocol / A2A 표면 (`design.md` §6, v2)

## 12. S2·S3 와의 접합면

이 spec 이 다음 두 층에 남기는 자리:

| 후속 | 필요한 자리 | S1 이 만드는 것 |
|---|---|---|
| S2 메모리 | 세션 생성 시 `<core-memory>` 주입 | `session.ts` 의 `session/new` 직전 훅 |
| S2 메모리 | 메모리 변경 시 세션 폐기 | §5 무효화 표에 조건 한 줄 추가 |
| S3 스킬 | 세션 전 스킬 파일 물질화 | `cwd`(= `workingDir`) 확정 지점 |

S2 는 `session/new` 에 시스템 프롬프트 파라미터가 **없다**는 제약 위에 설계돼야 한다 —
주입은 첫 프롬프트 본문 앞에 붙이는 형태가 된다. 이는 buzz 가 택한 것과 같다.

## 13. 성공 기준

1. `@handle` 멘션에 답한다 — 기능 후퇴가 없다(기존 agent 테스트 통과)
2. 같은 스레드에서 두 번 부르면 **두 번째가 첫 대화를 기억한다**
3. 다른 스레드에서 부르면 **앞 스레드 내용을 모른다**
4. UI 에서 지시문을 고치면 **다음 답변부터** 반영된다 (세션 재사용 이전과 동일)
5. `readonly` 로 바꾼 에이전트의 쓰기 도구 요청이 `reject_once` 로 응답되고, 그 판정이
   러너 로그에 남는다 (모델이 그 사실을 답변에 쓰는지는 모델 소관이라 기준에 넣지 않는다)
6. `claude-code` 외 harness 하나를 실제로 붙여 같은 멘션에 답하게 한다 — 로드맵 §5의
   "harness 다양성" 항목을 코드가 아니라 **실측으로** 닫는다
7. 러너 종료 후 tmp 에 PAT 파일이 남지 않는다
