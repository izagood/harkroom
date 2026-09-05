# 데스크탑 디자인 언어 도입 — 말의 종류와 수신자

> **For agentic workers:** 이 계획은 Task 단위로 구현한다. 각 Task 는 **독립 머지 가능**해야 하고,
> Step 은 체크박스(`- [ ]`)로 추적한다.

**Goal:** 데스크탑 화면이 **에이전트의 말을 종류별로 구별**하고 **그 말이 누구에게 갔는지**를 표현하게
한다. 지금 화면은 되물음·선택·진행·보고·실패를 전부 같은 회색 말풍선으로 그리고, 무엇보다
**선택지를 표현할 컴포넌트가 없어** 에이전트가 갈림길을 평문으로 쓰고 사람이 다시 타이핑해 답한다.
여럿이 일하면(핸들 집합 #230 · 에이전트 팀 #172) 문제가 배가된다 — 에이전트끼리 주고받는 물음까지
같은 무게로 흘러 스레드가 읽히지 않는다.

**Architecture:** 새 메시지 종류를 만들지 않는다. 이미 있는 `MessageRow.meta`(jsonb)에 말의 종류와
수신자를 싣고, 화면이 그것을 읽어 대접을 가른다 — `meta.avcsType`·`meta.skillSlug` 가 쓰는 그 자리다.
**모르는 `meta` 는 평문으로 흘린다**가 전 구간의 불변식이고, 이것이 구/신 버전 조합(러너 × 서버 ×
데스크탑)을 안전하게 만든다.

**Tech Stack:** Node 22 / TypeScript ESM / vitest / React 18 + Tailwind v4 (`@theme` 토큰) /
Fastify + Postgres / MCP Streamable HTTP

**Design doc:** [`docs/desktop-design-directions.html`](../desktop-design-directions.html) —
여섯 규칙 · 여덟 가지 말 × 두 수신자 · 진단 · 세 방향(A 차례 / B 작업 노트 / C 짝 작업)과 목업.
이 계획은 **A 를 골격, B 의 배정표를 스레드 안에, C 를 집중 모드로** 라는 문서의 추천을 따른다.

**Issues:** 신규(이 계획으로 발행). 관련: #230(핸들 집합) · #172(에이전트 팀) · #144(`kind='progress'`) ·
#141/#98(터미널 세션) · #124(러너 생존) · #112(시맨틱 토큰) · #424/#396(답글 요약 정리)

---

## Global Constraints

- ESM — 상대 import 는 `.js` 확장자 필수
- 주석·에러 메시지는 한국어, 기존 문체(**왜**를 적는다). 유예는 TODO 가 아니라 "범위" 주석
- 커밋 메시지: `type(scope): 요지`
- **화면 코드는 색 이름을 부르지 않는다** — 역할 토큰만(`bg-surface-sunken`, `text-fg-muted`).
  `dark:` variant 를 새로 쓰지 않는다(#112 규약). 새 색이 필요하면 `index.css` 에 토큰을 추가한다
- **모르는 `meta` 는 평문으로 흘린다** — 형식을 못 알아보면 상자를 그리지 않고 본문만 보여 준다.
  빈 상자는 "여기 뭔가 있다"는 거짓 신호다
- **강조색은 화면당 한 뜻으로만** — `→ 나` 로 온 막는 말(되물음·선택·실패). 그 외에는 무채색
- 테스트: `pnpm --filter @murmur/desktop test` · `--filter @murmur/server test`(Docker 필요) ·
  `--filter @murmur/shared build`
- Task 1·2 는 화면에 아무 변화도 만들지 않는다("보내는 쪽이 없는" 상태로 머지된다).
  Task 3 이 처음으로 경로를 관통한다

---

## Phase 1 — 어휘의 뼈대

### Task 1: 토큰 확장 (화면 변경 없음)

**왜 먼저인가:** 이후 모든 Task 가 새 역할 토큰을 부른다. 토큰이 없으면 화면 코드에 리터럴 색이
들어가고, #112 가 세운 "화면에는 색 이름이 없다"가 첫 PR 에서 깨진다.

**대상:** `packages/desktop/src/index.css`

- [ ] **Step 1: 브랜드 강조를 로고 색으로** — `--app-accent` 를 인디고(`#4f46e5`)에서 로고의
      주황(`#E8613C`)으로 옮긴다. `--app-accent-hover`·`--app-accent-surface` 도 함께.
      다크는 `#FF7B54` 계열. **로고에만 있고 화면에는 없던 색을 화면의 유일한 강조로 만드는 것**이
      이 Step 의 요지다
- [ ] **Step 2: 수신자·성부 토큰** — `--app-fg-agent` / `--app-surface-agent`(에이전트끼리의 말이
      앉는 아주 옅은 면) / `--app-border-agent`. 값은 청록 계열(`#4E5A56` 축)로, 강조와 경쟁하지 않게
      채도를 낮춘다
- [ ] **Step 3: 상태 토큰** — `--app-state-turn`(내 차례, 강조와 같은 값을 **가리키되 이름을 따로
      둔다** — 뜻이 둘이면 이름도 둘이어야 나중에 갈라놓을 수 있다) / `--app-state-running` /
      `--app-state-waiting` / `--app-state-done` / `--app-state-stuck`
- [ ] **Step 4: `@theme` 매핑 추가** — `--color-fg-agent` 등. 값은 `--app-*` 를 가리킨다(자기 참조
      금지: `index.css` 상단 주석의 함정)
- [ ] **검증:** `pnpm --filter @murmur/desktop test` 통과 · 앱을 띄워 라이트/다크 모두에서
      기존 화면이 깨지지 않는지 확인(강조색만 바뀐다)

### Task 2: 선택 요청 계약 (화면 변경 없음)

**왜:** 이 계획의 단일 최우선 항목. 화면 전체가 `meta` 필드 하나에 달려 있고, **수신자를 처음부터
넣지 않으면** 모든 선택지가 강조를 받는 버전이 한 번은 배포된다.

**대상:** `packages/shared/src/index.ts` · `packages/server/src/services/messages.ts` ·
`packages/server/src/mcp/mcpPlugin.ts` · `packages/server/test/mcp.test.ts`

- [ ] **Step 1: shared 타입** — `AskMeta` 신설.
      `{ kind: 'ask'; ask: { prompt?: string; options: { id: string; label: string; hint?: string }[];
      to: AskAudience; answeredWith?: string; answeredBy?: string; answeredAt?: string } }`,
      `AskAudience = { kind: 'human' } | { kind: 'account'; accountId: string }`.
      **`to` 를 옵셔널로 두지 않는다** — 없는 수신자는 "사람 아무나"로 해석되어야 하는데, 그 해석을
      화면마다 반복하면 갈라진다. 보내는 쪽이 항상 정하게 한다
- [ ] **Step 2: MCP `message.ask` 도구** — `message.post` 와 같은 삽입 경로를 쓰되 `meta` 에
      `AskMeta` 를 싣는다. 옵션은 2~5개로 제한(하나면 선택이 아니고, 여섯이면 읽히지 않는다).
      `to` 는 handle 로 받아 accountId 로 해석한다 — 없는 handle 은 400
- [ ] **Step 3: 답을 기록하는 경로** — 사람이 옵션을 고르면 그 자체가 **답글 메시지**가 되고
      (본문 = 고른 옵션의 `label`), 서버가 원본 메시지의 `meta.ask.answeredWith/By/At` 을 갱신한다.
      갱신은 `message.updated` 이벤트로 나간다. **원본을 고치는 것이 아니라 답을 덧붙이는 것**이므로
      `editedAt` 은 건드리지 않는다(사람이 고친 것이 아니다)
- [ ] **Step 4: 중복 답 방지** — 이미 `answeredWith` 가 있으면 두 번째 답은 400. 두 사람이 동시에
      누르면 먼저 도착한 것이 이긴다는 규칙을 테스트로 고정한다
- [ ] **검증:** `packages/server/test/mcp.test.ts` 에 ask 발행·답·중복 거절 3케이스.
      **모르는 meta 통과 회귀선** — 옛 데스크탑이 읽어도 본문만 보이면 된다는 것을 타입으로 고정

### Task 3: 선택지 컴포넌트 + 수신자 배지

**왜:** 여기서 처음으로 경로가 관통한다. 사람이 클릭 한 번으로 답하고, 남에게 간 물음은 강조를 받지 않는다.

**대상:** `packages/desktop/src/components/AskCard.tsx`(신규) ·
`packages/desktop/src/components/MessageItem.tsx` · `packages/desktop/src/state/controller.ts` ·
`packages/desktop/test/askCard.test.tsx`(신규)

- [ ] **Step 1: `AskCard`** — `meta.kind === 'ask'` 일 때만 렌더. 옵션은 **본문 크기**로 그린다
      (읽고 골라야 하니까). 답이 이미 있으면 고른 것만 남기고 나머지는 접는다 — 기록은 남되
      다시 누를 수는 없다
- [ ] **Step 2: 수신자에 따른 두 얼굴** — `to.kind === 'human'` 이면 강조 테두리 + `--app-state-turn`
      머리글("골라 줘"), 다른 에이전트에게 간 것이면 **무채색**(`--app-border-agent`) + 머리글에
      누가 고르는지("forge 가 고른다"). 옵션은 읽히되 **누를 수 없다**
- [ ] **Step 3: 수신자 배지** — 이름줄에 `→ 나` / `→ forge`. `→ 나` 만 강조색.
      배지는 `AskCard` 밖에도 쓰이므로 `MessageItem` 의 이름줄에 둔다(되물음·실패도 같은 배지를 쓴다)
- [ ] **Step 4: 답 보내기** — 옵션 클릭 → `controller.answerAsk(messageId, optionId)` →
      답글 전송 + 낙관적 갱신 없이 서버 응답을 기다린다(#Reactions 의 선례: 화면은 언제나 서버와 같다)
- [ ] **검증:** 사람에게 온 것/에이전트에게 간 것/이미 답한 것 3상태 스냅샷 · 클릭이 답글을 만드는지 ·
      **에이전트에게 간 카드의 옵션에 `disabled` 가 붙는지**

### Task 4: 진행(progress)을 상태 한 줄로 접는다

**왜:** `kind='progress'` 는 이미 서버에 있고 MCP `message.progress` 로 들어오는데
(#144, 마이그레이션 014), **데스크탑이 특별히 그리지 않아 일반 발화로 흐른다**. 규칙 02("로그가 아니라
사람의 말")가 지금 이 자리에서 새고 있다.

**대상:** `packages/desktop/src/components/MessageItem.tsx` ·
`packages/desktop/src/components/ChannelPane.tsx` · `packages/desktop/test/progressRow.test.tsx`(신규)

- [ ] **Step 1: 연속 progress 를 접는다** — 같은 저자의 연속된 `kind='progress'` 는 **마지막 하나만**
      상태 한 줄로 그린다(`● forge 작업 중 · 3분째`). 앞의 것들은 접힌 채로 남고 펼칠 수 있다
- [ ] **Step 2: 상태 한 줄의 형식** — 점 + 저자 + 경과. 문장을 그대로 쓰지 않는다 —
      progress 본문은 요약의 재료이지 발화가 아니다
- [ ] **Step 3: 터미널로 가는 길** — 상태 한 줄 끝에 `터미널`(소유자에게만 — `TerminalChip` 의
      판정을 그대로 재사용한다). 여기가 규칙 06 의 실행이다
- [ ] **검증:** progress 3개가 한 줄로 접히는지 · 사이에 `user` 발화가 끼면 그룹이 끊기는지 ·
      소유자가 아니면 터미널 링크가 **없는지**(비활성이 아니라 부재)

---

## Phase 2 — 여럿이 일할 때

### Task 5: 에이전트 간 주고받기 접힘

**대상:** `packages/desktop/src/components/AgentExchange.tsx`(신규) ·
`packages/desktop/src/components/ThreadPanel.tsx` · `packages/desktop/test/agentExchange.test.tsx`(신규)

- [ ] **Step 1: 묶음 판정** — 저자가 둘 다 에이전트이고 사람이 끼지 않은 **연속 구간**을 하나로 묶는다.
      판정은 표시 단계에서만 한다 — 저장 구조를 바꾸지 않는다
- [ ] **Step 2: 접힌 한 줄** — `forge ↔ codex · 4번 주고받음 · 마지막 4:09 · 펼치기`.
      펼침 상태는 스레드 단위 로컬 상태(서버에 동기화하지 않는다 — 기기의 속성이다)
- [ ] **Step 3: 예외** — 구간 안에 **실패**가 있으면 접지 않는다. 실패는 언제나 사람에게 오는 말이다
- [ ] **검증:** 2인 구간이 접히는지 · 사람 발화가 끼면 두 묶음으로 갈리는지 · 실패가 있으면 안 접히는지

### Task 6: 스레드 상태 5단 + 채널 요약 줄

**대상:** `packages/desktop/src/lib/threadState.ts`(신규) ·
`packages/desktop/src/components/MessageItem.tsx` · `packages/desktop/src/components/Sidebar.tsx` ·
`packages/desktop/test/threadState.test.ts`(신규)

- [ ] **Step 1: 판정 함수** — `threadState(messages, me, accounts)` →
      `'running' | 'my-turn' | 'waiting' | 'done' | 'stuck'`. **순수 함수로 분리한다** —
      이 판정이 화면 여러 곳(채널 요약 · 사이드바 · 스레드 목록)에서 같아야 하고, 컴포넌트 안에 두면
      세 곳이 조용히 갈라진다
- [ ] **Step 2: 채널 요약 줄 확장** — 지금의 답글 요약(#424 텍스트 링크) 아래/옆에 상태를 한 줄 더.
      `내 차례 — forge 가 범위를 묻는다 · 2분째`. **`→ 나` 인 막는 말이 있을 때만 강조색**
- [ ] **Step 3: 사이드바 세 덩이** — `내 차례` / `남을 기다림` / `도는 중`. 채널 목록 **위**에 둔다 —
      앱을 열었을 때 먼저 보여야 하는 것이 그것이다
- [ ] **Step 4: 러너 생존과 묶는다** — `running` 은 러너가 살아 있을 때만이다.
      생존 신호가 없으면 `stuck` 으로 떨어뜨린다(#124 의 `inbox.poll` liveness).
      **죽었는데 "도는 중"이면 사람은 영원히 기다린다** — 이 안의 유일한 치명적 실패 모드다
- [ ] **검증:** 5상태 각각의 판정 테이블 테스트 · 생존 신호가 끊기면 `running → stuck` 으로 넘어가는지

### Task 7: 대기 사슬과 교착

**대상:** `packages/desktop/src/lib/waitChain.ts`(신규) ·
`packages/desktop/src/components/WaitChain.tsx`(신규) · `packages/desktop/test/waitChain.test.ts`(신규)

- [ ] **Step 1: 사슬 계산** — 답을 기다리는 ask 들을 이어 `codex → forge → 나` 를 만든다.
      끝이 나면 `my-turn`, 아무 데도 안 닿으면 교착
- [ ] **Step 2: 순환 방지** — A→B→A 는 즉시 교착으로 끊는다. 방문 집합으로 막고 테스트로 고정한다
      (없으면 무한 루프가 렌더에서 터진다)
- [ ] **Step 3: 표시** — 스레드 안에서는 한 줄(`codex 가 forge 의 답을 기다린다 · 4분`),
      막는 말 옆에는 "답하면 codex 도 풀린다". **몇 개가 풀리는지가 사람이 답할 이유다**
- [ ] **Step 4: 교착의 대접** — 실패와 같다. 강조 + 고치는 경로(터미널 · 다시 부르기)
- [ ] **검증:** 사슬 3단 · 순환 · 끊긴 사슬(응답 없는 에이전트) 세 케이스

### Task 8: 집합 호출의 결과 · 참여자 줄 · 터미널 선택자

**대상:** `packages/desktop/src/components/Composer.tsx` ·
`packages/desktop/src/components/ThreadPanel.tsx` ·
`packages/desktop/src/components/TerminalChip.tsx` → `TerminalPicker.tsx`(승격)

- [ ] **Step 1: 자동완성에 구성원 수** — 집합 후보에 `memberCount` 를 보인다.
      `HandleGroupRow.memberCount` 는 **이미 서버가 실어 준다**(그 필드 주석이 바로 이 요구를 적고 있다) —
      화면이 안 쓰고 있을 뿐이다
- [ ] **Step 2: 부른 뒤의 한 줄** — `release 3명을 불렀다 — forge · codex 는 깼고 lint 는 응답이 없다`
      + `다시 부르기`. 셋을 불러 둘만 깨어난 것은 **조용한 실패**이고 지금은 말할 자리가 없다.
      판정은 Task 6 의 생존 신호를 재사용한다
- [ ] **Step 3: 참여자 줄** — 스레드 헤더에 참여 에이전트 아바타. 도는 자는 진하게, 막힌 자는 옅게,
      응답 없는 자는 회색
- [ ] **Step 4: 터미널 선택자** — `TerminalChip`(메시지마다 흩어져 있다)을 스레드 헤더의
      **드롭다운**으로 올린다. 세션이 `(에이전트, 스레드)` 당 하나이므로 자리가 스레드 헤더인 것이 맞다.
      **소유자 판정은 그대로 재사용**하고, 고를 것이 하나도 없으면 손잡이 자체를 그리지 않는다.
      메시지의 칩은 남겨 둔다(작은 화면에서 헤더가 먼저 접힌다)
- [ ] **검증:** 집합 후보의 수 표시 · 부분 응답 한 줄 · 소유자 아닌 계정에서 선택자 부재 ·
      선택자가 스레드의 에이전트만 담는지

---

## Phase 3 — 읽히는 말과 마감

### Task 9: 완료 보고 + 다음 제안

**대상:** `packages/shared/src/index.ts` · `packages/server/src/mcp/mcpPlugin.ts` ·
`packages/desktop/src/components/ReportCard.tsx`(신규)

- [ ] **Step 1: `ReportMeta`** — `{ kind: 'report'; report: { checks: string[]; files?: string[];
      remaining?: string[]; durationMs?: number; next?: { id: string; label: string }[] } }`.
      MCP `message.report` 로 싣는다
- [ ] **Step 2: 읽기 조판** — 확인 목록 + 바뀐 파일 + 남은 것. **강조색을 쓰지 않는다** —
      읽히는 말이지 막는 말이 아니다. 본문 크기, 넉넉한 행간
- [ ] **Step 3: 다음 제안 칩** — 누르면 **그 스레드에 새 부탁이 들어간다**(사람이 다시 타이핑하지
      않는다). 칩은 보내기 전 작성창을 채우는 방식으로 둔다 — 한 번의 확인을 남긴다
- [ ] **Step 4: 형식을 안 지키면 사라진다** — `checks` 가 비면 카드를 그리지 않고 본문만 보여 준다.
      빈 상자는 거짓 신호다
- [ ] **검증:** 형식 있음/없음 두 경로 · 칩이 작성창을 채우는지

### Task 10: 공통 위생

**대상:** `MessageItem.tsx` · `ThreadPanel.tsx` · `ChannelPane.tsx` · `Menu.tsx` · `index.css`

- [ ] **Step 1: 타이포 4단 고정** — 화면 제목 19 / 본문·이름 14 / 보조 12 / 라벨 11.
      지금 10·10.5·11·11.5px 이 섞여 위계가 아니라 잡음이다. 회색도 3단까지만
- [ ] **Step 2: 상자 예산 1개** — 한 메시지의 테두리 상자는 최대 하나이고, 그 하나는 `AskCard` 가 쓴다.
      나머지(리액션 칩 등)는 텍스트로 내린다
- [ ] **Step 3: 스레드 폭** — `w-96` 고정을 버리고 가변 + 최소 `480px`.
      선택지·보고문·사슬이 들어갈 자리가 필요하다. 리사이저는 사이드바의 선례를 따른다
- [ ] **Step 4: 본문 최대폭** — 대화 열에 `max-w-[70ch]`. 넓은 창에서 보고문이 한 줄 100자를 넘는다
- [ ] **Step 5: 오버레이 규칙 하나** — 스크림 + Esc + 포커스 트랩을 프리미티브로 뽑고
      Directory·Inbox·Saved·SearchPalette 가 함께 쓴다(**Directory 가 Esc 로 안 닫힌다** — 실측)
- [ ] **검증:** 기존 스냅샷 갱신 · Esc 로 닫히는 회귀선 4개

### Task 11: 컴포넌트 갤러리

**왜:** "이후 기능 개발이 기존 디자인을 따라간다"가 실제로 가능해지는 지점이다.
따라갈 것이 한 화면에 모여 있어야 한다.

**대상:** `packages/desktop/src/screens/GalleryScreen.tsx`(신규) ·
`packages/desktop/src/components/settings/sections.ts`

- [ ] **Step 1: 여덟 가지 말 × 두 수신자** — 부탁 · 되물음 · 선택 · 넘김 · 진행 · 보고 · 제안 · 실패를
      사람/에이전트 수신자별로 전부 한 화면에
- [ ] **Step 2: 경계 상태** — 편집 중 · 권한 없음 · 미읽음 구분선 · 교착 · 부분 응답
- [ ] **Step 3: 숨은 진입점** — 설정의 개발자 섹션 또는 단축키. 배포본에서 눈에 띄지 않게 둔다
- [ ] **검증:** 갤러리가 렌더되는 스모크 테스트 하나 — 여기가 깨지면 어휘가 깨진 것이다

---

## 열린 결정 (착수 전에 정한다)

1. **선택지의 계약 자리** — MCP 도구(`message.ask`)인가 `message.post` 의 `meta` 인가.
   이 계획은 **도구**를 전제로 썼다(발행 시점에 옵션 수·수신자 handle 을 서버가 검증할 수 있다).
2. **집합 호출 = 스레드 하나** — `@release` 로 셋을 부르면 스레드 하나에 셋이 들어온다는 전제로 그렸다.
   각자 스레드가 생기는 쪽이면 Task 6·8 의 모양이 달라진다.
3. **에이전트 간 선택의 기본값** — 접어 두고 펼치게 한다(이 계획). 아예 스레드에서 빼고 터미널에만
   남기면 더 조용하지만 "왜 이렇게 정해졌나"의 근거가 사라진다.
4. **`running` 의 근거** — `inbox.poll` 연결을 생존으로 볼지, 마지막 발화 시각을 볼지.
   Task 6 Step 4 가 여기 걸려 있다.
5. **UI 언어** — 영어 기본 + 한국어 번역인가, 한국어 단일인가. Task 10 의 문자열 정리 범위가 갈린다.
