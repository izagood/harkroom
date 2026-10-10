import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOperatorMergeCheckPayload, readOperatorMergeSetPayload } from '@harkroom/shared/daemonProtocol';
import { createLocalMergePort, parseGhAccounts, pickMergeGhUser, reachFromGh, REACH_TTL_MS } from '../src/localMerge.js';
import type { Exec } from '../src/turnMerge.js';

const STATUS = JSON.stringify({ hosts: {
  'github.com': [
    { state: 'success', active: true, host: 'github.com', login: 'work-account', tokenSource: 'keyring' },
    { state: 'success', active: false, host: 'github.com', login: 'izagood', tokenSource: 'keyring' },
  ],
  'ghe.example.com': [{ state: 'success', active: true, host: 'ghe.example.com', login: 'other' }],
} });

async function fresh(initial?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'local-merge-'));
  const configPath = join(dir, 'operator', 'operator.json');
  if (initial !== undefined) { await mkdir(join(dir, 'operator'), { recursive: true }); await writeFile(configPath, JSON.stringify(initial)); }
  const calls: { file: string; args: string[]; env: Record<string, string> }[] = [];
  let reply = { code: 0, stdout: STATUS, stderr: '' };
  const exec: Exec = async (file, args, env) => { calls.push({ file, args, env }); return reply; };
  const port = createLocalMergePort({ configPath, ghPath: '/opt/gh', home: '/home/me', exec, host: 'mac-1' });
  return { configPath, calls, port, setReply: (r: typeof reply) => { reply = r; } };
}

