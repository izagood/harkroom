/**
 * `#443` 회귀선 — **에이전트 상세에 daemon 이 직접 확인한 사실이 붙는다**
 * (정본 문서 `docs/desktop-agent-cards.html` 3단계).
 *
 * ## 이 파일이 지키는 것은 문구가 아니라 **경로**다
 *
 * 문서는 *"데이터는 이미 온다"* 고 적었는데 실측은 달랐다(2026-09-08):
 *
 * | 구간 | 무엇이 흐르나 |
 * |---|---|
 * | daemon → Rust | **전부.** `main.rs::daemon_list_runners` 가 `runners` 를 그대로 통과 |
 * | Rust → TS | **여기서 잘렸다** — 파싱 루프가 세 필드만 뽑았다 |
 * | TS → 화면 | 잘린 것만 |
 *
 * `pid`·`incarnationId`·`startedAtMs`·`termSentAtMs` 는 TS 로 넘어오는 순간 버려졌고,
 * 저장소에서 `RunnerInfo` 를 import 하는 desktop 파일은 하나도 없었다. 그래서 이것은
 * "상세 화면 작업"이 아니라 **경로를 새로 내는 작업**이었고, 이 파일은 그 경로의 네
 * 구간(파싱 · 스토어 · 판정 · 렌더)을 각각 잡는다.
 *
 * ## 두 축이 특히 중요하다 (RED 로 확인한 것)
 *
 * 1. **옛 daemon(필드 없음)에서 그 행이 안 그려진다** — 규칙 06. `0` 이나 `-` 로 꾸미면
 *    사람은 그것을 진짜 pid 로 읽는다.
 * 2. **두 종료 요청 경로가 합성된다** — 서버의 `stopRequestedAt` 과 daemon 의
 *    `termSentAtMs` 는 각자 **자기 쪽 행위만** 기록하므로, 주어를 안 붙이면
 *    `종료 요청함 / alive · 시그널 안 보냄` 이 모순처럼 읽힌다
 *    (`daemonProtocol.ts::RunnerInfo.termSentAtMs`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AgentConfig, AgentDefaults, AgentView, PatView } from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { daemonFactRows as rawDaemonFactRows, elapsedLabel as rawElapsedLabel } from '../src/lib/daemonFacts';
import { tauriDaemonObserver, type ObservedRunner } from '../src/lib/runnerLauncher';
import { translator } from '../src/i18n';
import { acc } from './helpers/fakeApi';

/**
 * 언어를 **인자로** 넘기는 껍데기(`#619` 의 `(b)` 주입). 전역 언어를 안 만지므로 이 파일이
 * 병렬로 도는 다른 파일의 언어를 밟지 않는다.
 *
 * 아래 시험들이 **한국어 문구를 그대로** 재는 것이 중요하다: 시간 표기가 `Intl` 로 옮겨
 * 갔는데도 이 화면의 문구가 한 글자도 안 바뀌었다는 것이 그 이전의 근거였고, 그 근거가
 * 참인 동안만 이 시험들이 초록이다.
 */
const ko = translator('ko');
const en = translator('en');
const daemonFactRows = (
  runner: ObservedRunner | undefined,
  server: { requestedAtMs: number | null; ackedAtMs: number | null },
  now: number = Date.now(),
) => rawDaemonFactRows(runner, server, now, 'ko', ko);
const elapsedLabel = (fromMs: number, now: number) => rawElapsedLabel(fromMs, now, 'ko', ko);

const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: 'u1', disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
});

const fakeController = (agents: AgentView[]) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => agents),
    listPats: vi.fn(async (): Promise<PatView[]> => []),
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null }
    )),
    agentMemory: vi.fn(async (): Promise<{ slug: string; value: string; updatedAt: string }[]> => []),
    updateAgent: vi.fn(async (_id: string, _patch: Partial<AgentConfig>) => agents[0]!),
  };
  setController(c as unknown as Controller);
  return c;
};

/** daemon 이 **모든** 필드를 보내는 경우. 목업의 여섯 행이 이 관측에서 나온다. */
const fullRunner = (agentId: string, extra: Partial<ObservedRunner> = {}): ObservedRunner => ({
  agentId, alive: true, adopted: false,
  pid: 48127, incarnationId: '3',
  startedAtMs: new Date(2026, 8, 7, 16, 5).getTime(),
  termSentAtMs: null,
  ...extra,
});

