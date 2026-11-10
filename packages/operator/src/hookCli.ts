/**
 * `harkroom-operator hook pretool` 의 판단 부분(H③b) — 프로세스·소켓 밖에서 시험할 수 있게 뗐다. `main.ts::hookMain` 이 부른다.
 *
 * 받는 것: claude PreToolUse hook 입력(stdin JSON — `tool_name`·`tool_input.command`·`tool_use_id`·`cwd`).
 * 내는 것: 승인된 정확한 명령이면 allow 결정 객체, 그 밖은 `null`(= 무출력 → claude 의 auto 분류기가 평소대로 판정).
 * 오퍼레이터에 묻기 전에 shared `validateExactCommand` 로 먼저 거른다 — 셸 이어 붙이기·허용 목록 밖이면 소켓도 열지 않는다.
 */
import type { Readable } from 'node:stream';
import { validateExactCommand } from '@harkroom/shared';
import { LANE_HOOK_TOOLS } from '@harkroom/shared/providerLane';
import { COMMAND_CHECK_TOOL } from './turnCommand.js';
import { peekContext, THREAD_PEEK_TOOL, type PeekPost } from './turnPeek.js';

export const HOOK_TIMEOUT_MS = 10_000;
export const HOOK_STDIN_MAX = 256 * 1024;

export type HookDecision = { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'allow'; permissionDecisionReason: string } };
type Ask = (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; text: string } | { ok: false; notInTurn: true }>;

export async function readStdinCapped(stream: Readable, max: number): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += b.length;
    if (size > max) throw new Error('hook input too large');
    chunks.push(b);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function decideHook(raw: string, ask: Ask): Promise<HookDecision | null> {
  let input: { tool_name?: unknown; tool_input?: { command?: unknown }; tool_use_id?: unknown; cwd?: unknown };
  try { input = JSON.parse(raw) as typeof input; } catch { return null; }
  if (input.tool_name !== 'Bash' || typeof input.tool_input?.command !== 'string') return null;
  const v = validateExactCommand(input.tool_input.command);
  if (!v.ok) return null;
  const r = await ask(COMMAND_CHECK_TOOL, {
    command: v.command,
    ...(typeof input.cwd === 'string' ? { cwd: input.cwd } : {}),
    ...(typeof input.tool_use_id === 'string' ? { toolUseId: input.tool_use_id } : {}),
  }).catch(() => null);
  if (!r || !r.ok || 'notInTurn' in r) return null;
  let out: { allow?: unknown; grantId?: unknown };
  try { out = JSON.parse(r.text) as typeof out; } catch { return null; }
  if (out.allow !== true || typeof out.grantId !== 'string') return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: `harkroom: owner-approved exact command (grant ${out.grantId.slice(0, 8)})` } };
}

export type LaneDenyDecision = { hookSpecificOutput: { hookEventName: 'PreToolUse'; permissionDecision: 'deny'; permissionDecisionReason: string } };

/** 거절 이유 — 모델에 그대로 간다(실측). 무엇을 하면 열리는지 한 줄로 말한다. 규칙 예는 **명령 전체**다(security S4). */
export const LANE_HOOK_DENY_REASON =
  'harkroom: this API-key agent may only use owner-approved tools. Ask with the harkroom permission.request tool (kind "tool") for this exact use, e.g. Bash(<the exact full command>); once approved it opens from the next turn.';

/**
 * 셸 글자 때문에 거절할 때의 이유(2026-10-24 실측: `gh run list … 2>&1` 이 승인된 `:*` 규칙 안인데도 거절되자 모델이 더 좁은 규칙을
 * 또 청해 카드가 겹쳤다). 규칙을 넓히지 않고, 맨 명령으로 치라고 말한다.
 */
export const LANE_HOOK_SHELL_REASON =
  'harkroom: this command has shell characters (> | & ; $ ` ( ) { } \\ or a line break), and approved rules never cover those, even inside quotes. Run the plain command without redirection (such as 2>&1), pipes, chaining or substitution. If no approved rule covers the plain command, ask with the harkroom permission.request tool (kind "tool") for it.';