describe('localMerge 포트 (P2 · security C7·C8)', () => {
  it('처음에는 비어 있다 — 활성 계정을 고르지 않는다. 목록은 github.com 의 이름·활성 여부뿐이고 기기 이름을 함께 준다', async () => {
    const { port, calls } = await fresh();
    expect(await port.get()).toEqual({
      ghUser: null, byScope: null, host: 'mac-1',
      accounts: [{ login: 'work-account', active: true }, { login: 'izagood', active: false }],
    });
    // C7: 인자 배열로, 토큰을 보이는 플래그 없이, 상속 env(GH_TOKEN) 없이
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('/opt/gh');
    expect(calls[0]!.args).toEqual(['auth', 'status', '--json', 'hosts']);
    expect(calls[0]!.args).not.toContain('--show-token');
    expect(calls[0]!.env.GH_TOKEN).toBeUndefined();
  });

  it('목록에 있는 이름을 고르면 operator.json merge.ghUser 에 쓰고 다른 칸은 그대로 둔다', async () => {
    const { port, configPath } = await fresh({ communities: { 'https://a.example.com': { agents: { x: {} } } } });
    const out = await port.set({ ghUser: 'izagood' });
    expect(out.changes).toEqual([{ scope: null, from: null, to: 'izagood' }]);
    expect(out.state.ghUser).toBe('izagood');
    const disk = JSON.parse(await readFile(configPath, 'utf8'));
    expect(disk.merge).toEqual({ ghUser: 'izagood' });
    expect(disk.communities['https://a.example.com'].agents).toEqual({ x: {} });
    expect((await port.get()).ghUser).toBe('izagood');
  });

  it('C7: 그 순간 gh 에 로그인되지 않은 이름은 받지 않는다 — 파일도 그대로다', async () => {
    const { port, configPath } = await fresh({ communities: {}, merge: { ghUser: 'izagood' } });
    await expect(port.set({ ghUser: 'someone-else' })).rejects.toThrow(/not logged in/);
    // 다른 호스트의 계정도 못 고른다 — 래퍼의 `gh auth token -u` 는 github.com 을 본다
    await expect(port.set({ ghUser: 'other' })).rejects.toThrow(/not logged in/);
    expect(JSON.parse(await readFile(configPath, 'utf8')).merge).toEqual({ ghUser: 'izagood' });
  });

  it('gh 가 답하지 못하면 목록은 null + 까닭이고, 고르기는 거절한다. 지우기(null)는 gh 없이도 된다', async () => {
    const { port, setReply, configPath } = await fresh({ communities: {}, merge: { ghUser: 'izagood' } });
    setReply({ code: 127, stdout: '', stderr: 'no such file' });
    const s = await port.get();
    expect(s.accounts).toBeNull();
    expect(s.accountsError).toContain('no such file');
    await expect(port.set({ ghUser: 'izagood' })).rejects.toThrow(/gh auth status failed/);
    const out = await port.set({ ghUser: null });
    expect(out.changes).toEqual([{ scope: null, from: 'izagood', to: null }]);
    expect(out.state.ghUser).toBeNull();
    expect(JSON.parse(await readFile(configPath, 'utf8')).merge).toBeUndefined();
  });

  it('줄별 계정(e085b6a7): 줄 하나를 고르면 byScope 에 쓰고, 그 뒤로 옛 기본값은 쓰이지 않는다 — 로그인되지 않은 이름은 거절', async () => {
    const { port, configPath } = await fresh({ communities: {}, merge: { ghUser: 'izagood' } });
    await expect(port.set({ scope: 'acme-org/*', ghUser: 'nobody' })).rejects.toThrow(/not logged in/);
    const out = await port.set({ scope: 'acme-org/*', ghUser: 'work-account' });
    expect(out.changes).toEqual([{ scope: 'acme-org/*', from: null, to: 'work-account' }]);
    expect(out.state.byScope).toEqual({ 'acme-org/*': 'work-account' });
    expect(JSON.parse(await readFile(configPath, 'utf8')).merge).toEqual({ ghUser: 'izagood', byScope: { 'acme-org/*': 'work-account' } });
    // byScope 가 생긴 뒤로는 옛 기본값으로 떨어지지 않는다
    const merge = JSON.parse(await readFile(configPath, 'utf8')).merge;
    expect(pickMergeGhUser(merge, 'izagood/harkroom')).toBeNull();
    // 줄 지우기는 gh 없이도 된다
    await port.set({ scope: 'acme-org/*', ghUser: null });
    expect((await port.get()).byScope).toEqual({});
  });

  it('migrate: 옛 기본값을 지금 줄들에 한 번만 복사하고 지운다 — 두 번째는 아무것도 안 한다', async () => {
    const { port, configPath } = await fresh({ communities: {}, merge: { ghUser: 'izagood' } });
    const out = await port.set({ migrate: ['izagood/*', 'acme-org/*'] });
    expect(out.state.byScope).toEqual({ 'izagood/*': 'izagood', 'acme-org/*': 'izagood' });
    expect(out.state.ghUser).toBeNull();
    expect(JSON.parse(await readFile(configPath, 'utf8')).merge).toEqual({ byScope: { 'izagood/*': 'izagood', 'acme-org/*': 'izagood' } });
    await port.set({ scope: 'acme-org/*', ghUser: 'work-account' });
    const again = await port.set({ migrate: ['izagood/*', 'acme-org/*', 'new/*'] });
    expect(again.changes).toEqual([]);
    expect(again.state.byScope).toEqual({ 'izagood/*': 'izagood', 'acme-org/*': 'work-account' });
  });

  it('migrate: 옛 값이 없어도 옮긴 것으로 적는다(빈 byScope) — 그 뒤 줄 없는 머지는 no_gh_user', async () => {
    const { port } = await fresh({ communities: {} });
    expect((await port.set({ migrate: ['izagood/*'] })).state.byScope).toEqual({});
  });

  it('pickMergeGhUser: 정확한 줄 > 조직 줄, 대소문자 무시, 모양이 아닌 항목은 버린다, 옮기기 전에만 옛 기본값', () => {
    const byScope = { 'acme/*': 'org', 'acme/api': 'repo', 'bad key': 'x', 'other/*': 'a b' };
    expect(pickMergeGhUser({ byScope }, 'Acme/API')).toEqual({ login: 'repo', scope: 'acme/api' });
    expect(pickMergeGhUser({ byScope }, 'acme/web')).toEqual({ login: 'org', scope: 'acme/*' });
    expect(pickMergeGhUser({ byScope }, 'other/x')).toBeNull();
    expect(pickMergeGhUser({ ghUser: 'legacy', byScope }, 'zzz/x')).toBeNull();
    expect(pickMergeGhUser({ ghUser: 'legacy' }, 'zzz/x')).toEqual({ login: 'legacy', scope: '(device default)' });
    expect(pickMergeGhUser(undefined, 'zzz/x')).toBeNull();
  });

  it('로그인 하나가 만료돼 gh 가 0 이 아닌 코드로 끝나도 JSON 이 있으면 목록을 쓴다', async () => {
    const { port, setReply } = await fresh();
    setReply({ code: 1, stdout: STATUS, stderr: 'token invalid for x' });
    expect((await port.get()).accounts?.map((a) => a.login)).toEqual(['work-account', 'izagood']);
  });

  it('parseGhAccounts: 모양이 아닌 이름·중복은 버리고, github.com 이 없으면 빈 목록', () => {
    expect(parseGhAccounts('nope')).toBeNull();
    expect(parseGhAccounts(JSON.stringify({ hosts: {} }))).toEqual([]);
    expect(parseGhAccounts(JSON.stringify({ hosts: { 'github.com': [{ login: 'a b' }, { login: 'ok', active: true }, { login: 'ok' }] } })))
      .toEqual([{ login: 'ok', active: true }]);
  });

  it('readOperatorMergeSetPayload: 로그인 모양이거나 null 만', () => {
    expect(readOperatorMergeSetPayload({ ghUser: 'izagood' })).toEqual({ ghUser: 'izagood' });
    expect(readOperatorMergeSetPayload({ ghUser: null })).toEqual({ ghUser: null });
    expect(readOperatorMergeSetPayload({})).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMergeSetPayload({ ghUser: 'a; rm -rf /' })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMergeSetPayload({ ghUser: '' })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMergeSetPayload({ scope: 'Acme/*', ghUser: 'x' })).toEqual({ scope: 'acme/*', ghUser: 'x' });
    expect(readOperatorMergeSetPayload({ scope: 'acme/api', ghUser: null })).toEqual({ scope: 'acme/api', ghUser: null });
    expect(readOperatorMergeSetPayload({ scope: '*', ghUser: 'x' })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMergeSetPayload({ scope: 'a/b/c', ghUser: 'x' })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMergeSetPayload({ migrate: ['acme/*', 'ACME/*', 'acme/api'] })).toEqual({ migrate: ['acme/*', 'acme/api'] });
    expect(readOperatorMergeSetPayload({ migrate: ['../x'] })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMergeSetPayload({ migrate: 'acme/*' })).toMatchObject({ code: 'bad-payload' });
  });
});

