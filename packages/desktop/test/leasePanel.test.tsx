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

/**
 * **문서 4 로 좁혀졌다**(실측 2026-09-07). 고장 자체는 화면 위쪽 띠가 말하고, 이 자리는
 * **남은 리스가 있을 때만** 한 줄을 남긴다 — 문서 4: *"설정 오류는 띠로 나가고, 그
 * 구역은 그냥 없어진다."*
 *
 * 사용자가 앱에서 본 것이 근거다: 문장을 갈라 놨어도 띠와 왼쪽 줄이 같은 주의색으로
 * 나란히 서면 눈에는 **같은 경고 둘**이다.
 *
 * **이 묶음이 지키던 것은 그대로다.** ① 네 사정을 뭉개지 않는다 ② 고장 때 남은 리스를
 * 말없이 '활성 작업'으로 보여 주지 않는다. 그래서 아래 케이스들은 **리스를 함께 심어**
 * 그 조건에서 사정이 여전히 구별되는지 묻는다 — 리스가 없으면 주장할 데이터가 없으니
 * 그 줄도 필요 없고, 그때가 중복이었다.
 */
const LEASE = [{ repo: 'org/repo', path: 'src/a.ts', actorKeyId: 'wk1', expiresAt: 'x' }];

describe('#267 ACTIVE WORK 가 투영 상태를 말한다', () => {
  it('unconfigured 는 설정하라고 말하고 AVCS_BASE_URL 을 알려 준다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'unconfigured', configured: false, repo: null, lastPolledAt: null }),
      leases: LEASE,
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
      leases: LEASE,
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
      leases: LEASE,
    });
    render(<LeasePanel />);
    expect(screen.getByTestId('projection-stalled').textContent).toContain('멈춰');
    expect(screen.queryByText('connection refused')).toBeNull();
  });

  // 폴링을 한 번도 못 한 경우. 모르는 것을 숫자로 꾸미지 않는다 — "0분 전부터"는 거짓이다.
  it('폴링 기록이 없으면 시각을 지어내지 않는다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: null }),
      leases: LEASE,
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
      leases: LEASE,
    });
    const unconfigured = panelText();

    useAppStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: Date.now() - 6 * 60 * 1000 }),
      leases: LEASE,
    });
    const stalled = panelText();

    // `ok` 는 리스가 있어도 경고 줄이 없다 — 그것이 이 셋을 가르는 세 번째 모습이다.
    useAppStore.getState().set({ projectionStatus: status({ state: 'ok' }), leases: LEASE });
    const okEmpty = panelText();

    // 셋이 모두 서로 달라야 한다. 두 개만 비교하면 나머지 한 쌍이 같아도 통과한다.
    expect(new Set([unconfigured, stalled, okEmpty]).size).toBe(3);
    // 고장 둘은 실제로 말을 한다(빈 문자열이면 위 단언이 무너진다). `ok` 는 경고 줄이
    // 없는 것이 정상이라 길이를 묻지 않는다 — 그 침묵이 세 번째 모습이다.
    for (const t of [unconfigured, stalled]) expect(t.length).toBeGreaterThan(20);
  });

  /**
   * 이 이슈의 핵심 기준: **"못 읽었다"를 "없다"로 그리지 않는다**(docs/design.md §4).
   * `/projection/status` 조회가 실패했는데 "No active work" 가 보이면, 도그푸딩 중에
   * 투영이 끊긴 것을 화면이 평소와 똑같이 그려 아무도 모른다.
   */
  it('상태를 못 읽었으면 그렇게 말한다 — "No active work" 가 아니다', () => {
    useAppStore.getState().set({ projectionStatusError: 'Failed to fetch', leases: LEASE });
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
      leases: LEASE,
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

/**
 * **빈 목록일 때 띠와 나란히 서지 않는다**(문서 4 · 실측 2026-09-07).
 *
 * 사용자가 앱에서 발견했다: 화면 위쪽 띠("투영이 설정되지 않았다")와 사이드바 줄
 * ("투영이 꺼져 있어 이 목록은 채워지지 않는다")이 **같은 주의색으로 나란히** 서 있었다.
 * 문장을 갈라 놨어도 눈에는 같은 경고 둘이다.
 *
 * **이 회귀선이 없어서 그 상태가 통과했다.** 기존 케이스들은 배너가 *있는지*만 물었고
 * "리스가 없을 때는 없어야 한다"를 아무도 묻지 않았다 — 조건을 되돌려도 25개가 전부
 * 초록이었다(실측). 그래서 여기서 그 자리를 못 박는다.
 *
 * 문서 4: *"설정 오류는 띠로 나가고, 그 구역은 그냥 없어진다."*
 */
describe('빈 목록에서는 고장을 되풀이하지 않는다', () => {
  it('리스가 없으면 띠에 맡기고 아무 줄도 세우지 않는다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'unconfigured', configured: false, lastPolledAt: null }),
      leases: [],
    });
    render(<LeasePanel />);
    expect(screen.queryByTestId('projection-unconfigured')).toBeNull();
  });

  /**
   * **남은 리스가 있으면 예외다.** 이 파일의 존재 이유가 그것이다: 멈춘 동안 남아 있던
   * 리스를 말없이 '활성 작업'으로 보여 주면 화면이 오래된 사실을 지금 사실로 주장한다.
   * 띠는 "고장났다"만 말하고 **이 목록이 낡았다**는 말은 하지 않는다.
   */
  it('리스가 남아 있으면 그 목록이 낡았다는 것을 말한다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: Date.now() - 6 * 60 * 1000 }),
      leases: LEASE,
    });
    render(<LeasePanel />);
    expect(screen.getByTestId('projection-stalled')).toBeTruthy();
    expect(screen.getByText(/src\/a\.ts/)).toBeTruthy();
  });

  /** 띠가 세우지 않는 사정('확인하는 중')은 리스가 없어도 여기가 **유일한 자리**다. */
  it("'확인하는 중'은 리스가 없어도 말한다", () => {
    useAppStore.getState().set({ projectionStatus: null, projectionStatusError: null, leases: [] });
    render(<LeasePanel />);
    expect(screen.getByTestId('projection-unknown').textContent).toContain('확인하는 중');
  });
});

