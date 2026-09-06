import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  PROJECTION_UNCONFIGURED_DETAIL, PROJECTION_UNCONFIGURED_HEADLINE, type ProjectionStatus,
} from '@murmur/shared';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { LeasePanel } from '../src/components/LeasePanel';

beforeEach(() => useAppStore.getState().reset());

afterEach(() => {
  cleanup();
});

/** 상태 픽스처. 테스트마다 관심 있는 필드만 덮어쓴다. */
const status = (over: Partial<ProjectionStatus> = {}): ProjectionStatus => ({
  state: 'ok',
  configured: true,
  repo: 'org/repo',
  lastLogIndex: 100,
  lastPolledAt: Date.now(),
  lastAdvancedAt: Date.now(),
  lastError: null,
  ...over,
});

/**
 * ACTIVE WORK 영역이 화면에 내는 **전체 문구**. 테스트 6(세 상태가 서로 다른 문구)은
 * 개별 문구를 찾는 것으로는 지킬 수 없다 — 두 상태가 우연히 같은 말을 해도 각자
 * `getByText` 는 통과한다. 그래서 렌더 결과 전체를 문자열로 뽑아 **서로 비교**한다.
 */
const panelText = (): string => {
  const { container } = render(<LeasePanel />);
  const text = container.textContent ?? '';
  cleanup();
  return text;
};

describe('LeasePanel', () => {
  // 상태를 읽었고 정상일 때만 "없다"고 말한다 — 그래서 이 테스트는 ok 를 심는다.
  it('shows empty state when the projection is known to be ok', () => {
    useAppStore.getState().set({ projectionStatus: status() });
    render(<LeasePanel />);
    expect(screen.getByText('No active work')).toBeTruthy();
  });

  it('groups leases by repo', () => {
    useAppStore.getState().set({
      projectionStatus: status(),
      leases: [
        { repo: 'main-repo', path: 'src/a.ts', actorKeyId: 'wk1', expiresAt: 'x' },
        { repo: 'main-repo', path: 'src/b.ts', actorKeyId: 'a-very-long-key-id', expiresAt: 'x' },
        { repo: 'other', path: 'src/c.ts', actorKeyId: 'wk2', expiresAt: 'x' },
      ],
    });
    render(<LeasePanel />);
    expect(screen.getByText('main-repo')).toBeTruthy();
    expect(screen.getByText('other')).toBeTruthy();
    expect(screen.getByText(/src\/a\.ts/)).toBeTruthy();
    expect(screen.getByText(/a-very-long-…/)).toBeTruthy();
  });
});

