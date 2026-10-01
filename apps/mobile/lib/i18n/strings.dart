/// 화면에 나가는 **모든 문자열의 목록**. 계획서 §7-2 의 결정을 코드로 세운 자리다.
///
/// ## 왜 abstract class 인가 — 빠진 키를 시험이 아니라 **컴파일러**가 잡게
///
/// 문구를 `Map<String, String>` 으로 두면 키 하나를 빠뜨려도 빌드가 통과하고, 그 화면을
/// 실제로 열어 본 사람이 처음 발견한다. getter 로 두면 `class Ko implements Strings` 가
/// **하나라도 빠진 순간 컴파일되지 않는다.** 데스크탑의 `i18n/types.ts` 가 하는 일과 같고,
/// 여기서는 그것이 타입이 아니라 상속으로 선다.
///
/// ## `en` 이 원본이다
///
/// 저장소 관례다 — 주석은 한국어, UI 문자열은 영어([en.dart] 가 원본). 뒤집으면 같은 문구가
/// 저장소 안에서 두 언어를 원본으로 갖는다.
///
/// ## 새 문구를 더할 때
///
/// 1. 여기에 getter 를 더한다.
/// 2. `en.dart` 와 `ko.dart` **둘 다** 채운다 — 컴파일러가 강제한다.
/// 3. 값이 비어 있지 않은지는 `test/i18n_test.dart` 가 본다. 빈 문자열은 컴파일을 통과한다.
abstract class Strings {
  /// 이 묶음의 언어 코드(`en`·`ko`). 시험과 언어 전환이 읽는다.
  String get localeCode;

  /// 앱 이름. **번역하지 않는다** — 고유명사다([i18nAllowSameAsEnglish] 참고).
  String get appName;

  // ── 연결 화면 ────────────────────────────────────────────────────────
  /// 서버 주소를 받는 화면의 제목.
  String get connectTitle;

  /// 주소 입력칸의 라벨.
  String get connectServerUrlLabel;

  /// 주소 입력칸이 비었을 때 자리에 뜨는 예시.
  String get connectServerUrlHint;

  /// 다음으로 넘어가는 버튼.
  String get connectContinue;

  /// 주소를 아예 안 적었다.
  String get connectErrorEmpty;

  /// 주소의 모양이 아니다(예: 공백, 스킴 없음).
  String get connectErrorMalformed;

  /// **평문 `http://` 주소를 막는다.** 계획서 §4 — iOS 의 ATS 는 평문 연결을 차단하면서
  /// 사유 없는 "연결 실패" 만 돌려준다. 그래서 앱이 저장하기 **전에** 먼저 말한다.
  String get connectErrorInsecure;

  // ── 공통 ─────────────────────────────────────────────────────────────
  /// 무언가를 기다리는 동안.
  String get commonLoading;

  /// 되돌아가기.
  String get commonBack;

  /// 다시 해 보기.
  String get commonRetry;

  // ── P2 ───────────────────────────────────────────────────────────────
  /// 파일 고르기 버튼의 접근성 이름.
  String get attachmentAdd;

  /// 올리기 실패. **조용히 지나가지 않는다** — 칩이 사라진 이유를 사람이 알아야 한다.
  String get attachmentUploadFailed;

  /// 링크 확인 시트의 머리.
  String get linkConfirmTitle;

  /// 링크 확인: 열기.
  String get linkConfirmOpen;

  /// 링크 확인: 취소.
  String get linkConfirmCancel;

  /// userinfo 가 붙은 주소 경고.
  String get linkUserInfoWarning;

  /// 호스트에 비ASCII 글자 경고.
  String get linkNonAsciiWarning;

  /// 못 읽음: 서버가 실패로 답했다.
  String get loadFailedServer;

  /// 못 읽음: 볼 권한이 없다.
  String get loadFailedForbidden;
  /// 날짜 줄: 오늘.
  String get dayToday;

  /// 날짜 줄: 어제.
  String get dayYesterday;

  /// 날짜 줄: 그 밖의 날. {m}·{d} 가 월·일.
  String get dayDate;

  /// 멘션 거절 줄(데스크탑 message.mentionDenied 와 같은 말). {handles} 가 @이름들.
  String get mentionDeniedLine;

  /// 읽지 못한 것.
  String get loadFailedHint;

  /// 채널 메시지를 못 읽음.
  String get messagesLoadFailed;

  /// 스레드 답글을 못 읽음.
  String get threadLoadFailed;

  /// 인박스를 못 읽음.
  String get inboxLoadFailed;

  /// 빈 채널에서 할 일.
  String get messagesEmptyHint;

