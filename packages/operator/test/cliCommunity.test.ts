// 격리 C P5 — 앱 없는 기계의 CLI 가 커뮤니티마다 뿌리를 앱과 같은 규칙으로 찾고(`resolveCommunityRoot`), `run --all` 이
// 커뮤니티마다 자식 하나를 감독한다. CLI 는 색인을 읽기만 한다(writer 는 앱).
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computedCommunityRoot } from '@harkroom/shared/operatorRoots';
import {
  applyCommunityEnv,
  assertPerCommunitySwitch,
  communityProcessEnv,
  communityRunTarget,
  listCommunityTargets,
  superviseCommunities,
  type CommunityRunTarget,
} from '../src/cliCommunity.js';
import { writeRootsIndex } from '../src/communityRoots.js';

const A = 'https://a.example.com';
const B = 'https://b.example.com';

async function tmp(): Promise<{ app: string; home: string }> {
  // 소켓 경로 상한(100바이트) 안에 들게 짧은 자리에 둔다 — macOS 의 tmpdir() 은 그것만으로 50바이트가 넘는다.
  const d = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'p5-'));
  return { app: join(d, 'app'), home: join(d, 'h') };
}

async function seedRoot(root: string, keys: string[]): Promise<void> {
  await mkdir(join(root, 'operator'), { recursive: true });
  const communities = Object.fromEntries(keys.map((k) => [k, { agents: {} }]));
  await writeFile(join(root, 'operator', 'operator.json'), JSON.stringify({ communities }));
}

describe('communityRunTarget — url 로 뿌리를 정한다', () => {
  it('색인이 없으면 해시 뿌리, 색인에 옛 자리(legacy)가 있으면 그 자리와 legacy', async () => {
    const { app, home } = await tmp();
    expect(await communityRunTarget(app, home, `${A}/`)).toEqual({ key: A, root: computedCommunityRoot(home, A), legacy: false });
    await writeRootsIndex(app, { version: 1, communities: { [A]: { root: app, legacy: true } } });
    expect(await communityRunTarget(app, home, A)).toEqual({ key: A, root: app, legacy: true });
  });
  it('소켓 경로가 상한을 넘으면 사유와 함께 던진다', async () => {
    const { app } = await tmp();
    await expect(communityRunTarget(app, `/${'x'.repeat(80)}`, A)).rejects.toThrow(/소켓 경로가 너무 길다/);
  });
});

describe('env — 앱의 community_env 와 같은 넷', () => {
  it('legacy 가 아니면 LEGACY 를 지운다(물려받은 값이 새지 않게)', () => {
    const t: CommunityRunTarget = { key: A, root: '/r', legacy: false };
    expect(communityProcessEnv(t)).toEqual({
      HARKROOM_OPERATOR_PER_COMMUNITY: '1', HARKROOM_OPERATOR_ROOT: '/r', HARKROOM_OPERATOR_COMMUNITY: A, HARKROOM_OPERATOR_LEGACY: undefined,
    });
    const env: NodeJS.ProcessEnv = { HARKROOM_OPERATOR_LEGACY: '1', HARKROOM_OPERATOR_COMMUNITY: B };
    applyCommunityEnv(env, t);
    expect(env).toEqual({ HARKROOM_OPERATOR_PER_COMMUNITY: '1', HARKROOM_OPERATOR_ROOT: '/r', HARKROOM_OPERATOR_COMMUNITY: A });
    applyCommunityEnv(env, { ...t, legacy: true });
    expect(env.HARKROOM_OPERATOR_LEGACY).toBe('1');
  });
  it('스위치가 꺼져 있으면 --community·--all 을 받지 않는다', () => {
    expect(() => assertPerCommunitySwitch({}, 'run --all')).toThrow(/HARKROOM_OPERATOR_PER_COMMUNITY=1/);
    expect(() => assertPerCommunitySwitch({ HARKROOM_OPERATOR_PER_COMMUNITY: 'true' }, 'run --all')).toThrow();
    expect(() => assertPerCommunitySwitch({ HARKROOM_OPERATOR_PER_COMMUNITY: '1' }, 'run --all')).not.toThrow();
  });
});

