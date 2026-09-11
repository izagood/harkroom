import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import type { AgentConfig, AgentDefaults, AgentView, PatView } from '@harkroom/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { setController, type Controller } from '../src/state/controller';
import { AgentsSettings } from '../src/components/settings/AgentsSettings';
import { acc } from './helpers/fakeApi';
import {
  PAT_PLACEHOLDER, RUNNER_DEV_COMMAND, RUNNER_SIDECAR_PATH, runnerCommandClipboardText,
} from '../src/lib/runnerCommand';
import { runnerStatusLabel } from '../src/components/RunnerStatus';
import { translator } from '../src/i18n';

// 이 파일은 위 `beforeEach` 가 앱 언어를 `ko` 로 고정한다 — 재는 것이 언어가 아니라
// **그 언어로 표현된 규율**(#125: 화면의 명령과 클립보드의 명령이 글자 하나까지 같다)
// 이기 때문이다. 기대값을 만드는 이 번역기도 같은 언어여야 둘이 실제로 맞붙는다.
const ko = translator('ko');

const agent = (handle: string, extra: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  claudeLane: null, executionPath: null,
  stopRequestedAt: null, stopAckedAt: null,
  lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...extra,
});

type CreateInput = { handle: string; displayName: string } & Partial<AgentConfig>;
type PatchInput = Partial<AgentConfig> & { displayName?: string };

const fakeController = (agents: AgentView[] = [], pats: PatView[] = []) => {
  const c = {
    listAgents: vi.fn(async (): Promise<AgentView[]> => agents),
    createAgent: vi.fn(async (_input: CreateInput) => ({ agent: agent('fizz'), pat: 'murp_secret' })),
    updateAgent: vi.fn(async (_id: string, _patch: PatchInput) => agent('fizz')),
    listPats: vi.fn(async (): Promise<PatView[]> => pats),
    revokePat: vi.fn(async (): Promise<{ revoked: number }> => ({ revoked: 1 })),
    mintPat: vi.fn(async (): Promise<string> => 'murp_new_token_12345'),
    agentDefaults: vi.fn(async (): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null }
    )),
    updateAgentDefaults: vi.fn(async (patch: Partial<AgentDefaults>): Promise<AgentDefaults> => (
      { harness: 'claude-code', model: null, effort: null, ...patch }
    )),
    requestAgentStop: vi.fn(async (id: string): Promise<AgentView> => (
      agent('rusalka', { id, stopRequestedAt: '2026-09-03T10:00:00.000Z', stopAckedAt: null })
    )),
    agentMemory: vi.fn(async (): Promise<{ slug: string; value: string; updatedAt: string }[]> => []),
    deleteAgentMemory: vi.fn(async (): Promise<void> => undefined),
  };
  setController(c as unknown as Controller);
  return c;
};

// 발급 직후 화면과 상시 틀은 둘 다 `aria-label="명령 복사"` 버튼을 갖는다(설계상 같은 이름이다).
// 그래서 테스트는 어느 절의 버튼인지 절 제목으로 좁혀서 집는다.
const sectionOf = (heading: string | RegExp): HTMLElement => {
  const el = screen.getByText(heading).parentElement;
  if (!el) throw new Error(`절을 못 찾았다: ${String(heading)}`);
  return el;
};
const RUNNER_SECTION = '러너 실행';
const MINTED_SECTION = /이 토큰은 지금만 보인다/;

/** 상세를 열어 상시 "러너 실행" 절이 그려질 때까지 기다린다. */
const openAgent = async (handle: string) => {
  // 카드를 **테스트 id** 로 고른다 — 아바타의 sr-only 핸들과 카드 라벨이 둘 다 이름을
  // 내므로 텍스트로 고르면 모호하다(Task 15-2).
  fireEvent.click(await screen.findByTestId(`agent-card-${handle}`));
  await screen.findByText(RUNNER_SECTION);
};

let writeText: ReturnType<typeof vi.fn>;

