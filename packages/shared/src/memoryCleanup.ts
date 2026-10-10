/**
 * 주간 기억 정리 자동화(메모리 C3, 설계 스레드 ef79b61f 의 5e177fd9 §7). 에이전트마다 하나를 `automation.propose` 로
 * 제안하고, 그 에이전트의 소유자가 설정 › Automations 에서 승인한다. 글은 승인한 사람 이름으로 나가 그 에이전트의
 * 정리 턴을 띄운다(본문 **맨 앞** 멘션만 턴을 띄운다).
 *
 * 절차 자체는 에이전트 지시문의 「정리하는 법」(agent `prompt.ts`)이 정본이다 — 이 본문은 그 절차를 부르고, 이 턴에서만
 * 지킬 것(임대·한도·보고 모양)을 덧붙인다. 도구 이름이 바뀌면 `memoryCleanup.test.ts` 가 서버 등록과 견준다.
 *
 * 서버 코드는 바꾸지 않는다: 임대(`memory.lease`)·후보(`memory.audit`)·합치기(`memory.merge`)·보관(`memory.archive`)은
 * C1(#1131)에 이미 있다. 2단계 recall(R1)에 기대지 않는다.
 */

/**
 * 기본 시각 — 월요일 09:00, **그 설치·소유자의 시간대**로. 시간대를 여기 박지 않는다: 설치마다 다르고, 한 곳의
 * 시간대를 기본값으로 두면 다른 곳에서는 엉뚱한 시각에 돈다. 부르는 쪽이 보는 사람의 IANA 시간대를 준다
 * (desktop 은 `Intl.DateTimeFormat().resolvedOptions().timeZone`). 사람이 승인할 때 바꿀 수 있다.
 */
export function memoryCleanupTrigger(tz: string) {
  return { kind: 'schedule', freq: 'weekly', weekdays: [1], time: '09:00', tz } as const;
}

export const MEMORY_CLEANUP_NAME = (handle: string): string => `주간 기억 정리 — @${handle}`;

/** 이 본문이 부르는 harkroom MCP 도구 — 시험이 서버 등록과 견준다. */
export const MEMORY_CLEANUP_TOOLS = [
  'memory.lease', 'memory.audit', 'memory.get', 'memory.merge', 'memory.archive', 'memory.set',
  'memory.revisions', 'memory.restore', 'message.post',
] as const;

/**
 * 자동화 본문. `handle` 은 정리할 에이전트 — 맨 앞 멘션이라야 그 에이전트의 턴이 뜬다. 채널 전체 토큰은 쓰지 않는다.
 */
export function memoryCleanupBody(handle: string): string {
  return [
    `@${handle} 주간 기억 정리 시간이다. 지시문의 「정리하는 법」 그대로 한다.`,
    '',
    '1. `memory.lease` 를 acquire 로 잡는다(60분). `acquired: false` 면 다른 턴이 정리 중이다 — 아무것도 고치지 말고 그 사실만 한 줄 남기고 끝낸다.',
    '2. `memory.audit` 으로 후보를 받는다. `truncated` 면 고친 뒤 다시 부른다.',
    '3. 후보마다 `memory.get` 으로 **읽고** 판단한다. 이름만 보고 고치지 않는다.',
    '   - 같은 주제 여럿 → `memory.merge` 한 번(into·from·value·ifUpdatedAt). 경위는 버리고 되풀이할 사실만 남긴다.',
    '   - 끝난 일·안 쓰는 것 → 지우지 말고 `memory.archive`.',
    '   - 곧 밀려날 journal(`expiringJournal`) → 되풀이할 교훈만 topic·procedure 로 증류한다.',
    '   - 요약 없는 것 → "언제 열어 볼지" 한 줄을 `description` 으로 채운다(`memory.set`, 본문은 그대로).',
    '   - core 가 길면 한 주제 절을 `mem/*` 로 내리고 포인터만 남긴다.',
    '   - 틀린 것만 지운다. 잘못 고쳤으면 `memory.revisions` → `memory.restore`.',
    '4. 다른 일은 하지 않는다 — 코드·PR·다른 스레드는 손대지 않는다.',
    '5. 임대를 release 로 놓고, 이 스레드에 `message.post` 로 한 번 보고한다: 합친 것(into ← from) · 보관한 것 · 증류한 것 · 고친 요약 수 · 정리 전후 항목 수(N/200)·journal 수.',
  ].join('\n');
}
