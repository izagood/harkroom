import { describe, it, expect } from 'vitest';
import { BUILTIN_SKILLS, BUILTIN_SKILL_PREFIX } from '@harkroom/shared/builtinSkills';
import { laneSafeSkill } from '../src/mentionTurn.js';
import { readsBuiltinSkills } from '../src/adapters/index.js';
import { buildSystemPrompt, skillOrInline } from '../src/prompt.js';

/** 내장 스킬(S P3)의 모양과, 못 읽는 턴이 잃는 것이 없다는 선. */
describe('내장 스킬 (2026-10-27 S P3)', () => {
  it('내장 스킬은 harkroom- 접두·서버 slug 규칙을 지키고, frontmatter 는 name·description 뿐이라 API 키 연결 턴에도 깔린다', () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThan(0);
    const slugs = new Set<string>();
    for (const b of BUILTIN_SKILLS) {
      expect(b.slug.startsWith(BUILTIN_SKILL_PREFIX), b.slug).toBe(true);
      expect(b.slug, b.slug).toMatch(/^[a-z0-9-]{2,40}$/);
      expect(laneSafeSkill(b.body), b.slug).toBe(true);
      expect(b.body.startsWith(`---\nname: ${b.slug}\ndescription: `), b.slug).toBe(true);
      expect(slugs.has(b.slug), b.slug).toBe(false);
      slugs.add(b.slug);
    }
  });

  it('스킬을 읽는 턴은 어댑터 skillDirs 가 있는 일반 턴뿐이다 — 읽기 전용·skillDirs 가 빈 하네스는 못 읽는다', () => {
    expect(readsBuiltinSkills('claude-code')).toBe(true);
    expect(readsBuiltinSkills('codex')).toBe(true);
    expect(readsBuiltinSkills('claude-code', { readOnly: true })).toBe(false);
    expect(readsBuiltinSkills('codex', { readOnly: true })).toBe(false);
    for (const h of ['opencode', 'pi', 'omp'] as const) expect(readsBuiltinSkills(h), h).toBe(false);
  });

  it('skillOrInline: 읽는 턴은 포인터 한 줄, 못 읽는 턴은 옮기기 전 절차를 그대로 싣는다', () => {
    const inline = ['절차 1', '절차 2'];
    expect(skillOrInline(true, 'harkroom-x', '언제 한 줄', inline)).toEqual(['언제 한 줄 — 자세한 절차는 스킬 `harkroom-x` 를 연다.']);
    expect(skillOrInline(false, 'harkroom-x', '언제 한 줄', inline)).toEqual(inline);
  });

  it('지금은 옮긴 절차가 없어 skillsReadable 이 시스템 프롬프트를 바꾸지 않는다 — 못 읽는 턴이 잃는 것이 없다', () => {
    const base = { handle: 'forge', channelName: 'dev', instructions: '', guide: '', memory: { core: null, slugs: [] } };
    expect(buildSystemPrompt({ ...base, skillsReadable: true })).toBe(buildSystemPrompt({ ...base, skillsReadable: false }));
  });
});
