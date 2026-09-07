/**
 * **에이전트 패널 = 얼굴 그리드** — 정본 문서 `docs/desktop-rail.html` 3단계.
 *
 * 문서: *"에이전트는 대화가 아니라 인력이다. 그래서 목록이 아니라 얼굴 그리드 — 설정 ›
 * 에이전트와 같은 카드 컴포넌트를 쓴다. 아직 DM 이 없는 에이전트도 여기서는 자리를 갖고,
 * 멈춘 것은 ▶ 로 여기서 바로 켠다. 지금은 DM 이 있는 쪽만 상태가 보이고 없는 쪽은 아무
 * 표시도 못 받는데, 그 비대칭이 사라진다."*
 *
 * 3단계 항목: *"에이전트 패널 = 설정의 그리드 재사용. 설정 › 에이전트 재설계가 먼저 들어가야
 * 카드 컴포넌트를 두 번 그리지 않는다."*
 *
 * ## 문서의 진단을 코드로 확인한 결과 (실측 2026-09-07, 이 브랜치의 `origin/main`)
 *
 * | 문서가 적은 것 | 코드 | 판정 |
 * |---|---|---|
 * | 목록이지 그리드가 아니다 | `panel === 'agents'` 가 `row()` 버튼을 세로로 쌓았다 | **맞다** |
 * | 아직 DM 이 없는 에이전트가 자리를 못 갖는다 | **거꾸로였다** — `dmAgentIds` 필터가 DM 이 **있는** 쪽을 뺐다 | **어긋난다(아래)** |
 * | 없는 쪽은 아무 표시도 못 받는다 | `RunnerStatusDot` 이 `state` 가 없으면 `null` 을 낸다 | **맞다** |
 *
 * 어긋난 항목의 실체는 **자리의 유무가 아니라 표현의 비대칭**이다. 2단계(#528)가 DM 목록을
 * 합치면서 에이전트를 DM 칸의 제1시민으로 만들었고(아바타 얼굴 + `faceState`), 그때 이 칸에는
 * DM 이 **없는** 쪽만 남겼다 — 네모난 러너 점 하나로. 그래서 같은 워크스페이스의 에이전트가
 * 두 칸에서 서로 다른 어휘로 그려졌고, 러너를 아직 한 번도 띄우지 않은(=`runnerStates` 가
 * 빈) 에이전트는 그 점조차 받지 못했다. **이번에 사라지는 것이 그 비대칭이다.**
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import type { AppState } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { Sidebar } from '../src/components/Sidebar';
import { AgentGrid } from '../src/components/settings/AgentGrid';
import { acc, chan } from './helpers/fakeApi';
import type { RunnerState } from '../src/lib/runnerLauncher';
import type { AgentView, DmView } from '@murmur/shared';

const fakeController = () => {
  const c = {
    openChannel: vi.fn(async () => undefined),
    startDm: vi.fn(async () => undefined),
    reissueRunnerPat: vi.fn(async () => undefined),
    logout: vi.fn(), createChannel: vi.fn(), updateChannel: vi.fn(),
    setChannelNotifyLevel: vi.fn(), toggleChannelStar: vi.fn(), setStatus: vi.fn(),
  };
  setController(c as unknown as Controller);
  return c;
};

const renderAgentsPanel = () =>
  render(
    <Sidebar panel="agents" onOpenDirectory={() => {}} onOpenChannelDirectory={() => {}}
      onOpenInbox={() => {}} collapsed={false} onToggleCollapse={vi.fn()} />,
  );

const dm = (id: string, peerId: string): DmView =>
  ({ id, memberIds: ['me', peerId], lastMessageAt: '2026-09-05T00:00:00.000Z' });

const runner = (
  agentId: string, status: RunnerState['status'], extra: Partial<RunnerState> = {},
): RunnerState => ({ agentId, status, exitCode: null, message: null, ...extra });

/**
 * 사람 하나 · 에이전트 둘. **한쪽은 DM 이 있고 한쪽은 없다** — 문서가 지적한 비대칭을
 * 재려면 두 조건이 한 화면에 함께 있어야 한다.
 */
