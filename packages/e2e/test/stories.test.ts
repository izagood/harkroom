import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadStoryboard, validate } from '../src/stories.js';

const repoRoot = join(import.meta.dirname, '..', '..', '..');
const sb = loadStoryboard();

describe('스토리보드 형식', () => {
  it('형식 오류가 없다(모르는 동작·페르소나·없는 시험 파일 포함)', () => {
    expect(validate(sb, (p) => existsSync(join(repoRoot, p)))).toEqual([]);
  });

  it('여정 J1~J14 가 빠짐없이 있다', () => {
    expect(sb.journeys.map((j) => j.id)).toEqual(Array.from({ length: 14 }, (_, i) => `J${i + 1}`));
  });

  it('owner 한 명이 아니라 여러 역할을 돈다', () => {
    const roles = new Set(sb.personas.map((p) => p.role));
    for (const r of ['owner', 'admin', 'member', 'guest', 'none']) expect(roles).toContain(r);
  });

  it('없는 동작·없는 파일·실명 handle 은 잡는다', () => {
    const bad = structuredClone(sb);
    bad.personas[0]!.handle = 'alice';
    bad.journeys[0]!.steps[0]!.act = 'nope' as never;
    bad.journeys[0]!.existing = [{ kind: 'server-vitest', file: 'packages/server/test/nope.test.ts', note: '' }];
    const errors = validate(bad, (p) => existsSync(join(repoRoot, p)));
    expect(errors.some((e) => e.includes('e2e-*'))).toBe(true);
    expect(errors.some((e) => e.includes('모르는 동작 nope'))).toBe(true);
    expect(errors.some((e) => e.includes('없는 시험 파일'))).toBe(true);
  });
});
