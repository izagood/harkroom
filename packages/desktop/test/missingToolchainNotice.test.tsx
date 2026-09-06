/**
 * `#476` 회귀선 — **없는 것을 어떻게 설치하는지 화면이 말한다.**
 *
 * ## 무엇이 문제였나 — 가장 흔한 상태가 가장 조용했다
 *
 * murmur 는 `node`·`claude`·`codex` 를 **동봉하지 않는다**(2026-09-06 사용자 방침):
 *
 * > murmur 는 자기 것만 배포하고, 남의 것은 사용자가 설치한다.
 *
 * 그래서 **`.dmg` 를 받은 사람의 기본 상태가 "없다"** 이다. 예외가 아니라 기본이다.
 * 그런데 없을 때 화면이 이랬다:
 *
 * | 자리 | 앞 판본 |
 * |---|---|
 * | 사유 문구 | *"`claude` 를 찾을 수 없다 — 설치하고 PATH 에 있는지 확인하라"* — **어디서 받는지 없음** |
 * | 채널 안 | **아무것도 안 뜸** — `ChannelPane` 이 `failed` 만 봤다 |
 * | 에이전트 격자 | **멀쩡한 얼굴** — `faceState` 가 `needs_harness` 를 안 봤다 |
 * | `node` 부재 | `daemon 을 띄우지 못했다: No such file or directory` — **파일은 있는데** |
 *
 * ## 이 파일이 재는 것 — `#478`·`#473` **위에 얹는다**
 *
 * `#478` 이 exit 78 의 두 사유를 갈랐고 `#473` 이 하네스 이름을 문구에 넣었다.
 * **그 경로를 다시 만들지 않는다** — 같은 `runnerExitReason`·`harnessBinaryName` 을 쓰고,
 * 이 이슈가 더하는 것은 **"어떻게"** 한 겹뿐이다.
 *
 * 문자열을 손으로 적어 대조하지 않는 규율도 `runnerHarnessMissing.test.tsx` 와 같다 —
 * 구분자도 실행 파일 이름도 설치 안내도 전부 `@murmur/shared` 에서 가져온다.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  CREDENTIAL_REJECTED_LINE,
  EX_CONFIG,
  EXECUTABLE_NOT_FOUND_LINE,
  harnessBinaryName,
  installHint,
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
import { fakeDaemon } from './helpers/fakeDaemon';
import { RunnerStatusLine } from '../src/components/RunnerStatus';

afterEach(cleanup);

const DEVICE = 'ab12cd34';

const agent = (id: string, extra: Partial<LaunchableAgent> = {}): LaunchableAgent => ({
  id, handle: id, ownerAccountId: 'me', disabled: false, stopRequestedAt: null,
  harness: 'claude-code', ...extra,
});

function fakeSecrets(): RunnerSecretStore {
  const map = new Map<string, StoredRunnerPat>();
  return {
    read: vi.fn(async (agentId: string) => ({ ok: true as const, value: map.get(agentId) ?? null })),
    write: vi.fn(async (agentId: string, value: StoredRunnerPat) => { map.set(agentId, value); }),
    clear: vi.fn(async (agentId: string) => { map.delete(agentId); }),
    deviceId: vi.fn(async () => DEVICE),
  };
}

function fakeSpawner() {
  const spawns: SpawnRequest[] = [];
  return {
    spawns,
    spawn: vi.fn(async (req: SpawnRequest): Promise<RunnerProcess> => {
      spawns.push(req);
      return { kill: async () => undefined };
    }),
    exit(code: number | null, tailLines?: string[]) { spawns.at(-1)!.onExit(code, tailLines); },
  } satisfies RunnerSpawner & Record<string, unknown>;
}

const fakeApi = () => ({
  baseUrl: 'https://murmur.example',
  listPats: vi.fn(async () => [] as { label: string; revokedAt: string | null }[]),
  mintPat: vi.fn(async (_id: string, label: string) => `murp_${label}`),
  revokePat: vi.fn(async () => ({ revoked: 1 })),
});

const loginPath: LoginPathReader = { read: async () => '/login/bin' };

async function 띄운다(a: LaunchableAgent) {
  const spawner = fakeSpawner();
  const launcher = new RunnerLauncher(fakeApi(), fakeSecrets(), spawner, loginPath, () => 0, fakeDaemon());
  await launcher.startAll({ agents: [a], myAccountId: 'me', liveAccountIds: new Set<string>() });
  return { launcher, spawner };
}

/** 러너가 하네스를 못 찾아 물러날 때의 꼬리(`runnerExitPlan` 의 모양). */
const 하네스부재꼬리 = [
  'harness 실행 파일을 찾을 수 없다. 러너를 멈춘다.',
  '  실행 파일: claude',
  EXECUTABLE_NOT_FOUND_LINE,
];

const 자격증명거부꼬리 = [
  'Murmur 자격증명을 해결할 수 없다. 러너를 멈춘다.',
  CREDENTIAL_REJECTED_LINE,
];

