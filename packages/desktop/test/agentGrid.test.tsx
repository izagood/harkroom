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

  it('생존을 모르면 가라앉히지 않는다 — 40개가 전부 회색이 되면 그것도 거짓말이다', () => {
    grid({ agents: [agent('alpha')], online: [], connected: false, onRelaunch: vi.fn() });
    expect(screen.getByTestId('agent-card-alpha').dataset.face).toBe('ok');
  });

  it('띄울 수 없는 사람에게는 ▶ 자체가 없다', () => {
    // `onRelaunch` 를 안 넘기면 문이 없다 — 눌러도 안 되는 버튼을 그리지 않는다.
    grid({ agents: [agent('alpha')], online: [] });
    expect(screen.queryByTestId('agent-relaunch-alpha')).toBeNull();
  });
});
