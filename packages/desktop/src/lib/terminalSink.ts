// 바이트를 화면의 터미널에 그리는 것(#141). xterm.js 를 이 파일 뒤에 숨긴다.
//
// **왜 이음새를 두는가**: xterm 은 `Terminal#open` 에서 캔버스·`getComputedStyle` 을 만지고,
// jsdom 에는 그 표면이 온전하지 않다. 패널 컴포넌트가 xterm 을 직접 import 하면 패널의
// 렌더·구독 수명 테스트가 xterm 이 jsdom 에서 뜨는지에 걸리고, 그건 이 테스트가 지키려는
// 성질(패널을 닫으면 구독이 끊긴다)과 아무 관계가 없다. `state/controller.ts` 의
// `setController` 와 같은 모양의 이음새다.
//
// 기본 구현은 xterm 을 **동적으로** import 한다 — 그래서 가짜를 꽂은 테스트에서는 xterm
// 모듈이 아예 로드되지 않는다.

export interface TerminalSink {
  /** PTY raw 바이트. 디코드는 xterm 의 상태 기계가 한다. */
  write(bytes: Uint8Array): void;
  dispose(): void;
}

export type TerminalSinkFactory = (el: HTMLElement) => TerminalSink;

/**
 * xterm 을 붙이는 실제 구현. `import()` 가 끝나기 전에 도착한 바이트는 **큐에 담고
 * 도착 순서 그대로** 쓴다.
 *
 * 버리면 안 되는 이유: attach 직후 서버가 보내는 첫 프레임이 ring buffer 재생이다 —
 * 그것을 버리면 사람이 보는 화면이 "붙은 순간부터"가 되어, 진행 중인 턴에 붙는다는
 * 이 기능의 값이 사라진다. 순서를 지키면 되는 이유: 서버가 이미 뷰어별로 재생 → 라이브
 * 순서를 보장하므로(스펙 §5), 도착 순서대로 쓰면 그 보장이 화면까지 그대로 온다.
 */
const xtermSink: TerminalSinkFactory = (el) => {
  const pending: Uint8Array[] = [];
  let term: { write(data: Uint8Array): void; dispose(): void } | null = null;
  let disposed = false;

  void (async () => {
    const { Terminal } = await import('@xterm/xterm');
    if (disposed) return;
    const t = new Terminal({
      // 스크롤백은 러너의 ring buffer(256KB)가 재생하는 만큼이면 충분하다 — 여기서 더
      // 크게 잡아도 그 이상은 애초에 오지 않는다.
      scrollback: 5_000,
      convertEol: false,
      fontSize: 12,
    });
    t.open(el);
    term = t;
    for (const chunk of pending) t.write(chunk);
    pending.length = 0;
  })().catch(() => { /* 터미널을 못 띄운 것으로 패널을 죽이지 않는다 */ });

  return {
    write(bytes) {
      if (term) term.write(bytes);
      else pending.push(bytes);
    },
    dispose() {
      disposed = true;
      pending.length = 0;
      term?.dispose();
      term = null;
    },
  };
};

let factory: TerminalSinkFactory = xtermSink;

export function setTerminalSinkFactory(next: TerminalSinkFactory): void {
  factory = next;
}

export function getTerminalSinkFactory(): TerminalSinkFactory {
  return factory;
}
