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
import {
  RunnerLauncher, patLabelPrefix,
  type LaunchableAgent, type RunnerProcess, type RunnerSecretStore, type RunnerSpawner,
  type LoginPathReader, type SpawnRequest, type StoredRunnerPat,
} from '../src/lib/runnerLauncher';

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
    /** 마지막으로 띄운 자식이 `code` 로 끝났다고 알린다. */
    exit(code: number | null, index = spawns.length - 1) { spawns[index]!.onExit(code); },
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
) => ({
  api, secrets, spawner, loginPath,
  launcher: new RunnerLauncher(api, secrets, spawner, loginPath, now),
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
});

describe('2. liveness', () => {
  it('러너가 이미 붙어 있으면 띄우지 않고 "외부에서 실행 중"이다', async () => {
    const { launcher, spawner } = make();
    await startAll(launcher, [agent('a')], { live: ['a'] });

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(launcher.getStates()[0]!.status).toBe('external');
  });

  it('presence 를 모르면(소켓 끊김) 띄우지 않는다 — 빈 목록을 "아무도 없다"로 읽지 않는다', async () => {
    const { launcher, spawner } = make();
    await startAll(launcher, [agent('a')], { live: null });

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(launcher.getStates()[0]!.message).toContain('알 수 없다');
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

describe('6. 종료 코드', () => {
  it('78 이면 "재발급 필요"가 된다', async () => {
    const { launcher, spawner } = make();
    await startAll(launcher, [agent('a')]);
    spawner.exit(78);

    const state = launcher.getStates()[0]!;
    expect(state.status).toBe('needs_reissue');
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
    spawner.exit(78, 0);

    expect(launcher.getStates()[0]!).toMatchObject({ status: 'running', exitCode: null });

    // 그리고 78 이 죽은 것이 아님을 같은 자리에서 못박는다: **지금 자식**이 78 로 끝나면
    // 여전히 '재발급 필요'가 된다. 이 대조가 없으면 위 단언은 세대 판정만 재고 78 자체는
    // 재지 않아, 78 분기를 통째로 지워도 초록으로 남는다.
    spawner.exit(78, 1);

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
    const launcher = new RunnerLauncher(fakeApi(), fakeSecrets(), spawner, fakeLoginPath());

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
    spawner.exit(78);

    expect(seen).toEqual(['running', 'needs_reissue']);
  });
});
