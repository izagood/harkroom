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
 * codex 가 아직 없는 이유(`docs/roadmap.md` §5, 2026-09-02 실측): 첫 턴은 murmur MCP 연결부터
 * `message.post` 발화까지 실제로 완주했지만 **resume 턴은 완주를 확인하지 못했다.** 막은 것은
 * murmur 쪽 결함이 아니라 그 개발 머신에 걸려 있던 개인 후크의 승인 게이트였고, 그것을
 * 우회하는 유일한 수단(`codex exec --approve-for-me`)이 `codex exec resume` 에는 없다.
 * 즉 기준의 절반만 닫혔다 — 그 후크가 없는 머신에서 resume 완주를 보면 추가한다.
 * (#89 신뢰 디렉터리와 #86 전역 MCP 상속은 그 전에 닫아야 했던 별개의 선행 조건이고, 둘 다 닫혔다.)
 *
 * gemini 는 `PRESETS.gemini === 'unsupported'` 로 구현 자체가 없다.
 */
export const RUNNABLE_HARNESSES = ['claude-code'] as const satisfies readonly AgentHarness[];

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
 * 본문 안의 멘션. 서버(알림 발송)와 데스크탑(강조)이 **반드시 같은 규칙**을 써야 한다 —
 * 갈라지면 두 방향으로 거짓말을 한다: 강조되지 않은 것이 몰래 알림을 보내거나(`me@x.com`),
 * 강조된 것이 알림을 보내지 않는다(`@Fizz`).
 *
 * 선행 문자 조건이 핵심이다. `@` 앞이 문자·숫자면 멘션이 아니다 — 이메일 주소와 단어
 * 중간의 `@` 를 걸러 낸다. handle 은 소문자로만 만들어지지만 사람은 `@Fizz` 라고 쓰므로
 * 대소문자를 무시하고 찾고, 조회할 때 소문자로 맞춘다.
 */
export const MENTION_PATTERN = `(^|[^a-zA-Z0-9_-])@(${HANDLE_PATTERN})`;

/**
 * 본문에서 불린 handle 들. 소문자로 정규화해 중복을 없앤다(`@fizz` 와 `@Fizz` 는 한 사람).
 * 패턴이 대문자를 이미 포함하므로 `i` 플래그는 필요하지 않다.
 */
export function mentionedHandles(body: string): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(new RegExp(MENTION_PATTERN, 'g'))) {
    if (m[2]) found.add(m[2].toLowerCase());
  }
  return [...found];
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

export interface MessageRow {
  id: string;
  seq: number;
  channelId: string;
  threadRootId: string | null;
  authorId: string;
  body: string;
  kind: 'user' | 'system' | 'progress';
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
  /** 스레드 답을 채널에도 함께 올린다(#231). threadRootId 가 없으면 이 값은 항상 false 다. */
  alsoInChannel: boolean;
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
}

/** 채널 멤버 한 명. 멤버 목록 화면이 handle 을 따로 조회하지 않도록 함께 준다. */
export interface ChannelMemberRow {
  accountId: string;
  handle: string;
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
  reason: 'mention' | 'thread_reply' | 'dm';
  readAt: string | null;
  channelId: string;
}

export interface DmView {
  id: string;
  memberIds: string[];
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
  notifyLevel: NotifyLevel;
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
  /** `AVCS_BASE_URL` 이 있어서 워커가 아예 만들어졌는가. */
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
  // 담기/해제/상태 변경(#219). 본인의 소켓에만 온다.
  | { type: 'saved.changed'; messageId: string; state: 'open' | 'done' | null; accountId: string };

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
}

/** 뷰어(데스크탑)가 보는 세션 상태. `runner-offline` 은 '끝났다'와 다르다. */
export type AgentSessionState = 'running' | 'ended' | 'runner-offline';

/**
 * 러너 → 서버 프레임. `GET /agent-relay` 소켓에 실린다.
 *
 * `announce` 가 재접속마다 다시 오는 것이 중요하다 — 서버는 소켓이 끊기면 그 러너의
 * 세션 레지스트리를 버리므로(살아 있는지 알 방법이 없다), 재접속 후 announce 가
 * 없으면 진행 중인 턴이 서버 쪽에서 영구히 사라진다.
 */
export type RelayRunnerFrame =
  | { type: 'announce'; sessions: AgentSessionView[] }
  | { type: 'session.started'; session: AgentSessionView }
  | { type: 'session.ended'; sessionId: string }
  /** 라이브 PTY 바이트. `data` 는 base64 이고 서버는 열지 않는다. */
  | { type: 'output'; sessionId: string; data: string }
  /** ring buffer 재생(서버의 `replay.request` 에 대한 답). 빈 버퍼도 빈 문자열로 답한다. */
  | { type: 'replay'; sessionId: string; data: string };

/**
 * 서버 → 러너 프레임. Phase 2 는 읽기만이므로 이 하나뿐이다 —
 * `input`·`resize` 는 범위 밖(권한·턴 모드 상호작용이 스펙 §6 결정을 건드린다).
 */
export type RelayServerFrame = { type: 'replay.request'; sessionId: string };

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
  | { type: 'status'; state: AgentSessionState };
