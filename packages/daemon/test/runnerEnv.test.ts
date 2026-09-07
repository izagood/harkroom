/**
 * 러너에게 넘기는 **환경 그 자체**의 회귀선 — 2026-09-07 16:05~16:41 실측.
 *
 * ## 무슨 일이 있었나
 *
 * forge 가 멘션마다 즉시 실패했다. 러너 로그의 사유는
 * `Failed to authenticate: OAuth session expired and could not be refreshed` 였고,
 * 사람은 claude 에 다시 로그인했는데도 똑같이 실패했다. 자격증명은 멀쩡했다 —
 * `~/.claude/.credentials.json` 의 토큰은 그날 23:55 까지, refresh 는 9/28 까지 살아 있었고
 * 같은 기계의 같은 바이너리를 일반 셸에서 부르면 그대로 성공했다.
 *
 * 이분 탐색으로 좁힌 차이는 **환경변수 `USER` 하나**였다.
 *
 * ```
 * env -i HOME=$HOME PATH=/usr/bin:/bin claude -p 'say ok'
 *   → Failed to authenticate: OAuth session expired and could not be refreshed
 * env -i HOME=$HOME PATH=/usr/bin:/bin USER=jaebin claude -p 'say ok'
 *   → ok
 * ```
 *
 * ## 왜 러너에는 그것이 없었나
 *
 * 앱이 `{ MURMUR_PAT, MURMUR_URL, PATH }` 세 개를 만들어 daemon 에 넘기고
 * (`desktop/src/lib/runnerLauncher.ts::spawnRunner`), daemon 이 그것을 그대로
 * `spawn(cmd, args, { env })` 에 넘겼다. **Node 의 `spawn` 은 `env` 를 주면 환경을 합치지
 * 않고 통째로 대체한다.** 그래서 러너는 세 변수만 가진 환경에서 돌았고, `USER`·`HOME`·
 * `LANG` 은 daemon 자신은 갖고 있는데도 자식에서 사라졌다.
 *
 * 그리고 하네스는 러너의 환경을 상속한다(`agent/src/turn.ts::childEnv` — "화이트리스트가
 * 아니라 전체 상속인 이유: 하네스가 정확히 무엇을 읽는지 우리가 모른다"). 그 약속이
 * **속 빈 약속**이었다: 부모가 세 개뿐이면 전부 물려줘도 세 개다.
 *
 * ## 이 파일이 지키는 것
 *
 * daemon 이 가진 사용자 환경을 자식에게 물려주고, 요청이 준 세 값은 그 위에 덮는다.
 * 가짜 host 로 재는 이유: 여기서 재는 것은 프로세스 성질이 아니라 **env 조립 규칙**이고,
 * 그것은 실제 spawn 없이도 관측할 수 있다(`runners.test.ts` 는 반대로 실물이 필요한
 * 성질만 실물로 잰다).
 */
import { describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';

import { RunnerRegistry, type RunnerHost } from '../src/runners.js';

const SLEEPER = { command: '/bin/sh', args: ['-c', 'sleep 30'] };

/** spawn 에 실제로 넘어간 env 를 잡아 두는 host. 자식은 만들지 않는다. */
function 엿보는host(): { host: RunnerHost; envs: Record<string, string>[] } {
  const envs: Record<string, string>[] = [];
  const host: RunnerHost = {
    spawn(_command: string, _args: readonly string[], env: Record<string, string>) {
      envs.push(env);
      // `RunnerRegistry` 가 기대하는 최소 표면만 흉내낸다 — pid 와 이벤트 등록.
      const fake = {
        pid: 4242,
        on() { return fake; },
        once() { return fake; },
        unref() { /* noop */ },
        kill() { return true; },
        stdout: null,
        stderr: null,
      };
      return fake as unknown as ChildProcess;
    },
    kill() { return true; },
    now() { return 0; },
    // `RunnerRegistry` 가 기동 직후 부르는 표면. 이 파일이 재는 것은 env 조립이므로
    // 값 자체는 아무것이나 좋다 — 다만 없으면 registry 가 터진다.
    async bootTimeSec() { return 0; },
  } as unknown as RunnerHost;
  return { host, envs };
}

describe('러너 환경 — daemon 의 사용자 환경을 물려준다', () => {
  /**
   * **되돌려 RED**: `runners.ts` 의 병합(`{ ...userEnv(), ...env }`)을 빼고 `env` 를 그대로
   * 넘기면 `USER` 가 사라져 이 단언이 빨개진다. 그것이 2026-09-07 의 forge 실패다.
   */
  it('USER 를 물려준다 — 없으면 claude CLI 가 자격증명을 만료로 보고한다(실측)', async () => {
    const { host, envs } = 엿보는host();
    const registry = new RunnerRegistry(SLEEPER, host);

    await registry.spawnRunner('a1', { MURMUR_PAT: 'p', MURMUR_URL: 'u', PATH: '/usr/bin' });

    expect(envs).toHaveLength(1);
    expect(envs[0]!.USER).toBe(process.env.USER);
    expect(envs[0]!.HOME).toBe(process.env.HOME);
  });

  it('요청이 준 값은 물려받은 값을 덮는다 — PAT·URL·PATH 는 앱이 정한다', async () => {
    const { host, envs } = 엿보는host();
    const registry = new RunnerRegistry(SLEEPER, host);

    await registry.spawnRunner('a1', { MURMUR_PAT: 'p', MURMUR_URL: 'u', PATH: '/앱이/정한/경로' });

    expect(envs[0]!.PATH).toBe('/앱이/정한/경로');
    expect(envs[0]!.MURMUR_PAT).toBe('p');
    expect(envs[0]!.MURMUR_URL).toBe('u');
  });

  it('물려주는 것은 전체다 — 화이트리스트를 두면 다음 하네스가 읽는 것을 또 빠뜨린다', async () => {
    const { host, envs } = 엿보는host();
    const registry = new RunnerRegistry(SLEEPER, host);
    process.env.MURMUR_TEST_CANARY = '카나리아';
    try {
      await registry.spawnRunner('a1', { PATH: '/usr/bin' });
      expect(envs[0]!.MURMUR_TEST_CANARY).toBe('카나리아');
    } finally {
      delete process.env.MURMUR_TEST_CANARY;
    }
  });
});