  /// 빈 인박스의 뜻.
  String get inboxEmptyHint;

  /// 부팅 때 서버에 못 닿음.
  String get bootUnreachableTitle;

  /// 끊김 띠.
  String get connectionLostBand;

  /// 끊김 띠의 지금 다시 붙기.
  String get connectionRetryNow;

  /// 자격증명이 죽었을 때.
  String get connectionSignInAgain;

  /// 보내기 실패 줄의 머리.
  String get sendFailed;

  /// 다시 보내는 중.
  String get sending;

  /// 못 보낸 말을 다시 보내기.
  String get resend;

  /// 못 보낸 말을 버리기.
  String get discard;

  /// 첨부가 올라가는 동안 잠긴 보내기.
  String get sendWaitsForUpload;

  /// ask 답 실패 토스트.
  String get askFailed;

  /// 리액션 실패 토스트.
  String get reactionFailed;

  /// 1분 미만. 숫자를 쓰지 않는다 — 그 정밀도는 쓸모가 없다.
  String get timeUnderMinute;

  /// 분. `{n}` 이 수로 바뀐다.
  String get timeMinutes;

  /// 시간.
  String get timeHours;

  /// 일.
  String get timeDays;

  /// 아직 도는 중. `{duration}` 이 길이로 바뀐다.
  String get timeRunning;

  /// 끝났다.
  String get timeTook;

  /// 지난 일.
  String get timeAgo;

  /// 방금.
  String get timeJustNow;

  /// 아직 오지 않은 것.
  String get timeIn;

  /// 곧. 시각이 이미 지났을 때 — `0분 뒤` 는 틀린 말이 아니라 쓸모없는 말이다.
  String get timeSoon;

  /// 진행 줄의 머리말. 뒤에 마지막 진행 문구가 붙는다.
  String get agentWorking;

  /// 대기 줄의 머리말.
  String get agentWaiting;

  /// 완료 보고 카드 제목.
  String get reportTitle;

  /// 무엇을 확인했나.
  String get reportChecks;

  /// 바뀐 파일.
  String get reportFiles;

  /// 이 보고가 **닫지 못한 것**. 숨기면 끝난 것처럼 보인다.
  String get reportRemaining;

  /// 다음으로 할 일 후보.
  String get reportNext;

  /// 실패 카드 제목.
  String get failureTitle;

  /// 다시 해 보면 되는 실패.
  String get failureRetryable;

  /// 사람 손이 필요한 실패. `retryable` 을 모를 때도 이쪽이다 — 헛된 재시도를 권하지 않는다.
  String get failureNeedsHand;

  // ── P1 ───────────────────────────────────────────────────────────────
  /// 탭 이름 — 채널.
  String get tabChannels;

  /// 탭 이름 — 나를 부른 것들.
  String get tabInbox;

  /// 탭 이름 — 나와 연결.
  String get tabMe;

  /// 부른 사람이 없다.
  String get inboxEmpty;

  /// 전부 읽음으로.
  String get inboxMarkAllRead;

  /// 누가 나를 불렀다.
  String get inboxReasonMention;

  /// 내 스레드에 답이 달렸다.
  String get inboxReasonThreadReply;

  /// DM.
  String get inboxReasonDm;

  /// 내가 낸 물음에 답이 왔다.
  String get inboxReasonAskAnswered;

  /// 내가 낸 물음을 접었다.
  String get inboxReasonAskClosed;

  /// 모르는 사유. 줄을 **지우지 않는다** — 사유를 몰라도 보이는 편이 낫다.
  String get inboxReasonOther;

  /// 어느 계정으로 들어와 있나. `{handle}` 이 바뀐다.
  String get meSignedInAs;

  /// 첨부를 크게 보기.
  String get attachmentOpen;

  /// 첨부를 못 불러왔다. **조용히 빈칸을 두지 않는다.**
  String get attachmentFailed;

  /// 이미 고른 물음. 고른 것이 무엇인지는 옆에 그린다.
  String get askAnswered;

  /// 답하지 않기로 한 물음.
  String get askClosed;

  /// 답하지 않기 버튼. **고르기만 있으면** 그만두려는 사람에게 남는 수단이 메시지를 지우는 것뿐이다.
  String get askDecline;

  /// 나에게 온 물음. 강조해야 "내 차례"가 보인다.
  String get askToYou;

  /// 사람 아무나에게 온 물음.
  String get askToAnyone;

  /// 스레드 화면 제목.
  String get threadTitle;

  /// 스레드 작성칸.
  String get threadReplyHint;

  /// 답글이 없는 루트.
  String get threadRepliesZero;