describe('닿음 확인 (시안 상태 A·B·E)', () => {
  const ok = (stdout: unknown) => ({ code: 0, stdout: JSON.stringify(stdout), stderr: '' });
  const fail = (stderr: string) => ({ code: 1, stdout: '', stderr });

  it('reachFromGh: 저장소는 쓰기 권한, 조직은 active 회원, 404 는 no, 403·깨진 답은 unknown', () => {
    expect(reachFromGh('acme/api', 'x', ok({ permissions: { pull: true, push: true } }))).toBe('ok');
    expect(reachFromGh('acme/api', 'x', ok({ permissions: { pull: true, maintain: true } }))).toBe('ok');
    expect(reachFromGh('acme/api', 'x', ok({ permissions: { pull: true, push: false } }))).toBe('no');
    expect(reachFromGh('acme/api', 'x', fail('gh: Not Found (HTTP 404)'))).toBe('no');
    expect(reachFromGh('acme/*', 'x', ok({ state: 'active' }))).toBe('ok');
    expect(reachFromGh('acme/*', 'x', ok({ state: 'pending' }))).toBe('no');
    expect(reachFromGh('acme/*', 'x', fail('gh: Not Found (HTTP 404)'))).toBe('no');
    expect(reachFromGh('acme/*', 'x', fail('gh: Resource not accessible by integration (HTTP 403)'))).toBe('unknown');
    expect(reachFromGh('acme/api', 'x', ok('nope'))).toBe('unknown');
    // 자기 계정의 owner/* 는 묻지 않아도 닿는다
    expect(reachFromGh('izagood/*', 'izagood', fail('anything'))).toBe('ok');
  });

  it('범위 × 로그인 계정마다 그 계정 토큰으로만 잰다 — 토큰은 답에 없고, 10분 안에는 다시 묻지 않는다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'local-merge-'));
    const calls: { args: string[]; env: Record<string, string> }[] = [];
    let t = 1_000_000;
    const exec: Exec = async (_file, args, env) => {
      calls.push({ args, env });
      if (args[0] === 'auth' && args[1] === 'status') return { code: 0, stdout: STATUS, stderr: '' };
      if (args[0] === 'auth' && args[1] === 'token') return { code: 0, stdout: `tok-${args[3]}\n`, stderr: '' };
      // work-account 는 acme 회원, izagood 는 아니다
      if (env.GH_TOKEN === 'tok-work-account' && args[1] === 'user/memberships/orgs/acme') return { code: 0, stdout: JSON.stringify({ state: 'active' }), stderr: '' };
      return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
    };
    const port = createLocalMergePort({ configPath: join(dir, 'operator.json'), ghPath: '/opt/gh', home: '/home/me', exec, host: 'mac-1', now: () => t });
    const r = await port.check(['acme/*', 'izagood/*']);
    expect(r.reach['acme/*']!['work-account']!.status).toBe('ok');
    expect(r.reach['acme/*']!.izagood!.status).toBe('no');
    expect(r.reach['izagood/*']!.izagood!.status).toBe('ok');
    expect(r.reach['izagood/*']!['work-account']!.status).toBe('no');
    expect(JSON.stringify(r)).not.toContain('tok-');
    const api = calls.filter((c) => c.args[0] === 'api');
    expect(api.map((c) => c.args)).toContainEqual(['api', 'user/memberships/orgs/acme']);
    // izagood/* 를 izagood 로는 묻지 않는다(자기 계정)
    expect(api).toHaveLength(3);
    for (const c of api) expect(c.env.GH_TOKEN).toMatch(/^tok-/);

    const n = calls.length;
    t += REACH_TTL_MS - 1;
    await port.check(['acme/*']);
    expect(calls.filter((c) => c.args[0] === 'api').length).toBe(3);
    t += 2;
    await port.check(['acme/*']);
    expect(calls.length).toBeGreaterThan(n + 1);
    expect(calls.filter((c) => c.args[0] === 'api').length).toBe(5);
  });

  it('토큰을 못 꺼내면 unknown, gh 목록이 없으면 빈 답', async () => {
    const { port, setReply } = await fresh();
    setReply({ code: 1, stdout: 'not json', stderr: 'boom' });
    expect(await port.check(['acme/api'])).toEqual({ reach: {} });
  });

  it('readOperatorMergeCheckPayload: 범위 문자열 배열만', () => {
    expect(readOperatorMergeCheckPayload({ scopes: ['Acme/*', 'acme/*', 'acme/api'] })).toEqual({ scopes: ['acme/*', 'acme/api'] });
    expect(readOperatorMergeCheckPayload({ scopes: ['../etc'] })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMergeCheckPayload({ scopes: 'acme/*' })).toMatchObject({ code: 'bad-payload' });
    expect(readOperatorMergeCheckPayload({})).toMatchObject({ code: 'bad-payload' });
  });
});
