// 투영 고장을 **화면 위쪽 띠**로 옮긴다(#488 A3-a).
//
// 문서의 진단: 이 오류가 사이드바 `ACTIVE WORK` 에서 **"설정 오류를 작업으로 그리고"**
// 있었다. 그 칸은 "지금 무슨 일이 벌어지는가"를 말하는 자리인데 거기 앉은 것은 일이
// 아니라 고장이었고, 고치는 동작도 그 좁은 칸에 들어가지 못했다.
//
// **이 파일이 가장 신경 쓰는 것은 네 사정을 뭉개지 않는 것이다**(`docs/design.md` §4).
// 빈 목록 하나가 ① 꺼짐 ② 멈춤 ③ 못 읽음 ④ 정말 없음 을 뭉갤 수 있고, 그러면
// 도그푸딩 중에 투영이 끊긴 것을 **아무도 모른다** — 화면이 평소와 똑같기 때문이다.
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ProjectionStatus } from '@murmur/shared';
import { useActiveStore } from '../src/state/communities';
import { ProjectionBanner } from '../src/components/ProjectionBanner';
import { projectionBanner } from '../src/lib/projectionBanner';

const status = (over: Partial<ProjectionStatus>): ProjectionStatus => ({
  state: 'ok', configured: true, lastPolledAt: Date.now(), lastError: null, ...over,
} as ProjectionStatus);

beforeEach(() => useActiveStore.getState().reset());
afterEach(() => cleanup());

const mount = (props: { onOpenSettings?: () => void } = {}) =>
  render(<ProjectionBanner onOpenSettings={props.onOpenSettings} />);

describe('띠가 서는 사정', () => {
  it('투영이 꺼져 있으면 선다', () => {
    useActiveStore.getState().set({ projectionStatus: status({ state: 'unconfigured', configured: false }) });
    mount();
    expect(screen.getByTestId('strip-projection-unconfigured')).toBeTruthy();
  });

  it('멈췄으면 선다 — 언제부터인지 함께 말한다', () => {
    useActiveStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: Date.now() - 10 * 60_000 }),
    });
    mount();
    expect(screen.getByTestId('strip-projection-stalled').textContent).toContain('10분 전부터');
  });

  /**
   * 폴링을 한 번도 못 했으면 **"N분 전"이라고 말할 수 없다.** 모르는 것을 숫자로
   * 꾸미면 화면이 없는 사실을 주장한다.
   */
  it('한 번도 못 폴링했으면 시간을 지어내지 않는다', () => {
    useActiveStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: null }),
    });
    mount();
    const t = screen.getByTestId('strip-projection-stalled').textContent ?? '';
    expect(t).toContain('언제부터인지 알 수 없지만');
    expect(t).not.toMatch(/\d+분 전/);
  });

  it('정상이면 아무것도 그리지 않는다', () => {
    useActiveStore.getState().set({ projectionStatus: status({ state: 'ok' }) });
    const { container } = mount();
    expect(container.firstChild).toBeNull();
  });

  /**
   * **'확인하는 중'은 띠로 세우지 않는다.** 앱을 켤 때마다 잠깐 뜨는 띠는 정보가 아니라
   * 깜빡임이고, 그 사이 화면이 한 줄 밀린다. 그 사정은 `LeasePanel` 안에서만 말한다.
   */
  it('아직 모르는 것은 띠로 세우지 않는다 — 그러나 판정 자체는 남는다', () => {
    useActiveStore.getState().set({ projectionStatus: null, projectionStatusError: null });
    const { container } = mount();
    expect(container.firstChild).toBeNull();
    // 사정이 사라진 것이 아니다 — 세우지 않을 뿐이다(`LeasePanel` 이 이것을 쓴다).
    const b = projectionBanner({ status: null, error: null, minutesAgo: () => '방금' });
    expect(b?.testid).toBe('projection-unknown');
    expect(b?.strip).toBe(false);
  });
});

describe('네 사정을 뭉개지 않는다', () => {
  /**
   * **못 읽은 것이 먼저다.** 마지막으로 성공한 상태가 남아 있어도 그것은 지금의
   * 사실이 아니므로, 지금 못 읽고 있다는 것을 먼저 말한다.
   */
  it('못 읽는 중이면 남아 있던 정상 상태보다 그것을 먼저 말한다', () => {
    useActiveStore.getState().set({
      projectionStatus: status({ state: 'ok' }),
      projectionStatusError: '네트워크가 끊겼다',
    });
    mount();
    expect(screen.getByTestId('strip-projection-unreadable')).toBeTruthy();
  });

  it('못 읽음은 고장색(danger)이고 꺼짐·멈춤은 주의색(warning)이다', () => {
    useActiveStore.getState().set({ projectionStatusError: 'x' });
    mount();
    expect(screen.getByTestId('strip-projection-unreadable').className).toContain('danger');
    cleanup();

    useActiveStore.getState().reset();
    useActiveStore.getState().set({ projectionStatus: status({ state: 'unconfigured', configured: false }) });
    mount();
    expect(screen.getByTestId('strip-projection-unconfigured').className).toContain('warning');
  });

  /**
   * **강조색을 쓰지 않는다**(문서: "급한 일과 고장이 같은 색이면 둘 다 안 보인다").
   * 강조색은 나를 막는 말에만 쓰는 색이다(규칙 04).
   */
  it('강조색을 쓰지 않는다', () => {
    useActiveStore.getState().set({ projectionStatus: status({ state: 'unconfigured', configured: false }) });
    mount();
    expect(screen.getByTestId('strip-projection-unconfigured').className).not.toContain('accent');
  });
});

describe('고치는 문과 닫기', () => {
  it('고치는 동작이 띠 안에 붙는다', () => {
    const onOpenSettings = vi.fn();
    useActiveStore.getState().set({ projectionStatus: status({ state: 'unconfigured', configured: false }) });
    mount({ onOpenSettings });
    fireEvent.click(screen.getByTestId('projection-open-settings'));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('열 수 없는 사람에게는 그 문을 그리지 않는다', () => {
    useActiveStore.getState().set({ projectionStatus: status({ state: 'unconfigured', configured: false }) });
    mount();
    expect(screen.queryByTestId('projection-open-settings')).toBeNull();
  });

  it('닫으면 사라진다', () => {
    useActiveStore.getState().set({ projectionStatus: status({ state: 'unconfigured', configured: false }) });
    const { container } = mount();
    fireEvent.click(screen.getByTestId('projection-dismiss'));
    expect(container.firstChild).toBeNull();
  });

  /**
   * **닫기는 사정별이다.** 꺼진 것을 닫아 뒀는데 그 뒤 투영이 멈추면 그것은 다른
   * 사실이므로 띠가 다시 선다 — 한 번 닫은 것으로 이후의 모든 고장을 덮으면 닫기가
   * 곧 **알림 끄기**가 된다.
   */
  it('다른 사정이 생기면 다시 선다', () => {
    useActiveStore.getState().set({ projectionStatus: status({ state: 'unconfigured', configured: false }) });
    mount();
    fireEvent.click(screen.getByTestId('projection-dismiss'));
    cleanup();

    // 사정이 바뀐다: 꺼짐 → 멈춤. 닫아 둔 열쇠와 다르므로 다시 서야 한다.
    useActiveStore.getState().set({
      projectionStatus: status({ state: 'stalled', lastPolledAt: Date.now() - 60_000 }),
    });
    mount();
    expect(screen.getByTestId('strip-projection-stalled')).toBeTruthy();
  });
});