/**
 * **내용이 없으면 제목도 없다**(문서 3 · 실측 v0.1.52).
 *
 * 사용자가 앱에서 발견했다: 홈 패널 하단에 `ACTIVE WORK` 라벨이 있고 **그 아래가
 * 완전히 비어 있었다.** 위 묶음이 "리스가 없으면 아무 줄도 세우지 않는다"를 못 박았지만
 * 제목에는 아무 조건이 없어서, 내용 셋이 모두 거짓인 창에서 제목 혼자 남았다.
 *
 * 문서 3: *"설정 오류는 띠로 나가고, 그 구역은 그냥 없어진다."* 「없어진다」는 제목까지
 * 없어지는 것이다 — 빈 제목은 없어진 것이 아니라 이름만 남은 빈 칸이다.
 *
 * **제목을 무조건 지우는 것은 답이 아니다.** 그릴 내용이 있을 때는 제목이 있어야 그
 * 내용이 무엇에 대한 것인지 알 수 있다. 그래서 이 묶음은 사라지는 창 하나와 **남아야
 * 하는 창 넷**을 같이 재고, 뒤쪽이 "제목을 늘 지운다"는 답을 막는다.
 */
describe('내용이 없으면 ACTIVE WORK 제목도 없다', () => {
  const LABEL = 'Active work';

  /**
   * 사용자가 본 그 상태다: 띠가 이미 말하는 고장(`strip: true`)이고 남은 리스가 없다.
   * 목록 줄도, "없다"도, 리스도 그리지 않으니 제목이 가리킬 내용이 하나도 없다.
   */
  it('띠가 말하는 고장이고 리스가 없으면 제목까지 사라진다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'unconfigured', configured: false, lastPolledAt: null }),
      leases: [],
    });
    const { container } = render(<LeasePanel />);
    expect(screen.queryByText(LABEL)).toBeNull();
    // 라벨만 지우고 빈 껍데기를 남기면 그 자리가 여전히 한 줄을 차지한다.
    expect(container.textContent).toBe('');
  });

  /** 나머지 두 고장도 같다 — `strip` 하나로 판정하니 사정마다 갈라지지 않는다. */
  it('멈춘 것과 못 읽은 것도 리스가 없으면 제목이 사라진다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: Date.now() - 6 * 60 * 1000 }),
      leases: [],
    });
    expect(panelText()).toBe('');

    useAppStore.getState().set({ projectionStatusError: 'Failed to fetch', leases: [] });
    expect(panelText()).toBe('');
  });

  /**
   * **여기부터가 "제목을 늘 지운다"를 막는 자리다.** 그릴 내용이 있는 네 창에서는 제목이
   * 남아야 한다 — 제목이 없으면 아래 줄이 무엇에 대한 것인지 화면이 말하지 못한다.
   */
  it('정상이고 빈 목록이면 제목과 "없다"가 함께 남는다', () => {
    useAppStore.getState().set({ projectionStatus: status({ state: 'ok' }), leases: [] });
    render(<LeasePanel />);
    expect(screen.getByText(LABEL)).toBeTruthy();
    expect(screen.getByText('No active work')).toBeTruthy();
  });

  it('리스가 있으면 제목이 남는다', () => {
    useAppStore.getState().set({ projectionStatus: status({ state: 'ok' }), leases: LEASE });
    render(<LeasePanel />);
    expect(screen.getByText(LABEL)).toBeTruthy();
    expect(screen.getByText(/src\/a\.ts/)).toBeTruthy();
  });

  it('고장이어도 남은 리스가 있으면 제목이 남는다', () => {
    useAppStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: Date.now() - 6 * 60 * 1000 }),
      leases: LEASE,
    });
    render(<LeasePanel />);
    expect(screen.getByText(LABEL)).toBeTruthy();
    expect(screen.getByTestId('projection-stalled')).toBeTruthy();
  });

  /**
   * 띠가 세우지 않는 '확인하는 중'(`strip: false`)은 여기가 유일한 자리다. 그 줄이
   * 남으니 제목도 남아야 한다 — 이 창까지 지우면 그 사정이 화면에서 사라진다.
   */
  it("'확인하는 중'은 리스가 없어도 제목과 함께 남는다", () => {
    useAppStore.getState().set({ projectionStatus: null, projectionStatusError: null, leases: [] });
    render(<LeasePanel />);
    expect(screen.getByText(LABEL)).toBeTruthy();
    expect(screen.getByTestId('projection-unknown')).toBeTruthy();
  });
});
