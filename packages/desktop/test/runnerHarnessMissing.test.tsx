/**
 * `#473` 회귀선 — **하네스가 없는데 앱이 "PAT 가 폐기됐다"고 말하지 않는다.**
 *
 * ## 무엇이 문제였나
 *
 * 종료 코드 78(`EX_CONFIG`)을 **두 사유가 공유한다**:
 *
 * | 사유 | 사람이 할 일 |
 * |---|---|
 * | 자격증명 거부(`#250`) | PAT 를 재발급한다 |
 * | 하네스 실행 파일 부재(`#340`) | `claude`/`codex` 를 설치하고 `PATH` 를 고친다 |
 *
 * 앱은 78 을 전부 앞쪽으로 단정했고, 하네스가 없는 사람은 재발급을 눌러도 아무것도
 * 안 고쳐졌다. `claude`·`codex` 는 사용자가 직접 설치하므로(2026-09-06 결정)
 * **"하네스가 없다"는 예외가 아니라 새 사용자의 기본 상태다.**
 *
 * ## 이 파일이 재는 것 — 판정과 문구, 그리고 그 문구가 닿는 자리
 *
 * 구분자는 **러너 로그의 마지막 줄**이고(`@murmur/shared` 의 두 상수), 그것이 여기까지
 * 오는 경로는 `#434` 가 놓았다: 러너의 출력이 파일로 가고 → daemon 이 exit 순간 꼬리를
 * 읽어 `runnerExit` 에 싣고 → 앱이 `onExit(code, tailLines)` 로 받는다.
 *
 * **문자열을 손으로 적어 대조하지 않는다.** 꼬리에 넣는 구분자도, 화면에서 찾는 실행
 * 파일 이름도 전부 `@murmur/shared` 의 진실 원천에서 가져온다 — 테스트가 자기 사본을
 * 들면 상수가 바뀔 때 이 파일만 초록으로 남고, 그때 앱은 다시 사유를 지어낸다.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  CREDENTIAL_REJECTED_LINE,
  EX_CONFIG,
  EXECUTABLE_NOT_FOUND_LINE,
  harnessBinaryName,
} from '@murmur/shared';
import {
  RunnerLauncher,
  type LaunchableAgent,
  type LoginPathReader,
  type RunnerProcess,
  type RunnerSecretStore,
  type RunnerSpawner,
  type SpawnRequest,
  type StoredRunnerPat,
} from '../src/lib/runnerLauncher';
import { RunnerStatusLine, runnerStatusLabel } from '../src/components/RunnerStatus';

afterEach(cleanup);

const DEVICE = 'ab12cd34';

const agent = (id: string, extra: Partial<LaunchableAgent> = {}): LaunchableAgent => ({
  id,
  handle: id,
  ownerAccountId: 'me',
  disabled: false,
  stopRequestedAt: null,
  harness: 'claude-code',
  ...extra,
});

function fakeSecrets() {
  const map = new Map<string, StoredRunnerPat>();
  return {
    read: vi.fn(async (agentId: string) => ({ ok: true as const, value: map.get(agentId) ?? null })),
    write: vi.fn(async (agentId: string, value: StoredRunnerPat) => { map.set(agentId, value); }),
    clear: vi.fn(async (agentId: string) => { map.delete(agentId); }),
    deviceId: vi.fn(async () => DEVICE),
  } satisfies RunnerSecretStore;
}

/**
 * 자식 목. **`exit(code, tailLines)` 가 이 파일의 핵심 표면이다** — daemon 이 exit 통지에
 * 꼬리를 실어 보내는 것을 흉내낸다(`RunnerExitEvent.tailLines`).
 */
function fakeSpawner() {
  const spawns: SpawnRequest[] = [];
  const spawner = {
    spawns,
    spawn: vi.fn(async (req: SpawnRequest): Promise<RunnerProcess> => {
      spawns.push(req);
      return { kill: async () => undefined };
    }),
    exit(code: number | null, tailLines?: string[]) {
      spawns.at(-1)!.onExit(code, tailLines);
    },
  };
  return spawner satisfies RunnerSpawner & Record<string, unknown>;
}

function fakeApi() {
  return {
    baseUrl: 'https://murmur.example',
    listPats: vi.fn(async () => [] as { label: string; revokedAt: string | null }[]),
    mintPat: vi.fn(async (_id: string, label: string) => `murp_${label}`),
    revokePat: vi.fn(async () => ({ revoked: 1 })),
  };
}

const loginPath: LoginPathReader = { read: async () => '/login/bin' };

