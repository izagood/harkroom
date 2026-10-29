/**
 * 기능 카탈로그(2026-10-27, 앱 기본 규칙 전달 c1) — harkroom MCP 도구마다 「언제 쓰나」를 **한 곳**에 둔다.
 *
 * ## 왜
 *
 * 도구의 「언제」가 워크스페이스 가이드·러너 시스템 프롬프트·도구 설명에 흩어져 있었고, 어느 곳도 「이 턴에 실제로 열린
 * 도구」로 갈리지 않았다. 그래서 읽기 전용 턴에 막힌 도구(`artifact.publish`·`message.askBundle`·`secret.generate`)를
 * 권하거나, 열린 도구(`automation.run`·`channel.doc`)를 언제 쓰는지 말하지 않는 곳이 생겼다. 이 표가 원본이고, 러너는
 * 이 턴에 열린 도구의 항목만 골라 「쓸 수 있는 기능」 절을 만든다(`packages/agent/src/prompt.ts` featureSection).
 *
 * ## 무엇을 담지 않는가
 *
 * - **사용자·워크스페이스 정책**(무엇을 보드에 걸지·보고 형식 등)은 담지 않는다 — 그건 메모리 층이다(설계 원칙 2).
 * - **기억 상태에 기대는 문구**는 담지 않는다(설계 원칙 1). 기억 쓰기 사용법은 `memorySection` 이 따로 맡는다.
 * - 다른 절이 이미 조건과 함께 맡는 도구(머지·권한 요청·예약·기억·팀 위임 등)는 `CATALOG_ELSEWHERE` 에 그 자리를 적는다.
 *   패리티 시험(`packages/agent/test/featureCatalog.test.ts`)이 서버에 등록된 모든 도구가 둘 중 한 곳에 있는지 본다.
 *
 * 문구는 에이전트가 읽는 지시라 한국어 한 벌이다(사람에게 보이는 화면 문구가 아니다 — i18n 대상 아님).
 */

/** 이 턴에 항목을 싣는 조건. 도구가 열렸는지는 러너가 판정한다(읽기 전용 턴의 허용 목록). */
export interface FeatureEntry {
  /** 사람이 읽는 이름(시험 실패 메시지용). */
  id: string;
  /** 이 항목이 기대는 harkroom MCP 도구. **하나라도 닫혀 있으면** 항목을 싣지 않는다. */
  tools: readonly string[];
  /** 서버가 부여한 능력이 있을 때만(`secretCreate` = capability `secret.create`). */
  needs?: 'secretCreate';
  /** 「언제 쓰나」와 꼭 알아야 할 쓰는 법. 한 줄이 한 문장 덩어리다. */
  lines: readonly string[];
}

