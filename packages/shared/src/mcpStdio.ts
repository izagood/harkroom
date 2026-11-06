/**
 * 앱에서 넣는 stdio MCP 정의의 문법 — 화면·오퍼레이터가 같이 쓴다(브라우저에서도 읽히게 node 의존이 없다).
 * 같은 상한과 글자 검사를 Rust(`mcp_stdio_confirm.rs`)가 OS 확인창을 띄우기 전에 다시 잰다. 창에 보이는 글자가 곧
 * 저장되는 글자여야 하므로 안 보이는 글자를 거절하고, 창이 잘리지 않도록 길이를 묶는다 — 잘라서 보이지 않는다.
 */
export const MCP_STDIO_LIMITS = { command: 512, arg: 512, args: 24, total: 1500, envs: 32, envValue: 8192 } as const;

/** 맨 이름(PATH 에서 찾는다) 또는 절대 경로. `./x`·`a/b` 는 턴의 작업 폴더(저장소)에 달려 있어 받지 않는다. */
const BARE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
/** 제어·서식(방향 바꾸기·폭 없는 글자)·줄 나눔 글자. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/**
 * 값을 바꾸면 실행되는 코드가 바뀌는 변수. 확인창에는 env 의 이름만 보이므로(값에 토큰이 있다) 앱에서는 받지 않는다.
 * 코드 적재 변수뿐 아니라 패키지 실행기의 설정(`npm_config_registry`), 설정을 읽는 자리(`HOME`·`XDG_*`), 받는 길(`*_PROXY`)도
 * 든다 — 창에는 평범한 `npx -y <패키지>` 만 보이는데 다른 코드를 받아 돌리는 길이다. 대소문자를 가리지 않는다.
 */
const CODE_LOADING_ENV = /^(DYLD_.*|LD_.*|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONSTARTUP|PYTHONHOME|PERL5OPT|PERL5LIB|RUBYOPT|RUBYLIB|BASH_ENV|ENV|ZDOTDIR|PATH|NPM_CONFIG_.*|PIP_.*|UV_.*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|LUA_.*|GIT_.*|HOME|XDG_.*|.*_PROXY)$/i;

export type McpStdioProblem =
  | 'command-empty' | 'command-shape' | 'command-too-long' | 'text-invisible' | 'text-spacing'
  | 'args-too-many' | 'arg-too-long' | 'total-too-long';

/** 확인창에 그대로 보일 글자인가. 공백을 길게 늘여 뒤 인자를 창 밖으로 미는 것도 막는다. */
function visibleProblem(text: string): McpStdioProblem | null {
  if (INVISIBLE.test(text)) return 'text-invisible';
  if (/\s{4,}/.test(text)) return 'text-spacing';
  return null;
}

export function checkMcpStdioCommand(command: string, args: readonly string[]): McpStdioProblem | null {
  if (!command) return 'command-empty';
  if (command.length > MCP_STDIO_LIMITS.command) return 'command-too-long';
  const shown = visibleProblem(command);
  if (shown) return shown;
  if (command !== command.trim()) return 'command-shape';
  const absolute = command.startsWith('/') && !command.split('/').includes('..');
  if (!absolute && !BARE_COMMAND.test(command)) return 'command-shape';
  if (args.length > MCP_STDIO_LIMITS.args) return 'args-too-many';
  let total = command.length;
  for (const arg of args) {
    if (arg.length > MCP_STDIO_LIMITS.arg) return 'arg-too-long';
    const p = visibleProblem(arg);
    if (p) return p;
    total += arg.length;
  }
  return total > MCP_STDIO_LIMITS.total ? 'total-too-long' : null;
}

export type McpEnvProblem = 'env-key' | 'env-code-loading';

export function checkMcpEnvKey(key: string): McpEnvProblem | null {
  if (!ENV_KEY.test(key)) return 'env-key';
  return CODE_LOADING_ENV.test(key) ? 'env-code-loading' : null;
}

/** 지금 env 값을 그대로 둘 수 있나 — 명령과 인자가 같을 때만이다. 토큰은 그 프로그램에 준 것이다. */
export function sameMcpProgram(a: { command: string; args: readonly string[] }, b: { command: string; args: readonly string[] }): boolean {
  return a.command === b.command && a.args.length === b.args.length && a.args.every((x, i) => x === b.args[i]);
}
