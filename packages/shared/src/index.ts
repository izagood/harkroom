/**
 * 사람이 **직접 고르는** 상태(#186). 소켓 연결에서 파생되는 presence 와 나란히 산다 —
 * 덮지 않는다. 둘을 한 필드에 합치면 "연결이 끊긴 사람"과 "방해 금지인 사람"이 한 표시로
 * 뭉쳐, 하트비트가 잡아내려던 신호(죽은 연결을 online 으로 남기지 않는다)를 잃는다.
 *
 * 값 집합은 DB 의 check 제약(마이그레이션 016)과 **같은 것**이어야 한다. 한쪽만 늘리면
 * 서버는 받아들이는데 DB 가 거절하거나, 그 반대가 된다.
 */
export const ACCOUNT_STATUSES = ['available', 'away', 'dnd'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export interface AccountView {
  id: string;
  handle: string;
  displayName: string;
  kind: 'human' | 'agent';
  isAdmin: boolean;
  /**
   * 에이전트를 소유한 계정의 ID. **null 이 정상이다** — backfill 없이 컬럼이 추가됐고
   * "추측 소유자는 소유자가 아니다"라는 원칙(#181)에 따라 null 이면 운영자가 없는 것이다.
   * 사람 계정에서는 항상 null 이다.
   */
  ownerAccountId: string | null;
  /**
   * 비활성화된 계정. **디렉터리에서 빼지 않고 표시만 한다** — 이 목록은 멘션 자동완성의
   * 원천이면서 동시에 **작성자 이름을 푸는 표**이기도 하다(`MessageItem` 이 `accounts[authorId]`
   * 를 본다). 빼 버리면 그 에이전트의 과거 메시지가 작성자를 잃는다 — "이력은 건드리지
   * 않는다"는 비활성화의 전제와 어긋난다. 자동완성 후보에서 빼는 것은 이 플래그를 보는
   * 화면의 몫이다.
   */
  disabled: boolean;
  /**
   * 사람이 직접 고른 상태. **에이전트에게는 뜻이 없다** — 서버가 `kind !== 'human'` 의
   * 변경을 거절하므로 에이전트 행은 기본값 `'available'` 로 남고, 화면은 사람 계정에만
   * 이 값을 그린다. 에이전트의 "지금 일할 수 있는가"는 러너 상태이지 사회적 신호가 아니다
   * (#124 가 닫은 결함 — 파생 사실과 사람이 고른 신호를 한 필드에 합치면 되살아난다).
   */
  status: AccountStatus;
  /** 상태에 덧붙이는 짧은 문구. 없음은 **null** 이다 — 빈 문자열과 구분해야 "지웠다"가 표현된다. */
  statusText: string | null;
  /**
   * 이 계정이 건 프로필 사진의 첨부 id(#159). 없으면 **null** 이다.
   *
   * **바이트가 아니라 id 만 싣는다.** 이 뷰는 계정 목록 전체로 오가므로 바이트를 실으면
   * 디렉터리 한 번에 모든 사진이 따라온다. 화면은 이 id 가 있을 때만 아바타를 받아 오고,
   * 값이 바뀌면 캐시가 자연히 무효화된다(id 는 업로드마다 새로 생긴다).
   *
   * 그리는 곳은 `Identity` **한 곳**이다 — 자리마다 따로 그리면 이 저장소가 반복 결함으로
   * 지목한 "하나의 사실이 두 곳에 유지된다"가 된다.
   */
  avatarAttachmentId: string | null;
}

/** murmur 가 스키마·설정 차원에서 아는 harness 이름 전체. 실제 실행 가능 여부는 `RUNNABLE_HARNESSES` 를 본다. */
export const AGENT_HARNESSES = ['claude-code', 'codex', 'gemini'] as const;
export type AgentHarness = (typeof AGENT_HARNESSES)[number];

/**
 * 지금 러너가 실제로 실행할 수 있는 harness. `AGENT_HARNESSES` 의 부분집합이다.
 * 둘이 다른 이유: 타입은 스키마·설정이 아는 이름 전체이고, 이쪽은 코드가 따라온 범위다.
 * UI 는 이 목록에 없는 것을 '지원 예정'으로 잠근다 — 없는 것을 있다고 표시하지 않는다
 * (design.md §4).
 *
 * **이 목록에 들어가는 기준은 하나다: 실물 CLI 로 첫 턴 + resume 왕복이 도는 것을 봤는가**
 * (`packages/agent/README.md` harness 절, spec §10 "수용" 층).
 *
 * codex 는 2026-09-04 codex-cli 0.153.2 실물 검증에서 첫 exec → 같은 세션 id 의 resume 두 번,
 * 그리고 격리 CODEX_HOME 을 쓴 대화형 resume 까지 완주했다. 대화형 CLI 가
 * --ignore-user-config 를 거부하는 문제는 러너별 CODEX_HOME 격리로 해결한다.
 *
 * gemini 는 `PRESETS.gemini === 'unsupported'` 로 구현 자체가 없다.
 */
export const RUNNABLE_HARNESSES = ['claude-code', 'codex'] as const satisfies readonly AgentHarness[];

/** 멘션 턴(화면 앞에 사람이 없다)의 권한. 사람 인터랙티브 턴은 하네스가 직접 묻는다. */
export const MENTION_PERMISSIONS = ['auto', 'readonly'] as const;
export type MentionPermission = (typeof MENTION_PERMISSIONS)[number];

/** UI 에서 등록·수정하는 에이전트의 정의. null 은 'harness 기본값 사용'이다. */
export interface AgentConfig {
  instructions: string;
  harness: AgentHarness;
  model: string | null;
  effort: string | null;
  workingDir: string | null;
  mentionPermission: MentionPermission;
  /**
   * 러너 소유자. **null 이면 attach 표면이 아무에게도 안 뜬다.**
   *
   * 여기(설정)에 있는 이유: 서버의 `configFields` 가 생성·수정에 같은 목록을 쓰고 그
   * 목록에 이 필드가 들어 있다. 클라이언트 타입이 그 계약을 그대로 반영한다.
   */
  ownerAccountId: string | null;
  /** 이 에이전트에 붙어 있는 러너의 빌드 버전. null 은 아직 한 번도 접속한 적이 없거나 버전 정보를 보내지 않은 것이다. */
  runnerVersion: string | null;
  /**
   * 러너에게 종료를 요청한 시각(#129). null 은 '요청 없음'이다.
   *
   * **재시작이 아니다.** murmur 는 러너를 띄우지 않으므로 다시 띄우는 것은 사람의 몫이고,
   * 이 값이 뜻하는 것은 "지금 턴을 끝내고 스스로 물러나 달라고 부탁했다"까지다.
   * `runnerVersion` 과 마찬가지로 읽기 전용이다 — PATCH 로는 바꿀 수 없고
   * `POST /accounts/agents/:id/stop` 하나만 이 값을 쓴다.
   */
  stopRequestedAt: string | null;
  /**
   * 러너가 그 요청을 읽어 간 시각. null 은 '아직 읽어 가지 않았다'이다.
   *
   * 이것이 '멈췄다'를 뜻하지는 **않는다**. 러너가 종료하면 다음 `GET /agent/config` 자체가
   * 오지 않으므로 서버는 프로세스의 생사를 알 수 없다. 화면은 이 구분(요청 없음 / 요청했으나
   * 아직 못 봄 / 러너가 받아 감)까지만 말할 수 있다.
   */
  stopAckedAt: string | null;
  /**
   * 이 에이전트가 **마지막으로 턴을 마친** 시각(#176). null 은 '아직 한 번도 턴을 돌린 적
   * 없음'이다 — '죽었다'가 아니다.
   *
   * **presence(온라인 여부)와 다른 사실이다.** 온라인은 러너가 지금 폴을 걸고 있다는 것이고
   * (`mcp/presence.ts`, #124), 이 값은 마지막으로 실제 일을 끝낸 시각이다. 둘은 나란히
   * 살아야 한다: 온라인인데 마지막 활동이 두 시간 전인 것은 정상이다(아무도 부르지 않았다).
   * 하나로 합치면 #124 가 닫은 결함(러너 없는 에이전트가 정상으로 보임)이 되살아난다.
   *
   * 폴 시각이 아니고 발화 시각도 아니다 — 폴은 할 일이 없어도 25초마다 돌고, 도구만 쓰고
   * 끝나는 턴은 발화가 없어도 활동이다.
   *
   * `runnerVersion`·`stopAckedAt` 과 같이 읽기 전용이다: PATCH 로는 바꿀 수 없고
   * `POST /agent/activity` 하나만 이 값을 쓴다. 시각은 **서버가** 찍는다 — 러너가 보낸
   * 타임스탬프를 저장하면 러너 시계가 앞선 머신에서 미래 시각이 화면에 뜬다.
   */
  lastTurnAt: string | null;
}

export interface AgentView extends AccountView, AgentConfig {}

/**
 * 새 에이전트를 만들 때 채워 넣는 기본값(#171). 워크스페이스 전체에 하나뿐이다.
 *
 * **에이전트가 이것을 참조하지 않는다.** 생성 시점 값을 그 에이전트의 정의에 복사하고,
 * 그 뒤로는 서로 독립이다 — 여기를 바꿔도 이미 만들어진 에이전트는 그대로다.
 * 참조로 두면 기본값을 고치는 순간 돌고 있는 러너의 harness 가 중간에 바뀐다.
 *
 * `model`·`effort` 의 null 은 `AgentConfig` 와 같은 뜻이다 — 'harness 기본값 사용'.
 */
export interface AgentDefaults {
  harness: string;
  model: string | null;
  effort: string | null;
}

export interface PatView {
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

/**
 * handle 문법. 계정 생성과 멘션 인식이 같은 것을 봐야 한다.
 */
export const HANDLE_PATTERN = '[a-zA-Z0-9_-]{2,32}';

/**
 * 채널 이름 문법. 서버와 클라이언트가 같은 것을 써야 한다.
 */
export const CHANNEL_NAME_PATTERN = '^[a-z0-9_-]{1,48}$';

/**
 * 본문에서 **코드만** 떼어낸다(#216). 마크다운 전체가 아니다 — 에이전트 출력에서 가치가
 * 가장 크면서 렌더링 표면이, 따라서 공격 표면도 가장 작은 것이 코드다.
 *
 * 이 판정이 사슬의 **맨 앞**에 있는 것이 요점이다. 멘션·링크(#214)보다 먼저 raw 본문을
 * 나눠야 코드가 우선권을 갖는다. 순서가 뒤집히면 코드 블록 안의 URL 이 이미 링크가 된
 * 뒤라 되돌릴 방법이 없다 — 코드는 코드다.
 *
 * 라이브러리를 쓰지 않는다. 마크다운 렌더러는 raw HTML 통과를 기본으로 켜 두는 경우가
 * 많고, 그 설정 하나가 "HTML 을 통과시키지 않는다"는 결정을 조용히 뒤집는다. 직접
 * 토크나이즈해서 React 엘리먼트로 넘기면 이스케이프는 React 가 보장한다.
 *
 * **`shared` 에 있는 이유(#298).** 데스크탑의 `MessageBody` 만 코드를 갈라내던 동안 서버는
 * 본문 전체에서 멘션을 뽑아 알림을 보냈다 — 알림은 갔는데 화면은 안 갔다고 말하는, 판정이
 * 두 벌일 때 나는 거짓말이다. 서버가 양보하고(코드 예시의 `@forge` 는 그 에이전트를 부르는
 * 뜻이 아니다) 그 판정을 여기 한 벌만 둔다. 데스크탑은 `src/lib/code.ts` 가 이것을 다시
 * export 한다 — **복사가 아니라 재수출이다.**
 */
export type CodeSegment =
  /**
   * 코드가 아닌 부분. 여기에만 멘션·링크 인식을 얹는다.
   *
   * `start` 는 이 조각이 **원문에서 시작한 위치**다(#271). 멘션 정규화가 코드 구간을
   * 비껴가려면 평문의 원문 위치가 있어야 한다 — 없으면 정규화가 코드 판정 규칙을
   * 자기 정규식으로 한 벌 더 갖게 되고, 그 둘이 갈라지면 코드 블록 안의 `@handle` 이
   * 저장 시 멘션으로 바뀌어 알림까지 간다(#298 이 막은 바로 그 일이다).
   */
  | { kind: 'plain'; text: string; start: number }
  /** 백틱 하나로 감싼 것. */
  | { kind: 'inlineCode'; code: string }
  /** 백틱 세 개로 감싼 것. `lang` 은 **표시용일 뿐** — 문법 강조는 하지 않는다. */
  | { kind: 'codeBlock'; code: string; lang: string | null };

/**
 * 펜스 줄. 줄 전체가 펜스여야 한다 — `see ```x``` here` 처럼 문장 안에 섞인 것은 펜스가
 * 아니다. 여는 줄의 나머지는 언어 표시로 읽는다.
 */
const FENCE_LINE = /^[ \t]*```([^\n`]*)$/;

/**
 * 인라인 코드. 개행을 넘지 않는 것이 의도다 — 짝이 없는 백틱 하나가 뒤의 본문 전체를
 * 코드로 삼키면 메시지가 사라진 것처럼 보인다(펜스에서 같은 이유로 같은 결정을 한다).
 *
 * 앞뒤에 백틱이 더 붙어 있으면 집지 않는다. ```` ```x``` ```` 를 한 줄에 쓴 것은 인라인도
 * 블록도 아닌 애매한 입력이니, 애매한 것은 평문으로 둔다.
 */
