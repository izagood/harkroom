// claude 계정 풀 해석의 골든 — L3c-3a, Rust 전환(`crates/harkroom-accounts`).
//
// 정본은 TS `loadClaudeAccountLane`·`claudeAccountUse` 다. 아래 표본마다 임시 폴더에 디스크 모양을 **실제로 만들고**
// 그 TS 함수를 **실행해서** 나온 값을 골든(`crates/harkroom-accounts/golden/lane.json`)에 담는다 — 사람이 손으로 쓴
// 기대값은 없다. 이 시험은 지금 실행한 결과가 골든과 한 칸이라도 다르면 빨강이고, Rust 쪽 `cargo test` 가 같은 파일의
// 입력으로 같은 모양을 만들어 Rust 판을 돌린 결과가 골든과 같은지 본다.
//
// 해석을 바꿨다면 `UPDATE_ACCOUNTS_GOLDEN=1 npx vitest run test/claudeAccountLaneGolden.test.ts` 로 다시 쓰고
// Rust 판을 같이 고친다. 경로는 임시 폴더를 `<tmp>` 로 바꿔 담는다.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { claudeAccountUse, loadClaudeAccountLane } from '../src/claudeAccountLane.js';

const GOLDEN = join(import.meta.dirname, '..', '..', '..', 'crates', 'harkroom-accounts', 'golden', 'lane.json');

const AID = '00000000-aaaa-4bbb-8ccc-000000000001';
const OTHER = '00000000-aaaa-4bbb-8ccc-000000000002';

/** 표본의 입력. 경로는 모두 임시 폴더(`<tmp>`) 기준이다. 계정 뿌리는 언제나 `<tmp>/accounts` 다. */
interface Case {
  name: string;
  /** 만들 디렉터리. */
  dirs?: string[];
  /** 만들 파일(경로 → 내용). */
  files?: Record<string, string>;
  /** 만들 심볼릭 링크(경로 → 가리킬 곳, 둘 다 `<tmp>` 기준). */
  links?: Record<string, string>;
  /** `HARKROOM_CLAUDE_ACCOUNTS`·`HARKROOM_OPERATOR_*` 등. 값의 `<tmp>` 는 임시 폴더로 바뀐다. */
  env?: Record<string, string>;
  agentId?: string;
  /** `HARKROOM_CLAUDE_POOL`(operator.json `claudePool`). */
  forcedPool?: string;
}

const pools = (v: unknown) => JSON.stringify(v);
const ACC = (pool: string | null, ...names: string[]) => names.map((n) => (pool ? `accounts/${pool}/${n}` : `accounts/${n}`));