// **언어를 한국어로 고정한다.** 이 파일의 축들은 이 화면의 한국어 문구로 쓰여 있고,
// 그 문구가 지키는 것은 언어가 아니라 **그 언어로 표현된 규율**이다(사이드바 PR 이 세운
// 방식과 같다). 영어가 원본이 되면서 기본값이 영어가 됐으므로, 한국어를 재려면 한국어라고
// 말해야 한다. 두 언어로 다 뜨는지는 `i18n.test.tsx` 가 잰다.
beforeEach(() => {
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin', 'human', true) });
  usePrefsStore.getState().setLocale('ko');
  writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('러너 실행 명령 (#177)', () => {
  it('1. 기존 에이전트를 열면(PAT 발급 없이) 명령 틀이 보인다', async () => {
    fakeController([agent('test-agent')], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);
    await openAgent('test-agent');

    expect(screen.getByText(/MURMUR_PAT=<발급한 토큰>/)).toBeTruthy();
  });

  it('1b. PAT 가 0 개인 에이전트에서도 틀은 보인다 — 발급 직후만이 아니다', async () => {
    fakeController([agent('test-agent')], []);
    render(<AgentsSettings />);
    await openAgent('test-agent');

    expect(screen.getByText(/MURMUR_PAT=<발급한 토큰>/)).toBeTruthy();
  });

  it('2. 틀에는 토큰이 없고 자리표시 문구가 있다', async () => {
    fakeController([agent('test-agent')], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);
    await openAgent('test-agent');

    const commandText = screen.getByText(/MURMUR_PAT=<발급한 토큰>/).textContent ?? '';
    expect(commandText).toContain('<발급한 토큰>');
    expect(commandText).not.toContain('murp_');
  });

  it('3. 복사 버튼이 clipboard.writeText 를 명령 전체로 호출한다 — 잘리지 않는다(#125)', async () => {
    fakeController([agent('test-agent')], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);
    await openAgent('test-agent');

    fireEvent.click(within(sectionOf(RUNNER_SECTION)).getByRole('button', { name: '명령 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    // 명령 전체다: 앞의 환경변수 지정부터 뒤의 `start` 까지. 말줄임표가 있으면 잘린 것이다.
    const copied = String(writeText.mock.calls[0]?.[0]);
    expect(copied).toBe(runnerCommandClipboardText(PAT_PLACEHOLDER, ko));
    expect(copied).not.toContain('…');
    expect(copied).not.toContain('...');
  });

  it('4. 발급 직후 화면에서는 전체 토큰이 든 명령이 복사된다', async () => {
    fakeController([], []);
    render(<AgentsSettings />);
    // Task 15: 그리드가 먼저 뜬다 — 새 에이전트 폼은 `+` 를 눌러야 열린다.
    fireEvent.click(await screen.findByTestId('agent-create'));

    fireEvent.change(await screen.findByLabelText('Agent name'), { target: { value: 'newagent' } });
    fireEvent.click(screen.getByRole('button', { name: '에이전트 만들기' }));
    await screen.findByText(MINTED_SECTION);

    fireEvent.click(within(sectionOf(MINTED_SECTION)).getByRole('button', { name: '명령 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    // 토큰이 통째로 실린다 — 접두사만 맞는지가 아니라 정확히 같은지를 본다.
    expect(String(writeText.mock.calls[0]?.[0])).toBe(runnerCommandClipboardText('murp_secret', ko));
    // 버튼 문구가 잠깐 "복사됨"으로 바뀐다.
    await screen.findByText('복사됨');
  });

  it('4b. 발급 직후가 아닌 화면에서는 어떤 버튼도 전체 토큰을 클립보드에 넣지 못한다', async () => {
    fakeController([agent('test-agent')], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);
    await openAgent('test-agent');

    // 발급 직후 절 자체가 없다 — 전체 토큰이 든 명령도, 그것을 복사할 버튼도 없다.
    expect(screen.queryByText(MINTED_SECTION)).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('murp_');
    // 이 화면의 복사 버튼은 하나뿐이고, 그것은 자리표시 틀을 복사한다.
    const copyButtons = screen.getAllByRole('button', { name: '명령 복사' });
    expect(copyButtons).toHaveLength(1);
    fireEvent.click(within(sectionOf(RUNNER_SECTION)).getByRole('button', { name: '명령 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]?.[0])).not.toContain('murp_');
  });

  it('5. clipboard 가 없으면 텍스트가 선택되고 오류가 화면에 보인다 — 조용히 실패하지 않는다', async () => {
    Reflect.deleteProperty(navigator, 'clipboard');
    fakeController([agent('test-agent')], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);
    await openAgent('test-agent');

    const command = screen.getByText(/MURMUR_PAT=<발급한 토큰>/);
    fireEvent.click(within(sectionOf(RUNNER_SECTION)).getByRole('button', { name: '명령 복사' }));

    // 오류가 보이는 자리에 있다 — `sr-only` 나 콘솔이 아니라 사람이 읽는 텍스트다.
    const alert = await screen.findByRole('alert');
    expect(alert.textContent ?? '').toContain('⌘C');
    expect(alert.className).not.toContain('sr-only');
    // "복사됨" 을 거짓으로 띄우지 않는다.
    expect(screen.queryByText('복사됨')).toBeNull();
    // 그리고 화면의 그 명령 텍스트가 실제로 선택 상태다.
    const selection = window.getSelection();
    expect(selection?.rangeCount).toBe(1);
    expect(command.contains(selection!.getRangeAt(0).startContainer)).toBe(true);
    expect(selection?.toString()).toContain('MURMUR_PAT');
  });
});

/**
 * 낡은 문구 회귀선 — **화면이 없는 것을 안내하지 않는다.**
 *
 * 이 네 줄이 막는 것은 각각 다르다:
 *
 * - ①② 는 **사라진 것**을 단언한다(사이드카 배포에서 안 도는 명령, 없어진 상태 이름).
 * - ③ 은 **두 자리가 갈리는 것**을 막는다 — 이 결함의 원인이 그 갈라짐이었다.
 * - ④ 는 **대조군**이다. ①②만 있으면 "그 절을 통째로 지웠다"로도 초록이 된다.
 */
describe('낡은 문구 회귀선 (#431 1단계 사이드카 배포 · #482 adopted)', () => {
  const openBoth = async () => {
    fakeController([agent('test-agent')], [{ label: 'runner', createdAt: '2026-01-01', revokedAt: null }]);
    render(<AgentsSettings />);
    await openAgent('test-agent');
  };

  it('① `pnpm --filter @harkroom/agent start` 를 단독 명령으로 내밀지 않는다', async () => {
    await openBoth();
    const body = document.body.textContent ?? '';
    // 개발용 갈래로는 남아 있어도 된다 — 저장소 안에서는 지금도 도는 명령이다.
    // 막는 것은 **조건 없이 그것 하나만** 내미는 것이다: 그러면 저장소가 없는 사람이
    // 붙여넣는 순간 실패한다. 그래서 dev 명령이 보이면 사이드카 갈래도 **반드시** 있어야 한다.
    if (body.includes(RUNNER_DEV_COMMAND)) {
      expect(body).toContain(RUNNER_SIDECAR_PATH);
    }
    // 클립보드에 들어가는 값도 같은 계약이다 — 사람이 실제로 붙여넣는 것은 이쪽이다.
    fireEvent.click(within(sectionOf(RUNNER_SECTION)).getByRole('button', { name: '명령 복사' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(String(writeText.mock.calls[0]?.[0])).toContain(RUNNER_SIDECAR_PATH);
  });

  it('② 화면에 사라진 상태 이름 `외부에서 실행 중` 이 없다', async () => {
    await openBoth();
    // `#482` 가 `external` 을 없앴다. 그 이름이 화면에 남아 있으면 사람은 존재하지 않는
    // 상태를 기다린다 — 그것이 `#430` 이 기록한 오독이다.
    expect(document.body.textContent ?? '').not.toContain('외부에서 실행 중');
  });

  it('③ 설명의 상태 문구가 `RunnerStatus.tsx` 와 같은 출처에서 나온다', async () => {
    await openBoth();
    // 이 파일이 `runnerStatusLabel` 을 불러 기대값을 만든다 — 그래서 `RunnerStatus.tsx` 가
    // 다음에 개명되면 **설명도 따라오거나, 안 따라오면 여기서 빨개진다.**
    const adopted = runnerStatusLabel({
      agentId: '', status: 'adopted', exitCode: null, message: null,
    }, ko);
    expect(document.body.textContent ?? '').toContain(adopted);
  });

  it('④ 대조군 — 지금도 유효한 안내는 그대로 남아 있다', async () => {
    await openBoth();
    const body = document.body.textContent ?? '';
    // 절 자체가 산다. 손으로 띄우는 길이 여전히 있으므로(앱은 내가 소유한 것만 띄운다)
    // "통째로 지웠다"는 이 이슈의 답이 아니다.
    expect(screen.getByText(RUNNER_SECTION)).toBeTruthy();
    // 그리고 그 안에 **실행 가능한 명령**이 있다: PAT 자리표시 + 사이드카 절대 경로.
    expect(body).toContain(PAT_PLACEHOLDER);
    expect(body).toContain(RUNNER_SIDECAR_PATH);
    // 러너 상태 절도 산다 — 상태를 읽는 자리가 없으면 ②는 "그 절을 지웠다"로도 통과한다.
    expect(screen.getByText('러너 (이 앱)')).toBeTruthy();
    // daemon 이 자기가 띄운 것만 안다는 한계 고백이 남아 있다(옛 "누가 띄웠든"의 자리).
    expect(body).toContain('자기가 띄운 러너만');
    expect(body).not.toContain('누가 띄웠든');
  });
});
