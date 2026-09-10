// **이 서버에서는 이 앱이 제대로 돌지 않는다**고 화면 위쪽 띠로 말한다(#693 후속).
//
// 사람의 진단: *"murmur 서버까지 업데이트 되어야 동작하는 기능이 있는데 서버가 그것보다
// 아래 버전이면 서버 재배포 해야하잖아."* 그 판단이 설정 안에만 있으면 늦다 — 사람은
// 무언가 이상할 때 설정을 열지 않고, 눌러도 아무 일이 없는 버튼을 보고 자기가 잘못
// 눌렀다고 생각한다.
//
// **이 파일이 가장 신경 쓰는 것은 띠가 함부로 서지 않는 것이다.** 상시로 서는 띠는 사람이
// 읽지 않고 닫는 법을 먼저 배우고, 그 순간 이 표면 전체가 죽는다. 그래서 서는 사정은
// **하한보다 낮을 때 하나뿐**이고, '뒤처졌다'·'모른다'로는 서지 않는다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MIN_SERVER_VERSION } from '@murmur/shared';
import { useActiveStore } from '../src/state/communities';
import type { SectionId } from '../src/components/settings/sections';
import { ServerCompatBanner } from '../src/components/ServerCompatBanner';
import { usePrefsStore } from '../src/state/prefsStore';

/** 하한에서 patch 를 옮긴 버전 — 하한을 올려도 이 파일이 안 깨지도록. */
function fromFloor(delta: number): string {
  const [major, minor, patch] = MIN_SERVER_VERSION.split('.').map(Number) as [number, number, number];
  return `${major}.${minor}.${patch + delta}`;
}
const BELOW = fromFloor(-1);

const seenVersion = (version: string | null) => useActiveStore.getState().set({
  serverVersion: { version, commit: null, startedAt: new Date().toISOString() },
});

beforeEach(() => {
  useActiveStore.getState().reset();
  usePrefsStore.getState().setLocale('ko');
});
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
});

const mount = (props: { onOpenSettings?: (section?: SectionId) => void } = {}) =>
  render(<ServerCompatBanner onOpenSettings={props.onOpenSettings} />);

describe('띠가 서는 사정 — 하나뿐이다', () => {
  it('하한보다 낮으면 선다 — 버전과 요구 버전을 함께 말한다', () => {
    seenVersion(BELOW);
    mount();
    const strip = screen.getByTestId('strip-server-incompatible');
    // 지금 무엇이 도는지와 무엇이 필요한지, **둘 다** 있어야 사람이 판단한다.
    expect(strip.textContent).toContain(BELOW);
    expect(strip.textContent).toContain(MIN_SERVER_VERSION);
  });

  // 뒤처졌지만 도는 서버로는 서지 않는다. 이것이 서면 릴리스마다 띠가 서고, 그러면
  // 사람은 이 띠를 닫는 법부터 배운다.
  it('뒤처졌지만 하한을 넘으면 서지 않는다', () => {
    seenVersion(MIN_SERVER_VERSION);
    mount();
    expect(screen.queryByTestId('strip-server-incompatible')).toBeNull();
  });

  // 모르는 것을 고장이라 부르지 않는다(`docs/design.md` §4).
  it('아직 못 받았거나 버전을 안 싣거나 견줄 수 없으면 서지 않는다', () => {
    mount();
    expect(screen.queryByTestId('strip-server-incompatible')).toBeNull();
    cleanup();

    seenVersion(null);
    mount();
    expect(screen.queryByTestId('strip-server-incompatible')).toBeNull();
    cleanup();

    seenVersion('dev');
    mount();
    expect(screen.queryByTestId('strip-server-incompatible')).toBeNull();
  });
});

describe('띠가 하는 일', () => {
  it('고치는 문이 띠 안에 있고, 커뮤니티 설정을 지목한다', () => {
    const onOpenSettings = vi.fn();
    seenVersion(BELOW);
    mount({ onOpenSettings });
    fireEvent.click(screen.getByTestId('server-compat-open-settings'));
    // **섹션을 함께 넘긴다.** 설정만 열고 어느 방인지 안 말하면 사람이 또 찾아야 한다.
    expect(onOpenSettings).toHaveBeenCalledWith('communities');
  });

  /**
   * 닫기는 **그 버전에 대해서만** 듣는다. 재배포했는데 아직도 모자라면(두 판 올렸지만
   * 여전히 하한 아래) 그것은 다른 사실이라 띠가 다시 서야 한다 — 한 번 닫은 것으로 이후를
   * 전부 덮으면 닫기가 곧 알림 끄기가 된다(`ProjectionBanner` 와 같은 규율).
   */
  it('닫으면 그 버전에서만 사라지고, 여전히 낮은 다른 버전에서는 다시 선다', () => {
    seenVersion(BELOW);
    const view = mount();
    fireEvent.click(screen.getByTestId('server-compat-dismiss'));
    view.rerender(<ServerCompatBanner />);
    expect(screen.queryByTestId('strip-server-incompatible')).toBeNull();

    // 재배포했지만 아직 모자라다.
    seenVersion(fromFloor(-2));
    view.rerender(<ServerCompatBanner />);
    expect(screen.getByTestId('strip-server-incompatible')).toBeTruthy();
  });
});