const CASES: Case[] = [
  { name: 'no-root' },
  { name: 'empty-root', dirs: ['accounts'] },
  { name: 'root-is-file', files: { accounts: 'x' } },
  {
    name: 'implicit',
    dirs: [...ACC(null, 'b', 'a', 'Bad', 'a_b', 'x'.repeat(33)), 'accounts/.hidden'],
    files: { 'accounts/.DS_Store': '', 'accounts/file-x': '' },
  },
  { name: 'implicit-order', dirs: ACC(null, 'a', 'b', 'c'), env: { HARKROOM_CLAUDE_ACCOUNTS: ' c, a ,,a' } },
  { name: 'implicit-order-missing', dirs: ACC(null, 'a', 'b'), env: { HARKROOM_CLAUDE_ACCOUNTS: 'a,zz,yy' } },
  { name: 'implicit-order-missing-empty', dirs: ['accounts'], env: { HARKROOM_CLAUDE_ACCOUNTS: 'a' } },
  {
    name: 'implicit-links',
    dirs: [...ACC(null, 'a'), 'ext/acct'],
    files: { 'ext/file': '' },
    links: { 'accounts/linked': 'ext/acct', 'accounts/broken': 'ext/missing', 'accounts/tofile': 'ext/file' },
  },
  {
    name: 'forced',
    dirs: [...ACC('p1', 'a', 'b'), ...ACC('p2', 'c')],
    files: { 'accounts/pools.json': pools({ order: { p2: ['c'] }, agents: { [AID]: ['p1'] }, defaultPool: 'p1' }) },
    agentId: AID, forcedPool: 'p2',
  },
  {
    name: 'forced-missing',
    dirs: ACC('p1', 'a'),
    files: { 'accounts/pools.json': '{}' },
    agentId: AID, forcedPool: 'nope',
  },
  { name: 'forced-missing-no-pools', dirs: ['accounts'], files: { 'accounts/pools.json': '{}' }, agentId: AID, forcedPool: 'nope' },
  {
    name: 'forced-empty-string',
    dirs: ACC('p1', 'a'),
    files: { 'accounts/pools.json': pools({ defaultPool: 'p1' }) },
    agentId: AID, forcedPool: '',
  },
  {
    name: 'forced-with-order',
    dirs: ACC('p1', 'a', 'b'),
    files: { 'accounts/pools.json': pools({ order: { p1: ['a', 'b'] } }) },
    env: { HARKROOM_CLAUDE_ACCOUNTS: 'b' },
    agentId: AID, forcedPool: 'p1',
  },
  {
    name: 'forced-with-order-missing',
    dirs: ACC('p1', 'a'),
    files: { 'accounts/pools.json': '{}' },
    env: { HARKROOM_CLAUDE_ACCOUNTS: 'zz' },
    agentId: AID, forcedPool: 'p1',
  },
  {
    name: 'assigned-chain',
    dirs: [...ACC('p1', 'a', 'b', 'c'), ...ACC('p2', 'd')],
    files: { 'accounts/pools.json': pools({ order: { p1: ['b', 'ghost', 'a'] }, agents: { [AID]: ['p2', 'gone', 'p1'] }, defaultPool: 'p1' }) },
    agentId: AID,
  },
  {
    name: 'assigned-first-empty',
    dirs: ['accounts/p0', ...ACC('p1', 'a')],
    files: { 'accounts/pools.json': pools({ agents: { [AID]: ['p0', 'p1'] } }) },
    agentId: AID,
  },
  {
    name: 'assigned-all-empty',
    dirs: ['accounts/p0', 'accounts/p3'],
    files: { 'accounts/pools.json': pools({ agents: { [AID]: ['p0', 'p3'] }, defaultPool: 'p1' }) },
    agentId: AID,
  },
  {
    name: 'assigned-all-missing-falls-to-default',
    dirs: ACC('p1', 'a'),
    files: { 'accounts/pools.json': pools({ agents: { [AID]: ['gone', 'gone2'] }, defaultPool: 'p1' }) },
    agentId: AID,
  },
  {
    name: 'assigned-legacy-string',
    dirs: ACC('p1', 'a'),
    files: { 'accounts/pools.json': pools({ agents: { [AID]: 'p1' } }) },
    agentId: AID,
  },
  {
    name: 'assigned-bad-names-and-dupes',
    dirs: [...ACC('p1', 'a'), ...ACC('p2', 'b')],
    files: { 'accounts/pools.json': pools({ agents: { [AID]: ['P1', '../x', 'p2', 7, 'p2', 'p1'] } }) },
    agentId: AID,
  },
  {
    name: 'assigned-truncated-at-16',
    dirs: [...ACC('p1', 'a'), ...ACC('p2', 'b')],
    files: {
      'accounts/pools.json': pools({
        agents: { [AID]: ['p1', 'p1', ...Array.from({ length: 15 }, (_, i) => `x${i}`), 'p2'] },
      }),
    },
    agentId: AID,
  },
  {
    name: 'other-agent-assigned-uses-default',
    dirs: [...ACC('p1', 'a'), ...ACC('p2', 'b')],
    files: { 'accounts/pools.json': pools({ agents: { [OTHER]: ['p2'] }, defaultPool: 'p1' }) },
    agentId: AID,
  },
  {
    name: 'default-order',
    dirs: ACC('p1', 'd', 'a', 'c', 'b'),
    files: { 'accounts/pools.json': pools({ order: { p1: ['c', 'ghost', 'a', 'Bad', 'c'] }, defaultPool: 'p1' }) },
    agentId: AID,
  },
  {
    name: 'default-missing',
    dirs: ACC('p1', 'a'),
    files: { 'accounts/pools.json': pools({ defaultPool: 'gone' }) },
    agentId: AID,
  },
  {
    name: 'default-bad-name',
    dirs: ACC('p1', 'a'),
    files: { 'accounts/pools.json': pools({ defaultPool: '../p1' }) },
    agentId: AID,
  },
  { name: 'default-empty-pool', dirs: ['accounts/p3'], files: { 'accounts/pools.json': pools({ defaultPool: 'p3' }) }, agentId: AID },
  { name: 'pools-no-default', dirs: ACC('p1', 'a'), files: { 'accounts/pools.json': '{}' }, agentId: AID },
  { name: 'pools-broken', dirs: ACC('p1', 'a'), files: { 'accounts/pools.json': '{not json' }, agentId: AID },
  { name: 'pools-array', dirs: ACC('p1', 'a'), files: { 'accounts/pools.json': '[1,2]' }, agentId: AID },
  { name: 'pools-null', dirs: ACC('p1', 'a'), files: { 'accounts/pools.json': 'null' }, agentId: AID },
  { name: 'pools-is-dir', dirs: [...ACC('p1', 'a'), 'accounts/pools.json'], agentId: AID },
  {
    name: 'pool-links',
    dirs: ['ext/pool/a', 'ext/acct', ...ACC('p1', 'b')],
    files: { 'accounts/pools.json': pools({ defaultPool: 'linked' }) },
    links: { 'accounts/linked': 'ext/pool', 'accounts/p1/c': 'ext/acct', 'accounts/p1/dead': 'ext/none' },
    agentId: AID,
  },
  {
    name: 'per-community',
    dirs: ACC('p1', 'a'),
    files: { 'community/claude-pools.json': pools({ defaultPool: 'p1' }) },
    env: { HARKROOM_OPERATOR_PER_COMMUNITY: '1', HARKROOM_OPERATOR_ROOT: '<tmp>/community/../community' },
    agentId: AID,
  },
  {
    name: 'per-community-ignores-root-pools',
    dirs: ACC('p1', 'a'),
    files: { 'accounts/pools.json': pools({ defaultPool: 'p1' }) },
    env: { HARKROOM_OPERATOR_PER_COMMUNITY: '1', HARKROOM_OPERATOR_ROOT: '<tmp>/community' },
    agentId: AID,
  },
  {
    name: 'per-community-relative-root',
    dirs: ACC('p1', 'a'),
    files: { 'accounts/pools.json': pools({ defaultPool: 'p1' }) },
    env: { HARKROOM_OPERATOR_PER_COMMUNITY: '1', HARKROOM_OPERATOR_ROOT: 'rel/community' },
    agentId: AID,
  },
  {
    name: 'per-community-switch-not-1',
    dirs: ACC('p1', 'a'),
    files: { 'accounts/pools.json': pools({ defaultPool: 'p1' }), 'community/claude-pools.json': '{}' },
    env: { HARKROOM_OPERATOR_PER_COMMUNITY: 'true', HARKROOM_OPERATOR_ROOT: '<tmp>/community' },
    agentId: AID,
  },
];

