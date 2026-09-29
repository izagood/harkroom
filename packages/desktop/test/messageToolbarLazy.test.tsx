import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useActiveStore as useAppStore } from '../src/state/communities';
import { setController, type Controller } from '../src/state/controller';
import { MessageItem, setEagerMessageToolbar } from '../src/components/MessageItem';
import { acc, msg } from './helpers/fakeApi';

/**
 * 툴바는 **행에 손이 닿은 뒤에만** 마운트된다(채널 전환 버벅임, 2026-09-29). 행 수백 개를
 * 새로 그리는 비용의 절반 가까이가 숨어 있는 툴바였다. 여기서는 제품의 기본값(지연)으로
 * 되돌려 세 가지를 잰다: 처음엔 없다 · 포인터나 포커스로 선다 · 한 번 서면 떠나도 남는다.
 */
beforeEach(() => {
  setEagerMessageToolbar(false);
  setController({ openThread: vi.fn() } as unknown as Controller);
  useAppStore.getState().reset();
  useAppStore.getState().set({ me: acc('u1', 'admin'), accounts: { u1: acc('u1', 'admin') } });
});
afterEach(() => { cleanup(); setEagerMessageToolbar(true); });

const toolbar = () => screen.queryByRole('toolbar', { name: 'message toolbar' });
const row = () => screen.getByText('안녕').closest('.group') as HTMLElement;

describe('lazy message toolbar', () => {
  it('is not mounted until the row is touched', () => {
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);
    expect(toolbar()).toBeNull();
  });

  it('mounts when the pointer enters the row, and stays after it leaves', () => {
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);
    fireEvent.mouseEnter(row());
    expect(toolbar()).not.toBeNull();
    fireEvent.mouseLeave(row());
    expect(toolbar()).not.toBeNull();
  });

  it('mounts when focus enters the row (keyboard path)', () => {
    render(<MessageItem message={msg('m1', 'c1', 1, '안녕', 'u1')} />);
    fireEvent.focus(row());
    expect(toolbar()).not.toBeNull();
  });
});
