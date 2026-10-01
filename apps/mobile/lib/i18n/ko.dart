import 'strings.dart';

/// 한국어. **비워 두지 않는다**(계획서 §7-2) — 빈 자리는 "번역이 없다"가 아니라
/// "덜 만든 화면"으로 읽힌다. `test/i18n_test.dart` 가 그것을 지킨다.
class StringsKo implements Strings {
  const StringsKo();

  @override
  String get localeCode => 'ko';

  // 고유명사라 영어와 같다. 그래도 통과하는 이유는 `i18nAllowSameAsEnglish` 에 적혀서다.
  @override
  String get appName => 'Harkroom';

  @override
  String get connectTitle => '워크스페이스에 연결';

  @override
  String get connectServerUrlLabel => '서버 주소';

  @override
  String get connectServerUrlHint => 'https://example.com';

  @override
  String get connectContinue => '계속';

  @override
  String get connectErrorEmpty => '서버 주소가 비어 있다.';

  @override
  String get connectErrorMalformed => '서버 주소 형식이 아니다.';

  @override
  String get connectErrorInsecure => 'iOS 는 http:// 연결을 막는다. https:// 주소여야 한다.';

  @override
  String get commonLoading => '불러오는 중…';

  @override
  String get commonBack => '뒤로';

  @override
  String get commonRetry => '다시 시도';

  @override
  String get loginTitle => '로그인';

  @override
  String get loginIdLabel => '로그인 아이디';

  @override
  String get loginPasswordLabel => '비밀번호';

  @override
  String get loginSubmit => '로그인';

  @override
  String get loginErrorRejected => '로그인 아이디나 비밀번호가 맞지 않는다.';

  @override
  String get loginErrorUnreachable => '서버에 연결하지 못했다. 주소와 네트워크를 확인해 달라.';

  @override
  String get signOut => '로그아웃';

  @override
  String get channelsTitle => '채널';

  @override
  String get channelsEmpty => '아직 들어간 채널이 없다.';

  @override
  String get messagesEmpty => '아직 메시지가 없다.';

  @override
  String get composerHint => '메시지 — @ 로 에이전트를 부른다';

  @override
  String get composerSend => '보내기';

  @override
  String get connectionOnline => '연결됨';

  @override
  String get connectionConnecting => '연결 중…';

  @override
  String get connectionReconnecting => '다시 연결 중…';

  @override
  String get connectionDead => '연결 끊김 — 다시 로그인해야 한다';

  @override
  String get noticeSessionNotSaved => '세션을 키체인에 저장하지 못했다. 지금은 계속 쓸 수 있지만, 앱을 다시 열면 다시 로그인해야 한다.';

  @override
  String get agentBadge => '에이전트';

  @override
  String get askAnswered => '정해졌다';

  @override
  String get askClosed => '답 없이 닫혔다';

  @override
  String get askDecline => '답하지 않기';

  @override
  String get askToYou => '내 차례';

  @override
  String get askToAnyone => '사람이 고른다';

  @override
  String get threadTitle => '스레드';

  @override
  String get threadReplyHint => '스레드에 답글';

  @override
  String get threadRepliesZero => '답글 달기';

  @override
  String get threadRepliesOne => '답글 1개';

  @override
  String get threadRepliesMany => '답글 {n}개';

  @override
  String get mentionPickerEmpty => '맞는 사람이 없다';

  @override
  String get mentionUnknown => '@알 수 없음';

  @override
  String get tabChannels => '채널';

  @override
  String get tabInbox => '인박스';

  @override
  String get tabMe => '나';

  @override
  String get inboxEmpty => '인박스가 비어 있다.';

  @override
  String get inboxMarkAllRead => '모두 읽음';

  @override
  String get inboxReasonMention => '불렀다';

  @override
  String get inboxReasonThreadReply => '답글';

  @override
  String get inboxReasonDm => '다이렉트 메시지';

  @override
  String get inboxReasonAskAnswered => '내 물음에 답했다';

  @override
  String get inboxReasonAskClosed => '내 물음을 닫았다';

  @override
  String get inboxReasonOther => '불렀다';

  @override
  String get meSignedInAs => '@{handle} 계정으로 로그인했다';

  @override
  String get attachmentOpen => '열기';

  @override
  String get attachmentFailed => '이 파일을 불러오지 못했다.';

  @override
  String get timeUnderMinute => '1분 미만';

  @override
  String get timeMinutes => '{n}분';

  @override
  String get timeHours => '{n}시간';

  @override
  String get timeDays => '{n}일';

  @override
  String get timeRunning => '{duration}째';

  @override
  String get timeTook => '{duration} 걸림';

  @override
  String get timeAgo => '{duration} 전';

  @override
  String get timeJustNow => '방금';

  @override
  String get timeIn => '{duration} 뒤';

  @override
  String get timeSoon => '곧';

  @override
  String get agentWorking => '작업 중';

  @override
  String get agentWaiting => '대기 중';

  @override
  String get reportTitle => '끝남';

  @override
  String get reportChecks => '확인한 것';

  @override
  String get reportFiles => '바뀐 파일';

  @override
  String get reportRemaining => '남은 것';

  @override
  String get reportNext => '다음';

  @override
  String get failureTitle => '끝내지 못했다';

  @override
  String get failureRetryable => '다시 해 볼 수 있다';

  @override
  String get failureNeedsHand => '손이 필요하다';

  @override
  String get attachmentAdd => '파일 첨부';

  @override
  String get attachmentUploadFailed => '파일을 올리지 못했다.';

  @override
  String get loadFailedHint => '네트워크를 확인한 뒤 다시 시도해 달라.';

  @override
  String get messagesLoadFailed => '메시지를 불러오지 못했다';

  @override
  String get threadLoadFailed => '답글을 불러오지 못했다';

  @override
  String get inboxLoadFailed => '인박스를 불러오지 못했다';

  @override
  String get messagesEmptyHint => '첫 말을 남기거나 @ 로 에이전트를 불러 본다.';

  @override
  String get inboxEmptyHint => '누가 부르거나 답을 기다리면 여기 선다.';

  @override
  String get bootUnreachableTitle => '서버에 닿지 못했다';

  @override
  String get connectionLostBand => '연결 끊김 · 다시 붙으면 놓친 메시지를 읽어 온다';

  @override
  String get connectionRetryNow => '다시';

  @override
  String get connectionSignInAgain => '다시 로그인';

  @override
  String get sendFailed => '보내지 못했다';

  @override
  String get sending => '보내는 중…';

  @override
  String get resend => '다시 보내기';

  @override
  String get discard => '지우기';

  @override
  String get sendWaitsForUpload => '첨부를 올리는 중이다 — 끝나면 보낼 수 있다';

  @override
  String get askFailed => '고르지 못했다';

  @override
  String get reactionFailed => '리액션을 바꾸지 못했다';
}
