// Task 15-2(identity 문서) — 에이전트 그리드 + 검색.
//
// 문서의 마지막 경고가 이 화면의 규칙이다: **"이 화면에서 정보를 더하는 쪽이 항상 지는
// 쪽이다."** 최악은 에이전트 40개이고, 그 수에서 무너지지 않는 것은 **고정 폭 카드와 검색**
// 둘뿐이다.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { AgentView } from '@murmur/shared';
import { AgentGrid } from '../src/components/settings/AgentGrid';

const agent = (handle: string, over: Partial<AgentView> = {}): AgentView => ({
  id: `id-${handle}`, handle, displayName: handle, kind: 'agent', isAdmin: false,
  instructions: '', harness: 'claude-code', model: null, effort: null, workingDir: null,
  mentionPermission: 'auto', ownerAccountId: null, disabled: false, runnerVersion: null,
  stopRequestedAt: null, stopAckedAt: null, lastTurnAt: null,
  status: 'available', statusText: null, avatarAttachmentId: null, ...over,
});

const grid = (props: Partial<Parameters<typeof AgentGrid>[0]> = {}) => render(
  <AgentGrid
    agents={props.agents ?? [agent('alpha')]}
    selectedId={props.selectedId ?? null}
    runnerStates={props.runnerStates ?? {}}
    online={props.online ?? []}
    connected={props.connected ?? true}
    onPick={props.onPick ?? vi.fn()}
    onCreate={props.onCreate ?? vi.fn()}
    canCreate={props.canCreate ?? true}
    onRelaunch={props.onRelaunch}
  />,
);

afterEach(() => cleanup());

describe('AgentGrid — 검색', () => {
  it('이름으로 찾는다', () => {
    grid({ agents: [agent('alpha'), agent('beta')] });
    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: 'bet' } });
    expect(screen.getByTestId('agent-card-beta')).toBeTruthy();
    expect(screen.queryByTestId('agent-card-alpha')).toBeNull();
  });

  /**
   * **검색은 이름만 훑지 않는다**(문서): "배포 담당이 누구였더라"를 이름을 모르는 채로 찾을
   * 수 있어야 검색이 목록을 대신한다. 설명은 카드에 안 보이지만 찾을 때는 쓰인다.
   */
  it('하는 일로도 찾는다 — 이름을 몰라도 찾힌다', () => {
    grid({
      agents: [agent('alpha'), agent('zeta', { instructions: '릴리스 배포를 맡는다' })],
    });
    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: '배포' } });
    expect(screen.getByTestId('agent-card-zeta')).toBeTruthy();
    expect(screen.queryByTestId('agent-card-alpha')).toBeNull();
  });

  it('못 찾은 것과 아무것도 없는 것은 다른 말이다', () => {
    grid({ agents: [agent('alpha')] });
    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: 'zzz' } });
    expect(screen.getByText(/"zzz" 에 맞는 에이전트가 없다/)).toBeTruthy();

    // 목록이 정말 비어 있는 것은 **다른 사실**이다 — 검색어를 지우고 확인한다.
    cleanup();
    grid({ agents: [] });
    expect(screen.getByText('아직 에이전트가 없다')).toBeTruthy();
  });

  it('가나다 고정이다 — 상태순이면 켜고 꺼질 때마다 카드가 자리를 옮긴다', () => {
    grid({ agents: [agent('zeta'), agent('alpha'), agent('mid')], online: ['id-zeta'] });
    const order = screen.getAllByTestId(/^agent-card-/).map((el) => el.dataset.testid);
    expect(order).toEqual(['agent-card-alpha', 'agent-card-mid', 'agent-card-zeta']);
  });

  it('+ 는 맨 앞이라 개수와 무관하게 자리가 고정된다', () => {
    grid({ agents: [agent('alpha')] });
    const buttons = screen.getAllByRole('button');
    // 검색 입력을 지나 첫 버튼이 `+` 다.
    expect(buttons[0]!.dataset.testid).toBe('agent-create');
  });

  it('검색으로 목록이 비어도 + 는 그대로 있다', () => {
    grid({ agents: [agent('alpha')] });
    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: 'zzz' } });
    expect(screen.getByTestId('agent-create')).toBeTruthy();
  });
});

/**
 * **상태는 사진이 말한다** — 상태 점도 상태 글자도 없다. 아바타 자체가 세 가지로 갈리므로
 * 카드에 줄이 늘지 않는다.
 */
