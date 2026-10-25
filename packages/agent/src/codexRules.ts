/**
 * codex 턴에 소유자 승인 명령을 연다(codex 권한 동등화 2단). 샌드박스는 그대로 바닥에 두고, 승인된 명령만 codex 명령 규칙으로 꺼낸다:
 *
 * - 규칙 파일 `<codexHome>/rules/harkroom.rules` — 이 에이전트의 **모든 채널** 승인 규칙의 합(서버 `reach`). codex 는 기동 때 이
 *   파일을 읽고(실측: 도는 중에 바꿔도 안 먹는다) 맞는 명령을 샌드박스 밖에서 돌린다.
 * - 턴 hook(`<codexHome>/hooks.json`, `harkroom-operator hook pretool --codex`) — 그 턴 **채널**의 규칙으로 다시 거르고, 밖으로 나갈
 *   명령의 실행 위치를 확인한다. hook 명령은 고정이다(신뢰 hash 가 턴마다 바뀌지 않게) — 턴마다 다른 값은 턴 env 로 간다.
 * - hook 신뢰 — codex 는 신뢰 기록이 없는 hook 을 돌리지 않는다. codex 자신(`app-server` 의 `hooks/list`)이 낸 hash 를 config 에 적고,
 *   다시 물어 `trusted` 를 확인한다. 확인하지 못하면 턴을 띄우지 않는다.
 *
 * 규칙 파일을 쓰지 않는 경우(= 지금처럼 승인 명령도 샌드박스 안): 옛 서버(합을 안 줌)·잰 판 밖의 codex·codex 홈이 샌드박스 쓰기 자리
 * 안. 그때는 남은 규칙 파일을 지운다 — codex 는 이 홈에서 뜨는 모든 턴에 그 파일을 싣는다.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { CODEX_HOOK_SPEC_ENV, codexRulesFile, encodeCodexHookSpec } from '@harkroom/shared/providerLane';
import { editCodexConfig } from './workspaceTrust.js';

/** 규칙 파일·hook 을 쓰는 codex 판(정확 일치, security W5). 대화 기록·hook 입력·신뢰 기록 꼴을 이 판에서 쟀다. */
export const CODEX_RULES_VERSIONS: readonly string[] = ['0.154.0'];

export function codexRulesVersionOk(raw: string | null | undefined): boolean {
  const m = /^codex-cli (\d+\.\d+\.\d+)$/.exec((raw ?? '').trim());
  return m !== null && CODEX_RULES_VERSIONS.includes(m[1]!);
}

export const codexRulesPath = (codexHome: string) => join(codexHome, 'rules', 'harkroom.rules');
export const codexHooksPath = (codexHome: string) => join(codexHome, 'hooks.json');

/**
 * hook 명령. `env -i` 로 codex 본체의 env(다리 열쇠·API 키)를 넘기지 않고, 판정에 쓰는 셋만 이름으로 다시 싣는다 — codex 가 hook 을
 * 셸로 띄우므로 `"$이름"` 이 codex 의 env 값으로 풀린다(실측). 판정은 로컬이라 오퍼레이터 열쇠도 넘기지 않는다. hook 이 어떤 길로
 * 죽어도 차단 종료 코드 2 로 끝낸다.
 */
export function codexHookCommand(operatorBin: string): string {
  return `/usr/bin/env -i PATH="$PATH" CODEX_HOME="$CODEX_HOME" ${CODEX_HOOK_SPEC_ENV}="$${CODEX_HOOK_SPEC_ENV}" ${JSON.stringify(operatorBin)} hook pretool --codex || exit 2`;
}

export function codexHooksJson(operatorBin: string): string {
  return `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: codexHookCommand(operatorBin) }] }] } }, null, 2)}\n`;
}

/** `hooks/list` 의 한 줄(쓰는 칸만). */
export type CodexHookListEntry = { key: string; sourcePath: string; eventName: string; command?: string; currentHash: string; trustStatus: string };

/** codex 샌드박스(workspace-write)가 쓰기를 여는 자리 — 작업 폴더와 임시 폴더들. */
export function sandboxWritableRoots(workspaceDir: string): (string | undefined)[] {
  // `tmpdir()` 가 `TMPDIR` 을 읽는다(없으면 OS 기본) — codex 는 러너 env 를 물려받으므로 같은 값이다.
  return [workspaceDir, '/tmp', '/private/tmp', '/var/tmp', tmpdir()];
}

