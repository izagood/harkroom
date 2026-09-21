/**
 * 러너 관측기 회귀선 — 스펙 2026-09-20 §2 책임표.
 *
 * 앞 판본의 이 파일은 실행기(`startAll`·`reissue`·`restart`)를 손으로 세워 **띄우는
 * 판정**을 쟀다. 그 판정은 오퍼레이터로 갔다(`packages/operator/src/assignments.ts`).
 * 앱에 남은 것은 **관측**뿐이다: 이 머신의 오퍼레이터 장부를 읽어 화면에 흘린다.
 * 그래서 여기서 재는 것도 관측 하나다 — 장부가 말한 것이 상태와 관측 두 통로로 나뉘어
 * 스토어에 닿는가, 장부를 못 읽으면 지어내지 않는가.
 */
import { describe, it, expect } from 'vitest';
import { RunnerLauncher, type AppVersionReader, type RunnerState } from '../src/lib/runnerLauncher';
import { fakeDaemon, liveRunner } from './helpers/fakeDaemon';

const version: AppVersionReader = { read: async () => '1.2.3' };

describe('RunnerLauncher — 관측만 한다', () => {
  it('장부의 살아 있는 러너를 adopted 로 판정한다 — 앱이 띄운 것이 아니므로', async () => {
    const daemon = fakeDaemon([liveRunner('a-1'), { agentId: 'a-2', alive: false, adopted: true }]);
    const launcher = new RunnerLauncher(daemon, version);
    let states: RunnerState[] = [];
    launcher.setOnStateChange((s) => { states = s; });
    await launcher.ensureOperator();
    expect(states).toEqual([{ agentId: 'a-1', status: 'adopted', exitCode: null, message: null }]);
  });

  it('관측 결과를 관측 구독자에게 통째로 흘린다 — 죽은 러너도 사실이다', async () => {
    const daemon = fakeDaemon([liveRunner('a-1'), { agentId: 'a-2', alive: false, adopted: true, pid: 9 }]);
    const launcher = new RunnerLauncher(daemon, version);
    let seen: unknown = null;
    launcher.setOnObservation((r) => { seen = r; });
    await launcher.ensureOperator();
    expect(seen).toEqual(daemon.runners);
  });

  it('장부를 못 읽으면 null 을 돌려주고 구독자에게 아무것도 보내지 않는다', async () => {
    const daemon = fakeDaemon([liveRunner('a-1')]);
    daemon.error = new Error('소켓 없음');
    const launcher = new RunnerLauncher(daemon, version);
    let calls = 0;
    launcher.setOnObservation(() => { calls += 1; });
    launcher.setOnStateChange(() => { calls += 1; });
    await expect(launcher.ensureOperator()).resolves.toBeNull();
    expect(calls).toBe(0);
  });

  it('앱 버전은 한 번만 읽는다', async () => {
    let reads = 0;
    const launcher = new RunnerLauncher(fakeDaemon(), { read: async () => { reads += 1; return ' 2.0.0 '; } });
    expect(await launcher.currentAppVersion()).toBe('2.0.0');
    expect(await launcher.currentAppVersion()).toBe('2.0.0');
    expect(reads).toBe(1);
  });
});
