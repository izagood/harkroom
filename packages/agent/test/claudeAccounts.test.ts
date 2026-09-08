import { mkdtempSync } from 'node:fs';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { claudeAccountsRoot, loadClaudeAccountLane, loadClaudeAccounts } from '../src/claudeAccounts.js';

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
    const root = await fixture(['cedar', 'aria', 'personal']);
    const accounts = await loadClaudeAccounts({ root });
    expect(accounts.map((a) => a.name)).toEqual(['aria', 'cedar', 'personal']);
    expect(accounts[0]!.configDir).toBe(join(root, 'aria'));
  });

  it('뿌리가 없으면 빈 배열이다 — 오류가 아니다', async () => {
    // 풀을 안 만든 사람이 압도적으로 많다. 그 경우가 정상 경로여야 기존 동작이 유지된다.
    expect(await loadClaudeAccounts({ root: '/nonexistent/murmur/pool' })).toEqual([]);
  });

  it('디렉터리가 아닌 것은 계정이 아니다', async () => {
    const root = await fixture(['aria']);
    await writeFile(join(root, 'README.md'), 'not an account');
    expect((await loadClaudeAccounts({ root })).map((a) => a.name)).toEqual(['aria']);
  });

  it('이름 문법에 안 맞는 디렉터리는 건너뛴다', async () => {
    // 사람이 `.DS_Store` 나 `Lime Backup` 같은 것을 만들어 둘 수 있다. 그것을 계정으로
    // 세면 러너가 없는 로그인을 가리키고, 그 실패는 계정 축을 한 칸 헛돌게 만든다.
    const root = await fixture(['aria', 'Lime Backup', '.hidden']);
    expect((await loadClaudeAccounts({ root })).map((a) => a.name)).toEqual(['aria']);
  });

  // 실물 검증(Task 8)에서 드러났다: `Dirent.isDirectory()` 는 **심볼릭 링크에 대해 거짓**
  // 이다(실측: isDirectory=false, isSymbolicLink=true). 디렉터리를 가리키는 링크를 계정으로
  // 쓰는 것은 정당한 구성이다 — 이미 로그인된 config 디렉터리를 이름 붙여 풀에 넣는 흔한
  // 방법이고, `codexHome.ts` 도 auth.json 을 링크로 재사용한다.
  it('디렉터리를 가리키는 심볼릭 링크도 계정이다', async () => {
    const root = await fixture(['cedar']);
    const real = mkdtempSync(join(tmpdir(), 'murmur-real-account-'));
    await symlink(real, join(root, 'aria'));
    expect((await loadClaudeAccounts({ root })).map((a) => a.name)).toEqual(['aria', 'cedar']);
  });

  it('끊어진 심볼릭 링크는 계정이 아니다', async () => {
    // 가리키는 곳이 없으면 claude 가 그 경로에 새 설정을 만들어 미로그인으로 뜬다 —
    // 계정 축이 한 칸 헛돈다. 링크가 살아 있는지까지 봐야 한다.
    const root = await fixture(['cedar']);
    await symlink(join(tmpdir(), 'murmur-no-such-target-xyz'), join(root, 'aria'));
    expect((await loadClaudeAccounts({ root })).map((a) => a.name)).toEqual(['cedar']);
  });

  it('파일을 가리키는 심볼릭 링크는 계정이 아니다', async () => {
    const root = await fixture(['cedar']);
    const file = join(mkdtempSync(join(tmpdir(), 'murmur-file-')), 'f.txt');
    await writeFile(file, 'x');
    await symlink(file, join(root, 'aria'));
    expect((await loadClaudeAccounts({ root })).map((a) => a.name)).toEqual(['cedar']);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 가 순서와 부분집합을 정한다', async () => {
    const root = await fixture(['aria', 'personal', 'cedar']);
    const accounts = await loadClaudeAccounts({ root, order: 'cedar,aria' });
    expect(accounts.map((a) => a.name)).toEqual(['cedar', 'aria']);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 의 공백을 무시한다', async () => {
    const root = await fixture(['aria', 'cedar']);
    expect((await loadClaudeAccounts({ root, order: ' cedar , aria ' })).map((a) => a.name))
      .toEqual(['cedar', 'aria']);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 에 없는 계정이 오면 기동을 실패시킨다', async () => {
    // 조용히 무시하면 운영자가 계정 B 라고 믿고 띄운 러너가 A 로 돈다 —
    // config.ts::validateInstance 와 같은 판단이다.
    const root = await fixture(['aria']);
    await expect(loadClaudeAccounts({ root, order: 'aria,ghost' }))
      .rejects.toThrow(/ghost/);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 가 빈 문자열이면 지정이 없는 것으로 본다', async () => {
    const root = await fixture(['aria', 'cedar']);
    expect((await loadClaudeAccounts({ root, order: '' })).map((a) => a.name))
      .toEqual(['aria', 'cedar']);
  });
});

/** 두 층 구조를 만든다. `cfg` 를 주면 `pools.json` 도 쓴다(그 존재가 풀 모드의 스위치다). */
async function poolFixture(
  pools: Record<string, string[]>,
  cfg?: unknown,
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'murmur-pools-'));
  for (const [pool, accounts] of Object.entries(pools)) {
    await mkdir(join(root, pool), { recursive: true });
    for (const a of accounts) await mkdir(join(root, pool, a), { recursive: true });
  }
  if (cfg !== undefined) await writeFile(join(root, 'pools.json'), JSON.stringify(cfg));
  return root;
}

