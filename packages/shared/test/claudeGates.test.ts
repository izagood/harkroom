// 계정 관문 미리 적기(2026-10-01) 회귀선. 근거는 `src/claudeGates.ts` 머리 주석.
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CLAUDE_ATTENTION_FILE,
  CLAUDE_ATTENTION_TTL_MS,
  clearAccountAttention,
  isAttentionFresh,
  markAccountNeedsAttention,
  markClaudeAccountGates,
  markClaudeWorkspaceTrusted,
  readAccountAttention,
  withClaudeAccountGates,
} from '../src/claudeGates.js';

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

describe('관문 표식 (사람이 지나야 하는 관문, 2026-10-01)', () => {
  const dir = () => mkdtemp(join(tmpdir(), 'attn-'));

  it('남기고 읽고 지운다 — 시각만 담는다', async () => {
    const d = await dir();
    expect(await readAccountAttention(d)).toBeNull();
    await markAccountNeedsAttention(d, 1_000);
    expect(await readAccountAttention(d)).toEqual({ kind: 'gate', atMs: 1_000 });
    expect(JSON.parse(await readFile(join(d, CLAUDE_ATTENTION_FILE), 'utf8'))).toEqual({ kind: 'gate', atMs: 1_000 });
    expect(await clearAccountAttention(d)).toBe(true);
    expect(await readAccountAttention(d)).toBeNull();
    expect(await clearAccountAttention(d)).toBe(false);
  });

  it('깨진 표식은 없는 것으로 본다 — 깨진 파일로 계정을 빼지 않는다', async () => {
    const d = await dir();
    await writeFile(join(d, CLAUDE_ATTENTION_FILE), '{ nope');
    expect(await readAccountAttention(d)).toBeNull();
  });

  it('30분이 지나면 유효하지 않다 — 우리 밖에서 지났을 수도 있으니 다시 재 본다', () => {
    const a = { kind: 'gate' as const, atMs: 0 };
    expect(isAttentionFresh(a, CLAUDE_ATTENTION_TTL_MS - 1)).toBe(true);
    expect(isAttentionFresh(a, CLAUDE_ATTENTION_TTL_MS)).toBe(false);
    expect(isAttentionFresh(null, 0)).toBe(false);
  });

  it('작업 폴더 신뢰를 없을 때만 적고 다른 값은 보존한다', async () => {
    const d = await dir();
    await writeFile(join(d, '.claude.json'), JSON.stringify({ x: 1, projects: { '/a': { y: 2 } } }));
    expect(await markClaudeWorkspaceTrusted(d, '/w')).toBe(true);
    const doc = JSON.parse(await readFile(join(d, '.claude.json'), 'utf8'));
    expect(doc).toEqual({ x: 1, projects: { '/a': { y: 2 }, '/w': { hasTrustDialogAccepted: true } } });
    expect(await markClaudeWorkspaceTrusted(d, '/w')).toBe(false);
  });
});