export function laneDeny(reason = LANE_HOOK_DENY_REASON): LaneDenyDecision {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

/** 셸이 명령을 이어 붙이거나 바꿔 넣는 글자. 하나라도 있으면 규칙과 맞춰 보지 않는다 — 규칙 판정보다 **좁게** 틀린다. */
const SHELL_META = /[;&|`$<>(){}\\\n\r]/;

/** dontAsk 가 규칙 없이 작업 폴더 안에서만 여는 읽기 도구 — hook 은 판정하지 않고 하네스에 맡긴다(밖은 하네스가 거절한다, 실측). */
const HARNESS_SCOPED = new Set(['Read']);

/**
 * 승인된 셸 규칙에 맞는가 — claude 의 판정보다 **좁다**. `Bash(<접두>:*)` 는 같은 명령이거나 접두 + 공백으로 시작할 때,
 * `Bash(<명령>)` 은 같을 때만. 셸 이어 붙이기·바꿔 넣기 글자가 있으면 맞지 않는다.
 */
export function laneBashAllowed(rules: readonly string[], command: unknown): boolean {
  const cmd = typeof command === 'string' ? command.trim() : '';
  if (!cmd || SHELL_META.test(cmd)) return false;
  for (const rule of rules) {
    const m = /^Bash\((.+)\)$/s.exec(rule);
    if (!m) continue;
    const inner = (m[1] ?? '').trim();
    if (inner.endsWith(':*')) {
      const prefix = inner.slice(0, -2).trim();
      if (prefix && (cmd === prefix || cmd.startsWith(`${prefix} `))) return true;
    } else if (cmd === inner) {
      return true;
    }
  }
  return false;
}

/** 셸이 아닌 도구가 허용 목록·승인 규칙에 이름으로 있는가. 웹 도구는 맨 이름 규칙만 받는다(범위가 붙은 규칙은 하위 에이전트에서 지켜지는지 모른다). */
export function laneToolListed(rules: readonly string[], tool: string): boolean {
  if (HARNESS_SCOPED.has(tool)) return true;
  if ((LANE_HOOK_TOOLS as readonly string[]).includes(tool)) return rules.includes(tool);
  for (const rule of rules) {
    const name = rule.replace(/\(.*$/s, '');
    if (name === tool) return true;
    if (name.startsWith('mcp__') && name.split('__').length === 2 && tool.startsWith(`${name}__`)) return true;
  }
  return false;
}

/**
 * API 키 연결 턴의 판정(D1, security S1·S2). matcher `*` 라 모든 도구가 온다. hook 은 **allow 를 내지 않는다** — 결정 없음(하네스의
 * `--allowedTools`·경로 규칙이 판정)이거나 deny 둘뿐이다. 그래서 hook 이 틀려도 하네스 판정에서 다시 막힌다.
 * - 셸: 승인 규칙에 (좁게) 맞으면 결정 없음, 아니면 deny
 * - 그 밖: 허용 목록·승인 규칙에 이름이 있으면 결정 없음, 없으면 deny(하네스의 dontAsk 판정과 겹으로 막는다)
 * - 입력을 못 읽으면 deny. LLM 판정은 없다.
 */
export function decideLaneHook(raw: string, rules: readonly string[]): LaneDenyDecision | null {
  let input: { tool_name?: unknown; tool_input?: { command?: unknown } };
  try { input = JSON.parse(raw) as typeof input; } catch { return laneDeny(); }
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (!tool) return laneDeny();
  if (tool === 'Bash') {
    const command = input.tool_input?.command;
    if (laneBashAllowed(rules, command)) return null;
    return laneDeny(typeof command === 'string' && SHELL_META.test(command.trim()) ? LANE_HOOK_SHELL_REASON : LANE_HOOK_DENY_REASON);
  }
  return laneToolListed(rules, tool) ? null : laneDeny();
}

/** 꼬리 막기 거절 이유 — 승인된 명령의 앞부분만 맞는 꼴이다. 규칙을 넓히지 말고 승인된 그대로 치거나 그 명령 전체를 청하라고 말한다. */
export const LANE_HOOK_TAIL_REASON =
  'harkroom: this command contains an owner-approved command but is not exactly it (extra arguments, a wrapper or quoting). Run the approved command exactly as approved, or ask with the harkroom permission.request tool (kind "tool") for this exact full command; once approved it opens from the next turn.';

/** 승인된 셸 규칙의 낱말(정확 규칙은 명령 전체, `:*` 규칙은 접두). */
function ruleWords(rules: readonly string[]): string[][] {
  const out: string[][] = [];
  for (const rule of rules) {
    const m = /^Bash\((.+)\)$/s.exec(rule);
    if (!m) continue;
    let inner = (m[1] ?? '').trim();
    if (inner.endsWith(':*')) inner = inner.slice(0, -2).trim();
    const words = inner.split(/\s+/).filter(Boolean);
    if (words.length) out.push(words);
  }
  return out;
}

/**
 * 명령 어딘가에 승인 규칙의 낱말이 **이어서** 나오는가 — codex 의 규칙 맞춤보다 **넓게** 본다. 따옴표·역슬래시를 걷고, 셸 글자로
 * 조각을 나눈 뒤, 조각마다 낱말 열에서 규칙 낱말 열을 찾는다. 그래서 `"gh" pr …`·`FOO=1 gh pr …`·`bash -lc '…'`·`a && <규칙> x` 를
 * 모두 「규칙을 건드린다」로 본다(codex 가 그 꼴을 어떻게 풀어 맞추는지와 상관없이).
 */
export function touchesApprovedRule(rules: readonly string[], command: unknown): boolean {
  const cmd = typeof command === 'string' ? command : '';
  if (!cmd.trim()) return false;
  const patterns = ruleWords(rules);
  if (!patterns.length) return false;
  const segments = cmd.replace(/["'\\]/g, '').split(SHELL_META).map((s) => s.split(/\s+/).filter(Boolean));
  return segments.some((words) => patterns.some((p) => {
    for (let i = 0; i + p.length <= words.length; i++) {
      if (p.every((w, j) => words[i + j] === w)) return true;
    }
    return false;
  }));
}

/**
 * 구독형 codex 턴의 hook(「꼬리 막기」, codex 권한 동등화 1안). 러너가 승인 규칙을 codex 명령 규칙(`codexRulesFile`)으로 꺼내 두면
 * 그 규칙의 **앞부분**에 맞는 명령은 codex 가 샌드박스 밖에서 돌린다. 규칙 파일은 에이전트의 **모든 채널 합**이므로 규칙을 두 벌 받는다:
 * - `rules`(이 턴 채널의 규칙)에 (좁게) 맞으면 결정 없음 — 규칙대로 밖에서 돈다
 * - `reach`(규칙 파일과 같은 합집합)의 낱말을 건드리는데 이 채널 규칙에 맞지 않으면 deny — 다른 채널의 승인 명령·꼬리·감싸기·
 *   셸 글자로 밖에 나가는 길을 막는다
 * - 그 밖(셸이 아닌 도구 포함)은 결정 없음 — 지금처럼 codex 샌드박스 안에서 돈다
 * 입력을 못 읽으면 deny 다(lane 과 같은 fail-closed).
 */
export function decideTailHook(raw: string, rules: readonly string[], reach: readonly string[]): LaneDenyDecision | null {
  let input: { tool_name?: unknown; tool_input?: { command?: unknown } };
  try { input = JSON.parse(raw) as typeof input; } catch { return laneDeny(); }
  if (typeof input.tool_name !== 'string' || !input.tool_name) return laneDeny();
  if (input.tool_name !== 'Bash') return null;
  const command = input.tool_input?.command;
  if (laneBashAllowed(rules, command)) return null;
  // 이 채널 규칙도 닿음 판정에 넣는다 — 합집합을 빠뜨리고 넘겨도 이 채널 규칙의 꼬리는 막힌다.
  if (!touchesApprovedRule([...reach, ...rules], command)) return null;
  return laneDeny(typeof command === 'string' && SHELL_META.test(command.trim()) ? LANE_HOOK_SHELL_REASON : LANE_HOOK_TAIL_REASON);
}

export type PostToolOutput = { hookSpecificOutput: { hookEventName: 'PostToolUse'; additionalContext: string } };

export function postToolOutput(text: string): PostToolOutput {
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } };
}

/**
 * 턴 도중 새 글 hook 의 판단 부분(`turnPeek.ts`) — 실을 글이 있으면 그 글, 없거나 어떤 실패든 null(무출력). 오퍼레이터 답의 모양을
 * 믿지 않고 글 하나하나를 다시 거른다.
 */
export async function decidePostToolHook(since: number, ask: Ask): Promise<string | null> {
  const r = await ask(THREAD_PEEK_TOOL, { sinceSeq: since }).catch(() => null);
  if (!r || !r.ok || 'notInTurn' in r) return null;
  let out: { posts?: unknown };
  try { out = JSON.parse(r.text) as typeof out; } catch { return null; }
  if (!Array.isArray(out.posts)) return null;
  const posts: PeekPost[] = out.posts.filter((p): p is PeekPost =>
    typeof p === 'object' && p !== null && typeof (p as PeekPost).seq === 'number'
    && typeof (p as PeekPost).handle === 'string' && typeof (p as PeekPost).body === 'string')
    // 「부른 사람」은 `true` 일 때만이다 — 칸이 없거나 모양이 틀리면 「다른 사람(멈춤만)」으로 좁게 읽는다(security F1).
    .map((p) => ({ ...p, caller: p.caller === true }));
  return peekContext(posts);
}

/**
 * `harkroom-operator hook permission` — claude 의 **PermissionRequest** hook(하네스 물음 자동 해결 C안 P1). claude 가 터미널에 확인·선택
 * 화면을 띄우기 **직전에만** 불린다(실측 2026-11-10 claude 2.1.321: PreToolUse → PermissionRequest → Notification(`permission_prompt`) 순,
 * hook 이 결정을 주면 화면 없이 이어 가고, 안 주면 화면 물음 → 답이 없으면 2분 뒤 자동 거절).
 *
 * **allow 는 내지 않는다**(결정 #2 — 사람만 승인하라는 안전 검사를 넘지 않는다). 내는 것은 둘 뿐이다:
 * - 변수 경로 `rm`(안전 검사가 묻는 꼴) → deny + 다시 쓰는 법.
 * - `AskUserQuestion`(멘션 턴의 터미널엔 답할 사람이 없다) → deny + 스스로 고르거나 `message.ask` 로 물으라는 말.
 * 같은 턴에서 거절이 `PERMISSION_STOP_AFTER` 번째가 되면 문구를 「멈추고 message.fail 로 보고」로 바꾼다(재시도 루프 막기, 결정 #7).
 * 그 밖은 결정 없음 — 지금처럼 화면 물음이 받는다(정책 밖 물음은 1주 기록을 본 뒤 P3 에서 정한다).
 */
/**
 * `harkroom-operator hook notify` — claude Notification hook(C안 P2). `permission_prompt` 일 때만 신호 파일에 받은 시각 한 줄을 쓴다.
 * 판정을 내지 않는 알림이라 어떤 길로 끝나도 넓어지는 것이 없다. 그 밖의 알림(대기 알림 등)·깨진 입력은 아무것도 안 쓴다.
 */
export function notifyGateLine(raw: string, nowMs: number): string | null {
  let input: { notification_type?: unknown };
  try { input = JSON.parse(raw) as typeof input; } catch { return null; }
  if (!input || typeof input !== 'object' || input.notification_type !== 'permission_prompt') return null;
  return `${Math.floor(nowMs)}\n`;
}

export type PermissionDenyDecision = { hookSpecificOutput: { hookEventName: 'PermissionRequest'; decision: { behavior: 'deny'; message: string } } };
export type PermissionKind = 'rm_variable_path' | 'ask_user_question' | 'other';

export const PERMISSION_STOP_AFTER = 3;
export const PERMISSION_RM_REASON =
  'harkroom: this rm targets a path built from shell variables, which needs interactive approval — and no human is at this terminal. '
  + 'Rewrite it so the path is checked or literal: use ${VAR:?} for every variable in the path (e.g. rm -rf "${P:?}/sub"), or write the absolute path literally. Then run it again.';
export const PERMISSION_ASK_REASON =
  'harkroom: no human is at this terminal, so AskUserQuestion cannot be answered. Choose yourself and continue. '
  + 'If the decision truly belongs to a person, ask with the harkroom message.ask tool (a card in the thread) instead.';
export const PERMISSION_STOP_REASON =
  'harkroom: this turn has hit repeated permission denials. Stop retrying: report what you were trying to do and what was blocked with the harkroom message.fail tool, then end the turn.';

/**
 * 변수로 지은 경로를 지우는 `rm` 인가. 안전 검사가 실제로 묻는 꼴(실측: 루프 변수·변수 둘 이상)보다 **넓게** 잡는다 — 이 hook 은 claude 가
 * 이미 물으려 할 때만 불리므로, 넓게 잡아도 묻지 않을 명령을 막지 않는다. `${X:?}` 만 쓴 경로도 여기 걸리지만 그 꼴은 claude 가 묻지 않는다.
 */
export function variablePathRm(command: string): boolean {
  // 명령 경계(줄 시작·`;`·`&`·`|`·`(`·`{`·`do`/`then` 뒤) 다음의 rm 과, 같은 단순 명령 안의 `$`.
  return /(?:^|[;&|({\n]|\b(?:do|then|else|xargs|sudo)\s)\s*(?:command\s+)?rm\s[^;&|\n]*\$/.test(command);
}

export function classifyPermissionRequest(raw: string): { tool: string; kind: PermissionKind; program: string | null } | null {
  let input: { hook_event_name?: unknown; tool_name?: unknown; tool_input?: { command?: unknown } };
  try { input = JSON.parse(raw) as typeof input; } catch { return null; }
  if (!input || typeof input !== 'object' || typeof input.tool_name !== 'string') return null;
  const tool = input.tool_name;
  if (tool === 'AskUserQuestion') return { tool, kind: 'ask_user_question', program: null };
  if (tool === 'Bash' && typeof input.tool_input?.command === 'string') {
    const command = input.tool_input.command;
    // 기록에는 명령 전문을 남기지 않는다(비밀이 섞일 수 있다) — 첫 낱말만.
    const program = /^\s*([A-Za-z0-9_./-]{1,64})/.exec(command)?.[1] ?? null;
    return { tool, kind: variablePathRm(command) ? 'rm_variable_path' : 'other', program };
  }
  return { tool, kind: 'other', program: null };
}

function permissionDeny(message: string): PermissionDenyDecision {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } };
}

/** 판정. `priorDenials` 는 이 턴에서 이 hook 이 이미 낸 거절 수다. 결정 없음이면 `decision: null`. */
export function decidePermissionHook(raw: string, priorDenials: number): { tool: string; kind: PermissionKind; program: string | null; decision: PermissionDenyDecision | null } | null {
  const c = classifyPermissionRequest(raw);
  if (!c) return null;
  if (c.kind === 'other') return { ...c, decision: null };
  if (priorDenials + 1 >= PERMISSION_STOP_AFTER) return { ...c, decision: permissionDeny(PERMISSION_STOP_REASON) };
  return { ...c, decision: permissionDeny(c.kind === 'rm_variable_path' ? PERMISSION_RM_REASON : PERMISSION_ASK_REASON) };
}

/** 기록 한 줄(JSONL). 명령 전문·입력은 싣지 않는다. */
export type PermissionRecord = { at: string; turn: string; event: 'decided' | 'hook_error'; tool?: string; kind?: PermissionKind; program?: string | null; decision?: 'deny' | 'none'; error?: string };

/** 그날 기록에서 이 턴이 낸 거절 수. */
export function countTurnDenials(jsonl: string, turn: string): number {
  let n = 0;
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as Partial<PermissionRecord>;
      if (r.turn === turn && r.event === 'decided' && r.decision === 'deny') n++;
    } catch { /* 깨진 줄은 센 것으로 치지 않는다 */ }
  }
  return n;
}
