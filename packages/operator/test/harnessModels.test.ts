// 하네스가 받는 모델 목록 — 에이전트 설정의 모델 고르개의 재료(`harnessModels.ts`).
import { describe, it, expect } from 'vitest';
import { CLAUDE_MODEL_ALIASES, listHarnessModels, parseCodexModels, parseOpencodeModels } from '../src/harnessModels.js';

describe('parseCodexModels', () => {
  it('visibility=list 만, priority 순으로 — hide 는 codex 자신의 고르개에도 안 나온다', () => {
    const out = parseCodexModels(JSON.stringify({ models: [
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 12 },
      { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 3 },
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', priority: 1 },
    ] }));
    expect(out).toEqual([{ id: 'gpt-6-astra', label: 'GPT-6-Astra' }, { id: 'gpt-5.5', label: 'GPT-5.5' }]);
  });
  it('모양이 다르면 undefined(모른다) — 빈 목록(없다)과 구별한다', () => {
    expect(parseCodexModels('not json')).toBeUndefined();
    expect(parseCodexModels('{"other":1}')).toBeUndefined();
  });
});

describe('parseOpencodeModels', () => {
  it('provider/model 줄만 받고 경고 줄·빈 줄·중복은 버린다', () => {
    expect(parseOpencodeModels('opencode/big-pickle\nrro/openai/gpt-oss-120b\n\nWARN something\nopencode/big-pickle\n'))
      .toEqual([{ id: 'opencode/big-pickle' }, { id: 'rro/openai/gpt-oss-120b' }]);
  });
});

describe('listHarnessModels', () => {
  it('claude-code 는 목록 명령이 없다 — 별칭만, 실행하지 않는다', async () => {
    const out = await listHarnessModels('claude-code', { path: '/usr/bin', env: {}, home: '/h', exec: () => { throw new Error('실행하면 안 된다'); } });
    expect(out).toBe(CLAUDE_MODEL_ALIASES);
  });
  it('러너와 같은 PATH 로 부른다 — 로그인 셸 PATH 뒤에 설치 관례 자리', async () => {
    const calls: { file: string; args: string[]; PATH?: string }[] = [];
    const out = await listHarnessModels('opencode', {
      path: '/usr/bin', env: {}, home: '/h',
      exec: async (file, args, opts) => { calls.push({ file, args, PATH: opts.env.PATH }); return 'a/b\n'; },
    });
    expect(out).toEqual([{ id: 'a/b' }]);
    expect(calls).toEqual([{ file: 'opencode', args: ['models'], PATH: '/usr/bin:/h/.opencode/bin' }]);
  });
  it('codex 는 debug models 로 묻는다', async () => {
    const calls: string[][] = [];
    await listHarnessModels('codex', { path: '/usr/bin', env: {}, home: '/h', exec: async (_f, args) => { calls.push(args); return '{"models":[]}'; } });
    expect(calls).toEqual([['debug', 'models']]);
  });
  it('실행이 실패하면 undefined — 없다고 말하지 않는다', async () => {
    const out = await listHarnessModels('codex', { path: null, env: {}, home: '/h', exec: async () => { throw new Error('ENOENT'); } });
    expect(out).toBeUndefined();
  });
});
