/**
 * 에이전트 권한 요청(스레드 f61af808) — Claude Code allow 규칙 하나를 재는 판정. 서버가 요청·승인 때 쓰고, 데스크톱 카드·설정
 * 화면이 같은 결과로 경고 띠를 그린다(그래서 Node 의존 없이 shared 에 둔다).
 *
 * 원칙: **분류기를 끄지 않고 allow 를 정확히 더한다**(D4). 받는 모양은 셋뿐이다.
 * - `Bash(<명령 접두>:*)` — 고정 낱말이 둘 이상인 접두(`kubectl:*` 처럼 낱말 하나면 그 도구 전부가 열린다)
 * - `Bash(<명령 전체>)` — 정확히 그 명령
 * - `mcp__<server>__<tool>` — MCP 도구 하나
 *
 * 거절(`ok:false`)은 서버가 요청 단계에서 받지 않는다. 경고(`warnings`)는 받되 카드에 빨간 띠로 보인다 — `kubectl exec` 처럼
 * 실행형이지만 일에 꼭 필요한 것을 막지 않기 위해서다(D4).
 */

export type ToolRuleRefusal =
  | 'empty' | 'too_long' | 'unsupported_tool' | 'wildcard' | 'too_broad' | 'shell_syntax'
  | 'dangerous_flag' | 'interpreter' | 'operator_wrapper' | 'merge_bypass';

export type ToolRuleWarning = 'executes_in_workload' | 'mutates_remote' | 'short_prefix';

export type ToolRuleVerdict =
  | { ok: true; rule: string; kind: 'bash_prefix' | 'bash_exact' | 'mcp_tool'; warnings: ToolRuleWarning[] }
  | { ok: false; code: ToolRuleRefusal };

export const TOOL_RULE_MAX_CHARS = 300;

/** 첫 낱말이 이것이면 그 뒤에 무엇이든 돌릴 수 있다 — 셸·인터프리터·남의 명령을 대신 돌리는 것. */
const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'env', 'sudo', 'su', 'doas', 'xargs', 'eval', 'exec',
  'command', 'builtin', 'nohup', 'time', 'timeout', 'nice', 'watch', 'script', 'osascript', 'open',
  'python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'npx', 'pnpx', 'bunx', 'uvx',
]);