  /// 답글 하나.
  String get threadRepliesOne;

  /// 답글 여럿. `{n}` 이 수로 바뀐다 — 문장을 화면에서 조립하지 않는다.
  String get threadRepliesMany;

  /// 접두에 맞는 사람이 없다.
  String get mentionPickerEmpty;

  /// 본문의 멘션이 가리키는 대상을 모른다(지워졌거나, 모바일이 이름표를 안 받는 팀·집합).
  String get mentionUnknown;

  // ── P0 ───────────────────────────────────────────────────────────────
  /// 로그인 화면 제목.
  String get loginTitle;

  /// 로그인 아이디 입력칸.
  String get loginIdLabel;

  /// 비밀번호 입력칸.
  String get loginPasswordLabel;

  /// 로그인 버튼.
  String get loginSubmit;

  /// 서버가 자격증명을 거절했다. **무엇이 틀렸는지 말하지 않는다** — 아이디가 있는지 없는지를 알려 주면 계정 목록을 훑을 수 있다.
  String get loginErrorRejected;

  /// 서버에 닿지 못했다. 자격증명 문제와 **갈라서** 말한다 — 사람이 할 일이 다르다.
  String get loginErrorUnreachable;

  /// 로그아웃.
  String get signOut;

  /// 채널 목록 화면 제목.
  String get channelsTitle;

  /// 들어가 있는 채널이 하나도 없다.
  String get channelsEmpty;

  /// 채널에 말이 하나도 없다.
  String get messagesEmpty;

  /// 작성칸의 자리 표시. **에이전트를 부르는 방법이 여기 적혀 있다** — 별도 버튼이 없으므로 화면이 말해 주지 않으면 알 길이 없다.
  String get composerHint;

  /// 보내기 버튼의 접근성 이름.
  String get composerSend;

  /// 고정 멘션 줄의 접근성 이름 — 이 작성칸이 다음 글에서도 저절로 부르는 상대들.
  String get stickyMentionsLabel;

  /// 고정 멘션 칩 × 의 설명. {handle} 은 `@forge` 꼴.
  String get stickyMentionRemove;

  /// 모델 지정(서버 079): "기본" 칩 — 이 에이전트의 설정 모델로 돈다.
  String get modelDefault;

  /// 모델 지정(서버 079): 스레드에 지정된 값임을 밝히는 꼬리.
  String get modelThreadSet;

  /// 모델 지정(087): **에이전트가** 정한 지정의 꼬리. {handle} 은 정한 에이전트(`@lead 지정`).
  String get modelAgentSet;

  /// 모델 지정(087): 정한 에이전트를 모를 때(지워졌거나 목록에 없음)의 꼬리.
  String get modelAgentSetUnknown;

  /// 모델 지정(서버 079): 지정이 하나도 없는 스레드의 접힌 칩.
  String get modelAllDefault;

  /// 모델 지정(서버 079): 빠른 줄의 마지막 칩 — 바텀시트를 연다.
  String get modelMore;

  /// 모델 지정(서버 079): effort 칸 이름.
  String get modelEffort;

  /// 모델 지정(서버 079): effort 를 비워 둘 때의 이름.
  String get modelEffortDefault;

  /// 모델 지정(서버 079): 에이전트 기본값을 밝히는 줄의 머리.
  String get modelAgentDefault;

  /// 모델 지정(서버 079): 에이전트 설정도 비었을 때.
  String get modelHarnessDefault;

  /// 모델 지정(서버 079): 비용 도움말(주간 한도·캐시·문맥).
  String get modelCostNote;

  /// 모델 지정(서버 079): 스레드 지정은 다음 턴부터다.
  String get modelNextTurn;

  /// 모델 지정(서버 079): 지정을 푼다.
  String get modelReset;

  /// 모델 지정(서버 079): 고른 값을 적용한다.
  String get modelApply;

  /// 모델 지정(서버 079): 목록 밖 이름을 직접 적는 칸.
  String get modelCustom;

  /// 모델 지정(서버 079): 하네스가 바뀐 지정.
  String get modelStale;

  /// 모델 지정(서버 079): 바텀시트 제목(스레드 칩). {handle} 자리에 @handle.
  String get modelSheetTitleThread;

  /// 모델 지정(서버 079): 바텀시트 제목(작성칸 칩).
  String get modelSheetTitleComposer;

  /// 모델 지정(서버 079): 빠른 줄 맨 앞 라벨.
  String get modelQuickLabel;

  /// 모델 지정(서버 079): 이어받은 스레드 지정을 푼다.
  String get modelClearThread;

  /// 모델 지정(서버 079): 무효 지정 안내. {harness} 는 지금 하네스.
  String get modelStaleDetail;