const 두에이전트 = (over: Partial<AppState> = {}): Partial<AppState> => ({
  me: { ...acc('me', 'jaebin'), isAdmin: true },
  accounts: {
    me: { ...acc('me', 'jaebin'), isAdmin: true },
    forge: acc('forge', 'forge', 'agent'),
    codex: acc('codex', 'codex', 'agent'),
  },
  channels: [chan('c1', 'general')],
  // forge 에게만 DM 이 있다.
  dms: [dm('d-forge', 'forge')],
  online: [] as string[],
  connected: true,
  activeChannelId: 'c1',
  runnerStates: {} as Record<string, RunnerState>,
  ...over,
});

beforeEach(() => { useAppStore.getState().reset(); });
afterEach(() => { cleanup(); });

// ---------------------------------------------------------------------------

describe('비대칭이 사라진다 (docs/desktop-rail.html 3단계)', () => {
  /**
   * **이 파일의 중심 회귀선이다.**
   *
   * 되돌려 RED: `Sidebar` 의 에이전트 칸에서 `dmAgentIds` 필터를 되살리면(`!dmAgentIds.has(a.id)`)
   * `agent-card-forge` 가 사라져 빨개진다.
   */
  it('DM 이 있든 없든 모든 에이전트가 자리를 갖는다', () => {
    fakeController();
    useAppStore.getState().set(두에이전트());
    renderAgentsPanel();

    // DM 이 있는 쪽(forge)도, 없는 쪽(codex)도 카드를 받는다.
    expect(screen.getByTestId('agent-card-forge')).toBeTruthy();
    expect(screen.getByTestId('agent-card-codex')).toBeTruthy();
  });

  /**
   * **표현이 한 어휘로 모인다.** 앞 판본은 이 칸에서만 네모난 러너 점(`runner-{id}`)을
   * 썼고 DM 칸에서는 아바타 얼굴을 썼다 — 같은 사실을 두 어휘로 그린 것이고, B1 이
   * 없애려던 "같은 사실이 화면마다 네 가지로 그려진다"가 정확히 그 모양이다.
   *
   * 되돌려 RED: 옛 목록(`RunnerStatusDot` + `@handle` 행)으로 되돌리면 `data-face` 를
   * 가진 카드가 없어 빨개진다.
   */
  it('상태는 아바타가 말한다 — 네모난 러너 점이 이 칸에서 사라졌다', () => {
    fakeController();
    useAppStore.getState().set(두에이전트({
      runnerStates: { codex: runner('codex', 'running') },
    }));
    renderAgentsPanel();

    expect(screen.getByTestId('agent-card-codex').dataset.face).toBe('ok');
    // 이 칸의 어휘는 격자의 얼굴 하나다 — 점을 나란히 두면 어느 쪽을 믿을지 사람이 고른다.
    expect(document.querySelector('[data-testid^="runner-"]')).toBeNull();
  });

  /**
   * **러너를 한 번도 안 띄운 에이전트도 표시를 받는다.** 문서가 *"없는 쪽은 아무 표시도
   * 못 받는다"* 고 적은 그 자리다 — `RunnerStatusDot` 은 `state` 가 없으면 `null` 을 냈다.
   * `faceState` 는 그 경우에도 답을 낸다: 붙어 있으면 `ok`, 아니면 `stopped`.
   */
  it('러너 상태가 아예 없어도 얼굴이 답을 낸다 — 빈 칸이 아니다', () => {
    fakeController();
    useAppStore.getState().set(두에이전트({ runnerStates: {}, online: ['forge'] }));
    renderAgentsPanel();

    expect(screen.getByTestId('agent-card-forge').dataset.face).toBe('ok');
    expect(screen.getByTestId('agent-card-codex').dataset.face).toBe('stopped');
  });

  /**
   * **`runner-reason-{id}` 충돌이 실제로 없다.** 앞 판본 주석이 이 위험을 적어 뒀다:
   * *"필터를 떼면 같은 testid 가 둘이 되어 시험의 `getByTestId` 가 깨진다."*
   *
   * 필터를 떼면서 그 이름을 이 칸에서 **쓰지 않는 것**으로 푼다 — 격자는 사유를
   * `agent-runner-failed-{id}` 로 내고, 그 이름은 `dmRow` 와 겹치지 않는다. 두 칸은
   * 애초에 동시에 그려지지 않지만(한 번에 한 패널), 이름이 겹치면 두 칸을 한 시험에서
   * 구별할 수 없게 된다.
   */
  it('실패 사유는 격자의 이름으로 온다 — DM 줄의 이름과 겹치지 않는다', () => {
    fakeController();
    useAppStore.getState().set(두에이전트({
      runnerStates: { forge: runner('forge', 'failed', { exitCode: 1, message: '노드를 못 찾았다' }) },
    }));
    renderAgentsPanel();

    expect(screen.getByTestId('agent-runner-failed-forge').textContent).toContain('노드를 못 찾았다');
    expect(screen.queryByTestId('runner-reason-forge')).toBeNull();
  });
});