/**
 * 상세를 열고 daemon 사실 구획을 돌려준다. `null` 이면 구획이 **아예 없다** — 규칙 06 의
 * 축이라 `queryByTestId` 로 없음을 잴 수 있어야 한다.
 */
async function openDetail(a: AgentView, daemonRunners: Record<string, ObservedRunner>) {
  fakeController([a]);
  useAppStore.getState().set({
    me: acc('u1', 'admin', 'human', true),
    accounts: { u1: acc('u1', 'admin', 'human', true), [a.id]: acc(a.id, a.handle, 'agent') },
    connected: true,
    daemonRunners,
  });
  render(<AgentsSettings />);
  fireEvent.click(await screen.findByTestId(`agent-card-${a.handle}`));
  // 상세가 뜬 것 자체는 러너 절의 존재로 확인한다 — 구획이 없는 경우와 상세가 아직 안
  // 뜬 경우를 가르지 못하면 규칙 06 단언이 거짓 초록이 된다.
  await screen.findByText('러너 (이 앱)');
  return screen.queryByTestId('daemon-facts');
}

/** 그 행의 값 글자. 행 자체가 없으면 `null` — 그것이 규칙 06 의 단언 대상이다. */
const factValue = (key: string): string | null =>
  document.querySelector(`[data-fact-value="${key}"]`)?.textContent ?? null;

beforeEach(() => { useAppStore.getState().reset(); });
afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// 1구간: 파싱 — 필드가 TS 로 **넘어온다**
// ---------------------------------------------------------------------------

