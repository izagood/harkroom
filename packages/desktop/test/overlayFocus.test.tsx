// Overlay 는 모달이다 — aria-modal, Tab 가둠, 닫히면 연 자리로 포커스 복귀.
//
// 스크림이 뒤를 가리는데 Tab 이 뒤로 새면 키보드로 쓰는 사람은 보이지 않는 버튼을 누른다.
// 닫힌 뒤 포커스가 `body` 로 떨어지면 목록 어디에 있었는지를 잃는다.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { Overlay } from '../src/components/Overlay';
import { ConfirmDialog } from '../src/components/ConfirmDialog';

afterEach(() => cleanup());

function Harness({ children }: { children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>열기</button>
      <button>뒤의 다른 버튼</button>
      {open && children(() => setOpen(false))}
    </>
  );
}

describe('Overlay — 모달', () => {
  it('dialog 는 aria-modal 이다', () => {
    render(<Overlay label="창" onClose={vi.fn()}><p>내용</p></Overlay>);
    expect(screen.getByRole('dialog', { name: '창' }).getAttribute('aria-modal')).toBe('true');
  });

  it('안에 포커스가 없으면 열릴 때 패널이 받는다', () => {
    render(<Overlay label="창" onClose={vi.fn()}><p>글만 있다</p></Overlay>);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('소비자가 먼저 옮긴 포커스는 건드리지 않는다 — 확인창의 첫 손가락은 취소다', () => {
    render(<ConfirmDialog title="지울까?" confirmLabel="지우기" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByTestId('confirm-cancel'));
  });

  it('Tab 은 마지막 다음에 처음으로, Shift+Tab 은 처음 앞에서 마지막으로 돈다', () => {
    render(<ConfirmDialog title="지울까?" confirmLabel="지우기" onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const cancel = screen.getByTestId('confirm-cancel');
    const ok = screen.getByTestId('confirm-ok');
    ok.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(ok);
  });

  it('포커스가 밖으로 빠져 있어도 Tab 은 안으로 돌아온다', () => {
    render(<Harness>{(close) => (
      <Overlay label="창" onClose={close}><button>안의 버튼</button></Overlay>
    )}</Harness>);
    fireEvent.click(screen.getByText('열기'));
    screen.getByText('뒤의 다른 버튼').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('안의 버튼'));
  });

  it('닫히면 열기 직전의 포커스로 돌아간다', () => {
    render(<Harness>{(close) => (
      <ConfirmDialog title="지울까?" confirmLabel="지우기" onConfirm={close} onCancel={close} />
    )}</Harness>);
    const opener = screen.getByText('열기');
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByTestId('confirm-cancel'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('겹쳐 열리면 맨 위만 Tab 을 가둔다', () => {
    render(
      <>
        <Overlay label="아래" onClose={vi.fn()}><button>아래 버튼</button></Overlay>
        <Overlay label="위" onClose={vi.fn()}><button>위 버튼 1</button><button>위 버튼 2</button></Overlay>
      </>,
    );
    screen.getByText('위 버튼 2').focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByText('위 버튼 1'));
  });

  it('아래 깔린 오버레이가 다시 그려져도 Esc 는 여전히 맨 위만 닫는다', () => {
    const lower = vi.fn();
    const upper = vi.fn();
    const { rerender } = render(
      <>
        <Overlay label="아래" onClose={() => lower()}><p>a</p></Overlay>
        <Overlay label="위" onClose={upper}><p>b</p></Overlay>
      </>,
    );
    // 아래의 onClose 가 새 함수가 된다 — 옛 구현은 이때 스택 맨 위로 다시 올라갔다.
    rerender(
      <>
        <Overlay label="아래" onClose={() => lower()}><p>a</p></Overlay>
        <Overlay label="위" onClose={upper}><p>b</p></Overlay>
      </>,
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(upper).toHaveBeenCalledTimes(1);
    expect(lower).not.toHaveBeenCalled();
  });
});
