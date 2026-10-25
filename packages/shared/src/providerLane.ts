/**
 * 전용 제공사 경로(provider lane) — 에이전트 하나를 Anthropic 호환 엔드포인트(사내 gateway 등)로 돌린다.
 *
 * 흐름(security 판정 4번 ⓐ~ⓕ):
 *   사람이 데스크톱에서 그 에이전트의 base URL 과 비밀 보관소의 비밀 이름을 정한다(`operator.json` 의 로컬
 *   설정, writer 는 오퍼레이터 하나) → 오퍼레이터가 러너를 띄울 때 `HARKROOM_PROVIDER_LANE=1` 만 준다(값 없음)
 *   → 러너가 턴마다 PTY 를 띄우기 직전 relay 로 `PROVIDER_LANE_MOUNT_PATH` 를 부른다 → 오퍼레이터가 그 턴의
 *   임대로 비밀을 꺼내 임대 디렉터리에 쓰고 경로와 base URL 을 돌려준다 → 러너가 그 값을 **그 턴의 하네스
 *   자식 env 에만** 넣는다. 임대 디렉터리에 있으므로 기록 가리기(`secretLeases.needles`)가 그 값을 그대로 바늘로 쓴다.
 *
 * - **base URL 은 이 설정에서만 온다.** 서버 정의·MCP·에이전트는 바꾸지 못한다 — 바꾸면 키가 바깥으로 샌다(ⓓ).
 * - **풀 계정과 섞지 않는다**(ⓒ). lane 에이전트는 계정 풀·`~/.claude` 로그인을 쓰지 않는다 — 한 자식에 OAuth 와
 *   키가 같이 있으면 #374 가 막던 상황이 그대로 생긴다.
 */

import { validateToolRule } from './toolRules.js';

/** 러너 → 오퍼레이터(relay 전용). 서버로는 나가지 않는다. */
export const PROVIDER_LANE_MOUNT_PATH = '/agent/provider-lane/mount';
/** 오퍼레이터가 러너 env 에 **늘** 싣는다('0'/'1') — 빼면 오퍼레이터를 띄운 셸의 값이 샌다(`HARKROOM_CHROME_HOST` 와 같은 이유). */
export const PROVIDER_LANE_ENV = 'HARKROOM_PROVIDER_LANE';

/** 로컬 설정 한 칸. 값이 아니라 **이름**만 — 값은 보관소에 있다. */
export interface ProviderLaneConfig {
  /** `https://gateway.example` 꼴. 끝 슬래시 없음. */
  baseUrl: string;
  /** 비밀 보관소의 비밀 이름(그 에이전트가 grant 를 받아야 꺼내진다). */
  secretName: string;
}

/** 오퍼레이터의 답(200). `null` 은 「이 에이전트에 lane 설정이 없다」. */
export interface ProviderLaneMountResult {
  lane: { baseUrl: string; path: string } | null;
}

/** 비밀 이름 문법 — 서버·`turnSecrets.ts` 의 NAME 과 같다. */
export const PROVIDER_SECRET_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * base URL 을 고른다. 받으면 정규화한 문자열, 아니면 null.
 *
 * - `https:` 만. 시험·로컬 프록시용으로 루프백 `http:` 하나만 예외다 — 평문으로 키가 남의 기계에 가지 않게.
 * - 사용자 정보·쿼리·조각은 받지 않는다(키가 URL 에 섞일 자리를 만들지 않는다).
 * - 경로는 남긴다(`/anthropic` 같은 접두가 있는 gateway). 끝 슬래시는 뗀다.
 */