describe('파싱 — daemon 이 보낸 필드가 버려지지 않는다', () => {
  /** Tauri invoke 표면을 세운다. 파싱 루프가 이것의 응답을 읽는다. */
  const withInvoke = (response: unknown) => {
    const invoke = vi.fn(async () => response);
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };
    return invoke;
  };

  afterEach(() => { delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; });

  it('pid · 세대 · 가동시각 · 종료시각이 관측에 실려 온다', async () => {
    // 이 결함의 재현 그대로다: daemon 은 여섯 필드를 보내는데 파싱 루프가 셋만 뽑았다.
    withInvoke({
      daemonPid: 4242, attached: true,
      runners: [{
        agentId: 'forge', alive: true, adopted: false,
        pid: 48127, incarnationId: '3', startedAtMs: 1_757_260_000_000, termSentAtMs: null,
      }],
    });

    const observed = (await tauriDaemonObserver.observe()).runners[0]!;

    expect(observed.pid).toBe(48127);
    expect(observed.incarnationId).toBe('3');
    expect(observed.startedAtMs).toBe(1_757_260_000_000);
    // daemon 이 **말한** `null` 이다("내가 안 보냈다"). 결측(`undefined`)으로 접으면
    // 상세가 '시그널' 행을 못 그린다.
    expect(observed.termSentAtMs).toBeNull();
    expect('termSentAtMs' in observed).toBe(true);
  });

  it('옛 daemon 이 안 보낸 필드는 **키가 아예 없다** — 0 으로 꾸미지 않는다', async () => {
    // 파싱 루프 주석이 이미 다루는 사정이다: *"옛 daemon 은 이 필드를 안 보낼 수 있다."*
    withInvoke({
      daemonPid: 4242, attached: true,
      runners: [{ agentId: 'forge', alive: true, adopted: false }],
    });

    const observed = (await tauriDaemonObserver.observe()).runners[0]!;

    // `toBeUndefined` 만으로는 부족하다 — 키가 `undefined` 로 **있으면** 그것을 순회하는
    // 다음 사람이 `'pid' in r` 로 판정하다 틀린다.
    expect('pid' in observed).toBe(false);
    expect('incarnationId' in observed).toBe(false);
    expect('startedAtMs' in observed).toBe(false);
    expect('termSentAtMs' in observed).toBe(false);
    // 판정에 쓰이는 `alive` 는 반대다 — 기본값을 갖는다(`ObservedRunner` 주석).
    expect(observed.alive).toBe(true);
  });

  it('형이 다른 값은 담지 않는다 — 지어내지 않는다(`#368`)', async () => {
    withInvoke({
      daemonPid: 4242, attached: true,
      runners: [{ agentId: 'forge', alive: true, adopted: false, pid: '48127', startedAtMs: 'nope' }],
    });

    const observed = (await tauriDaemonObserver.observe()).runners[0]!;

    expect('pid' in observed).toBe(false);
    expect('startedAtMs' in observed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2구간: 판정 — 무엇을 적고 무엇을 적지 않는가
// ---------------------------------------------------------------------------

describe('판정 — 규칙 06: 없는 것을 그리지 않는다', () => {
  const noStop = { requestedAtMs: null, ackedAtMs: null };

  it('daemon 이 이 에이전트를 모르면 행이 하나도 없다', () => {
    expect(daemonFactRows(undefined, noStop)).toEqual([]);
  });

  it('옛 daemon 이면 pid · 가동 행이 서지 않는다 — 생사만 남는다', () => {
    const rows = daemonFactRows({ agentId: 'forge', alive: true, adopted: false }, noStop);
    const keys = rows.map((r) => r.key);

    expect(keys).not.toContain('pid');
    expect(keys).not.toContain('uptime');
    // '시그널' 행도 없다 — `undefined` 는 "daemon 이 이 질문을 모른다"이고, 거기에
    // "안 보냈다"라고 적으면 모르는 것을 단정하는 것이다.
    expect(keys).not.toContain('signal');
    // '종료 요청' 행도 없다: 두 출처 중 daemon 쪽 절반을 못 봤으므로 "아무도 요청하지
    // 않았다"고 말할 수 없다.
    expect(keys).not.toContain('termination');
    // 생사는 남는다 — 이 구획의 존재 이유에 가장 가깝고, `alive` 는 옵셔널이 아니다.
    expect(keys).toEqual(['liveness']);
  });

  it('pid 만 오고 세대가 없으면 pid 만 적는다 — 빈 세대를 만들지 않는다', () => {
    const rows = daemonFactRows({ agentId: 'forge', alive: true, adopted: false, pid: 48127 }, noStop);

    expect(rows.find((r) => r.key === 'pid')!.value).toBe('48127');
  });

  it('절대 시각과 경과를 함께 적는다 — 사람이 뺄셈하게 만들지 않는다', () => {
    const started = new Date(2026, 8, 7, 16, 5).getTime();
    const rows = daemonFactRows(
      { agentId: 'forge', alive: true, adopted: false, startedAtMs: started },
      noStop,
      started + 4 * 3_600_000 + 12 * 60_000,
    );

    const uptime = rows.find((r) => r.key === 'uptime')!.value;
    expect(uptime).toContain('부터');
    expect(uptime).toContain('4시간 12분');
  });

  it('생사는 **어떻게 알았는지**를 함께 적는다 — 관측이지 판단이 아니다', () => {
    const alive = daemonFactRows({ agentId: 'f', alive: true, adopted: false }, noStop);
    const dead = daemonFactRows({ agentId: 'f', alive: false, adopted: false }, noStop);

    // `kill(pid, 0)` 이 값에 있어야 한다. 없으면 사람은 이 생사를 서버가 아는 사실로
    // 오해하고, 그 오해가 `#428` 의 "murmur 가 알 수 없다"와 정면으로 어긋난다.
    expect(alive.find((r) => r.key === 'liveness')!.value).toContain('kill(pid, 0)');
    expect(dead.find((r) => r.key === 'liveness')!.value).toContain('kill(pid, 0)');
    expect(dead.find((r) => r.key === 'liveness')!.value).toContain('dead');
  });
});

describe('판정 — 종료 요청은 **누가 했는지 함께** 적는다 (제약 1)', () => {
  /**
   * **로컬 시각으로 만든다.** 화면은 사람이 보는 시계로 적으므로(`clock()`), ISO 의 `Z`
   * 를 쓰면 이 회귀선은 UTC 머신에서만 초록이고 CI 나 다른 시간대에서 빨개진다 — 그리고
   * 그 실패는 코드의 결함이 아니다.
   */
  const REQ = new Date(2026, 8, 8, 10, 23).getTime();
  const req = (extra: Partial<{ ackedAtMs: number | null }> = {}) =>
    ({ requestedAtMs: REQ, ackedAtMs: null, ...extra });

  it('사람이 UI 로 요청하고 daemon 은 안 보냈다 — 목업의 그 조합', () => {
    // 이것이 `daemonProtocol.ts` 가 함정으로 적어 둔 상태다: 사람이 요청해 러너가
    // 물러나는 중인데 daemon 입장에서는 `termSentAtMs: null, alive: true` 다.
    const rows = daemonFactRows(fullRunner('forge'), req(), REQ + 60_000);

    const term = rows.find((r) => r.key === 'termination')!.value;
    // **주어가 붙는다.** 이것이 이 제약의 전부다 — 없으면 아래 '시그널' 행과 나란히
    // 놓였을 때 사람이 둘 중 하나를 거짓으로 읽는다.
    expect(term).toContain('사람이 UI 에서');
    expect(term).toContain('10:23');
    expect(term).toContain('러너가 아직 못 읽음');
    // 시그널 행은 daemon **자신의** 행위만 말한다. 두 행이 함께 있어야 모순이 풀린다.
    expect(rows.find((r) => r.key === 'signal')!.value).toBe('daemon 은 안 보냈다');
  });

  it('러너가 읽어 갔으면 그 시각까지 적는다(`#428`)', () => {
    const acked = REQ + 90_000;
    const rows = daemonFactRows(fullRunner('forge'), req({ ackedAtMs: acked }), acked);

    const term = rows.find((r) => r.key === 'termination')!.value;
    expect(term).toContain('사람이 UI 에서');
    expect(term).toContain('읽었다');
    expect(term).not.toContain('아직 못 읽음');
  });

  it('둘 다 요청했으면 **둘 다** 적는다 — 하나를 골라 적으면 나머지가 없는 일이 된다', () => {
    const sent = REQ + 30_000;
    const rows = daemonFactRows(
      fullRunner('forge', { termSentAtMs: sent }), req(), sent + 10_000,
    );

    const term = rows.find((r) => r.key === 'termination')!.value;
    expect(term).toContain('사람이 UI 에서');
    expect(term).toContain('daemon 이 시그널로');
  });

  it('아무도 요청하지 않았다고 **말할 수 있다** — 두 출처를 다 봤을 때만', () => {
    // daemon 이 `null` 을 말했고(= 내가 안 보냈다) 서버 쪽도 비었다. 이때만 단정한다.
    const rows = daemonFactRows(fullRunner('forge'), { requestedAtMs: null, ackedAtMs: null });

    expect(rows.find((r) => r.key === 'termination')!.value).toContain('아무도 요청하지 않았다');
  });
});

describe('판정 — 제약 2: N 의 정상 범위를 절대값으로 박지 않는다', () => {
  it('경과는 적지만 이상하다고 판정하지 않는다', () => {
    const sent = new Date(2026, 8, 8, 10, 23).getTime();
    // 롱폴링 기본 예산(25초)을 한참 넘긴 4분 12초. **이래도 판정하지 않는다** —
    // `AGENT_POLL_TIMEOUT_MS` 는 환경변수라 배포마다 다르고 daemon 은 러너 설정을 모른다
    // (`daemonProtocol.ts` `:504~506`).
    const rows = daemonFactRows(
      fullRunner('forge', { termSentAtMs: sent, alive: true }),
      { requestedAtMs: null, ackedAtMs: null },
      sent + 4 * 60_000 + 12_000,
    );

    const signal = rows.find((r) => r.key === 'signal')!.value;
    // 사실은 적는다.
    expect(signal).toContain('4분 12초');
    expect(signal).toContain('아직 살아 있다');
    // 판정은 안 한다. 이 낱말들이 들어오면 그 숫자가 어느 배포에서는 거짓이 된다.
    for (const verdict of ['이상', '비정상', '멈췄', '문제', '실패', '응답 없음', '너무']) {
      expect(signal).not.toContain(verdict);
    }
  });

  /**
   * **제약 2 가 언어를 바꿔도 지켜지는가**(`#619` 후속).
   *
   * 위 축은 한국어 판정 낱말을 잰다. 시간 표기가 `Intl` 로 옮겨 가면서 이 값의 일부가
   * **언어를 따르게 됐으므로**, 영어로 냈을 때 `Intl` 이 판정 낱말을 끼워 넣지 않는지를
   * 함께 봐야 한다 — 제약 2 는 문구의 성질에 대한 것이지 한국어에 대한 것이 아니다.
   *
   * 지금은 이 행의 나머지가 아직 한국어라(화면 이전은 다음 PR) 영어 낱말이 섞여 나오는
   * 것이 정상이다. 그래서 **경과 부분만** 떼어 재고, 다음 PR 이 이 행을 옮길 때 위 축을
   * 영어로도 돌리면 된다.
   */
  it('경과 표기 자체는 어느 언어로도 판정을 안 한다', () => {
    const cases = [42_000, 4 * 60_000 + 12_000, 4 * 3_600_000 + 12 * 60_000, 2 * 86_400_000];
    for (const ms of cases) {
      const value = rawElapsedLabel(0, ms, 'en', en);
      // 사실은 적는다 — 수를 낸다.
      expect(value).toMatch(/\d/);
      // 판정은 안 한다. `Intl.DurationFormat` 은 길이만 내지 평가를 안 붙인다.
      for (const verdict of ['abnormal', 'stuck', 'problem', 'failed', 'no response', 'too ', 'unusual']) {
        expect(value.toLowerCase()).not.toContain(verdict);
      }
    }
  });

  it('판정 함수 어디에도 임계값 상수가 없다 — 소스를 직접 본다', async () => {
    // 문구를 대조하는 것만으로는 다음 사람이 새로 넣는 임계값을 못 막는다. 그래서
    // 소스를 읽어 롱폴링 예산의 이름 자체가 없음을 단언한다.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(process.cwd(), 'src/lib/daemonFacts.ts'), 'utf-8');
    // 주석에서 근거로 **인용**하는 것은 정상이다. 금지 대상은 코드에서 그 값을 쓰는 것이므로
    // 주석을 지운 뒤 센다.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toContain('AGENT_POLL_TIMEOUT');
    // 25초·3분 같은 임계값 리터럴도 없다. 시간 단위 변환(1_000·60·24)은 남아야 하므로
    // "초 단위 임계값"에 쓰일 수를 콕 집는다.
    expect(code).not.toMatch(/25_?000|180_?000/);
  });
});

describe('경과 표기 — 음수를 지어내지 않는다', () => {
  it('시계 보정으로 음수가 나와도 "-3분"을 만들지 않는다', () => {
    // `agoLabel` 과 같은 규율이다 — 음수를 그대로 적으면 사람은 앱이 고장 났다고 읽는다.
    expect(elapsedLabel(1_000_000, 900_000)).toBe('방금');
  });

  /**
   * **문구가 그대로다.** 서식이 `Intl.DurationFormat` 으로 옮겨 갔는데(`lib/time.ts`)
   * 한국어 화면은 한 글자도 안 바뀌었다 — `Intl` 이 이 넷을 원래 문구 그대로 낸다는
   * 실측이 그 이전의 근거였고, 이 축이 그 근거를 잠근다.
   */
  it('종료 요청 뒤의 기다림은 **초까지** 읽힌다 — 롱폴링 한 바퀴가 그 단위다', () => {
    expect(elapsedLabel(0, 42_000)).toBe('42초');
    expect(elapsedLabel(0, 4 * 60_000 + 12_000)).toBe('4분 12초');
    expect(elapsedLabel(0, 4 * 3_600_000 + 12 * 60_000)).toBe('4시간 12분');
    expect(elapsedLabel(0, 2 * 86_400_000 + 5 * 3_600_000)).toBe('2일 5시간');
  });

  /** **언어를 바꾸면 길이 표기도 바뀐다** — 사전에 그 문구가 없는데도. */
  it('언어를 영어로 바꾸면 길이가 영어로 나온다', () => {
    expect(rawElapsedLabel(1_000_000, 900_000, 'en', en)).toBe('just now');
    expect(rawElapsedLabel(0, 42_000, 'en', en)).toBe('42s');
    expect(rawElapsedLabel(0, 4 * 60_000 + 12_000, 'en', en)).toBe('4m 12s');
    expect(rawElapsedLabel(0, 4 * 3_600_000 + 12 * 60_000, 'en', en)).toBe('4h 12m');
  });
});

// ---------------------------------------------------------------------------
// 3구간: 렌더 — 상세에 붙고, 카드에는 안 붙는다
// ---------------------------------------------------------------------------

describe('렌더 — 상세에 붙는다', () => {
  it('여섯 행이 상세에 선다 — 목업 그대로', async () => {
    const forge = agent('forge');
    const section = await openDetail(forge, { [forge.id]: fullRunner(forge.id) });

    expect(section).toBeTruthy();
    expect(section!.textContent).toContain('daemon 이 직접 확인한 것');
    expect(factValue('pid')).toContain('48127');
    expect(factValue('pid')).toContain('세대 3');
    expect(factValue('uptime')).toContain('부터');
    expect(factValue('liveness')).toContain('alive');
    expect(factValue('signal')).toBe('daemon 은 안 보냈다');
  });

  it('사람이 UI 에서 건 중지가 daemon 의 사실과 **합쳐져** 한 줄로 선다', async () => {
    // 서버 쪽 사실은 `AgentView` 로 오고 daemon 쪽은 스토어의 `daemonRunners` 로 온다.
    // 두 출처가 실제로 한 행에서 만나는지를 렌더까지 와서 잰다.
    // 위 `REQ` 와 같은 이유로 로컬 시각을 ISO 로 되돌려 넘긴다 — 서버는 ISO 를 주고
    // 화면은 로컬 시계로 적는다는 그 왕복 자체가 이 축의 대상이다.
    const requestedAt = new Date(2026, 8, 8, 10, 23);
    const forge = agent('forge', {
      stopRequestedAt: requestedAt.toISOString(),
      stopAckedAt: null,
    });
    await openDetail(forge, { [forge.id]: fullRunner(forge.id) });

    const term = factValue('termination')!;
    expect(term).toContain('사람이 UI 에서');
    expect(term).toContain('10:23');
    expect(term).toContain('러너가 아직 못 읽음');
    // 나란히 서는 '시그널' 행이 daemon 쪽을 말한다 — 둘이 함께 있어야 모순이 풀린다.
    expect(factValue('signal')).toBe('daemon 은 안 보냈다');
  });

  it('daemon 이 이 에이전트를 모르면 구획이 **아예 없다** — 제목만 남기지 않는다', async () => {
    const forge = agent('forge');
    // 장부가 비었다. "확인해 봤는데 아무것도 아니었다"가 아니라 "묻지 못했다"다.
    expect(await openDetail(forge, {})).toBeNull();
  });

  it('옛 daemon 에서는 pid · 가동 · 시그널 행이 안 그려진다', async () => {
    const forge = agent('forge');
    const section = await openDetail(forge, {
      [forge.id]: { agentId: forge.id, alive: true, adopted: false },
    });

    expect(section).toBeTruthy();
    expect(factValue('pid')).toBeNull();
    expect(factValue('uptime')).toBeNull();
    expect(factValue('signal')).toBeNull();
    expect(factValue('liveness')).toContain('alive');
    // **`0` 이나 `-` 로 꾸미지 않았다**를 글자로도 잡는다 — 자리표시가 들어오면 사람은
    // 그것을 진짜 pid 로 읽는다.
    expect(section!.textContent).not.toContain('48127');
    expect(section!.textContent).not.toMatch(/pid\s*[-0]/);
  });

  it('옛 daemon 이라도 서버가 아는 중지 요청은 여전히 보인다', async () => {
    // 서버 쪽 사실은 daemon 판본과 무관하게 온다. 이것까지 접으면 옛 daemon 을 쓰는
    // 사람은 자기가 누른 중지가 반영됐는지 볼 자리를 잃는다.
    const forge = agent('forge', { stopRequestedAt: new Date(2026, 8, 8, 10, 23).toISOString() });
    await openDetail(forge, {
      [forge.id]: { agentId: forge.id, alive: true, adopted: false },
    });

    expect(factValue('termination')).toContain('사람이 UI 에서');
    // 그래도 '시그널' 행은 안 선다 — daemon 이 그 질문을 모른다.
    expect(factValue('signal')).toBeNull();
  });
});

describe('렌더 — 카드에는 안 올린다', () => {
  it('격자에는 pid 가 없다 — 문서가 상세에만 두라고 했다', async () => {
    // **격자와 상세는 한 번에 하나다**(`AgentsSettings` 의 `view === 'grid'` 주석:
    // *"그리드를 보거나 상세를 보거나 — 나란히 두지 않는다"*). 그래서 이 축은 상세를
    // 열지 **않은** 채로 재야 한다 — 열고 재면 격자가 이미 언마운트돼 무엇을 재도 초록이다.
    const forge = agent('forge');
    fakeController([forge]);
    useAppStore.getState().set({
      me: acc('u1', 'admin', 'human', true),
      accounts: { u1: acc('u1', 'admin', 'human', true), [forge.id]: acc(forge.id, 'forge', 'agent') },
      connected: true,
      // daemon 은 **모든** 사실을 알고 있다. 그런데도 격자에 안 나오는 것이 이 축이다.
      daemonRunners: { [forge.id]: fullRunner(forge.id) },
    });
    render(<AgentsSettings />);

    const card = await screen.findByTestId('agent-card-forge');
    expect(card.textContent).not.toContain('48127');
    expect(card.textContent).not.toContain('kill(pid, 0)');
    // 격자 화면 **어디에도** 없다 — 카드 밖(띠·머리말)에 얹는 것도 카드에 올린 것과
    // 같은 결과다(문서: *"카드에 올릴 것은 아니지만 상세에는 있어야 한다"*).
    expect(screen.queryByTestId('daemon-facts')).toBeNull();
    expect(document.body.textContent).not.toContain('48127');
  });
});
