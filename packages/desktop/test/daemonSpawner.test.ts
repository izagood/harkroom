/**
 * `daemonSpawner` 회귀선 — **앱이 daemon 을 통해 러너를 소유한다**(`#431` 2단계-b 3/3).
 *
 * 여기서 재는 것은 웹뷰 쪽 절반이다: invoke 표면 너머로 무엇을 보내고, 돌아온 이벤트를
 * 어떻게 거르는가. daemon 을 실제로 띄우는 것(프로세스 그룹·소켓·토큰)은 Rust 쪽이고
 * 그 성질은 `runnerShellScope.test.ts`(소스 읽기)와 `daemon_client.rs` 의 `mod tests`,
 * 그리고 실물 `.app` 검증이 잰다.
 *
 * ## 왜 목이 invoke 하나인가
 *
 * `daemonSpawner` 가 아는 표면이 그것 하나이기 때문이다 — 소켓도, 프로세스도, 경로도
 * 이 파일 아래에서는 보이지 않는다. **그것이 이 단계가 만든 성질이다**: 웹뷰는 값만
 * 넘기고 나머지는 Rust 가 정한다. 목이 더 필요해지는 날이 오면 그 자체가 경계가 무너진
 * 신호다.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  daemonSpawner, RUNNER_EXIT_EVENT,
  type DaemonRunnerExit,
} from '../src/lib/runnerLauncher';

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** 웹뷰가 보는 Tauri 표면 전부를 흉내낸다 — invoke 와 이벤트 콜백 등록 둘뿐이다. */
function fakeTauri() {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  /** `plugin:event|listen` 으로 등록된 콜백들. `emit()` 이 이것들을 부른다. */
  const listeners = new Map<number, (payload: unknown) => void>();
  let nextCallbackId = 1;
  let nextEventId = 100;

  const api = {
    calls,
    listeners,
    /** `daemon_spawn_runner` 가 돌려줄 값. 테스트가 갈아 끼운다. */
    spawnResult: { agentId: 'a', pid: 4242, incarnationId: 'inc-1' } as unknown,
    spawnError: null as Error | null,
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === 'daemon_spawn_runner') {
        if (api.spawnError) throw api.spawnError;
        return api.spawnResult;
      }
      if (cmd === 'plugin:event|listen') {
        const eventId = nextEventId++;
        // 등록된 콜백 id 를 그 이벤트 id 에 묶어 둔다.
        (api as unknown as Record<string, unknown>)[`event-${eventId}`] = args!.handler;
        return eventId;
      }
      if (cmd === 'plugin:event|unlisten') {
        listeners.delete(args!.eventId as number);
        return null;
      }
      return null;
    }) as Invoke,
    transformCallback: vi.fn((cb: (payload: unknown) => void) => {
      const id = nextCallbackId++;
      listeners.set(id, cb);
      return id;
    }),
    /** daemon 이 보낸 `runnerExit` 이 웹뷰에 닿았다고 흉내낸다. */
    emit(event: DaemonRunnerExit) {
      for (const cb of listeners.values()) cb({ payload: event });
    },
  };
  return api;
}

let tauri: ReturnType<typeof fakeTauri>;