  /// 모델 지정(서버 079): 무효 지정을 다시 고른다.
  String get modelRepick;

  /// 소켓이 붙어 있다.
  String get connectionOnline;

  /// 처음 붙는 중.
  String get connectionConnecting;

  /// 끊겼지만 **기다리면 낫는** 부류다.
  String get connectionReconnecting;

  /// 기다려도 안 낫는다. 다시 로그인해야 한다.
  String get connectionDead;

  /// 키체인에 못 썼다. **두 가지를 다 말한다** — 지금은 쓸 수 있다는 것과, 앱을 다시 켜면 다시 로그인해야 한다는 것. 앞만 말하면 무엇이 걸린 일인지 모르고, 뒤를 빼면 다음 기동의 로그아웃이 이유 없는 로그아웃으로 남는다.
  String get noticeSessionNotSaved;

  /// 에이전트 계정임을 나타내는 짧은 표. 사람과 갈라 보여야 누구를 부르는지 안다.
  String get agentBadge;
}

/// **영어와 같아도 되는 키.** 고유명사처럼 번역이 존재하지 않는 것들이다.
///
/// 이 목록이 없으면 "ko 를 비워 두지 않는다"(§7-2)를 지키는 시험이 `appName` 에서
/// 무조건 빨개지고, 그 시험을 끄면 진짜로 번역이 빠진 키도 함께 통과한다. 예외를
/// **값으로** 적어 두는 것이 시험을 끄는 것보다 낫다 — 늘어나면 눈에 보인다.
const Set<String> i18nAllowSameAsEnglish = {
  // 고유명사.
  'appName',
  // 주소 예시다. 번역할 말이 없다 — `https://example.com` 은 어느 언어에서도 같다.
  'connectServerUrlHint',
};

