// Task 10 Step 5 — 오버레이 규칙 하나(스크림 + Esc + 바깥 클릭).
//
// **계획서가 "Directory 는 Esc 로 안 닫힌다"고 실측한 것의 정체**: 세 오버레이가 패널 div 의
// `onKeyDown` 으로 Esc 를 받고 있었다. 그것은 포커스가 패널 안에 있을 때만 도는 핸들러라,
// 열자마자는 `autoFocus` 덕에 우연히 동작하고 **결과를 한 번 클릭하면 조용히 죽는다.**
//
// 그래서 이 파일의 핵심은 "열자마자 Esc"가 아니라 **"포커스가 빠진 뒤에도 Esc"** 다.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Overlay } from '../src/components/Overlay';

beforeEach(() => cleanup());
afterEach(() => cleanup());

describe('Overlay — Esc 는 포커스와 무관하게 닫는다', () => {
  it('문서 어디에 포커스가 있어도 닫힌다', () => {
    const onClose = vi.fn();
    render(<Overlay label="디렉터리" onClose={onClose}><p>내용</p></Overlay>);

    // **패널 밖(document.body)에서 누른다** — 옛 구현은 여기서 아무 일도 하지 않았다.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('패널 안에서 눌러도 닫힌다', () => {
    const onClose = vi.fn();
    render(<Overlay label="인박스" onClose={onClose}><input aria-label="검색" /></Overlay>);
    fireEvent.keyDown(screen.getByLabelText('검색'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('닫힌 뒤에는 리스너가 남지 않는다 — 안 뜬 화면이 키를 먹으면 안 된다', () => {
    const onClose = vi.fn();
    const { unmount } = render(<Overlay label="저장된 메시지" onClose={onClose}><p>x</p></Overlay>);
    unmount();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('겹쳐 열리면 나중 것 하나만 닫힌다 — 전부 닫으면 화면이 통째로 사라진다', () => {
    const first = vi.fn();
    const second = vi.fn();
    render(
      <>
        <Overlay label="먼저" onClose={first}><p>1</p></Overlay>
        <Overlay label="나중" onClose={second}><p>2</p></Overlay>
      </>,
    );
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });
});

describe('Overlay — 스크림과 바깥 클릭', () => {
  it('스크림을 누르면 닫히고, 패널 안을 누르면 닫히지 않는다', () => {
    const onClose = vi.fn();
    const { container } = render(
      <Overlay label="디렉터리" onClose={onClose}><button>안쪽</button></Overlay>,
    );

    fireEvent.click(screen.getByText('안쪽'));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(container.firstChild as HTMLElement);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('role 과 접근성 이름을 준다 — 무엇이 열렸는지 말해야 한다', () => {
    render(<Overlay label="디렉터리" onClose={vi.fn()}><p>x</p></Overlay>);
    expect(screen.getByRole('dialog', { name: '디렉터리' })).toBeTruthy();
  });
});