describe('세 콜백이 이 자리에서 뜻하는 것', () => {
  /**
   * **카드를 누르면 DM 이 열린다.** 설정에서는 상세(설정 폼)를 열지만 여기서는 아니다 —
   * 옛 목록이 이미 `startDm` 이었고(자리만 바뀌었다), 문서가 이 칸을 *"인력"* 이라 적었다.
   * 사람을 눌러 말을 거는 것이 이 앱에서 대화의 기본 동작이고, 설정으로 보내면 레일에서
   * 한 번 더 누른 대가가 "설정 화면으로 튀어나가는 것"이 된다.
   */
  it('카드를 누르면 DM 이 열린다 — 설정이 아니다', () => {
    const c = fakeController();
    useAppStore.getState().set(두에이전트());
    renderAgentsPanel();

    fireEvent.click(screen.getByTestId('agent-card-codex'));
    expect(c.startDm).toHaveBeenCalledWith('codex');
  });

  /**
   * **`+` 카드가 없다**(`canCreate: false`). A2 가 정한 것을 그대로 따른다: *"설정으로
   * 가는 `+ Add or edit agents` 는 nav 에서 사라진다(이동 사이에 설정이 끼어 있었다)."*
   * 만들기는 설정의 일이고, 그 문은 이미 `+ Create agent` 로 서 있다.
   */
  it('만들기 문을 이 칸에 두지 않는다 — 그것은 설정의 일이다', () => {
    fakeController();
    useAppStore.getState().set(두에이전트());
    renderAgentsPanel();

    expect(screen.queryByTestId('agent-create')).toBeNull();
  });

  /**
   * **멈춘 것은 ▶ 로 여기서 바로 켠다**(문서). 이 칸이 3단계에서 얻는 새 능력이고,
   * 옛 목록에는 없었다 — 사유를 읽을 수는 있어도 켤 수는 없었다.
   */
  it('멈춘 에이전트는 ▶ 를 받고, 누르면 러너가 뜬다', () => {
    const c = fakeController();
    useAppStore.getState().set(두에이전트({ online: [], connected: true }));
    renderAgentsPanel();

    expect(screen.getByTestId('agent-card-codex').dataset.face).toBe('stopped');
    fireEvent.click(screen.getByTestId('agent-relaunch-codex'));
    expect(c.reissueRunnerPat).toHaveBeenCalledWith('codex');
    // 카드와 다른 동작이다 — 겹쳐 두면 실행이 우연히 눌린다(격자의 규칙).
    expect(c.startDm).not.toHaveBeenCalled();
  });

  /**
   * **권한이 없으면 그 자리를 그리지 않는다**(`AgentGrid` 주석: *"없으면 그 자리를 그리지
   * 않는다 — 권한 없는 사람에게는 문이 없다"*). 판정은 설정 화면과 같은 것이다:
   * 관리자이거나 내가 소유한 에이전트.
   */
  it('띄울 수 없는 사람에게는 ▶ 자체가 없다', () => {
    fakeController();
    const me = acc('me', 'nari', 'human', false);
    useAppStore.getState().set({
      me,
      accounts: { me, codex: acc('codex', 'codex', 'agent') },
      channels: [chan('c1', 'general')],
      dms: [], online: [], connected: true, activeChannelId: 'c1', runnerStates: {},
    });
    renderAgentsPanel();

    expect(screen.getByTestId('agent-card-codex').dataset.face).toBe('stopped');
    expect(screen.queryByTestId('agent-relaunch-codex')).toBeNull();
  });

  /**
   * **대조군** — 소유자면 관리자가 아니어도 켤 수 있다. 위 회귀선만 있으면 `onRelaunch` 를
   * 아예 안 넘기는 구현으로 초록이 되고, 그러면 문서의 *"▶ 로 여기서 바로 켠다"* 가
   * 아무에게도 닿지 않는다.
   */
  it('대조군 — 내가 소유한 에이전트는 관리자가 아니어도 켤 수 있다', () => {
    const c = fakeController();
    const me = acc('me', 'nari', 'human', false);
    useAppStore.getState().set({
      me,
      accounts: { me, codex: acc('codex', 'codex', 'agent', false, { ownerAccountId: 'me' }) },
      channels: [chan('c1', 'general')],
      dms: [], online: [], connected: true, activeChannelId: 'c1', runnerStates: {},
    });
    renderAgentsPanel();

    fireEvent.click(screen.getByTestId('agent-relaunch-codex'));
    expect(c.reissueRunnerPat).toHaveBeenCalledWith('codex');
  });
});