describe('AgentGrid — 아바타 세 얼굴', () => {
  it('정상은 그냥 사진이다 — 정상이 기본값이므로 표시를 붙이지 않는다', () => {
    grid({ agents: [agent('alpha')], online: ['id-alpha'], onRelaunch: vi.fn() });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('ok');
    expect(screen.queryByTestId('agent-relaunch-alpha')).toBeNull();
  });

  it('멈추면 ▶ 가 뜨고, 그것은 카드와 다른 동작이다', () => {
    const onPick = vi.fn();
    const onRelaunch = vi.fn();
    grid({ agents: [agent('alpha')], online: [], onPick, onRelaunch });

    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('stopped');
    fireEvent.click(screen.getByTestId('agent-relaunch-alpha'));
    // 실행이 우연히 눌리지 않도록 카드 클릭(=설정 열기)과 갈라 둔다.
    expect(onRelaunch).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('실패는 ↻ 를 받고 사유가 글자로 남는다 — 유일하게 글자가 느는 상태다', () => {
    grid({
      agents: [agent('alpha')],
      runnerStates: { 'id-alpha': { agentId: 'id-alpha', status: 'failed', exitCode: 1, message: '노드를 못 찾았다' } },
      onRelaunch: vi.fn(),
    });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('failed');
    // 사유가 title 툴팁에만 있으면 사람은 그것을 찾지 못한다(#368).
    expect(screen.getByTestId('agent-runner-failed-id-alpha').textContent).toContain('노드를 못 찾았다');
  });

  /**
   * **`#443` 이 이 단언을 뒤집었다.**
   *
   * 앞 판본은 `toBe('ok')` 였고, 그 근거가 이 이름에 남아 있다 — *"40개가 전부 회색이
   * 되면 그것도 거짓말이다"*. **그 문장은 여전히 옳다.** 틀린 것은 그 다음 걸음이다:
   * 회색이 거짓말이라고 해서 `ok`(정상 얼굴)가 참이 되지는 않는다.
   *
   * 실측(2026-09-06, 릴리즈 `.app`)이 그 대가를 보여 줬다 — 서버가 죽어 타이틀 옆 점이
   * 빨강인 그 순간, 에이전트 여섯이 **전부 초록**이었다. 사람은 화면 두 곳에서 서로
   * 반대되는 말을 듣고 아래쪽을 믿었다.
   *
   * 그래서 값이 하나 늘었다. 두 거짓말 중 하나를 고르는 문제가 아니라 **모른다고 말할
   * 값이 없었던 것**이 문제였다(`#368` 의 규율).
   */
  it('생존을 모르면 초록도 회색도 아니다 — 모른다고 말한다 (#443)', () => {
    grid({ agents: [agent('alpha')], online: [], connected: false, onRelaunch: vi.fn() });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('unknown');
    // 얼굴 색만 바꾸면 사람은 `stopped`(꺼짐)와 구분하지 못한다. **글자로도 말한다.**
    expect(screen.getByTestId('agent-presence-unknown').textContent).toContain('알 수 없다');
    // **▶ 를 달지 않는다.** 지금 도는지 모르는 것을 켜라고 권하면 `#430` 의 중복이 된다.
    expect(screen.queryByTestId('agent-relaunch-alpha')).toBeNull();
  });

  /**
   * **대조군.** 위 회귀선만 있으면 `faceState` 가 무조건 `unknown` 을 돌려줘도 초록이다 —
   * 즉 "붙어 있어도 모른다고 말하는" 화면으로 이 이슈를 '고칠' 수 있다. 그것은 고친 것이
   * 아니라 정보를 통째로 없앤 것이다.
   *
   * 이 저장소가 반복해서 겪은 실패 모드라 명시한다(`#482` 의 회귀선 ⑦과 같은 자리).
   */
  it('대조군 — 붙어 있으면 초록이다 (#443)', () => {
    grid({ agents: [agent('alpha')], online: ['id-alpha'], connected: true, onRelaunch: vi.fn() });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('ok');
    // 모른다는 줄이 서지 않는다 — 그 줄이 늘 있으면 사람이 곧 읽지 않게 된다.
    expect(screen.queryByTestId('agent-presence-unknown')).toBeNull();
  });

  /**
   * **daemon 이 서버보다 먼저다**(`#443` 의 판단, `#482` 위에 얹는다).
   *
   * 소켓이 끊겨도 daemon 은 안 끊긴다 — daemon 은 이 앱 옆에 있고 서버는 네트워크 너머에
   * 있다. 그리고 daemon 의 `running`·`adopted` 는 `kill(pid, 0)` 로 **직접 관측한** 것이라
   * presence 의 보고보다 강하다. 끊긴 동안 유일하게 남아 있는 사실이 이것이다.
   *
   * 되돌려 RED: `faceState` 의 `if (st === 'running' || st === 'adopted') return 'ok'` 를
   * 지우면 이 단언이 `unknown` 을 받아 빨개진다.
   */
  it('끊겨도 daemon 이 아는 러너는 초록이다 — daemon 이 서버보다 먼저다 (#443)', () => {
    for (const status of ['running', 'adopted'] as const) {
      grid({
        agents: [agent('alpha')],
        online: [],
        connected: false,
        runnerStates: { 'id-alpha': { agentId: 'id-alpha', status, exitCode: null, message: null } },
        onRelaunch: vi.fn(),
      });
      expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('ok');
      cleanup();
    }
  });

  /**
   * **`#476`** — 하네스가 없어 물러난 러너가 격자에서 멀쩡한 얼굴이었다.
   *
   * `#473` 이 `needs_harness` 를 만들었는데 이 화면의 `faceState` 는 `failed` 와
   * `needs_reissue` 만 봤다. **새 사용자의 기본 상태가 이것**이라(`claude`·`codex` 는
   * 사용자가 직접 설치한다, 2026-09-06 방침) 가장 흔한 상태가 화면에서 가장 조용했다.
   *
   * 되돌려 RED: `faceState` 의 `|| st === 'needs_harness'` 를 지우면 얼굴이 `stopped` 가
   * 되고 아래 글자 줄도 사라진다.
   */
  it('하네스가 없어 죽은 러너는 멀쩡한 얼굴이 아니다 — 사유가 글자로 온다 (#476)', () => {
    grid({
      agents: [agent('alpha')],
      online: ['id-alpha'],
      connected: true,
      runnerStates: {
        'id-alpha': {
          agentId: 'id-alpha', status: 'needs_harness', exitCode: 78,
          message: '`claude` 를 찾을 수 없다 — 설치하고 PATH 에 있는지 확인하라. Claude Code 를 설치하면 함께 깔린다: https://claude.com/product/claude-code',
        },
      },
      onRelaunch: vi.fn(),
    });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('failed');
    // **설치 주소가 화면에 글자로 온다.** 이름만으로는 사람이 무엇을 어떻게 할지 모른다.
    const line = screen.getByTestId('agent-runner-harness-id-alpha');
    expect(line.textContent).toContain('claude');
    expect(line.textContent).toContain('https://claude.com/product/claude-code');
  });

  it('띄울 수 없는 사람에게는 ▶ 자체가 없다', () => {
    // `onRelaunch` 를 안 넘기면 문이 없다 — 눌러도 안 되는 버튼을 그리지 않는다.
    grid({ agents: [agent('alpha')], online: [] });
    expect(screen.queryByTestId('agent-relaunch-alpha')).toBeNull();
  });
});

/**
 * 목업과 맞춘 것들(2026-09-06 화면 확인). 문서의 목업은 **원과 이름만** 있는 격자이고,
 * 실행 글리프는 "사진 안으로 들어간다".
 */
describe('AgentGrid — 목업의 모양', () => {
  it('카드에 상자가 없다 — 26개가 깔릴 때 격자 선이 얼굴보다 먼저 보이면 안 된다', () => {
    grid({ agents: [agent('alpha')], online: ['id-alpha'] });
    const card = screen.getByTestId('agent-card-alpha');
    expect(card.className).not.toMatch(/border-border|bg-surface-hover/);
  });

  it('실행 글리프는 평소 옅고 호버에서 또렷해진다', () => {
    grid({ agents: [agent('alpha')], online: [], onRelaunch: vi.fn() });
    const glyph = screen.getByTestId('agent-relaunch-alpha');
    // 26개가 깔린 화면에서 26개의 진한 글리프는 소음이다.
    expect(glyph.className).toContain('opacity-50');
    expect(glyph.className).toContain('group-hover:opacity-100');
  });

  it('검색창이 몇 개를 뒤지는지 말한다', () => {
    grid({ agents: [agent('alpha'), agent('beta')] });
    expect(screen.getByText('2개')).toBeTruthy();
    // 걸러지면 그 수도 따라간다 — 뒤지고 있는 범위가 곧 이 숫자다.
    fireEvent.change(screen.getByTestId('agent-search'), { target: { value: 'alp' } });
    expect(screen.getByText('1개')).toBeTruthy();
  });
});
