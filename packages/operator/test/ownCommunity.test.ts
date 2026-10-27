// 격리 C — 커뮤니티마다 모드의 오퍼레이터는 자기 커뮤니티 칸만 띄운다(security #1649 M1).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ownsCommunity } from '../src/communityRoots.js';
import { startCommunities } from '../src/communities.js';
import type { OperatorSecrets } from '../src/secrets.js';

const A = 'https://a.example.com';
const B = 'https://b.example.com';
const ON = { HARKROOM_OPERATOR_PER_COMMUNITY: '1', HARKROOM_OPERATOR_COMMUNITY: A };

describe('ownsCommunity', () => {
  it('꺼져 있으면 모든 칸을 띄운다(지금 그대로)', () => {
    expect(ownsCommunity(A, {})).toBe(true);
    expect(ownsCommunity(B, {})).toBe(true);
  });
  it('켜져 있으면 맡은 커뮤니티만(끝 슬래시는 같은 커뮤니티)', () => {
    expect(ownsCommunity(A, ON)).toBe(true);
    expect(ownsCommunity(`${A}/`, ON)).toBe(true);
    expect(ownsCommunity(B, ON)).toBe(false);
  });
  it('켜져 있는데 맡은 커뮤니티를 모르면 아무것도 띄우지 않는다', () => {
    expect(ownsCommunity(A, { HARKROOM_OPERATOR_PER_COMMUNITY: '1' })).toBe(false);
  });
});

describe('startCommunities — 옛 설정에 칸이 둘이어도', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

  async function run(env: NodeJS.ProcessEnv) {
    const dir = await mkdtemp(join(tmpdir(), 'hk-own-'));
    dirs.push(dir);
    await mkdir(join(dir, 'operator'), { recursive: true });
    await writeFile(join(dir, 'operator', 'operator.json'), JSON.stringify({ communities: { [A]: { agents: {} }, [B]: { agents: {} } } }));
    const asked: string[] = [];
    const logs: string[] = [];
    // 토큰은 늘 없다 — 실제로 붙지는 않고 「어느 칸의 토큰을 찾았나」만 본다.
    const secrets: OperatorSecrets = {
      getToken: async (u) => { asked.push(u); return null; },
      setToken: async () => undefined,
      clearToken: async () => undefined,
    };
    const rt = await startCommunities({
      appDataDir: dir, env, secrets, appVersion: null, log: (l: string) => logs.push(l),
      registry: {} as never, host: {} as never, runnerLink: {} as never,
    } as never);
    // 등록 뒤 붙이기 길(startOne)도 같은 규칙을 따른다.
    await rt.startOne(B);
    return { asked, logs };
  }

  it('켜져 있으면 맡은 커뮤니티(A)의 토큰만 찾고, B 는 등록 길로도 띄우지 않는다', async () => {
    const { asked, logs } = await run(ON);
    expect(asked).toEqual([A]);
    expect(logs.filter((l) => l.includes('맡은 커뮤니티가 아니다'))).toHaveLength(2);
  });

  it('꺼져 있으면 지금처럼 두 칸 다 찾는다', async () => {
    const { asked } = await run({});
    expect(asked.sort()).toEqual([A, B, B].sort());
  });
});
