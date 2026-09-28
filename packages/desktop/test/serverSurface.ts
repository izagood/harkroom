/**
 * `src/lib/api.ts` 가 부르는 **서버 표면**(메서드 + 경로)을 소스 글에서 뽑는다.
 *
 * 경로 안의 `${…}` 는 이름과 상관없이 `:p` 로, 쿼리(`?…` 또는 끝의 `${qs}`)는 떼어 낸다 —
 * 같은 라우트를 부르는 두 줄이 인자 이름만 달라서 다른 표면으로 세어지지 않게.
 * `serverSurface.test.ts` 가 이 결과를 `serverSurface.json` 과 견준다.
 */
export function extractServerSurface(src: string): string[] {
  const out = new Set<string>();
  const norm = (path: string): string => path
    .replace(/\?.*$/, '')
    .replace(/\$\{[^}]*\}$/, (m, off: number, s: string) => (s[off - 1] === '/' ? ':p' : ''))
    .replace(/\$\{[^}]*\}/g, ':p');
  // this.req('GET', '/x') · this.req<T>(\n 'GET', `/x/${id}`) · this.reqWithHeaders<T>('POST', …)
  const call = /\b(?:req|reqWithHeaders)(?:<[^()]*?>)?\(\s*'([A-Z]+)'\s*,\s*(['`])([^'`]*)\2/g;
  for (const m of src.matchAll(call)) out.add(`${m[1]} ${norm(m[3]!)}`);
  // 바이트를 받는 자리는 fetch 를 바로 쓴다(메서드는 GET). `${path}` 만 받는 req 본체는 뺀다.
  const raw = /fetch\(`\$\{this\.baseUrl\}(\/[^`]*)`/g;
  for (const m of src.matchAll(raw)) out.add(`GET ${norm(m[1]!)}`);
  return [...out].sort();
}