/** realpath 가 `root` 와 같거나 그 아래인가. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * codex 홈이 샌드박스 쓰기 자리(작업 폴더·임시 폴더) **밖**인가(security W1). 안이면 모델이 규칙 파일·hook·신뢰 기록·대화 기록을
 * 고쳐 쓸 수 있다(실측: 홈 아래 자리면 그 넷 모두 쓰기 거절).
 */
export async function codexHomeOutsideWritable(codexHome: string, roots: readonly (string | undefined)[]): Promise<boolean> {
  let home: string;
  try { home = await realpath(codexHome); } catch { return false; }
  for (const root of roots) {
    if (!root) continue;
    const real = await realpath(root).catch(() => null);
    if (real && (isUnder(home, real) || isUnder(real, home))) return false;
  }
  return true;
}

async function writeIfChanged(path: string, text: string): Promise<void> {
  const now = await readFile(path, 'utf8').catch(() => null);
  if (now === text) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
}

const STATE_BEGIN = '# harkroom:hook-trust begin (written by the runner; do not edit)';
const STATE_END = '# harkroom:hook-trust end';

/** config.toml 에서 러너의 hook 신뢰 절을 바꿔 넣는다. 같은 값이면 null(쓰지 않음). */
export function withHookTrust(text: string, key: string, hash: string): string | null {
  const block = `${STATE_BEGIN}\n[hooks.state.${JSON.stringify(key)}]\nenabled = true\ntrusted_hash = ${JSON.stringify(hash)}\n${STATE_END}\n`;
  const start = text.indexOf(STATE_BEGIN);
  const end = start < 0 ? -1 : text.indexOf(STATE_END, start);
  if (start >= 0 && end >= 0) {
    const old = text.slice(start, end + STATE_END.length + 1);
    if (old === block) return null;
    return text.slice(0, start) + block + text.slice(end + STATE_END.length + 1);
  }
  return `${text}${text.endsWith('\n') || text === '' ? '' : '\n'}\n${block}`;
}

/**
 * codex 자신에게 이 홈의 hook 목록을 묻는다(`codex app-server` → `hooks/list`). hash 를 우리가 짜 맞추지 않는 이유: hash 는 codex 가
 * 정규화한 hook 선언에서 나오고 그 칸이 판마다 바뀔 수 있다. 실패하면 던진다.
 */
export function listCodexHooks(opts: { codexBin: string; codexHome: string; cwd: string; path: string; home?: string; timeoutMs?: number }): Promise<CodexHookListEntry[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.codexBin, ['app-server'], {
      cwd: opts.cwd,
      env: { PATH: opts.path, CODEX_HOME: opts.codexHome, ...(opts.home ? { HOME: opts.home } : {}) },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    let done = false;
    const finish = (err: Error | null, out?: CodexHookListEntry[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err); else resolve(out ?? []);
    };
    const timer = setTimeout(() => finish(new Error('codex hooks/list timed out')), opts.timeoutMs ?? 15_000);
    child.on('error', (e) => finish(e));
    child.on('exit', () => finish(new Error('codex app-server exited before answering')));
    child.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id?: unknown; result?: { data?: { hooks?: unknown }[] }; error?: unknown };
        try { msg = JSON.parse(line) as typeof msg; } catch { continue; }
        if (msg.id === 1) {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: [opts.cwd] } })}\n`);
        } else if (msg.id === 2) {
          if (msg.error || !Array.isArray(msg.result?.data)) return finish(new Error('codex hooks/list failed'));
          const hooks = msg.result.data.flatMap((d) => (Array.isArray(d.hooks) ? d.hooks as CodexHookListEntry[] : []));
          return finish(null, hooks);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'harkroom-runner', version: '0' } } })}\n`);
  });
}

/**
 * 규칙 파일을 **쓰지 않는** codex 길(읽기 전용·열쇠 없는 멘션 턴, 대화형 턴, 백그라운드)에서 띄우기 전에 부른다(security F1). codex 는
 * 이 홈으로 뜨는 모든 턴에 규칙 파일을 싣는데, 판이 바뀌면 hook 신뢰가 풀려 hook 없이 규칙만 실릴 수 있다 — 잰 판 밖이거나 판을
 * 못 읽으면 남은 규칙 파일을 지운다. 잰 판이면 그대로 둔다(그 턴의 hook 은 판정 값이 없어 규칙 파일의 명령을 막는다).
 */