describe('좁은 폭 — 62px 레일 옆의 패널은 설정 화면이 아니다', () => {
  /**
   * **실측(2026-09-07).** 설정 화면의 격자는 `grid-cols-[repeat(auto-fill,86px)]` +
   * `gap-x-6`(24px)이고 아바타가 `h-14 w-14`(56px)다. 사이드바 패널의 실제 폭은
   * `MIN_SIDEBAR_WIDTH`(180) ~ `DEFAULT_PREFS.sidebarWidth`(240)이고 `nav` 의 `p-2` 가
   * 좌우 8px 씩을 먹으므로 **내용 폭은 164 ~ 224px** 이다.
   *
   * `auto-fill` 이 채우는 열 수는 `86n + 24(n-1) ≤ W` 를 만족하는 최대 n 이다:
   *
   * | 내용 폭 | 86px 카드 | 64px 카드(`narrow`) |
   * |---|---|---|
   * | 164px (최소) | **1열** — 78px 이 빈다 | 2열 |
   * | 224px (기본) | 2열 | 3열 |
   *
   * 넘쳐서 깨지는 것은 아니지만 **최소 폭에서 한 열**이면 그리드가 아니라 목록이다 —
   * 문서가 목록을 그리드로 바꾸라고 한 자리에서 목록이 되돌아온다. 그래서 자리 축을 더한다.
   *
   * jsdom 에는 레이아웃 엔진이 없어 픽셀을 잴 수 없다. 그래서 **트랙 폭 자체**를 잰다 —
   * 열 수를 정하는 것이 그 숫자이고, 위 표가 그 숫자에서 나온다.
   */
  it('좁은 칸의 카드는 설정보다 작은 트랙을 쓴다', () => {
    fakeController();
    useAppStore.getState().set(두에이전트());
    renderAgentsPanel();

    const grid = screen.getByTestId('agent-grid');
    expect(grid.className).toContain('repeat(auto-fill,64px)');
    expect(grid.className).not.toContain('repeat(auto-fill,86px)');
  });

  /**
   * **`sticky` 검색줄이 자기 바닥을 칠한다.** 설정 화면의 바닥은 `surface-raised` 고
   * 사이드바는 `surface-sunken` 이라(`Sidebar` 의 `aside`), 설정의 값을 그대로 쓰면
   * 사이드바에서 검색줄만 한 단계 밝은 띠가 된다 — 토큰을 쓰고 있어도 자리와 맞지 않으면
   * 틀린 색이다.
   */
  it('검색줄의 바닥이 사이드바의 바닥과 같다', () => {
    fakeController();
    useAppStore.getState().set(두에이전트());
    renderAgentsPanel();

    const sticky = screen.getByTestId('agent-search').closest('.sticky')!;
    expect(sticky.className).toContain('bg-surface-sunken');
    expect(sticky.className).not.toContain('bg-surface-raised');
  });

  /**
   * **설정 화면의 모양이 바뀌지 않는다.** 자리 축의 기본값이 `settings` 이므로 설정은
   * 한 글자도 안 바뀐다 — 그것을 여기서 잠근다: 이 단언이 없으면 좁은 폭을 맞추다 설정을
   * 함께 줄여도 아무도 모른다.
   *
   * `AgentGrid` 를 **직접** 세운다(설정 화면 전체가 아니라). 재는 것이 이 컴포넌트의
   * 기본값이고, 설정 화면은 그 기본값을 쓰는 호출자 하나일 뿐이다.
   */
  it('회귀선 — 자리를 안 주면 설정의 그 격자다', () => {
    const agent: AgentView = {
      ...acc('forge', 'forge', 'agent'),
      instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
      mentionPermission: 'auto', runnerVersion: null,
      stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
    };
    render(
      <AgentGrid agents={[agent]} selectedId={null} runnerStates={{}} online={[]}
        connected onPick={vi.fn()} onCreate={vi.fn()} canCreate />,
    );

    const grid = screen.getByTestId('agent-grid');
    expect(grid.className).toContain('repeat(auto-fill,86px)');
    expect(grid.className).toContain('gap-x-6');
    // 아바타도 그대로 56px 이다.
    expect(screen.getByTestId('agent-card-forge').querySelector('.h-14')).toBeTruthy();
    // 검색줄의 바닥도 그대로 카드 면이다.
    expect(screen.getByTestId('agent-search').closest('.sticky')!.className)
      .toContain('bg-surface-raised');
  });
});

