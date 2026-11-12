// Rust 러너(`crates/harkroom-runner/src/skills_sync.rs`)가 싣는 내장 스킬 골든 — s8 B4-2e-3, Rust 전환.
//
// 정본은 `src/builtinSkills.ts` 의 `BUILTIN_SKILLS` 다. Rust 는 같은 목록을 두 벌로 적지 않고
// `crates/harkroom-runner/golden/builtin_skills.json` 을 `include_str!` 로 싣는다. 이 시험이 정본과 그 파일을
// 비교한다(다르면 빨강). 내장 스킬을 고쳤다면 `UPDATE_BUILTIN_SKILLS_GOLDEN=1 npx vitest run test/builtinSkillsGolden.test.ts`
// 로 다시 쓴다.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILL_PREFIX, BUILTIN_SKILLS } from '../src/builtinSkills.js';

const GOLDEN = join(import.meta.dirname, '..', '..', '..', 'crates', 'harkroom-runner', 'golden', 'builtin_skills.json');

describe('builtin skills golden (Rust runner)', () => {
  it('matches BUILTIN_SKILLS', () => {
    const want = `${JSON.stringify({ prefix: BUILTIN_SKILL_PREFIX, skills: BUILTIN_SKILLS.map(({ slug, body }) => ({ slug, body })) }, null, 2)}\n`;
    if (process.env.UPDATE_BUILTIN_SKILLS_GOLDEN === '1') writeFileSync(GOLDEN, want);
    expect(readFileSync(GOLDEN, 'utf8')).toBe(want);
  });
});