async function 띄운다(a: LaunchableAgent) {
  const spawner = fakeSpawner();
  const launcher = new RunnerLauncher(fakeApi(), fakeSecrets(), spawner, loginPath, () => 0);
  await launcher.startAll({
    agents: [a],
    myAccountId: 'me',
    liveAccountIds: new Set<string>(),
  });
  return { launcher, spawner };
}

/**
 * 러너가 하네스를 못 찾아 78 로 물러날 때 실제로 남기는 꼬리.
 *
 * `runnerExitPlan`(`packages/agent/src/exit.ts`)이 찍는 블록의 **모양**을 따른다 —
 * 안내 몇 줄 뒤에 구분자가 마지막으로 온다. 앞 줄들을 함께 두는 것이 요점이다:
 * 판정이 "마지막 줄 하나"가 아니라 "꼬리 안에 있는가"로 서는지 이 픽스처가 재고,
 * 그래야 다른 경로가 한 줄 더 찍었을 때도 판정이 안 뒤집힌다.
 */
const 하네스부재꼬리 = [
  'harness 실행 파일을 찾을 수 없다. 러너를 멈춘다.',
  '  실행 파일: claude',
  '  자식에게 넘긴 PATH: /usr/bin:/bin',
  EXECUTABLE_NOT_FOUND_LINE,
];

const 자격증명거부꼬리 = [
  'Murmur 자격증명을 해결할 수 없다. 러너를 멈춘다.',
  '  Murmur API 의 PAT 가 만료·폐기됐는지 확인해라.',
  CREDENTIAL_REJECTED_LINE,
];

describe('회귀선 3 — 하네스 부재를 PAT 문제로 말하지 않는다', () => {
  /**
   * **되돌려 RED**: `handleExit` 의 78 분기를 앞 판본
   * (`message: 'PAT 가 폐기·회전됐다 — 재발급하면 다시 뜬다'` 한 줄)으로 되돌리면
   * `toContain('PAT')` 이 성립해 이 단언이 빨개진다. 실제로 되돌려 실행해 확인했다.
   */
  it('78 + EXECUTABLE_NOT_FOUND_LINE 이면 문구에 "PAT" 가 없다', async () => {
    const { launcher, spawner } = await 띄운다(agent('a'));
    spawner.exit(EX_CONFIG, 하네스부재꼬리);

    const state = launcher.getStates()[0]!;
    expect(state.exitCode).toBe(EX_CONFIG);
    // **이것이 이 이슈다.** 화면 문구 어디에도 자격증명 이야기가 없어야 한다.
    //
    // `'PAT'` 를 그대로 찾지 않는 이유: 이 문구는 **`PATH` 를 확인하라고 말해야 한다**
    // (그것이 사람이 할 일이다). `PATH` 안에 `PAT` 가 들어 있으므로 순진한
    // `not.toContain('PAT')` 은 옳은 문구를 빨갛게 만든다 — 실제로 그렇게 썼다가 잡혔다.
    // 재는 것은 "PAT 라는 세 글자"가 아니라 **자격증명을 사유로 말하는가**다.
    expect(state.message).not.toMatch(/PAT(?!H)/);
    expect(state.message).not.toContain('재발급');
    expect(state.message).not.toContain('폐기');
    // 상태도 재발급 상태가 아니다 — 그 상태는 화면에 재발급 버튼을 세운다.
    expect(state.status).not.toBe('needs_reissue');
    expect(state.status).toBe('needs_harness');
  });

  /**
   * **회귀선 5 — 하네스 이름이 문구에 들어간다.**
   *
   * "하네스를 설치해라"만으로는 사람이 무엇을 설치할지 모른다. 이름은 에이전트마다
   * 다르므로(`claude-code` → `claude`, `codex` → `codex`) 그 값에서 나와야 한다.
   *
   * **되돌려 RED**: `exitStateFor78` 에서 `harnessBinaryName(agent.harness)` 를 지우고
   * 고정 문구를 쓰면 codex 쪽 단언이 빨개진다.
   */
  it('어느 하네스인지 실행 파일 이름을 말한다 — 에이전트마다 다르다', async () => {
    for (const harness of ['claude-code', 'codex'] as const) {
      const binary = harnessBinaryName(harness)!;
      const { launcher, spawner } = await 띄운다(agent('a', { harness }));
      spawner.exit(EX_CONFIG, 하네스부재꼬리);

      const message = launcher.getStates()[0]!.message ?? '';
      expect(message).toContain(binary);
      expect(message).toContain('설치');
      expect(message).toContain('PATH');
    }
  });

  it('모르는 하네스면 이름을 지어내지 않는다', async () => {
    const { launcher, spawner } = await 띄운다(agent('a', { harness: 'gemini' }));
    spawner.exit(EX_CONFIG, 하네스부재꼬리);

    const message = launcher.getStates()[0]!.message ?? '';
    // 실행 가능한 하네스의 이름을 함부로 갖다 붙이지 않는다.
    expect(message).not.toContain('claude');
    expect(message).not.toContain('codex');
    // 그래도 "설치해라"라는 방향은 말한다 — 상태 자체는 하네스 부재가 맞다.
    expect(launcher.getStates()[0]!.status).toBe('needs_harness');
  });
});