describe('loadClaudeAccountLane — 풀 축', () => {
  it('pools.json 이 없으면 뿌리가 암묵 풀이다 — 어제 동작 그대로', async () => {
    // 하위 호환이 이 한 줄에 걸려 있다. 술어는 파일의 존재 하나다.
    const root = await fixture(['aria', 'cedar']);
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1' });
    expect(lane.pool).toBe(null);
    expect(lane.accounts.map((a) => a.name)).toEqual(['aria', 'cedar']);
    expect(lane.accounts[0]!.configDir).toBe(join(root, 'aria'));
  });

  it('pools.json 이 있으면 하위 디렉터리가 풀이다', async () => {
    const root = await poolFixture({ work: ['aria'], personal: ['gmail'] }, { defaultPool: 'work' });
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1' });
    expect(lane.pool).toBe('work');
    expect(lane.accounts.map((a) => a.name)).toEqual(['aria']);
    expect(lane.accounts[0]!.configDir).toBe(join(root, 'work', 'aria'));
  });

  it('에이전트 배정이 기본 풀을 덮는다', async () => {
    const root = await poolFixture(
      { work: ['aria'], personal: ['gmail'] },
      { defaultPool: 'work', agents: { a1: 'personal' } },
    );
    expect((await loadClaudeAccountLane({ root, agentId: 'a1' })).pool).toBe('personal');
    expect((await loadClaudeAccountLane({ root, agentId: 'a2' })).pool).toBe('work');
  });

  it('MURMUR_CLAUDE_POOL 이 가장 세다', async () => {
    const root = await poolFixture(
      { work: ['aria'], personal: ['gmail'] },
      { defaultPool: 'work', agents: { a1: 'work' } },
    );
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1', forcedPool: 'personal' });
    expect(lane.pool).toBe('personal');
    expect(lane.accounts.map((a) => a.name)).toEqual(['gmail']);
  });

  it('MURMUR_CLAUDE_POOL 이 없는 풀을 가리키면 던진다 — 사람이 타이핑한 의도다', async () => {
    const root = await poolFixture({ work: ['aria'] }, { defaultPool: 'work' });
    await expect(loadClaudeAccountLane({ root, agentId: 'a1', forcedPool: 'ghost' }))
      .rejects.toThrow(/ghost/);
  });

  it('pools.json 이 없는 풀을 가리키면 경고하고 무시한다 — 던지지 않는다', async () => {
    // UI 가 쓴 뒤 사람이 디렉터리를 지울 수 있다. 던지면 러너가 안 뜨고 사용자는
    // 앱에서 고칠 수 없다. 다음 단계로 떨어진다.
    const root = await poolFixture({ work: ['aria'] }, { defaultPool: 'work', agents: { a1: 'gone' } });
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1' });
    expect(lane.pool).toBe('work'); // 배정을 무시하고 기본 풀로 떨어졌다
  });

  it('기본 풀도 없으면 계정 지정 없음이다', async () => {
    const root = await poolFixture({ work: ['aria'] }, { agents: { a1: 'gone' } });
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1' });
    expect(lane.pool).toBe(null);
    expect(lane.accounts).toEqual([]);
  });

  it('풀 안 순서를 pools.json 이 정한다', async () => {
    const root = await poolFixture(
      { work: ['aria', 'cedar', 'zebra'] },
      { defaultPool: 'work', order: { work: ['cedar', 'aria'] } },
    );
    expect((await loadClaudeAccountLane({ root, agentId: 'a1' })).accounts.map((a) => a.name))
      .toEqual(['cedar', 'aria', 'zebra']);
  });

  it('MURMUR_CLAUDE_ACCOUNTS 가 풀 안 순서를 덮는다', async () => {
    const root = await poolFixture(
      { work: ['aria', 'cedar'] },
      { defaultPool: 'work', order: { work: ['aria', 'cedar'] } },
    );
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1', order: 'cedar' });
    expect(lane.accounts.map((a) => a.name)).toEqual(['cedar']);
  });

  it('빈 풀은 계정 0개다 — 오류가 아니다', async () => {
    const root = await poolFixture({ work: [] }, { defaultPool: 'work' });
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1' });
    expect(lane.pool).toBe('work');
    expect(lane.accounts).toEqual([]);
  });

  it('깨진 pools.json 은 없는 것이 아니라 빈 설정이다', async () => {
    // **파일의 존재가 풀 모드의 스위치**이므로, 깨진 파일을 "없음"으로 읽으면 풀 모드였던
    // 러너가 조용히 암묵 풀로 되돌아가 **계정을 풀로 읽는다.**
    const root = mkdtempSync(join(tmpdir(), 'murmur-pools-broken-'));
    await mkdir(join(root, 'aria'), { recursive: true });
    await writeFile(join(root, 'pools.json'), '{ not json');
    const lane = await loadClaudeAccountLane({ root, agentId: 'a1' });
    // `aria` 은 풀로 읽히고 그 안에 계정이 없다 — 암묵 풀로 되돌아가지 않았다.
    expect(lane.pool).toBe(null);
    expect(lane.accounts).toEqual([]);
  });
});
