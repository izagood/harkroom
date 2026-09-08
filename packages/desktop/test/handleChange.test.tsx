// #271 회귀선 (데스크탑) — "불리는 이름 바꾸기" 화면.
//
// `ProfileSettings` 를 **실제로 렌더한다**. 컨트롤러 메서드만 부르는 테스트는 그 버튼이
// 화면에 없어도, 확인 문구가 안 떠도, 오류가 안 보여도 전부 초록이다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { usePrefsStore } from '../src/state/prefsStore';
import { translator } from '../src/i18n';
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

// **언어를 고정한다.** 이 파일이 재는 것은 화면이 무엇을 보내고 무엇을 막는가이지
// 문구의 언어가 아니다 — 언어를 재는 자리는 `i18n.test.tsx` 하나이고, 두 곳에서 재면
// 문구를 고칠 때 한쪽만 고쳐진다.
const ko = translator('ko');

beforeEach(() => usePrefsStore.getState().setLocale('ko'));
afterEach(() => {
  cleanup();
  usePrefsStore.getState().setLocale('system');
  setController(null as unknown as Controller);
  vi.restoreAllMocks();
});

describe('#271 불리는 이름 바꾸기', () => {
  it('확인 문구를 지나야 실제로 바뀐다 — 누르자마자 보내지 않는다', async () => {
    const setHandle = mount();
    typeNewHandle('fizzy');

    fireEvent.click(screen.getByRole('button', { name: '확인' }));
    // 이 변경은 되돌릴 수 없으므로, 무엇이 따라 바뀌는지 먼저 말한다.
    //
    // **낱말이 아니라 두 사실을 잰다.** 어투를 `~다` 로 맞추면서 문구가 바뀌었는데
    // (`표시됩니다` → `보인다`), 그때 이 줄이 빨개진 것은 규율이 깨져서가 아니라
    // 글자를 재고 있었기 때문이다. 지켜야 할 것은 **과거에 미치는 범위**와
    // **되돌릴 수 없다는 것**이 둘 다 화면에 있다는 사실이다.
    const notice = screen.getByTestId('handle-change-confirm').textContent ?? '';
    expect(notice).toContain('과거 메시지의 멘션');
    expect(notice).toContain('되돌릴 수 없다');
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

    // 판정은 **코드**로 갈렸고(위 주석), 이 줄은 그 결과가 사람에게 닿는지만 본다.
    // 그래서 사전의 그 문구를 그대로 가져온다 — 문구를 손으로 적으면 사전을 고칠 때
    // 여기만 낡는다.
    expect(screen.getByRole('alert').textContent).toContain(ko('profileName.taken'));
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