/// 키 → 값 표로 펼친다. **시험이 문구를 훑는 유일한 통로**다.
///
/// Dart 에는 런타임 리플렉션이 없다(Flutter 에서는 특히). 그래서 getter 를 자동으로
/// 열거할 수 없고, 이 함수가 **열거의 한 곳**이 된다.
///
/// 그러므로 새 문구를 더할 때는 세 곳이다: [Strings] 의 getter · `en`/`ko` 의 구현 ·
/// **여기**. 앞의 둘은 컴파일러가 강제하고 여기는 강제하지 못한다 — 빠뜨리면 그 키는
/// 시험의 눈 밖에 있게 된다. 줄 하나이므로 함께 적는다.
Map<String, String> stringsToMap(Strings s) => {
      'appName': s.appName,
      'connectTitle': s.connectTitle,
      'connectServerUrlLabel': s.connectServerUrlLabel,
      'connectServerUrlHint': s.connectServerUrlHint,
      'connectContinue': s.connectContinue,
      'connectErrorEmpty': s.connectErrorEmpty,
      'connectErrorMalformed': s.connectErrorMalformed,
      'connectErrorInsecure': s.connectErrorInsecure,
      'commonLoading': s.commonLoading,
      'commonBack': s.commonBack,
      'commonRetry': s.commonRetry,
      'attachmentAdd': s.attachmentAdd,
      'attachmentUploadFailed': s.attachmentUploadFailed,
      'linkConfirmTitle': s.linkConfirmTitle,
      'linkConfirmOpen': s.linkConfirmOpen,
      'linkConfirmCancel': s.linkConfirmCancel,
      'linkUserInfoWarning': s.linkUserInfoWarning,
      'linkNonAsciiWarning': s.linkNonAsciiWarning,
      'loadFailedServer': s.loadFailedServer,
      'loadFailedForbidden': s.loadFailedForbidden,
      'dayToday': s.dayToday,
      'dayYesterday': s.dayYesterday,
      'dayDate': s.dayDate,
      'mentionDeniedLine': s.mentionDeniedLine,
      'loadFailedHint': s.loadFailedHint,
      'messagesLoadFailed': s.messagesLoadFailed,
      'threadLoadFailed': s.threadLoadFailed,
      'inboxLoadFailed': s.inboxLoadFailed,
      'messagesEmptyHint': s.messagesEmptyHint,
      'inboxEmptyHint': s.inboxEmptyHint,
      'bootUnreachableTitle': s.bootUnreachableTitle,
      'connectionLostBand': s.connectionLostBand,
      'connectionRetryNow': s.connectionRetryNow,
      'connectionSignInAgain': s.connectionSignInAgain,
      'sendFailed': s.sendFailed,
      'sending': s.sending,
      'resend': s.resend,
      'discard': s.discard,
      'sendWaitsForUpload': s.sendWaitsForUpload,
      'askFailed': s.askFailed,
      'reactionFailed': s.reactionFailed,
      'timeUnderMinute': s.timeUnderMinute,
      'timeMinutes': s.timeMinutes,
      'timeHours': s.timeHours,
      'timeDays': s.timeDays,
      'timeRunning': s.timeRunning,
      'timeTook': s.timeTook,
      'timeAgo': s.timeAgo,
      'timeJustNow': s.timeJustNow,
      'timeIn': s.timeIn,
      'timeSoon': s.timeSoon,
      'agentWorking': s.agentWorking,
      'agentWaiting': s.agentWaiting,
      'reportTitle': s.reportTitle,
      'reportChecks': s.reportChecks,
      'reportFiles': s.reportFiles,
      'reportRemaining': s.reportRemaining,
      'reportNext': s.reportNext,
      'failureTitle': s.failureTitle,
      'failureRetryable': s.failureRetryable,
      'failureNeedsHand': s.failureNeedsHand,
      'tabChannels': s.tabChannels,
      'tabInbox': s.tabInbox,
      'tabMe': s.tabMe,
      'inboxEmpty': s.inboxEmpty,
      'inboxMarkAllRead': s.inboxMarkAllRead,
      'inboxReasonMention': s.inboxReasonMention,
      'inboxReasonThreadReply': s.inboxReasonThreadReply,
      'inboxReasonDm': s.inboxReasonDm,
      'inboxReasonAskAnswered': s.inboxReasonAskAnswered,
      'inboxReasonAskClosed': s.inboxReasonAskClosed,
      'inboxReasonOther': s.inboxReasonOther,
      'meSignedInAs': s.meSignedInAs,
      'attachmentOpen': s.attachmentOpen,
      'attachmentFailed': s.attachmentFailed,
      'askAnswered': s.askAnswered,
      'askClosed': s.askClosed,
      'askDecline': s.askDecline,
      'askToYou': s.askToYou,
      'askToAnyone': s.askToAnyone,
      'threadTitle': s.threadTitle,
      'threadReplyHint': s.threadReplyHint,
      'threadRepliesZero': s.threadRepliesZero,
      'threadRepliesOne': s.threadRepliesOne,
      'threadRepliesMany': s.threadRepliesMany,
      'mentionPickerEmpty': s.mentionPickerEmpty,
      'mentionUnknown': s.mentionUnknown,
      'loginTitle': s.loginTitle,
      'loginIdLabel': s.loginIdLabel,
      'loginPasswordLabel': s.loginPasswordLabel,
      'loginSubmit': s.loginSubmit,
      'loginErrorRejected': s.loginErrorRejected,
      'loginErrorUnreachable': s.loginErrorUnreachable,
      'signOut': s.signOut,
      'channelsTitle': s.channelsTitle,
      'channelsEmpty': s.channelsEmpty,
      'messagesEmpty': s.messagesEmpty,
      'composerHint': s.composerHint,
      'composerSend': s.composerSend,
      'stickyMentionsLabel': s.stickyMentionsLabel,
      'stickyMentionRemove': s.stickyMentionRemove,
      'modelDefault': s.modelDefault,
      'modelThreadSet': s.modelThreadSet,
      'modelAgentSet': s.modelAgentSet,
      'modelAgentSetUnknown': s.modelAgentSetUnknown,
      'modelAllDefault': s.modelAllDefault,
      'modelMore': s.modelMore,
      'modelEffort': s.modelEffort,
      'modelEffortDefault': s.modelEffortDefault,
      'modelAgentDefault': s.modelAgentDefault,
      'modelHarnessDefault': s.modelHarnessDefault,
      'modelCostNote': s.modelCostNote,
      'modelNextTurn': s.modelNextTurn,
      'modelReset': s.modelReset,
      'modelApply': s.modelApply,
      'modelCustom': s.modelCustom,
      'modelStale': s.modelStale,
      'modelSheetTitleThread': s.modelSheetTitleThread,
      'modelSheetTitleComposer': s.modelSheetTitleComposer,
      'modelQuickLabel': s.modelQuickLabel,
      'modelClearThread': s.modelClearThread,
      'modelStaleDetail': s.modelStaleDetail,
      'modelRepick': s.modelRepick,
      'connectionOnline': s.connectionOnline,
      'connectionConnecting': s.connectionConnecting,
      'connectionReconnecting': s.connectionReconnecting,
      'connectionDead': s.connectionDead,
      'noticeSessionNotSaved': s.noticeSessionNotSaved,
      'agentBadge': s.agentBadge,
    };