beforeEach(() => {
  tauri = fakeTauri();
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: tauri.invoke,
    transformCallback: tauri.transformCallback,
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('daemonSpawner 는 daemon 에게 러너를 띄우라고 시킨다 (#431 2단계-b 3/3)', () => {
  it('`daemon_spawn_runner` 로 agentId 와 env 값만 넘긴다 — 경로도 프로그램도 넘기지 않는다', async () => {
    await daemonSpawner.spawn({
      agentId: 'agent-1',
      env: { MURMUR_PAT: 'pat-1', MURMUR_URL: 'http://x', PATH: '/usr/bin' },
      onExit: () => {},
    });

    const call = tauri.calls.find((c) => c.cmd === 'daemon_spawn_runner');
    expect(call).toBeDefined();
    // **인자 목록 자체를 단언한다.** "경로가 없다"를 `not.toHaveProperty` 로 재면 이름만
    // 바꾼 경로 인자가 통과한다 — 있는 것을 전부 적어야 새로 생긴 것이 걸린다.
    expect(Object.keys(call!.args!).sort()).toEqual([
      'agentId', 'murmurPat', 'murmurUrl', 'path',
    ]);
    // `path` 는 자식의 `PATH` 환경변수이지 실행 파일 경로가 아니다 — 값이지 실행 표면이 아니다.
    expect(call!.args!.path).toBe('/usr/bin');
  });

  /**
   * **회귀선 4 — `incarnationId` 가 다른 exit 이 엉뚱한 세대를 죽이지 않는다.**
   *
   * 소켓을 한 겹 거치면서 옛 러너의 exit 이 새 러너가 뜬 뒤에 도착하는 창이 넓어졌다.
   * `agentId` 만 보고 상태를 바꾸면 앱은 **살아 있는 새 러너를 죽은 것으로** 표시하고,
   * 그 표시를 믿고 또 하나를 띄운다 — 같은 에이전트에 러너가 둘이면 멘션을 나눠 집어 간다.
   *
   * 되돌려 RED: `daemonSpawner` 의
   * `if (event.incarnationId !== incarnationId) return;` 한 줄을 지우면 이 테스트가 빨개진다.
   */
  it('세대가 다른 exit 은 `onExit` 을 부르지 않는다', async () => {
    tauri.spawnResult = { agentId: 'agent-1', pid: 1, incarnationId: 'inc-NEW' };
    const onExit = vi.fn();
    await daemonSpawner.spawn({
      agentId: 'agent-1',
      env: { MURMUR_PAT: 'p', MURMUR_URL: 'u', PATH: '/bin' },
      onExit,
    });

    // 같은 에이전트지만 **옛 세대**의 종료 통지다.
    tauri.emit({ agentId: 'agent-1', incarnationId: 'inc-OLD', code: 1, signal: null });
    expect(onExit).not.toHaveBeenCalled();

    // 같은 세대면 그대로 통과한다 — 거르기만 하고 막지는 않는다.
    tauri.emit({ agentId: 'agent-1', incarnationId: 'inc-NEW', code: 78, signal: null });
    expect(onExit).toHaveBeenCalledWith(78);
  });

  it('다른 에이전트의 exit 도 부르지 않는다', async () => {
    tauri.spawnResult = { agentId: 'agent-1', pid: 1, incarnationId: 'inc-1' };
    const onExit = vi.fn();
    await daemonSpawner.spawn({
      agentId: 'agent-1', env: { MURMUR_PAT: 'p', MURMUR_URL: 'u', PATH: '/bin' }, onExit,
    });
    tauri.emit({ agentId: 'agent-2', incarnationId: 'inc-1', code: 0, signal: null });
    expect(onExit).not.toHaveBeenCalled();
  });

  it('exit 은 정확히 한 번만 통지된다 — 같은 이벤트가 두 번 와도', async () => {
    tauri.spawnResult = { agentId: 'agent-1', pid: 1, incarnationId: 'inc-1' };
    const onExit = vi.fn();
    await daemonSpawner.spawn({
      agentId: 'agent-1', env: { MURMUR_PAT: 'p', MURMUR_URL: 'u', PATH: '/bin' }, onExit,
    });
    const event: DaemonRunnerExit = {
      agentId: 'agent-1', incarnationId: 'inc-1', code: 0, signal: null,
    };
    tauri.emit(event);
    tauri.emit(event);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  /**
   * **회귀선 — kill 이 세대를 실어 보낸다.**
   *
   * 안 실으면 daemon 은 "지금 것"을 죽이고, 앱이 옛 세대를 죽이라고 보낸 명령이 그 사이
   * 새로 뜬 러너를 데려간다(`daemonProtocol.ts::KillRunnerParams.incarnationId` 주석).
   */
  it('`kill()` 이 세대를 함께 보낸다 — 옛 명령이 새 러너를 데려가지 않는다', async () => {
    tauri.spawnResult = { agentId: 'agent-1', pid: 1, incarnationId: 'inc-7' };
    const child = await daemonSpawner.spawn({
      agentId: 'agent-1', env: { MURMUR_PAT: 'p', MURMUR_URL: 'u', PATH: '/bin' },
      onExit: () => {},
    });
    await child.kill();

    const call = tauri.calls.find((c) => c.cmd === 'daemon_kill_runner');
    expect(call!.args).toEqual({ agentId: 'agent-1', incarnationId: 'inc-7' });
  });

  it('이벤트를 `murmur://runner-exit` 이름으로 듣는다 — Rust 와 같은 이름이어야 한다', async () => {
    await daemonSpawner.spawn({
      agentId: 'a', env: { MURMUR_PAT: 'p', MURMUR_URL: 'u', PATH: '/bin' }, onExit: () => {},
    });
    const listen = tauri.calls.find((c) => c.cmd === 'plugin:event|listen');
    expect(listen!.args!.event).toBe(RUNNER_EXIT_EVENT);
    // 리터럴로도 못박는다 — 상수만 비교하면 구현이 이름을 바꿔도 함께 움직여 초록이 된다.
    expect(RUNNER_EXIT_EVENT).toBe('murmur://runner-exit');
  });
});

describe('daemon 기동 실패는 조용히 넘어가지 않는다 (#431 · #368)', () => {
  /**
   * **회귀선 3 — daemon 기동 실패가 사유로 올라온다. 폴백하지 않는다.**
   *
   * `daemonSpawner` 가 실패를 삼키고 `{ kill }` 을 돌려주면 `RunnerLauncher` 는 그것을
   * `running` 으로 표시한다 — 러너가 하나도 없는데 화면은 "실행 중"이다. 그리고 옛 경로로
   * 물러나면 "daemon 이 도는 줄 알았는데 아니었다"가 된다.
   *
   * 되돌려 RED: `daemonSpawner.spawn` 의 invoke 를 `try/catch` 로 감싸 실패 시
   * `{ kill: async () => {} }` 를 돌려주게 하면 이 테스트가 빨개진다.
   */
  it('daemon 을 못 띄우면 그 사유 그대로 던진다 — 삼키지도, 다른 경로로 물러나지도 않는다', async () => {
    tauri.spawnError = new Error(
      'daemon 사이드카를 찾지 못했다: `/Applications/murmur.app/Contents/MacOS/murmur-daemon`',
    );
    await expect(daemonSpawner.spawn({
      agentId: 'a', env: { MURMUR_PAT: 'p', MURMUR_URL: 'u', PATH: '/bin' }, onExit: () => {},
    })).rejects.toThrow('daemon 사이드카를 찾지 못했다');

    // **옛 경로를 부르지 않았다** — 폴백이 없다는 것이 이 줄의 뜻이다.
    expect(tauri.calls.map((c) => c.cmd)).not.toContain('runner_spawn');
  });

  it('소켓 경로 길이 실패도 그대로 올라온다 — `EINVAL` 이 아니라 길이를 말한다', async () => {
    // Rust 쪽 `check_socket_path_length` 가 만드는 문장이다(`daemon_client.rs` 의
    // `소켓_경로가_상한을_넘으면_길이를_사유로_말한다` 가 그 형태를 잰다). 웹뷰는 그것을
    // 지어내지 않고 **그대로** 사람에게 올린다(`#368`).
    tauri.spawnError = new Error('소켓 경로가 115바이트로 커널 상한 104바이트를 넘는다: `/…`');
    await expect(daemonSpawner.spawn({
      agentId: 'a', env: { MURMUR_PAT: 'p', MURMUR_URL: 'u', PATH: '/bin' }, onExit: () => {},
    })).rejects.toThrow('커널 상한 104바이트를 넘는다');
  });

  it('daemon 응답이 계약과 다르면 그 값을 그대로 보이며 실패한다', async () => {
    // 세대 없이 성공한 척하면 exit 통지를 영영 못 거른다 — 조용히 지나가면 안 된다.
    tauri.spawnResult = { agentId: 'a', pid: 1 };
    await expect(daemonSpawner.spawn({
      agentId: 'a', env: { MURMUR_PAT: 'p', MURMUR_URL: 'u', PATH: '/bin' }, onExit: () => {},
    })).rejects.toThrow(/계약과 다르다/);
  });

  it('Tauri 표면이 없으면 그 사실을 실패로 올린다 — 브라우저에서는 러너를 못 띄운다', async () => {
    delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__;
    await expect(daemonSpawner.spawn({
      agentId: 'a', env: { MURMUR_PAT: 'p', MURMUR_URL: 'u', PATH: '/bin' }, onExit: () => {},
    })).rejects.toThrow('Tauri invoke 표면이 없다');
  });
});