export function normalizeProviderBaseUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > 512) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(u.hostname))) return null;
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.host}${path}`;
}

/** 로컬 설정에서 읽은 값을 고른다(손으로 고친 파일도 지난다). 틀리면 null — lane 이 없는 것과 같다. */
export function readProviderLaneConfig(raw: unknown): ProviderLaneConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { baseUrl?: unknown; secretName?: unknown };
  const baseUrl = normalizeProviderBaseUrl(r.baseUrl);
  if (!baseUrl || typeof r.secretName !== 'string' || !PROVIDER_SECRET_NAME.test(r.secretName)) return null;
  return { baseUrl, secretName: r.secretName };
}

/*
 * 하네스별로 API 키 연결 격리를 **잰** 판(2026-10-25 — 관문이 아니다). 판이 이 목록 밖이어도 턴은 돈다. 러너는 그 (하네스, 판)을
 * 처음 볼 때 스레드에 경고 한 줄을 남긴다(`providerLane.ts::laneUnmeasuredNotice`). 판을 올리면 실물 시험(`*.real.test.ts`)으로 다시 재고
 * 목록에 더한다. 데스크톱 상태 칸 문장도 이 목록을 쓴다.
 */

/** opencode. 판을 더할 때는 홈 표지·플러그인·정확 규칙·턴 파일 격리를 그 판으로 다시 잰다(1.19.4: 2026-10-25). */
export const OPENCODE_LANE_MEASURED_VERSIONS = ['1.18.32', '1.19.4'] as const;

/**
 * codex. 셸 env 걷기가 설정 셋(정책·셸 스냅숏·로그인 셸)에 걸려 있고
 * 판마다 기본값이 달랐다(0.154.0 실측: 기본은 키를 셸에 넘기고, TUI 는 스냅숏이 정책을 우회한다) — 판이 바뀌면 다시 잰다.
 */
export const CODEX_LANE_MEASURED_VERSIONS = ['0.154.0'] as const;

/**
 * omp. 저장소 설정 차단(빈 cwd·`--add-dir`)·프로젝트 `models.yml` 미독·
 * 세션 헤더 꼴이 모두 문서에 없는 동작이라 판마다 심은 파일 회귀 시험으로 다시 잰다(security C1).
 */
export const OMP_LANE_MEASURED_VERSIONS = ['18.12.6'] as const;
/**
 * kilo. 저장소 설정 차단(`KILO_DISABLE_PROJECT_CONFIG`)·홈 표지 자리(`KILO_TEST_HOME`)가
 * opencode 와 이름이 달라 판이 바뀌면 조용히 풀릴 수 있다 — 넓히면 그 판으로 다시 잰다.
 */
export const KILO_LANE_MEASURED_VERSIONS = ['7.8.17'] as const;

/**
 * pi. lane 홈의 로그인·`models.json` 우선순위와 저장소 설정 무시(`--no-approve`)를
 * 이 판에서 쟀다 — 판이 바뀌면 실물 시험으로 다시 잰다.
 */
export const PI_LANE_MEASURED_VERSIONS = ['1.4.0'] as const;

/**
 * 턴을 못 띄운 까닭의 **허용 목록**(1c, security 조건 ③). 실패 카드 meta(`FailureMeta.failure.laneCode`)에는 이 값만 실린다 —
 * 오퍼레이터·서버가 준 문자열을 그대로 흘리지 않고, 모르는 것은 `unknown` 으로 접는다. base URL·비밀 이름·값 경로는
 * 코드가 아니므로 어디에도 실리지 않는다(조건 ①).
 *
 * - 러너가 정하는 것: `harness_unsupported`·`no_turn_secrets_dir`·`operator_unreachable`·`lane_unset`·`bad_base_url`·`bad_path`·`bad_value`·`bg_unsupported`·`bad_model`(opencode 모델이 `harkroom-lane/<id>` 꼴이 아님)·`workspace_protected`(작업 폴더에 다음 턴을 바꾸는 이름이 있음)·`harness_version`(옛 러너만 낸다 — 2026-10-25 부터 판으로 막지 않는다)·`harness_login_present`(codex lane 전용 홈에 계정 로그인 파일이 있음)·`lane_setup`(그 채널의 lane 권한 표를 쓰거나 확인하지 못함)
 * - 오퍼레이터가 정하는 것: `no_lease`(재기동한 러너)·`forbidden`·`bad_request`·`unavailable`
 * - 서버 비밀 꺼내기가 정하는 것: `not_granted`·`grant_suspended`·`lease_invalid`·`not_found`·`secret_expired`·`secret_store_disabled`·`rate_limited`
 */
export const PROVIDER_LANE_FAILURE_CODES = [
  'harness_unsupported', 'no_turn_secrets_dir', 'operator_unreachable', 'lane_unset', 'bad_base_url', 'bad_path', 'bad_value', 'bg_unsupported', 'bad_model', 'workspace_protected', 'harness_version', 'harness_login_present', 'lane_setup',
  'no_lease', 'forbidden', 'bad_request', 'unavailable',
  'not_granted', 'grant_suspended', 'lease_invalid', 'not_found', 'secret_expired', 'secret_store_disabled', 'rate_limited',
  'unknown',
] as const;
export type ProviderLaneFailureCode = (typeof PROVIDER_LANE_FAILURE_CODES)[number];

/** 아무 문자열을 허용 목록의 코드로 접는다. 목록 밖은 `unknown`. */
export function providerLaneFailureCode(raw: unknown): ProviderLaneFailureCode {
  return (PROVIDER_LANE_FAILURE_CODES as readonly string[]).includes(raw as string) ? raw as ProviderLaneFailureCode : 'unknown';
}

/**
 * 에이전트의 **마지막 키 받기** 결과(2a). 오퍼레이터가 메모리에 들고 `operatorAgentsList` 에 실어 앱의 실행 탭 「마지막 시도」
 * 줄·격자 빨간 점이 읽는다. 러너가 그 턴의 값을 받았는지(성공) 또는 못 받은 까닭 코드(허용 목록)만 — 주소·이름·경로는 없다.
 * 하네스가 API 를 부르다 실패한 것은 여기 안 든다(스레드 실패 카드에 남는다).
 */
export interface ProviderLaneStatus {
  /** ISO 시각. */
  at: string;
  ok: boolean;
  code?: ProviderLaneFailureCode;
  /** 키는 받았는데 그 턴이 하네스 API 오류로 끝났다(n16) — 화면은 초록으로 그리지 않는다. 키 받기 결과가 새로 오면 지워진다. */
  apiFailed?: boolean;
}

/**
 * API 키로 도는 에이전트의 터미널 열기 거절 문장(security F1). 코드를 앞에 붙여 앱이 문장을 고른다(`interactive_unsupported:`).
 * 러너(`interactiveTurn.ts`)와 오퍼레이터(`relayMux` — 설정과 모드가 다른 러너로 가는 열기, C1 후속)가 같은 문장을 쓴다.
 */
export const PROVIDER_LANE_INTERACTIVE_REJECTION = 'interactive_unsupported: API 키로 도는 에이전트는 아직 터미널 열기를 지원하지 않는다';

/**
 * API 키 연결 턴의 PreToolUse hook(D1)이 받는 「소유자가 승인한 규칙」. 러너가 hook 명령 인자에 싣고(`--lane <값>`) 오퍼레이터의
 * `hook pretool` 이 푼다. 그 턴의 기본 허용 목록과 승인 규칙을 다 싣는다 — hook 은 모든 도구를 보고(matcher `*`), 목록에 없는 도구는
 * 거절한다. 값은 base64url(JSON 배열)이라 셸 글자가 섞이지 않는다.
 */
export const LANE_HOOK_TOOLS = ['Bash', 'WebFetch', 'WebSearch'] as const;
const LANE_HOOK_RULE = /^[A-Za-z_][A-Za-z0-9_]*(\(.*\))?$/s;

export function encodeLaneHookRules(rules: readonly string[]): string {
  const kept = rules.filter((r) => LANE_HOOK_RULE.test(r));
  return Buffer.from(JSON.stringify(kept), 'utf8').toString('base64url');
}

/** 풀지 못하면 null — 부르는 쪽은 그때 거절한다(fail-closed). */
export function decodeLaneHookRules(value: string): string[] | null {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(parsed) && parsed.every((r) => typeof r === 'string' && LANE_HOOK_RULE.test(r)) ? parsed as string[] : null;
  } catch {
    return null;
  }
}

/**
 * codex 명령 규칙 파일(`<codexHome>/rules/harkroom.rules`, codex 0.154 execpolicy)의 본문 — 승인된 셸 규칙만 `prefix_rule` 로 옮긴다.
 * 이 파일에 맞는 명령은 codex 가 **샌드박스 밖**에서 돌린다. 그래서:
 * - 받는 것은 `Bash(<명령>)`·`Bash(<접두>:*)` 둘뿐이다. 그 밖(MCP·웹 도구)은 codex 규칙과 상관없어 뺀다.
 * - 본문은 `validateToolRule` 의 글자 허용 목록을 다시 지나야 한다(따옴표·역슬래시가 없으니 Starlark 문자열이 깨지지 않는다).
 *   지나지 못한 규칙은 조용히 뺀다 — 덜 꺼내는 쪽으로 틀린다.
 * - codex 의 `prefix_rule` 은 **앞부분 맞춤**이다(실측: 정확 규칙에 인자를 하나 더 붙여도 allow). 정확 규칙의 꼬리는 턴 hook 이
 *   막는다(`hook pretool --lane`·`--tail`).
 */
export function codexRulesFile(rules: readonly string[]): string {
  const seen = new Set<string>();
  const lines: string[] = ['# harkroom: owner-approved commands (written by the runner each turn; do not edit)'];
  for (const raw of rules) {
    const v = validateToolRule(raw);
    if (!v.ok || v.kind === 'mcp_tool') continue;
    const m = /^Bash\((.+)\)$/s.exec(v.rule);
    if (!m) continue;
    let body = m[1]!.trim();
    if (body.endsWith(':*')) body = body.slice(0, -2).trim();
    const words = body.split(/\s+/).filter(Boolean);
    if (!words.length || words.some((w) => !CODEX_RULE_WORD.test(w))) continue;
    const pattern = `[${words.map((w) => JSON.stringify(w)).join(', ')}]`;
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    lines.push(`prefix_rule(pattern = ${pattern}, decision = "allow")`);
  }
  return `${lines.join('\n')}\n`;
}

/** `validateToolRule` 의 본문 글자와 같다 — 한 번 더 걸러 Starlark 문자열 밖으로 나갈 글자가 없게 한다. */
const CODEX_RULE_WORD = /^[A-Za-z0-9_./@=:+%-]+$/;

/**
 * `codexRulesFile` 가 쓴 글을 다시 `Bash(<명령>)` 규칙으로 읽는다 — codex 턴 hook 이 「밖으로 나갈 수 있는 명령」을 규칙 파일과
 * **같은 출처**로 보려고 쓴다. 이 함수가 쓴 꼴(머리 주석·`prefix_rule(… decision = "allow")`·빈 줄) 말고 다른 줄이 하나라도 있으면
 * null 이다 — 부르는 쪽은 그때 막는다(fail-closed).
 */
export function parseCodexRulesFile(text: string): string[] | null {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^prefix_rule\(pattern = \[(.*)\], decision = "allow"\)$/.exec(line);
    if (!m) return null;
    const words: string[] = [];
    for (const part of (m[1] ?? '').split(', ')) {
      let w: unknown;
      try { w = JSON.parse(part); } catch { return null; }
      if (typeof w !== 'string' || !CODEX_RULE_WORD.test(w)) return null;
      words.push(w);
    }
    if (!words.length) return null;
    out.push(`Bash(${words.join(' ')})`);
  }
  return out;
}

/**
 * codex 턴 hook(`hook pretool --codex`)이 읽는 턴 env 이름. 값은 `encodeCodexHookSpec` 의 base64url 이다. hooks.json 의 명령은
 * 고정이고(신뢰 hash 가 바뀌지 않게) 턴마다 다른 것(채널 규칙·합집합·codex 홈)은 이 env 로 간다 — codex 본체의 env 라 모델의 셸이
 * 바꿀 수 없다.
 */
export const CODEX_HOOK_SPEC_ENV = 'HARKROOM_CODEX_HOOK';

/**
 * `rules` 는 그 턴 채널의 승인 규칙, `reach` 는 러너가 규칙 파일에 쓴 합집합(`decideTailHook`). `codexHome` 은 그 턴의 codex 홈
 * (기록 파일·규칙 파일이 이 아래에 있어야 한다).
 */
export type CodexHookSpec = { rules: string[]; reach: string[]; codexHome: string };

export function encodeCodexHookSpec(spec: CodexHookSpec): string {
  const keep = (rs: readonly string[]) => rs.filter((r) => LANE_HOOK_RULE.test(r));
  return Buffer.from(JSON.stringify({ rules: keep(spec.rules), reach: keep(spec.reach), codexHome: spec.codexHome }), 'utf8').toString('base64url');
}

/** 풀지 못하면 null — 부르는 쪽은 그때 거절한다(fail-closed). */
export function decodeCodexHookSpec(value: string | undefined): CodexHookSpec | null {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const p = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
    const list = (v: unknown) => (Array.isArray(v) && v.every((r) => typeof r === 'string' && LANE_HOOK_RULE.test(r)) ? v as string[] : null);
    const rules = list(p.rules);
    const reach = list(p.reach);
    if (!rules || !reach || typeof p.codexHome !== 'string' || !p.codexHome.startsWith('/')) return null;
    return { rules, reach, codexHome: p.codexHome };
  } catch {
    return null;
  }
}

/**
 * **다시 부르면 풀리는** API 키 연결 실패 코드(2026-10-25). 턴 임대는 멘션마다 한 번만 나오고(서버 S1) 그 장부는 러너·오퍼레이터
 * 메모리에만 있다 — 러너가 다시 뜬 뒤 옛 멘션을 다시 집으면 임대가 없다(`no_lease`)·맞지 않는다(`lease_invalid`). 같은 멘션은
 * 다시 받을 수 없지만 **새 멘션**은 새 임대를 받는다. 러너는 이 둘에 [다시 부르기]를 열고(`retryable`), 화면은 고칠 설정이
 * 없으니 [에이전트 설정 열기]를 감춘다. 가로챔 신호(`lease_used`)는 넣지 않는다.
 */
export const PROVIDER_LANE_RECALLABLE_CODES = ['no_lease', 'lease_invalid'] as const;

export function providerLaneRecallable(code: string | null | undefined): boolean {
  return (PROVIDER_LANE_RECALLABLE_CODES as readonly string[]).includes(code ?? '');
}