describe('회귀선 — 무엇을 어떻게 설치하는지 말한다 (#476)', () => {
  /**
   * **"설치하세요"는 답이 아니다.** `#473` 이 이름을 넣어 *무엇이* 없는지는 답했지만
   * 사람은 그 이름을 들고 검색을 해야 했고, 검색 결과가 맞는 것인지도 스스로 판단해야
   * 했다. 동봉하지 않기로 한 이상 **어디서 받는지 알려 주는 것이 앱이 할 수 있는 전부**다.
   *
   * **되돌려 RED**: `exitStateFor78` 의 `installHint(binary)` 를 지우면(= `#473` 판본의
   * 문구 그대로) 주소가 사라져 빨개진다. 실제로 되돌려 실행해 확인했다.
   */
  it('하네스마다 다른 설치처를 말한다', async () => {
    for (const harness of ['claude-code', 'codex'] as const) {
      const binary = harnessBinaryName(harness)!;
      const hint = installHint(binary)!;
      const { launcher, spawner } = await 띄운다(agent('a', { harness }));
      spawner.exit(EX_CONFIG, 하네스부재꼬리);

      const message = launcher.getStates()[0]!.message ?? '';
      // `#473` 이 넣은 것은 그대로 있다 — 얹는 것이지 갈아치우는 것이 아니다.
      expect(message).toContain(binary);
      expect(message).toContain('PATH');
      // 그리고 **어떻게** 가 붙었다.
      expect(message).toContain(hint);
      expect(message).toMatch(/https:\/\//);
      cleanup();
    }
  });

  /**
   * **대조군 ① — 하네스마다 문구가 다르다.**
   *
   * 없으면 위 회귀선은 "아무 주소나 하나 박아 두는" 구현으로도 통과한다. 그러면
   * `codex` 사용자는 Claude Code 를 설치하러 간다 — `#473` 이 고친 것과 같은 종류의 오답이다.
   */
  it('대조군 — claude 와 codex 의 설치처가 서로 다르다', () => {
    expect(installHint('claude')).not.toBe(installHint('codex'));
    expect(installHint('claude')).toContain('claude.com');
    expect(installHint('codex')).toContain('openai.com');
    // `node` 도 **같은 자리에서 같은 방식으로** 안내한다 — 특별 대우하지 않는다.
    expect(installHint('node')).toContain('nodejs.org');
  });

  /**
   * **대조군 ② — 모르는 것의 설치처를 지어내지 않는다.**
   *
   * `#368` 의 규율이다. 모르는 하네스에 아무 주소나 붙이면 사람은 앱이 시킨 대로 했는데
   * 안 되는 상태에 놓인다.
   */
  it('대조군 — 모르는 실행 파일이면 주소를 지어내지 않는다', async () => {
    expect(installHint('gemini')).toBeNull();
    expect(installHint(undefined)).toBeNull();

    const { launcher, spawner } = await 띄운다(agent('a', { harness: 'gemini' }));
    spawner.exit(EX_CONFIG, 하네스부재꼬리);

    const message = launcher.getStates()[0]!.message ?? '';
    expect(message).not.toMatch(/https:\/\//);
    expect(message).not.toContain('claude.com');
    // 그래도 상태와 방향은 말한다 — 아는 것은 말한다.
    expect(launcher.getStates()[0]!.status).toBe('needs_harness');
  });

  /**
   * **대조군 ③ — 다른 사유는 다른 문구다.**
   *
   * 78 을 두 사유가 공유하므로, 설치 안내가 자격증명 쪽으로 새면 사람은 PAT 를 재발급할
   * 자리에서 Node 를 설치하러 간다. `#473` 이 고친 결함의 정확한 거울상이다.
   */
  it('대조군 — 자격증명 거부에는 설치 안내가 붙지 않는다', async () => {
    const { launcher, spawner } = await 띄운다(agent('a'));
    spawner.exit(EX_CONFIG, 자격증명거부꼬리);

    const state = launcher.getStates()[0]!;
    expect(state.status).toBe('needs_reissue');
    expect(state.message).toContain('재발급');
    expect(state.message).not.toMatch(/https:\/\//);
    expect(state.message).not.toContain('설치');
  });
});

describe('화면 — 설치 안내가 사람이 보는 자리에 닿는다 (#476)', () => {
  it('상태 줄이 설치 주소를 글자로 펼친다', async () => {
    const { launcher, spawner } = await 띄운다(agent('a'));
    spawner.exit(EX_CONFIG, 하네스부재꼬리);
    const state = launcher.getStates()[0]!;

    render(<RunnerStatusLine state={state} />);

    const text = document.body.textContent ?? '';
    expect(text).toContain(installHint(harnessBinaryName('claude-code')!)!);
    // 사유는 **보이는 자리**에 있어야 한다 — `title` 툴팁에만 있으면 아무도 안 읽는다(`#368`).
    expect(screen.getByRole('status')).toBeTruthy();
  });
});