export const FEATURE_CATALOG: readonly FeatureEntry[] = [
  // ── 발화 종류(옛 가이드 「발화 종류를 고른다」 절, f2) ──
  {
    id: 'post',
    tools: ['message.post'],
    lines: ['`message.post`: 보통의 답·중간 소식.'],
  },
  {
    id: 'report',
    tools: ['message.report'],
    lines: [
      '`message.report`: 맡은 일을 끝냈을 때의 완료 보고 — 확인한 것(checks)·바뀐 것·남은 것을 갖춘다.',
      '확인한 것이 없는 답이면 post 로 쓴다.',
    ],
  },
  {
    id: 'ask',
    tools: ['message.ask'],
    lines: [
      '`message.ask`: 상대가 골라야 다음으로 갈 수 있는 갈림길 — 선택지를 정할 수 있을 때 카드로 세운다.',
      '선택지를 정할 수 없는 열린 질문은 글로 묻는다.',
      '같은 스레드에 네가 세운 열린 카드가 있으면 새 카드에 그 카드를 대신하는지(`supersedes`, 합치면 여러 id)',
      '따로 남기는지(`keepOpen`)를 밝힌다 — 안 밝히면 `open_card_in_thread` 로 거절되고 `openCardIds` 가 온다.',
    ],
  },
  {
    id: 'askBundle',
    tools: ['message.askBundle', 'message.askBundleResolve'],
    lines: ['`message.askBundle`: 여러 에이전트가 같은 사람에게 세운 카드를 한 장에 모아 한 번에 고르게 할 때(`askBundleResolve` 로 닫는다).'],
  },
  {
    id: 'fail',
    tools: ['message.fail'],
    lines: [
      '`message.fail`: 스스로 끝내지 못했을 때(막힘·권한·인증·한도 소진) — 답 없이 끝내지 말고 무엇이 막혔는지와',
      '다시 부를 수 있는지(retryable)를 밝힌다. `code` 는 러너가 붙이는 표지다 — 너는 싣지 마라.',
    ],
  },
  {
    id: 'progress',
    tools: ['message.progress'],
    lines: ['`message.progress`: 긴 작업을 시작할 때 무슨 작업인지 짧게 — 결과 발화로 세지 않고, 사람이 기다릴지 끊을지 정할 근거가 된다.'],
  },
  {
    id: 'react',
    tools: ['message.react', 'message.unreact'],
    lines: ['`message.react`: 글을 읽었다·동의한다는 표시만 할 때. 답이 필요한 요청을 리액션으로 대신하지 않는다.'],
  },
  // ── 찾기·붙이기·보여 주기 ──
  {
    id: 'search',
    tools: ['message.search'],
    lines: [
      '`message.search`: 지난 대화에서 무엇이 어디 있었는지 찾을 때 — 채널을 통째로 `message.read` 로 넘겨 읽지 말고,',
      '`channelId`·`threadRootId` 로 범위를, `authorIds`(계정 id, `account.list`)·`after`·`before`(시간대 붙은 ISO)·`hasAttachment`·`sort: "recent"` 로 거르고, `hasMore` 면 `offset` 으로 잇는다.',
    ],
  },
  {
    id: 'attachment',
    tools: ['attachment.upload'],
    lines: [
      '`attachment.upload`(path): 그림·PDF·HTML 같은 파일을 글에 붙일 때 — 턴 워크스페이스 안에 두고 올려 받은 id 를',
      '`message.post` 의 `attachmentIds` 로 붙인다. 워크스페이스 밖 파일은 거절된다. 로컬 경로만 적으면 사람은 그 파일을 못 본다.',
    ],
  },
  {
    id: 'artifact',
    tools: ['artifact.publish'],
    lines: [
      '`artifact.publish`(channelId·threadRootId·title·body·html): 사람이 **눈으로 볼 HTML**(시안·보고서 페이지)일 때 — 그 글이 이 턴의 발화다.',
      'claude.ai 아티팩트 링크로 주지 않는다(그 계정으로 로그인한 사람만 연다). 한 파일에 다 담는다(외부 fetch 불가, 스크립트·스타일·폰트는 cdnjs·jsdelivr·Google Fonts 만).',
      '같은 안을 고칠 때는 앞서 받은 `artifactId` 를 줘서 다음 버전으로 올린다.',
    ],
  },
  {
    id: 'channelDoc',
    tools: ['channel.doc'],
    lines: ['`channel.doc`: 이 채널에서 처음 일하거나 채널의 약속·자료를 확인해야 할 때 읽는다(사람이 쓰는 문서다).'],
  },
  // ── 밖의 일·자동화 ──
  {
    id: 'workitem',
    tools: ['workitem.upsert', 'workitem.list', 'workitem.remove'],
    lines: ['`workitem.upsert`: 밖의 시스템 항목 하나를 이 스레드에 이어 사람의 「내 작업」 보드에 세운다. 무엇을 걸지는 지시문·기억을 따른다.'],
  },
  {
    id: 'automation',
    tools: ['automation.list', 'automation.run'],
    lines: ['`automation.list`·`automation.run`: 사람이 이미 승인해 둔 자동화를 지금 한 번 돌려 달라고 할 때. 새로 만드는 것은 제안(`automation.propose`)뿐이다.'],
  },
  {
    id: 'grantList',
    tools: ['grant.list'],
    lines: ['`grant.list`: 내가 받은 부여(연결·비밀 등)가 무엇인지 확인할 때 — 없는 권한을 짐작으로 쓰지 않는다.'],
  },
  // ── 비밀 ──
  {
    id: 'secretUse',
    tools: ['secret.list', 'secret.mount'],
    lines: [
      '`secret.list`·`secret.mount`: 비밀(비밀번호·토큰·키)이 필요할 때 — 받은 이름을 보고 이 턴 전용 파일 경로를 받아 쓴다.',
      '값을 출력·복사하거나 MCP 인자·메시지·기억·파일·커밋에 쓰지 않는다. 목록에 없으면 사람에게 설정 › 비밀과 API 에서 달라고 말한다.',
      '**이미 화면·문맥에 보인 값은 유출된 것이다** — 계속 쓰지 말고 사람에게 회전을 부탁한다.',
    ],
  },
  {
    id: 'secretCreate',
    tools: ['secret.generate', 'secret.import', 'secret.rotate'],
    needs: 'secretCreate',
    lines: [
      '**비밀을 만들 수 있다 — 소유자가 그 비밀을 만들어 달라고 요청할 때만 만든다.** 필요해 보인다고 스스로 만들지 않는다.',
      '만든 비밀의 주인은 소유자이고, 부여는 나에게 이 채널로만 걸린다. 만들면 서버가 이 스레드에 알림 줄을 남기고 소유자를 부른다.',
      '- 새 값: `secret.generate`(type: password·token_hex·token_base64url·ssh_ed25519). 값은 나에게 오지 않는다. ssh 는 공개키만 돌려준다. 바로 써야 하면 `mount:true`.',
      '- 받은 값 등록: 값을 화면에 찍지 말고 `cmd > file` 로 턴 워크스페이스에 받은 뒤 `secret.import { name, path }`. 원본은 지워진다.',
      '  이미 보인 값은 등록하지 말고 회전을 부탁한다. `already_granted` 는 이미 가진 비밀이다 — 그 이름으로 `secret.mount` 해서 쓴다.',
      '- 값 바꾸기: 내가 만든 비밀만 `secret.rotate { name, generate | path }`. `adopted_by_owner` 면 소유자가 맡은 비밀이니 사람에게 넘긴다.',
      '- 거절 코드(`not_granted`·`cause_not_owner`·`value_is_mounted`·`too_many` 등)는 그대로 사람에게 적고 멈춘다.',
    ],
  },
];

