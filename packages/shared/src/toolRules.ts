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
  | 'dangerous_flag' | 'interpreter' | 'operator_wrapper' | 'merge_bypass' | 'bad_chars' | 'gh_api_write'
  /** 정확한 명령만(H②, security n1): 첫 낱말이 `NAME=값` — `LD_PRELOAD=`·`PATH=` 로 명령의 뜻을 바꾼다. */
  | 'env_prefix'
  /** 정확한 명령만(H③a, security C1~C4). */
  | 'path_head' | 'relative_path' | 'glued_flag' | 'needs_kubeconfig';

export type ToolRuleWarning = 'executes_in_workload' | 'mutates_remote' | 'runs_arbitrary' | 'short_prefix'
  /** 정확한 명령만(H②, security F1): 파일을 읽어 그 내용대로 움직인다 — 승인은 글자에 묶이고 파일 내용은 범위 밖이다. */
  | 'reads_file';

export type ToolRuleVerdict =
  | { ok: true; rule: string; kind: 'bash_prefix' | 'bash_exact' | 'mcp_tool'; warnings: ToolRuleWarning[] }
  | { ok: false; code: ToolRuleRefusal };

export const TOOL_RULE_MAX_CHARS = 300;

/** 첫 낱말이 이것이면 그 뒤에 무엇이든 돌릴 수 있다 — 셸·인터프리터·남의 명령을 대신 돌리는 것. */
const INTERPRETERS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh', 'env', 'sudo', 'su', 'doas', 'xargs', 'eval', 'exec',
  'command', 'builtin', 'nohup', 'time', 'timeout', 'nice', 'watch', 'script', 'osascript', 'open',
  'python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'lua', 'npx', 'pnpx', 'bunx', 'uvx',
  // security F2: 남의 명령을 감싸 돌리는 것들.
  'caffeinate', 'stdbuf', 'unbuffer', 'chroot', 'setsid', 'flock', 'busybox', 'strace', 'ltrace', 'gdb', 'lldb', 'expect',
  'ionice', 'taskset', 'pkexec', 'runuser', 'systemd-run', 'launchctl', 'arch', 'chronic', 'doppler', 'op',
]);

/** 규칙 본문에 허락하는 글자. 쉼표는 없다 — `--allowedTools` 가 쉼표로 규칙을 가를 수 있다(F1). */
const BODY_CHARS = /^[A-Za-z0-9 _./@=:+%-]+$/;

/** 버전이 붙은 인터프리터(`python3.12`·`node22`·`pwsh7`)와 셸(F2). */
const INTERPRETER_VERSIONED = /^(python|node|ruby|perl|php|lua|luajit|pwsh|powershell|bash|zsh|ksh|tclsh|wish|irb|jshell|R|Rscript)[\d.]*$/i;

