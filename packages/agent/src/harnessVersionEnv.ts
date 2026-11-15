/**
 * `<하네스> --version` 을 물을 env(`main.ts` `harnessVersion`). PATH·HOME 만 주되:
 * - omp 는 natives 캐시를 `$HOME/.omp` 에서 실행 코드로 싣는다(security C3) — 러너 omp 홈의 HOME 을 준다.
 * - codex 는 `--version` 에도 `$CODEX_HOME/tmp/arg0` 에 도우미 링크·잠금을 만든다(없으면 사람 `~/.codex`) — **러너 codex 홈을
 *   `CODEX_HOME`** 으로 준다. 러너 codex 홈을 모르면 `null`(묻지 않는다).
 */
export function harnessVersionEnv(opts: {
  /** 하네스 PATH(`harnessPath`). */
  path: string;
  /** 사람 HOME(없으면 싣지 않는다). */
  home: string | undefined;
  /** omp 면 러너 omp 홈의 HOME, 아니면 undefined. */
  ompHome?: string;
  /** codex 면 러너 codex 홈, 아니면 undefined. */
  codexHome?: string;
  codex: boolean;
}): Record<string, string> | null {
  if (opts.codex && !opts.codexHome) return null;
  const home = opts.ompHome ?? opts.home;
  return {
    PATH: opts.path,
    ...(home ? { HOME: home } : {}),
    ...(opts.codex && opts.codexHome ? { CODEX_HOME: opts.codexHome } : {}),
  };
}
