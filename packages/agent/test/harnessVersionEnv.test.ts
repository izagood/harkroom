import { describe, expect, it } from 'vitest';
import { harnessVersionEnv } from '../src/harnessVersionEnv.js';

describe('harnessVersionEnv', () => {
  it('codex: PATH·HOME·러너 CODEX_HOME 셋뿐 — 사람 ~/.codex/tmp 를 건드리지 않게', () => {
    const env = harnessVersionEnv({ path: '/bin', home: '/h', codexHome: '/s/codex-home', codex: true });
    expect(Object.keys(env!).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH']);
    expect(env!.CODEX_HOME).toBe('/s/codex-home');
  });
  it('codex 인데 러너 codex 홈을 모르면 묻지 않는다(null)', () => {
    expect(harnessVersionEnv({ path: '/bin', home: '/h', codex: true })).toBeNull();
  });
  it('codex 가 아닌 하네스엔 CODEX_HOME 을 싣지 않는다 · omp 는 러너 omp 홈 HOME', () => {
    expect(harnessVersionEnv({ path: '/bin', home: '/h', codexHome: '/c', codex: false })).toEqual({ PATH: '/bin', HOME: '/h' });
    expect(harnessVersionEnv({ path: '/bin', home: '/h', ompHome: '/o', codex: false })).toEqual({ PATH: '/bin', HOME: '/o' });
  });
  it('pi: 러너 pi 홈을 PI_CODING_AGENT_DIR 로 — 사람 ~/.pi/agent 를 건드리지 않게 · 모르면 묻지 않는다', () => {
    const env = harnessVersionEnv({ path: '/bin', home: '/h', codex: false, pi: true, piHome: '/s/pi-provider-lane' });
    expect(env).toEqual({ PATH: '/bin', HOME: '/h', PI_CODING_AGENT_DIR: '/s/pi-provider-lane' });
    expect(harnessVersionEnv({ path: '/bin', home: '/h', codex: false, pi: true })).toBeNull();
    // pi 가 아닌 하네스엔 싣지 않는다.
    expect(harnessVersionEnv({ path: '/bin', home: '/h', codex: false, pi: false, piHome: '/p' })).toEqual({ PATH: '/bin', HOME: '/h' });
  });
});