describe('회귀선 4 — 자격증명 거부는 여전히 PAT 문구다 (대조군)', () => {
  /**
   * 이 대조군이 없으면 위 회귀선은 "78 분기를 통째로 지워도" 초록이다 — `#473` 이 고친
   * 것은 78 을 전부 한쪽으로 보내던 것이지, 자격증명 쪽 자체가 아니다.
   */
  it('78 + CREDENTIAL_REJECTED_LINE 이면 재발급을 말한다', async () => {
    const { launcher, spawner } = await 띄운다(agent('a'));
    spawner.exit(EX_CONFIG, 자격증명거부꼬리);

    const state = launcher.getStates()[0]!;
    expect(state.status).toBe('needs_reissue');
    expect(state.message).toContain('PAT');
    expect(state.message).toContain('재발급');
  });
});

describe('둘 다 아닌 78 — 지어내지 않는다 (#368)', () => {
  /**
   * 꼬리가 없는 경우다: daemon 이 로그를 못 열었거나, 버전이 갈린 옛 daemon 이 이 필드를
   * 안 보낸다. **여기서 한쪽을 골라 단정하는 것이 정확히 `#473` 의 결함이다.**
   */
  it('꼬리가 없으면 재발급을 말하지 않고 모른다고 한다', async () => {
    for (const 꼬리 of [undefined, [] as string[]]) {
      const { launcher, spawner } = await 띄운다(agent('a'));
      spawner.exit(EX_CONFIG, 꼬리);

      const state = launcher.getStates()[0]!;
      expect(state.status).not.toBe('needs_reissue');
      expect(state.status).not.toBe('needs_harness');
      expect(state.message).not.toMatch(/PAT(?!H)/);
      // 코드는 그대로 보인다 — 아는 것은 말한다.
      expect(state.exitCode).toBe(EX_CONFIG);
      expect(state.message).toContain('78');
      expect(state.message).toContain('러너 로그');
    }
  });

  it('구분자가 없는 꼬리는 그 내용을 그대로 보여 준다', async () => {
    const { launcher, spawner } = await 띄운다(agent('a'));
    spawner.exit(EX_CONFIG, ['설정 파일이 깨졌다', '알 수 없는 사유로 물러난다']);

    const message = launcher.getStates()[0]!.message ?? '';
    // 러너가 한 말이 그대로 사람에게 간다 — 앱이 다시 설명하지 않는다.
    expect(message).toContain('알 수 없는 사유로 물러난다');
    expect(message).not.toMatch(/PAT(?!H)/);
  });

  it('78 이 아닌 코드는 그대로 보인다 — 78 판정이 다른 코드로 새지 않는다', async () => {
    const { launcher, spawner } = await 띄운다(agent('a'));
    // 하네스 부재 꼬리가 실려 있어도 코드가 78 이 아니면 그 판정을 쓰지 않는다.
    spawner.exit(1, 하네스부재꼬리);

    const state = launcher.getStates()[0]!;
    expect(state.status).toBe('stopped');
    expect(state.exitCode).toBe(1);
    expect(state.message).toBeNull();
  });
});

describe('화면 — 문구가 사람이 보는 자리에 닿는다', () => {
  /**
   * 실행기가 만든 문구를 **그대로** 화면에 넣고 그 글자가 나오는지 본다. 화면이 자기
   * 문구를 새로 쓰면 실행기가 준 글자가 없어 빨개진다(`runnerFailureDisplay.test.tsx`
   * 와 같은 규율).
   */
  it('하네스 부재 상태의 라벨과 문구가 화면에 글자로 나온다', async () => {
    const { launcher, spawner } = await 띄운다(agent('a'));
    spawner.exit(EX_CONFIG, 하네스부재꼬리);
    const state = launcher.getStates()[0]!;

    render(<RunnerStatusLine state={state} />);

    const text = document.body.textContent ?? '';
    expect(text).toContain(harnessBinaryName('claude-code')!);
    expect(text).toContain(state.message!);
    // 라벨도 자격증명 이야기를 하지 않는다.
    expect(runnerStatusLabel(state)).not.toContain('자격증명');
    expect(runnerStatusLabel(state)).toContain('하네스');
    expect(screen.getByRole('status')).toBeTruthy();
  });
});
