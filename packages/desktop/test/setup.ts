import { vi } from 'vitest';

// #392: 지연 주입 통제 실험 전용. 무엇을 어떻게 쟀고 무엇이 빨개졌는지는
// docs/specs/2026-09-05-timing-delay-injection.md 에 있다 — 실측 결과가 이슈의 산출물이다.
// MURMUR_TEST_DELAY_MS 를 안 주면 이 블록은 아무 것도
// 안 한다(바이트 하나 안 바뀐 채 기존 스위트가 돈다). env 를 주면 React scheduler 가 매
// 렌더마다 예약하는 macrotask 펌프(Node/jsdom 은 setImmediate, 없으면 MessageChannel)를
// N ms 늦춰 "waitFor 뒤 상태가 실제로는 아직 안 끝났다" 계열 결함을 재현한다(#333·#367 과
// 같은 방식). 대상은 이 두 펌프뿐이다 — setTimeout/setInterval 은 건드리지 않는다.
//
// vi.useFakeTimers() 와 공존하려면 반드시 매 호출마다 vi.isFakeTimers() 로 비켜야 한다.
// 이유: vitest 의 FakeTimers 는 지연 생성 singleton(`_timers ||= new FakeTimers(...)`)이라
// **테스트 안에서 처음 vi.useFakeTimers() 가 불릴 때** 그 시점의 global.setImmediate 를
// "되돌릴 원본"으로 캡처한다. 그때 global.setImmediate 가 이미 이 wrapper 면, sinon 내부
// tickAsync 가 매 스텝마다 이 wrapper 를 거쳐 실제 setTimeout(N ms) 을 기다리게 되고,
// advanceTimersByTimeAsync 가 반복 호출될 때마다 지연이 누적돼 결국 테스트 타임아웃으로
// 죽는다(Controller #267 두 건에서 이렇게 재현됨 — 180s 타임아웃). vi.isFakeTimers() 가
// true 인 동안은 지연 없이 즉시 원래 펌프에 위임해 이 경로를 완전히 비킨다.
const __delayMs = Number(process.env.MURMUR_TEST_DELAY_MS ?? '0');
if (__delayMs > 0) {
  // 늦춰 둔 펌프는 jsdom 환경이 헐린 뒤에 깨어날 수 있다. 파일의 마지막 렌더가 예약한
  // 콜백이 그렇게 깨어나면 React scheduler 안에서 `window is not defined` 로 터진다
  // (파일 단위 병렬 실행이라 매번 다른 파일에 붙는다 — 제품 결함이 아니라 이 주입기가
  // 만든 잔여 타이머다). 깨어날 때 환경이 아직 살아 있는지 보고, 헐렸으면 조용히 버린다.
  // afterEach 로 일괄 취소하면 테스트 도중 정상 대기 중인 펌프까지 죽어 스위트가 무너진다.
  const defer = (run: () => void) => {
    const handle = setTimeout(() => {
      if (typeof globalThis.window === 'undefined') return;
      run();
    }, __delayMs);
    // 남은 타이머가 vitest 를 붙잡지 않게 한다 — 지연은 재현용이지 수명 연장용이 아니다.
    (handle as unknown as { unref?: () => void }).unref?.();
  };

  const realSetImmediate = globalThis.setImmediate;
  if (typeof realSetImmediate === 'function') {
    globalThis.setImmediate = ((fn: (...args: unknown[]) => void, ...args: unknown[]) => {
      if (vi.isFakeTimers()) return realSetImmediate(fn, ...args);
      return realSetImmediate(() => defer(() => fn(...args)));
    }) as typeof globalThis.setImmediate;
  }

  const RealMessageChannel = globalThis.MessageChannel;
  if (typeof RealMessageChannel === 'function') {
    globalThis.MessageChannel = class DelayedMessageChannel extends RealMessageChannel {
      constructor() {
        super();
        const realPostMessage = this.port2.postMessage.bind(this.port2);
        this.port2.postMessage = ((message: unknown, transfer?: Transferable[]) => {
          if (vi.isFakeTimers()) {
            realPostMessage(message, transfer ?? []);
            return;
          }
          defer(() => realPostMessage(message, transfer ?? []));
        }) as typeof this.port2.postMessage;
      }
    } as typeof MessageChannel;
  }
}

// jsdom에는 matchMedia가 없다 — 컴포넌트가 미디어쿼리를 만져도 죽지 않게 스텁.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

// jsdom에는 objectURL이 없다. 첨부 미리보기는 blob → objectURL 경로를 지나므로 스텁이 필요하다
// (토큰을 URL에 넣지 않기 위해 바이트를 fetch로 받는 설계의 결과다).
let objectUrlSeq = 0;
URL.createObjectURL = () => `blob:murmur/${++objectUrlSeq}`;
URL.revokeObjectURL = () => {};
