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

  'appearance.colorMode': '색 모드',
  'appearance.description': '시스템을 따르거나, 밝게 또는 어둡게 고른다',
  'appearance.language': '언어',
  'appearance.languageOption': '{name} 로 보기',
  'appearance.languageSystem': '시스템',
  'appearance.mode': '{mode} 모드',
  'appearance.title': '모양',

  'sweep.close': '닫기',
  'sweep.done': '다 봤다',
  'sweep.failed': '읽음 처리에 실패했다',
  'sweep.justNext': '그냥 다음',
  'sweep.loading': '불러오는 중…',
  'sweep.readAndNext': '읽음 처리하고 다음',
  'sweep.retry': '다시 시도',
  'sweep.title': '미읽음 훑기',
  'sweep.unknownError': '알 수 없는 오류',

  'accountOpen.agentConfig': '{handle} 에이전트 설정 열기',
  'accountOpen.profile': '{handle} 프로필 열기',

  'mention.unknownAccount': '알 수 없음',

  'thread.alsoPostToChannel': '채널에도 올리기',
  'thread.resizeHandle': '스레드 너비 조절',

  // ---------------------------------------------------------------------------
  // avatar · avatarEdit — **어투를 `~다` 로 맞췄다.** 이 둘만 `~습니다`·`~주세요` 였고,
  // 한 자리만 높임말이면 같은 앱이 사람을 두 가지로 대한다(`profileName`·`InviteSettings`
  // 가 세운 선례). 뜻은 그대로다.
  // ---------------------------------------------------------------------------

  'attachment.fetchFailed': '첨부를 불러오지 못했다',
  'attachment.missing': '첨부 파일이 서버에 없다',

  'avatar.error.notAnImage': '{formats} 파일만 쓸 수 있다. 파일 이름이 아니라 내용으로 판정한다.',
  'avatar.error.notFound': '업로드한 파일을 찾지 못했다. 다시 시도한다.',
  'avatar.error.other': '사진을 바꾸지 못했다 ({code}).',
  'avatar.error.unreachable': '사진을 바꾸지 못했다. 서버에 연결하지 못했을 수 있다.',
  'avatar.error.svgTooLarge': 'SVG 는 256 KiB 까지 쓸 수 있다. 더 단순한 그림이나 PNG 로 바꾼다.',
  'avatar.error.tooLarge': '파일이 너무 크다. 더 작은 이미지를 고른다.',

  'avatarEdit.progress.applying': '프로필에 적용 중…',
  'avatarEdit.progress.aria': '사진 업로드 진행',
  'avatarEdit.progress.removing': '사진을 지우는 중…',
  'avatarEdit.progress.uploading': '사진 올리는 중…',
  'avatarEdit.progress.uploadingPct': '사진 올리는 중… {pct}%',
  'avatarEdit.result.changed': '사진을 바꿨다',
  'avatarEdit.result.removed': '사진을 지웠다',

  // ---------------------------------------------------------------------------
  // gallery — **키 순서는 `en.ts` 와 같다**(덩어리 알파벳 → 그 안 키 알파벳).
  //
  // 이 영역에 **견본 대화가 없는 이유**는 `en.ts` 머리말이 적었다 — 카드 속 말은 화면
  // 문구가 아니라 데이터이고, 이 화면이 가르치는 것은 카드의 생김새다.
  // ---------------------------------------------------------------------------

  'gallery.page.namesMissing':
    '에이전트가 둘 미만이라 이름 자리가 {ellipsis} 로 남는다. 색과 수신자, 사슬의 모양은 '
    + '견본으로 고정되어 규칙대로 그려진다 — 에이전트 둘을 만들면 이름까지 실제 값으로 채워진다.',
  'gallery.page.subtitle': '여덟 가지 말과 그 경계 상태. 여기가 깨지면 어휘가 깨진 것이다.',
  /** 화면 제목은 원래도 영어였다 — 설정 목차의 다른 항목들과 같은 자리이기 때문이다. */
  'gallery.page.title': 'Component gallery',

  'gallery.speech.askDone': '선택 — 이미 답한 것',
  'gallery.speech.askDoneNote': '고른 것만 남고 강조를 거둔다.',
  'gallery.speech.askForMe': '선택 — 나에게 온 것',
  'gallery.speech.askForMeNote': '강조를 받는 유일한 카드. 누를 수 있다.',
  'gallery.speech.askToAgent': '선택 — 에이전트에게 간 것',
  'gallery.speech.askToAgentNote': '무채색. 읽히되 누를 수 없다(규칙 04).',
  'gallery.speech.exchange': '에이전트끼리의 주고받기',
  'gallery.speech.exchangeNote': '기본 접힘. 접지 않으면 스레드가 로그가 된다.',
  'gallery.speech.failFinal': '실패 — 다시 불러도 소용없다',
  'gallery.speech.failFinalNote': "'다시 부르기'가 없다 — 없는 문은 그리지 않는다.",
  'gallery.speech.failRetry': '실패 — 다시 부를 수 있다',
  'gallery.speech.failRetryNote': '언제나 사람에게 온다. 고치는 경로가 같은 자리에.',
  'gallery.speech.progress': '진행',
  'gallery.speech.progressNote': '답이 필요 없는 구간. 문장이 아니라 상태 한 줄이다.',
  'gallery.speech.report': '완료 보고',
  'gallery.speech.reportNote': '읽히는 말이라 강조색을 쓰지 않는다. 가장 오래 남는 말이다.',

  'gallery.thread.chainMine': '대기 사슬 — 내 차례',
  'gallery.thread.chainMineNote': '몇 개가 풀리는지가 사람이 답할 이유다.',
  'gallery.thread.chainStuck': '대기 사슬 — 교착',
  'gallery.thread.chainStuckNote': '사슬이 아무 데도 닿지 않는다. 사람만이 푼다.',
  'gallery.thread.participants': '참여자 줄 · 터미널 선택자',
  'gallery.thread.participantsNote': '응답 없는 자는 흐리다. 소유자 아닌 것은 목록에 없다.',
  'gallery.thread.states': '스레드 상태 5단',
  'gallery.thread.statesNote': '강조는 둘뿐이고 그 둘도 색이 다르다.',
  // defaults — **키 순서는 `en.ts` 와 같다.** `harness`·`model`·`effort` 는 안 옮긴다.
  // ---------------------------------------------------------------------------

  'defaults.field.effort': '기본 effort',
  'defaults.field.harness': '기본 harness',
  'defaults.field.harnessDefault': 'harness 기본값',
  'defaults.field.model': '기본 model',
  'defaults.field.modelHint': '비우면 하네스가 고른다 — murmur 는 그 선택을 발화에 실린 모델로만 안다',
  'defaults.field.applyScope': '다음에 만드는 에이전트에만 적용된다. 이미 있는 에이전트는 바뀌지 않는다.',
  'defaults.field.loadFailed': '기본값을 불러오지 못했다',
  'defaults.field.loading': '불러오는 중…',
  'defaults.field.notAdmin': '기본값을 정할 수 있는 것은 admin 뿐이다.',
  'defaults.field.save': '기본값 저장',
  'defaults.field.saved': '저장했다',
  'defaults.field.saveFailed': '기본값을 저장하지 못했다',
  'defaults.field.subtitle': '새로 만드는 에이전트가 물려받을 값. 이미 있는 에이전트는 바뀌지 않는다.',

  // ---------------------------------------------------------------------------
  // groups — 한국어는 원래 쓰던 `집합` 을 그대로 둔다. 영어가 `group` 인 근거는
  // `en.ts` 머리말에 있고, **낱말 선택은 언어마다 제 사정을 따른다.**
  // ---------------------------------------------------------------------------

  'groups.edit.addMember': '구성원 추가',
  'groups.edit.addMemberFailed': '구성원을 추가하지 못했다',
  'groups.edit.displayName': '표시 이름',
  'groups.edit.memberAccountId': '계정 ID: {id}',
  'groups.edit.membersFailed': '구성원 명단을 받지 못했다',
  'groups.edit.newDisplayName': '새 표시 이름',
  'groups.edit.pick': '집합을 고른다',
  'groups.edit.removeMember': '구성원 제거: {name}',
  'groups.edit.removeMemberFailed': '구성원을 제거하지 못했다',
  'groups.edit.renameFailed': '이름을 저장하지 못했다',
  'groups.list.empty': '아직 없다',
  'groups.list.heading': '집합',
  'groups.list.subtitle': '사람 여럿을 한 이름으로 부르는 장치다. 에이전트를 묶으려면 설정 › Agents 의 팀 묶음이다 — 이름 자리는 둘이 함께 쓴다.',
  'groups.member.empty': '구성원이 없다',
  'groups.member.pick': '계정 선택…',
  'groups.member.remove': '제거',
  'groups.new.badHandle': '집합 핸들은 계정 핸들과 같은 문법이어야 한다',
  'groups.new.createFailed': '만들지 못했다 (이미 있는 이름일 수 있다)',
  'groups.new.displayName': '집합 표시 이름',
  'groups.new.handle': '집합 핸들',
  'groups.new.readOnly': '집합을 만들고 고치는 것은 admin 만 할 수 있다',
  'groups.new.create': '만들기',
  'groups.new.heading': '새 집합',
  'groups.remove.cancel': '취소',
  'groups.remove.confirm': '정말 지운다',
  'groups.remove.start': '집합 삭제',
  'groups.rename.name': '이름',
  'groups.rename.save': '저장',
  'groups.rename.start': '이름 바꾸기',
  'groups.remove.failed': '지우지 못했다',

  // ---------------------------------------------------------------------------
  // profileName — **어투를 `~다` 로 맞췄다**(근거는 `en.ts` 머리말). 뜻은 그대로다.
  // ---------------------------------------------------------------------------

  'profileAvatar.removeCancel': '취소',
  'profileAvatar.removeConfirm': '정말 지우기',

  'profileName.apply': '적용',
  'profileName.empty': '새 이름을 적는다',
  'profileName.cancel': '취소',
  'profileName.confirm': '확인',
  'profileName.effectPast': '과거 메시지의 멘션도 새 이름으로 보인다.',
  'profileName.effectPermanent': '이 변경은 되돌릴 수 없다.',
  'profileName.failed': '이름을 바꾸지 못했다',
  'profileName.heading': '불리는 이름',
  'profileName.input': '새 이름',
  'profileName.start': '바꾸기',
  'profileName.invalidChars': '소문자와 숫자, 밑줄, 하이픈만 쓸 수 있다',
  'profileName.length': '2~32자여야 한다',
  'profileName.taken': '이 이름은 이미 쓰고 있다',
  'profileName.unusable': '쓸 수 없는 이름이다',

  // ---------------------------------------------------------------------------
  // skills — 확인 문구 셋이 **각각 다른 일**을 말한다(`en.ts` 머리말).
  // ---------------------------------------------------------------------------

  'skills.confirm.approve':
    '승인하면 이 본문이 모든 에이전트의 스킬 디렉터리에 SKILL.md 로 깔리고, 하네스가 필요할 때 읽는다',
  'skills.confirm.disable': '비활성화하면 모든 에이전트가 이 스킬의 파일과 링크를 삭제한다',
  'skills.confirm.reject': '거부하면 이 스킬은 비활성으로 내려간다 — 되돌리려면 에이전트가 다시 제안해야 한다',
  'skills.confirm.approveStart': '승인 확인',
  'skills.confirm.cancel': '취소',
  'skills.group.approved': '승인됨',
  'skills.group.approvedEmpty': '승인된 스킬이 없다',
  'skills.group.disabled': '비활성',
  'skills.group.disabledEmpty': '비활성된 스킬이 없다',
  'skills.group.pending': '대기 중',
  'skills.group.pendingEmpty': '승인을 기다리는 스킬이 없다',
  'skills.group.subtitle':
    '에이전트가 제안한 워크스페이스 스킬. 승인하면 본문이 모든 에이전트의 스킬 파일로 깔리고, 하네스가 필요할 때 읽는다.',
  'skills.list.loadFailed': '스킬 목록을 불러오지 못했다',
  'skills.list.loading': '불러오는 중…',
  'skills.list.refresh': '새로고침',
  'skills.row.approve': '승인',
  'skills.row.approveFailed': '승인하지 못했다',
  'skills.row.confirmDisable': '비활성화 확인',
  'skills.row.confirmReject': '거부 확인',
  'skills.row.disable': '비활성화',
  'skills.row.disableFailed': '비활성화하지 못했다',
  'skills.row.fold': '본문 접기',
  'skills.row.reject': '거부',
  'skills.row.rejectFailed': '거부하지 못했다',
  'skills.row.unfold': '본문 보기',

  // ---------------------------------------------------------------------------
  // agents — **키 순서는 `en.ts` 와 같다**(덩어리 알파벳 → 그 안 키 알파벳).
  //
  // 원래 화면의 말투를 그대로 살렸다. 이 화면은 `~합니다` 와 `~한다` 가 섞여 있었는데
  // (비활성화 상자만 `합니다`, 나머지는 전부 `한다`) **`한다` 로 통일했다** — 저장소의
  // 다른 사전과 문서가 그 말투이고, 한 화면 안에서 두 말투가 갈리면 어느 문장이 더 무거운
  // 말인지가 말투 차이로 잘못 읽힌다. 단정을 바꾼 곳은 없다.
  //
  // **번역하지 않은 것**은 `en.ts` 의 agents 머리말에 표로 적었다 — `admin`·`PAT`·
  // `harness`·`daemon`·`attach`·`murmur`, `auto`/`readonly` 값, 경로·이름 예시, 종료 코드.
  // ---------------------------------------------------------------------------

  // --- Agents 칸의 관제 구획(`AgentTurns`) — 근거는 `en.ts` 의 같은 묶음에 있다 --------
  'agentTurns.accountDefault': '기본 로그인',
  'agentTurns.accountTitle': '이 턴이 지금 쓰는 claude 계정 (풀: {pool})',
  'agentTurns.accountTitleRoot': '이 턴이 지금 쓰는 claude 계정 (뿌리 풀)',
  'agentTurns.cancel': '중단',
  'agentTurns.cancelAll': '전부 중단',
  'agentTurns.cancelAllTitle': '도는 턴 {n}개를 중단할까?',
  'agentTurns.cancelConfirm': '중단',
  'agentTurns.cancelDetail': '턴만 끊는다 — 러너는 살아 있어 다음 멘션을 정상으로 받는다. 중단된 턴은 그 스레드에 실패 카드로 남는다. 사람이 직접 조종 중인 턴은 건드리지 않는다.',
  'agentTurns.cancelKeep': '그대로 두기',
  'agentTurns.cancelThread': '스레드 중단',
  'agentTurns.cancelThreadTitle': '이 스레드에서 도는 턴을 전부 중단한다',
  'agentTurns.checking': '확인 중\u2026',
  'agentTurns.count': '{n}개 도는 중',
  'agentTurns.human': '사람이 조종 중',
  'agentTurns.noThread': '러너가 어느 스레드의 턴인지 말하지 않았다',
  'agentTurns.none': '도는 턴 없음',
  'agentTurns.scope': '러너가 알려 준 턴만, 내가 볼 수 있는 에이전트에 대해 보인다.',
  'agentTurns.title': '지금 도는 턴',
  'agentTurns.unknown': '도는 턴을 알 수 없다',
  'agentTurns.unknownHint': '0개라는 뜻이 아니다 — 러너는 계속 돌고 있을 수 있다.',
  'agents.create.failed': '만들지 못했다 (이미 있는 이름일 수 있다)',
  'agents.create.invalidName': '이름은 소문자·숫자·-·_ 2~32자여야 한다 (채널에서 @이름 으로 부른다)',
  'agents.create.poolFailed': '에이전트는 만들어졌지만 계정 풀을 배정하지 못했다: {reason}',

  'agents.detail.back': '← 에이전트',
  'agents.detail.disconnected': '연결 끊김 — 살아 있는지 알 수 없다',
  'agents.detail.lastTurn': '마지막 활동: {ago}',
  'agents.detail.launchFailed': '기동 실패',
  'agents.detail.launchFailedReason': '기동 실패 — {reason}',
  'agents.detail.noActivity': '활동 없음',
  'agents.detail.offline': '오프라인',
  'agents.detail.online': '온라인',
  'agents.detail.ownerNone': '없음',
  'agents.detail.ownerUnknown': '알 수 없는 계정',
  'agents.detail.revert': '되돌리기',
  'agents.detail.save': '저장',
  'agents.detail.saveFailed': '저장하지 못했다',
  'agents.detail.submitNew': '에이전트 만들기',
  'agents.detail.titleEdit': '{handle} 편집',
  'agents.detail.titleNew': '새 에이전트',

  'agents.disable.cancel': '취소',
  'agents.disable.confirm': '정말 비활성화',
  'agents.disable.disable': '비활성화',
  'agents.disable.disableAction': '에이전트 비활성화',
  'agents.disable.disableFailed': '비활성화하지 못했다 — 에이전트는 그대로 켜져 있다',
  'agents.disable.enable': '활성화',
  'agents.disable.enableAction': '에이전트 활성화',
  'agents.disable.enableFailed': '활성화하지 못했다 — 에이전트는 그대로 꺼져 있다',
  'agents.disable.headingDisabled': '비활성화된 에이전트',
  'agents.disable.headingEnabled': '에이전트 활성화',
  'agents.disable.noteDisabled':
    '이 에이전트는 비활성화되어 있다. 다시 활성화하면 PAT 가 없다(재발급 필요)고 안내가 뜬다 — '
    + '비활성화 시 모든 PAT 가 폐기되었기 때문이다.',
  'agents.disable.noteEnabled':
    '에이전트를 비활성화하면 {strongRevoked}되고, 다시 활성화해도 PAT 는 복구되지 않아 '
    + '{strongMint}해야 한다.',
  'agents.disable.noteEnabledMint': '새로 발급',
  'agents.disable.noteEnabledRevoked': '모든 PAT 가 폐기',
  'agents.disable.warning':
    '{strongRevoked}되어 러너가 멈춘다. 다시 활성화해도 PAT 는 돌아오지 않으며, '
    + '{strongMint}해야 한다.',
  'agents.disable.warningMint': '새로 발급',
  'agents.disable.warningRevoked': '이 에이전트의 모든 PAT 가 폐기',

  'agents.grid.heading': '에이전트',
  'agents.grid.listFailed': '에이전트 목록을 받지 못했다',
  'agents.grid.note': '채널에서 @이름 으로 부른다. 카드를 누르면 설정이 열린다.',
  'agents.grid.tabAgents': '에이전트',
  'agents.grid.tablist': '에이전트와 팀',
  'agents.grid.tabTeams': '팀',

  'agents.memory.deleteAction': '{slug} 기억 지우기',
  'agents.memory.deleteConfirm': '정말 지운다',
  'agents.memory.deleteFailed': '기억을 지우지 못했다',
  'agents.memory.deleteStart': '지우기',
  'agents.memory.empty': '기억이 없다',
  'agents.memory.failed': '기억을 불러오지 못했다',
  // 원래 화면은 `기억 (memory)` 로 원어를 병기했다 — 한국어에서는 그 병기가 값을 하므로
  // 남긴다(영어에서는 같은 말의 반복이라 `Memory` 하나다).
  'agents.memory.heading': '기억 (memory)',
  'agents.memory.keep': '두기',
  'agents.memory.loading': '불러오는 중…',

  'agents.pat.copyToken': '토큰 복사',
  'agents.pat.label': 'New PAT label',
  'agents.pat.labelNote': '라벨은 살아 있는 토큰 안에서 유일하다. 폐기하면 같은 라벨을 다시 쓸 수 있다.',
  'agents.pat.listFailed': 'PAT 목록을 읽지 못했다',
  'agents.pat.loading': 'PAT 를 읽고 있다…',
  'agents.pat.mint': '+ New PAT',
  'agents.pat.mintFailed': 'PAT 를 새로 발급하지 못했다',
  'agents.pat.none': 'PAT 가 없다',
  'agents.pat.noneNeedsMint': 'PAT 가 없다 — 새로 발급해야 한다(비활성화 시 전부 폐기됨)',
  'agents.pat.revoke': 'Revoke',
  'agents.pat.revokeCancel': 'Cancel',
  'agents.pat.revokeConfirm': 'Really revoke',
  'agents.pat.revoked': '(폐기됨)',
  'agents.pat.revokeFailed': 'PAT 를 폐기하지 못했다',
  'agents.pat.shownOnce': '이 토큰은 지금만 보인다 — 서버가 해시만 보관하므로 다시 볼 수 없다',

  'agents.permissions.mentionAuto': 'auto — 멘션 턴에서 도구를 모두 허용',
  'agents.permissions.mentionNote': '사람이 터미널로 직접 조종할 때는 이 설정과 무관하게 하네스가 물어본다.',
  'agents.permissions.mentionReadonly': 'readonly — 읽기만 (상담 전용)',
  'agents.permissions.mentionReadOnlyValue': 'Mention permission: {value} (admin 만 바꾼다)',
  'agents.permissions.note': '누가 조종하고 무엇을 할 수 있는가.',
  'agents.permissions.ownerLabel': '소유자',
  'agents.permissions.ownerNone': '없음 — attach 불가',
  'agents.permissions.ownerNote': '소유자만 이 에이전트에 attach 할 수 있다.',
  'agents.permissions.ownerReadOnly': '소유자: @{handle}',
  'agents.permissions.ownerReadOnlyNone': '소유자: 없음 — attach 불가',
  'agents.permissions.title': '권한',
  'agents.permissions.workingDirPlaceholder': '/Users/me/some-repo — 비우면 스레드 전용 빈 디렉터리를 새로 만든다',

  'agents.profile.avatarFormats': '{formats} · 비우면 이름에서 색을 뽑는다',
  'agents.profile.avatarRemove': '지우기',
  'agents.profile.avatarRemoveCancel': '취소',
  'agents.profile.avatarRemoveConfirm': '정말 지우기',
  'agents.profile.avatarUpload': '사진 올리기',
  'agents.profile.handleNote': '채널에서 @이름 으로 부른다. 나중에 바꿀 수 없다.',
  'agents.profile.instructionsPlaceholder': '이 에이전트가 무엇을 하는지 적는다.',
  'agents.profile.note': '채널에서 어떻게 보이고 무엇을 하는가.',
  'agents.profile.title': '프로필',

  'agents.run.defaultsFailed': '기본값을 불러오지 못했다 — 새 에이전트 초안을 만들 수 없다',
  'agents.run.defaultsLoading': '기본값을 불러오는 중…',
  'agents.run.defaultsNotAdmin': '에이전트를 만들 수 있는 것은 admin 뿐이다',
  'agents.run.harnessDefault': 'harness 기본값',
  'agents.run.harnessPlanned': '{harness} (지원 예정)',
  'agents.run.note': '무엇으로 도는가.',
  'agents.run.title': '실행',

  'agents.runner.commandCopy': '명령 복사',
  'agents.runner.copied': '복사됨',
  'agents.runner.copy': '복사',
  'agents.runner.copyFailedManual': '클립보드를 쓸 수 없고 명령을 선택할 수도 없다 — 명령을 손으로 옮겨 적는다',
  'agents.runner.copyFailedSelected': '클립보드를 쓸 수 없다 — 명령을 선택해 두었으니 ⌘C 로 복사한다',
  'agents.runner.daemonScope':
    'daemon 은 {strongOnlyOwn} 안다. 다른 머신이나 손으로 띄운 러너는 이 목록에 없어서 여기 '
    + '나타나지 않는다 — 그때는 서버에 붙어 있다는 사실만 사유로 붙고, 이 앱은 자기 러너를 그대로 띄운다.',
  'agents.runner.daemonScopeOnlyOwn': '자기가 띄운 러너만',
  'agents.runner.factsHeading': '러너 — daemon 이 직접 확인한 것',
  'agents.runner.heading': '러너 (이 앱)',
  'agents.runner.ownedNote':
    '이 앱은 {strongOwn} 에이전트의 러너를 띄운다. {strongDaemon} 러너가 살아 있으면 새로 띄우지 않고 '
    + '‘{label}’ 으로 표시한다 — 같은 에이전트에 러너가 둘이면 멘션을 두 러너가 나눠 집어 간다.',
  'agents.runner.ownedNoteDaemon': 'daemon 이 이미 들고 있는',
  'agents.runner.ownedNoteOwn': '내가 소유한',
  'agents.runner.patGoToMint': 'PAT 발급으로 이동',
  'agents.runner.reissue': 'PAT 재발급',
  'agents.runner.reissueFailed': 'PAT 재발급에 실패했다: {reason}',
  'agents.runner.reissueNote':
    '새 PAT 를 발급하고 {strongRevoke} 러너를 다시 띄운다. 옛 PAT 로 돌던 러너(다른 머신의 것도)는 '
    + '다음 호출에서 401 을 받고 종료 코드 78 로 스스로 물러난다.',
  'agents.runner.reissueNoteRevoke': '옛 PAT 를 폐기한 뒤',
  'agents.runner.reissuing': '재발급 중…',
  'agents.runner.startFailed': '러너를 띄우지 못했다: {reason}',
  /** `#` 는 셸 주석 기호다 — 이 값이 통째로 클립보드에 실린다(`en.ts` 의 그 주석). */
  'agents.runner.commandBundledNote': '# 앱을 설치해 쓰는 경우 (설치 위치가 다르면 경로를 바꾼다)',
  'agents.runner.commandDevNote': '# murmur 저장소를 클론한 개발 환경',
  'agents.runner.templateHeading': '러너 실행',
  'agents.runner.templateNote': '토큰은 발급 순간에만 보인다. 잃었으면 새로 발급한다.',
  'agents.runner.whoStarts':
    'murmur {strongServer}는 러너를 띄우지 않는다. 이 데스크탑 앱은 {strongOwn} 에이전트만 띄운다 — '
    + '남이 소유했거나 소유자가 없는 에이전트는 {strongNoAnswer}(멘션은 쌓이기만 한다). '
    + '러너는 앱과 함께 배포되므로 murmur 앱이 설치된 머신이면 된다 — 저장소는 아래 개발용 갈래에만 필요하다.',
  'agents.runner.whoStartsNoAnswer': '위 명령을 직접 실행해 러너를 붙이기 전까지 멘션에 답하지 않는다',
  'agents.runner.whoStartsOwn': '내가 소유한',
  'agents.runner.whoStartsServer': '서버',

  'agents.stale.allCurrent': '도는 러너가 전부 이 번들이다.',
  'agents.stale.elsewhere': {
    other: '이 기기가 띄운 러너는 전부 이 번들이다. 뒤처진 러너 {count}대는 다른 기기의 것이라 '
      + '여기서 재기동할 수 없다 — 그 기기의 murmur 에서 눌러야 한다.',
  },
  'agents.stale.note': '재기동은 {strong} — 턴을 마친 뒤 새 번들로 다시 뜬다.',
  'agents.stale.noteStrong': '진행 중인 턴을 끊지 않는다',
  // 한국어는 수에 따라 명사가 안 바뀐다 — `other` 하나인 것이 그 언어의 사실이다.
  'agents.stale.restart': { other: '뒤처진 러너 전체 재기동 ({count})' },
  'agents.stale.restartDone': { other: '러너 {count}대가 새 번들로 돌아왔다.' },
  'agents.stale.restartFailed': '재기동하지 못했다: {reason}',
  'agents.stale.restartRequested': {
    other: '러너 {count}대에 재기동을 걸었다 — 진행 중인 턴을 마치면 새 번들로 다시 뜬다.',
  },
  'agents.stale.restarting': '재기동 거는 중…',
  'agents.stale.unknownAppVersion': '앱 버전을 얻지 못해 뒤처짐을 판정할 수 없다.',
  'agents.stale.unknownVersion': {
    other: '버전을 모르는 러너 {count}대 — 뒤처졌는지 알 수 없어 대상에서 뺐다. '
      + '한 번 재기동하면 그 뒤로는 버전이 보인다.',
  },

  'agents.stop.acked':
    '러너가 요청을 읽어 갔다 (중지 {requestedAt} · 수령 {ackedAt}). 진행 중이던 턴을 마치고 '
    + '종료한다 — 실제로 종료했는지는 murmur 가 알 수 없다.',
  'agents.stop.ackedResume': ' 실행을 누르면 다음 기동부터 다시 자동 기동 대상이 된다.',
  'agents.stop.heading': '러너 실행 · 중지',
  'agents.stop.note':
    '{strongStop}는 러너를 지금 끊지 않는다 — 러너가{strongFinish}. 턴 중간에 끊지 않는 것은 사람이 '
    + '기다리는 답을 잃지 않기 위해서다. 중지해 둔 동안 이 에이전트는{strongSkipped}. '
    + '{strongStart}을 누르면 다시 대상에 들어와 {strongNextStart} — 지금 이 자리에서 띄우지는 않는다. '
    + '둘 다 언제든 되돌릴 수 있는 조작이다.',
  'agents.stop.noteFinish': ' 진행 중인 턴을 마친 뒤 스스로 종료',
  'agents.stop.noteNextStart': '다음 기동에서 러너가 뜬다',
  'agents.stop.noteSkipped': ' 자동 기동에서 빠진다',
  'agents.stop.noteStart': '실행',
  'agents.stop.noteStop': '중지',
  'agents.stop.notRequested': '자동 기동 대상이다 — 중지를 걸어 둔 적이 없다.',
  'agents.stop.requested':
    '중지함 ({requestedAt}) — 러너가 아직 읽어 가지 않았다. 러너가 붙어 있지 않으면 읽어 갈 쪽도 없다.',
  'agents.stop.start': '실행',
  'agents.stop.startAction': '러너 실행',
  'agents.stop.startFailed': '종료 요청을 되돌리지 못했다',
  'agents.stop.stop': '중지',
  'agents.stop.stopAction': '러너 중지',
  'agents.stop.stopFailed': '종료를 요청하지 못했다',

  // teams — **덩어리를 늘렸다.** 원래 화면 문구를 그대로 옮겼고, 갈린 곳은 둘뿐이다:
  // `← 팀` 이 `← 팀 목록` 이 되지 않았고(격자 머리가 `팀` 이라 그대로다), `팀원 빼기: `
  // 가 `팀에서 빼기: ` 로 바뀌었다 — 접근 이름은 **어디서 빼는지**를 말해야 채널 멤버
  // 빼기(`sidebar.members.removeAction`)와 안 겹친다.

  'agents.teams.back': '← 팀',
  'agents.teams.cancel': '취소',
  'agents.teams.candidateSearch': '팀원 후보 검색',
  'agents.teams.candidateSearchPlaceholder': '이름 · 설명으로 찾기',
  'agents.teams.create': '만들기',
  'agents.teams.createFailed': '팀을 만들지 못했다',
  'agents.teams.delete': '팀 지우기',
  'agents.teams.deleteConfirm': '정말 삭제',
  'agents.teams.deleteConfirmAsk': '정말 지우는가?',
  'agents.teams.deleteFailed': '팀을 지우지 못했다',
  'agents.teams.deleteHeading': '팀 삭제',
  'agents.teams.deleteNote': '팀을 지워도 팀에 속했던 에이전트는 그대로 있다',
  'agents.teams.detailFailed': '팀 정보를 받지 못했다',
  'agents.teams.cardInfo': '팀 · {count}명',
  'agents.teams.gridUnavailable':
    '이 서버는 팀 목록을 주지 않는다 — 앱보다 낡은 서버다. 팀을 만들 수는 있지만 만든 팀이 '
    + '여기 나타나지 않으니, 서버를 올린 뒤에 확인해라.',
  'agents.teams.gridEmpty': '아직 팀이 없다',
  'agents.teams.gridNoMatch': '“{query}” 에 맞는 팀이 없다',
  'agents.teams.gridSearch': '팀 검색',
  'agents.teams.gridSearchCount': '{count}개',
  'agents.teams.gridSearchPlaceholder': '이름으로 찾기',
  'agents.teams.heading': '팀',
  'agents.teams.invalidName': '이름은 영문·숫자·-·_ 2~32자여야 한다',
  'agents.teams.listFailed': '팀 목록을 받지 못했다',
  'agents.teams.memberAddFailed': '팀원을 추가하지 못했다',
  'agents.teams.memberCandidateEmpty':
    '넣을 수 있는 에이전트가 없다 — 등록된 에이전트가 모두 이 팀에 있다',
  'agents.teams.memberCandidateNoMatch': '“{query}” 에 맞는 에이전트가 없다',
  'agents.teams.memberDisabled': '비활성 — 호출에서 빠진다',
  /** 조사가 이름 목록의 받침을 따른다 — `forge 는` 과 `민수는` 이 갈리지 않게. */
  'agents.teams.cardDisabled': '{names:은는} 비활성 — 호출에서 빠진다',
  'agents.teams.memberEmpty': '팀원이 없다',
  'agents.teams.memberLoading': '불러오는 중…',
  'agents.teams.memberPickAction': '팀에 넣기: {handle}',
  'agents.teams.memberPickNote':
    '얼굴을 누르면 팀에 들어간다. 멈춘 에이전트도 넣을 수 있다 — 팀에 넣는 것과 지금 도는 '
    + '것은 다른 일이다.',
  'agents.teams.memberReadOnly': '팀원을 바꿀 수 있는 것은 admin 뿐이다',
  'agents.teams.memberRemove': '빼기',
  'agents.teams.memberRemoveAction': '팀에서 빼기: {handle}',
  'agents.teams.memberRemoveFailed': '팀원을 빼지 못했다',
  'agents.teams.membersHeading': '팀원',
  'agents.teams.nameEdit': '팀 이름 수정',
  'agents.teams.nameHeading': '팀 이름',
  'agents.teams.nameLabel': '새 팀 이름',
  /** `{name}` 은 화면이 다른 색으로 세우는 자리라 문장에서 뽑혀 있다(`en.ts` 와 같다). */
  'agents.teams.nameNote':
    '계정과 같은 이름 자리를 쓴다 — 채널에서 @{name} 을 부르면 팀원 전원이 깬다. '
    + '사람 여럿을 한 이름으로 부르려면 설정 › Handle Groups 다.',
  'agents.teams.nameSave': '저장',
  'agents.teams.newTeam': '새 팀',
  'agents.teams.renameFailed': '이름을 바꾸지 못했다',
  'agents.teams.note':
    '에이전트를 묶어 한 이름으로 부른다 — 채널에서 @팀이름 을 부르면 팀원 전원이 깬다. '
    + '카드를 누르면 팀원을 고칠 수 있다.',

  // ---------------------------------------------------------------------------
  // daemonFacts — **원래 문구를 한 글자도 안 바꿨다.**
  //
  // 이 판정의 회귀선(`daemonFacts.test.tsx`)은 한국어를 **고정해 놓고 글자를 잰다**
  // (그 파일이 `setLocale('ko')` 를 하는 이유를 머리말에 적어 뒀다). 그 축들이 지키는
  // 것은 언어가 아니라 **그 언어로 표현된 규율**이므로(제약 1 의 주어, 제약 2 의 판정
  // 낱말 없음), 옮기면서 문구를 다듬으면 지켜지던 규율이 조용히 사라진다.
  //
  // 그래서 이 영역만은 **영어를 새로 설계하되 한국어는 옮겨 적기만 했다.** 라벨 넷과
  // 값 아홉이 전부 옛 소스의 그 글자다.
  // ---------------------------------------------------------------------------

  'daemonFacts.label.liveness': '생사',
  // `pid` 는 두 언어가 같다 — 필드 이름이라 옮기지 않는다(`en.ts` 머리말).
  'daemonFacts.label.pid': 'pid',
  'daemonFacts.label.signal': '시그널',
  'daemonFacts.label.termination': '종료 요청',
  'daemonFacts.label.uptime': '가동',

  'daemonFacts.liveness.alive': 'alive — kill(pid, 0) 확인',
  'daemonFacts.liveness.dead': 'dead — kill(pid, 0) 이 실패했다',

  'daemonFacts.pid.incarnation': '세대 {id}',

  'daemonFacts.signal.none': 'daemon 은 안 보냈다',
  'daemonFacts.signal.sent': '{stamp} 에 SIGTERM',
  'daemonFacts.signal.sentStillAlive': '{stamp} 에 SIGTERM · 보낸 지 {elapsed}, 아직 살아 있다',

  'daemonFacts.termination.byPerson': '사람이 UI 에서 {time} · {read}',
  'daemonFacts.termination.bySignal': 'daemon 이 시그널로 {time}',
  'daemonFacts.termination.none': '없다 — 아무도 요청하지 않았다',
  'daemonFacts.termination.read': '러너가 {time} 에 읽었다',
  'daemonFacts.termination.unread': '러너가 아직 못 읽음',

  'daemonFacts.uptime.since': '{stamp} 부터 · {elapsed}',

  // ---------------------------------------------------------------------------
  // runner — **여기도 원래 문구 그대로다.**
  //
  // 이유가 daemonFacts 와 같다: 러너 실패 사유를 글자로 재는 회귀선이 넷이다
  // (`runnerFailureDisplay` · `runnerHarnessMissing` · `missingToolchainNotice` ·
  // `agentGrid`). 그 축들이 지키는 것은 **사유가 뭉개지지 않았다**는 사실이고,
  // 문구를 다듬으면 그 사실을 재던 자리가 사라진다.
  //
  // 옛 소스가 문자열을 이어 붙여 만들던 자리(`+` 로 이은 두세 줄)는 **자리표시자 낀
  // 한 문장**이 됐다 — 조각으로 두면 영어에서 그 조각들이 갈 자리가 없다는 것이
  // `waitChain.link` 가 세운 규율이다. 한국어 쪽 결과 글자는 그대로다.
  // ---------------------------------------------------------------------------

  'runner.exit.credentialRejected': 'PAT 가 폐기·회전됐다 — 재발급하면 다시 뜬다',
  'runner.exit.loginRequired': '{what} 로그인이 풀렸다 — 터미널에서 {binary} 를 실행해 다시 로그인하면 살아난다',
  'runner.exit.loginRequiredNoBinary': '{what} 의 로그인이 풀렸다 — 그 CLI 로 다시 로그인해라',
  'runner.exit.notFound': '{what} 를 찾을 수 없다 — 설치하고 PATH 에 있는지 확인하라. {hint}',
  'runner.exit.notFoundNoHint': '{what} 를 찾을 수 없다 — 설치하고 PATH 에 있는지 확인하라',
  'runner.exit.subjectHarness': '이 에이전트의 하네스({harness})',
  'runner.exit.subjectHarnessUnknown': '알 수 없음',
  'runner.exit.unknown': '설정 문제로 물러났다(78) — 사유를 가리지 못했다. 러너 로그를 확인하라',
  'runner.exit.unknownWithLog':
    '설정 문제로 물러났다(78) — 사유를 가리지 못했다. 러너 로그 마지막 줄: {excerpt}',

  'runner.launch.daemonUnreachable': 'daemon 에 닿지 못해 러너를 띄우지 않았다: {reason}',
  'runner.launch.failed': '기동 실패: {reason}',
  'runner.launch.keychainUnreadable':
    '키체인을 읽지 못했다 — 돌고 있는 러너를 죽일 수 있어 새로 발급하지 않았다: {reason}',
  'runner.launch.patNotStored':
    '에이전트는 생성됐지만 PAT 를 키체인에 저장하지 못해 러너를 띄우지 않았다: {reason}',

  'runner.reissue.keychainUnreadable': '키체인을 읽지 못해 옛 PAT 를 폐기할 수 없다 — 재발급하지 않았다: {reason}',
  'runner.reissue.mintFailed': '새 PAT 를 발급하지 못했다 — 옛 PAT 는 그대로 살아 있다: {reason}',
  'runner.reissue.revokeDeferred':
    '새 PAT 로 다시 띄운다. 옛 PAT({label})는 폐기하지 않았다 — 그것으로 도는 러너가 진행 중인 '
    + '턴을 마치는 중이다(끝나면 스스로 물러난다). 지금 끊어야 한다면 설정에서 손으로 폐기해라 — '
    + '그 턴은 답을 남기지 못한다.',
  'runner.reissue.revokeFailed':
    '새 PAT 로 다시 띄웠지만 옛 PAT({label}) 폐기에 실패했다 — 설정에서 손으로 폐기해라: {reason}',
  'runner.reissue.waiting': '새 PAT 를 받았다 — 옛 러너가 진행 중인 턴을 끝내고 물러나기를 기다린다',

  'runner.restart.killFailed': '재기동하지 못했다 — daemon 에 종료를 전하지 못했다: {reason}',
  'runner.restart.respawnUnreachable': '러너는 물러났지만 daemon 에 닿지 못해 다시 띄우지 못했다: {reason}',
  'runner.restart.stillRunning':
    '러너가 아직 물러나지 않았다 — 진행 중인 턴이 길다. 종료 요청은 이미 갔으므로 다음 기동에서 새 번들로 뜬다.',
  'runner.restart.waitingForRetirement': '앞 세대 러너가 진행 중인 턴을 끝내고 물러나는 중이다 — 끝나면 새로 띄운다',

  'runner.stranger.attached':
    '이 계정으로 붙어 있는 러너가 서버에 보이지만 이 daemon 의 장부에는 없다 — 내 러너는 새로 띄웠다',

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

  // find — **종류 글자 셋 중 둘은 `sidebar.members.kind*` 를 그대로 쓴다**(`en.ts` 머리말).

  'sidebar.find.allChannels': '모든 채널에서 찾기',
  'sidebar.find.kindChannel': '채널',
  'sidebar.find.label': '찾기',
  'sidebar.find.none': '찾는 것이 없다',
  'sidebar.find.placeholder': '채널 · 사람 · 에이전트',

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
  // 시간 — 수량은 `Intl` 이 낸다(`lib/time.ts`). 여기 있는 넷은 수량이 아니다.
  'time.justNow': '방금',
  'time.none': '없음',
  // 어미로 상[aspect]을 말한다 — 영어는 `running {duration}` 으로 말을 앞에 세운다.
  // **같은 뜻을 언어마다 다른 문법으로 낸다**, 그것이 이 둘이 사전에 있는 이유다.
  'time.running': '{duration}째',
  'time.took': '{duration}',

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

  // ---------------------------------------------------------------------------
  // composer — 원래 화면의 말투(`~한다`)를 그대로 뒀다. 단정을 바꾼 곳은 없다.
  //
  // **번역하지 않은 것**은 `en.ts` 의 composer 머리말에 적었다 — 서버가 준 실패 사유,
  // 호출자가 넘기는 placeholder, 기호(`@`·`📎`·`🕐`·`×`).
  // ---------------------------------------------------------------------------

  'composer.attach.drop': '여기에 놓으면 첨부된다',
  'composer.attach.uploadFailed': '{filename} 을 올리지 못했다 (크기 제한을 넘었을 수 있다)',

  'composer.mention.autoBadge': '자동',
  'composer.mention.autoTitle': '이 채널이 자동으로 멘션한다',
  // 원래 화면 그대로 `(채널 전체)` 다. 영어가 `(everyone here)` 로 **사람들**을 세는 쪽으로
  // 옮긴 이유는 `en.ts` 표에 있고, 한국어는 원래 문구가 이미 그 뜻으로 읽힌다.
  'composer.mention.channelAll': '(채널 전체)',
  // **`명` 을 뺐다.** 그 단위는 사람만 세는 말인데 집합에는 에이전트도 든다 — 영어가
  // 숫자만 남긴 것과 같은 판단이고, 원래 문구의 부정확을 여기서 함께 고친다.
  'composer.mention.groupCount': '({count})',
  'composer.mention.reaching': '부를 상대',
  'composer.mention.reachingLabel': '부를 상대',

  /**
   * 퍼머링크를 붙여넣었을 때 서는 줄. 붙여넣은 글자는 초안에 그대로 있고, 이 줄은
   * **이동할 수 있다**고만 말한다 — 이동은 옆 버튼을 누를 때만 일어난다.
   */
  // 붙여넣기가 부르는 이름(2단계) — 근거는 `en.ts` 의 같은 묶음에 있다.
  'composer.paste.calls': '붙여넣은 글이 {handles} 를 부른다',
  'composer.paste.quote': '인용으로 바꾸기',
  'composer.paste.keep': '그대로 두기',
  'composer.paste.confirmTitle': '{count}명을 부를까?',
  'composer.paste.confirmDetail': '이 메시지는 {handles} 를 부른다. 부른 수만큼 턴이 따로 뜬다.',
  'composer.paste.confirmSend': '보내기',
  'composer.paste.confirmCancel': '더 고치기',
  'composer.paste.long': '{chars}자 — 그대로 보내면 대화가 밀린다',
  'composer.paste.asFile': '파일로 첨부',
  'composer.paste.moving': '첨부하는 중…',
  'composer.link.pasted': '메시지 링크를 붙여넣었다',
  'composer.link.open': '그 메시지로 이동',

  'composer.schedule.cancel': '취소',
  'composer.schedule.cancelOne': '예약 취소',
  'composer.schedule.cancelFailed': '예약을 취소하지 못했다',
  'composer.schedule.hasAttachments': '첨부가 붙은 메시지는 예약할 수 없다 — 첨부를 떼거나 지금 보내라',
  'composer.schedule.failed': '예약에 실패했다',
  'composer.schedule.notSent': '보내지 못함: {reason}',
  'composer.schedule.listFailed': '예약 목록을 불러오지 못했다',
  'composer.schedule.later': '나중에 보내기',
  'composer.schedule.submit': '예약',
  'composer.schedule.submitting': '예약 중…',
  'composer.schedule.summary': '예약 {count}건',
  'composer.schedule.summaryFailed': ' · 실패 {count}건',
  'composer.schedule.timeLabel': '예약 시각',
  'composer.schedule.title': '예약 발송',

  // 수에 따라 명사가 안 바뀐다 — `other` 하나가 이 언어의 사실이다(위 머리말).
  'composer.send.attachmentsOnly': { other: '첨부 {count}개' },
  'composer.send.failed': '메시지가 나가지 않았다 — 연결을 확인하고 다시 보내라',
  'composer.send.tooLong': '{over}자 넘었다 — 상한은 {max}자다',
  'composer.send.over': '{over}자 넘음',
  'composer.send.remaining': '{remaining}자 남음',
  'composer.send.sending': '보내는 중…',
  'composer.send.submit': '전송',
  'composer.send.undo': '보냄 취소',

  // ---------------------------------------------------------------------------
  // grid — 에이전트 격자. 영역을 `agents` 에 안 붙인 근거는 `en.ts` 의 grid 머리말에 있다
  // (이 컴포넌트는 설정과 사이드바 **둘이 공유한다**).
  // ---------------------------------------------------------------------------

  'grid.card.harness': '하네스',
  'grid.card.harnessDefault': '하네스 기본값',
  'grid.card.lastTurn': '활동',
  'grid.card.runner': '러너',
  'grid.card.retiring': '물러나는 중 · 진행 중인 턴을 끝내고 있다',
  'grid.card.stopping': '멈추는 중 · 러너가 아직 못 봤다',

  'grid.runner.harnessMissing': '하네스를 찾을 수 없다',
  'grid.runner.launchFailed': '기동 실패',
  'grid.runner.launchFailedReason': '기동 실패 — {reason}',
  'grid.runner.presenceUnknown': {
    other: '서버와 끊겨 {count}개 에이전트의 생사를 알 수 없다 — 마지막으로 본 상태이지 '
      + '지금 상태가 아니다. 다시 붙으면 갱신된다.',
  },

  'grid.search.create': '새 에이전트',
  'grid.search.empty': '아직 에이전트가 없다',
  'grid.search.label': '에이전트 검색',
  'grid.search.noMatch': '“{query}” 에 맞는 에이전트가 없다',
  'grid.search.placeholder': '이름으로 찾기',
  // 한국어는 단위를 붙인다 — 영어가 숫자만 세우는 이유는 `en.ts` 의 그 키 주석에 있다.
  'grid.search.count': '{count}개',

  'grid.version.current': '{version}',
  'grid.version.restarting': '재기동 중…',
  'grid.version.stale': '{version} · 뒤처짐',
  'grid.version.staleAction': '{handle} 러너 재기동 — {version} 은 앱보다 뒤처졌다',
  'grid.version.unknown': '버전 모름',

  'grid.card.relaunch': '{handle} 실행하기',
  'grid.card.relaunchFailed': '{handle} 다시 띄우기',
  'grid.card.stop': '{handle} 멈추기',

  // ---------------------------------------------------------------------------
  // presence — 세 자리(사이드바·디렉터리·격자)가 같은 말을 쓴다. 표는 남기고 값만
  // 키로 바꿨다 — 근거는 `en.ts` 의 이 영역 머리말에.
  // ---------------------------------------------------------------------------

  'presence.offline': '오프라인',
  'presence.online': '온라인',
  /** **"오프라인"이라고 쓰지 않는다** — 그것은 아는 척이다(`lib/presenceView.ts`). */
  'presence.unknown': '연결 끊김 — 알 수 없음',

  // ---------------------------------------------------------------------------
  // projection — 판정 이름이다(`lib/projectionBanner.ts`). 네 사정을 뭉개지 않는 것이
  // 이 영역의 전부이고, 그 표는 `en.ts` 머리말에 있다.
  //
  // **꺼짐(`unconfigured`)의 문구가 여기 없다** — `packages/shared` 의 상수라 이 사전이
  // 닿을 수 없다(그 머리말의 '안 넣은 것').
  // ---------------------------------------------------------------------------

  'projection.banner.stalled': '투영이 {ago}부터 멈춰 있다',
  /** 한 번도 못 폴링했다 — **모르는 것을 숫자로 꾸미지 않는다**. */
  'projection.banner.stalledUnknownSince': '투영이 언제부터인지 알 수 없지만 멈춰 있다',
  'projection.banner.unknown': '투영 상태를 확인하는 중…',
  'projection.banner.unreadable': '투영 상태를 읽지 못했다',

  'projection.banner.dismiss': '이 알림 닫기',
  'projection.banner.openSettings': '설정 열기',

  'projection.list.stalled': '투영이 {ago}부터 멈춰 이 목록은 지금 사실이 아닐 수 있다',
  'projection.list.stalledUnknownSince':
    '투영이 언제부터인지 알 수 없지만 멈춰 이 목록은 지금 사실이 아닐 수 있다',
  'projection.list.unknown': '투영 상태를 확인하는 중…',
  'projection.list.unconfigured': '투영이 꺼져 있어 이 목록은 채워지지 않는다',
  'projection.list.unreadable': '지금 상태를 못 읽어 이 목록을 믿을 수 없다',

  'projection.url.field': 'avcs 주소',
  'projection.url.hintFallback': '지우면 {url} 로 돌아간다',
  'projection.url.hintOff': '지우면 투영이 꺼진다',
  'projection.url.loadFailed': '투영 설정을 불러오지 못했다',
  'projection.url.loading': '투영 설정을 불러오는 중…',
  'projection.url.placeholder': 'http://avcs.example:4000',
  'projection.url.saveFailed': '투영 URL 을 저장하지 못했다',
  'projection.url.sourceNone': '아직 정해지지 않았다',
  'projection.url.sourceOf': '출처: {source}',
  'projection.url.sourceApp': '앱에서 설정',
  'projection.url.sourceEnv': '환경변수(AVCS_BASE_URL)',

  'projection.url.cancel': '취소',
  'projection.url.clear': '지우기',
  'projection.url.edit': '편집',
  'projection.url.save': '저장',

  // ---------------------------------------------------------------------------
  // runnerState — `RunnerStatus.tsx::runnerStatusLabel` 이 내는 **상태의 이름**이다.
  // 사유(`runner.*`)와 갈리는 근거, 그리고 모듈 상수를 함수로 내린 근거는 `en.ts`
  // 머리말에 있다.
  // ---------------------------------------------------------------------------

  /** `#431` 2단계가 `external` 을 없애고 넣은 이름이다 — 그 오독이 `#430` 이었다. */
  'runnerState.adopted': 'daemon 이 들고 있음',
  'runnerState.failed': '기동 실패',
  'runnerState.needsHarness': '종료 (78: 하네스를 찾을 수 없음 — 설치 필요)',
  'runnerState.needsLogin': '종료 (78: 하네스 로그인 만료 — 재로그인 필요)',
  'runnerState.needsReissue': '종료 (78: 자격증명 폐기 — 재발급 필요)',
  /** 괄호가 요점이다 — SIGTERM 은 graceful 이라 그 시차가 분 단위다. */
  'runnerState.restarting': '재기동 대기 (진행 중인 턴을 마치는 중)',
  'runnerState.running': '실행 중',
  /** **정상이다** — 코드 0 이나 신호로 곱게 죽었다. 아래와 갈려야 한다. */
  'runnerState.stopped': '꺼짐',
  'runnerState.stoppedWithCode': '종료 (기타: 코드 {code})',

  // ---------------------------------------------------------------------------
  // terminal — `components/TerminalPanel.tsx` 와 그 패널을 여는 `TerminalChip.tsx`.
  // 못 치는 이유 넷을 뭉개지 않는 것이 이 영역의 요점이고, 그 표는 `en.ts` 머리말에.
  // ---------------------------------------------------------------------------

  /**
   * **여는 문이다**(2026-09-09). 앞 문구는 "진행 중인 터미널을 본다"였고 그때는 참이었다 —
   * 턴이 없으면 패널이 「진행 중인 턴이 없다」에서 멈췄다. 지금은 없으면 스스로 띄우므로,
   * "진행 중"을 남겨 두면 칩이 하는 일의 절반만 말한다.
   */
  'terminal.chip.open': '@{handle} 의 터미널을 연다 — 진행 중인 턴이 있으면 그 화면에 붙는다',
  'terminal.chip.label': '터미널 보기',
  /** `#384` 의 정직성 전부 — 그 침묵을 이 줄이 메운다. */

  /** 보이는 글자. 접근 이름은 아래가 따로 진다 — 짧음이 스크린리더에서 뜻을 잃는다. */
  'terminal.header.close': '닫기',
  'terminal.header.closeAction': '터미널 닫기',
  'terminal.header.resize': '터미널 너비 조절',
  'terminal.header.thread': '스레드',
  'terminal.header.title': '터미널',
  'terminal.header.panel': '에이전트 터미널',

  'terminal.session.noHost': '터미널을 붙일 자리가 없다',
  /** 「턴이 없다」 화면이 없어져(2026-09-09) 이제 **실패 뒤의 다시 열기**만 남았다. */
  'terminal.session.open': '터미널 열기',
  'terminal.session.openFailed': '터미널을 열지 못했다: {reason}',
  'terminal.session.checking': '세션을 확인하는 중…',
  /** 위와 **갈린다**: 저쪽은 서버의 목록을, 이쪽은 러너가 띄우는 PTY 를 기다린다. */
  'terminal.session.opening': '터미널을 여는 중…',

  /** `runnerState.running` 과 **다른 것을 센다** — 저쪽은 러너, 이쪽은 PTY 세션의 턴이다. */
  'terminal.state.running': '진행 중',
  'terminal.state.ended': '턴 종료',
  /** *"'끝났다'로 쓰지 않는다 — 다른 사실이다"* — 턴은 안 끝났고 소켓만 끊겼다. */
  'terminal.state.runnerOffline': '러너 연결 끊김',

  'terminal.writer.can': '입력 가능 — 마지막으로 연 창이 입력을 가진다.',
  /** **원인을 그대로 말한다** — "관찰 전용"만 적으면 임의의 제약으로 읽힌다. */
  'terminal.writer.observeOnly':
    '관찰 전용 — 진행 중인 멘션 턴은 프롬프트를 파일로 받으므로 이 터미널은 입력을 받을 수 없다. '
    + '직접 치려면 턴이 끝난 뒤 터미널을 열어라.',
  'terminal.writer.otherWriter': '읽기 전용 — 다른 창이 입력 중이다. 이 창에 치면 아무 데도 가지 않는다.',
  'terminal.writer.runnerOutdated': '읽기 전용 — 이 러너는 입력을 다룰 줄 모른다(구버전이거나 붙어 있지 않다).',
  /** 구 서버는 이유를 안 싣는다 — **원인을 지어내지 않는다**(`#368`). */
  'terminal.writer.unknown': '읽기 전용 — 이 창의 입력은 러너에 닿지 않는다.',

  // ---------------------------------------------------------------------------
  // inbox — 사슬 구획은 여기 없다(`waitChain.*` 이 진다, `en.ts` 머리말).
  // ---------------------------------------------------------------------------

  'inbox.drafts.badge': '초안',
  'inbox.drafts.empty': '쓰다 만 초안이 없다',
  'inbox.drafts.heading': '쓰다 만 초안',
  'inbox.drafts.headingCount': '쓰다 만 초안 ({count})',
  'inbox.drafts.thread': '스레드',

  'inbox.entries.empty': '나를 부른 것이 없다',
  'inbox.entries.heading': '나를 부른 것',
  'inbox.entries.headingCount': '나를 부른 것 ({count})',
  'inbox.entries.noMatch': '필터에 맞는 것이 없다',
  'inbox.entries.thread': '스레드',
  'inbox.entries.unread': '안 읽음',

  'inbox.filter.all': '전부',
  'inbox.filter.blocking': '나를 막는 것',
  'inbox.filter.unread': '안 읽은 것',
  'inbox.filter.reading': '읽을 것',

  'inbox.pane.close': '인박스 닫기',
  'inbox.pane.loadFailed': '인박스를 불러오지 못했다 — {reason}',
  'inbox.pane.loading': '불러오는 중…',
  'inbox.pane.retry': '다시 시도',
  // 머리글이 원래 `Inbox` 였다 — 영어가 원본이므로 그쪽은 그 글자를 지키고, 한국어는
  // 화면의 다른 말들과 같은 언어로 선다(`aria-label` 이 이미 `인박스` 였다).
  'inbox.pane.title': '인박스',

  // ---------------------------------------------------------------------------
  // profile — 사람과 에이전트가 같은 틀을 쓴다(그 화면 주석: 행 이름만 다르다).
  // ---------------------------------------------------------------------------

  'profile.actions.agentSettings': '에이전트 설정',
  'profile.actions.dm': 'DM 열기',
  'profile.actions.restartCancel': '재기동 예약 취소',
  'profile.actions.restartStale': '새 버전으로 재기동',
  'profile.actions.restart': '러너 재기동',

  'profile.rows.harness': '하네스',
  'profile.rows.kind': '종류',
  'profile.rows.kindAgent': '에이전트',
  'profile.rows.kindHuman': '사람',
  'profile.rows.lastTurn': '마지막 활동',
  'profile.rows.model': '모델',
  'profile.rows.modelDefault': '하네스 기본값 — 실제 모델은 발화 이름줄 hover 로 본다',
  'profile.rows.owner': '소유자',
  'profile.rows.permission': '권한',
  // 원래 행 이름은 `연결` 이었다. 영어가 `Presence` 로 간 이유(`Connection` 은 소켓
  // 상태로 읽힌다)가 한국어에도 그대로 걸려 `생존` 으로 옮긴다 — 이 행이 답하는 것은
  // 소켓이 아니라 **그 에이전트가 지금 답하는가**이고, 코드가 그것을 `live` 라 부른다.
  'profile.rows.presence': '생존',
  'profile.rows.presenceNotResponding': '응답 없음',
  'profile.rows.presenceOnline': '온라인',
  'profile.rows.presenceUnknown': '알 수 없음',
  'profile.rows.runnerVersion': '러너 버전',
  'profile.rows.runnerVersionWithApp': '{version} (앱 {appVersion})',
  'profile.rows.runnerVersionUnknown': '버전을 모른다 — 재기동하면 채워진다',
  'profile.rows.state': '상태',
  'profile.rows.stateDisabled': '비활성',
  'profile.rows.title': '{handle} 프로필',
  'profile.rows.workingDir': '작업 디렉터리',
  'profile.rows.workingDirPerThread': '스레드마다 새로 만든다',

  'profile.runner.restartQueued':
    '재기동을 예약했다 — {strongTurn}을 마치면 새 버전으로 뜬다. 턴을 끊지 않는다.',
  'profile.runner.restartQueuedTurn': '진행 중인 턴',
  'profile.runner.stale':
    '이 러너는 {strongBundle}로 돌고 있다 — 새 버전으로 재기동하면 갈아탄다.',
  'profile.runner.staleBundle': '앱보다 뒤처진 번들',
  // message — **키 순서는 `en.ts` 와 같다**. 이 화면의 말투는 `~다` 로 끝나는 서술이고
  // (대화 옆에 앉는 곁정보라 명령이 아니다) 원래 화면이 그렇게 쓰고 있었다.
  // ---------------------------------------------------------------------------

  'message.channelEcho': '채널에도 전송됨',
  'message.deleted': '채팅이 삭제되었습니다',
  'message.threadOrigin': '스레드에 댓글 남김',
  'message.recentReplies': '최근 댓글 보기',
  'message.replyInThread': '스레드에 답글 달기',
  // 연쇄 깊이 상한에 막힌 호출(4단계) — 근거는 `en.ts` 의 같은 자리에 있다.
  'message.chainCapped': '{handles} 를 부르지 않았다 — 멘션 연쇄가 깊이 상한({limit})에 닿았다. 이어 가려면 사람이 한 줄 쓰면 된다.',
  'message.openSkillApproval': '스킬 승인 화면 열기',

  'message.authorLabel': '작성자 {name}',

  // `→ 나` 는 **원래 화면 그대로다**. 한국어는 화면이 사람을 `나` 로 부르는 것이
  // 자연스럽고(영어는 `you` 가 자연스럽다), 그 차이가 이 두 줄이 낱말 대치가 아닌 자리다.
  'message.audience.me': '→ 나',
  'message.audience.person': '→ 사람',
  'message.audience.agent': '→ {name}',
  'message.audience.unknownAgent': '다른 에이전트',

  'message.model.tooltip': '모델 {id}',
  'message.model.mismatchTooltip': '설정된 모델과 다른 계열이다 — 이 말은 {id} 로 했다',
  'message.model.mismatchLabel': '설정된 모델과 다르다: {id}',

  'message.attachment.previewFailed': '(미리보기 실패)',
  'message.attachment.loadFailed': '(불러오기 실패)',
  'message.attachment.zoom': '크게 보기: {filename}',
  'message.attachment.closeZoom': '확대 보기 닫기',
  'message.attachment.save': '저장',

  'message.notified.group': '집합',
  'message.notified.team': '팀',
  'message.notified.mixed': '부른 명단',
  'message.notified.counts': '{called}명을 불렀는데 {woke}명만 깼다',
  'message.notified.reasonGroup': '— 남은 사람은 이 채널을 볼 수 없다. 채널 멤버로 넣어야 부름이 닿는다.',
  'message.notified.reasonTeam': '— 남은 팀원은 비활성이거나 이 채널을 볼 수 없다. 팀 설정과 채널 멤버를 보라.',
  'message.notified.reasonMixed': '— 남은 상대에게 부름이 닿지 않았다.',

  // 접근 라벨의 네 틀. 영어와 **같은 순서**(상태 → 수 → 마지막)로 둔다 — 화면이 그
  // 순서로 그리므로 눈으로 읽는 것과 귀로 듣는 것이 어긋나면 안 된다.
  'message.summary.label': '{count}',
  'message.summary.labelWithState': '{state}, {count}',
  'message.summary.labelWithTime': '{count}, 마지막 답글 {time}',
  'message.summary.labelWithStateAndTime': '{state}, {count}, 마지막 답글 {time}',
  // 수에 따라 명사가 안 바뀐다 — `other` 하나인 것이 이 언어의 사실이다.
  'message.summary.replies': { other: '답글 {count}개' },

  'message.typing.names': '{names} 입력 중…',
  'message.typing.count': { other: '{count}명이 입력 중…' },

  // ---------------------------------------------------------------------------
  // speech — **키 순서는 `en.ts` 와 같다**.
  //
  // 이 다섯 컴포넌트의 말투는 **에이전트가 하는 말**이라 반말 서술이다(`끝내지 못했다`).
  // 그것이 원래 화면의 말투이고, 정본 문서가 여덟 가지 말을 "말"이라 부르는 이유다 —
  // 라벨이 아니라 발화라서, `~합니다` 로 올리면 카드가 폼처럼 읽힌다.
  // ---------------------------------------------------------------------------

  'speech.ask.pickOne': '골라 줘',
  // 조사 표기를 쓴다 — handle 은 영문도 한글도 온다(`codex 가` · `민수가`).
  'speech.ask.agentPicks': '{name:이가} 고른다',
  'speech.ask.personPicks': '사람이 고른다',
  'speech.ask.decided': '정해졌다',
  'speech.ask.answeredBy': '{name:이가} 골랐다',
  'speech.ask.unknownAgent': '다른 에이전트',

  'speech.failure.title': '끝내지 못했다',
  'speech.failure.callAgain': '다시 부르기',
  'speech.failure.retryDraft': '@{handle} 다시 해 줘',

  'speech.progress.working': '작업 중',
  'speech.progress.worked': '작업',
  'speech.progress.expand': { other: '{count}줄 펼치기' },
  'speech.progress.collapse': '접기',

  'speech.report.checks': '확인한 것',
  'speech.report.files': '바뀐 파일',
  'speech.report.remaining': '남은 것',

  'speech.exchange.decided': '정했다',
  'speech.exchange.finished': '끝냈다',
  'speech.exchange.undecided': '아직 정해진 것 없음',
  'speech.exchange.count': { other: '{count}번 주고받음' },
  'speech.exchange.last': '마지막 {time}',
  'speech.exchange.collapse': '접기',

  // ---------------------------------------------------------------------------
  // thread — **키 순서는 `en.ts` 와 같다**. 다섯이 한 사다리이고, 원래 화면의 낱말을
  // 그대로 둔다 — 갤러리 회귀선(`gallery.test.tsx`)이 이 다섯을 한국어로 재고 있다.
  // ---------------------------------------------------------------------------

  'thread.state.myTurn': '내 차례',
  'thread.state.stuck': '막힘',
  'thread.state.waiting': '남을 기다림',
  'thread.state.running': '도는 중',
  'thread.state.done': '끝남',

  // ---------------------------------------------------------------------------
  // inbox — **키 순서는 `en.ts` 와 같다**. 여섯이 서로 달라야 한다는 것이 이 판정의
  // 존재 이유이고(*"네 줄이 글자 하나까지 똑같다"*), 원래 화면의 낱말이 이미 그렇다.
  // ---------------------------------------------------------------------------

  'inbox.label.ask': '골라 줘',
  'inbox.label.askOther': '고르는 중',
  'inbox.label.failure': '막혔다',
  'inbox.label.report': '끝냈다',
  'inbox.label.mention': '불렀다',
  'inbox.label.reply': '답글',

  // ---------------------------------------------------------------------------
  // channel — **원래 화면 문구를 그대로 옮겼다.** 단정을 바꾼 곳은 없다.
  //
  // 세 자리만 갈렸고 셋 다 **원래 화면에 없던 접근 이름**이라 새로 지은 것이다:
  // `channel.doc.close`·`channel.files.close`·`channel.header.searchLabel` 은 원래
  // `aria-label` 이 있었으므로 그 값을 그대로 뒀고, `channel.doc.editLabel` 도 같다.
  // ---------------------------------------------------------------------------

  'channel.doc.cancel': '취소',
  'channel.doc.close': '닫기',
  'channel.doc.conflict':
    '다른 사람이 먼저 고쳤다. 아래 현재 내용을 확인하고 다시 저장하면 내 편집으로 덮어쓴다.',
  'channel.doc.edit': '편집',
  'channel.doc.editLabel': '문서 편집',
  'channel.doc.empty': '(빈 문서)',
  'channel.doc.heading': '문서',
  'channel.doc.noneYet': '아직 문서가 없다',
  'channel.doc.loadFailed': '문서를 불러오지 못했다: {reason}',
  'channel.doc.loading': '불러오는 중…',
  'channel.doc.placeholder': '이 채널의 전제를 적어 둔다',
  'channel.doc.save': '저장',
  'channel.doc.saveFailed': '저장하지 못했다',
  'channel.doc.saving': '저장 중…',
  'channel.doc.unknownAuthor': '알 수 없는 사람',
  'channel.doc.unknownError': '알 수 없는 오류',
  'channel.doc.theirs': '서버의 현재 내용',

  'channel.empty.noMessages': '아직 메시지가 없다',
  'channel.empty.noMessagesIn': '#{name} 에 아직 메시지가 없다',
  'channel.empty.tipMention': '@{handle} 처럼 에이전트를 멘션하면 그 에이전트의 inbox 로 들어간다.',
  'channel.empty.tipTopic':
    "사이드바에서 이 채널의 ⋯ 메뉴를 열고 '채널 편집'으로 topic 을 정할 수 있다.",

  'channel.files.close': '파일 목록 닫기',
  'channel.files.empty': '아직 오간 파일이 없다',
  'channel.files.heading': '파일',
  'channel.files.label': '채널 파일',
  'channel.files.loadFailed': '파일 목록을 불러오지 못했다: {reason}',
  'channel.files.loading': '불러오는 중…',
  'channel.files.more': '더 오래된 파일',
  'channel.files.retry': '다시 시도',
  'channel.files.unknownError': '알 수 없는 오류',

  'channel.header.archived': '보관됨',
  'channel.header.doc': '문서',
  'channel.header.files': '파일',
  'channel.header.search': '검색',
  'channel.header.searchLabel': '이 채널에서 찾기',
  'channel.header.searchTitle': '이 채널에서 찾기 (⌘K 는 전체 검색)',

  'channel.pane.archived': '보관된 채널이다',
  'channel.pane.jumpToBottom': '아래로 내려가기',
  'channel.pane.runnerFailureAgent': '에이전트',
  /** 조사가 `{handle}` 의 받침을 따른다 — `codex 는` 과 `forge 는` 이 갈리지 않게. */
  'channel.pane.runnerFailureLine': '@{handle:은는} 지금 응답하지 않는다',

  // ---------------------------------------------------------------------------
  // channelDirectory — **원래 문구 그대로다.** `표준 채널이 없다` 만 `채널이 없다` 로
  // 줄였다: `standard` 는 내부 구분이고, 그 낱말이 화면에 서면 사람은 「표준이 아닌
  // 채널」이 어딘가 따로 있다고 읽는다(실제로 그것은 DM 이고 이 목록의 물음이 아니다).
  // ---------------------------------------------------------------------------

  'channelDirectory.archived': '보관됨 ({count})',
  'channelDirectory.close': '채널 디렉터리 닫기',
  'channelDirectory.empty': '채널이 없다',
  'channelDirectory.heading': '채널 찾기',
  'channelDirectory.label': '채널 디렉터리',
  'channelDirectory.noMatch': '검색 결과가 없다',
  'channelDirectory.private': '비공개 채널',
  'channelDirectory.search': '채널 이름으로 검색',
  'channelDirectory.searchPlaceholder': '채널 이름',
  'channelDirectory.sortAge': '생성순',
  'channelDirectory.sortName': '이름순',

  // ---------------------------------------------------------------------------
  // search — **어투를 `~다` 로 맞췄다.** 이 화면만 `검색 결과가 없습니다` 였다
  // (`profileName`·`invite` 와 같은 이유 — `en.ts` 머리말). 뜻은 그대로다.
  //
  // `검색 실패` 도 갈렸다: 그것은 낱말이지 문장이 아니어서 **무엇이 지금 참인지**를
  // 안 말한다. 이 저장소의 오류 규율(`~하지 못했다`)로 돌린다.
  // ---------------------------------------------------------------------------

  'search.palette.empty': '맞는 메시지가 없다',
  'search.palette.failed': '검색하지 못했다',
  'search.palette.hintClose': 'Esc 닫기',
  'search.palette.hintOpen': 'Enter 열기',
  'search.palette.hintMove': '↑↓ 이동',
  'search.palette.input': '검색어 입력',
  'search.palette.label': '메시지 검색',
  'search.palette.loading': '검색 중…',
  'search.palette.more': '결과 더 보기',
  'search.palette.placeholderAll': '전체에서 찾기',
  'search.palette.placeholderThread': '이 스레드에서 찾기',
  'search.palette.placeholderScoped': '이 채널에서 찾기 ({name})',
  'search.palette.results': '검색 결과',
  'search.palette.scopeAll': '전체',
  'search.palette.scopeGroup': '검색 범위',
  'search.palette.scopeLabel': '이 채널 ({name})',
  'search.palette.scopeThread': '이 스레드',
  'search.palette.thread': '스레드',
  'search.palette.unnamedChannel': '이름 없는 채널',

  // ---------------------------------------------------------------------------
  // directory — **원래 문구 그대로다.** `{label}` 은 `People`·`Agents` 라 안 옮긴다 —
  // 그 값이 `section()` 의 `aria-label` 이기도 해서, 옮기면 구획 이름이 함께 갈린다.
  // ---------------------------------------------------------------------------

  'directory.close': '디렉터리 닫기',
  'directory.disabled': '비활성',
  'directory.empty': '이 워크스페이스에 아직 계정이 없다',
  'directory.label': '디렉터리',
  'directory.listFailed': '계정 목록을 불러오지 못했다 — {reason}',
  'directory.loading': '불러오는 중…',
  'directory.sectionNoMatch': '{label} 중 맞는 것이 없다',
  'directory.retry': '다시 시도',
  'directory.search': '디렉터리 검색',
  'directory.searchPlaceholder': 'handle 또는 이름으로 검색',

  // ---------------------------------------------------------------------------
  // saved — **원래 문구 그대로다.** 접근 이름 하나만 갈렸다: `할 것으로 되돌리기` 는
  // 그대로 두되 영어가 `Put back on the list` 인 이유가 `en.ts` 표에 있다.
  // ---------------------------------------------------------------------------

  'saved.close': '패널 닫기',
  'saved.deleted': '삭제된 메시지',
  'saved.emptyDone': '완료된 메시지가 없다',
  'saved.emptyOpen': '저장된 메시지가 없다',
  'saved.label': '저장된 메시지',
  'saved.listFailed': '불러오지 못했다 — {reason}',
  'saved.loading': '불러오는 중…',
  'saved.markDone': '완료로 표시',
  'saved.markOpen': '할 것으로 되돌리기',
  'saved.retry': '다시 시도',
  'saved.tabDone': '완료',
  'saved.tabOpen': '할 것',

  // ---------------------------------------------------------------------------
  // status — **원래 문구 그대로다.** 값 셋(`available`·`away`·`dnd`)은 안 옮긴다
  // (`en.ts` 머리말) — 여기 오는 것은 그 값에 씌우는 이름뿐이다.
  // ---------------------------------------------------------------------------

  'status.mark.withText': '{label}: {text}',
  'status.picker.clear': '문구 지우기',
  'status.picker.close': '닫기',
  'status.picker.failed': '상태를 바꾸지 못했다',
  'status.picker.notePlaceholder': '짧은 문구 (최대 80자)',
  'status.picker.noteLabel': '상태 문구',
  'status.picker.save': '저장',
  'status.value.available': '대화 가능',
  'status.value.away': '자리 비움',
  'status.value.dnd': '방해 금지',

  // ---------------------------------------------------------------------------
  // rail — **원래 문구 그대로다.** 칸 이름 넷은 안 옮긴다(`en.ts` 머리말: 폭을 재어 고른
  // 값이라 언어마다 길이가 갈리면 그 계산이 무너진다).
  //
  // `{count}` 자리에 `개` 를 그대로 둔다 — 원래 화면이 그렇게 세고 있었고, 이 수가 세는
  // 것은 사람이 아니라 **항목**이라 그 단위가 맞는다(`composer.mention.groupCount` 가
  // `명` 을 버린 것과 갈리는 지점이 그것이다).
  // ---------------------------------------------------------------------------

  'rail.community.label': '커뮤니티 전환',
  'rail.community.connected': '연결됨',
  'rail.community.disconnected': '연결 끊김',
  'rail.community.tile': '{name} — {state}',
  'rail.me.menu': '내 계정 메뉴',
  'rail.me.menuFor': '{handle} — 내 계정 메뉴',
  'rail.me.profile': '내 프로필',
  'rail.me.status': '상태 바꾸기',
  'rail.nav.label': '주 목록',
  'rail.cell.withCount': '{name} — {count}',
  'rail.cell.blocking': '나를 기다리는 것 {count}개',
  'rail.cell.saved': '담아 둔 메시지 {count}개',

  // ---------------------------------------------------------------------------
  // workspace — **`앞로 (Cmd+])` 의 오타를 고쳤다**(`앞으로` 여야 한다). 옮기면서
  // 발견했고, 뜻이 아니라 글자가 틀린 것이라 그대로 둘 이유가 없다.
  // ---------------------------------------------------------------------------

  'workspace.back': '뒤로',
  'workspace.backTitle': '뒤로 (Cmd+[)',
  'workspace.forward': '앞으로',
  'workspace.forwardTitle': '앞으로 (Cmd+])',
  'workspace.showSidebar': '사이드바 펼치기',
  'workspace.sweep': '미읽음 훑기',
  'workspace.sweepTitle': '미읽음을 하나씩 훑는다',

  // ---------------------------------------------------------------------------
  // identity — **`{n}명` 이 `{count}` 로 바뀐 자리다**(`en.ts` 표). 집합에도 팀에도
  // 에이전트가 드는데 `명` 은 사람 세는 단위라, 원래 문구가 이미 부정확했다.
  // 괄호도 없앴다 — 배지 안의 수가 무엇인지는 옆의 글리프와 `sr-only` 이름이 말한다.
  // ---------------------------------------------------------------------------

  'identity.account.unknown': '알 수 없는 계정',
  'identity.badge.count': '{count}',
  'identity.badge.group': '집합',
  'identity.badge.team': '팀',

  // ---------------------------------------------------------------------------
  // invite — **어투를 `~다` 로 맞췄다**(`profileName` 과 같은 이유, `en.ts` 머리말).
  // 뜻은 한 글자도 안 바꿨다: 세 사실(한 번만 보인다 · 소진된다 · 지금 복사하라)이
  // 그대로 있고, 어미만 `~습니다`·`~세요` 에서 `~다` 로 왔다.
  // ---------------------------------------------------------------------------

  'invite.busy': '발급 중…',
  'invite.create': '초대 토큰 발급',
  'invite.createAgain': '새 토큰 발급 (앞 토큰은 화면에서 사라진다)',
  'invite.failed': '초대 토큰을 발급하지 못했다',
  'invite.notAdmin': '이 화면은 admin 만 볼 수 있다',
  'invite.note':
    '초대 토큰을 만들어 다른 사람을 이 워크스페이스로 부를 수 있다. 토큰은 발급 직후 한 번만 '
    + '보이고 다시 볼 수 없다. 한 번 쓰면 소진된다.',
  'invite.tokenNextStep': '받는 사람이 가입할 때 이 토큰이 필요하다. 지금 복사해 둔다.',
  'invite.tokenWarning': '이 토큰은 지금만 보인다 — 창을 벗어나면 다시 볼 수 없다',

  // ---------------------------------------------------------------------------
  // boot — **원래 문구 그대로다.** 부팅 시점에도 언어를 안다는 실측은 `en.ts` 머리말에.
  // ---------------------------------------------------------------------------

  'boot.keychain.title': 'OS 키체인의 승인을 기다리는 중',
  'boot.keychain.hint':
    '시스템 승인 대화상자가 떠 있는지 확인하라 — 다른 창 뒤에 가려져 있을 수 있다. '
    + '승인하면 곧바로 이어진다.',
} satisfies Catalog;
