// #271 회귀선 (데스크탑) — "불리는 이름 바꾸기" 화면.
//
// `ProfileSettings` 를 **실제로 렌더한다**. 컨트롤러 메서드만 부르는 테스트는 그 버튼이
// 화면에 없어도, 확인 문구가 안 떠도, 오류가 안 보여도 전부 초록이다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { useAppStore } from '../src/state/appStore';
import { setController, type Controller } from '../src/state/controller';
import { ProfileSettings } from '../src/components/settings/ProfileSettings';
import { ApiError } from '../src/lib/api';
import { acc } from './helpers/fakeApi';

function mount(setHandle = vi.fn(async () => {})) {
  setController({ api: { baseUrl: 'http://x' }, setHandle } as unknown as Controller);
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'fizz'), accounts: { u1: acc('u1', 'fizz') } });
  render(<ProfileSettings onSignOut={vi.fn()} />);
  return setHandle;
}

/** 이름 입력까지 간다: 바꾸기 → 새 이름 입력. */
function typeNewHandle(value: string): void {
  fireEvent.click(screen.getByRole('button', { name: '바꾸기' }));
  fireEvent.change(screen.getByPlaceholderText('새 이름'), { target: { value } });
}

beforeEach(() => { /* mount 가 상태를 세운다 */ });
afterEach(() => { cleanup(); setController(null as unknown as Controller); vi.restoreAllMocks(); });

describe('#271 불리는 이름 바꾸기', () => {
  it('확인 문구를 지나야 실제로 바뀐다 — 누르자마자 보내지 않는다', async () => {
    const setHandle = mount();
    typeNewHandle('fizzy');

    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    // 이 변경은 되돌릴 수 없으므로, 무엇이 따라 바뀌는지 먼저 말한다.
    expect(screen.getByText(/과거 메시지의 멘션도 새 이름으로 표시됩니다/)).toBeTruthy();
    expect(setHandle).not.toHaveBeenCalled();

    await act(async () => { screen.getByRole('button', { name: '적용' }).click(); });
    expect(setHandle).toHaveBeenCalledWith('fizzy');
  });

  it('대문자는 **보내기 전에** 막는다 — 서버 400 을 받아 뭉개지 않는다', () => {
    const setHandle = mount();
    typeNewHandle('Fizzy');
    fireEvent.click(screen.getByRole('button', { name: '확인' }));

    expect(screen.getByRole('alert').textContent).toContain('소문자');
    expect(setHandle).not.toHaveBeenCalled();
  });

  it('이미 쓰는 이름이면 그 사실을 말한다 — 코드로 가른다', async () => {
    const setHandle = vi.fn(async () => {
      throw new ApiError(409, 'handle_taken', 'this handle is already taken');
    });
    mount(setHandle);
    typeNewHandle('taken');
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    await act(async () => { screen.getByRole('button', { name: '적용' }).click(); });

    // 문구를 문자열로 뒤지는 판정이면 서버가 문구를 다듬는 순간 이 줄이 빨개진다.
    expect(screen.getByRole('alert').textContent).toContain('이미 쓰고 있습니다');
  });

  it('오류는 눈에 보이게 낸다 — 조용히 실패하지 않는다', async () => {
    const setHandle = vi.fn(async () => { throw new Error('network down'); });
    mount(setHandle);
    typeNewHandle('other');
    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    await act(async () => { screen.getByRole('button', { name: '적용' }).click(); });

    expect(screen.getByRole('alert')).toBeTruthy();
  });
});