describe('칸을 눌러 온 사람에게 빈 화면을 주지 않는다', () => {
  /**
   * 문서 「치르는 값 · 한 번 더 누름」: 레일을 한 번 더 누른 대가가 아무것도 아니면
   * 레일이 손해만 남긴다. 격자가 이미 그 문구를 갖고 있다(*"아직 에이전트가 없다"*) —
   * 여기서 따로 만들지 않는다.
   */
  it('에이전트가 하나도 없으면 격자가 그 사실을 말한다', () => {
    fakeController();
    const me = acc('me', 'jaebin', 'human', true);
    useAppStore.getState().set({
      me, accounts: { me },
      channels: [chan('c1', 'general')],
      dms: [], online: [], connected: true, activeChannelId: 'c1', runnerStates: {},
    });
    renderAgentsPanel();

    expect(screen.getByText('아직 에이전트가 없다')).toBeTruthy();
    // 옛 문구는 사라졌다 — DM 이 있는 쪽을 다른 칸으로 보내던 규칙 자체가 없어졌다.
    expect(screen.queryByText(/DM 이 있는 에이전트는 DM 칸에 선다/)).toBeNull();
  });

  /**
   * **검색은 따라온다.** 격자를 재사용하는 값이 여기 있다 — 문서가 설정 › 에이전트를
   * 검색 중심으로 짠 이유(*"에이전트는 늘어나는 것을 전제로 만들고 있다"*)가 이 칸에도
   * 그대로 적용되고, 두 화면이 같은 컴포넌트면 그 능력을 옮기는 비용이 0이다.
   */
  it('이름으로 찾는 입력이 이 칸에도 있다', () => {
    fakeController();
    useAppStore.getState().set(두에이전트());
    renderAgentsPanel();

    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: 'cod' } });
    expect(screen.getByTestId('agent-card-codex')).toBeTruthy();
    expect(screen.queryByTestId('agent-card-forge')).toBeNull();
  });
});