/** 셸 문법 — 이 글자가 있으면 규칙 하나가 명령 둘을 덮거나 claude 의 조각 판정과 어긋난다. */
const SHELL_SYNTAX = /[;&|`<>\n\r]|\$\(|\$\{/;

/** (첫 낱말, 하위 명령) — 원격 작업 부하 안에서 임의 명령을 돌린다. */
const EXEC_SUBCOMMANDS: Record<string, readonly string[]> = {
  kubectl: ['exec', 'debug', 'attach', 'cp', 'port-forward', 'run'],
  oc: ['exec', 'debug', 'rsh', 'cp', 'port-forward'],
  docker: ['exec', 'run'],
  ssh: ['*'],
};

/** (첫 낱말, 하위 명령) — 원격 상태를 바꾼다. */
const MUTATE_SUBCOMMANDS: Record<string, readonly string[]> = {
  kubectl: ['delete', 'apply', 'patch', 'edit', 'replace', 'scale', 'drain', 'cordon', 'uncordon', 'rollout', 'annotate', 'label', 'create', 'set', 'taint'],
  helm: ['install', 'upgrade', 'uninstall', 'rollback', 'delete'],
  git: ['push'],
  gh: ['api'],
  terraform: ['apply', 'destroy', 'import'],
  rm: ['*'],
};

/** 첫 낱말 뒤 옵션(`--context X`, `-n Y`, `-R owner/repo`)을 건너뛰고 하위 명령 하나를 찾는다. */
function subcommandOf(words: readonly string[]): string | null {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith('-')) {
      // `--flag=value` 는 한 낱말, `--flag value`·`-n value` 는 다음 낱말까지.
      if (!w.includes('=') && i + 1 < words.length && !words[i + 1]!.startsWith('-')) i++;
      continue;
    }
    return w;
  }
  return null;
}

function hits(table: Record<string, readonly string[]>, head: string, sub: string | null): boolean {
  const subs = table[head];
  if (!subs) return false;
  return subs.includes('*') || (sub !== null && subs.includes(sub));
}

export function validateToolRule(input: string): ToolRuleVerdict {
  const rule = input.trim();
  if (!rule) return { ok: false, code: 'empty' };
  if (rule.length > TOOL_RULE_MAX_CHARS) return { ok: false, code: 'too_long' };
  if (/--dangerously/i.test(rule)) return { ok: false, code: 'dangerous_flag' };

  if (/^mcp__[a-z0-9_-]+__[a-z0-9_-]+$/i.test(rule)) {
    // 우리 harkroom MCP 는 서버가 도구마다 판정한다 — allow 로 분류기를 건너뛰게 할 이유가 없다(grant.delegate 처럼 러너가 따로 연다).
    if (/^mcp__harkroom__/i.test(rule)) return { ok: false, code: 'unsupported_tool' };
    return { ok: true, rule, kind: 'mcp_tool', warnings: [] };
  }

  const m = /^Bash\((.*)\)$/s.exec(rule);
  if (!m) return { ok: false, code: 'unsupported_tool' };
  let body = m[1]!.trim();
  const prefix = body.endsWith(':*');
  if (prefix) body = body.slice(0, -2).trim();
  if (!body || body === '*') return { ok: false, code: 'too_broad' };
  if (body.includes('*')) return { ok: false, code: 'wildcard' };
  if (SHELL_SYNTAX.test(body)) return { ok: false, code: 'shell_syntax' };

  const words = body.split(/\s+/);
  const head = words[0]!.split('/').pop()!.toLowerCase();
  if (INTERPRETERS.has(head)) return { ok: false, code: 'interpreter' };
  if (/harkroom-operator/i.test(body)) return { ok: false, code: 'operator_wrapper' };
  const sub = subcommandOf(words);
  // 머지는 래퍼로만 간다(turn.ts MERGE_DENY_RULES) — allow 로 그 deny 를 흐리는 요청은 받지 않는다.
  if (head === 'gh' && sub === 'pr' && words.includes('merge')) return { ok: false, code: 'merge_bypass' };
  if (head === 'gh' && sub === 'api' && /(^|\s)(-X|--method)(\s+|=)PUT\b/i.test(body)) return { ok: false, code: 'merge_bypass' };
  if (prefix && words.length < 2) return { ok: false, code: 'too_broad' };

  const warnings: ToolRuleWarning[] = [];
  if (hits(EXEC_SUBCOMMANDS, head, sub)) warnings.push('executes_in_workload');
  if (hits(MUTATE_SUBCOMMANDS, head, sub)) warnings.push('mutates_remote');
  if (prefix && words.length < 3) warnings.push('short_prefix');
  const normalized = `Bash(${words.join(' ')}${prefix ? ':*' : ''})`;
  return { ok: true, rule: normalized, kind: prefix ? 'bash_prefix' : 'bash_exact', warnings };
}

/**
 * `tool.allow` grant 의 scope — `tool:<channelId>:<규칙>`. 채널 id 를 넣는 이유는 D2(요청한 채널에만 적용)이고, 이 하나가
 * PK 의 일부라 같은 규칙도 채널마다 따로 주고 거둔다.
 */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const TOOL_SCOPE_RE = new RegExp(`^tool:(${UUID}):(.+)$`, 's');

export function toolScope(channelId: string, rule: string): string {
  return `tool:${channelId}:${rule}`;
}

export function parseToolScope(scope: string): { channelId: string; rule: string } | null {
  const m = TOOL_SCOPE_RE.exec(scope);
  return m ? { channelId: m[1]!, rule: m[2]! } : null;
}
