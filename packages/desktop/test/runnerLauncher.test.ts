/**
 * 러너 실행기 회귀선(#250).
 *
 * **실행기 자체를 부른다.** 앞선 판본의 이 파일은 대상 판정·상태 판정·라벨 규칙을 테스트
 * 안에 다시 구현해 그 사본에 단언했고, `runnerLauncher.ts` 를 import 조차 하지 않았다 —
 * 구현이 무엇을 하든 초록이었다(실제로 그 구현은 5초마다 자식을 `kill()` 했고 종료 코드를
 * 볼 수 없었으며 Tauri shell 스코프가 비어 있어 애초에 자식을 띄우지 못했는데, 그 파일은
 * 전부 통과했다). 여기서는 키체인과 자식 프로세스만 목이고 판정은 전부 실물이다.
 */
import { describe, it, expect, vi } from 'vitest';
import { CREDENTIAL_REJECTED_LINE } from '@murmur/shared';
import {
  RunnerLauncher, patLabelPrefix, STRANGER_ATTACHED,
  type LaunchableAgent, type RunnerProcess, type RunnerSecretStore, type RunnerSpawner,
  type LoginPathReader, type SpawnRequest, type StoredRunnerPat,
} from '../src/lib/runnerLauncher';
import { fakeDaemon, liveRunner } from './helpers/fakeDaemon';

const agent = (id: string, extra: Partial<LaunchableAgent> = {}): LaunchableAgent => ({
  id, handle: id, ownerAccountId: 'me', disabled: false, stopRequestedAt: null, ...extra,
});

const DEVICE = 'ab12cd34';

/** 키체인 목. 저장소는 맵이고, 읽기 실패를 강제할 수 있다(그 구분이 이 기능의 핵이다). */
function fakeSecrets(initial: Record<string, StoredRunnerPat> = {}) {
  const map = new Map(Object.entries(initial));
  const s = {
    readError: null as string | null,
    read: vi.fn(async (agentId: string) => (
      s.readError
        ? { ok: false as const, error: s.readError }
        : { ok: true as const, value: map.get(agentId) ?? null }
    )),
    write: vi.fn(async (agentId: string, value: StoredRunnerPat) => { map.set(agentId, value); }),
    clear: vi.fn(async (agentId: string) => { map.delete(agentId); }),
    deviceId: vi.fn(async () => DEVICE),
    map,
  };
  return s;
}

/** 자식 프로세스 목. `exit(code)` 로 종료를 흉내낸다 — 실행기는 `onExit` 만 본다. */
function fakeSpawner() {
  const spawns: SpawnRequest[] = [];
  const kills: number[] = [];
  const spawner = {
    spawns,
    kills,
    failNext: null as Error | null,
    spawn: vi.fn(async (req: SpawnRequest): Promise<RunnerProcess> => {
      if (spawner.failNext) { const e = spawner.failNext; spawner.failNext = null; throw e; }
      const index = spawns.push(req) - 1;
      return { kill: async () => { kills.push(index); } };
    }),
    /**
     * 마지막으로 띄운 자식이 `code` 로 끝났다고 알린다.
     *
     * `tailLines` 는 daemon 이 exit 통지에 싣는 **러너 로그의 꼬리**다(`#473`).
     * 안 주면 `undefined` — 옛 daemon 이거나 로그를 못 읽은 경우와 같다.
     */
    exit(code: number | null, index = spawns.length - 1, tailLines?: string[]) {
      spawns[index]!.onExit(code, tailLines);
    },
  };
  return spawner;
}

/**
 * 로그인 셸 `PATH` 조회 목(#305). 기본값을 주는 이유: 이 파일의 기존 테스트들은 `PATH`
 * 이야기를 하지 않으므로 '조회가 된다'가 그 자리의 정상 상태다.
 */
function fakeLoginPath(value: string | null = '/login/bin'): LoginPathReader {
  return { read: vi.fn(async () => value) };
}

function fakeApi(calls: string[] = []) {
  return {
    calls,
    baseUrl: 'https://murmur.example',
    listPats: vi.fn(async () => { calls.push('listPats'); return [] as { label: string; revokedAt: string | null }[]; }),
    mintPat: vi.fn(async (_id: string, label: string) => { calls.push(`mint:${label}`); return `murp_${label}`; }),
    revokePat: vi.fn(async (_id: string, label: string) => { calls.push(`revoke:${label}`); return { revoked: 1 }; }),
  };
}