export async function sweepCodexRules(codexHome: string, version: () => Promise<string | null>, log: (line: string) => void = () => {}): Promise<void> {
  if (codexRulesVersionOk(await version().catch(() => null))) return;
  log('[codexRules] 잰 판 밖의 codex — 남은 규칙 파일을 지운다');
  await rm(codexRulesPath(codexHome), { force: true });
}

export class CodexRulesError extends Error {
  constructor(readonly code: 'codex_hook_untrusted') {
    super('codex 가 러너의 명령 hook 을 신뢰하는지 확인하지 못해 턴을 띄우지 않았다(codex_hook_untrusted) — 러너 로그를 보라');
    this.name = 'CodexRulesError';
  }
}

export type CodexRulesDeps = {
  /** `codex --version` 출력 — 턴마다 묻는다(판은 러너 모르게 바뀔 수 있다). */
  version: () => Promise<string | null>;
  listHooks: (codexHome: string, cwd: string) => Promise<CodexHookListEntry[]>;
  log?: (line: string) => void;
  /** 시험용 — 샌드박스 쓰기 자리 목록을 바꾼다(기본 `sandboxWritableRoots`). */
  writableRoots?: (workspaceDir: string) => (string | undefined)[];
};

/**
 * 이 턴의 codex 규칙 파일·hook·hook 신뢰를 갖춘다. 돌려주는 env 를 그 턴의 codex env 에 얹는다(규칙을 쓰지 않으면 빈 객체).
 * hook 신뢰를 확인하지 못하면 `CodexRulesError` 를 던진다 — 부르는 쪽은 턴을 띄우지 않는다.
 */
export async function prepareCodexRules(
  opts: { codexHome: string; workspaceDir: string; operatorBin: string; rules: readonly string[]; reach: readonly string[] | null },
  deps: CodexRulesDeps,
): Promise<Record<string, string>> {
  const log = deps.log ?? (() => {});
  const off = async (why: string) => {
    log(`[codexRules] 규칙 파일을 쓰지 않는다(${why}) — 승인 명령도 샌드박스 안에서 돈다`);
    await rm(codexRulesPath(opts.codexHome), { force: true });
    return {};
  };
  if (opts.reach === null) return off('서버가 규칙 합을 주지 않음');
  if (!codexRulesVersionOk(await deps.version().catch(() => null))) return off('잰 판 밖의 codex');
  const roots = deps.writableRoots?.(opts.workspaceDir) ?? sandboxWritableRoots(opts.workspaceDir);
  if (!(await codexHomeOutsideWritable(opts.codexHome, roots))) return off('codex 홈이 샌드박스 쓰기 자리 안');

  // hook 을 먼저 갖추고 신뢰를 확인한 **뒤에** 규칙 파일을 쓴다 — 그 사이에 뜨는 다른 턴이 hook 없이 규칙만 싣지 않게.
  const hooksPath = codexHooksPath(opts.codexHome);
  await writeIfChanged(hooksPath, codexHooksJson(opts.operatorBin));
  const ours = (list: CodexHookListEntry[]) => list.filter((h) => h.sourcePath === hooksPath && h.eventName === 'preToolUse');
  let mine = ours(await deps.listHooks(opts.codexHome, opts.workspaceDir).catch(() => []));
  if (mine.length === 1 && mine[0]!.trustStatus !== 'trusted') {
    const { key, currentHash } = mine[0]!;
    await editCodexConfig(join(opts.codexHome, 'config.toml'), (text) => withHookTrust(text, key, currentHash));
    mine = ours(await deps.listHooks(opts.codexHome, opts.workspaceDir).catch(() => []));
  }
  if (mine.length !== 1 || mine[0]!.trustStatus !== 'trusted') {
    await rm(codexRulesPath(opts.codexHome), { force: true });
    throw new CodexRulesError('codex_hook_untrusted');
  }
  await writeIfChanged(codexRulesPath(opts.codexHome), codexRulesFile(opts.reach));
  return { [CODEX_HOOK_SPEC_ENV]: encodeCodexHookSpec({ rules: [...opts.rules], reach: [...opts.reach], codexHome: opts.codexHome }) };
}
