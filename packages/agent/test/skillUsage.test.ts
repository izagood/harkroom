// D3(2026-10-01): 이 턴에 하네스가 부른 스킬을 세션 기록에서 읽는다. 실물 모양은
// `{"type":"tool_use","name":"Skill","input":{"skill":"runner-harness-work"}}`(2026-10-01 기록 213개 실측).
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readSkillUses } from '../src/skillUsage.js';

const SID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const T0 = Date.parse('2026-10-01T03:00:00.000Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

async function seed(lines: unknown[]): Promise<string> {
  const projects = await mkdtemp(join(tmpdir(), 'skill-use-'));
  const proj = join(projects, '-private-tmp-whatever-cwd');
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return projects;
}

const call = (s: number, name: string, input: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'assistant', timestamp: at(s), ...extra,
  message: { role: 'assistant', stop_reason: 'tool_use', content: [
    { type: 'text', text: '스킬을 연다' },
    { type: 'tool_use', id: `t${s}`, name, input },
  ] },
});

describe('readSkillUses', () => {
  it('이 턴의 Skill 호출 slug 를 앞에서부터 중복 없이 준다', async () => {
    const projectsDir = await seed([
      call(-10, 'Skill', { skill: 'old-turn' }), // 앞 턴 — 세지 않는다
      call(1, 'Skill', { skill: 'runner-harness-work' }),
      call(2, 'Bash', { command: 'ls' }),
      call(3, 'Skill', { skill: 'pr-recipe', args: 'x' }),
      call(4, 'Skill', { skill: 'runner-harness-work' }),
    ]);
    expect(await readSkillUses('claude-code', SID, { projectsDir, sinceMs: T0 })).toEqual(['runner-harness-work', 'pr-recipe']);
  });

  it('곁가지(subagent)와 사람 말 속 인용은 세지 않는다', async () => {
    const projectsDir = await seed([
      call(1, 'Skill', { skill: 'from-sidechain' }, { isSidechain: true }),
      { type: 'user', timestamp: at(2), message: { role: 'user', content: [{ type: 'tool_use', name: 'Skill', input: { skill: 'quoted' } }] } },
      call(3, 'Skill', { skill: '' }),
      call(4, 'Skill', { nope: 1 }),
    ]);
    expect(await readSkillUses('claude-code', SID, { projectsDir, sinceMs: T0 })).toEqual([]);
  });

  it('기록을 읽지 않는 하네스·세션 없음·파일 없음은 빈 배열 — 던지지 않는다', async () => {
    const projectsDir = await seed([call(1, 'Skill', { skill: 'x' })]);
    expect(await readSkillUses('codex', SID, { projectsDir, sinceMs: T0 })).toEqual([]);
    expect(await readSkillUses('claude-code', null, { projectsDir })).toEqual([]);
    expect(await readSkillUses('claude-code', 'ffffffff-ffff-ffff-ffff-ffffffffffff', { projectsDir })).toEqual([]);
  });
});
