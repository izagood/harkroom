import { describe, expect, it } from 'vitest';
import { RUNNER_LINK_ENV, RUNNER_TURN_KEY_ENV } from '@harkroom/shared/runnerLink';
import { auxQueryEnv } from '../src/queryEnv.js';
import { opencodeQueryEnv } from '../src/mentionTurn.js';

/** 러너 프로세스 env 를 흉내 — 실행에 필요한 칸과 열쇠·토큰이 섞여 있다. */
const PARENT: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/u',
  LANG: 'ko_KR.UTF-8',
  LC_ALL: 'C.UTF-8',
  TMPDIR: '/tmp/x',
  XDG_CACHE_HOME: '/home/u/.cache',
  [RUNNER_LINK_ENV.socketPath]: '/s/op.sock',
  [RUNNER_LINK_ENV.runnerId]: 'runner-1',
  [RUNNER_LINK_ENV.secret]: 'LINK-SECRET',
  [RUNNER_TURN_KEY_ENV.bridge]: 'TURN-KEY',
  HARKROOM_OPERATOR_VERSION: '9.9.9',
  GH_TOKEN: 'gh-token',
  ANTHROPIC_API_KEY: 'sk-x',
};

const 열쇠값 = ['LINK-SECRET', 'TURN-KEY', 'gh-token', 'sk-x'];

describe('보조 조회 env 는 허용 목록이다', () => {
  for (const harness of ['opencode', 'kilo'] as const) {
    it(`${harness} 세션 조회 — 실행 칸·XDG·스위치만 있고 열쇠·HARKROOM_* 는 없다`, () => {
      const dirs = { XDG_CONFIG_HOME: '/r/config', XDG_DATA_HOME: '/r/data', XDG_STATE_HOME: '/r/state' };
      const env = opencodeQueryEnv(harness, dirs, PARENT);
      expect(env.HOME).toBe('/home/u');
      expect(env.LANG).toBe('ko_KR.UTF-8');
      expect(env.LC_ALL).toBe('C.UTF-8');
      expect(env.TMPDIR).toBe('/tmp/x');
      expect(env.XDG_CACHE_HOME).toBe('/home/u/.cache');
      expect(env.XDG_CONFIG_HOME).toBe('/r/config');
      expect(env.PATH?.startsWith('/usr/bin:/bin')).toBe(true);
      expect(env[harness === 'kilo' ? 'KILO_DISABLE_PROJECT_CONFIG' : 'OPENCODE_DISABLE_PROJECT_CONFIG']).toBe('1');
      expect(Object.keys(env).filter((k) => k.startsWith('HARKROOM_'))).toEqual([]);
      for (const v of 열쇠값) expect(Object.values(env)).not.toContain(v);
    });
  }

  it('허용 목록 밖 이름은 무엇이든 빠진다', () => {
    const env = auxQueryEnv('opencode', { PATH: '/bin', SOME_TOKEN: 't', NODE_OPTIONS: '--require x' });
    expect(env.SOME_TOKEN).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
  });

});

