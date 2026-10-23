import { REPO_ORG_SCOPE_RE, TOOL_RULE_MAX_CHARS, orgScopeOf, repoGrantScope, repoScope, validateExactCommand, validateToolRule } from '@harkroom/shared';

/**
 * 위임(mandate) W2 — 능력(cap) 등록부. 위임장의 줄(`mandate_line`) 하나는 cap 하나 + scope + limits 다.
 * **새 능력 = 이 표에 항목 하나.** 각 항목은 scope 검증(`validateScope`), 줄과 행동의 대조(`matches`), 카드 문구 키(ko/en)를 가진다.
 *
 * 판정 자리는 아직 이것을 쓰지 않는다 — W2 는 그림자(`mergeGrants.ts::shadowMandate`)만 이것으로 계산한다.
 */
export const CAPS = ['merge', 'tool', 'command', 'bypass'] as const;
export type Cap = (typeof CAPS)[number];
export const isCap = (s: string): s is Cap => (CAPS as readonly string[]).includes(s);

/** 줄의 한도 — 모두 선택. `uses` 는 `used_count` 와, `until` 은 지금과 비교한다. merge 만 `pr`·`head`·`ghUser`·`ciOverride` 를 본다. */
export interface LineLimits {
  uses?: number; pr?: number; head?: string; ghUser?: string | null; ciOverride?: boolean; until?: string;
}

/** 대조에 필요한 줄의 모양 — 저장된 줄과 상시 줄(standing) 둘 다. */
export interface LineFacts {
  cap: Cap; scope: string; limits: LineLimits; usedCount: number; revokedAt: Date | string | null;
}

export type CapAction =
  /**
   * `ghUser`: 머지에 쓸 gh 계정(래퍼가 알려 줄 때만). 줄에 `ghUser` 가 있으면 같은 계정이어야 맞는다 — 모르면(없으면) 맞지 않는다(W3, 보수).
   * `ciOverride`: CI 실패를 무시하려는 머지. 줄이 `ciOverride: true` 일 때만 맞는다.
   */
  | { cap: 'merge'; repo: string; pr?: number; head?: string; ghUser?: string | null; ciOverride?: boolean }
  | { cap: 'tool'; rule: string }
  | { cap: 'command'; command: string }
  | { cap: 'bypass'; command: string };

export type ScopeVerdict = { ok: true; scope: string } | { ok: false; code: string };

export interface CapEntry<A extends CapAction = CapAction> {
  /** 받은 scope 를 정규형으로. 정규형이 아니면 저장하지 않는다. */
  validateScope(scope: string): ScopeVerdict;
  /** 이 줄이 이 행동을 덮는가 — 회수·`until`·`uses` 는 `lineLive` 가 먼저 본다. */
  matches(line: LineFacts, action: A): boolean;
  /** 카드 문구 키 — 화면은 이 PR 에 없다. 문구는 `CAP_CARD_TEXT`. */
  cardKey: string;
}

/** 줄이 살아 있는가 — 회수되지 않았고, `until` 전이며, `uses` 를 다 쓰지 않았다. */
export function lineLive(line: LineFacts, now = new Date()): boolean {
  if (line.revokedAt) return false;
  const l = line.limits ?? {};
  if (l.until !== undefined) {
    const t = Date.parse(l.until);
    if (!Number.isFinite(t) || t <= now.getTime()) return false;
  }
  if (l.uses !== undefined && !(typeof l.uses === 'number' && line.usedCount < l.uses)) return false;
  return true;
}

/** 우회(bypass)·명령의 정규형 — 앞뒤 공백을 떼고 낱말 사이 공백 하나. 줄바꿈·제어 문자는 받지 않는다. */
function normalizeCommandText(input: string): ScopeVerdict {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(input)) return { ok: false, code: 'shell_syntax' };
  const s = input.trim().replace(/ +/g, ' ');
  if (!s) return { ok: false, code: 'empty' };
  if (s.length > TOOL_RULE_MAX_CHARS) return { ok: false, code: 'too_long' };
  return { ok: true, scope: s };
}

