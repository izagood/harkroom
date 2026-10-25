import { describe, expect, it, vi } from 'vitest';
import { attachReadOnlyWheel } from '../src/lib/terminalSink';

/**
 * 못 치는 창의 휠(2026-10-25). TUI 가 마우스 추적을 켜면 xterm 은 휠을 PTY 로 보내고 취소하는데, 읽기 전용 창은
 * 그것을 버려 스크롤이 죽었다 — 그때만 xterm 보다 먼저 받아 화면을 올린다.
 */
function setup(state: { blocked: boolean; eats: boolean }) {
  const host = document.createElement('div');
  const inner = document.createElement('div');
  host.appendChild(inner);
  document.body.appendChild(host);
  const scrollLines = vi.fn();
  const xtermWheel = vi.fn();
  inner.addEventListener('wheel', xtermWheel);
  const detach = attachReadOnlyWheel(host, {
    blocked: () => state.blocked,
    eatsWheel: () => state.eats,
    lineHeight: () => 15,
    scrollLines,
  });
  const wheel = (deltaY: number, deltaMode = 0) => {
    const ev = new WheelEvent('wheel', { deltaY, deltaMode, bubbles: true, cancelable: true });
    inner.dispatchEvent(ev);
    return ev;
  };
  return { scrollLines, xtermWheel, wheel, detach };
}

describe('attachReadOnlyWheel', () => {
  it('못 치는 창 + 마우스 추적이면 휠을 가로채 줄 단위로 스크롤한다', () => {
    const s = setup({ blocked: true, eats: true });
    const ev = s.wheel(-45);
    expect(s.scrollLines).toHaveBeenCalledWith(-3);
    expect(ev.defaultPrevented).toBe(true);
    // xterm 의 리스너(마우스 보고)에 닿지 않는다.
    expect(s.xtermWheel).not.toHaveBeenCalled();
  });

  it('픽셀 조각은 모아서 한 줄이 되면 보낸다', () => {
    const s = setup({ blocked: true, eats: true });
    s.wheel(5); s.wheel(5);
    expect(s.scrollLines).not.toHaveBeenCalled();
    s.wheel(5);
    expect(s.scrollLines).toHaveBeenCalledWith(1);
  });

  it('줄 단위 휠은 그대로 줄 수다', () => {
    const s = setup({ blocked: true, eats: true });
    s.wheel(2, 1);
    expect(s.scrollLines).toHaveBeenCalledWith(2);
  });

  it('칠 수 있는 창은 TUI 에 맡긴다', () => {
    const s = setup({ blocked: false, eats: true });
    const ev = s.wheel(-45);
    expect(s.scrollLines).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
    expect(s.xtermWheel).toHaveBeenCalled();
  });

  it('마우스 추적이 꺼져 있으면 xterm 이 스스로 스크롤하게 둔다', () => {
    const s = setup({ blocked: true, eats: false });
    s.wheel(-45);
    expect(s.scrollLines).not.toHaveBeenCalled();
    expect(s.xtermWheel).toHaveBeenCalled();
  });

  it('떼면 더 가로채지 않는다', () => {
    const s = setup({ blocked: true, eats: true });
    s.detach();
    s.wheel(-45);
    expect(s.scrollLines).not.toHaveBeenCalled();
    expect(s.xtermWheel).toHaveBeenCalled();
  });
});
