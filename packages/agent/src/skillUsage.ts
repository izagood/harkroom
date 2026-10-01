// 이 턴에 하네스가 부른 스킬을 기록에서 읽는다(D3, 2026-10-01 — Hermes 자기 개선 검토).
//
// **왜 필요한가.** 승인된 스킬은 모든 에이전트의 모든 턴에 깔린다(`syncSkills`). 무엇이 실제로
// 쓰이는지 근거가 없으면 안 쓰는 스킬을 끌 수 없고, 끌 수 없으면 하나 늘 때마다 모든 턴의
// 비용이 붙는다. 서버는 이 기록으로 "안 쓰는 후보"만 띄운다 — 끄는 것은 사람이다.
//
// **이것은 하네스 출력 파싱이 아니다.** `harnessErrors.ts` 의 거부·마지막 말과 같은 "디스크의
// 사실 관측"이다. claude 는 스킬을 쓸 때 `Skill` 도구를 `{ skill: "<slug>" }` 로 부르고 그
// 호출이 세션 jsonl 에 남는다(2026-10-01 실측: 213개 기록 파일에서 `input.skill`). codex·opencode
// 는 스킬을 파일로 읽어 별도 호출이 남지 않는다 — 그 하네스는 `readsSessionTranscript` 가
// 거짓이라 빈 배열이다(셀 수 없다 ≠ 안 썼다. 서버도 그렇게 적어 둔다).
import type { AgentHarness } from '@harkroom/shared';

import { readsSessionTranscript } from './adapters/index.js';
import { readTranscriptTail, recordsSince, type TranscriptRecord } from './harnessErrors.js';

/** 기록 레코드들에서 `Skill` 도구 호출의 slug 를 앞에서부터, 중복 없이. 순수 함수다. */
export function skillUsesIn(records: TranscriptRecord[]): string[] {
  const out = new Set<string>();
  for (const r of records) {
    if (r.type !== 'assistant') continue;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content as Array<Record<string, unknown>>) {
      if (!part || typeof part !== 'object' || part.type !== 'tool_use' || part.name !== 'Skill') continue;
      const skill = (part.input as { skill?: unknown } | undefined)?.skill;
      if (typeof skill === 'string' && skill.trim()) out.add(skill.trim());
    }
  }
  return [...out];
}

/**
 * 이 턴(`sinceMs` 이후)에 하네스가 부른 스킬 slug. 없거나 못 읽으면 빈 배열. **던지지 않는다** —
 * 사용 기록은 턴의 성패가 아니다. 워크스페이스 스킬인지는 가리지 않는다(하네스·플러그인 스킬도
 * 섞인다) — 승인 목록과 맞추는 것은 서버가 한다(`recordSkillUse`).
 */
export async function readSkillUses(
  harness: AgentHarness,
  sessionId: string | null,
  opts: { projectsDir?: string; configDir?: string | null; sinceMs?: number } = {},
): Promise<string[]> {
  if (!readsSessionTranscript(harness)) return [];
  if (!sessionId) return [];
  const text = await readTranscriptTail(sessionId, opts);
  if (text === null) return [];
  return skillUsesIn(recordsSince(text, opts.sinceMs));
}