const merge: CapEntry<Extract<CapAction, { cap: 'merge' }>> = {
  // 줄에는 정확한 저장소(`repo:owner/name`)나 조직 전체(`repo:owner/*`, 그 grant 를 상시 줄로 펼칠 때)가 온다.
  validateScope(scope) {
    const raw = scope.trim().toLowerCase();
    if (!raw.startsWith('repo:')) return { ok: false, code: 'bad_repo' };
    const s = repoGrantScope(raw.slice('repo:'.length));
    return s ? { ok: true, scope: s } : { ok: false, code: 'bad_repo' };
  },
  matches(line, action) {
    const want = repoScope(action.repo);
    if (!want) return false;
    const scopeHit = line.scope === want || (REPO_ORG_SCOPE_RE.test(line.scope) && orgScopeOf(want) === line.scope);
    if (!scopeHit) return false;
    const l = line.limits ?? {};
    if (l.pr !== undefined && l.pr !== action.pr) return false;
    if (l.head !== undefined && l.head !== action.head) return false;
    if (l.ghUser && (action.ghUser ?? '').toLowerCase() !== l.ghUser.toLowerCase()) return false;
    if (action.ciOverride && l.ciOverride !== true) return false;
    return true;
  },
  cardKey: 'mandate.line.merge',
};

const tool: CapEntry<Extract<CapAction, { cap: 'tool' }>> = {
  // 권한 요청 kind=tool 과 같은 판정(`validateToolRule`). 정규형과 다르면 받지 않는다.
  validateScope(scope) {
    const v = validateToolRule(scope);
    if (!v.ok) return { ok: false, code: v.code };
    return { ok: true, scope: v.rule };
  },
  // 서버에는 Claude Code allow 규칙의 대조기가 없다(러너가 규칙을 Claude Code 에 넘기고 거기서 맞춘다) — 여기서는 규칙 문자열 정확 일치다.
  matches(line, action) { return line.scope === action.rule.trim(); },
  cardKey: 'mandate.line.tool',
};

const command: CapEntry<Extract<CapAction, { cap: 'command' }>> = {
  // 권한 요청 kind=command 와 같은 판정(`validateExactCommand`).
  validateScope(scope) {
    const v = validateExactCommand(scope);
    if (!v.ok) return { ok: false, code: v.code };
    return { ok: true, scope: v.command };
  },
  matches(line, action) {
    const v = validateExactCommand(action.command);
    return v.ok && v.command === line.scope;
  },
  cardKey: 'mandate.line.command',
};

const bypass: CapEntry<Extract<CapAction, { cap: 'bypass' }>> = {
  // 우회는 이번 판에 쓰이지 않는다(G5) — 명령 하나 그대로만 담는다. kubectl·helm 제한은 없고, 한 줄·길이만 본다.
  validateScope(scope) { return normalizeCommandText(scope); },
  matches(line, action) {
    const v = normalizeCommandText(action.command);
    return v.ok && v.scope === line.scope;
  },
  cardKey: 'mandate.line.bypass',
};

export const CAPABILITIES: { [K in Cap]: CapEntry<Extract<CapAction, { cap: K }>> } = { merge, tool, command, bypass };

/** 카드 문구(ko/en). 키는 `CapEntry.cardKey`. `{scope}` 자리에 줄의 scope 가 들어간다. */
export const CAP_CARD_TEXT: Record<string, { ko: string; en: string }> = {
  'mandate.line.merge': { ko: '{scope} 저장소 머지', en: 'Merge in {scope}' },
  'mandate.line.tool': { ko: '도구 규칙 {scope} 허용', en: 'Allow tool rule {scope}' },
  'mandate.line.command': { ko: '명령 {scope} 실행', en: 'Run the command {scope}' },
  'mandate.line.bypass': { ko: '명령 {scope} 한 번 우회 실행', en: 'Run {scope} once without the usual checks' },
};

export function validateCapScope(cap: Cap, scope: string): ScopeVerdict {
  return CAPABILITIES[cap].validateScope(scope);
}

/** 줄이 살아 있고 이 행동을 덮는가. cap 이 다르면 거짓. */
export function lineMatches(line: LineFacts, action: CapAction, now = new Date()): boolean {
  if (line.cap !== action.cap || !lineLive(line, now)) return false;
  return (CAPABILITIES[action.cap] as CapEntry).matches(line, action);
}