const INLINE_CODE = /(?<!`)`([^`\n]+)`(?!`)/g;

/** 코드가 아닌 구간을 인라인 코드로 한 번 더 나눈다. */
function splitInline(text: string, out: CodeSegment[], offset: number): void {
  let cursor = 0;
  for (const m of text.matchAll(INLINE_CODE)) {
    if (m.index > cursor) {
      out.push({ kind: 'plain', text: text.slice(cursor, m.index), start: offset + cursor });
    }
    out.push({ kind: 'inlineCode', code: m[1]! });
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) out.push({ kind: 'plain', text: text.slice(cursor), start: offset + cursor });
}

/**
 * 본문을 코드/비코드 구간으로 나눈다(#216, #298).
 *
 * **닫히지 않은 펜스는 코드가 아니다.** 열고 닫지 않은 것을 블록으로 그리면 그 뒤 본문
 * 전체가 코드가 되어 메시지가 통째로 사라진 것처럼 보인다. 그래서 닫는 줄을 먼저 찾고,
 * 없으면 여는 줄까지 평문으로 되돌린다.
 */
export function splitCode(body: string): CodeSegment[] {
  const out: CodeSegment[] = [];
  const lines = body.split('\n');
  let plainFrom = 0;
  let i = 0;

  // 각 줄이 원문에서 시작하는 위치. `join('\n')` 이 되돌리는 것과 같은 오프셋이다 —
  // 줄 하나마다 길이 + 개행 하나.
  const lineStart: number[] = [];
  {
    let at = 0;
    for (const line of lines) { lineStart.push(at); at += line.length + 1; }
  }

  const flushPlain = (until: number) => {
    if (until <= plainFrom) return;
    splitInline(lines.slice(plainFrom, until).join('\n'), out, lineStart[plainFrom]!);
  };

  while (i < lines.length) {
    const open = FENCE_LINE.exec(lines[i]!);
    if (!open) { i += 1; continue; }

    // 닫는 줄을 찾는다. 언어 표시가 붙어 있어도 닫는 줄로 본다 — 두 번째 펜스가 나온
    // 시점에서 블록은 끝난 것이고, 그 뒤를 계속 코드로 두면 위 결정을 어기게 된다.
    let close = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (FENCE_LINE.test(lines[j]!)) { close = j; break; }
    }
    if (close === -1) { i += 1; continue; }

    flushPlain(i);
    const lang = (open[1] ?? '').trim();
    out.push({
      kind: 'codeBlock',
      code: lines.slice(i + 1, close).join('\n'),
      lang: lang.length ? lang : null,
    });
    i = close + 1;
    plainFrom = i;
  }
  flushPlain(lines.length);

  return out.length ? out : [{ kind: 'plain', text: body, start: 0 }];
}

/**
 * 본문 안의 멘션. 서버(알림 발송)와 데스크탑(강조)이 **반드시 같은 규칙**을 써야 한다 —
 * 갈라지면 두 방향으로 거짓말을 한다: 강조되지 않은 것이 몰래 알림을 보내거나(`me@x.com`),
 * 강조된 것이 알림을 보내지 않는다(`@Fizz`).
 *
 * 선행 문자 조건이 핵심이다. `@` 앞이 문자·숫자면 멘션이 아니다 — 이메일 주소와 단어
 * 중간의 `@` 를 걸러 낸다. handle 은 소문자로만 만들어지지만 사람은 `@Fizz` 라고 쓰므로
 * 대소문자를 무시하고 찾고, 조회할 때 소문자로 맞춘다.
 *
 * **역할 분리:**
 * - `MENTION_PATTERN` (@handle): 사람이 입력하는 형식. 클라이언트 입력, 화면 표시 원문.
 * - `MENTION_TOKEN_PATTERN` (<@id>): 저장소 안 정본. 본문 저장, REST/WS 응답.
 *
 * 입력 -> 저장: `normalizeMentions()` 가 @handle 을 <@id> 로 바꾼다.
 * 저장 -> 화면: `renderMentions()` 가 <@id> 를 현재 handle 로 바꾼다.
 * 저장 -> MCP: `denormalizeMentions()` 가 <@id> 를 현재 handle 로 바꾼다(에이전트가 handle 로 생각한다).
 */
export const MENTION_PATTERN = `(^|[^a-zA-Z0-9_-])@(${HANDLE_PATTERN})`;

/**
 * 저장된 멘션 토큰. 본문에 **정본으로** 저장되는 형식이다.
 * <@id> 는 본문을 다시 쓰지 않고 handle 변경을 반영할 수 있게 해 준다.
 */
export const MENTION_TOKEN_PATTERN = '<@([0-9a-f-]{36})>';

/**
 * 본문에서 불린 handle 들. 소문자로 정규화해 중복을 없앤다(`@fizz` 와 `@Fizz` 는 한 사람).
 * 패턴이 대문자를 이미 포함하므로 `i` 플래그는 필요하지 않다.
 *
 * 코드 블록(#298) 과 인용 줄(#592) 안의 `@handle` 은 무시한다 — `mentionScanText` 가 먼저
 * 그 구간을 걷어낸다. 인용은 남의 말을 옮기는 자리이므로 부르는 것이 아니다.
 *
 * **순서가 결정이다: 코드·인용 제거 → 멘션 추출 → 그룹 확장(#230)·채널 전체(#225).** 코드 제거가
 * 맨 앞이므로 코드 안의 그룹 handle 은 애초에 `handles` 에 들어오지 못하고, 따라서 확장될
 * 기회도 없다 — 예외 처리가 아니라 순서에서 따라오는 결과다. 서버(`services/messages.ts`)의
 * 그룹 확장은 이 함수가 돌려준 목록만 훑으므로 그 순서가 코드로 강제된다.
 */
export function mentionedHandles(body: string): string[] {
  const found = new Set<string>();
  for (const m of mentionScanText(body).matchAll(new RegExp(MENTION_PATTERN, 'g'))) {
    if (m[2]) found.add(m[2].toLowerCase());
  }
  return [...found];
}

/**
 * 본문에 저장된 멘션 ID 집합. 정규화된 본문(<@id> 토큰)에서 추출한다.
 * 알림 판정에 쓴다 — inbox 를 만든 뒤에는 본문을 다시 읽지 않는다.
 */
export function mentionedIds(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(new RegExp(MENTION_TOKEN_PATTERN, 'g'))) {
    if (m[1]) found.add(m[1]);
  }
  return [...found];
}

/**
 * 본문의 `@handle`(**존재하는 계정만**)을 `<@id>` 로 정규화한다(#271). 저장 전에 한 번 돈다.
 *
 * **코드 구간과 인용 줄은 건드리지 않는다**(#298, #592). 판정은 `mentionRegions` 하나가 하고
 * 여기서는 그것이 내준 조각의 원문 범위만 고쳐 쓴다 — 자기 정규식으로 다시 판정하면 규칙이
 * 두 벌이 되고, 갈라지는 순간 코드·인용 안의 `@handle` 이 저장 시 멘션이 되어 알림까지
 * 간다. `mentionedHandles` 가 같은 이유로 `mentionScanText` 를 지난다.
 *
 * 정규화하지 않은 자리의 `@handle` 은 **글자 그대로** 남는다. 그래서 인용을 옮겨 적은 본문은
 * 저장된 뒤에도 사람이 쓴 모양 그대로 보인다 — `mentionedIds`(알림)도 `<@id>` 만 보므로
 * 추출과 정규화가 같은 답을 낸다.
 *
 * 계정 목록을 순회하지 않고 **본문을 한 번** 훑는다. 순회하면 비용이 워크스페이스의 계정
 * 수에 비례하고, 그보다 나쁘게는 handle 을 정규식에 끼워 넣는 자리가 생긴다.
 *
 * #230 그룹 멘션(`@그룹`)은 여기서 처리하지 않는다 — 호출부가 먼저 그룹을 펼치고, 그룹
 * 토큰은 `accountsMap` 에 없으므로 **글자 그대로** 남는다. 존재하지 않는 handle 이 그대로
 * 남는 것도 같은 이유다(오타를 멘션처럼 보이지 않게 한다).
 *
 * @param body 사람이 입력한 본문(`@handle` 형식)
 * @param accountsMap handle(소문자) -> 계정 id
 */
export function normalizeMentions(body: string, accountsMap: Map<string, string>): string {
  if (!accountsMap.size) return body;
  const mention = new RegExp(MENTION_PATTERN, 'g');
  // 뒤에서부터 고친다 — 앞에서 고치면 뒤 조각의 원문 오프셋이 밀린다.
  let out = body;
  for (const seg of mentionRegions(body).reverse()) {
    const replaced = seg.text.replace(mention, (whole, lead: string, handle: string) => {
      const id = accountsMap.get(handle.toLowerCase());
      return id ? `${lead}<@${id}>` : whole;
    });
    if (replaced !== seg.text) {
      out = out.slice(0, seg.start) + replaced + out.slice(seg.start + seg.text.length);
    }
  }
  return out;
}

/**
 * 저장된 `<@id>` 를 현재 handle 로 되돌린다 — MCP 가 에이전트에게 줄 때 쓴다(#271).
 * 에이전트는 handle 로 생각하고, 그 입력은 다시 `normalizeMentions` 를 탄다.
 *
 * **모르는 id 는 그대로 둔다.** `@알 수 없음` 같은 표시 문구로 바꾸면 에이전트가 그것을
 * 그대로 되받아 쓸 수 있고, 그때는 사람 이름처럼 생긴 문자열이 본문에 남는다. 화면(사람)
 * 과 도구(에이전트)의 처리가 다른 이유가 이것이다.
 *
 * @param body 저장된 본문(`<@id>` 형식)
 * @param idToHandle 계정 id -> 현재 handle
 */
export function denormalizeMentions(body: string, idToHandle: Map<string, string>): string {
  return body.replace(new RegExp(MENTION_TOKEN_PATTERN, 'g'), (whole, id: string) => {
    const handle = idToHandle.get(id);
    return handle ? `@${handle}` : whole;
  });
}

/**
 * 저장된 `<@id>` 를 **화면에 그릴** 현재 handle 로 바꾼다(#271). 본문을 그리는 곳은
 * 전부 이 함수를 지난다 — 두 벌이 되면 한쪽만 새 이름을 반영한다.
 *
 * 모르는 id 는 `@알 수 없음` 이다. 여기서는 `<@uuid>` 를 그대로 두는 것이 더 나쁘다 —
 * 사람에게 그 문자열은 아무 뜻이 없고, 무엇이 잘못됐는지도 말해 주지 않는다.
 *
 * @param body 저장된 본문(`<@id>` 형식)
 * @param idToHandle 계정 id -> 현재 handle
 * @param unknownLabel 모르는 id 를 대신할 라벨
 */
export function renderMentions(
  body: string,
  idToHandle: Map<string, string>,
  unknownLabel = UNKNOWN_ACCOUNT_LABEL,
): string {
  return body.replace(new RegExp(MENTION_TOKEN_PATTERN, 'g'), (_whole, id: string) => {
    const handle = idToHandle.get(id);
    return handle ? `@${handle}` : `@${unknownLabel}`;
  });
}

/** 계정 id 를 지금의 이름으로 바꿀 수 없을 때 대신 쓰는 라벨. `renderMentions`(#271)와 `fillSystemAccount`(#329)가 같은 말을 해야 한다. */
export const UNKNOWN_ACCOUNT_LABEL = '알 수 없음';

/**
 * 시스템 메시지 본문에서 "이 계정"이 들어갈 자리(#329).
 *
 * 서버는 본문에 handle 을 **박지 않는다** — 이것만 남기고 대상은 `meta.accountId` 로
 * 싣는다. 화면이 표시 시점에 지금의 handle 을 찾아 채우므로, `#271` 이후 이름을 바꾸면
 * 과거의 입·퇴장 메시지도 새 이름으로 그려진다.
 *
 * `#271` 의 `<@id>` 토큰을 본문에 쓰지 **않는** 이유: `postMessage` 는 `kind` 와 무관하게
 * 본문의 멘션을 판정하므로, 그 토큰을 본문에 두면 `#322` 가 명시적으로 막은 알림이 다시
 * 나간다. 그래서 멘션 문법과 겹치지 않는 자리표시자를 따로 둔다 — `@` 도 `<` 도 없다.
 */
export const SYSTEM_ACCOUNT_PLACEHOLDER = '{account}';

/**
 * 자리표시자를 지금의 handle 로 채운다(#329).
 *
 * **`@` 를 붙이지 않는다.** 붙이면 `splitMentions` 가 그것을 멘션으로 칠하고, 화면은 알림이
 * 간 것처럼 보인다 — `desktop/src/lib/mention.ts` 가 경계하는 바로 그 거짓말이다
 * (강조된 것이 알림을 보내지 않는다). 시스템 메시지는 사실을 남기는 것이지 부르는 것이 아니다.
 *
 * 자리표시자가 없는 본문은 그대로 돌아온다 — `#322` 가 이미 만든 옛 메시지는 본문에 이름이
 * 박혀 있고 `meta.accountId` 도 없다. 그것을 다시 쓰지 않는 것이 이 이슈의 결정이다.
 */
export function fillSystemAccount(body: string, handle: string | null): string {
  return body.split(SYSTEM_ACCOUNT_PLACEHOLDER).join(handle ?? UNKNOWN_ACCOUNT_LABEL);
}

/**
 * 인용 줄(#592). `> ` 로 시작하는 줄이고, 뒤의 공백 하나까지 표시로 먹는다.
 *
 * **이 판정이 여기 있는 이유:** 인용은 렌더러(데스크탑의 `quote` 블록)와 멘션 파서가 **같은
 * 것**을 인용이라고 불러야 한다. 갈라지면 화면은 인용으로 그리는 줄이 저장 시에는 평문으로
 * 취급되어 그 안의 `@handle` 이 알림을 보낸다 — `#298` 이 코드 블록에서 막은 것과 같은
 * 거짓말이다. 그래서 `desktop/src/lib/markdown.ts` 는 자기 정규식을 갖지 않고 이것을 쓴다.
 *
 * 게으른 이어짐(`> a` 다음 줄의 `b`)은 인용이 아니다. 마크다운 표준은 그것을 인용에 붙이지만
 * 데스크탑 렌더러는 `>` 가 없는 줄에서 인용을 끊으므로(`parseBlocks`), 여기서 표준을 따르면
 * 화면과 판정이 다시 갈라진다.
 */
export const QUOTE_LINE = /^ {0,3}>[ \t]?(.*)$/;

/**
 * 멘션을 찾을 구간과 그 **원문 위치**. 코드(#298)와 인용 줄(#592)을 뺀 나머지다.
 *
 * 인용 범위를 원문의 **줄 단위로 먼저 잡고** 코드 구간과 교차시킨다. 코드 조각별로 인용을
 * 다시 판정하면 `> 인용 ` + `` `코드` `` + ` @handle` 처럼 인라인 코드가 섞인 인용에서 첫
 * 조각만 인용으로 보이고 뒤가 샌다 — 이 결함의 절반이 그 모양이다.
 */
function mentionRegions(body: string): { text: string; start: number }[] {
  const quoted: [number, number][] = [];
  let at = 0;
  for (const line of body.split('\n')) {
    if (QUOTE_LINE.test(line)) quoted.push([at, at + line.length]);
    at += line.length + 1;
  }

  const out: { text: string; start: number }[] = [];
  for (const seg of splitCode(body)) {
    if (seg.kind !== 'plain') continue;
    const end = seg.start + seg.text.length;
    let cursor = seg.start;
    for (const [qs, qe] of quoted) {
      if (qe <= cursor || qs >= end) continue;
      if (qs > cursor) out.push({ text: body.slice(cursor, qs), start: cursor });
      cursor = Math.max(cursor, Math.min(end, qe));
    }
    if (cursor < end) out.push({ text: body.slice(cursor, end), start: cursor });
  }
  return out;
}

/**
 * 본문에서 멘션을 찾을 평문(#298, #592). 멘션을 찾을 대상은 **이것뿐**이다 — 서버 알림,
 * 데스크탑의 "부를 상대"(#278), 에이전트 교환 판정(`agentExchange.ts`)이 모두 이것을 지난다.
 *
 * 남은 조각을 개행으로 이어 붙인다. 개행은 handle 문자가 아니므로 `MENTION_PATTERN` 의
 * 선행 문자 조건에서 조각의 첫 글자가 `^` 와 같은 자격을 갖는다 — 조각을 따로 훑는 것과
 * 결과가 같고, 걷어낸 자리에서 두 조각이 붙어 없던 멘션이 생기는 일도 없다.
 *
 * 문자열 하나를 돌려주는 이유: 쓰는 곳은 모두 정규식을 한 번 돌릴 평문이 필요할 뿐이다.
 * 각자 세그먼트를 이어 붙이게 두면 그 이어 붙이는 규칙이 다시 두 벌이 된다.
 */
export function mentionScanText(body: string): string {
  return mentionRegions(body).map((r) => r.text).join('\n');
}

/**
 * 채널 전체를 부르는 예약 handle(#225). 문법을 따로 만들지 않는다 — `@channel` 은 평범한
 * 멘션과 **같은** `MENTION_PATTERN` 에 걸리고, 이름만 예약이다. 파서를 갈라 두면 서버와
 * 데스크탑이 서로 다른 것을 멘션이라 부르게 된다.
 *
 * 같은 handle 을 가진 **계정이 있으면 계정이 이긴다.** 사람의 이름이 예약어에 밀리면 그
 * 사람은 영영 불릴 수 없다 — 예약어를 못 쓰는 쪽이 훨씬 가벼운 손해다. 그래서 서버는
 * 계정 조회를 먼저 하고, 그 handle 의 계정이 **없을 때만** 채널 전체로 펼친다.
 */
export const CHANNEL_MENTION_HANDLE = 'channel';

/**
 * 집합(#230)에는 **예약 handle 이 없다.** `@channel` 과 다른 점이 여기다: `@channel` 은
 * 이름 하나가 고정된 뜻을 갖는 예약어지만, 집합은 admin 이 이름을 정하는 저장된 엔티티라
 * 계정과 **같은 네임스페이스**를 쓴다(`HandleGroupRow` 주석). 그래서 문법도 따로 없고
 * 평범한 `MENTION_PATTERN` 에서 잡힌다.
 *
 * `GROUP_MENTION_HANDLE = 'group'` 같은 상수를 두지 않는 이유: 그런 상수가 있으면 `@group`
 * 이 특별한 이름이라는 **거짓 사실**을 코드가 주장하게 된다. 초판에 그 상수가 있었고,
 * 아무 곳에서도 쓰이지 않으면서 두 파일이 import 하고 있었다.
 *
 * 집합과 같은 이름의 계정은 만들 수 없고 그 반대도 안 된다 — 서버가 양쪽에서 막는다
 * (`authRoutes.ts`·`agents.ts`·`handleGroupRoutes.ts`). 그래도 판정 순서는 정해 둔다:
 * **계정이 이긴다**(`services/messages.ts`). 사람의 이름이 집합에 밀리면 그 사람은
 * 영영 불릴 수 없다.
 */

/**
 * 메시지 하나를 가리키는 링크의 스킴(#178). 문자열을 여기저기서 조립하지 않는다 —
 * 만드는 쪽과 읽는 쪽이 갈라지면 자기가 만든 링크를 자기가 못 여는 상태가 된다.
 *
 * **OS 에 등록하는 URL 스킴이 아니다.** murmur 는 셀프호스트라 호스트가 인스턴스마다
 * 다르고, 그래서 링크에 호스트를 넣지 않는다 — 이 문자열은 앱 안에서 붙여넣어 여는
 * 좌표이지 브라우저가 넘겨 주는 주소가 아니다.
 */
export const MESSAGE_PERMALINK_PREFIX = 'murmur://message/';

/**
 * uuid 판정. `parseMessagePermalink` 가 **형식까지** 보게 하는 것이 요점이다 —
 * 접두사만 확인하고 나머지를 통과시키면 사람이 붙여넣은 임의 문자열이 그대로 서버 질의가 된다.
 */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** 이 메시지를 가리키는 링크 문자열. */
export function messagePermalink(messageId: string): string {
  return `${MESSAGE_PERMALINK_PREFIX}${messageId}`;
}

/**
 * 링크에서 메시지 id 를 꺼낸다. 링크가 아니거나 uuid 가 아니면 **null** 이다.
 *
 * 앞뒤 공백은 잘라 낸다 — 사람이 복사한 링크에는 줄바꿈이 붙어 오는 일이 흔하고,
 * 그것 때문에 "형식이 틀렸다"고 말하면 거짓말이 된다.
 *
 * **전체 일치만 링크로 본다.** 문장 안에서 링크를 찾아내지 않는다 — 붙여넣기를 가로채는
 * 쪽(#228)이 이 판정을 그대로 쓰기 때문이다. 부분 일치까지 링크로 보면 링크를 **인용**하려고
 * 문장째 붙여넣은 사람이 쓰던 글을 잃고 엉뚱한 곳으로 끌려간다.
 *
 * **이 형식에는 서버·커뮤니티 식별자가 없다(#228).** 지금은 데스크탑이 한 서버만 보므로
 * uuid 하나로 좌표가 되지만, 다중 커뮤니티(#163)가 들어오면 이 링크는 **어느 커뮤니티의
 * 메시지인지 말하지 못한다** — 다른 커뮤니티를 보고 있을 때 붙여넣으면 '사라진 메시지'로
 * 보인다. 지금 형식을 바꾸지 않는 이유: 이미 나간 링크가 있고, 서버를 무엇으로 적을지는
 * #163 계열의 결정이다.
 */
export function parseMessagePermalink(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(MESSAGE_PERMALINK_PREFIX)) return null;
  const id = trimmed.slice(MESSAGE_PERMALINK_PREFIX.length);
  return UUID_PATTERN.test(id) ? id : null;
}

/**
 * 링크가 가리키는 메시지가 **어디에 있는가**. `GET /messages/:id` 의 응답이 이것을 만족한다
 * (`MessageRow` 가 구조적으로 들어맞는다).
 *
 * 이름을 따로 두는 이유: 링크를 여는 쪽이 실제로 필요한 것은 본문이 아니라 이 두 좌표다.
 * `threadRootId` 가 있으면 스레드 패널까지 열어야 한다 — 답글을 스레드 밖에서 보면 맥락을 잃는다.
 */
export interface MessageLocation {
  channelId: string;
  threadRootId: string | null;
}

/**
 * 한 이모지에 누가 눌렀는지. `count`·`mine` 이 아니라 누른 사람 목록인 이유는 요청자에 따라
 * 값이 달라지면 같은 페이로드를 여러 명에게 브로드캐스트할 수 없기 때문이다.
 * count 는 `accountIds.length`, '내가 눌렀나' 는 `includes(me.id)` 로 클라이언트가 센다.
 */
export interface ReactionRow {
  emoji: string;
  accountIds: string[];
}

/**
 * 클라이언트가 보는 첨부. `storageKey` 와 `uploaderId` 는 **일부러 없다** — 스토리지 키가
 * 새어 나가면 그 자체가 접근 경로가 되고, 업로더는 메시지 작성자와 같으므로 중복이다.
 */
export interface AttachmentRow {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}

/**
 * 채널 파일 색인의 한 줄(#232). `AttachmentRow` 에 "어느 메시지에서 왔는가"를 더한 것이다 —
 * 이 화면의 유일한 동작이 '누르면 그 메시지로 간다'(`controller.openMessage`)이므로
 * `messageId` 가 곁가지가 아니라 본체다.
 *
 * 올린 사람은 `uploaderId` 가 아니라 메시지 작성자(`authorId`)로 준다. `AttachmentRow` 가
 * `uploaderId` 를 일부러 뺀 이유가 "업로더는 메시지 작성자와 같으므로 중복"이라는 것이고,
 * 그 판단을 여기서 되돌리면 같은 사실을 두 이름으로 부르게 된다.
 */
export interface ChannelFileRow extends AttachmentRow {
  messageId: string;
  /** 그 메시지의 seq. 최신순 정렬 기준이자 `before` 커서에 그대로 넣는 값이다. */
  messageSeq: number;
  authorId: string;
  /** 첨부가 오간 시각 = 그 메시지의 작성 시각(ISO). 업로드 시각이 아니다. */
  createdAt: string;
}

/**
 * 미답 물음 한 마디 — **누가 누구를 기다리는가**(#488 A3-b).
 *
 * 화면의 `waitChain()` 이 이것들을 이어 붙여 `codex → forge → 나` 를 만든다.
 */
export interface OpenAskLink {
  /** 기다리는 쪽 — 그 물음을 낸 계정. */
  waiter: string;
  /** 답해야 하는 쪽. **`null` 은 '사람 아무나'** 다. */
  blockedBy: string | null;
  /** 이 마디가 생긴 시각. 경과("3분째")를 말하는 데 쓴다. */
  askedAt: string;
}

export interface MessageRow {
  id: string;
  seq: number;
  channelId: string;
  threadRootId: string | null;
  authorId: string;
  body: string;
  /**
   * `'wake'` 는 에이전트가 자기를 나중에 깨우려고 걸어 둔 **대기 줄**이다(#533 후속).
   * 결과 발화가 아니므로 `progress` 와 같은 취급을 받는다 — 러너의 발화 판정에서
   * 세지 않는다(agent/src/prompt.ts::countOwnPostsSince).
   */
  kind: 'user' | 'system' | 'progress' | 'wake';
  meta: Record<string, unknown>;
  createdAt: string;
  /** 수정된 적이 없으면 null. */
  editedAt: string | null;
  /** 아무도 안 눌렀으면 빈 배열. 필드가 없는 것과 구분해야 UI 가 분기할 필요가 없다. */
  reactions: ReactionRow[];
  /** 첨부가 없으면 빈 배열. 사용자가 고른 순서를 지킨다. */
  attachments: AttachmentRow[];
  /** 스레드 루트에만 있음. 답글 수. */
  replyCount: number | null;
  /** 스레드 루트에만 있음. 마지막 답글 시각. */
  lastReplyAt: string | null;
  /** 스레드 루트에만 있음. 답글 작성자 목록 (중복 없음). */
  participantIds: string[] | null;
  /**
   * 스레드 상태의 **재료**(Task 6 Step 2). 이 필드들이 한 덩이로 움직인다 — 서버가 판정하지
   * 않고 사실만 싣는다.
   *
   * **왜 판정이 아니라 재료인가:** 판정은 화면의 순수 함수 `threadState()` 하나가 하고,
   * 그 함수의 축 하나인 **러너 생존은 클라이언트만 안다**(소켓이 끊긴 '모른다'와 정말 죽은
   * 것을 서버는 구분해 줄 수 없다). 서버가 상태를 계산해 실으면 같은 5단이 두 벌이 되고,
   * 둘은 반드시 갈라진다.
   *
   * **왜 이것이 필요한가:** 답글은 스레드를 열 때만 로드되므로 채널 목록에는 루트만 있다.
   * 그 상태로 판정을 걸면 **열어 보지 않은 스레드가 전부 '끝남'으로 보인다** — 화면이
   * 사람에게 하는 거짓말이다. 이 다섯 필드가 그 구멍을 메운다.
   *
   * `replyCount` 와 같은 규약으로 **스레드 루트에만 있고 답글에서는 null** 이다. 또한 메시지
   * 하나를 내주는 경로(POST·PATCH·링크·핀·검색)에서도 null 이다 — 그 자리들은 스레드를
   * 요약하는 자리가 아니다.
   */
  /** 미답 물음 중 '사람 아무나'(`ask.to.kind === 'human'`)에게 간 것의 수. */
  openAskHumanCount: number | null;
  /** 미답 물음 중 특정 계정에게 간 것들의 수신자 id. 중복 없음. */
  openAskAccountIds: string[] | null;
  /**
   * 미답 물음의 **마디들** — `누가 → 누구를` 기다리는가(#488 A3-b).
   *
   * **왜 `openAskAccountIds` 로는 부족한가:** 그 배열은 '답해야 하는 쪽'만 모은 집합이라
   * **누가 물었는지가 지워진다.** 대기 사슬은 `codex → forge → 나` 처럼 마디를 이어
   * 붙이는 것이라 짝이 필요하다 — 집합만으로는 어느 물음이 어느 물음에 이어지는지
   * 복원할 수 없다.
   *
   * **왜 메시지를 통째로 싣지 않는가:** 화면이 이 사슬에서 실제로 쓰는 것은 셋뿐이다 —
   * 두 계정과 **가장 오래된 마디의 시각**(경과를 말하는 자리). 답글 본문까지 실으면
   * 채널 목록 응답이 스레드 수만큼 부풀고, 그 대부분은 그려지지 않는다.
   *
   * `blockedBy` 가 `null` 인 것은 **'사람 아무나'** 다 — `openAskHumanCount` 와 같은
   * 구별이며, 같은 이유로 계정 id 로 대신 채우지 않는다.
   *
   * 순서는 **낸 순**(`seq`)이다. 사슬은 가장 최근 물음에서 출발하므로 화면이 뒤에서
   * 집는다.
   */
  openAskLinks: OpenAskLink[] | null;
  /**
   * 이 스레드에 실패(`meta.kind === 'failure'`)가 **몇 번 있었는가**. 0 이면 없다.
   *
   * **누적이다 — 상태가 아니다.** 화면이 이것으로 '막힘'을 칠하면 한 번 실패한 스레드는
   * 그 뒤에 에이전트가 다시 붙어 잘 돌고 있어도 **영원히 붉다.** 판정에 쓸 것은
   * 아래 `unresolvedFailureCount` 다. 이 값은 옛 서버와의 하위호환으로만 남아 있다.
   */
  failureCount: number | null;
  /**
   * 그중 **아직 안 풀린** 실패의 수.
   *
   * 실패는 사람이 손으로 지우는 것이 아니라 **에이전트가 다시 움직이면 풀린다** — 그래서
   * "그 실패보다 뒤에 에이전트의 말이 있는가"로 센다. 에이전트의 말이란 진행 설명·완료
   * 보고이거나, **그 실패를 낸 계정 자신의 아무 말**이다(마지막 답을 평범한 글로 내는
   * 러너가 있다). 사람이 "왜 안 돼?"라고 되묻는 것은 풀지 않는다 — 그때야말로 막힌 것이
   * 맞기 때문이다.
   *
   * `null` 인 경우가 두 가지이고 **뜻이 다르다**: 답글 행이라 요약할 자리가 아니거나,
   * 이 필드를 모르는 **옛 서버**다. 후자에서 화면은 `failureCount` 로 물러난다 — 해소를
   * 모를 때는 실패를 숨기는 쪽보다 남기는 쪽이 안전하다.
   */
  unresolvedFailureCount: number | null;
  /**
   * 스레드의 **마지막 말**의 종류. `'progress'` 일 때만 '도는 중'일 수 있다 —
   * 실제로 도는지는 `lastAuthorId` 의 생존을 아는 클라이언트가 판정한다.
   */
  lastKind: 'user' | 'system' | 'progress' | null;
  /** 그 마지막 말의 저자. 생존을 물어볼 대상이다. */
  lastAuthorId: string | null;
  /** 스레드 답을 채널에도 함께 올린다(#231). threadRootId 가 없으면 이 값은 항상 false 다. */
  alsoInChannel: boolean;
}

/**
 * 부름의 결과를 싣는 응답 헤더(Task 8 Step 2) — **누구를 불렀는가**.
 *
 * 서버는 `postMessage` 에서 `notified` 를 이미 계산하지만 지금까지 inbox 이벤트를 쏘는 데만
 * 쓰고 버렸다. 그래서 `@channel` 이나 집합을 부른 사람이 "셋을 불러 둘만 깼다"를 말할 자료가
 * 화면에 없었다.
 *
 * **왜 본문이 아니라 헤더인가.** `POST /channels/:id/messages` 의 응답 본문은 `MessageRow`
 * **그 자체**이고, 데스크탑은 그것을 그대로 `upsertMessages` 로 스토어에 넣는다
 * (`controller.ts::send`). 본문에 `notified` 를 형제 키로 얹으면 그 값이 스토어의
 * `MessageRow` 로 흘러들어, WebSocket 으로 오는 같은 메시지(그 키가 없다)와 모양이 달라진다 —
 * 같은 한 줄이 어느 경로로 왔느냐에 따라 다른 값을 갖는 것은 조용한 결함의 씨앗이다.
 * 반대로 응답을 `{ message, notified }` 봉투로 바꾸는 것은 기존 응답 모양을 깨는 일이라
 * 서버 테스트 41 개와 클라이언트가 함께 무너진다.
 *
 * 헤더는 **본문 밖**이라 둘 다 피한다: `MessageRow` 는 한 글자도 넓어지지 않고, 지금 본문만
 * 읽는 호출부는 그대로 돈다. `attachmentRoutes`·`avatarRoutes` 가 이미 응답의 부수 사실을
 * 헤더로 싣는 선례다.
 *
 * MCP 쪽은 응답이 이미 `{ message }` **봉투**라 사정이 다르다 — 거기서는 `notified` 를
 * 형제 키로 둔다(`MessageRow` 를 오염시키지 않으면서 JSON 하나로 끝난다).
 */
export const NOTIFIED_HEADER = 'x-murmur-notified';

/**
 * 부른 사람의 **총수**를 싣는 헤더. `NOTIFIED_HEADER` 가 잘렸을 때 화면이 "외 N 명"을 말할
 * 수 있게 한다.
 *
 * **왜 수를 따로 싣는가:** `@channel` 은 그 채널을 볼 수 있는 계정 **전부**를 부를 수 있어
 * 명단에 상한이 없다. 그런데 HTTP 헤더는 전체가 16KB(Node 기본값)를 넘으면 응답 자체가
 * 깨지고, uuid 하나가 37 바이트라 수백 명이면 그 선에 닿는다. **명단을 자르되 수는 정확히**
 * 두는 것이 이 두 헤더의 분업이다 — 잘린 명단만 있으면 화면이 조용히 적은 수를 말한다.
 */
export const NOTIFIED_COUNT_HEADER = 'x-murmur-notified-count';

/**
 * `NOTIFIED_HEADER` 에 실을 id 의 최대 개수. 37 바이트 × 100 ≈ 3.7KB 로, 다른 헤더와 합쳐도
 * 16KB 한계에 여유가 있다. 화면이 이름을 그리는 것은 어차피 앞의 몇 명뿐이고 나머지는
 * `NOTIFIED_COUNT_HEADER` 의 수로 말한다.
 */
export const NOTIFIED_HEADER_MAX_IDS = 100;

/**
 * 선택 요청의 수신자 — **누가 답해야 진행되는가**.
 *
 * `'human'` 은 특정 사람이 아니라 **사람 아무나**다. 스레드에 사람이 여럿 있어도 먼저 고른
 * 사람이 이기고, 그것이 이 제품의 규칙이다(누가 고를지 지정하는 것은 이 어휘가 답할 문제가
 * 아니다 — 그렇게 하고 싶으면 `account` 로 사람의 accountId 를 싣는다).
 *
 * **왜 합 타입인가:** `accountId?: string` 하나로 두면 "없음"이 두 뜻이 된다 —
 * '사람 아무나'와 '아직 안 정했다'. 화면은 그 둘을 다르게 그려야 하는데(전자는 강조,
 * 후자는 그릴 수 없다) 필드 하나로는 구별이 안 된다.
 */
export type AskAudience =
  | { kind: 'human' }
  | { kind: 'account'; accountId: string };

/** 선택지 하나. `id` 는 답을 기록할 때 쓰는 열쇠이므로 한 요청 안에서 유일해야 한다. */
export interface AskOption {
  id: string;
  label: string;
  /** 고르기 전에 읽는 한 줄 — "되돌리기 쉽다" 같은 판단 근거. 없어도 된다. */
  hint?: string;
}

/**
 * 선택 요청(`message.ask`). 에이전트가 갈림길에서 선택지를 내놓고, 수신자가 고르면 그 즉시
 * 진행된다 — 사람이 다시 타이핑하지 않는 것이 이 어휘의 존재 이유다.
 *
 * **`to` 를 옵셔널로 두지 않는다.** 없는 수신자를 화면이 '사람 아무나'로 해석해야 하는데,
 * 그 해석을 화면마다 반복하면 갈라진다. 보내는 쪽이 항상 정하게 한다 — 그래야 "모든 선택지가
 * 강조를 받는" 버전이 한 번도 배포되지 않는다(규칙 04).
 *
 * **답은 원본을 고치지 않는다.** 고른 결과는 `answeredWith`/`By`/`At` 로 덧붙고, 본문과
 * `editedAt` 은 그대로다 — 사람이 글을 고친 것이 아니기 때문이다.
 */
export interface AskMeta {
  kind: 'ask';
  ask: {
    /** 무엇을 묻는지. 본문에 이미 적혀 있으면 생략한다 — 같은 말을 두 번 그리지 않는다. */
    prompt?: string;
    options: AskOption[];
    to: AskAudience;
    /** 고른 옵션의 `id`. 없으면 아직 아무도 답하지 않았다. */
    answeredWith?: string;
    /** 고른 계정. 사람일 수도 에이전트일 수도 있다. */
    answeredBy?: string;
    answeredAt?: string;
  };
}

/** 선택지 개수의 경계. 하나면 선택이 아니고, 여섯이면 읽히지 않는다. */
export const ASK_MIN_OPTIONS = 2;
export const ASK_MAX_OPTIONS = 5;

/**
 * 대기 줄(wake)의 meta — 에이전트가 걸어 둔 예약의 **시각**을 싣는다(마이그레이션 040).
 *
 * 왜 본문에 "15:20 에 다시 봅니다" 로 굽지 않는가: 그렇게 만든 문자열은 서버의 시간대에
 * 고정되고, 다른 시간대에서 읽는 사람에게 거짓이 된다. 서버는 사실(ISO 시각)만 싣고
 * 읽는 쪽이 자기 시간대로 읽는다 — 이 저장소가 판정과 표시를 나누는 방식 그대로다.
 */
export interface WakeMeta {
  kind: 'wake';
  wake: { wakeAt: string; reason?: string };
}

/**
 * `meta` 가 대기 줄인지 판정한다. `readAskMeta` 와 같은 판례를 따른다 — 형식을 못 알아보면
 * `null` 을 주고 화면은 본문만 그린다. 시각을 못 읽는다고 대기가 없던 일이 되지는 않으므로,
 * 이 함수가 null 이어도 줄 자체는 `kind='wake'` 로 그려진다(호출부의 책임 경계다).
 */
export function readWakeMeta(meta: Record<string, unknown> | null | undefined): WakeMeta['wake'] | null {
  if (!meta || meta.kind !== 'wake') return null;
  const wake = meta.wake as WakeMeta['wake'] | undefined;
  if (!wake || typeof wake !== 'object') return null;
  if (typeof wake.wakeAt !== 'string') return null;
  return wake;
}

/**
 * `meta` 가 선택 요청인지 판정한다. **모르는 `meta` 는 평문으로 흘린다**가 이 계획 전
 * 구간의 불변식이므로, 형식을 못 알아보면 `null` 을 주고 화면은 본문만 그린다 — 빈 상자는
 * "여기 뭔가 있다"는 거짓 신호다.
 *
 * 서버·화면이 같은 판정을 써야 하므로 shared 에 둔다. 한쪽에만 두면 구/신 버전 조합에서
 * 두 판정이 갈린다.
 */
export function readAskMeta(meta: Record<string, unknown> | null | undefined): AskMeta['ask'] | null {
  if (!meta || meta.kind !== 'ask') return null;
  const ask = meta.ask as AskMeta['ask'] | undefined;
  if (!ask || typeof ask !== 'object') return null;
  if (!Array.isArray(ask.options)) return null;
  // 개수 경계를 **읽는 쪽에서도** 지킨다: 옛 서버나 손으로 쓴 meta 가 1개짜리 선택지를
  // 실어 보낼 수 있고, 그것은 선택이 아니라 통보다.
  if (ask.options.length < ASK_MIN_OPTIONS || ask.options.length > ASK_MAX_OPTIONS) return null;
  if (!ask.options.every((o) => o && typeof o.id === 'string' && typeof o.label === 'string')) return null;
  // 수신자를 못 읽으면 그리지 않는다 — 이것을 '사람 아무나'로 넘겨 주면 남에게 간 물음이
  // 내 화면에서 강조를 받는다. 그 사고를 타입이 아니라 이 줄이 막는다.
  const to = ask.to;
  if (!to || (to.kind !== 'human' && to.kind !== 'account')) return null;
  if (to.kind === 'account' && typeof to.accountId !== 'string') return null;
  return ask;
}

/**
 * 실패(`message.fail`) — 에이전트가 **스스로 못 끝냈다**.
 *
 * 여덟 가지 말 중 유일하게 **에이전트가 먼저 사람을 부르는** 말이다. 넘겨받은 에이전트가
 * 실패해도 결국 사람에게 온다 — 사슬의 끝은 언제나 사람이다.
 *
 * **`to` 가 없다.** `AskMeta` 와 달리 수신자를 싣지 않는 것이 이 어휘의 요점이다:
 * 실패의 수신자는 언제나 사람이므로 필드로 둘 것이 없다. 두면 "에이전트에게 간 실패"라는
 * 표현할 수 없는 상태가 타입에 생기고, 화면은 그것을 그릴 방법이 없다.
 *
 * **고치는 경로를 함께 싣는다**(`retryable`). 디자인 문서가 "고치는 경로가 같은 자리에"라고
 * 적은 요구다 — 실패를 알리기만 하고 다음 수를 사람이 찾아 헤매게 하면 개입 비용이 올라간다.
 */
export interface FailureMeta {
  kind: 'failure';
  failure: {
    /** 무엇을 하려다 실패했는가. 한 줄. 본문에 이미 있으면 생략한다. */
    what?: string;
    /**
     * 왜 못 끝냈는가. **사람이 읽는 말**이지 스택트레이스가 아니다 — 자세한 것은 터미널이
     * 답한다(규칙 06). 없을 수도 있다: 러너가 죽으면 이유를 남길 자가 없다.
     */
    reason?: string;
    /**
     * 다시 부르면 될 일인가. `false` 는 "다시 불러도 같은 결과"라는 뜻이므로 화면이
     * '다시 부르기'를 그리지 않는다 — 눌러도 안 되는 버튼은 없는 문을 그리는 것이다(규칙 06).
     */
    retryable: boolean;
  };
}

/**
 * `meta` 가 실패인지 판정한다. `readAskMeta` 와 같은 규약이다 — **모르는 `meta` 는 평문으로
 * 흘린다**가 전 구간의 불변식이므로, 형식을 못 알아보면 `null` 을 주고 화면은 본문만 그린다.
 *
 * `retryable` 이 boolean 이 아니면 못 알아본 것으로 친다. 기본값을 정해 주지 않는 이유:
 * `true` 로 치면 다시 불러도 소용없는 실패에 버튼이 생기고, `false` 로 치면 고칠 수 있는
 * 실패의 경로가 사라진다. 둘 다 거짓 신호이므로 **보내는 쪽이 반드시 정하게 한다.**
 */
export function readFailureMeta(
  meta: Record<string, unknown> | null | undefined,
): FailureMeta['failure'] | null {
  if (!meta || meta.kind !== 'failure') return null;
  const failure = meta.failure as FailureMeta['failure'] | undefined;
  if (!failure || typeof failure !== 'object') return null;
  if (typeof failure.retryable !== 'boolean') return null;
  return failure;
}

/** 완료 보고 뒤에 붙는 다음 제안 하나. 누르면 새 부탁이 된다. */
export interface ReportNext {
  id: string;
  label: string;
}

/**
 * 완료 보고(`message.report`) — 무엇을 했고, 무엇이 바뀌었고, 무엇이 남았는가.
 *
 * **이 스레드에서 가장 오래 남고 가장 많이 다시 읽히는 말이다.** 그래서 자유 문장이 아니라
 * 형식이어야 한다 — 형식이 있어야 나중에 훑어 읽힌다.
 *
 * **강조색을 쓰지 않는다.** 읽히는 말이지 막는 말이 아니다(규칙 03) — 보고에 강조를 주면
 * "내 차례"라는 신호가 그만큼 흐려진다.
 *
 * `checks` 만 필수인 이유: 나머지는 없을 수 있지만(바꾼 파일이 없는 작업도 있다) **무엇을
 * 확인했는지 없는 보고는 보고가 아니다.** 그것이 비면 화면은 카드를 그리지 않고 본문만 보여
 * 준다 — 빈 상자는 "여기 뭔가 있다"는 거짓 신호다.
 */
export interface ReportMeta {
  kind: 'report';
  report: {
    /** 확인한 것들. 비면 형식을 못 갖춘 것으로 친다. */
    checks: string[];
    /** 바뀐 파일. 없는 작업도 있다. */
    files?: string[];
    /** 남은 것 — 이 보고가 닫지 못한 것. */
    remaining?: string[];
    durationMs?: number;
    /** "다음으로 이걸 할까?" 누르면 새 부탁이 된다. */
    next?: ReportNext[];
  };
}

/** 보고의 경계. 하나도 없으면 보고가 아니고, 너무 많으면 읽히지 않는다. */
export const REPORT_MAX_ITEMS = 20;
export const REPORT_MAX_NEXT = 4;

/**
 * `meta` 가 완료 보고인지 판정한다. `readAskMeta`·`readFailureMeta` 와 같은 규약이다 —
 * **모르는 `meta` 는 평문으로 흘린다.**
 *
 * `checks` 가 비면 `null` 이다: 형식을 안 지킨 보고는 **조용히 사라져** 본문만 남는다.
 * 계획서가 "형식을 안 지키면 조용히 사라지는 설계가 필수"라고 적은 그 자리다.
 */
export function readReportMeta(
  meta: Record<string, unknown> | null | undefined,
): ReportMeta['report'] | null {
  if (!meta || meta.kind !== 'report') return null;
  const report = meta.report as ReportMeta['report'] | undefined;
  if (!report || typeof report !== 'object') return null;
  if (!Array.isArray(report.checks) || report.checks.length === 0) return null;
  if (!report.checks.every((c) => typeof c === 'string' && c.length > 0)) return null;
  return report;
}

/**
 * 발화에 실린 **모델**. 에이전트가 자기 입으로 신고한다(#600).
 *
 * **왜 자기 신고인가.** murmur 는 실제로 쓰인 모델을 알 방법이 없다 — 아는 것은 설정값
 * (`agent_config.model` → `agent_defaults.model`)뿐이고, 그것이 `null` 이면 러너는
 * `--model` 플래그를 아예 붙이지 않아(`agent/src/turn.ts`) 결정이 하네스로 넘어간다.
 * 러너는 하네스 출력을 해석하지 않는다는 경계(pty.ts)가 있어 stream-json 의 init 에서
 * 캐낼 수도 없다. 반면 **에이전트 자신은 자기 모델을 안다** — 하네스가 시스템 프롬프트에
 * 넣어 주기 때문이다. 그래서 가장 싸고 정확한 출처가 발화하는 그 자신이다.
 *
 * **`meta.kind` 를 쓰지 않는 이유**: ask·report·failure 는 그 발화가 *무엇인지*를 말하는
 * 배타적 종류인데, 모델은 그것들과 **직교**한다(보고에도 모델이 있다). 그래서 `kind` 를
 * 보지 않고 `meta.model` 키만 본다 — 완료 보고가 모델을 실어도 보고로 남는다.
 */
export interface ModelMeta {
  model: {
    /** 하네스가 알려 준 모델 ID 그대로(`claude-opus-5[1m]` 처럼 꾸밈이 붙어 있어도 그대로). */
    id: string;
    /**
     * 설정된 모델과 **계열이 어긋난다**. 어긋날 때만 있다 — 맞으면 키가 없다.
     *
     * 판정은 서버가 하고(`modelsDisagree`), 설정값 자체는 싣지 않는다: harness·model 은
     * admin·소유자만 보는 값인데(`GET /accounts/agents`) meta 는 채널을 보는 모두에게
     * 간다. 어긋났다는 **사실**만으로 화면이 할 일은 충분하다.
     */
    mismatch?: true;
  };
}

/** 모델 ID 의 상한. 하네스가 긴 ID 를 쓰더라도 meta 가 본문만큼 커지지는 않게 한다. */
export const MODEL_ID_MAX = 120;

/**
 * `meta` 가 모델을 싣고 있는지 판정한다. `readAskMeta` 와 같은 규약이다 — **모르는 `meta` 는
 * 평문으로 흘린다.** 형식을 못 알아보면 `null` 이고, 화면은 아무것도 그리지 않는다.
 */
export function readModelMeta(
  meta: Record<string, unknown> | null | undefined,
): ModelMeta['model'] | null {
  if (!meta) return null;
  const model = meta.model as ModelMeta['model'] | undefined;
  if (!model || typeof model !== 'object') return null;
  if (typeof model.id !== 'string') return null;
  const id = model.id.trim();
  if (id.length === 0 || id.length > MODEL_ID_MAX) return null;
  return { id, ...(model.mismatch === true ? { mismatch: true as const } : {}) };
}

/** 아는 계열의 이름들. 여기 없는 이름은 '모른다'로 다루고 경고하지 않는다. */
const MODEL_FAMILIES = ['opus', 'sonnet', 'haiku', 'fable', 'gpt', 'codex', 'gemini'] as const;

/**
 * 모델 ID 에서 **계열**을 뽑는다(`claude-opus-5[1m]` → `opus`, `sonnet` → `sonnet`).
 *
 * 계열까지만 보는 이유는 같은 모델을 부르는 이름이 여럿이기 때문이다: 설정에는 별칭
 * (`opus`)을 쓰고 하네스는 정식 ID(`claude-opus-5`)를 말하며, 거기에 `[1m]` 같은 꾸밈이
 * 붙는다. 문자열을 그대로 비교하면 **맞는데 어긋났다고 말한다** — 거짓 경고는 아무 경고도
 * 없는 것보다 나쁘다(그때부터 사람은 배지를 안 믿는다).
 */
export function modelFamily(id: string | null | undefined): string | null {
  if (!id) return null;
  const lower = id.toLowerCase();
  return MODEL_FAMILIES.find((f) => lower.includes(f)) ?? null;
}

/**
 * 설정된 모델과 신고된 모델이 **어긋나는가**. 둘 다 계열을 알아볼 수 있고 그 계열이 다를
 * 때만 `true` 다.
 *
 * 한쪽이라도 계열을 모르면 `false` 다 — 새 모델 이름이 나올 때마다 이 목록이 뒤처지는데,
 * 뒤처짐이 거짓 경고로 나타나면 안 된다. 모르는 것은 조용히 넘긴다.
 */
export function modelsDisagree(
  configured: string | null | undefined, reported: string | null | undefined,
): boolean {
  const a = modelFamily(configured);
  const b = modelFamily(reported);
  if (a === null || b === null) return false;
  return a !== b;
}

export interface ChannelRow {
  id: string;
  name: string | null;
  topic: string;
  kind: 'standard' | 'dm';
  repo: string | null;
  archivedAt: string | null;
  /**
   * 공개 범위(#182). **옵셔널이 아닌 이유**: 옵셔널로 두면 이 필드를 안 넘기는 호출부가
   * 조용히 통과하고, 화면은 `undefined` 를 public 으로 읽어 private 채널에 자물쇠가
   * 사라진다. 필수로 두면 타입 검사가 그런 자리를 전부 짚는다.
   *
   * private 은 '보이지만 못 읽는다'가 아니라 '멤버만 존재를 안다'다 — 이 값이 'private'
   * 인 행을 받았다는 것 자체가 이미 '나는 멤버이거나 admin 이다'라는 뜻이다.
   */
  visibility: 'public' | 'private';
  /**
   * 채널이 만들어진 시각(#180). **옵셔널이 아닌 이유**: 채널 디렉터리의 "생성순" 정렬은
   * 클라이언트에서 하고, 이 값이 없으면 비교 함수가 쓸 것이 없다. 옵셔널로 두면 정렬은
   * 조용히 원래 순서를 그대로 두고 — `listChannels` 는 `order by name` 이라 — 사용자에게는
   * "생성순을 눌러도 이름순"으로 보인다. 필수로 두면 타입 검사가 이 값을 안 싣는 자리를 짚는다.
   */
  createdAt: string;
}

/** 채널 멤버 한 명. 멤버 목록 화면이 handle 을 따로 조회하지 않도록 함께 준다. */
export interface ChannelMemberRow {
  accountId: string;
  handle: string;
}

/**
 * 채널이 자동으로 멘션하는 에이전트 한 명(#173). 채널 전역 사실이다 — 누가 봐도 같다.
 *
 * `handle` 을 함께 주는 이유는 `ChannelMemberRow` 와 같다: 작성창이 칩을 그리려면 handle 이
 * 필요하고, 그것을 위해 디렉터리를 다시 뒤지게 하면 디렉터리가 아직 안 온 순간 칩이 비었다가
 * 나타난다. 접두는 이 handle 로 만든다.
 */
export interface ChannelAutoMentionRow {
  channelId: string;
  agentAccountId: string;
  handle: string;
  createdBy: string;
  createdAt: string;
}

/**
 * 채널 문서(#188). 채널당 하나고 덮어쓰기다 — 메시지의 추가와는 성질이 다르다.
 *
 * `updatedBy` 와 `updatedAt` 은 화면에 "누가 언제"를 보여주는 용도다. 에이전트가
 * 읽을 수 있지만 쓰지는 못한다(쓰기 도구를 제공하지 않는다).
 *
 * **둘이 nullable 인 이유:** 아직 아무도 저장하지 않은 채널도 이 모양으로 읽힌다
 * (본문 `''`). 그때 "누가 언제"를 **지금 시각과 보는 사람으로 채우면 화면이 거짓말한다** —
 * 아무도 쓴 적 없는 문서를 내가 방금 고친 것처럼 보여 준다. 게다가 그 가짜 시각이
 * `expectedUpdatedAt` 으로 되돌아오면 낙관적 동시성 검사가 무엇과 비교하는지 알 수 없게
 * 된다. `null` 은 "아직 아무도"이고, 그 상태로 저장하는 것이 첫 저장이다.
 */
export interface ChannelDoc {
  channelId: string;
  body: string;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface InboxEntry {
  id: number;
  messageId: string;
  /**
   * `'wake'` 는 **자기가 걸어 둔 깨움**이 시각이 되어 자기를 부른 것이다. 사람의 부름과
   * 갈라 두는 이유: 러너가 프롬프트를 다르게 조립해야 한다 — 깨움에는 새 사람 발화가
   * 없어서 델타가 비고, 비면 하네스를 돌리지 않는다(agent/src/mentionTurn.ts).
   */
  reason: 'mention' | 'thread_reply' | 'dm' | 'wake';
  readAt: string | null;
  channelId: string;
  /**
   * 줄이 **네 가지를 말하기 위한 재료**(#488 C2). 문서: *"줄은 네 가지를 말한다 —
   * 누가(얼굴) · 무슨 말(되물음·선택·보고·넘김) · 무엇을(본문 한 줄) · 언제·어디.
   * 지금 줄에는 이 중 어느 것도 없다."*
   *
   * **`reason` 으로는 못 만든다.** 그 값은 셋뿐이라(`mention`·`thread_reply`·`dm`)
   * 네 줄이 글자까지 똑같아진다 — 문서가 지적한 그 화면이다. 말의 종류는 `meta` 에
   * 있고(`AskMeta`·`FailureMeta`·`ReportMeta`), 그것을 실어야 줄이 갈린다.
   *
   * 문서가 이 화면을 "말의 종류가 `meta` 에 들어간 다음 제 모습이 된다"고 적었는데,
   * 그 문턱은 이미 넘었다 — 여기서 하는 일은 **그 사실을 인박스까지 나르는 것**이다.
   */
  authorId: string | null;
  /** 본문 한 줄. 서버가 자르지 않는다 — 자르는 폭은 화면이 안다. */
  body: string;
  /** 말의 종류를 담은 그 `meta`. 모르는 `meta` 는 평문으로 흐른다(불변 규약). */
  meta: Record<string, unknown>;
  /** 언제. 인박스 항목이 아니라 **그 말이 오간** 시각이다. */
  createdAt: string;
  /** 어디 — 스레드 안이면 그 뿌리. 채널 바로 밑이면 null 이다. */
  threadRootId: string | null;
}

export interface DmView {
  id: string;
  memberIds: string[];
  /**
   * 이 DM 에서 **마지막으로 말이 오간 시각**. 삭제된 메시지는 세지 않고, 말이 하나도 없으면
   * `null` 이다.
   *
   * 정본 문서 `docs/desktop-rail.html` 2단계가 요구한 **"최근순 한 목록"** 의 근거다.
   * 문서: *"`DIRECT MESSAGES` 와 `AGENTS` 두 묶음을 최근순 한 목록으로."* 그 정렬 근거가
   * 화면에 없었다 — `DmView` 는 `{ id, memberIds }` 뿐이었고 서버는 `order by
   * c.created_at`(**만들어진** 순서)을 줬다.
   *
   * **옵셔널이 아닌 이유**: 옵셔널로 두면 이 값을 안 싣는 응답이 조용히 통과하고, 화면의
   * 비교 함수는 `undefined` 위에서 원래 순서를 그대로 둔다 — 사람에게는 "최근순이라는데
   * 안 바뀐다"로 보인다. `ChannelRow.createdAt` 이 같은 이유로 필수인 것과 같다.
   *
   * **`null` 은 '없다'이지 '오래됐다'가 아니다.** 갓 만들어 아직 아무 말도 없는 DM 이
   * 이 값을 갖는다 — 그것을 `0` 이나 채널 생성 시각으로 채우면 '대화한 적 없다'가
   * '그때 대화했다'로 바뀐다. 이 저장소가 모르는 것을 아는 것처럼 쓰지 않는 규약
   * (`threadState`·`waitChain`·`faceState`)과 같은 자리다. 정렬에서 어디에 둘지는
   * 화면이 정한다.
   *
   * **왜 마지막 읽음이 아닌가**: 마지막 읽음은 '내가 어디까지 봤는가'라 아직 안 열어 본
   * DM — 즉 가장 새 말이 와 있는 DM — 을 맨 아래로 가라앉힌다. 근거는
   * `routes/directoryRoutes.ts` 의 `GET /dms` 주석에 있다.
   */
  lastMessageAt: string | null;
}

/**
 * 채널별 알림 수준(#224). `muted_at` 의 on/off 를 대체한다.
 *
 * - `all`     — 이 채널의 알림을 전부 받는다(전역 알림 설정이 정한 범위 안에서).
 * - `mentions` — 나를 부른 것만 받는다.
 * - `none`    — 아무것도 받지 않는다. **멘션도 아니다.**
 *
 * `none` 에서 멘션이 예외가 아닌 것은 #229 의 결정이고 #224 가 그것을 유지한다 — 세분화가
 * 생겼으니 "덜 받겠다"는 사람에게는 `mentions` 라는 자리가 따로 있다. 이 주석이 없으면
 * "멘션은 예외였나?"가 세 번째로 논의된다.
 */
export const NOTIFY_LEVELS = ['all', 'mentions', 'none'] as const;

/**
 * 목록에서 파생한다 — 값의 집합이 **한 곳에만** 산다. 따로 적어 두면 네 번째 수준을
 * 들일 때 목록만 고치고 타입을 잊는(또는 그 반대) 사고가 난다.
 */
export type NotifyLevel = (typeof NOTIFY_LEVELS)[number];

export interface ChannelPrefRow {
  accountId: string;
  channelId: string;
  /**
   * 언제 음소거했는지의 기록. **동작 판정에 쓰지 마라** — 알림도 배지도 `notifyLevel` 만
   * 본다(#224). 같은 사실이 두 곳에 살면 한쪽만 고치는 사고가 난다.
   */
  mutedAt: string | null;
  starredAt: string | null;
  /**
   * 이 채널을 사이드바에서 치운 시각(#376). null 이면 보인다.
   *
   * **보관(`channel.archivedAt`)과 독립이다.** 보관은 채널 전체의 상태(운영자가 정한다)이고
   * 숨김은 한 사람의 상태다 — 보관된 채널도 숨길 수 있고, 숨긴 채널이 보관돼도 숨김은
   * 유지된다. 한 필드로 합치면 한 사람이 치운 채널이 모두에게서 사라진다.
   *
   * **나가기(#344)와도 다르다.** 나가기는 멤버십을 지우지만 숨김은 남긴다 — 그래서 스스로
   * 되돌릴 수 있고(다시 보이게 하기) 남에게 시스템 메시지로 보이지 않는다.
   *
   * 서버가 이 값을 **혼자서 null 로 되돌리는 경우가 하나 있다**: 나를 부르는 것이 오면
   * (`services/messages.ts` 의 `insertInbox`) 숨김이 풀린다. 그때 다시 숨지 않는 이유는
   * 그 함수 주석에 있다.
   */
  hiddenAt: string | null;
  notifyLevel: NotifyLevel;
  /**
   * 채널이 속한 섹션(#157). null 이면 섹션 없음(맨 아래 "기타").
   * 길이 1~40, 앞뒤 공백 제거, 빈 문자열은 null 로 저장.
   */
  section: string | null;
  /**
   * 섹션 안에서의 수동 순서(#157). null 이면 이름순 뒤에 붙는다.
   */
  sortOrder: number | null;
}

/**
 * pref 행에서 알림 수준을 읽는다. **행이 없으면 `mentions`** — 아무것도 정하지 않은 채널은
 * 지금 동작 그대로여야 하고, 지금 동작은 "나를 부른 것만 알린다"이다. 024 마이그레이션의
 * default 와 **반드시 같은 값이어야 한다**: 여기와 저기가 갈라지면 pref 행이 있는 채널과
 * 없는 채널이 다르게 울린다.
 *
 * `all` 을 기본값으로 두지 않는 이유: `all` 은 일반 메시지 알림이라는 **새 경로를 여는**
 * 값이다(#224 가 그 경로를 함께 들여왔다). 기본값으로 두면 아무도 고르지 않은 변화가
 * 업데이트하는 순간 모든 채널에 적용돼 모든 메시지가 OS 알림이 된다.
 *
 * `mutedAt` 은 **보지 않는다.** 알림·배지·훑기가 전부 이 한 함수를 지나가게 해서, 같은
 * 질문에 두 곳이 다르게 답하는 일을 막는다(#224).
 */
export function notifyLevelOf(pref: { notifyLevel?: NotifyLevel } | undefined | null): NotifyLevel {
  return pref?.notifyLevel ?? 'mentions';
}

/**
 * 사이드바 채널 순서(#157). **섹션 → 별표 → `sortOrder` → 이름** 4단이다.
 *
 * 사이드바 안에 흩어 놓지 않고 여기 순수 함수 하나로 두는 이유: 이 순서는 화면 세 곳
 * (채널 목록·섹션 헤더 묶기·"위로/아래로"가 계산하는 이웃)이 **같은 답**을 봐야 뜻이
 * 성립한다. 한 곳이라도 따로 정렬하면 위로 눌렀는데 다른 자리로 가는 화면이 된다.
 *
 * 각 단의 뜻:
 * - **섹션**: 이름순. 섹션 없음(null)은 맨 아래다 — 사람이 이름 지은 묶음이 먼저고,
 *   아직 정리하지 않은 것이 밑에 남는 편이 "기타"라는 말과 맞는다.
 * - **별표**: 섹션 안에서 먼저다. 별표는 섹션의 특수한 하나가 아니라 **별도 축**이다(#152).
 * - **`sortOrder`**: 사람이 손으로 매긴 순서. **값이 있는 것이 없는 것보다 앞**이다 —
 *   null 은 "아직 안 매겼다"이므로 이름순으로 뒤에 붙는다.
 * - **이름**: 나머지를 가른다.
 *
 * @param channels 각 원소는 채널 행과 그 채널의 선호(없으면 null)
 */
export function sortChannelsBySection<T extends { channel: ChannelRow; pref: ChannelPrefRow | null }>(
  channels: T[],
): T[] {
  return [...channels].sort((a, b) => {
    // 1단 — 섹션. null 을 sentinel 문자열로 바꾸지 않는다: 그러면 그 문자를 이름에 쓴
    // 섹션과 "섹션 없음"이 같은 값이 되고, 로케일에 따라 sentinel 이 맨 앞으로 가기도 한다.
    const aSection = a.pref?.section ?? null;
    const bSection = b.pref?.section ?? null;
    if (aSection !== bSection) {
      if (aSection === null) return 1;
      if (bSection === null) return -1;
      const bySection = aSection.localeCompare(bSection);
      if (bySection !== 0) return bySection;
    }

    // 2단 — 별표가 먼저.
    const aStarred = !!a.pref?.starredAt;
    const bStarred = !!b.pref?.starredAt;
    if (aStarred !== bStarred) return aStarred ? -1 : 1;

    // 3단 — 손으로 매긴 순서. 값이 있는 쪽이 앞이고, 둘 다 있으면 작은 값이 앞이다.
    const aOrder = a.pref?.sortOrder ?? null;
    const bOrder = b.pref?.sortOrder ?? null;
    if (aOrder !== bOrder) {
      if (aOrder === null) return 1;
      if (bOrder === null) return -1;
      if (aOrder !== bOrder) return aOrder - bOrder;
    }

    // 4단 — 이름.
    return (a.channel.name ?? '').localeCompare(b.channel.name ?? '');
  });
}

/**
 * 채널에 고정된 메시지 하나(#218).
 *
 * **채널 전역이다** — 보관(#153)과 같은 층이고, 음소거·즐겨찾기(#151, #152)처럼 계정별이
 * 아니다. 그래서 이 행에는 "누가 보는가"가 없고 `pinnedBy`("누가 고정했는가")만 있다.
 * `pinnedBy` 는 취향이 아니라 해제 권한의 근거다 — 해제는 고정한 사람 또는 admin 이다.
 *
 * `message` 를 통째로 싣는 이유: 핀 목록은 본문 한 줄을 미리 보여 줘야 쓸모가 있고,
 * 그것을 위해 클라이언트가 핀마다 메시지를 다시 물으면 목록 하나에 왕복이 N 번 생긴다.
 * 지워진 메시지는 여기 **아예 오지 않는다** — 서버가 `deleted_at is null` 로 조인한다.
 */
export interface PinRow {
  messageId: string;
  channelId: string;
  pinnedBy: string;
  pinnedAt: string;
  message: MessageRow;
}

/**
 * 나중에 볼 메시지 한 줄(#219). **개인 전용**이다 — 서버가 요청자 자신의 행만 내준다.
 * `createdAt`·`doneAt` 은 담은 시각·완료 시각이고, 메시지 자체의 시각은 `message.createdAt` 다.
 */
export interface SavedMessageRow {
  messageId: string;
  channelId: string;
  state: 'open' | 'done';
  createdAt: string;
  doneAt: string | null;
  /** 담아 둔 메시지가 지워졌는가. 지워져도 목록의 자리는 남는다(#219 결정 3). */
  deleted: boolean;
  /**
   * `deleted` 가 true 면 **null** 이다 — 지워진 메시지의 본문은 내주지 않는다.
   * 옵셔널이 아니라 명시적 null 인 이유: 키가 사라지면 '아직 안 받았다'와 '삭제됐다'가
   * 한 화면이 된다.
   */
  message: MessageRow | null;
}

/**
 * 사람 집합을 한 handle 로 부르는 것(#230). 저장된 명단이다 — 계산된 질의가 아니다.
 *
 * 계정과 **같은 네임스페이스**를 쓴다. `@foo` 가 사람인지 집합인지 갈라지면
 * 안 되므로, 집합을 만들 때 같은 이름의 계정이 있으면 거절하고, 계정을 만들 때도
 * 같은 이름의 집합이 있으면 거절한다.
 */
export interface HandleGroupRow {
  id: string;
  handle: string;
  displayName: string;
  createdAt: string;
  /**
   * 지금 이 집합에 든 사람 수(#285). **옵셔널이 아니라 필수다** — 이 값을 안 실어 주는
   * 경로가 하나라도 있으면 화면은 "몇 명인지 모른다"를 그릴 방법이 없고, 결국 수를 아예
   * 안 보이는 쪽으로 떨어진다. 자동완성 후보가 `@release` 를 부르기 직전에 그것이
   * 한 사람인지 스무 사람인지 보여야 하는 유일한 자리다.
   *
   * 파생값이므로 저장하지 않고 조회할 때 센다 — 저장하면 구성원 추가·제거마다 두 곳을
   * 맞춰야 하고, 한쪽만 틀린 수가 화면에 남는다.
   */
  memberCount: number;
}

/**
 * 집합의 구성원. `account_id` 로 `account` 를 조인해 계정을 가져온다.
 */
export interface HandleGroupMemberRow {
  groupId: string;
  accountId: string;
}

export interface LeaseRow {
  repo: string;
  path: string;
  actorKeyId: string;
  expiresAt: string;
}

/**
 * 투영 워커가 들고 있는 **원자료**(#267). 서버 메모리에만 산다 — 마이그레이션 없음.
 *
 * `state` 는 여기서 파생된다(`projectionState`). 파생을 라우트 핸들러에 인라인으로
 * 두지 않는 이유: 같은 판정이 서버·클라이언트·문서에 세 벌 생기면 5분 임계값을 고칠 때
 * 한 벌만 고쳐지고 화면과 API 가 서로 다른 말을 한다.
 */
export interface ProjectionRuntime {
  /** 투영 URL 이 있어서 워커가 아예 만들어졌는가(`resolveProjectionUrl` 의 결과). */
  configured: boolean;
  /** 마지막으로 폴링한 저장소. 조용한 저장소도 여기 남는다 — 폴링했다는 사실이므로. */
  repo: string | null;
  lastLogIndex: number;
  /** 마지막 폴링 시각(ms). **이것이 살아 있는가의 신호다.** */
  lastPolledAt: number | null;
  /** 커서가 마지막으로 전진한 시각(ms). 신호가 **아니다** — 아래 주석 참고. */
  lastAdvancedAt: number | null;
  /** 마지막 실패 메시지(200자). 성공 폴링이 지운다. */
  lastError: string | null;
}

export type ProjectionState = 'unconfigured' | 'stalled' | 'ok';

/**
 * 투영이 꺼져 있다는 사실을 사람·에이전트에게 말하는 **단 하나의 문구**(#381).
 *
 * 같은 사실을 말하는 자리가 셋이다: `LeasePanel` 의 ACTIVE WORK 배너(#267), `Sidebar`
 * 채널 편집의 repo 입력, 그리고 MCP `work.link` 응답. 셋이 각자 문자열을 들고 있으면
 * 문구를 고칠 때 한 벌만 고쳐지고 **화면과 API 가 같은 상태를 다른 말로 부른다** —
 * `projectionState` 를 shared 에 둔 것과 같은 이유다(판정 한 벌, 문구도 한 벌).
 *
 * 서버가 이것을 쓰는 것이 이상하지 않다: `work.link` 가 실어 보내는 것은 화면이 이미
 * 쓰는 그 문구이고, 에이전트가 사람에게 그대로 옮겨 적을 수 있어야 한다.
 */
export const PROJECTION_UNCONFIGURED_HEADLINE = '투영이 설정되지 않았다';
/** 무엇을 하면 되는지. 배너에서는 headline 아래 줄이다. */
export const PROJECTION_UNCONFIGURED_DETAIL = '앱 설정이나 AVCS_BASE_URL 로 켠다';
/** 한 줄로 써야 하는 자리(좁은 폼, API 응답)용. 위 둘에서 **파생**한다 — 세 번째 사본이 아니다. */
export const PROJECTION_UNCONFIGURED_NOTICE =
  `${PROJECTION_UNCONFIGURED_HEADLINE} — ${PROJECTION_UNCONFIGURED_DETAIL}`;

/** 투영 URL 이 어디서 왔는가. 화면이 이것을 사람 말로 바꿔 적는다. */
export type ProjectionUrlSource = 'app' | 'env';

export interface ResolvedProjectionUrl {
  url: string | null;
  /** url 이 null 이면 source 도 null — 출처 없는 값에 출처를 붙이지 않는다. */
  source: ProjectionUrlSource | null;
}

/**
 * 투영 URL 의 **표준형**. 이 값이 `projection_cursor`·`active_lease` 의 키가 되므로
 * (마이그레이션 042) 겉보기만 다른 두 문자열이 서로 다른 행을 뜻하면 안 된다 — 그러면
 * 오타가 아닌 저장 한 번이 전재스캔과 그 사이의 빈 `/leases` 를 만든다.
 *
 * `httpAvcsClient` 의 슬래시 자르기와 다른 관심사다: 그것은 요청 URL 조립의 방어선이고
 * 이것은 저장되는 키의 표준형이다.
 *
 * `new URL` 이 스킴·호스트 소문자화와 기본 포트 접기를 해 준다. 후행 슬래시는 오히려
 * `pathname` 에 `'/'` 로 채워 넣으므로 직접 자른다. 경로 대소문자는 손대지 않는다 —
 * 경로는 실제로 대소문자를 구분한다. 호스트의 후행 점도 자르지 않는다(그 나름의 함정이 있다).
 */
export function canonicalAvcsBaseUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * env 와 앱 설정 중 **무엇으로 투영을 돌리는가**.
 *
 * 앱(DB)이 이긴다. env 는 앱 값이 없을 때만 쓰는 기본값이다. 이 판정이 서버(부팅·재설정)와
 * 라우트 응답 양쪽에 살면 화면과 API 가 같은 상태를 다른 말로 부른다 — `projectionState` 를
 * 여기 둔 것과 같은 이유다.
 *
 * 빈 문자열을 값으로 세지 않는다. 세면 지우기와 오타 저장이 같은 값이 된다.
 *
 * **돌려주는 `url` 은 표준형이다.** URL 이 (repo 와 함께) DB 키가 된 지금(042), env 든
 * 앱이든 여기를 거치지 않고 `baseUrl` 로 흘러가는 값이 없어야 한다 — 한쪽만 표준화하면
 * `AVCS_BASE_URL=http://a:3000/` 로 뜬 서버와 앱에서 `http://a:3000` 을 저장한 서버가
 * 여전히 다른 행을 쓴다. 표준형이 `null` 이면(값이 URL 형태가 아니면) 그 출처는 값이
 * 없는 것으로 취급하고 다음 출처로 떨어진다.
 */
export function resolveProjectionUrl(
  envUrl: string | null, appUrl: string | null,
): ResolvedProjectionUrl {
  const app = appUrl ? canonicalAvcsBaseUrl(appUrl) : null;
  if (app) return { url: app, source: 'app' };
  const env = envUrl ? canonicalAvcsBaseUrl(envUrl) : null;
  if (env) return { url: env, source: 'env' };
  return { url: null, source: null };
}

/** `GET`·`PUT /settings/projection` 의 응답. admin 전용 표면이다. */
export interface ProjectionConfigView extends ResolvedProjectionUrl {
  /** DB 에 저장된 값. null 이면 앱에서 정한 것이 없다. */
  appUrl: string | null;
  /** `AVCS_BASE_URL`. 지우기가 무엇으로 복귀하는지 화면이 말할 재료다. */
  envUrl: string | null;
}

/**
 * 폴링이 이보다 오래 안 돌았으면 멈춘 것으로 본다. 폴링 주기(25초)의 몇 배로 잡아
 * 한두 번 늦는 것을 장애로 오해하지 않는다.
 */
export const PROJECTION_STALL_MS = 5 * 60 * 1000;

/**
 * 원자료에서 상태 하나를 뽑는다. **커서가 안 움직이는 것 자체는 신호가 아니다** —
 * 아무도 커밋하지 않는 조용한 저장소도 커서가 그대로다. 그것을 장애로 부르면 정상인
 * 저장소가 영영 빨갛고, 사람은 곧 이 표시를 무시하게 된다. 신호는 `lastAdvancedAt`
 * 이 아니라 **`lastPolledAt`** 이다: 우리가 물어보고 있는가.
 */
export function projectionState(r: ProjectionRuntime, now: number = Date.now()): ProjectionState {
  if (!r.configured) return 'unconfigured';
  // 폴링을 아직 한 번도 못 했거나(null), 너무 오래됐거나, 마지막 시도가 실패했다.
  if (r.lastPolledAt === null) return 'stalled';
  if (now - r.lastPolledAt > PROJECTION_STALL_MS) return 'stalled';
  if (r.lastError) return 'stalled';
  return 'ok';
}

/**
 * `GET /projection/status` 의 응답. 원자료 + 파생 상태다.
 *
 * `connected`(avcs 소켓이 붙었는가)는 **여기 없다** — 그것은 `/healthz` 의 것이고,
 * 이 화면이 답하는 질문("투영이 돌고 있는가")과 다른 사실이다. 두 사실을 한 객체에
 * 실으면 화면이 어느 것을 믿어야 하는지 정하지 못한다.
 */
export interface ProjectionStatus extends ProjectionRuntime {
  state: ProjectionState;
}

export interface ScheduledMessageView {
  id: string;
  channelId: string;
  authorId: string;
  threadRootId: string | null;
  body: string;
  sendAt: string;
  createdAt: string;
  sentMessageId: string | null;
  failedReason: string | null;
  canceledAt: string | null;
}

export type WsServerEvent =
  | { type: 'message.created'; message: MessageRow; audience: 'all' | string[] }
  | { type: 'message.updated'; message: MessageRow; audience: 'all' | string[] }
  | { type: 'message.deleted'; channelId: string; messageId: string; audience: 'all' | string[] }
  | { type: 'inbox.updated'; accountId: string }
  | { type: 'lease.changed'; repo: string }
  | { type: 'presence.changed'; accountId: string; online: boolean }
  | { type: 'presence.snapshot'; online: string[] }
  /**
   * 사람이 자기 상태를 바꿨다(#186). presence 와 **별개의 이벤트**다 — 상태 변경은
   * `presence.changed` 를 만들지 않고, 연결이 끊겨도 상태는 남는다.
   */
  | { type: 'status.changed'; accountId: string; status: AccountStatus; statusText: string | null }
  /**
   * 누군가 자기 프로필 사진을 바꿨다(#159). 바이트가 아니라 id 만 보낸다 — 받는 쪽이 그
   * id 로 아바타를 받아 오고, 지우기는 null 이다.
   */
  | { type: 'avatar.changed'; accountId: string; avatarAttachmentId: string | null }
  /**
   * 누군가 자기 handle 을 바꿨다(#271). 데스크탑은 디렉터리만 갱신하면 본문은 다음 렌더에
   * 새 이름으로 나온다 — 매핑이 그 일을 한다.
   */
  | { type: 'account.handle_changed'; accountId: string; newHandle: string }
  // 리액션은 델타로 보낸다 — 메시지 전체를 다시 실으면 한 번 누를 때마다 본문이 오간다.
  | { type: 'reaction.added'; channelId: string; messageId: string; emoji: string; accountId: string; audience: 'all' | string[] }
  | { type: 'reaction.removed'; channelId: string; messageId: string; emoji: string; accountId: string; audience: 'all' | string[] }
  /**
   * 지금 이 채널에서 입력 중인 사람들. started/stopped 두 이벤트가 아니라 **상태 전체**를
   * 보내는 이유: 두 이벤트면 클라이언트가 두 곳에서 같은 맵을 갱신하고 그 두 곳이 갈라진다.
   * 받는 사람 자신은 목록에서 빠져 있다 — 자기 그림자를 그리지 않게, 서버가 한 곳에서 거른다.
   */
  | { type: 'typing.changed'; channelId: string; accountIds: string[]; audience: 'all' | string[] }
  // 채널 목록 변경(#284). public 은 전원, private 은 멤버만 받는다.
  | { type: 'channel.created'; channel: ChannelRow; audience: 'all' | string[] }
  | { type: 'channel.updated'; channel: ChannelRow; audience: 'all' | string[] }
  | { type: 'channel.deleted'; channelId: string; audience: 'all' | string[] }
  // 채널 멤버십 변경(#300). 목록 수신자는 #284 의 channelListAudience 를 쓴다.
  | { type: 'channel.member_added'; channelId: string; accountId: string; audience: 'all' | string[] }
  | { type: 'channel.member_removed'; channelId: string; accountId: string; audience: 'all' | string[] }
  // 핸들 집합 변경(#300). 로그인한 전원에게 간다.
  | { type: 'handle_group.changed'; groupId: string; audience: 'all' | string[] }
  /**
   * 에이전트 팀 변경(#172). 집합의 `handle_group.changed` 와 **같은 모양**이고 같은 이유다:
   * 팀을 부를 수 있게 된 뒤로 팀 이름은 자동완성 후보이고, 팀원 수는 "몇 명을 불렀는가"의
   * 유일한 출처다(`AgentTeamRow.memberCount`). 새 팀이 생겨도 알리지 않으면 그 이름은
   * **다음 새로고침까지 아무의 자동완성에도 나타나지 않고**, 팀원이 바뀌어도 화면은 옛 수로
   * 조용한 실패를 판정한다.
   *
   * 로그인한 전원에게 간다 — 팀 이름은 누구나 부를 수 있으므로(라우트 `GET /teams` 도
   * `requireAccount` 다) 수신자를 좁힐 근거가 없다.
   *
   * `teamId` 만 보낸다: 목록은 서버에 하나뿐이고, 여기서 한 건만 끼워 넣으면 그 사이 다른
   * admin 이 한 변경이 화면에서 사라진다(스킬 이벤트의 같은 판단).
   */
  | { type: 'agent_team.changed'; teamId: string; audience: 'all' | string[] }
  // 담기/해제/상태 변경(#219). 본인의 소켓에만 온다.
  | { type: 'saved.changed'; messageId: string; state: 'open' | 'done' | null; accountId: string }
  /**
   * 링크 미리보기가 준비됐다(#215). 가져오기는 비동기라 메시지가 먼저 뜨고 카드가 뒤에
   * 온다 — 이 이벤트가 없으면 카드는 **다음에 그 메시지를 다시 그릴 때까지** 안 보인다.
   * URL 만 보낸다: 카드 내용은 받는 쪽이 `GET /link-previews` 로 읽는다(캐시가 하나다).
   */
  | { type: 'link_preview.ready'; url: string; audience: 'all' | string[] }
  /**
   * 워크스페이스 스킬(#140·#311). 제안·승인·비활성을 알린다.
   *
   * **`audience` 가 없다 — 전 소켓으로 간다.** 스킬 목록과 본문은 `GET /skills` 가
   * `requireAccount` 로 이미 로그인한 계정 전원에게 열려 있으므로, 이벤트를 좁혀도
   * 감출 수 있는 것이 없다. 승인은 워크스페이스 전체에 영향을 주는 사실이라
   * 열려 있는 설정 화면이 누구 것이든 같이 갱신되는 편이 맞다.
   */
  | { type: 'skill.proposed'; skill: WorkspaceSkillView; channelId: string }
  | { type: 'skill.approved'; skill: WorkspaceSkillView }
  | { type: 'skill.disabled'; skill: WorkspaceSkillView };

/**
 * 워크스페이스 스킬 하나의 뷰(#140·#311).
 *
 * 세 묶음(대기·승인됨·비활성)은 이 세 시각으로 갈린다: `approvedAt` 도 `disabledAt` 도
 * 없으면 대기, `approvedAt` 만 있으면 승인됨, `disabledAt` 이 있으면 비활성이다.
 * (거부와 비활성은 서버에서 같은 경로다 — 미승인 스킬을 비활성한 것이 거부다.)
 */
export interface WorkspaceSkillView {
  slug: string;
  body: string;
  proposedBy: string;
  proposedAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  disabledAt: string | null;
}

export type SkillGroupId = 'pending' | 'approved' | 'disabled';

/**
 * 이 스킬이 어느 묶음인가(#311). **판정은 여기 한 곳이다** — 화면이 세 자리에서 각각
 * `!approvedAt && !disabledAt` 같은 식을 다시 쓰면, 비활성된 승인 스킬이 두 묶음에
 * 동시에 뜨는 식으로 갈라진다. 순서가 곧 규칙이다: 비활성이 승인을 이긴다.
 */
export function skillGroupOf(skill: WorkspaceSkillView): SkillGroupId {
  if (skill.disabledAt) return 'disabled';
  if (skill.approvedAt) return 'approved';
  return 'pending';
}

/**
 * ── Phase 2 attach: 러너 PTY ↔ 서버 ↔ 데스크탑 xterm 릴레이 (스펙 §5) ──
 *
 * 이 절의 타입이 **불투명 우체국**(스펙 §2)의 계약이다. 바이트는 항상 `data: string`
 * (base64) 로만 오간다 — 서버는 봉투(JSON)를 열어 `sessionId` 만 읽고 `data` 는
 * **절대 디코드하지 않는다.** 디코드하면 잘린 UTF-8 이 U+FFFD 로 치환되고 ANSI
 * 이스케이프가 깨져 xterm 이 화면을 재구성하지 못한다(`packages/agent/src/pty.ts`
 * 의 `RingBuffer` 주석이 같은 이유로 문자 경계 정렬을 거부한다).
 *
 * base64 를 고른 이유: WS 는 바이너리 프레임을 실을 수 있지만, 한 소켓에 세션이
 * 여럿 다중화되므로 프레임마다 `sessionId` 가 붙어야 한다. 봉투를 JSON 으로 두고
 * 바이트만 base64 로 싣는 것이 "봉투는 열고 내용은 안 연다"를 코드 모양으로
 * 드러내는 가장 단순한 방법이다.
 */

/** 진행 중인 PTY 세션 하나. 러너가 announce 하고 서버가 인메모리로만 들고 있다. */
export interface AgentSessionView {
  /** 러너가 만든 세션 식별자(UUID). 스레드 키가 아니다 — URL 경로에 실려야 한다. */
  sessionId: string;
  /** 이 세션을 돌리는 에이전트 계정. attach 권한은 이 계정의 `ownerAccountId` 가 판정한다. */
  agentAccountId: string;
  channelId: string;
  /** 스레드 루트. 채널 최상위 멘션은 그 멘션 메시지가 루트다(#98). */
  threadRootId: string | null;
  harness: AgentHarness;
  /** 러너가 이 세션을 연 시각(ISO). 러너 시계다 — 서버가 찍지 않는다(러너만 아는 사실이다). */
  startedAt: string;
  /**
   * 이 PTY 가 어떤 턴인가(#337). `'mention'` 은 멘션이 띄운 비대화형 턴, `'interactive'`
   * 는 사람이 [터미널 열기]로 스스로 연 턴이다 — 데스크탑이 "지금 사람이 조종 중"을
   * 구분해 그릴 수단이다. 없으면(구 러너) 알 수 없다는 뜻이지 멘션 턴이라는 뜻이 아니다.
   */
  mode?: 'mention' | 'interactive';
  /**
   * 이 세션의 PTY stdin 이 **사람의 입력을 실제로 받을 수 있는가**(#369).
   *
   * **`mode` 로 대신할 수 없다.** 판정의 근거는 턴의 종류가 아니라 자식의 fd 0 이 무엇인가
   * 하나다: 러너가 `stdinFile` 을 넘긴 턴은 `sh -c 'exec <하네스> ... < <파일>'` 로 감싸여
   * 자식의 stdin 이 PTY slave 가 아니라 일반 파일이고, 그 파일이 EOF 에 닿은 뒤 PTY master
   * 로 쓴 바이트는 자식에게 **도달하지 않는다**(#369 재현). 하네스 종류(`claude -p` 인지)로
   * 재지 않는 이유도 같다 — 하네스가 늘어도 이 사실은 그대로다.
   *
   * `false` 면 서버는 그 세션의 뷰어에게 writer 차례를 주지 않는다. 없는 것을 있다고
   * 표시하지 않는다(docs/design.md §4): 쳐도 아무 데도 안 가는 입력창이 최악이다.
   *
   * **없으면(`undefined`) `false` 와 다르다.** `mode` 와 같은 이유로 옵셔널이다 — `#346`
   * 시절의 러너는 `input` 능력은 선언하면서 이 필드는 모른다. 그때 서버는 여전히 입력을
   * 닫지만(모르는 것을 열 수는 없다) 이유는 `'observe-only'` 가 아니라
   * `'runner-outdated'` 다: 그 세션의 stdin 이 파일이라는 사실을 확인한 적이 없으므로,
   * 확인한 척하면 화면이 다시 원인을 지어내는 것이 된다(이 이슈가 멈추려던 바로 그것).
   * 러너 쪽 계약(`OpenSessionInput.acceptsInput`)은 옵셔널이 아니다 — 새 러너가 실수로
   * 빠뜨리면 그 기본값이 곧 판정이 되기 때문이다.
   */
  acceptsInput?: boolean;
}

/** 뷰어(데스크탑)가 보는 세션 상태. `runner-offline` 은 '끝났다'와 다르다. */
export type AgentSessionState = 'running' | 'ended' | 'runner-offline';

/**
 * 러너가 다룰 줄 아는 개입 능력(#346, 스펙 §5-2 결정 2). `announce` 에 실려 서버가
 * 구/신 러너를 가른다:
 * - `'input'` 이 없으면 서버는 그 러너로 `input` 을 포워딩하지 않고 뷰어에 `writer:false`
 *   만 내린다 — 구 러너에서 타이핑이 "고장"이 아니라 "안 열림"으로 보이게.
 * - `'interactive'` 가 없으면 인터랙티브 open 요청이 타임아웃 대기 없이 즉시
 *   `runner_outdated` 로 거절된다.
 * - `'handoff'` 가 없으면 **이어받기**(#384) 요청이 같은 자리에서 즉시 거절된다. 이 능력이
 *   없는 러너는 `handoff` 플래그를 모르므로 진행 중인 멘션 턴의 세션을 그대로 돌려주는데,
 *   그러면 사람은 [이어받기] 를 눌러 놓고 여전히 관찰 전용인 화면을 본다 — 눌렀는데 아무
 *   일도 없는 그 결함이 정확히 #384 가 막으려는 것이다.
 */
export type RunnerCap = 'input' | 'interactive' | 'handoff';

/**
 * 러너 → 서버 프레임. `GET /agent-relay` 소켓에 실린다.
 *
 * `announce` 가 재접속마다 다시 오는 것이 중요하다 — 서버는 소켓이 끊기면 그 러너의
 * 세션 레지스트리를 버리므로(살아 있는지 알 방법이 없다), 재접속 후 announce 가
 * 없으면 진행 중인 턴이 서버 쪽에서 영구히 사라진다.
 */
export type RelayRunnerFrame =
  /** `caps` 가 없으면(구 러너) 능력이 하나도 없는 것으로 읽는다 — 없는 것을 있다고 표시하지 않는다. */
  | { type: 'announce'; sessions: AgentSessionView[]; caps?: readonly RunnerCap[] }
  | { type: 'session.started'; session: AgentSessionView }
  | { type: 'session.ended'; sessionId: string }
  /** 라이브 PTY 바이트. `data` 는 base64 이고 서버는 열지 않는다. */
  | { type: 'output'; sessionId: string; data: string }
  /** ring buffer 재생(서버의 `replay.request` 에 대한 답). 빈 버퍼도 빈 문자열로 답한다. */
  | { type: 'replay'; sessionId: string; data: string }
  /**
   * `interactive.open` 에 대한 응답(#337, 스펙 §5-2 결정 4). `created` 가 false 면 이미
   * 돌고 있던 턴(멘션이든 인터랙티브든)의 세션을 그대로 준 것이다 — 서버는 이 sessionId 로
   * attach 티켓을 발급한다. 같은 소켓의 `session.started` 가 항상 이 프레임보다 먼저
   * 도착하므로(순서 보장), 서버가 이 응답을 받는 시점에 세션 조회는 성립한다.
   */
  | { type: 'interactive.opened'; requestId: string; sessionId: string; created: boolean }
  /**
   * 이어받기가 **예약**됐다(#384). 진행 중인 멘션 턴이 끝난 뒤 러너가 같은 하네스 세션
   * id 로 인터랙티브 턴을 띄운다 — 진행 중인 턴을 멈추지 않는다(운영자 결정 A: 멈추면
   * 하네스가 어디까지 했는지 사람이 모른다).
   *
   * **`interactive.opened` 에 플래그를 더하지 않고 프레임을 가른 이유**: "열렸다"와
   * "기다린다"는 사람이 다음에 할 일이 다르다 — 열렸으면 지금 치고, 기다리는 것이면
   * 화면에 그 사실이 있어야 한다. 한 프레임의 옵셔널 필드로 두면 그 필드를 안 읽는
   * 경로가 "열렸다"로 뭉개고, 그것이 곧 "눌렀는데 아무 일이 없다"다.
   *
   * `sessionId` 는 **지금 도는 멘션 턴**의 세션이다: 사람은 기다리는 동안 그 화면을 계속
   * 본다(관찰 전용인 채로). 인터랙티브 턴의 세션 id 는 아직 존재하지 않는다.
   */
  | { type: 'interactive.reserved'; requestId: string; sessionId: string }
  /** interactive.open 이 실패했다(codex 거절 등). message 는 사람에게 그대로 보여줄 문구다. */
  | { type: 'interactive.error'; requestId: string; message: string };

/**
 * 서버 → 러너 프레임.
 *
 * `input` 이 #315 에서 늘어난 것이다. **운영자 결정**: 멘션 턴에도 사람의 입력을 허용한다 —
 * `mention_permission` 은 **에이전트가 스스로 넘지 못하는 선이지, 사람이 넘지 못하는 선이
 * 아니다.** 원 요청("터미널에 들어가서 작업하는 것과 동일하게")이 온전히 성립하려면 사람이
 * 그 프롬프트에 답할 수 있어야 하고, 사람이 앞에 앉아 있다는 것 자체가 그 권한의 근거다.
 * 이것을 "권한 구멍"으로 읽고 되돌리지 마라 — 되돌리면 이 기능의 절반이 다시 사라진다.
 *
 * **입력을 여는 것은 턴 모드를 바꾸는 것이 아니다.** 이 프레임은 PTY stdin 에 바이트를
 * 넣을 뿐이고, 그 턴의 `TurnMode` 도 `mention_permission` 도 건드리지 않는다(#141 회귀선의
 * 새 형태 — `packages/agent/test/mentionTurn.test.ts` 가 조립된 plan 을 직접 비교한다).
 *
 * `data` 는 `output` 과 **같은 규율**로 base64 다: 서버는 이 바이트도 열지 않는다.
 * 사람이 친 것에도 비밀이 섞인다(붙여 넣은 토큰, 비밀번호 프롬프트의 답).
 */
export type RelayServerFrame =
  | { type: 'replay.request'; sessionId: string }
  | { type: 'input'; sessionId: string; data: string }
  /**
   * PTY 창 크기(#335). **바이트가 아니라 숫자 두 개다** — 그래서 위 `data` 들과 달리
   * base64 규율을 타지 않고, 대신 서버가 값을 검증한다(러너의 `resize` 는 ioctl 로
   * 그대로 내려간다).
   */
  | { type: 'resize'; sessionId: string; cols: number; rows: number }
  /**
   * 이 세션을 보는 뷰어 수의 변동(#337). 러너의 인터랙티브 고아 회수가 읽는다 —
   * exit 없이 viewer 가 0 이 되면 유예 뒤 SIGTERM(스펙 §5-2 결정 5). 패널 닫힘·소켓
   * 단절·앱 강제종료가 서버 관점에서 전부 이 하나("viewer 소멸")로 수렴하므로, 명시적
   * 종료 프레임은 두지 않는다.
   */
  | { type: 'viewer.count'; sessionId: string; count: number }
  /**
   * 사람이 스스로 터미널을 연다(#337, 스펙 §5-2 결정 4). 세션이 아니라 **스레드**를
   * 가리킨다 — 세션이 아직 없을 수 있고, 없으면 러너가 만든다. `requestId` 로
   * `interactive.opened`/`interactive.error` 와 상관된다. `openedByHandle` 은 조종 중
   * 유예 통지("지금 {handle} 이 직접 조종 중")의 재료다.
   */
  | {
      type: 'interactive.open';
      requestId: string;
      channelId: string;
      threadRootId: string;
      openedByHandle: string;
      /**
       * 진행 중인 멘션 턴을 **이어받으러** 온 요청인가(#384). true 면 러너는 그 턴이 끝난
       * 뒤 인터랙티브 턴을 띄우겠다고 예약하고 `interactive.reserved` 로 답한다. false 면
       * 지금까지의 답 그대로다 — 진행 중인 멘션 턴의 세션에 관찰로 합류한다(#369).
       *
       * 옵셔널인 이유는 `mode`·`acceptsInput` 과 같다: 구 서버는 이 필드를 모른다. 없으면
       * 이어받기가 아닌 것으로 읽는다 — 없는 요청을 있다고 읽으면 사람이 부탁하지 않은
       * 턴이 뜬다. 러너 쪽 계약(`InteractiveOpenRequest.handoff`)은 필수다.
       */
      handoff?: boolean;
      cols?: number;
      rows?: number;
    };

/**
 * 서버 → 뷰어 프레임. `GET /agent-attach` 소켓에 실린다.
 *
 * 순서 보장: attach 직후 `status(running)` → `output`(ring 재생) → 그 뒤 라이브
 * `output`. 재생이 도착하기 전에 들어온 라이브 바이트는 서버가 뷰어별로 잠시
 * 큐에 담아 두고 재생 뒤에 흘린다 — 안 그러면 xterm 이 최신 바이트를 먼저 그린 뒤
 * 과거 화면으로 덮어쓴다.
 */
export type AttachServerFrame =
  | { type: 'output'; data: string }
  | { type: 'status'; state: AgentSessionState }
  /**
   * 이 뷰어가 지금 **writer 인가**(스펙 §5-2 결정 2). attach 인가(붙어도 되는가)는 여전히
   * 티켓이 운반하지만, 쓰기 **차례**는 서버 허브가 산다: **마지막으로 attach 한 뷰어가
   * writer** 이고 나머지는 읽기 전용이다 — 소유자와 admin 이 동시에 붙어도 바이트가 섞이는
   * 상태 자체가 생기지 않는다(잠금 장치 대신 이 규칙 하나다). 새 뷰어가 붙으면 이전
   * writer 는 `writer:false` 를 받고, writer 가 떠나면 가장 최근에 붙은 뷰어가 승계한다.
   * 이 프레임이 **한 번도 안 오면**(구 서버) 뷰어는 읽기 전용으로 남아야 한다 — 구/신
   * 조합 4방향 안전의 데스크탑 쪽 절반이다.
   */
  | {
      type: 'writer';
      /** 이 창이 **입력**을 보낼 수 있는가. */
      writer: boolean;
      /**
       * 이 창이 **폭**을 정하는가(#335 + #369). `writer` 와 갈라 두는 이유: `#346` 이 둘을
       * 한 판정으로 묶은 근거는 "읽기 전용 창이 폭을 줄이면 writer 의 작업 환경이 좁아진다"
       * 였고, 그 근거는 **writer 가 존재할 때만** 성립한다. 관찰 전용 세션(#369)에는 writer
       * 가 아예 없어 좁혀질 작업 환경이 없고, 반대로 폭은 stdin 과 무관하게 ioctl 로 자식에
       * 그대로 닿는다 — 여기서 폭까지 막으면 진행 중인 멘션 턴을 보는 창이 영원히 러너의
       * spawn 기본값(120x40)에 갇힌다. 순서 규칙(마지막 attach 가 차례)은 하나 그대로다.
       */
      resize: boolean;
      reason: WriterDeniedReason | null;
    };

/**
 * 이 창이 **왜** 읽기 전용인가(#369). `writer:false` 만 보내면 화면이 이유를 지어내야 하고,
 * 실제로 그랬다 — 원인이 무엇이든 "다른 창이 입력 중"이라고 적혀서, 아무도 안 붙은 멘션
 * 턴에서 없는 사람을 만들어 냈다.
 *
 * - `'other-writer'` — 더 최근에 붙은 창이 차례를 가져갔다(스펙 §5-2 결정 2).
 * - `'observe-only'` — 이 턴의 stdin 이 프롬프트 파일이라 PTY 로 넣은 입력이 자식에게
 *   닿지 않는다(#369, `AgentSessionView.acceptsInput`). 진행 중인 멘션 턴이 여기다.
 * - `'runner-outdated'` — 러너가 `input` 능력을 선언하지 않았거나 붙어 있지 않다(#346).
 *
 * `writer:true` 일 때는 `null` 이다 — "이유 없음"을 빈 문자열이 아니라 명시적 null 로 둔다.
 * `'observe-only'` 는 `resize:true` 와 함께 온다 — 못 치지만 폭은 정한다.
 */
export type WriterDeniedReason = 'other-writer' | 'observe-only' | 'runner-outdated';

/**
 * 뷰어 → 서버 프레임(#315). 사람이 그 터미널에 친 바이트다.
 *
 * **쓰기 차례는 서버가 `writer` 프레임으로 알린다**(위 `AttachServerFrame`, 스펙 §5-2
 * 결정 2). attach 인가는 소유자·admin 으로 좁혀져 있고(티켓 발급 시 `checkOwnerOrAdmin`),
 * 그 안에서 누가 지금 치는가는 "마지막 attach 가 writer" 규칙 하나다 — writer 가 아닌
 * 뷰어의 input 은 서버가 조용히 버린다(화면이 아니라 서버가 진짜 게이트다).
 *
 * `data` 는 base64 다 — 사람이 치는 것은 글자만이 아니다. 화살표·Ctrl-C·붙여 넣기는
 * 전부 제어 바이트이고, 문자열로 실으면 그 중 일부가 JSON 인코딩에서 왜곡된다.
 */
export type AttachClientFrame =
  | { type: 'input'; data: string }
  /**
   * 이 뷰어의 패널 크기(#335). PTY 가 이 크기가 된다.
   *
   * **writer 의 폭이 정답이다**(#335 의 "소유자의 폭"이 writer 규칙(#346) 위에서 갱신된
   * 표현이다 — 스펙 §5: "resize 는 writer 를 따른다"). 근거는 그대로 하나다 — **읽기
   * 전용은 아무것도 바꾸지 않는다.** 붙은 사람 중 가장 좁은 폭에 맞추면 읽기 전용 창을
   * 줄이는 것만으로 writer 의 작업 환경이 좁아지고, 그러면 그 창은 더 이상 읽기 전용이
   * 아니다. 러너 하나에 크기 하나이고, 그 하나를 정하는 주체는 지금의 writer 다.
   * 읽기 전용 창이 접힌 줄을 보는 것은 **받아들이기로 한 비용**이다 — 그것을 고치려고
   * 폭 협상을 넣으면 위 문장이 깨진다.
   *
   * 그래서 게이트도 `input` 과 **같은 것 하나**를 탄다(허브의 writer 판정). 프레임
   * 종류만 늘었지 판정이 늘지 않았다.
   *
   * **감사에는 남기지 않는다.** detach 감사의 `inputBytes` 가 남기는 것은 "사람이 이
   * 턴에 개입했다"는 사실이고, 창 크기 조절은 개입이 아니라 **보기**다 — resize 는 그
   * 합산에도 들어가지 않는다. "입력은 남기는데 왜 이것은 안 남기나"로 되돌리지 마라 —
   * 남길 사실이 애초에 없다.
   */
  | { type: 'resize'; cols: number; rows: number };

/**
 * 에이전트 팀(#172). **저장된 엔티티다** — "이 다섯을 넣는다"를 매번 고르는 즉석
 * 멀티셀렉트가 아니라, 이름을 붙여 남기는 운영자의 의도 기록이다.
 *
 * `name` 은 계정 handle 과 **같은 네임스페이스**를 쓴다(집합 #230 과 같은 결정) —
 * 그 예약을 이제 쓴다: `@팀` 을 부르면 팀원 전원이 깬다(`services/messages.ts`).
 */
export interface AgentTeamRow {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  /**
   * 지금 이 팀에 든 에이전트 수. **옵셔널이 아니라 필수다** — 근거는
   * `HandleGroupRow.memberCount`(#285)의 주석과 **같은 것**이다: 이 값을 안 실어 주는
   * 경로가 하나라도 있으면 화면은 "몇 명인지 모른다"를 그릴 방법이 없고, 결국 수를 아예
   * 안 보이는 쪽으로 떨어진다.
   *
   * 팀에서 이 수가 특히 필요한 이유는 `#230` 이 팀 멘션을 유보한 사유 그 자체다:
   * *"턴 셋이 동시에 시작되고" 조용히 실패한다.* 그 조용한 실패를 화면이 말하는 장치가
   * `lib/notified.ts`(`calledGroups`·`notifiedSummary`)이고, 그것은 **"몇 명을
   * 불렀는가"를 이 필드에서만** 얻는다. 멘션만 열고 이 수를 안 주면 팀은 부를 수 있지만
   * 덜 깬 것을 아무도 말하지 않는 상태가 된다 — `#230` 이 막으려던 바로 그 상태다.
   *
   * 파생값이므로 저장하지 않고 조회할 때 센다 — 저장하면 팀원 추가·제거마다 두 곳을
   * 맞춰야 하고, 한쪽만 틀린 수가 화면에 남는다(`services/teams.ts` 의 `COLS`).
   *
   * **비활성 팀원도 센다.** 비활성화는 팀원을 지우지 않는다(`036_agent_team.sql`) —
   * 명단의 크기는 운영자의 의도 기록이고, 그 중 몇이 실제로 깨는지는 별개의 사실이다.
   * 그래서 이 수와 실제로 깬 수가 어긋날 수 있고, 그 어긋남을 말하는 것이 위 장치가
   * 하는 일이다(`AgentTeamMemberRow.disabled` 가 사유를 따로 말한다).
   */
  memberCount: number;
}

/**
 * 팀원 한 명. handle 을 함께 준다 — 화면이 계정 목록을 따로 받아 맞출 필요가 없다
 * (`ChannelMemberRow` 와 같은 이유).
 *
 * `disabled` 를 싣는 이유: 비활성 에이전트는 팀에 **남고** 채널에 넣을 때만 걸러지므로
 * (`AddTeamToChannelResult.skipped`), 화면이 그 사실을 미리 말할 수 있어야 한다.
 * 안 실으면 "추가했는데 왜 안 들어갔지" 를 결과가 나온 뒤에야 알게 된다.
 */
export interface AgentTeamMemberRow {
  accountId: string;
  handle: string;
  /** 에이전트 계정이 비활성화되어 있으면 true. */
  disabled: boolean;
}

/**
 * 채널에 팀을 넣은 결과(#172). 세 갈래를 **따로** 돌려준다 — 하나로 합치면
 * "넣었다"가 "이미 있었다"와 "비활성이라 건너뛰었다"를 삼켜, 화면이 사람에게
 * 아무 것도 설명할 수 없다. 값은 모두 handle 이다.
 */
export interface AddTeamToChannelResult {
  added: string[];
  skipped: string[];
  alreadyMember: string[];
}

/**
 * 링크 미리보기(#215) — 서버와 데스크탑이 **같은 함수**로 URL 을 집고 정규화한다.
 *
 * 두 곳에 각자 정규식을 두면 서버가 저장하는 키와 클라이언트가 조회하는 키가 갈라진다.
 * 그러면 카드는 영원히 404 이고, 어느 쪽도 틀린 것처럼 보이지 않아 원인을 찾기 어렵다
 * (이 브랜치의 초판이 정확히 그랬다: 서버는 `[^\s<>"']+`, 클라이언트는 `[^\s]+` 였고
 * 클라이언트는 후행 문장부호를 떼지 않았다).
 */

/**
 * URL 후보를 **넓게** 집는 패턴의 원본. `://` 를 요구하지 않는 것이 의도다 — 좁게 집으면
 * `javascript:alert(1)` 이 애초에 후보가 되지 못해, 스킴 검사가 없어도 테스트가 초록이
 * 된다. 방어선은 판정(`normalizePreviewUrl`·`classifyLink`) 한 곳에만 있어야 실재를
 * 확인할 수 있다.
 *
 * 정규식 **객체**가 아니라 원본 문자열을 내보내는 이유: `/g` 정규식은 `lastIndex` 를
 * 들고 있어서 모듈 간에 공유하면 호출 순서에 따라 결과가 달라진다.
 */
export const URL_CANDIDATE_SOURCE = '[a-zA-Z][a-zA-Z0-9+.-]*:[^\\s]+';

/** 매번 새 `/g` 정규식을 만든다(공유 객체의 `lastIndex` 를 피한다). */
export function urlCandidateRegex(): RegExp {
  return new RegExp(URL_CANDIDATE_SOURCE, 'g');
}

/**
 * 문장 끝에 붙어 온 문장부호는 URL 이 아니다 — `자세히는 https://a.io/b.` 의 마침표까지
 * 링크에 넣으면 열리지 않는 주소가 된다. 짝이 맞는 괄호는 남긴다(위키 주소가 실제로 쓴다).
 */
export function trimTrailingPunctuation(token: string): string {
  let end = token.length;
  while (end > 0) {
    const ch = token[end - 1]!;
    if ('.,;:!?\'"'.includes(ch)) { end -= 1; continue; }
    if (ch === ')' || ch === ']') {
      const open = ch === ')' ? '(' : '[';
      const slice = token.slice(0, end);
      const balanced = slice.split(open).length <= slice.split(ch).length;
      if (balanced) { end -= 1; continue; }
    }
    break;
  }
  return token.slice(0, end);
}

/**
 * 미리보기 캐시의 **키**. 같은 페이지가 여러 키로 저장되면 같은 URL 을 여러 번 가져온다.
 *
 * - `http`/`https` 만. 다른 스킴은 미리보기 대상이 아니다(가져올 것이 없거나 위험하다).
 * - **자격증명이 실린 URL(`user:pass@host`)은 거절한다.** 벗겨서 가져오는 길도 있지만,
 *   그러면 사람이 본 링크와 **다른 자원**을 가져와 카드로 보여 주게 된다. 게다가
 *   `user:pass@` 는 호스트 혼동 공격의 고전적 재료다 — 파서마다 무엇을 호스트로 보는지
 *   갈린다. 가져오지 않는 쪽이 정직하다(카드가 안 뜨는 것은 사람이 바로 안다).
 * - 후행 점(`example.com.`)을 뗀다. DNS 상 같은 이름인데 키가 갈라진다.
 * - fragment 제거(서버가 받지 않는다), 기본 포트 제거·스킴/호스트 소문자는 `URL` 이 한다.
 */
export function normalizePreviewUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  url.hash = '';
  // `URL` 은 IPv4 를 어떤 표기로 써도(`2130706433`, `0x7f000001`) 점 표기로 정규화하고,
  // IDN 을 punycode 로 바꾼다 — 그 결과를 그대로 키로 쓴다.
  const host = url.hostname.replace(/\.+$/, '');
  if (!host) return null;
  url.hostname = host;
  return url.toString();
}

/**
 * 미리보기 카드 하나(#215). `imageUrl` 은 **URL 만** 담는다 — 바이트를 프록시하지 않는다.
 * v1 클라이언트는 이 값을 `<img>` 로 그리지 않는다(그리면 결정 1 이 무너진다).
 */
export interface LinkPreviewView {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  status: 'ok' | 'failed' | 'blocked';
  fetchedAt: string;
}

/**
 * 본문에서 미리보기를 가져올 URL 을 집는다. 최대 `max` 개(기본 3) — 한 메시지가 링크
 * 스무 개를 담으면 그만큼의 외부 요청이 서버에서 나간다.
 */
export function extractPreviewUrls(body: string, max = 3): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(urlCandidateRegex())) {
    const token = trimTrailingPunctuation(m[0]);
    if (!token) continue;
    const normalized = normalizePreviewUrl(token);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= max) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 러너 종료 사유 — **앱과 러너가 같은 문자열을 봐야 한다** (#473)
// ---------------------------------------------------------------------------

/**
 * `sysexits.h` 의 `EX_CONFIG`. "설정이 틀렸다 — 재시도로 낫지 않는다"는 뜻이다.
 *
 * **여기 있는 이유**: 러너가 이 코드로 물러나고(`packages/agent/src/exit.ts`), 앱이 이
 * 코드를 보고 화면 문구를 정한다(`runnerLauncher.ts::handleExit`). 두 곳이 각자 `78` 을
 * 리터럴로 적으면 한쪽만 바뀌는 날이 온다.
 */
export const EX_CONFIG = 78;

/**
 * 자격증명 거부(#250)로 러너가 물러날 때 stderr 의 **마지막 줄**.
 *
 * ## 왜 이 문자열이 계약인가
 *
 * `EX_CONFIG`(78)를 **두 사유가 공유한다** — 자격증명 거부(#250)와 하네스 실행 파일
 * 부재(#340). 종료 코드로는 그 둘이 구분되지 않고, 사람이 할 일은 정반대다:
 *
 * | 마지막 줄 | 사람이 할 일 |
 * |---|---|
 * | 이 줄 | PAT 를 재발급한다 |
 * | `EXECUTABLE_NOT_FOUND_LINE` | 하네스를 설치하고 `PATH` 를 고친다 |
 *
 * **그래서 이 줄이 유일한 구분자다.** 문구를 바꾸면 사람의 판정과 앱의 판정이 함께
 * 깨진다 — 앱이 이 상수를 그대로 비교하므로(`runnerExitReason`), 러너와 앱이 서로 다른
 * 사본을 들면 앱은 영원히 "구분자를 못 봤다"로 떨어지고 `#473` 이 되돌아온다.
 *
 * ## 왜 `@murmur/agent` 가 아니라 여기인가
 *
 * `@murmur/agent` 는 데스크탑의 **devDependency** 다 — 테스트는 그것을 import 할 수
 * 있지만 웹뷰 번들은 못 한다(그리고 그 패키지는 `node-pty` 같은 네이티브 의존을 끌고
 * 온다). 이 파일은 Node 의존이 없는 순수 타입·상수이고 웹뷰가 이미 import 한다.
 * `packages/agent/src/exit.ts` 는 이제 여기서 다시 낸다 — **값은 하나뿐이다.**
 */
/**
 * `retiring` 사유가 **Rust 를 지나 앱까지 오는 접합면**(2026-09-07 후속).
 *
 * daemon 은 이 사유를 JSON 에 `code: 'retiring'` 으로 싣지만(`daemonProtocol.ts` 의
 * `DaemonErrorCode`), Tauri 커맨드의 경계가 `Result<_, String>` 이라 코드가 타입으로
 * 건너오지 못한다. Rust 는 그것을 `format!("{}: {}", e.code, e.message)` 로 문자열에
 * 담고(`daemon_client.rs`), 그래서 앱이 볼 수 있는 것은 그 문자열뿐이다.
 *
 * 문구를 손으로 뒤지지 않도록 **코드 토큰을 상수로 고정한다** — 아래
 * `CREDENTIAL_REJECTED_LINE` 이 러너와 앱 사이에서 하는 일과 같은 판례이고, 같은 이유로
 * `daemonProtocol.ts` 가 아니라 여기 산다: **웹뷰가 import 하는 파일은 이것이다.**
 * (실제로 그쪽에 뒀다가 루트 재수출이 없어 `undefined` 가 되고, `includes(undefined)` 가
 * 조용히 false 여서 앱이 기다리지 않고 실패로 칠했다.)
 *
 * 값이 두 곳에 사본으로 생기면 한쪽만 바뀌는 날 앱은 다시 "기다릴 줄 모르는" 상태로
 * 돌아간다 — 그리고 그 실패는 조용하다.
 */
export const DAEMON_RETIRING_TOKEN = 'retiring:';

export const CREDENTIAL_REJECTED_LINE =
  'murmur-agent: credential rejected (revoked or rotated); exiting';

/**
 * 하네스 실행 파일 부재(#340)로 러너가 물러날 때 stderr 의 **마지막 줄**.
 * 위 `CREDENTIAL_REJECTED_LINE` 과 같은 규율이다 — 그 주석의 표를 보라.
 */
export const EXECUTABLE_NOT_FOUND_LINE =
  'murmur-agent: harness executable not found; exiting';

/**
 * **하네스 로그인**이 풀려(만료·폐기) 러너가 물러날 때 stderr 의 마지막 줄.
 *
 * 왜 `CREDENTIAL_REJECTED_LINE` 과 갈라야 하는가 — 2026-09-07 16:09 실측: claude CLI 의
 * OAuth 세션이 만료되자 러너가 78 로 물러나며 `CREDENTIAL_REJECTED_LINE` 을 냈고, 앱은
 * 그것을 보고 "PAT 가 폐기·회전됐다 — 재발급하면 다시 뜬다"를 띄웠다. 사람이 실제로
 * 해야 할 일은 `claude` 를 한 번 실행해 다시 로그인하는 것이었다.
 *
 * `#473` 이 하네스 부재에서 고친 결함("하네스가 없는 사람에게 PAT 를 재발급하라고
 * 말한다")과 **정확히 같은 모양**이 자격증명 안에서 되풀이된 것이다. `policy.ts` 는 이미
 * 두 출처를 갈라 놓고 있었고(`murmur-credential`·`harness-credential`) 안내문도 갈라져
 * 있었다 — 갈라지지 않은 곳은 앱이 읽을 수 있는 유일한 것, 이 마커뿐이었다.
 */
export const HARNESS_LOGIN_REQUIRED_LINE =
  'murmur-agent: harness login required (expired or revoked); exiting';

/** 78 로 죽은 러너가 로그로 밝힌 사유. 못 가리면 `null` 이다 — 지어내지 않는다. */
export type RunnerExitReason =
  | 'credential-rejected'
  | 'harness-login-required'
  | 'executable-not-found';

/**
 * 78 로 죽은 러너의 로그 꼬리를 보고 **어느 사유인가**를 가른다(#473).
 *
 * ## 왜 함수인가 — 판정이 한 곳에만 있어야 한다
 *
 * 이 판정은 `includes` 두 번이다. 그래도 함수로 두는 이유는 `acceptRunnerExit` 이
 * 함수인 것과 같다: 호출부마다 다시 쓰이면 한 곳에서 두 상수가 뒤바뀌어도 아무도
 * 모른다. 그리고 그 사고의 결과가 정확히 `#473` 이다 — 하네스가 없는 사람에게 PAT 를
 * 재발급하라고 말하는 것.
 *
 * ## 왜 마지막 줄이 아니라 꼬리 전체를 훑는가
 *
 * 러너의 stdout·stderr 가 **같은 파일**로 간다(`#434` 의 리다이렉션). 그래서 러너가
 * 물러나는 순간 다른 경로가 한 줄 더 찍으면 구분자가 마지막 줄이 아니게 된다.
 * `at(-1)` 로 재면 그 한 줄에 판정이 뒤집히고, 그 실패는 조용하다 — 앱은 다시 사유를
 * 지어내는 상태로 돌아간다. 꼬리 안에 **있는가**를 보면 그 창이 없다.
 *
 * 둘 다 있으면 **`null` 이다.** 실제로는 러너가 하나만 찍으므로(`runnerExitPlan` 이
 * 두 갈래 중 하나를 고른다) 이 경우는 회전 직후 옛 세대의 꼬리가 섞였다는 뜻이고,
 * 그때 하나를 골라 단정하면 그것이 바로 이 이슈가 막으려는 짓이다.
 */
export function runnerExitReason(
  tailLines: readonly string[] | undefined,
): RunnerExitReason | null {
  if (!tailLines || tailLines.length === 0) return null;
  const credential = tailLines.some((line) => line.includes(CREDENTIAL_REJECTED_LINE));
  const harnessLogin = tailLines.some((line) => line.includes(HARNESS_LOGIN_REQUIRED_LINE));
  const notFound = tailLines.some((line) => line.includes(EXECUTABLE_NOT_FOUND_LINE));
  // 둘 이상 보이면 모른다고 한다 — 지어내지 않는다(#368). 사유가 셋이 된 뒤에도 규칙은
  // 같다: 하나만 보일 때만 단정한다. 세 갈래를 각각 짝지어 비교하는 대신 **개수를 센다** —
  // 짝 비교는 사유가 늘 때마다 조합이 늘고, 그중 하나를 빼먹는 날 조용히 단정한다.
  const seen = [credential, harnessLogin, notFound].filter(Boolean).length;
  if (seen !== 1) return null;
  if (notFound) return 'executable-not-found';
  if (harnessLogin) return 'harness-login-required';
  return 'credential-rejected';
}

/**
 * 이 하네스가 `PATH` 에서 찾는 **실행 파일 이름**(#473).
 *
 * ## 왜 필요한가 — "하네스를 설치해라"는 사람이 실행할 수 없는 말이다
 *
 * 무엇을 설치할지는 에이전트마다 다르다. 화면이 이름을 말해야 사람이 그것을 설치한다.
 *
 * ## 왜 `turn.ts` 의 `PRESETS` 를 안 쓰는가
 *
 * 그 표가 진실의 원천인 것은 맞다 — 러너가 실제로 실행하는 명령이 거기서 나온다.
 * 그런데 그것은 `@murmur/agent` 안에 있고 웹뷰는 그 패키지를 못 들인다(위
 * `CREDENTIAL_REJECTED_LINE` 주석의 같은 사정). 그래서 **이름만** 여기 둔다.
 *
 * 두 곳이 갈릴 위험은 있다. 그 위험을 회귀선으로 막는다 —
 * `packages/agent/test/harnessBinary.test.ts` 가 `PRESETS` 의 실제 명령과 이 표를
 * 대조한다. 갈리면 빨개진다.
 *
 * 모르는 하네스면 `null` — **지어내지 않는다**(`#368`). 그때 문구는 이름 없이 나간다.
 */
export function harnessBinaryName(harness: string | undefined | null): string | null {
  switch (harness) {
    case 'claude-code':
      return 'claude';
    case 'codex':
      return 'codex';
    // `gemini` 는 `RUNNABLE_HARNESSES` 에 없어 러너가 실행하지 않는다(`PRESETS.gemini
    // === 'unsupported'`). 실행하지 않는 것의 실행 파일 이름을 말할 이유가 없다.
    default:
      return null;
  }
}

/**
 * 이 실행 파일을 **어떻게 설치하는가**(`#476`).
 *
 * ## 왜 이름만으로는 부족한가
 *
 * `#473` 이 문구에 실행 파일 이름을 넣었다(`claude` 를 찾을 수 없다). 그것으로 사람은
 * **무엇이** 없는지 알게 됐지만 **어떻게** 채우는지는 여전히 몰랐다 — 이름을 들고 검색을
 * 해야 했고, 검색 결과가 맞는 것인지도 스스로 판단해야 했다.
 *
 * murmur 는 이 셋을 **동봉하지 않는다**(2026-09-06 사용자 방침): *"murmur 는 자기 것만
 * 배포하고, 남의 것은 사용자가 설치한다."* 라이선스도 크기도 부차적 이유이고, 진짜 이유는
 * **그것이 우리 것이 아니라는 것**이다. 동봉하지 않기로 한 이상 **어디서 받는지 알려 주는
 * 것이 남은 전부**이고, 그것이 이 표다.
 *
 * ## 왜 명령이 아니라 주소인가
 *
 * `npm i -g @anthropic-ai/claude-code` 같은 한 줄을 적고 싶어지지만 그러지 않는다:
 *
 * - **패키지 이름과 설치 경로는 우리 것이 아니라 남의 것이라 언제든 바뀐다.** 바뀌면 이
 *   문구는 조용히 틀린 말이 되고, 사람은 앱이 시킨 대로 했는데 안 되는 상태에 놓인다 —
 *   `#368`("사유를 지어내지 마라")과 같은 종류의 실패다
 * - 설치 방법이 기계·계정마다 다르다(패키지 매니저·권한·기존 설치)
 * - **설치를 대신 실행하지 않는다**(`#476` 범위) — 사용자 기계에 뭔가를 설치하는 것은
 *   앱이 할 일이 아니다
 *
 * 공식 주소는 그 모든 것의 **현재 답을 들고 있는 자리**다. 주소가 바뀌는 속도가 명령이
 * 바뀌는 속도보다 훨씬 느리기도 하다.
 *
 * ## `node` 가 이 표에 함께 있는 이유
 *
 * **특별 대우하지 않는다**(같은 방침의 정정 코멘트). 하네스를 직접 설치하라면서 `node` 만
 * 다르게 다루는 것은 일관되지 않는다 — 같은 자리에서 같은 방식으로 안내한다.
 *
 * 모르는 것이면 `null` — **지어내지 않는다**. 그때 문구는 이름만 들고 나간다.
 */
export function installHint(binary: string | undefined | null): string | null {
  switch (binary) {
    case 'claude':
      return 'Claude Code 를 설치하면 함께 깔린다: https://claude.com/product/claude-code';
    case 'codex':
      return 'OpenAI Codex CLI 를 설치하면 함께 깔린다: https://developers.openai.com/codex/cli';
    case 'node':
      // 사이드카가 셔뱅(`#!/usr/bin/env node`)이라 **`node` 가 없으면 러너 자체가 안 뜬다.**
      // murmur 가 동봉하지 않는 것 셋 중 하나다.
      return 'Node.js 를 설치하라(LTS 판이면 된다): https://nodejs.org/en/download';
    default:
      return null;
  }
}
