import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  communityRootHash,
  computedCommunityRoot,
  resolveCommunityRoot,
  SOCKET_PATH_LIMIT_BYTES,
  type OperatorRootsIndex,
} from '@harkroom/shared/operatorRoots';
import { daemonEndpointPaths } from '@harkroom/shared/daemonEndpoint';
import { MAX_SOCKET_PATH_BYTES } from '../src/cli.js';
import { communityKey } from '../src/config.js';
import { appDataDirFromSocket } from '../src/run.js';
import {
  operatorDataRoot,
  perCommunityEnabled,
  readRootsIndex,
  recordCommunityRoot,
  rootsIndexPath,
} from '../src/communityRoots.js';

const HOME = '/Users/alice';
const A = 'https://a.example.com';
const B = 'https://b.example.com';
const index = (communities: OperatorRootsIndex['communities'] = {}): OperatorRootsIndex => ({ version: 1, communities });

describe('뿌리 규칙(shared/operatorRoots)', () => {
  it('뿌리는 ~/.harkroom-agent/c/<baseUrl 해시 8자> 이고 끝 슬래시는 같은 커뮤니티다', () => {
    expect(communityRootHash(A)).toMatch(/^[0-9a-f]{8}$/);
    expect(communityRootHash(`${A}/`)).toBe(communityRootHash(A));
    expect(computedCommunityRoot(HOME, A)).toBe(join(HOME, '.harkroom-agent', 'c', communityRootHash(A)));
    expect(communityRootHash(A)).not.toBe(communityRootHash(B));
  });

  it('키 규칙이 오퍼레이터 설정(communityKey)과 같다', () => {
    for (const u of [A, `${A}/`, `${A}//`, 'http://localhost:3400/']) {
      expect(communityRootHash(u)).toBe(communityRootHash(communityKey(u)));
    }
  });

  it('소켓 경로는 지금과 같은 조립(daemonEndpointPaths)이고 두 단계 위로 뿌리가 되짚인다', () => {
    const r = resolveCommunityRoot(HOME, A, index());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.socketPath).toBe(daemonEndpointPaths(r.root).socketPath);
    expect(appDataDirFromSocket(r.socketPath)).toBe(r.root);
    expect(r.fromIndex).toBe(false);
  });

  it('색인에 있으면(옛 자리 D5 포함) 계산하지 않고 그 뿌리를 쓴다', () => {
    const legacy = '/Users/alice/Library/Application Support/app.harkroom.desktop';
    const r = resolveCommunityRoot(HOME, `${A}/`, index({ [A]: { root: legacy, legacy: true } }));
    expect(r).toMatchObject({ ok: true, root: legacy, fromIndex: true });
  });

  it('계산한 뿌리를 다른 커뮤니티가 쓰고 있으면 거절한다 — 한 뿌리에 두 커뮤니티를 섞지 않는다', () => {
    const taken = computedCommunityRoot(HOME, B);
    const r = resolveCommunityRoot(HOME, B, index({ [A]: { root: taken } }));
    expect(r).toMatchObject({ ok: false, reason: 'root_taken', takenBy: A });
  });

  it('소켓 경로가 상한을 넘으면 거절한다', () => {
    const longHome = `/Users/${'x'.repeat(80)}`;
    const r = resolveCommunityRoot(longHome, A, index());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('socket_path_too_long');
  });

  it('상한은 한 곳에서 온다(cli 의 MAX_SOCKET_PATH_BYTES 와 같다)', () => {
    expect(MAX_SOCKET_PATH_BYTES).toBe(SOCKET_PATH_LIMIT_BYTES);
  });
});

describe('스위치 HARKROOM_OPERATOR_PER_COMMUNITY', () => {
  it('정확히 1 일 때만 켜진다', () => {
    expect(perCommunityEnabled({})).toBe(false);
    for (const v of ['', '0', 'true', 'yes', ' 1']) expect(perCommunityEnabled({ HARKROOM_OPERATOR_PER_COMMUNITY: v })).toBe(false);
    expect(perCommunityEnabled({ HARKROOM_OPERATOR_PER_COMMUNITY: '1' })).toBe(true);
  });
});

describe('색인 파일(operators.json)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'hk-roots-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('꺼져 있으면 받은 앱 데이터 디렉터리를 그대로 쓰고 색인을 읽지도 만들지도 않는다 — 지금 동작 그대로', async () => {
    await writeFile(rootsIndexPath(dir), 'not json');
    expect(await operatorDataRoot({}, dir, HOME, A)).toEqual({ mode: 'single', root: dir });
    expect(await readFile(rootsIndexPath(dir), 'utf8')).toBe('not json');
  });

  it('켜져 있으면 색인을 보고 뿌리를 정한다', async () => {
    const out = await operatorDataRoot({ HARKROOM_OPERATOR_PER_COMMUNITY: '1' }, dir, HOME, A);
    expect(out).toMatchObject({ mode: 'per-community', resolution: { ok: true, root: computedCommunityRoot(HOME, A) } });
  });

  it('파일이 없으면 빈 색인이다', async () => {
    expect(await readRootsIndex(dir)).toEqual({ version: 1, communities: {} });
  });

  it('칸을 넣어도 다른 커뮤니티 칸은 남고, 파일은 0600 이다', async () => {
    await recordCommunityRoot(dir, A, { root: '/r/a', operatorId: 'op-a' });
    await recordCommunityRoot(dir, `${B}/`, { root: '/r/b' });
    expect(await readRootsIndex(dir)).toEqual({ version: 1, communities: { [A]: { root: '/r/a', operatorId: 'op-a' }, [B]: { root: '/r/b' } } });
    expect((await stat(rootsIndexPath(dir))).mode & 0o777).toBe(0o600);
  });

  it('모양이 틀리면 빈 색인으로 치지 않고 던진다 — 옛 자리를 잊고 새 뿌리를 만들지 않게', async () => {
    await writeFile(rootsIndexPath(dir), JSON.stringify({ version: 2, communities: {} }));
    await expect(readRootsIndex(dir)).rejects.toThrow();
    await writeFile(rootsIndexPath(dir), JSON.stringify({ version: 1, communities: { [A]: { root: 'relative/path' } } }));
    await expect(readRootsIndex(dir)).rejects.toThrow();
    await writeFile(rootsIndexPath(dir), '{');
    await expect(readRootsIndex(dir)).rejects.toThrow();
  });
});