/**
 * 카탈로그 밖에서 이미 조건과 함께 다루는 도구 → 그 자리. 여기 적는 것은 「언제」를 **빠뜨리지 않았다**는 기록이다 —
 * 새 도구를 등록하고 어느 쪽에도 적지 않으면 패리티 시험이 빨개진다.
 */
export const CATALOG_ELSEWHERE: Readonly<Record<string, string>> = {
  'workspace.guide': '워크스페이스 가이드 자신(러너가 받아 시스템 프롬프트에 싣는다)',
  'account.me': '가이드 「이름이 아니라 id 로」 절',
  'account.list': '가이드 「이름이 아니라 id 로」 절',
  'channel.list': '가이드 「이름이 아니라 id 로」 절',
  'message.read': '가이드 「이름이 아니라 id 로」 절·러너 턴 프롬프트(대화 줄)',
  'attachment.fetch': '러너 턴 프롬프트의 첨부 안내(첨부가 있는 턴에만, attachmentHowTo)',
  'agent.modelOptions': '러너 「다른 에이전트를 부를 때 agentModels」 문단',
  'message.delegate': '러너 「agentModels」 문단·팀 블록(teamSection)',
  'permission.request': '러너 권한 요청 절(permissionSection, 권한이 있을 때만)',
  'permission.revoke': '러너 권한 요청 절(permissionSection)',
  'grant.delegate': '러너 외부 API 절(apiSection, 넘길 수 있는 연결이 있을 때만)',
  'grant.revoke': '러너 외부 API 절(apiSection)',
  'turn.wake': '러너 「더 기다려야 하면」 문단(턴)·가이드 상주 판본 WAKE 절',
  'inbox.poll': '가이드 상주 판본(poll 루프 계약) — 턴은 쓰지 않는다(가이드 TURN_ONLY)',
  'inbox.read': '가이드 상주 판본 — 턴은 쓰지 않는다(가이드 TURN_ONLY)',
  'thread.note': '러너 스레드 메모 절(threadNoteSection)',
  'memory.list': '러너 기억 절(memorySection)',
  'memory.get': '러너 기억 절(memorySection)',
  'memory.search': '러너 기억 절(memorySection)',
  'memory.set': '러너 기억 절(memorySection, 읽기 전용 턴엔 없음)',
  'memory.merge': '러너 기억 절(memorySection)',
  'memory.archive': '러너 기억 절(memorySection)',
  'memory.unarchive': '러너 기억 절(memorySection)',
  'memory.revisions': '러너 기억 절(memorySection)',
  'memory.restore': '러너 기억 절(memorySection)',
  'memory.lease': '러너 기억 절(memorySection)',
  'memory.audit': '러너 기억 절(memorySection)',
  'memory.recalled': '러너 내부(recall 기록) — 에이전트는 부르지 않는다',
  'skill.propose': '러너 스킬 절(skillSection, 읽기 전용 턴엔 없음)',
  'automation.propose': '러너 스킬 절(skillSection, 읽기 전용 턴엔 없음)',
  'bg.claim': '백그라운드 회차 전용(bgExecutor) — 멘션 턴은 쓰지 않는다',
  'bg.complete': '백그라운드 회차 전용(bgExecutor) — 멘션 턴은 쓰지 않는다',
};

/** 발화 종류 항목(가이드 상주 판본이 같은 표에서 그 절을 만든다 — `server/src/mcp/guide.ts`). */
export const UTTERANCE_FEATURE_IDS: readonly string[] = ['post', 'report', 'ask', 'askBundle', 'fail'];

/** 이 턴에 열린 항목만 고른다. `isOpen` 은 MCP 도구 이름(`message.ask`)을 받는다. */
export function openFeatures(
  isOpen: (tool: string) => boolean,
  caps: { secretCreate?: boolean } = {},
): FeatureEntry[] {
  return FEATURE_CATALOG.filter((e) =>
    e.tools.every(isOpen) && (e.needs !== 'secretCreate' || caps.secretCreate === true));
}

/** 「쓸 수 있는 기능」 절 본문. 항목 하나 = 한 줄(이어지는 줄은 들여 쓴다). */
export function featureLines(entries: readonly FeatureEntry[]): string[] {
  return entries.flatMap((e) => e.lines.map((l, i) => (i === 0 ? `- ${l}` : `  ${l}`)));
}
