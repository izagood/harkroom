import { mkdtempSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { claudeAccountsRoot, loadClaudeAccounts } from '../src/claudeAccounts.js';

async function fixture(names: string[]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'murmur-claude-accounts-'));
  for (const name of names) await mkdir(join(root, name), { recursive: true });
  return root;
}

describe('claudeAccountsRoot', () => {
  it('기본 뿌리는 러너 상태 디렉터리 밖의 공용 경로다', () => {
    // 계정은 에이전트·인스턴스·서버를 가로지르는 자산이다 — 러너 상태 디렉터리 안에
    // 두면 에이전트마다 다시 로그인해야 한다(codexHome 과 목적이 반대다).
    expect(claudeAccountsRoot({} as NodeJS.ProcessEnv)).toMatch(/\.murmur-agent\/claude-accounts$/);
  });

  it('MURMUR_CLAUDE_ACCOUNTS_DIR 로 뿌리를 옮길 수 있다', () => {
    expect(claudeAccountsRoot({ MURMUR_CLAUDE_ACCOUNTS_DIR: '/tmp/pool' } as NodeJS.ProcessEnv))
      .toBe('/tmp/pool');
  });
});

describe('loadClaudeAccounts', () => {
  it('하위 디렉터리를 사전순으로 돌려준다', async () => {
    // 순서가 예측 가능해야 로그를 읽고 다음 계정을 알 수 있다.
    const root = await fixture(['plum', 'lime', 'personal']);
    const accounts = await loadClaudeAccounts({ root });
    expect(accounts.map((a) => a.name)).toEqual(['lime', 'personal', 'plum']);
    expect(accounts[0]!.configDir).toBe(join(root, 'lime'));
  });

  it('뿌리가 없으면 빈 배열이다 — 오류가 아니다', async () => {
    // 풀을 안 만든 사람이 압도적으로 많다. 그 경우가 정상 경로여야 기존 동작이 유지된다.
    expect(await loadClaudeAccounts({ root: '/nonexistent/murmur/pool' })).toEqual([]);
  });

  it('디렉터리가 아닌 것은 계정이 아니다', async () => {
    const root = await fixture(['lime']);
    await writeFile(join(root, 'README.md'), 'not an account');
    expect((await loadClaudeAccounts({ root })).map((a) => a.name)).toEqual(['lime']);
  });

  it('이름 문법에 안 맞는 디렉터리는 건너뛴다', async () => {
    // 사람이 `.DS_Store` 나 `Lime Backup` 같은 것을 만들어 둘 수 있다. 그것을 계정으로
    // 세면 러너가 없는 로그인을 가리키고, 그 실패는 계정 축을 한 칸 헛돌게 만든다.
    const root = await fixture(['lime', 'Lime Backup', '.hidden']);
    expect((await loadClaudeAccounts({ root })).map((a) => a.name)).toEqual(['lime']);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 가 순서와 부분집합을 정한다', async () => {
    const root = await fixture(['lime', 'personal', 'plum']);
    const accounts = await loadClaudeAccounts({ root, order: 'plum,lime' });
    expect(accounts.map((a) => a.name)).toEqual(['plum', 'lime']);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 의 공백을 무시한다', async () => {
    const root = await fixture(['lime', 'plum']);
    expect((await loadClaudeAccounts({ root, order: ' plum , lime ' })).map((a) => a.name))
      .toEqual(['plum', 'lime']);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 에 없는 계정이 오면 기동을 실패시킨다', async () => {
    // 조용히 무시하면 운영자가 계정 B 라고 믿고 띄운 러너가 A 로 돈다 —
    // config.ts::validateInstance 와 같은 판단이다.
    const root = await fixture(['lime']);
    await expect(loadClaudeAccounts({ root, order: 'lime,ghost' }))
      .rejects.toThrow(/ghost/);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 가 빈 문자열이면 지정이 없는 것으로 본다', async () => {
    const root = await fixture(['lime', 'plum']);
    expect((await loadClaudeAccounts({ root, order: '' })).map((a) => a.name))
      .toEqual(['lime', 'plum']);
  });
});