const ENV_KEYS = ['HARKROOM_CLAUDE_ACCOUNTS', 'HARKROOM_OPERATOR_PER_COMMUNITY', 'HARKROOM_OPERATOR_ROOT'] as const;

async function run(c: Case): Promise<unknown> {
  const tmp = await mkdtemp(join(tmpdir(), 'hk-lane-'));
  const sub = (s: string) => s.split('<tmp>').join(tmp);
  try {
    for (const d of c.dirs ?? []) await mkdir(join(tmp, d), { recursive: true });
    for (const [p, text] of Object.entries(c.files ?? {})) {
      await mkdir(dirname(join(tmp, p)), { recursive: true });
      await writeFile(join(tmp, p), text);
    }
    for (const [p, target] of Object.entries(c.links ?? {})) {
      await mkdir(dirname(join(tmp, p)), { recursive: true });
      await symlink(join(tmp, target), join(tmp, p));
    }
    const root = join(tmp, 'accounts');
    const env: NodeJS.ProcessEnv = { HARKROOM_CLAUDE_ACCOUNTS_DIR: root };
    for (const [k, v] of Object.entries(c.env ?? {})) env[k] = sub(v);
    // `loadClaudeAccountLane` 은 `pools.json` 자리를 process.env 로 잰다 — 같은 env 를 그 자리에도 둔다.
    for (const k of ENV_KEYS) vi.stubEnv(k, env[k] ?? '');
    for (const k of ENV_KEYS) if (env[k] === undefined) delete process.env[k];

    const agentId = c.agentId ?? AID;
    let lane: unknown;
    try {
      lane = await loadClaudeAccountLane({ root, agentId, forcedPool: c.forcedPool, order: env.HARKROOM_CLAUDE_ACCOUNTS });
    } catch (err) {
      lane = { error: (err as Error).message };
    }
    const use = await claudeAccountUse({ agentId, forcedPool: c.forcedPool, env });
    return JSON.parse(JSON.stringify({ lane, use }).split(tmp).join('<tmp>'));
  } finally {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  }
}

describe('claude 계정 풀 해석 골든(Rust harkroom-accounts 와 같은 답)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('TS 를 실행한 결과가 골든과 같다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cases = [];
    for (const c of CASES) cases.push({ ...c, expected: await run(c) });
    const doc = { cases };

    if (process.env.UPDATE_ACCOUNTS_GOLDEN === '1') {
      mkdirSync(dirname(GOLDEN), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(doc, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(GOLDEN, 'utf8'))).toEqual(doc);
  });

  it('표본이 갈래를 고루 지난다(빠지면 골든이 그 갈래를 못 지킨다)', async () => {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { cases: { expected: { lane: Record<string, unknown>; use: string } }[] };
    const uses = new Set(golden.cases.map((c) => c.expected.use));
    expect([...uses].sort()).toEqual(['none', 'pool', 'unreadable']);
    expect(golden.cases.some((c) => 'error' in c.expected.lane)).toBe(true);
    expect(golden.cases.some((c) => 'chain' in c.expected.lane)).toBe(true);
    expect(golden.cases.some((c) => c.expected.lane.pool === null && (c.expected.lane.accounts as unknown[])?.length)).toBe(true);
  });
});
