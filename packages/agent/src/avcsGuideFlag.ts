/**
 * `workspace.guide` 에 실을 `avcs` 플래그 — "이 러너가 띄우는 하네스가 avcs MCP 를 실제로 띄울 수 있는가".
 *
 * 오퍼레이터와 codex 프리셋은 avcs MCP 를 언제나 `avcs mcp`(stdio)로 넣는다(`operator/src/mcpConfig.ts`,
 * `turn.ts` 의 codex `-c`). 그러니 그 MCP 가 뜨는지는 **`avcs` 실행 파일이 하네스의 PATH 에서 풀리는가**와 같다.
 * 하네스의 PATH 는 이 러너의 `process.env.PATH` 다 — 오퍼레이터가 러너를 띄울 때 로그인 셸 PATH 를 넣어 주고
 * (`operator/src/assignments.ts`), 러너는 그것을 하네스에 그대로 물려준다(`harnessPath` 는 뒤에 하네스 폴백만 붙인다).
 *
 * **모르면 보내지 않는다.** `false` 는 서버가 avcs 절(「읽기 전용 요청엔 avcs 오브젝트를 만들지 않는다」 경계 포함)을
 * 빼는 신호라, 잘못 보내면 avcs 를 쓰는 에이전트가 그 경계를 잃는다. 그래서:
 * - PATH 가 없거나 비었다 → 잴 수 없다 → `undefined`(인자를 빼면 서버는 전문을 준다).
 * - PATH 에서 `avcs` 가 풀린다 → `true`.
 * - PATH 가 있는데 어느 디렉터리에도 실행 가능한 `avcs` 가 없다 → `false`.
 */
import { delimiter } from 'node:path';
import { resolveExecutable } from './pty.js';

export function avcsGuideFlag(
  path: string | undefined,
  resolve: (command: string, path: string | undefined) => string | null = resolveExecutable,
): boolean | undefined {
  if (!path || path.split(delimiter).every((dir) => dir.trim() === '')) return undefined;
  return resolve('avcs', path) !== null;
}
