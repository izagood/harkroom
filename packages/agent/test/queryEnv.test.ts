import { describe, expect, it } from 'vitest';
import { RUNNER_LINK_ENV, RUNNER_TURN_KEY_ENV } from '@harkroom/shared/runnerLink';
import { auxQueryEnv, piMcpListEnv } from '../src/queryEnv.js';
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

  it('pi 도구 목록 — 다리가 붙을 링크 세 칸만 짚어 넘기고 턴 열쇠·그 밖의 HARKROOM_*·토큰은 없다', () => {
    const env = piMcpListEnv('pi', PARENT, '/r/pi');
    expect(env.PI_CODING_AGENT_DIR).toBe('/r/pi');
    expect(env[RUNNER_LINK_ENV.socketPath]).toBe('/s/op.sock');
    expect(env[RUNNER_LINK_ENV.runnerId]).toBe('runner-1');
    expect(env[RUNNER_LINK_ENV.secret]).toBe('LINK-SECRET');
    expect(env[RUNNER_TURN_KEY_ENV.bridge]).toBeUndefined();
    expect(env.HARKROOM_OPERATOR_VERSION).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

it('pi 도구 목록 조회는 piMcpListEnv 를 탄다(부모 env 펼치기 없음)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/mentionTurn.ts', import.meta.url), 'utf8');
  const call = src.slice(src.indexOf('await listPiMcpTools({'));
  expect(call.slice(0, call.indexOf('});'))).toContain('env: piMcpListEnv(');
});
