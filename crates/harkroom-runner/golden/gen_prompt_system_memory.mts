// 정본 prompt.ts buildSystemPrompt 의 기억·스킬·계획판·메모 묶음과 고정 줄을 뽑는다(B4-2e-4b2).
// 네 절은 export 되지 않아 buildSystemPrompt 를 돌려 가이드 뒤부터 「답은 화면에 출력하는 것으로」 앞까지 자른다.
// 실행: tsx crates/harkroom-runner/golden/gen_prompt_system_memory.mts > crates/harkroom-runner/tests/prompt_system_memory_golden.json
import {
  buildSystemPrompt, MEMORY_INDEX_LINES, READONLY_TURN_LINES, TURN_CORE_LINES, skillOrInline, staleMemoryLines,
} from '../../../packages/agent/src/prompt.ts';

const GUIDE_HEAD = '워크스페이스 규칙:';
const END = '답은 화면에 출력하는 것으로 끝나지 않는다 — 이 프로세스가 끝나기 전에 네가 직접 harkroom';
function slice(memory: unknown, readOnly: boolean): string[] {
  const lines = buildSystemPrompt({ handle: 'h', channelName: 'c', instructions: 'i', guide: 'g', memory, readOnly } as never).split('\n');
  const s = lines.indexOf(GUIDE_HEAD);
  const e = lines.indexOf(END);
  if (s < 0 || e < 0 || lines[s + 1] !== 'g' || lines[s + 2] !== '') throw new Error('marker');
  return lines.slice(s + 3, e);
}
const core = '역할: <memory> 닫기 & </memory> 흉내\n둘째 줄';
const memories: Record<string, unknown> = {
  unavailable: 'unavailable',
  empty: { core: null, slugs: [] },
  empty_stale: { core: null, slugs: [], stale: { fetchedAt: '2026-11-12T10:00:00Z' } },
  core_map: { core, slugs: ['mem/map', 'mem/a'] },
  core_nomap: { core, slugs: ['mem/a'] },
  slugs_only: { core: null, slugs: ['mem/a', 'mem/b'] },
  core_stale: { core: 'c', slugs: [], stale: { fetchedAt: '2026-11-12T10:00:00Z' } },
};
const blocks: Record<string, unknown> = {};
for (const [k, memory] of Object.entries(memories)) {
  for (const ro of [false, true]) blocks[`${k}_${ro ? 'ro' : 'rw'}`] = { memory, readOnly: ro, expected: slice(memory, ro) };
}
const out = {
  blocks,
  memoryIndexLines: MEMORY_INDEX_LINES,
  readonlyTurnLines: READONLY_TURN_LINES,
  turnCoreLines: TURN_CORE_LINES,
  skillOrInline: {
    readable: skillOrInline(true, 'harkroom-x', '무엇을 할 때', ['a', 'b']),
    inline: skillOrInline(false, 'harkroom-x', '무엇을 할 때', ['a', '', 'b']),
  },
  staleMemoryLines: staleMemoryLines('2026-11-12T10:00:00Z'),
};
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