describe('listCommunityTargets — 색인 칸 ∪ ~/.harkroom-agent/c/* 의 커뮤니티', () => {
  it('색인의 옛 자리와 해시 뿌리에서 찾은 커뮤니티를 합친다', async () => {
    const { app, home } = await tmp();
    await writeRootsIndex(app, { version: 1, communities: { [A]: { root: app, legacy: true } } });
    await seedRoot(computedCommunityRoot(home, B), [B]);
    const out = await listCommunityTargets(app, home);
    expect(out.targets).toEqual([
      { key: A, root: app, legacy: true },
      { key: B, root: computedCommunityRoot(home, B), legacy: false },
    ]);
    expect(out.skipped).toEqual([]);
  });
  it('뿌리 자리에서 찾은 커뮤니티가 지금 규칙으로 다른 뿌리로 풀리면 띄우지 않는다 — 한 커뮤니티를 두 자리에서 띄우지 않는다', async () => {
    const { app, home } = await tmp();
    const stray = join(home, '.harkroom-agent', 'c', 'deadbeef');
    await seedRoot(stray, [A]);
    const out = await listCommunityTargets(app, home);
    expect(out.targets).toEqual([]);
    expect(out.skipped).toEqual([{ root: stray, reason: expect.stringContaining('띄우지 않는다') }]);
  });
  it('커뮤니티가 둘 든 뿌리는 건너뛰고, c/ 가 없으면 빈 목록', async () => {
    const { app, home } = await tmp();
    expect(await listCommunityTargets(app, home)).toEqual({ targets: [], skipped: [] });
    await seedRoot(computedCommunityRoot(home, A), [A, B]);
    const out = await listCommunityTargets(app, home);
    expect(out.targets).toEqual([]);
    expect(out.skipped[0]?.reason).toMatch(/둘 이상/);
  });
});

class FakeChild extends EventEmitter {
  signals: string[] = [];
  kill(signal?: NodeJS.Signals): boolean { this.signals.push(signal ?? 'SIGTERM'); return true; }
  die(code: number | null, signal: NodeJS.Signals | null = null): void { this.emit('exit', code, signal); }
}

describe('superviseCommunities — run --all', () => {
  function harness() {
    let t = 0;
    const timers: { fn: () => void; ms: number }[] = [];
    const children: Record<string, FakeChild[]> = {};
    const sup = (targets: CommunityRunTarget[]) => superviseCommunities(targets, {
      spawn: (target) => { const c = new FakeChild(); (children[target.key] ??= []).push(c); return c; },
      log: () => {},
      now: () => t,
      setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; },
      clearTimer: (h) => { timers.splice(timers.indexOf(h as never), 1); },
    });
    return { sup, children, timers, advance: (ms: number) => { t += ms; } };
  }
  const targets: CommunityRunTarget[] = [{ key: A, root: '/a', legacy: false }, { key: B, root: '/b', legacy: false }];

  it('커뮤니티마다 자식 하나, 죽은 것만 1초·2초·4초 백오프로 다시 띄우고, 1분 넘게 살았으면 처음부터 센다', () => {
    const h = harness();
    h.sup(targets);
    expect(Object.keys(h.children)).toEqual([A, B]);
    h.children[A]![0]!.die(1);
    expect(h.timers.map((x) => x.ms)).toEqual([1000]);
    h.timers.shift()!.fn();
    expect(h.children[A]).toHaveLength(2);
    h.children[A]![1]!.die(1);
    expect(h.timers.map((x) => x.ms)).toEqual([2000]);
    h.timers.shift()!.fn();
    h.children[A]![2]!.die(1);
    expect(h.timers.map((x) => x.ms)).toEqual([4000]);
    h.timers.shift()!.fn();
    h.advance(60_000);
    h.children[A]![3]!.die(1);
    expect(h.timers.map((x) => x.ms)).toEqual([1000]);
    expect(h.children[B]).toHaveLength(1);
  });

  it('stop 은 기다리던 재기동을 거두고 살아 있는 자식 모두에 신호를 넘기며, 다 끝나야 풀린다', async () => {
    const h = harness();
    const s = h.sup(targets);
    h.children[A]![0]!.die(1);
    let done = false;
    const p = s.stop('SIGTERM').then(() => { done = true; });
    expect(h.timers).toEqual([]);
    expect(h.children[B]![0]!.signals).toEqual(['SIGTERM']);
    await Promise.resolve();
    expect(done).toBe(false);
    h.children[B]![0]!.die(0, 'SIGTERM');
    await p;
    expect(done).toBe(true);
    expect(h.children[A]).toHaveLength(1);
  });
});
