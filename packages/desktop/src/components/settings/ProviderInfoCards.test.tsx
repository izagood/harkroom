/**
 * OpenCode·Cursor 카드는 **표시만** 한다 — 데몬을 부르지 않고, 계정 추가 버튼도 없다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import { CursorAccountsCard, OpenCodeAccountsCard } from './ProviderInfoCards';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubInvoke() {
  const invoke = vi.fn(async () => ({}));
  vi.stubGlobal('__TAURI_INTERNALS__', { transformCallback: () => 1, invoke });
  return invoke;
}

describe('표시만 하는 카드', () => {
  it('OpenCode: 시스템 기본값과 "여기서 관리하지 않는다"를 말하고, 버튼이 없다', () => {
    const invoke = stubInvoke();
    render(<OpenCodeAccountsCard />);
    const card = screen.getByTestId('provider-opencode');
    expect(within(card).getByText('OpenCode')).toBeTruthy();
    expect(within(card).getByText(/opencode auth login/)).toBeTruthy();
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('Cursor: 러너와 무관하다고 말하고, 대시보드 링크만 둔다', () => {
    const invoke = stubInvoke();
    render(<CursorAccountsCard />);
    const card = screen.getByTestId('provider-cursor');
    expect(within(card).getByText(/not an agent harness/i)).toBeTruthy();
    expect(within(card).getByRole('link', { name: /Cursor dashboard/ })).toBeTruthy();
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
  });
});