describe('#267 ACTIVE WORK 가 투영 상태를 말한다', () => {
  it('unconfigured 는 설정하라고 말하고 AVCS_BASE_URL 을 알려 준다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'unconfigured', configured: false, repo: null, lastPolledAt: null }),
    });
    render(<LeasePanel />);
    expect(screen.getByTestId('projection-unconfigured')).toBeTruthy();
    /**
     * **문구가 띠로 옮겨졌다**(#489 후속). 고장 자체(`PROJECTION_UNCONFIGURED_HEADLINE`)는
     * 이제 화면 위쪽 띠가 말하고, 이 줄은 **그것이 이 목록에 뜻하는 것**을 말한다.
     * 두 자리가 같은 문구를 세우면 중복이고, 사용자가 화면에서 그것을 먼저 발견했다.
     *
     * 이 회귀선이 지키던 것("꺼진 것을 말한다")은 그대로다 — 말하는 문장만 달라졌다.
     */
    expect(screen.getByTestId('projection-unconfigured').textContent).toContain('꺼져 있어');
    // 띠가 말하는 문구를 여기서 되풀이하지 않는다.
    expect(screen.queryByText(PROJECTION_UNCONFIGURED_HEADLINE)).toBeNull();
    // 꺼져 있는 것을 "없다"로 말하지 않는다.
    expect(screen.queryByText('No active work')).toBeNull();
  });

  it('stalled 는 언제부터 멈췄는지와 에러를 말한다', () => {
    useAppStore.getState().set({
      projectionStatus: status({
        state: 'stalled', lastPolledAt: Date.now() - 6 * 60 * 1000, lastError: 'connection refused',
      }),
    });
    render(<LeasePanel />);
    // 멈춘 시점은 이 줄도 말한다 — 목록이 **언제부터** 낡았는지가 곧 그 목록의 신뢰도다.
    expect(screen.getByTestId('projection-stalled').textContent).toContain('6분 전부터');
    // 에러 원문은 띠가 말한다(`detail`). 여기서 되풀이하면 좁은 칸이 다시 길어진다.
    expect(screen.queryByText('connection refused')).toBeNull();
    expect(screen.queryByText('No active work')).toBeNull();
  });

  it('stalled 인데 에러가 없으면 에러 줄이 없다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: Date.now() - 6 * 60 * 1000, lastError: null }),
    });
    render(<LeasePanel />);
    expect(screen.getByTestId('projection-stalled').textContent).toContain('멈춰');
    expect(screen.queryByText('connection refused')).toBeNull();
  });

  // 폴링을 한 번도 못 한 경우. 모르는 것을 숫자로 꾸미지 않는다 — "0분 전부터"는 거짓이다.
  it('폴링 기록이 없으면 시각을 지어내지 않는다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: null }),
    });
    render(<LeasePanel />);
    const text = screen.getByTestId('projection-stalled').textContent ?? '';
    expect(text).toContain('알 수 없');
    expect(text).not.toMatch(/\d+분 전/);
  });

  /**
   * 회귀 6. **세 상태가 서로 다른 문구여야 한다** — 특히 `unconfigured` 와 `ok + 빈 목록`
   * 이 같은 문구면 결함이다(spec §3, docs/design.md §4). 문구를 하나씩 찾는 방식으로는
   * 이것을 지킬 수 없어서 렌더 결과 전체를 뽑아 서로 비교한다.
   */
  it('unconfigured · stalled · ok+빈 목록 이 서로 다른 문구로 나온다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'unconfigured', configured: false, lastPolledAt: null }),
    });
    const unconfigured = panelText();

    useAppStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: Date.now() - 6 * 60 * 1000 }),
    });
    const stalled = panelText();

    useAppStore.getState().set({ projectionStatus: status({ state: 'ok' }) });
    const okEmpty = panelText();

    // 셋이 모두 서로 달라야 한다. 두 개만 비교하면 나머지 한 쌍이 같아도 통과한다.
    expect(new Set([unconfigured, stalled, okEmpty]).size).toBe(3);
    // 그리고 문구가 실제로 비어 있지 않다 — 셋 다 빈 문자열이면 위 단언이 무너진다.
    for (const t of [unconfigured, stalled, okEmpty]) expect(t.length).toBeGreaterThan(20);
  });

  /**
   * 이 이슈의 핵심 기준: **"못 읽었다"를 "없다"로 그리지 않는다**(docs/design.md §4).
   * `/projection/status` 조회가 실패했는데 "No active work" 가 보이면, 도그푸딩 중에
   * 투영이 끊긴 것을 화면이 평소와 똑같이 그려 아무도 모른다.
   */
  it('상태를 못 읽었으면 그렇게 말한다 — "No active work" 가 아니다', () => {
    useAppStore.getState().set({ projectionStatusError: 'Failed to fetch' });
    render(<LeasePanel />);
    expect(screen.getByTestId('projection-unreadable')).toBeTruthy();
    expect(screen.getByTestId('projection-unreadable').textContent).toContain('못 읽어');
    // 에러 원문(`Failed to fetch`)은 **띠**가 말한다 — 이 좁은 칸에서 되풀이하지 않는다.
    expect(screen.queryByText('No active work')).toBeNull();
  });

  // 아직 첫 응답이 오지 않은 창. "없다"가 아니라 "아직 모른다"다.
  it('첫 응답 전에는 확인 중이라고 말한다', () => {
    render(<LeasePanel />);
    expect(screen.getByTestId('projection-unknown')).toBeTruthy();
    expect(screen.queryByText('No active work')).toBeNull();
  });

  // 실패는 마지막으로 성공한 상태보다 **먼저** 말한다 — 오래된 성공은 지금의 사실이 아니다.
  it('읽기 실패가 남아 있으면 지난 성공 상태보다 그것을 먼저 말한다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'ok' }),
      projectionStatusError: 'Failed to fetch',
    });
    render(<LeasePanel />);
    expect(screen.getByTestId('projection-unreadable')).toBeTruthy();
    expect(screen.queryByText('No active work')).toBeNull();
  });

  /**
   * 리스가 있으면 목록을 그린다 — 실제 데이터가 상태 문구보다 먼저다. 다만 배너는
   * 함께 남는다: 투영이 멈춘 동안의 리스는 지금 벌어지는 일이 아닐 수 있고, 말없이
   * '활성 작업'으로 보여 주면 화면이 오래된 사실을 지금 사실로 주장하게 된다.
   */
  it('멈춘 상태에서도 남아 있는 리스를 그리되 멈췄다는 것을 함께 말한다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: Date.now() - 9 * 60 * 1000 }),
      leases: [{ repo: 'org/repo', path: 'src/a.ts', actorKeyId: 'wk1', expiresAt: 'x' }],
    });
    render(<LeasePanel />);
    /**
     * **이 회귀선의 본론은 그대로다**: 멈춘 동안 남아 있던 리스를 그리되, 그것이 지금
     * 사실이 아닐 수 있다는 말을 **함께** 세운다. 말없이 '활성 작업'으로 보여 주면
     * 화면이 오래된 사실을 지금 사실로 주장한다. 문구만 띠와 갈라졌다.
     */
    expect(screen.getByTestId('projection-stalled').textContent).toContain('멈춰');
    expect(screen.getByText(/src\/a\.ts/)).toBeTruthy();
  });
});
