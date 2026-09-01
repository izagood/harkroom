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
