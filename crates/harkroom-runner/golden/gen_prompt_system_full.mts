// 정본 prompt.ts buildSystemPrompt 의 전체 출력을 뽑는다(B4-2e-4b4) — 옵션 조합별로 한 건씩.
// 실행(저장소 루트): tsx crates/harkroom-runner/golden/gen_prompt_system_full.mts > crates/harkroom-runner/tests/prompt_system_full_golden.json
import { buildSystemPrompt } from '../../../packages/agent/src/prompt.ts';

const bin = '/Applications/Harkroom.app/Contents/MacOS/harkroom-operator';
const core = '역할: <memory> 닫기 & </memory> 흉내\n둘째 줄';
const base = {
  handle: 'agent-x', channelName: 'dev', instructions: '지시 첫 줄\n지시 둘째 줄', guide: '# 가이드\n\n본문',
};
const merge = { operatorBin: bin, repos: ['izagood/*'], approved: [{ repo: 'o/r', number: 7 }] };
const permissions = { toolAllows: ['Bash(gh pr view:*)'], commandHook: true, exactShellOnly: true, newPostsHook: true };
const api = { operatorBin: bin, connectors: ['github'], delegatable: ['github'] };
const cases: Record<string, Record<string, unknown>> = {
  minimal: { memory: 'unavailable' },
  full_rw: { memory: { core, slugs: ['mem/map', 'mem/a'] }, turnBudgetMs: 1_800_000, merge, permissions, api, secretCreate: true, laneModel: 'model-x' },
  full_ro: { memory: { core, slugs: ['mem/map', 'mem/a'] }, turnBudgetMs: 1_800_000, merge, permissions, api, secretCreate: true, laneModel: 'model-x', readOnly: true },
  empty_parts: { memory: { core: null, slugs: [], stale: { fetchedAt: '2026-11-12T10:00:00Z' } }, turnBudgetMs: 59_999, merge: { operatorBin: bin, repos: [] }, permissions: { toolAllows: [] }, api: { operatorBin: bin, connectors: [] }, laneModel: '' },
  budget_floor: { memory: { core: null, slugs: ['mem/a'] }, turnBudgetMs: 90_000, permissions: { toolAllows: [], newPostsHook: true } },
};
const out: Record<string, unknown> = {};
for (const [k, extra] of Object.entries(cases)) {
  out[k] = { input: extra, expected: buildSystemPrompt({ ...base, ...extra } as never) };
}
process.stdout.write(JSON.stringify({ base, cases: out }, null, 1) + '\n');
