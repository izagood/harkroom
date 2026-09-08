// `packages/agent/src/version.ts` 가 구운 값을 읽는 방식 **그대로**를 최소로 재현한다.
// 러너 전체를 번들해서 재면 그 회귀선이 러너의 의존 그래프에 매인다 — 여기서 재는 것은
// esbuild `define` 이 그 식별자를 치환하는가 하나다.
const baked = typeof __AGENT_VERSION__ === 'string' && __AGENT_VERSION__ !== ''
  ? __AGENT_VERSION__
  : null;
console.log(`BAKED:${process.env.AGENT_VERSION ?? baked ?? 'unknown'}`);
