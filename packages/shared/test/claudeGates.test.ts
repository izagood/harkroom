// 계정 관문 미리 적기(2026-10-01) 회귀선. 근거는 `src/claudeGates.ts` 머리 주석.
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { markClaudeAccountGates, withClaudeAccountGates } from '../src/claudeGates.js';

describe('withClaudeAccountGates', () => {
  it('빈 문서에 두 키를 채운다', () => {
    expect(withClaudeAccountGates({})).toEqual({
      hasCompletedOnboarding: true,
      autoModeEnvSetup: { dismissed: true },
    });
  });

  it('이미 지난 계정은 null — 쓰지 않는다', () => {
    expect(withClaudeAccountGates({
      hasCompletedOnboarding: true, autoModeEnvSetup: { denials: 5, dismissed: true },
    })).toBeNull();
  });

  it('하네스가 담아 둔 다른 값(denials·projects 등)은 그대로 둔다', () => {
    const next = withClaudeAccountGates({
      numStartups: 9, projects: { '/w': { hasTrustDialogAccepted: true } },
      autoModeEnvSetup: { denials: 5, dismissedAt: 1 },
    });
    expect(next).toEqual({
      numStartups: 9, projects: { '/w': { hasTrustDialogAccepted: true } },
      hasCompletedOnboarding: true,
      autoModeEnvSetup: { denials: 5, dismissedAt: 1, dismissed: true },
    });
  });
});

describe('markClaudeAccountGates', () => {
  const dir = () => mkdtemp(join(tmpdir(), 'gates-'));

  it('파일이 없으면 만들고(0600), 있으면 합친다', async () => {
    const d = await dir();
    expect(await markClaudeAccountGates(d)).toBe(true);
    const path = join(d, '.claude.json');
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ hasCompletedOnboarding: true });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('다 적혀 있으면 파일을 다시 쓰지 않는다 — 하네스와 경합하지 않는다', async () => {
    const d = await dir();
    const path = join(d, '.claude.json');
    const text = JSON.stringify({ hasCompletedOnboarding: true, autoModeEnvSetup: { dismissed: true }, x: 1 });
    await writeFile(path, text);
    expect(await markClaudeAccountGates(d)).toBe(false);
    expect(await readFile(path, 'utf8')).toBe(text);
  });

  it('깨진 파일은 덮어쓰지 않고 던진다 — 하네스의 상태를 우리 최소 문서로 지우지 않는다', async () => {
    const d = await dir();
    const path = join(d, '.claude.json');
    await writeFile(path, '{ not json');
    await expect(markClaudeAccountGates(d)).rejects.toThrow();
    expect(await readFile(path, 'utf8')).toBe('{ not json');
  });
});
