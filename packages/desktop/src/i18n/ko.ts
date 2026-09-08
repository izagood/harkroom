import type { Catalog } from './en';

/**
 * 한국어 — **여러 언어 중 하나다.** 원본은 `en.ts` 이고 이 파일은 그 키 집합을 따른다.
 *
 * `satisfies Catalog` 가 계약이다: 키를 빠뜨리면 **여기서 컴파일이 막힌다.** 그것이
 * 이 구조가 라이브러리 없이도 지키는 것 하나다 — i18next 였다면 빠진 키가 런타임에
 * `waitChain.empty` 라는 글자로 화면에 뜬다.
 *
 * ## 복수형이 한 갈래인 것은 누락이 아니다
 *
 * `waitChain.unblocks` 가 `other` 하나만 갖는다. 한국어는 수에 따라 명사가 안 바뀌므로
 * `Intl.PluralRules('ko')` 가 어느 수에나 `other` 를 낸다 — **그 언어의 사실**이라
 * `one` 을 적으면 그 줄은 영원히 안 쓰인다. `Plural` 타입이 `other` 만 필수인 이유다.
 *
 * ## 조사는 **번역문 안에서** 푼다
 *
 * `{waiter}가` 라고 못 적는다 — 받침에 따라 `이/가` 가 갈리고 handle 은 영문도 한글도
 * 온다(`민수가` 와 `codex 가`). 그래서 이 언어만 쓰는 **후처리 규칙**을 둔다:
 * `{waiter:은는}` 처럼 자리표시자에 조사를 붙이면 번역기가 받침을 보고 고른다
 * (`format.ts::applyParticle`). 영어 원본에는 그런 표기가 없고, 그것이 맞다 —
 * **문법 규칙은 그것을 가진 언어의 파일에만 있어야 한다.**
 */