const make = (
  api = fakeApi(), secrets = fakeSecrets(), spawner = fakeSpawner(),
  loginPath = fakeLoginPath(), now = () => 1_700_000_000_000,
  daemon = fakeDaemon(),
) => ({
  api, secrets, spawner, loginPath, daemon,
  launcher: new RunnerLauncher(api, secrets, spawner, loginPath, now, daemon),
});

const startAll = (
  l: RunnerLauncher, agents: LaunchableAgent[],
  over: { live?: string[] | null } = {},
) => l.startAll({
  agents,
  myAccountId: 'me',
  liveAccountIds: over.live === null ? null : new Set(over.live ?? []),
});

describe('1. 대상 선별', () => {
  it('소유·비활성 아님·종료요청 없음만 뽑는다', async () => {
    const { launcher, spawner } = make();
    await startAll(launcher, [
      agent('mine'),
      agent('theirs', { ownerAccountId: 'someone-else' }),
      agent('unowned', { ownerAccountId: null }),
      agent('off', { disabled: true }),
      agent('stopping', { stopRequestedAt: '2026-09-01T00:00:00Z' }),
    ]);

    expect(spawner.spawns).toHaveLength(1);
    expect(launcher.getStates().map((s) => s.agentId)).toEqual(['mine']);
  });

  /**
   * #427: **종료 요청을 되돌리면 자동 기동 대상에 다시 들어온다.** 이것이 그 이슈의 핵심이다.
   *
   * 되돌리기 자체는 서버가 한다(`POST /accounts/agents/:id/stop/undo` 가
   * `stop_requested_at` 을 null 로 되돌린다) — 앱이 재는 것은 **그 결과를 여기가 어떻게
   * 먹는가**다. 그래서 서버 왕복을 흉내내지 않고 필터가 실제로 보는 값
   * (`stopRequestedAt`)의 전후를 그대로 준다.
   *
   * 되돌리기 전후를 **한 테스트 안에서** 잰다. 대조군(아래)이 따로 있지만, 같은 에이전트가
   * "빠졌다 → 들어왔다"로 움직이는 것을 한자리에서 보이지 않으면 두 단언이 서로 다른
   * 이유로도 통과할 수 있다.
   */
  it('종료 요청을 되돌리면(stopRequestedAt = null) 다시 대상이 된다', async () => {
    const { launcher, spawner } = make();

    // 되돌리기 전 — 서버 정의에 요청이 남아 있다.
    await startAll(launcher, [agent('undone', { stopRequestedAt: '2026-09-01T00:00:00Z' })]);
    expect(spawner.spawns).toHaveLength(0);
    expect(launcher.getStates()).toHaveLength(0);

    // 되돌린 뒤 — 서버가 그 값을 지웠고, 다음 기동이 같은 에이전트를 고른다.
    await startAll(launcher, [agent('undone', { stopRequestedAt: null })]);
    expect(spawner.spawns).toHaveLength(1);
    expect(launcher.getStates().map((s) => s.agentId)).toEqual(['undone']);
  });

  /**
   * #427 대조군. **이것이 없으면 위 회귀선은 "필터가 아예 없다"로도 통과한다** — 요청이
   * 남아 있는 에이전트를 여전히 걸러 내는지가 그 회귀선의 전제다.
   *
   * 위 첫 테스트의 `stopping` 과 겹쳐 보이지만 겹치지 않는다: 저기서는 다섯 마리를 섞어
   * "뽑히는 것이 하나"를 재고, 여기서는 요청이 남은 **한 마리만** 줘서 그 한 마리가
   * 걸러지는 것 자체를 잰다. 저 단언은 다른 필터(소유·비활성) 중 하나만 살아 있어도
   * 통과할 수 있다.
   */
  it('대조군: 되돌리지 않으면 여전히 제외된다', async () => {
    const { launcher, spawner } = make();
    await startAll(launcher, [agent('still-stopping', { stopRequestedAt: '2026-09-01T00:00:00Z' })]);

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(launcher.getStates()).toHaveLength(0);
  });
});

