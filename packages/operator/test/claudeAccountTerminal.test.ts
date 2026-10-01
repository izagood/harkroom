// 사람이 지나야 하는 관문 → 그 계정의 터미널 열기(2026-10-01).
//
// 러너는 조직 관리 설정 승인 같은 화면을 대신 누르지 않는다. 사람이 설정 화면에서 [터미널 열기]를
// 누르면 데몬이 그 계정의 `CLAUDE_CONFIG_DIR` 로 Terminal.app 의 `claude` 를 연다. 여기서 재는 것:
// 목록이 표식을 싣는가, 스크립트가 무엇을 하는가(경로 인용·표식 지우기), 진짜 창은 띄우지 않는다.
import { mkdtempSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { CLAUDE_ATTENTION_FILE, CLAUDE_ATTENTION_TTL_MS } from '@harkroom/shared/claudeGates';

import { createClaudeAccountsPort, terminalScript } from '../src/claudeAccounts.js';

const NOW = 1_800_000_000_000;

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'd-term-'));
  await mkdir(join(root, 'work', 'aria'), { recursive: true });
  await mkdir(join(root, 'work', 'cedar'), { recursive: true });
  await writeFile(join(root, 'pools.json'), JSON.stringify({ defaultPool: 'work' }));
  const opened: string[] = [];
  const port = createClaudeAccountsPort({
    root,
    runStatus: vi.fn(async () => ({ loggedIn: true })),
    now: () => NOW,
    openInTerminal: vi.fn(async (p: string) => { opened.push(p); }),
  });
  return { root, port, opened };
}

describe('목록이 관문 표식을 싣는다', () => {
  it('유효한 표식만 attention 으로 — 지난 표식·없는 표식은 싣지 않는다', async () => {
    const h = await setup();
    await writeFile(join(h.root, 'work', 'aria', CLAUDE_ATTENTION_FILE), JSON.stringify({ kind: 'gate', atMs: NOW - 1_000 }));
    await writeFile(join(h.root, 'work', 'cedar', CLAUDE_ATTENTION_FILE),
      JSON.stringify({ kind: 'gate', atMs: NOW - CLAUDE_ATTENTION_TTL_MS - 1 }));
    const accounts = (await h.port.list()).pools[0]!.accounts;
    expect(accounts.find((a) => a.name === 'aria')!.attention).toEqual({ atMs: NOW - 1_000 });
    expect(accounts.find((a) => a.name === 'cedar')!.attention).toBeUndefined();
  });
});

describe('openTerminal', () => {
  it('그 계정의 스크립트를 쓰고 연다 — 작업 폴더를 미리 신뢰하고, 계정 목록에 끼지 않는다', async () => {
    const h = await setup();
    await h.port.openTerminal('work', 'aria');
    expect(h.opened).toHaveLength(1);
    const script = await readFile(h.opened[0]!, 'utf8');
    const acct = join(h.root, 'work', 'aria');
    expect(script).toContain(`export CLAUDE_CONFIG_DIR='${acct}'`);
    expect(script).toContain(`rm -f '${join(acct, CLAUDE_ATTENTION_FILE)}'`);
    expect((await stat(h.opened[0]!)).mode & 0o777).toBe(0o700);
    // 폴더 신뢰 화면이 먼저 떠서 진짜 관문을 가리지 않게.
    const doc = JSON.parse(await readFile(join(acct, '.claude.json'), 'utf8'));
    expect(doc.projects[join(h.root, '.terminal')]).toEqual({ hasTrustDialogAccepted: true });
    // 뿌리의 `.terminal` 은 풀도 계정도 아니다.
    expect((await h.port.list()).pools.map((p) => p.name)).toEqual(['work']);
  });

  it('없는 계정·문법 밖 이름은 거절한다 — 창을 띄우지 않는다', async () => {
    const h = await setup();
    await expect(h.port.openTerminal('work', 'ghost')).rejects.toThrow(/없다/);
    await expect(h.port.openTerminal('work', '..')).rejects.toThrow();
    expect(h.opened).toEqual([]);
  });
});

describe('terminalScript', () => {
  it('경로의 작은따옴표를 셸에서 깨지지 않게 인용한다', () => {
    const s = terminalScript({ configDir: "/tmp/it's", workDir: '/w', label: 'work/aria' });
    expect(s).toContain(`export CLAUDE_CONFIG_DIR='/tmp/it'\\''s'`);
    expect(s.split('\n')[0]).toBe('#!/bin/zsh -l');
  });
});