export const ko = {
  'common.someone': '사람',

  // ---------------------------------------------------------------------------
  // sidebar — **키 순서는 `en.ts` 와 같다**(덩어리 알파벳 → 그 안 키 알파벳).
  // 두 파일이 같은 순서여야 나란히 놓고 읽을 수 있고, 리베이스 충돌도 사람이 합칠 수
  // 있다. 순서의 근거는 `en.ts` 의 sidebar 머리말에 있다.
  // ---------------------------------------------------------------------------

  'sidebar.brand.collapse': '사이드바 접기',
  'sidebar.brand.connected': '서버에 연결됨',
  'sidebar.brand.disconnected': '서버와 끊김 — 다시 붙을 때까지 아래 목록의 생사는 알 수 없다',
  'sidebar.brand.nav': '채널 목록',

  'sidebar.channel.archived': 'Archived ({count})',
  'sidebar.channel.cancel': '취소',
  'sidebar.channel.create': 'Create channel',
  'sidebar.channel.createFailed': '채널 생성에 실패했다',
  'sidebar.channel.createInvalidName': '이름은 영문 소문자·숫자·`-`·`_` 만 쓸 수 있다 (1~48자)',
  'sidebar.channel.createSubmit': '만들기',
  'sidebar.channel.favorites': 'Favorites',
  'sidebar.channel.heading': 'Channels',
  'sidebar.channel.hidden': 'Hidden ({count})',
  'sidebar.channel.private': '비공개 채널',
  'sidebar.channel.privateOption': '비공개 (멤버만 볼 수 있다)',
  'sidebar.channel.unread': '{name} 에 안 읽은 것 {count}개',

  'sidebar.delete.cancel': '취소',
  'sidebar.delete.confirm': '정말 삭제',
  'sidebar.delete.countFailed': '메시지 수를 읽지 못했다',
  'sidebar.delete.counting': '메시지 수를 읽고 있다…',
  'sidebar.delete.failed': '삭제에 실패했다',
  // 한국어는 수에 따라 명사가 안 바뀐다 — `other` 하나인 것이 그 언어의 사실이다.
  'sidebar.delete.scope': { other: '이 채널과 메시지 {count}개를 영구히 지운다. 되돌릴 수 없다.' },
  'sidebar.delete.title': '{name} 삭제',

  'sidebar.dm.new': 'New',

  'sidebar.edit.cancel': '취소',
  'sidebar.edit.failed': '채널 편집에 실패했다',
  'sidebar.edit.repoPlaceholder': 'repo (비우면 해제)',
  'sidebar.edit.save': '저장',
  'sidebar.edit.title': '{name} 편집',
  'sidebar.edit.topicPlaceholder': 'topic (선택)',

  'sidebar.members.adminBadge': '워크스페이스 admin',
  'sidebar.members.adminBadgeTitle': '워크스페이스 admin — 채널 역할이 아니다',
  'sidebar.members.agentDisabled': '비활성',
  'sidebar.members.autoMentionBadge': '자동',
  'sidebar.members.autoMentionCheckbox': '@{handle} 자동 멘션',
  'sidebar.members.autoMentionEmptyAdmin': '켤 수 있는 에이전트가 없다',
  'sidebar.members.autoMentionEmptyReader': '자동으로 부르는 에이전트가 없다',
  'sidebar.members.autoMentionFailed': '자동 멘션을 바꾸지 못했다',
  'sidebar.members.autoMentionHeading': '자동 멘션',
  'sidebar.members.autoMentionListFailed': '자동 멘션 목록을 받지 못했다',
  'sidebar.members.autoMentionNote':
    '켠 에이전트는 이 채널에서 사람이 쓰는 글 앞에 자동으로 불린다. '
    + '작성창의 칩 × 로 한 메시지에서만 뺄 수 있다.',
  'sidebar.members.autoMentionNoteReadOnly': ' 바꾸는 것은 admin 만 할 수 있다.',
  'sidebar.members.close': '닫기',
  'sidebar.members.empty': '멤버가 없다',
  'sidebar.members.invite': '초대',
  'sidebar.members.inviteFailed': '초대에 실패했다',
  'sidebar.members.invitePick': '계정 선택…',
  'sidebar.members.inviteSelect': '초대할 계정',
  'sidebar.members.kindAgent': '에이전트',
  'sidebar.members.kindHuman': '사람',
  'sidebar.members.lastMemberWarning':
    '나가면 아무도 이 채널을 볼 수 없다 — 마지막 멤버다. 채널은 지워지지 않는다.',
  'sidebar.members.leave': '나가기',
  'sidebar.members.leaveConfirm': '정말 나가기',
  'sidebar.members.leaveFailed': '나가기에 실패했다',
  'sidebar.members.listFailed': '멤버 목록을 받지 못했다',
  'sidebar.members.loading': '불러오는 중…',
  'sidebar.members.notAMember': '이 채널의 멤버가 아니다',
  'sidebar.members.readOnlyArchived': '보관된 채널은 읽기 전용이라 멤버를 바꿀 수 없다',
  'sidebar.members.remove': '내보내기',
  'sidebar.members.removeAction': '{handle} 내보내기',
  'sidebar.members.removeFailed': '내보내기에 실패했다',
  'sidebar.members.scopePrivate': '이 목록이 이 채널을 볼 수 있는 사람의 전부다.',
  'sidebar.members.scopePublic':
    '누구나 읽고 쓸 수 있는 채널이다 — 이 목록은 구독한 사람이지, 볼 수 있는 사람의 전부가 아니다.',
  'sidebar.members.teamAdd': '추가',
  'sidebar.members.teamAddFailed': '팀 추가에 실패했다',
  'sidebar.members.teamAdded': '추가: {names}',
  'sidebar.members.teamAlready': '이미 있음: {names}',
  'sidebar.members.teamHeading': '팀으로 추가',
  'sidebar.members.teamListFailed': '팀 목록을 받지 못했다',
  'sidebar.members.teamPick': '팀 선택…',
  'sidebar.members.teamSelect': '추가할 팀',
  'sidebar.members.teamSkipped': '건너뜀: {names}',
  'sidebar.members.title': '{name} 멤버',

  'sidebar.menu.archive': '보관',
  'sidebar.menu.copyId': '채널 ID 복사',
  'sidebar.menu.copyName': '채널명 복사',
  'sidebar.menu.delete': '삭제',
  'sidebar.menu.edit': '채널 편집',
  'sidebar.menu.hide': '숨기기',
  'sidebar.menu.invite': '초대',
  'sidebar.menu.leave': '나가기',
  'sidebar.menu.markUnread': '미읽음으로 표시',
  'sidebar.menu.members': '멤버 보기',
  'sidebar.menu.moveDown': '아래로',
  'sidebar.menu.moveUp': '위로',
  'sidebar.menu.section': '섹션: {name}',
  'sidebar.menu.sectionClear': '섹션에서 빼기',
  'sidebar.menu.sectionNew': '새 섹션…',
  'sidebar.menu.star': '즐겨찾기',
  'sidebar.menu.unarchive': '보관 해제',
  'sidebar.menu.unhide': '숨김 해제',
  'sidebar.menu.unstar': '즐겨찾기 해제',

  'sidebar.notify.all': '전체',
  // 알림 3단. 한국어도 **한 축**이다 — `전체`/`멘션만`/`없음` 이 그대로 사다리가 된다.
  // `없음` 을 `안 받음` 으로 바꾸지 않는다: 원래 화면이 그 말이었고 회귀선이 그것을 잰다.
  'sidebar.notify.item': '{check}알림: {level}',
  'sidebar.notify.mentions': '멘션만',
  'sidebar.notify.none': '없음',

  'sidebar.resize.handle': '사이드바 너비 조절',

  'sidebar.runner.launchFailed': '기동 실패 — {reason}',
  'sidebar.runner.state': '러너: {label}',

  'sidebar.section.cancel': '취소',
  'sidebar.section.movePlaceholder': '섹션 이름',
  'sidebar.section.moveSubmit': '옮기기',
  'sidebar.section.name': '새 섹션 이름',
  'sidebar.section.rename': '이름 바꾸기',
  'sidebar.section.renameName': '섹션 새 이름',
  'sidebar.section.renamePlaceholder': '새 이름',
  'sidebar.section.renameSubmit': '바꾸기',

  // 조사 표기(`:이가`)가 붙는다 — 위 머리말 참고. 영어 원본에는 이런 표기가 없다.
  'waitChain.link': '{waiter:이가} {blockedBy}의 답을 기다린다',
  'waitChain.linkAnyone': '{waiter:이가} 사람의 답을 기다린다',

  'waitChain.deadlock': '교착',
  'waitChain.deadlockCycle': '{names} 가 서로를 기다린다 — 사람만이 풀 수 있다',
  'waitChain.deadlockDeadRunner': '{waiter} 가 {blockedBy} 를 기다리는데 응답이 없다',

  'waitChain.unblocks': { other: '답하면 {count}개가 풀린다' },

  'waitChain.sectionTitle': '기다리는 것',
  'waitChain.sectionTitleCount': '기다리는 것 ({count})',
  'waitChain.empty': '기다리는 것이 없다',
  'waitChain.unseen': '아직 다 보지 못했다',
  'waitChain.dm': 'DM',
  'waitChain.reasonCycle': '서로를 기다린다',
  'waitChain.reasonDeadRunner': '답할 쪽이 멈췄다',

  'message.channelEcho': '채널에도 전송됨',
  'message.threadOrigin': '스레드에 댓글 남김',
  'message.recentReplies': '최근 댓글 보기',
} satisfies Catalog;