/**
 * `#431` 2단계 A — **판정의 주체가 presence 에서 daemon 으로 옮겨갔다.**
 *
 * 앞 판본의 이 자리는 `liveAccountIds` 를 재고 있었다: presence 에 있으면 `external`,
 * `null` 이면 아예 안 띄움. 그 둘이 정확히 이 이슈가 없앤 것이다.
 */
describe('2. liveness — daemon 장부가 판정한다', () => {
  it('daemon 장부에 있고 살아 있으면 띄우지 않는다 — 중복 러너를 만들지 않는다', async () => {
    const { launcher, spawner } = make(
      fakeApi(), fakeSecrets(), fakeSpawner(), fakeLoginPath(), () => 0,
      fakeDaemon([liveRunner('a')]),
    );
    await startAll(launcher, [agent('a')]);

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(launcher.getStates()[0]!.status).toBe('adopted');
  });

  /**
   * **이 파일의 핵심 회귀선이다.**
   *
   * 실측(2026-09-06, 두 번): 다른 워크트리의 러너 8개 — 고아 6개(`ppid=1`)와 **살아 있는
   * 남의 daemon(pid 35721)의 자식 2개** — 가 서버 presence 에 올라와 있기만 해도 이 앱이
   * 자기 에이전트를 하나도 못 띄웠다. 고아를 사람이 지워도 나머지 2개 때문에 안 풀렸다.
   *
   * 즉 원인은 "고아"가 아니라 **판정 기준이 presence 하나였다는 것**이다. 장부에 없는
   * 러너는 그것이 고아든 남의 daemon 의 자식이든 **내 것이 아니고**, 내 에이전트를
   * 막을 이유가 없다.
   *
   * 되돌려 RED: `doStartOne` 에 `if (input.liveAccountIds?.has(agent.id)) return;` 를
   * 되살리면 이 테스트가 빨개진다.
   */
  it('장부에 없는 러너가 서버 presence 에 있어도 내 에이전트는 뜬다', async () => {
    const { launcher, spawner } = make(
      fakeApi(), fakeSecrets(), fakeSpawner(), fakeLoginPath(), () => 0,
      fakeDaemon([]), // 장부는 비어 있다 — 그 러너는 남의 daemon 것이다
    );
    await startAll(launcher, [agent('a')], { live: ['a'] });

    expect(spawner.spawn).toHaveBeenCalledTimes(1);
    expect(launcher.getStates()[0]!.status).toBe('running');
  });

  it('그 어긋남을 사람에게 말한다 — 막지는 않되 침묵하지도 않는다', async () => {
    const { launcher } = make(
      fakeApi(), fakeSecrets(), fakeSpawner(), fakeLoginPath(), () => 0, fakeDaemon([]),
    );
    await startAll(launcher, [agent('a')], { live: ['a'] });

    expect(launcher.getStates()[0]!.message).toBe(STRANGER_ATTACHED);
  });

  it('presence 를 몰라도(소켓 끊김) 띄운다 — 중복을 막는 것은 이제 장부다', async () => {
    const { launcher, spawner } = make(
      fakeApi(), fakeSecrets(), fakeSpawner(), fakeLoginPath(), () => 0, fakeDaemon([]),
    );
    await startAll(launcher, [agent('a')], { live: null });

    expect(spawner.spawn).toHaveBeenCalledTimes(1);
    // 어긋남이 없으므로 사유도 없다 — 없는 사실을 문장으로 만들지 않는다(`#368`).
    expect(launcher.getStates()[0]!.message).toBeNull();
  });

  it('장부에 있지만 죽었으면 띄운다 — 장부는 이력이지 현재가 아니다', async () => {
    const { launcher, spawner } = make(
      fakeApi(), fakeSecrets(), fakeSpawner(), fakeLoginPath(), () => 0,
      fakeDaemon([{ agentId: 'a', alive: false, adopted: false }]),
    );
    await startAll(launcher, [agent('a')]);

    expect(spawner.spawn).toHaveBeenCalledTimes(1);
  });

  it('`external` 상태는 더 이상 없다 — presence 만으로 건너뛰지 않는다', async () => {
    const { launcher } = make(
      fakeApi(), fakeSecrets(), fakeSpawner(), fakeLoginPath(), () => 0, fakeDaemon([]),
    );
    await startAll(launcher, [agent('a')], { live: ['a'] });

    expect(launcher.getStates().map((s) => s.status)).not.toContain('external');
  });
});

