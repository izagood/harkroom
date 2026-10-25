/**
 * `harkroom-operator hook pretool --codex` 의 판단 부분 — codex 턴의 PreToolUse hook. 러너가 승인 규칙을 codex 명령 규칙
 * (`<codexHome>/rules/harkroom.rules`)으로 꺼내 두면 그 규칙에 맞는 명령은 codex 가 샌드박스 밖에서 돌린다. 이 hook 은:
 * - 그 턴 채널의 규칙으로 판정한다(`decideTailHook` 그대로). 합집합은 러너가 준 값과 **지금 규칙 파일**을 함께 본다 —
 *   codex 가 기동 때 읽은 파일과 같은 출처다. codex 0.154 의 PreToolUse 는 셸(`Bash`)에만 온다(실측).
 * - 판정을 통과해 **밖으로 나갈** 명령(그 턴 규칙에 맞는 셸 명령)만 실행 위치를 확인한다: codex 가 쓴 대화 기록에서 그 호출
 *   한 줄을 찾아, 실행 폴더가 턴의 작업 폴더와 같을 때만 통과한다. 기록을 못 읽거나 줄이 하나가 아니면 막는다.
 * 규칙 밖 명령은 판단하지 않는다 — 지금처럼 codex 샌드박스 안에서 돈다.
 */
import { open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { parseCodexRulesFile, type CodexHookSpec } from '@harkroom/shared/providerLane';
import { decideTailHook, laneBashAllowed, laneDeny, type LaneDenyDecision } from './hookCli.js';

/** 대화 기록에서 읽는 꼬리의 상한. 지금 호출의 줄은 hook 이 불리기 전에 기록 끝에 이미 있다(codex 0.154 실측). */
export const CODEX_TRANSCRIPT_TAIL_BYTES = 8 * 1024 * 1024;

/** 규칙 파일 자리 — 러너(`codexRulesPath`)와 같은 값이어야 한다. */
export const CODEX_RULES_RELATIVE = join('rules', 'harkroom.rules');

export const CODEX_HOOK_WORKDIR_REASON =
  'harkroom: an owner-approved command runs only in this turn\'s working folder. Run it again without a different working directory (workdir).';

type HookInput = { tool_name?: unknown; tool_input?: { command?: unknown }; tool_use_id?: unknown; cwd?: unknown; transcript_path?: unknown };

/** realpath 가 `root` 와 같거나 그 아래인가. */
function isUnder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** 규칙 파일을 지금 읽은 승인 규칙. 파일이 없으면 빈 목록, 읽었는데 꼴이 다르면 null(막는다). */
async function rulesFileNow(codexHome: string): Promise<string[] | null> {
  let text: string;
  try {
    text = await readFile(join(codexHome, CODEX_RULES_RELATIVE), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  return parseCodexRulesFile(text);
}

/** 파일 끝 `max` 바이트. 앞이 잘렸으면 첫 (잘린) 줄을 버린다. */
async function readTail(path: string, max: number): Promise<string> {
  const fh = await open(path, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start === 0 ? text : text.slice(text.indexOf('\n') + 1);
  } finally {
    await fh.close();
  }
}

/**
 * 이 호출의 실행 폴더가 턴의 작업 폴더인가(security W1~W3). 통과면 null, 아니면 거절.
 * - 기록 파일은 이 턴 codex 홈 아래여야 한다(샌드박스 쓰기 자리 밖 — 모델이 고쳐 쓸 수 없다).
 * - `tool_use_id` 의 function_call 줄이 꼬리 안에 **정확히 한 줄**이고(결과 줄이 이미 있으면 지금 호출이 아니다), 그 인자의 명령이
 *   hook 이 받은 명령과 같아야 한다.
 * - 인자에 `workdir` 가 있으면 실제 경로가 작업 폴더의 실제 경로와 같아야 한다.
 */
export async function checkCodexWorkdir(input: HookInput, command: string, codexHome: string, tailBytes = CODEX_TRANSCRIPT_TAIL_BYTES): Promise<LaneDenyDecision | null> {
  const deny = () => laneDeny(CODEX_HOOK_WORKDIR_REASON);
  if (typeof input.transcript_path !== 'string' || typeof input.tool_use_id !== 'string' || !input.tool_use_id) return deny();
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) return deny();
  try {
    const home = await realpath(codexHome);
    const transcript = await realpath(input.transcript_path);
    if (transcript === home || !isUnder(transcript, home)) return deny();
    const matches: Record<string, unknown>[] = [];
    for (const line of (await readTail(transcript, tailBytes)).split('\n')) {
      if (!line.includes(input.tool_use_id)) continue;
      let rec: { type?: unknown; payload?: { type?: unknown; call_id?: unknown; arguments?: unknown } };
      try { rec = JSON.parse(line) as typeof rec; } catch { continue; }
      if (rec.type !== 'response_item' || rec.payload?.call_id !== input.tool_use_id) continue;
      // 이미 결과가 적힌 호출 id 는 지금 호출이 아니다 — 옛 id 를 다시 쓴 호출을 옛 줄로 통과시키지 않는다.
      if (rec.payload.type === 'function_call_output') return deny();
      if (rec.payload.type !== 'function_call') continue;
      if (typeof rec.payload.arguments !== 'string') return deny();
      let args: unknown;
      try { args = JSON.parse(rec.payload.arguments); } catch { return deny(); }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return deny();
      matches.push(args as Record<string, unknown>);
    }
    if (matches.length !== 1) return deny();
    const args = matches[0]!;
    if (typeof args.cmd !== 'string' || args.cmd.trim() !== command.trim()) return deny();
    if (args.workdir === undefined || args.workdir === null) return null;
    if (typeof args.workdir !== 'string' || !args.workdir) return deny();
    const cwd = await realpath(input.cwd);
    const wd = await realpath(isAbsolute(args.workdir) ? args.workdir : join(input.cwd, args.workdir));
    return wd === cwd ? null : deny();
  } catch {
    return deny();
  }
}

/** codex 턴 hook 의 판정. 막으면 거절 객체, 판단하지 않으면 null. */
export async function decideCodexHook(raw: string, spec: CodexHookSpec): Promise<LaneDenyDecision | null> {
  let input: HookInput;
  try { input = JSON.parse(raw) as HookInput; } catch { return laneDeny(); }
  const fileRules = input.tool_name === 'Bash' ? await rulesFileNow(spec.codexHome) : [];
  if (fileRules === null) return laneDeny();
  const denied = decideTailHook(raw, spec.rules, [...spec.reach, ...fileRules]);
  if (denied) return denied;
  // 여기까지 온 셸 명령 가운데 그 턴 규칙에 맞는 것만 밖으로 나간다(W4) — 그것만 실행 위치를 본다.
  const command = input.tool_input?.command;
  if (input.tool_name !== 'Bash' || typeof command !== 'string' || !laneBashAllowed(spec.rules, command)) return null;
  return checkCodexWorkdir(input, command, spec.codexHome);
}
