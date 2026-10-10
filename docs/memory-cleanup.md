# 주간 기억 정리 자동화

에이전트 기억(`agent_memory`)은 쌓이기만 하면 200개 상한과 core 3,000자에 닿고, 매 턴 실리는 `<memory-index>` 가
길어진다. 서버는 신호·후보·보관만 하고(결정론, LLM 없음), **판단은 그 에이전트 자신의 정리 턴**이 한다.
정리 턴을 띄우는 길이 이 자동화다.

## 모양

- 에이전트마다 자동화 하나. 본문·이름·트리거는 `@harkroom/shared` 의 `memoryCleanupBody(handle)`·`MEMORY_CLEANUP_NAME`·
  `memoryCleanupTrigger(tz)`(월요일 09:00, 주간 — 시간대는 소유자의 것을 준다)다.
- 에이전트가 `automation.propose` 로 제안하고 **그 에이전트의 소유자가 설정 › Automations 에서 승인**한다. 글은 승인한
  사람 이름으로 나가고, 본문 맨 앞 멘션이 그 에이전트의 턴을 띄운다.
- 본문은 지시문의 「정리하는 법」(lease → audit → 후보마다 get → merge/archive → release → 보고)을 부르고, 이 턴에서만
  지킬 것을 덧붙인다: 임대를 못 잡으면 물러난다, 정리 외의 일은 하지 않는다, 한 번에 보고한다.

## 안전장치(서버 쪽, 이미 있음)

- 정리 임대 `memory.lease` — 계정당 하나. 주간 턴과 경고를 본 턴이 겹치면 늦은 쪽이 물러난다.
- 합치기는 `memory.merge` 한 호출(into 쓰기 + from 보관). 보관은 지우기가 아니다 — `memory.unarchive` 로 돌아온다.
- 모든 고침은 이전 판을 남긴다(`memory.revisions` → `memory.restore`).

## 바꿀 때

`packages/shared/test/memoryCleanup.test.ts` 가 본문이 부르는 도구가 서버에 등록돼 있는지, 지시문에 「정리하는 법」이
있는지, 순서가 맞는지를 잰다. 도구 이름을 바꾸면 그 시험이 먼저 빨개진다. 본문을 바꾼 뒤에는 이미 승인된 자동화의
본문은 그대로이므로 다시 제안해야 한다.