/**
 * `#431` 2단계 A — **daemon 은 러너의 부산물이 아니다.**
 *
 * 앞 판본에서 daemon 에 닿는 자리는 `spawn()` 하나뿐이었고, 그 앞단이 안 띄우기로 하면
 * daemon 도 안 떴다. 그것이 순환의 첫 화살표다(`DaemonObserver` 주석).
 */
describe('2-A. daemon 을 먼저 세운다', () => {
  it('띄울 러너가 하나도 없어도 daemon 을 세운다', async () => {
    const { launcher, daemon, spawner } = make();
    await launcher.ensureDaemon();

    expect(daemon.observeCalls).toBe(1);
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('대상이 0개여도 daemon 에 묻는다 — 물어야 순환이 끊긴다', async () => {
    const { launcher, daemon } = make();
    await startAll(launcher, []);

    expect(daemon.observeCalls).toBe(1);
  });

  it('daemon 확보에 실패하면 던지지 않고 null 로 돌아온다 — 앱은 떠야 한다', async () => {
    const { launcher, daemon } = make();
    daemon.error = new Error('소켓 없음');

    await expect(launcher.ensureDaemon()).resolves.toBeNull();
  });

  it('daemon 에 못 닿으면 러너를 안 띄우고 그 사유를 남긴다 — 폴백은 없다', async () => {
    const { launcher, daemon, spawner } = make();
    daemon.error = new Error('소켓 없음');
    await startAll(launcher, [agent('a')]);

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(launcher.getStates()[0]!.message).toContain('소켓 없음');
  });

  it('에이전트가 여럿이어도 한 번만 묻는다 — 루프 도중 장부가 바뀌지 않는다', async () => {
    const { launcher, daemon } = make();
    await startAll(launcher, [agent('a'), agent('b'), agent('c')]);

    expect(daemon.observeCalls).toBe(1);
  });
});

describe('3. 키체인의 PAT 를 재사용한다 (기동마다 재발급하지 않는다)', () => {
  it('PAT 가 있으면 발급·폐기를 부르지 않고 그 토큰으로 띄운다', async () => {
    const secrets = fakeSecrets({ a: { label: patLabelPrefix(DEVICE), token: 'murp_old' } });
    const { launcher, api, spawner } = make(fakeApi(), secrets);
    await startAll(launcher, [agent('a')]);

    expect(api.mintPat).not.toHaveBeenCalled();
    expect(api.revokePat).not.toHaveBeenCalled();
    expect(api.listPats).not.toHaveBeenCalled();
    expect(spawner.spawns[0]!.env.MURMUR_PAT).toBe('murp_old');
  });

  it('키체인을 못 읽으면 발급하지 않는다 — 돌고 있는 러너를 죽이지 않는다', async () => {
    const secrets = fakeSecrets();
    secrets.readError = 'keychain locked';
    const { launcher, api, spawner } = make(fakeApi(), secrets);
    await startAll(launcher, [agent('a')]);

    expect(api.mintPat).not.toHaveBeenCalled();
    expect(spawner.spawn).not.toHaveBeenCalled();
    const state = launcher.getStates()[0]!;
    expect(state.status).toBe('failed');
    expect(state.message).toContain('keychain locked');
  });
});

describe('4. 첫 발급', () => {
  it('없으면 발급하고 키체인에 저장한다', async () => {
    const secrets = fakeSecrets();
    const { launcher, api, spawner } = make(fakeApi(), secrets);
    await startAll(launcher, [agent('a')]);

    const label = patLabelPrefix(DEVICE);
    expect(api.mintPat).toHaveBeenCalledWith('a', label);
    expect(secrets.map.get('a')).toEqual({ label, token: `murp_${label}` });
    expect(spawner.spawns[0]!.env.MURMUR_PAT).toBe(`murp_${label}`);
  });

  it('같은 라벨이 서버에 살아 있으면 **먼저 폐기하고** 발급한다', async () => {
    const api = fakeApi();
    const label = patLabelPrefix(DEVICE);
    api.listPats = vi.fn(async () => {
      api.calls.push('listPats');
      return [
        { label, revokedAt: null },
        { label: `${label}#1`, revokedAt: null },
        // 다른 기기·다른 용도의 라벨은 건드리지 않는다.
        { label: 'desktop:other', revokedAt: null },
        { label: 'runner', revokedAt: null },
        // 이미 폐기된 것은 다시 폐기하지 않는다.
        { label: `${label}#0`, revokedAt: '2026-01-01T00:00:00Z' },
      ];
    });
    const { launcher } = make(api, fakeSecrets());
    await startAll(launcher, [agent('a')]);

    expect(api.calls).toEqual(['listPats', `revoke:${label}`, `revoke:${label}#1`, `mint:${label}`]);
  });
});

describe('4-1. 앱 실행 뒤 만든 에이전트', () => {
  it('생성 API 가 돌려준 PAT 를 키체인에 저장하고 추가 발급 없이 즉시 띄운다', async () => {
    const secrets = fakeSecrets();
    const { launcher, api, spawner } = make(fakeApi(), secrets);
    const createdPat = { label: 'runner', token: 'murp_created' };

    await launcher.startCreated({
      agent: agent('codex'), pat: createdPat, autoStart: true,
      liveAccountIds: new Set(),
    });

    expect(secrets.map.get('codex')).toEqual(createdPat);
    expect(api.mintPat).not.toHaveBeenCalled();
    expect(spawner.spawns).toHaveLength(1);
    expect(spawner.spawns[0]!.env.MURMUR_PAT).toBe('murp_created');
    expect(launcher.getStates()[0]!.status).toBe('running');
  });

  it('자동 기동이 꺼져 있어도 유일한 PAT 원문은 키체인에 보관한다', async () => {
    const secrets = fakeSecrets();
    const { launcher, spawner } = make(fakeApi(), secrets);

    await launcher.startCreated({
      agent: agent('codex'), pat: { label: 'runner', token: 'murp_created' }, autoStart: false,
      liveAccountIds: new Set(),
    });

    expect(secrets.map.get('codex')?.token).toBe('murp_created');
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('키체인 저장 실패는 생성 성공을 throw 로 뒤집지 않고 러너 상태에 이유를 남긴다', async () => {
    const secrets = fakeSecrets();
    secrets.write.mockRejectedValueOnce(new Error('keychain locked'));
    const { launcher, spawner } = make(fakeApi(), secrets);

    await expect(launcher.startCreated({
      agent: agent('codex'), pat: { label: 'runner', token: 'murp_created' }, autoStart: true,
      liveAccountIds: new Set(),
    })).resolves.toBeUndefined();

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(launcher.getStates()[0]).toMatchObject({ status: 'failed' });
    expect(launcher.getStates()[0]!.message).toContain('keychain locked');
  });
});

describe('5. 재발급 — 새 발급 → 옛 폐기 → 재실행', () => {
  it('호출 순서가 그 순서다', async () => {
    const oldLabel = patLabelPrefix(DEVICE);
    const secrets = fakeSecrets({ a: { label: oldLabel, token: 'murp_old' } });
    const { launcher, api, spawner } = make(fakeApi(), secrets);
    await startAll(launcher, [agent('a')]);
    api.calls.length = 0;

    await launcher.reissue({ agent: agent('a') });

    const newLabel = `${oldLabel}#1700000000000`;
    // 발급이 먼저다. 폐기가 먼저면 발급 실패 한 번에 쓸 수 있는 PAT 가 사라진다.
    expect(api.calls).toEqual([`mint:${newLabel}`, `revoke:${oldLabel}`]);
    // 그리고 재실행이 일어났고, 새 토큰으로 떴다.
    expect(spawner.spawns).toHaveLength(2);
    expect(spawner.spawns[1]!.env.MURMUR_PAT).toBe(`murp_${newLabel}`);
    // 옛 자식은 죽였다 — 같은 에이전트에 러너가 둘이면 안 된다.
    expect(spawner.kills).toEqual([0]);
    expect(secrets.map.get('a')).toEqual({ label: newLabel, token: `murp_${newLabel}` });
  });

  it('옛 자식의 늦은 종료가 새 자식의 실행 중 상태를 덮어쓰지 않는다', async () => {
    const oldLabel = patLabelPrefix(DEVICE);
    const secrets = fakeSecrets({ a: { label: oldLabel, token: 'murp_old' } });
    const { launcher, spawner } = make(fakeApi(), secrets);
    await startAll(launcher, [agent('a')]);

    await launcher.reissue({ agent: agent('a') });
    expect(launcher.getStates()[0]!.status).toBe('running');

    // 실제 Tauri close 이벤트처럼 kill()이 끝난 뒤 옛 자식의 종료가 늦게 도착한다.
    spawner.exit(0, 0);

    expect(launcher.getStates()[0]).toMatchObject({ status: 'running', exitCode: null });
    // 새 자식은 여전히 등록돼 있어 일반 자동 기동이 중복으로 하나를 더 만들지 않는다.
    await startAll(launcher, [agent('a')]);
    expect(spawner.spawns).toHaveLength(2);
  });

  it('발급이 실패하면 옛 PAT 를 폐기하지 않는다 — 돌던 러너를 잃지 않는다', async () => {
    const oldLabel = patLabelPrefix(DEVICE);
    const secrets = fakeSecrets({ a: { label: oldLabel, token: 'murp_old' } });
    const api = fakeApi();
    const { launcher, spawner } = make(api, secrets);
    await startAll(launcher, [agent('a')]);
    api.mintPat = vi.fn(async () => { throw new Error('server down'); });

    await launcher.reissue({ agent: agent('a') });

    expect(api.revokePat).not.toHaveBeenCalled();
    expect(spawner.kills).toEqual([]);
    expect(secrets.map.get('a')).toEqual({ label: oldLabel, token: 'murp_old' });
    expect(launcher.getStates()[0]!.message).toContain('옛 PAT 는 그대로 살아 있다');
  });

  it('폐기가 실패하면 삼키지 않고 남은 일을 말한다', async () => {
    const oldLabel = patLabelPrefix(DEVICE);
    const secrets = fakeSecrets({ a: { label: oldLabel, token: 'murp_old' } });
    const api = fakeApi();
    const { launcher } = make(api, secrets);
    await startAll(launcher, [agent('a')]);
    api.revokePat = vi.fn(async () => { throw new Error('403'); });

    await launcher.reissue({ agent: agent('a') });

    const state = launcher.getStates()[0]!;
    expect(state.status).toBe('running');
    expect(state.message).toContain('폐기에 실패했다');
    expect(state.message).toContain(oldLabel);
  });
});

/**
 * 러너가 자격증명 거부로 물러날 때 로그에 남기는 구분자(`#473`).
 *
 * **`#434` 이전에는 이 값이 필요 없었다** — 앱이 78 을 보면 무조건 자격증명 거부로
 * 단정했기 때문이다. 그 단정이 하네스가 없는 사람에게 재발급을 시켰고(`#473`), 이제
 * 앱은 **로그의 이 줄**을 보고 가른다. 그래서 이 픽스처가 생겼다.
 *
 * 문자열을 손으로 적지 않고 `@murmur/shared` 의 상수를 쓴다 — 사본을 들면 상수가
 * 바뀔 때 이 파일만 초록으로 남고, 그때 앱은 다시 사유를 못 가린다.
 */
const 자격증명거부꼬리 = [CREDENTIAL_REJECTED_LINE];

describe('6. 종료 코드', () => {
  it('78 + 자격증명 거부 구분자면 "재발급 필요"가 된다', async () => {
    const { launcher, spawner } = make();
    await startAll(launcher, [agent('a')]);
    spawner.exit(78, undefined, 자격증명거부꼬리);

    const state = launcher.getStates()[0]!;
    expect(state.status).toBe('needs_reissue');
    expect(state.exitCode).toBe(78);
  });

  /**
   * **78 만으로는 재발급을 말하지 않는다** — `#473` 이 고친 것이 이것이다.
   *
   * 자세한 갈래는 `runnerHarnessMissing.test.tsx` 가 잰다. 여기 한 줄을 두는 이유는
   * 이 파일이 종료 코드 판정의 자리이고, 누가 78 분기를 "꼬리를 안 봐도 되게" 되돌리면
   * 여기서도 걸려야 하기 때문이다.
   */
  it('구분자 없는 78 은 재발급을 말하지 않는다 — 사유를 지어내지 않는다', async () => {
    const { launcher, spawner } = make();
    await startAll(launcher, [agent('a')]);
    spawner.exit(78);

    const state = launcher.getStates()[0]!;
    expect(state.status).not.toBe('needs_reissue');
    expect(state.exitCode).toBe(78);
  });

  it('다른 코드면 그 코드가 보인다 — 원인을 지어내지 않는다', async () => {
    const { launcher, spawner } = make();
    await startAll(launcher, [agent('a')]);
    spawner.exit(1);

    const state = launcher.getStates()[0]!;
    expect(state.status).toBe('stopped');
    expect(state.exitCode).toBe(1);
    // 78 이 아닌 것을 '재발급 필요'로 뭉치지 않는다 — 사람이 할 일이 다르다.
    expect(state.status).not.toBe('needs_reissue');
  });

  it('78 로 죽은 뒤 재발급하면 다시 뜬다', async () => {
    const { launcher, spawner } = make();
    await startAll(launcher, [agent('a')]);
    spawner.exit(78);

    await launcher.reissue({ agent: agent('a') });

    expect(spawner.spawns).toHaveLength(2);
    expect(launcher.getStates()[0]!.status).toBe('running');
  });

  it('옛 자식의 늦은 78 종료가 새 자식의 실행 중 상태를 덮어쓰지 않는다', async () => {
    const oldLabel = patLabelPrefix(DEVICE);
    const secrets = fakeSecrets({ a: { label: oldLabel, token: 'murp_old' } });
    const { launcher, spawner } = make(fakeApi(), secrets);
    await startAll(launcher, [agent('a')]);

    await launcher.reissue({ agent: agent('a') });
    // 새 자식이 실제로 떴는지 먼저 못박는다 — 자식이 하나뿐인 상태로 통과하면
    // '옛 자식의 종료'라는 이 테스트의 전제 자체가 없는 것이다.
    expect(spawner.spawns).toHaveLength(2);
    expect(launcher.getStates()[0]!.status).toBe('running');

    // 재발급 순서(결정 3: 새 발급 → 옛 폐기 → 재실행)상 옛 자식은 폐기된 PAT 로 401 을
    // 받고 78 로 죽는 것이 정상 경로다 — 그 통지가 새 자식을 'needs_reissue' 로 덮으면 안 된다.
    // 꼬리까지 실려 온다(`#473`) — **꼬리가 있어도 세대 판정이 먼저 거른다**는 것이
    // 이 단언이 함께 지키는 성질이다.
    spawner.exit(78, 0, 자격증명거부꼬리);

    expect(launcher.getStates()[0]!).toMatchObject({ status: 'running', exitCode: null });

    // 그리고 78 이 죽은 것이 아님을 같은 자리에서 못박는다: **지금 자식**이 78 로 끝나면
    // 여전히 '재발급 필요'가 된다. 이 대조가 없으면 위 단언은 세대 판정만 재고 78 자체는
    // 재지 않아, 78 분기를 통째로 지워도 초록으로 남는다.
    spawner.exit(78, 1, 자격증명거부꼬리);

    expect(launcher.getStates()[0]!).toMatchObject({ status: 'needs_reissue', exitCode: 78 });
  });
});

describe('7. 한 에이전트가 못 떠도 나머지는 뜬다', () => {
  it('첫 에이전트의 spawn 이 throw 해도 둘째가 뜬다', async () => {
    const { launcher, spawner } = make();
    spawner.failNext = new Error('program not allowed');
    await startAll(launcher, [agent('a'), agent('b')]);

    expect(spawner.spawns.map((s) => s.env.MURMUR_PAT)).toHaveLength(1);
    const byId = Object.fromEntries(launcher.getStates().map((s) => [s.agentId, s]));
    expect(byId.a!.status).toBe('failed');
    expect(byId.a!.message).toContain('program not allowed');
    expect(byId.b!.status).toBe('running');
  });

  it('발급이 throw 해도 나머지가 뜬다', async () => {
    const api = fakeApi();
    let first = true;
    api.mintPat = vi.fn(async (_id: string, label: string) => {
      if (first) { first = false; throw new Error('409 label_in_use'); }
      return `murp_${label}`;
    });
    const { launcher, spawner } = make(api);
    await startAll(launcher, [agent('a'), agent('b')]);

    expect(spawner.spawns).toHaveLength(1);
    const byId = Object.fromEntries(launcher.getStates().map((s) => [s.agentId, s]));
    expect(byId.a!.status).toBe('failed');
    expect(byId.b!.status).toBe('running');
  });
});

/**
 * `#431` 1단계에서 `repoPath`(저장소 경로)·`runnerCommand`(pnpm 경로)와 그것을 채우던
 * `RunnerRepoProvisioner`(#425 전역 체크아웃)가 통째로 사라졌다 — 러너가 Tauri sidecar 로
 * 배포되면서 "murmur 소스가 어디 있나"라는 물음 자체가 없어졌기 때문이다(사이드카는 자기
 * 위치를 스스로 안다, `main.rs::sidecar_path()`). 옛 "8. 저장소 경로"·
 * "10. 전역 저장소(#425)" 스위트가 여기 있었다 — 이 자리는 그 제거의 흔적이다.
 *
 * 남는 것은 `MURMUR_URL`(서버 주소)뿐이고, 그것은 "3. 키체인의 PAT 를 재사용한다" 등
 * 다른 스위트가 이미 `spawner.spawns[0]!.env` 로 확인하고 있다.
 */
describe('8. MURMUR_URL 은 서버 주소 그대로 넘어간다', () => {
  it('env.MURMUR_URL 이 api.baseUrl 과 같다', async () => {
    const { launcher, spawner } = make();
    await startAll(launcher, [agent('a')]);

    expect(spawner.spawns[0]!.env.MURMUR_URL).toBe('https://murmur.example');
  });
});

describe('9. 중복 방지·정리', () => {
  it('두 번 startAll 해도 자식은 하나다', async () => {
    const { launcher, spawner } = make();
    await startAll(launcher, [agent('a')]);
    await startAll(launcher, [agent('a')]);

    expect(spawner.spawns).toHaveLength(1);
  });

  it('두 startAll 이 비동기로 겹쳐도 에이전트별 기동은 하나다', async () => {
    const { launcher, api, spawner } = make();

    await Promise.all([
      startAll(launcher, [agent('a')]),
      startAll(launcher, [agent('a')]),
    ]);

    expect(api.mintPat).toHaveBeenCalledTimes(1);
    expect(spawner.spawns).toHaveLength(1);
  });

  it('dispose 는 띄운 자식을 끝낸다', async () => {
    const { launcher, spawner } = make();
    await startAll(launcher, [agent('a'), agent('b')]);
    launcher.dispose();

    expect(spawner.kills.sort()).toEqual([0, 1]);
  });

  it('spawn IPC 도중 dispose 해도 뒤늦게 생긴 자식을 즉시 끝낸다', async () => {
    const kill = vi.fn(async () => {});
    let finishSpawn!: () => void;
    const spawner: RunnerSpawner = {
      spawn: vi.fn(() => new Promise<RunnerProcess>((resolve) => {
        finishSpawn = () => resolve({ kill });
      })),
    };
    const launcher = new RunnerLauncher(
      fakeApi(), fakeSecrets(), spawner, fakeLoginPath(), () => 0, fakeDaemon(),
    );

    const starting = startAll(launcher, [agent('a')]);
    await vi.waitFor(() => expect(spawner.spawn).toHaveBeenCalledOnce());
    launcher.dispose();
    finishSpawn();
    await starting;

    expect(kill).toHaveBeenCalledOnce();
    expect(launcher.getStates().some((state) => state.status === 'running')).toBe(false);
  });

  it('상태 변화가 구독자에게 간다', async () => {
    const { launcher, spawner } = make();
    const seen: string[] = [];
    launcher.setOnStateChange((states) => seen.push(states.map((s) => s.status).join(',')));
    await startAll(launcher, [agent('a')]);
    spawner.exit(78, undefined, 자격증명거부꼬리);

    expect(seen).toEqual(['running', 'needs_reissue']);
  });
});