/** gh 하위 명령의 고정 낱말(옵션과 그 값을 건너뛴 것). */
function positionals(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (w.startsWith('-')) {
      if (!w.includes('=') && /^-[A-Za-z]$|^--[a-z-]+$/.test(w) && i + 1 < words.length && !words[i + 1]!.startsWith('-')) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

/**
 * gh 는 머지 deny(`gh pr merge:*` 접두)를 옆으로 도는 길이 많다(security F3) — `gh -R o/r pr merge`, `gh api …/merge -X PUT`,
 * `gh api graphql`(mergePullRequest), `-XPUT` 붙여 쓰기. 그래서 gh 는 따로 좁게 본다:
 * - `merge` 낱말은 어디에 있든 거절. `alias`·`extension` 도(머지를 다른 이름으로 감쌀 수 있다).
 * - `gh api` 는 접두 규칙을 받지 않고, 정확 규칙도 메서드·필드·입력·graphql 이 있으면 거절(읽기 GET 한 줄만).
 * - 그 밖의 gh 접두 규칙은 하위 명령 **두 단계**(`gh pr view`)를 고정해야 받는다.
 */
function checkGh(words: readonly string[], prefix: boolean): ToolRuleRefusal | null {
  if (words.some((w) => /merge/i.test(w))) return 'merge_bypass';
  const pos = positionals(words);
  if (pos[0] === 'alias' || pos[0] === 'extension' || pos[0] === 'ext') return 'merge_bypass';
  // `gh repo sync` 는 대상의 기본 브랜치를 source 로 덮는다(`--force` 면 hard reset) — main 에 넣는 것과 같다(security F5).
  if (pos[0] === 'repo' && pos[1] === 'sync') return 'merge_bypass';
  if (pos[0] === 'api') {
    if (prefix) return 'gh_api_write';
    const writes = words.some((w) => /^(-X|--method)/.test(w) || /^-[fF]/.test(w) || /^--(field|raw-field|input)/.test(w))
      || pos.some((w) => w.toLowerCase() === 'graphql');
    return writes ? 'gh_api_write' : null;
  }
  if (prefix && pos.length < 2) return 'too_broad';
  return null;
}

/**
 * `git push` 로 main 에 바로 넣는 길(security F4) — 에이전트 토큰은 repo 스코프라 main 에 push 하면 머지와 같다. 그래서:
 * - `git push` **접두 규칙은 거절**(뒤에 무엇이든 붙는다).
 * - 정확 규칙은 원격과 refspec 을 **명시**해야 받는다(`git push origin` 만이면 현재 브랜치 — main 일 수 있다).
 * - refspec 에 `main`·`master`·`HEAD`(콜론 꼴 포함)·`refs/heads/`·지우기(`:x`)·`--all`·`--mirror` 가 있으면 거절.
 */
function checkGitPush(words: readonly string[], prefix: boolean): ToolRuleRefusal | null {
  if (!positionals(words).includes('push')) return null;
  if (prefix) return 'merge_bypass';
  if (words.some((w) => /^--(all|mirror)$/.test(w))) return 'merge_bypass';
  // push 뒤의 옵션은 값을 받지 않는 것으로 본다(`-u`·`-f`·`--force-with-lease`) — 남는 첫 낱말이 원격, 그 뒤가 refspec.
  const after = words.slice(words.indexOf('push') + 1).filter((w) => !w.startsWith('-'));
  const refs = after.slice(1);
  if (refs.length === 0) return 'merge_bypass';
  const protectedRef = /(^|[:+])(main|master|head)$|refs\/heads\/|^:/i;
  // `@` 는 HEAD 의 다른 이름이다(security F4a) — `@`·`@:x` 모두 현재 브랜치(main 일 수 있다)를 민다.
  return refs.some((r) => r.includes('@') || protectedRef.test(r) || r.split(':').some((part) => /^(main|master|head)$/i.test(part))) ? 'merge_bypass' : null;
}

/** 경고(n5): 인자로 임의 명령을 돌릴 수 있는 도구 — 받되 카드에 띠를 단다. */
function runsArbitrary(head: string, sub: string | null, words: readonly string[]): boolean {
  if (['awk', 'gawk', 'sed', 'make', 'just', 'ssh', 'tmux', 'screen', 'rsync', 'parallel', 'vim', 'vi', 'nvim', 'emacs', 'java', 'sqlite3', 'tar'].includes(head)) return true;
  if (head === 'git' && sub === 'config') return true;
  if (head === 'find' && words.some((w) => /^-(exec|execdir|ok|okdir)$/.test(w))) return true;
  if (head === 'find') return true; // 접두 규칙이면 뒤에 -exec 를 붙일 수 있다
  if (head === 'git' && words.includes('-c')) return true;
  if (['uv', 'npm', 'pnpm', 'yarn', 'cargo', 'go', 'poetry', 'pipenv', 'bundle', 'mvn', 'gradle'].includes(head)
    && (sub === 'run' || sub === 'exec' || sub === 'x' || sub === 'dlx' || sub === 'test' || sub === 'install')) return true;
  return false;
}

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
  gh: ['api', 'workflow', 'release', 'repo', 'secret', 'variable', 'label', 'issue'],
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
  // 글자 허용 목록(security F1·F2) — 괄호·쉼표(규칙 여럿 끼워 넣기), 따옴표·역슬래시(`"sh"`·`\sh` 로 머리 숨기기),
  // `{}`·`!`·`~`·`$`·`?`·`[]` 은 정상 규칙에 쓸 일이 없다. 막는 쪽이 판정보다 단단하다.
  if (!BODY_CHARS.test(body)) return { ok: false, code: 'bad_chars' };

  const words = body.split(/\s+/);
  const head = words[0]!.split('/').pop()!.toLowerCase();
  if (INTERPRETERS.has(head) || INTERPRETER_VERSIONED.test(head)) return { ok: false, code: 'interpreter' };
  if (/harkroom-operator/i.test(body)) return { ok: false, code: 'operator_wrapper' };
  const sub = subcommandOf(words);
  if (prefix && words.length < 2) return { ok: false, code: 'too_broad' };
  if (head === 'gh') {
    const gh = checkGh(words, prefix);
    if (gh) return { ok: false, code: gh };
  }
  if (head === 'git') {
    const push = checkGitPush(words, prefix);
    if (push) return { ok: false, code: push };
  }

  const warnings: ToolRuleWarning[] = [];
  if (hits(EXEC_SUBCOMMANDS, head, sub)) warnings.push('executes_in_workload');
  if (hits(MUTATE_SUBCOMMANDS, head, sub)) warnings.push('mutates_remote');
  if (runsArbitrary(head, sub, words)) warnings.push('runs_arbitrary');
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

/** 「정확한 명령」이 읽는 파일 하나(H③a, security C1). `secret` 이면 내용(미리 보기)을 서버로 보내지 않는다. */
export interface CommandFileArg { path: string; flag: string; secret: boolean }

export type ExactCommandVerdict =
  | { ok: true; command: string; warnings: ToolRuleWarning[]; files: CommandFileArg[] }
  | { ok: false; code: ToolRuleRefusal };

/**
 * 「정확한 명령」 승인(kind `command`, 권한 요청 H②·H③, 스레드 8769dbf7)의 판정과 정규형. **승인할 때(서버)·파일 해시를 잴 때(오퍼레이터)·
 * hook 이 맞춰 볼 때 모두 이 함수 하나를 쓴다** — 둘이 다르면 승인한 것과 열리는 것이 어긋난다.
 *
 * - PreToolUse hook 의 allow 는 Bash 호출 문자열 **전체**에 걸린다(실측 T2: `a; b` 의 b 도 돈다). 그래서 셸 문법·따옴표·`$`·괄호가
 *   있는 명령은 아예 받지 않는다 — `validateToolRule` 의 `Bash(<명령 전체>)` 판정과 같은 글자 허용 목록이다.
 * - 정규형은 낱말 사이 공백 하나(따옴표가 없으니 셸에서 공백은 구분자일 뿐이다). `:*` 접두는 받지 않는다 — 접두는 `kind: tool` 이다.
 * - 승인은 글자에 묶이므로 **글자 밖에서 뜻을 바꾸는 것**을 막는다(security F1·C1~C4):
 *   - 첫 낱말 `NAME=값`(env 앞붙임) → `env_prefix`.
 *   - 경로로 부르는 머리(`./deploy.sh`) → `path_head`. 스크립트는 다른 파일·env 를 읽어 해시 하나로 고정되지 않는다(C3).
 *   - 파일 자리(`files`)는 **절대 경로**만(`relative_path`) — cwd 와 상관없게. 붙여 쓴 짧은 플래그(`-fX`·`-f=X`)는 판정이 모호해
 *     `glued_flag`. 파일 내용은 오퍼레이터가 sha256 으로 묶는다(요청·match 양쪽, 서버는 경로 집합이 `files` 와 같은지 본다 — C1).
 *   - kubectl·helm 은 `--kubeconfig <절대경로>` 와 `--context`/`--kube-context` 가 둘 다 있어야 한다(C4) — 없으면 `~/.kube/config`·
 *     `KUBECONFIG` 를 몰래 읽어 해시 묶기를 피한다 → `needs_kubeconfig`.
 */
export function validateExactCommand(input: string): ExactCommandVerdict {
  const command = input.trim();
  if (!command) return { ok: false, code: 'empty' };
  if (command.endsWith(':*')) return { ok: false, code: 'wildcard' };
  const v = validateToolRule(`Bash(${command})`);
  if (!v.ok) return v;
  if (v.kind !== 'bash_exact') return { ok: false, code: 'unsupported_tool' };
  const normalized = v.rule.slice('Bash('.length, -1);
  const words = normalized.split(' ');
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) return { ok: false, code: 'env_prefix' };
  if (words[0]!.includes('/')) return { ok: false, code: 'path_head' };
  const head = words[0]!.toLowerCase();
  const f = commandFileArgs(head, words);
  if ('code' in f) return { ok: false, code: f.code };
  if (head === 'kubectl' || head === 'helm') {
    const ctxFlag = head === 'kubectl' ? '--context' : '--kube-context';
    const has = (flag: string) => words.some((w, i) => (w === flag && i + 1 < words.length && !words[i + 1]!.startsWith('-')) || w.startsWith(`${flag}=`));
    if (!f.files.some((x) => x.flag === '--kubeconfig') || !has(ctxFlag)) return { ok: false, code: 'needs_kubeconfig' };
  }
  const warnings = [...v.warnings];
  if (f.files.length) warnings.push('reads_file');
  return { ok: true, command: normalized, warnings, files: f.files };
}

/** 어느 명령에서든 파일을 읽는 플래그. */
const COMMON_FILE_FLAGS = ['--patch-file', '--env-file', '--from-env-file', '--config', '--kubeconfig'];
/** 머리별로 더하는 것 — `-f` 는 kubectl·helm 에서만 파일이다(`tail -f`·`rm -f` 는 아니다). */
const HEAD_FILE_FLAGS: Record<string, readonly string[]> = {
  kubectl: ['-f', '--filename', '--kustomize', '-k', '--from-file'],
  helm: ['-f', '--values', '--set-file'],
};
/** 내용에 비밀이 있을 수 있어 미리 보기를 보내지 않는 자리. */
const SECRET_FILE_FLAGS = new Set(['--kubeconfig', '--env-file', '--from-env-file', '--config']);
/** kubectl 에서 `-f` 가 파일이 아닌 하위 명령(`logs -f` 는 따라가기). */
const KUBECTL_F_NOT_FILE = new Set(['logs']);

function commandFileArgs(head: string, words: readonly string[]): { files: CommandFileArg[] } | { code: ToolRuleRefusal } {
  let flags = [...COMMON_FILE_FLAGS, ...(HEAD_FILE_FLAGS[head] ?? [])];
  if (head === 'kubectl' && words.slice(1).some((w) => KUBECTL_F_NOT_FILE.has(w))) flags = flags.filter((x) => x !== '-f');
  const shortFlags = flags.filter((x) => /^-[A-Za-z]$/.test(x));
  const files: CommandFileArg[] = [];
  const add = (flag: string, raw: string | undefined): ToolRuleRefusal | null => {
    if (raw === undefined) return 'relative_path';
    // `--set-file name=path`·`--from-file key=path` 는 `=` 뒤가 경로다.
    const path = (flag === '--set-file' || flag === '--from-file') && raw.includes('=') ? raw.slice(raw.indexOf('=') + 1) : raw;
    if (!isCleanAbsolutePath(path)) return 'relative_path';
    files.push({ path, flag, secret: SECRET_FILE_FLAGS.has(flag) });
    return null;
  };
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    let bad: ToolRuleRefusal | null = null;
    if (flags.includes(w)) { bad = add(w, words[i + 1]); i++; }
    else if (w.startsWith('--') && w.includes('=') && flags.includes(w.slice(0, w.indexOf('=')))) bad = add(w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1));
    else if (shortFlags.some((x) => w.startsWith(x) && w.length > x.length)) bad = 'glued_flag';
    else if (w.startsWith('@')) bad = add('@', w.slice(1));
    if (bad) return { code: bad };
  }
  return { files };
}

/** `/` 로 시작하고 `.`·`..`·빈 마디·끝 `/` 가 없는 경로 — 오퍼레이터의 `realpath(p) === p` 와 맞물린다(C2). */
function isCleanAbsolutePath(p: string): boolean {
  if (!p.startsWith('/') || p.length < 2 || p.endsWith('/')) return false;
  return p.slice(1).split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}
