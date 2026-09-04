# 러너 관찰·개입 (Phase 2 후반) 구현 계획 — 입력·인터랙티브 턴·멘션 큐잉

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 관찰(#141)에서 멈춘 Phase 2 를 완성한다 — 소유자가 attach 한 터미널에 **타이핑**하고(입력·resize·writer 규칙), 진행 중인 턴이 없어도 **스스로 인터랙티브 세션을 열고**, 사람이 조종 중인 스레드의 멘션은 **큐에 들어가 기다린다**. 스펙 §14 성공 기준 4("사람이 attach 해 고친 내용을 다음 멘션 턴이 알고 있다")가 여기서 닫힌다.

**Architecture:** 기존 릴레이(러너 outbound WS → 서버 소켓 쌍 허브 → 뷰어 WS)에 역방향 프레임을 다중화한다 — 러너는 여전히 포트를 열지 않고, 서버는 여전히 `data` 를 열지 않는다. 확정 결정 8개는 스펙 §5-2 에 있다(이 문서는 결정을 반복하지 않는다).

**Tech Stack:** Node 22 / TypeScript ESM / vitest / node-pty / Fastify + Postgres (서버) / xterm.js + @xterm/addon-fit (데스크탑)

**Spec:** `docs/specs/2026-09-01-runner-sessions-pty-design.md` §5-2 (확정 결정) · §5 (릴레이 원형) · §6 (권한) · §13.6–8 (스파이크)

**Issues:** #315 (개입 코어 — Task 2~5·9) · 인터랙티브 기동+큐잉 이슈 (Task 1·6·7·8·10)

## Global Constraints

- ESM — 상대 import 는 `.js` 확장자 필수
- 주석·에러 메시지는 한국어, 기존 문체(왜를 적는다). 유예는 TODO 가 아니라 "범위" 주석
- 커밋 메시지: `type(scope): 요지`
- `pnpm --filter @murmur/agent test` / `--filter @murmur/server test`(Docker) / `--filter @murmur/desktop test`
- 하네스 영구 설정을 바꾸는 플래그·명령 금지 (spec §6)
- 서버는 릴레이 `data`(base64)를 **절대 디코드하지 않는다** — 입력 바이트 수도 길이 산술로
- 구/신 버전 조합 4방향(러너×서버×데스크탑)이 전부 안전해야 한다 (spec §5-2 결정 2)
- Task 는 각각 독립 머지 가능해야 한다. Task 2~6 은 "보내는 쪽이 없는" 죽은 코드 상태로 머지되고, Task 7 이 처음으로 경로를 관통하며, Task 9 가 사람에게 연다

---

### Task 1: 실측 스파이크 (spec §13.6–8) — 코드보다 먼저

**왜 먼저인가:** codex 인터랙티브의 성립 여부(§5-2 결정 8)와 claude 인터랙티브 첫 턴의 전제가 여기 걸려 있다. Phase 1 의 교훈 그대로 — 플래그가 부모 서브커맨드에 있다는 사실이 자식에도 있다는 뜻이 아니다.

- [ ] **Step 1: codex resume 표면** — `codex resume --help` 에 `--ignore-user-config` 가 있는가. 있으면 Task 2 의 플래그 표에 넣고, 없으면 codex 인터랙티브 거절 확정
- [ ] **Step 2: claude 인터랙티브 첫 턴** — `claude --session-id <uuid>`(`-p` 없음)가 인터랙티브로 뜨고, 종료 후 그 uuid 로 `-r <uuid>` resume 이 되는가
- [ ] **Step 3: SIGWINCH** — node-pty `resize()` 가 자식 프로세스에 SIGWINCH 로 전달되는가 (fake-harness 로 확인)
- [ ] **Step 4: 결과를 이 파일 하단 "스파이크 결과" 절에 기록하고 커밋**

### Task 2: 프로토콜 + 플래그 표

**대상:** `packages/shared/src/index.ts` · `packages/agent/src/turn.ts` · `packages/agent/test/turn.test.ts` · `packages/agent/test/acceptance-cli.test.ts`

- [ ] shared: `AttachClientFrame`(`input`/`resize`) 신설, `AttachServerFrame` 에 `{type:'writer', writer:boolean}` 추가, `RelayServerFrame` 유니온화(`replay.request`·`input`·`resize`·`viewer.count`·`interactive.open`), `RelayRunnerFrame` 에 `interactive.opened`/`interactive.error`, `announce` 에 `caps?: readonly ('input'|'interactive')[]`, `AgentSessionView` 에 `mode?: 'mention'|'interactive'`. "Phase 2 는 읽기만" 주석을 §5-2 참조로 교체
- [ ] turn.ts: 인터랙티브 **첫** 턴 조합 — claude `isFirstTurn && interactive → ['--session-id', id]`, codex 는 Task 1 결과에 따라(첫 턴 맨 `codex` 또는 명확한 거절 에러). `assertValidSession` 의 "인터랙티브인데 이어받을 게 없다" 불변식을 "첫 턴이면 허용"으로 완화. codex `--ignore-user-config` 인터랙티브 처리(Task 1 결과)
- [ ] acceptance-cli: `(harness, 'interactive', isFirstTurn)` 조합 추가 — §10 "표를 고치면 반드시 돌린다"
- [ ] **검증:** 인터랙티브 조합이 수용 테스트 통과(또는 codex 거절 에러가 테스트로 고정)

### Task 3: PTY 조작 핸들

**대상:** `packages/agent/src/pty.ts` · `packages/agent/test/pty.test.ts` · `packages/agent/test/helpers/fake-harness.mjs`

- [ ] `RunPtyTurnOptions` 에 `onSpawn?: (controls: PtyControls) => void` · `cols?`/`rows?` · `timeoutMs: 0`(무기한 — 인터랙티브 전용) 추가. `PtyControls = { write(data: string): void; resize(cols, rows): void; kill(signal?): void }`. Promise 시그니처는 유지 — 기존 `RunTurn` 계약과 테스트 스텁을 깨지 않는다
- [ ] `write`/`resize` 는 exit 후 no-op (`settled` 가드). 입력은 base64→Buffer→utf8→`proc.write` — 입력의 기원이 xterm `onData` 문자열이라 UTF-8 왕복이 무손실(출력의 디코드 금지와 방향이 다르다 — 주석으로 남긴다)
- [ ] fake-harness 신모드 2개: `echo-stdin-live`(stdin 을 계속 읽어 에코), `report-winch`(SIGWINCH 시 `columns x rows` 출력)
- [ ] **검증:** onSpawn.write 에코가 ring 에 도달 · resize 가 SIGWINCH 로 전달 · `timeoutMs: 0` 이 타이머를 안 건다

### Task 4: 러너 릴레이 확장

**대상:** `packages/agent/src/relay.ts` · `packages/agent/test/relay.test.ts`

- [ ] `OpenSession` 에 `bindPty(controls)` 추가(close 시 해제), `OpenSessionInput` 에 `mode`·`onViewerCount?` 추가
- [ ] `onServerFrame` switch 확장: `input` → `controls?.write`, `resize` → `controls?.resize`, `viewer.count` → 콜백, `interactive.open` → `RelayClientOptions.onInteractiveOpen` 왕복(`interactive.opened`/`interactive.error` 로 응답). 콜백 예외는 삼킨다 — 개입이 다른 턴을 죽이지 않는다
- [ ] announce 에 `caps: ['input','interactive']`
- [ ] **검증:** 가짜 dialer 로 프레임별 도달 · 미지 세션/미바인딩 무해 · 구 서버 프레임만 받아도 무변화

### Task 5: 서버 허브 개입 경로

**대상:** `packages/server/src/ws/relay.ts` · `packages/server/src/routes/agentRelayRoutes.ts` · `packages/server/test/agentRelay.test.ts`

- [ ] `writerOf: Map<sessionId, Viewer>` — 마지막 attach 가 writer(승격 시 이전 writer 에 `writer:false`, 새 writer 에 `true`), 이탈 시 가장 최근 attach 로 승계
- [ ] `addViewer` 반환을 핸들 객체로: `{ close(), handleMessage(raw), inputBytes() }`. `handleMessage`: writer 검증 + 러너 caps 확인 후 base64 **그대로** 포워딩(실패는 조용히 drop), 바이트 수는 base64 길이 산술로 누계. `resize` 는 정수 1..1000 범위 검증
- [ ] viewer 수 변동 시 러너로 `viewer.count` 통지
- [ ] detach 감사(`agent.detached`) detail 에 `inputBytes` 합산 1회 (§5-2 결정 3)
- [ ] **검증:** 소켓 쌍 — input 왕복(sessionId 봉투) · 비-writer drop · writer 승계 순서 · writer 프레임 수신 · caps 없는 러너 미포워딩 · inputBytes 정확성 · 세션 소유권 위조 방어가 input 에도 적용

### Task 6: 인터랙티브 open REST

**대상:** `packages/server/src/routes/agentRelayRoutes.ts` · `packages/server/src/ws/relay.ts` · `packages/server/src/audit.ts`

- [ ] `POST /agent-sessions/interactive` `{agentAccountId, channelId, threadRootId}` → `checkOwnerOrAdmin`(attach 와 같은 술어) → 허브 `openInteractive`(requestId 상관, 10초 타임아웃) → `200 {ticket, session}` / `404 no runner` / `409 runner_outdated`(caps 에 `interactive` 없음 — 타임아웃 대기 없이 즉시) / `504 runner_timeout`
- [ ] 러너의 `session.started` 가 `interactive.opened` 보다 먼저 오므로(같은 소켓, 순서 보장) resolve 시점에 세션 조회가 성립 — 티켓 발급은 attach 와 동일 경로
- [ ] 감사 액션 `agent.interactive.opened` 신설 — detail `{sessionId, channelId, threadRootId, created}`
- [ ] **검증:** 가짜 러너 opened 응답 → ticket 반환 · 타임아웃/오프라인/구버전 각 상태코드

### Task 7: 러너 인터랙티브 턴

**대상:** 신규 `packages/agent/src/interactiveTurn.ts` · 신규 `packages/agent/src/turnRegistry.ts` · `packages/agent/src/mentionTurn.ts` · `packages/agent/src/main.ts`

- [ ] `turnRegistry.ts`: `Map<threadKey, {kind: TurnMode, sessionId}>` 인메모리(프로세스=턴이라 디스크 불필요). 멘션 턴·인터랙티브 턴이 시작에 등록, finally 해제
- [ ] `mentionTurn.ts`: `runTurn(plan, {…, onSpawn: session ? c => session.bindPty(c) : undefined})` — 멘션 턴 attach 입력이 이 배선으로 열린다. plan 은 권한 플래그 조립 **후** 이므로 모드 불변(§6 표 3행) 유지. `resolveWorkspaceDir` 공용화(export 또는 모듈 분리)
- [ ] `interactiveTurn.ts` 3분기: ① 그 스레드에 멘션 턴 진행 중 → 그 sessionId 를 `{created:false}` 로 반환(그 PTY 에 attach) ② 인터랙티브 진행 중 → 기존 반환 ③ 없음 → 세션 확보(없으면 생성 — workspace project + uuid 발급) 후 `buildTurnCommand({mode:'interactive', stdinFile:null, promptCtx:''})` — 권한 플래그 없음(하네스 기본), `runPtyTurn({timeoutMs: 0, onSpawn: bindPty})`. **exit 을 await 하지 않고** spawn 확인 즉시 resolve
- [ ] 종료: 프로세스 exit 1차 + `viewer.count === 0` → 유예(`AGENT_INTERACTIVE_ORPHAN_MS`, 기본 60초) → `controls.kill('SIGTERM')`→5초→SIGKILL 2차. count > 0 프레임이 오면 타이머 취소. 러너 SIGTERM 종료 시에도 같은 경로로 회수
- [ ] exit 후: 레지스트리 해제 · `session.close()` · `lastFedSeq` 전진하되 **대기 멘션 min seq − 1 클램프**(§5-2 결정 7 — 주석으로 근거) · codex 이고 `sessionId===null` 이면 사후 발견 · "발화 없음" 검사는 하지 않는다(사람 턴에 발화 의무가 없다)
- [ ] `main.ts`: `relay.onInteractiveOpen` 배선
- [ ] **검증:** 3분기 · lastFedSeq 클램프 · 고아 회수 타이머(schedule 주입) · plan 에 권한 플래그 부재 — 전부 스텁 테스트

### Task 8: 멘션 큐잉

**대상:** 신규 `packages/agent/src/mentionQueue.ts` · `packages/agent/src/main.ts` · `packages/agent/src/prompt.ts`

- [ ] main 루프, anchor 계산 후: `registry.get(threadKey)?.kind === 'interactive'` 면 유예 — `markRead` 도 attempts 증가도 없이 건너뜀(inbox 가 곧 큐, §5-2 결정 6)
- [ ] `mentionQueue.ts`: `Map<threadKey, Set<entryId>>` — 통지는 entry 당 1회, N = Set 크기. 인터랙티브 종료 시 key 제거 + Task 7 의 클램프에 min seq 제공
- [ ] 통지 문구 상수(prompt.ts): "지금 {handle} 이(가) 직접 조종 중입니다 — 이 멘션은 대기 {n}건째로, 터미널이 닫히면 처리합니다" — 러너가 **에이전트 계정으로** post(`NO_REPLY_NOTICE` 판례)
- [ ] 유예만 있고 완료가 없는 배치는 고정 5초 sleep — 실패 backoff 와 별개(실패가 아니다)
- [ ] **검증:** 유예 시 markRead/attempts 불변 · 통지 1회(재폴링 중복 없음) · 인터랙티브 종료 후 대기 멘션이 처리되고 프롬프트가 비지 않는다

### Task 9: 데스크탑 — 스레드 스코프 + 입력 배선 + 열기 UX

**대상:** `packages/desktop/src/state/appStore.ts` · `components/TerminalChip.tsx` · `components/MessageItem.tsx` · `components/TerminalPanel.tsx` · `lib/agentTerminal.ts` · `lib/terminalSink.ts` · `lib/api.ts` · `test/agentTerminal.test.tsx`

- [ ] **(선행 결함 수정 — 개입과 독립 머지 가능)** `terminalAgentId` → `terminalTarget {agentAccountId, channelId, threadRootId}`. 칩이 `message.threadRootId ?? message.id`(#98 앵커식)로 채우고, 패널의 세션 선택을 3필드 일치로. 패널 헤더에 채널/스레드 표기
- [ ] `terminalSink.ts`: `io?: {onData?, onResize?}` 확장 + `@xterm/addon-fit`(현재 xterm 기본 80x24 고정이라 resize 가 성립하지 않는다) — mount 시 fit + host ResizeObserver
- [ ] `agentTerminal.ts`: `AttachHandle.sendInput`(TextEncoder→base64)/`sendResize`, `AttachCallbacks.onWriter`. **writer 확인 전에는 보내지 않는다** — `writer` 프레임이 없는 구 서버에서 자연스럽게 읽기 전용으로 저하
- [ ] `TerminalPanel`: writer 배지("입력 가능"/"읽기 전용 — 다른 창이 입력 중"), writer 일 때만 onData/onResize 를 흘리고, 승격 직후 fit 크기로 resize 1회(§5 "writer 크기로 resize"). no-session 문구를 [터미널 열기] 버튼으로 — `api.openInteractiveSession` → `{ticket, session}` → 기존 attach 합류. 러너 오프라인/구버전/codex 거절은 서버 메시지 그대로 error phase 에. "Phase 2 는 읽기만" 주석 갱신
- [ ] **검증:** 배선 회귀 — 같은 에이전트 2스레드 픽스처에서 올바른 세션 선택 · 가짜 sink onData → input 프레임 캡처 · writer:false 미전송 · 열기 버튼 → REST 호출

### Task 10: 문서·주석 정리 + 실물 e2e

- [ ] "읽기만" 주석 3곳(`shared`·`agentRelayRoutes.ts`·`TerminalPanel.tsx`) 정리 — Task 2·5·9 에서 놓친 것 확인
- [ ] 실물(로컬 전용 태그, CI 제외): claude 인터랙티브 e2e — [터미널 열기] → 타이핑 → 파일 수정 → 닫기 → 같은 스레드 멘션이 그 수정을 안다 (**스펙 §14 성공 기준 4**) · 멘션 턴 attach 중 타이핑(기준 3+입력) · 조종 중 멘션 큐잉 왕복
- [ ] 로드맵 §5 "아직 확인하지 못한 것" 갱신

---

## 스파이크 결과 (Task 1 완료 후 기록)

(비어 있음 — Task 1 이 채운다)
