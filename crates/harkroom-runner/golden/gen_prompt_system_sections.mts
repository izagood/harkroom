// 정본 prompt.ts buildSystemPrompt 의 merge·permission·api 절을 뽑는다(B4-2e-4b1).
// 세 절은 export 되지 않아 buildSystemPrompt 를 한 절만 켠 채로 돌리고 앞뒤 고정 줄 사이를 자른다.
// 실행: tsx crates/harkroom-runner/golden/gen_prompt_system_sections.mts > crates/harkroom-runner/tests/prompt_system_sections_golden.json
import { buildSystemPrompt } from '../../../packages/agent/src/prompt.ts';

const START = '답 없이 남는다. 눈에 띈 요청은 대신 하지 말고 그 사실만 네 스레드에 한 줄 적어라.';
const END = '저장소에 PR 을 열면 본문 **맨 끝**에 이 줄을 넣는다:';
const base = {
  handle: 'h', channelName: 'c', instructions: 'i', guide: 'g',
  memory: 'unavailable' as const,
};
function slice(extra: Record<string, unknown>): string[] {
  const lines = buildSystemPrompt({ ...base, ...extra } as never).split('\n');
  const s = lines.indexOf(START);
  const e = lines.indexOf(END);
  if (s < 0 || e < 0) throw new Error('marker');
  return lines.slice(s + 2, e);
}
const bin = '/Applications/Harkroom.app/Contents/MacOS/harkroom-operator';
const cases: Record<string, { kind: string; input: unknown }> = {
  merge_none: { kind: 'merge', input: { operatorBin: bin, repos: [] } },
  merge_repos: { kind: 'merge', input: { operatorBin: bin, repos: ['o/r', 'p/q'] } },
  merge_org_approved: { kind: 'merge', input: { operatorBin: bin, repos: ['izagood/*'], approved: [{ repo: 'o/r', number: 7 }, { repo: 'p/q', number: 12 }] } },
  perm_min: { kind: 'permissions', input: { toolAllows: [] } },
  perm_all: { kind: 'permissions', input: { toolAllows: ['Bash(kubectl get:*)', 'Bash(gh pr view:*)'], commandHook: true, exactShellOnly: true, newPostsHook: true } },
  perm_hook_only: { kind: 'permissions', input: { toolAllows: ['Bash(ls)'], newPostsHook: true } },
  api_none: { kind: 'api', input: { operatorBin: bin, connectors: [] } },
  api_some: { kind: 'api', input: { operatorBin: bin, connectors: ['github', 'linear'] } },
  api_delegatable: { kind: 'api', input: { operatorBin: bin, connectors: ['github'], delegatable: ['github', 'x'] } },
};
const out: Record<string, unknown> = {};
for (const [k, c] of Object.entries(cases)) out[k] = { ...c, expected: slice({ [c.kind]: c.input }) };
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
