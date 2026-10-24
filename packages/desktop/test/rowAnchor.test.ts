/**
 * 손 앵커(`rowAnchor.ts`) — WKWebView 에는 스크롤 앵커링이 없다. 누른 줄이 사라져도 바로 아래 줄이 누른 줄 자리에 와야 하고,
 * 그 사이 사람이 굴렸으면 건드리지 않는다. jsdom 은 레이아웃을 재지 않으므로 getBoundingClientRect 를 줄마다 꾸민다.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { captureRowAnchor, restoreRowAnchor } from '../src/lib/rowAnchor';

/** 스크롤 상자 하나 + 줄들. 줄의 화면 위치 = 문서 위치 − scrollTop. */
function setup(rows: { key: string; docTop: number }[]) {
  const scroller = document.createElement('main');
  scroller.style.overflowY = 'auto';
  const list = document.createElement('div');
  scroller.appendChild(list);
  document.body.appendChild(scroller);
  let st = 0;
  Object.defineProperty(scroller, 'scrollTop', { get: () => st, set: (v: number) => { st = v; }, configurable: true });
  scroller.getBoundingClientRect = () => ({ top: 0 } as DOMRect);
  const pos = new Map<string, number>();
  const add = (key: string, docTop: number) => {
    const el = document.createElement('div');
    el.setAttribute('data-anchor-key', key);
    el.getBoundingClientRect = () => ({ top: (pos.get(key) ?? 0) - st } as DOMRect);
    pos.set(key, docTop);
    list.appendChild(el);
    return el;
  };
  const els = rows.map((r) => add(r.key, r.docTop));
  return { scroller, els, pos, setScroll: (v: number) => { st = v; } };
}

afterEach(() => { document.body.innerHTML = ''; });

describe('rowAnchor', () => {
  it('누른 줄이 사라지고 위 칸이 한 줄 길어져도, 아래 줄이 누른 줄 자리에 온다', () => {
    const { scroller, els, pos, setScroll } = setup([{ key: 'a', docTop: 1000 }, { key: 'b', docTop: 1072 }, { key: 'c', docTop: 1144 }]);
    setScroll(990); // a 가 화면 10px 에
    const anchor = captureRowAnchor(els[0]!);
    // 새 원장: 위 칸에 한 줄(+60) 생기고 a 는 빠진다 → b 는 1072+60−72 = 1060
    els[0]!.remove(); pos.set('b', 1060); pos.set('c', 1132);
    restoreRowAnchor(anchor);
    expect(els[1]!.getBoundingClientRect().top).toBe(10); // a 가 있던 자리
    expect(scroller.scrollTop).toBe(1050);
  });
  it('마지막 줄을 누르면 위 줄을 제자리에 둔다', () => {
    const { els, pos, setScroll } = setup([{ key: 'a', docTop: 1000 }, { key: 'b', docTop: 1072 }]);
    setScroll(1000);
    const anchor = captureRowAnchor(els[1]!);
    els[1]!.remove(); pos.set('a', 1060);
    restoreRowAnchor(anchor);
    expect(els[0]!.getBoundingClientRect().top).toBe(0);
  });
  it('그 사이 사람이 굴렸으면 되돌리지 않는다', () => {
    const { scroller, els, pos, setScroll } = setup([{ key: 'a', docTop: 1000 }, { key: 'b', docTop: 1072 }]);
    setScroll(990);
    const anchor = captureRowAnchor(els[0]!);
    setScroll(500);
    els[0]!.remove(); pos.set('b', 1060);
    restoreRowAnchor(anchor);
    expect(scroller.scrollTop).toBe(500);
  });
  it('self: 묶음 막대처럼 그 요소 자체를 제자리에', () => {
    const { els, pos, setScroll } = setup([{ key: 'bar', docTop: 800 }, { key: 'x', docTop: 900 }]);
    setScroll(700);
    const anchor = captureRowAnchor(els[0]!, 'self');
    pos.set('bar', 1100); // 위 칸에 여러 줄이 생겼다
    restoreRowAnchor(anchor);
    expect(els[0]!.getBoundingClientRect().top).toBe(100);
  });
  it('스크롤 상자가 없거나 줄이 아니면 붙잡지 않는다', () => {
    expect(captureRowAnchor(null)).toBeNull();
    const loose = document.createElement('div');
    document.body.appendChild(loose);
    expect(captureRowAnchor(loose)).toBeNull();
  });
});
