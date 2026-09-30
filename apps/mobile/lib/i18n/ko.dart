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
  String get connectErrorEmpty => '서버 주소를 입력하세요.';

  @override
  String get connectErrorMalformed => '서버 주소 형식이 아닙니다.';

  @override
  String get connectErrorInsecure => 'iOS는 http:// 연결을 차단합니다. https:// 주소를 사용하세요.';

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
  String get loginErrorRejected => '로그인 아이디 또는 비밀번호가 맞지 않습니다.';

  @override
  String get loginErrorUnreachable => '서버에 연결하지 못했습니다. 주소와 네트워크를 확인하세요.';

  @override
  String get signOut => '로그아웃';

  @override
  String get channelsTitle => '채널';

  @override
  String get channelsEmpty => '아직 들어간 채널이 없습니다.';

  @override
  String get messagesEmpty => '아직 메시지가 없습니다.';

  @override
  String get composerHint => '메시지, 또는 @로 에이전트 호출';

  @override
  String get composerSend => '보내기';

  @override
  String get connectionOnline => '연결됨';

  @override
  String get connectionConnecting => '연결 중…';

  @override
  String get connectionReconnecting => '다시 연결 중…';

  @override
  String get connectionDead => '연결 끊김 — 다시 로그인하세요';

  @override
  String get noticeSessionNotSaved => '세션을 키체인에 저장하지 못했습니다. 지금은 계속 사용할 수 있지만, 앱을 다시 열면 다시 로그인해야 합니다.';

  @override
  String get agentBadge => '에이전트';

  @override
  String get askAnswered => '답함';

  @override
  String get askClosed => '답하지 않음';

  @override
  String get askDecline => '나중에';

  @override
  String get askToYou => '내 차례';

  @override
  String get askToAnyone => '누군가의 차례';

  @override
  String get threadTitle => '스레드';

  @override
  String get threadReplyHint => '스레드에 답하기';

  @override
  String get threadRepliesZero => '답글 달기';

  @override
  String get threadRepliesOne => '답글 1개';

  @override
  String get threadRepliesMany => '답글 {n}개';

  @override
  String get mentionPickerEmpty => '맞는 사람이 없습니다';

  @override
  String get mentionUnknown => '@알 수 없음';

  @override
  String get tabChannels => '채널';

  @override
  String get tabInbox => '받은 것';

  @override
  String get tabMe => '나';

  @override
  String get inboxEmpty => '아직 받은 것이 없습니다.';

  @override
  String get inboxMarkAllRead => '모두 읽음';

  @override
  String get inboxReasonMention => '나를 불렀습니다';

  @override
  String get inboxReasonThreadReply => '내 스레드에 답글';

  @override
  String get inboxReasonDm => '다이렉트 메시지';

  @override
  String get inboxReasonAskAnswered => '내 물음에 답함';

  @override
  String get inboxReasonAskClosed => '내 물음을 접음';

  @override
  String get inboxReasonOther => '나를 불렀습니다';

  @override
  String get meSignedInAs => '@{handle} 로 로그인됨';

  @override
  String get attachmentOpen => '열기';

  @override
  String get attachmentFailed => '이 파일을 불러오지 못했습니다.';

  @override
  String get timeUnderMinute => '1분 미만';

  @override
  String get timeMinutes => '{n}분';

  @override
  String get timeHours => '{n}시간';

  @override
  String get timeDays => '{n}일';

  @override
  String get timeRunning => '{duration}째 작업 중';

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
  String get reportTitle => '완료';

  @override
  String get reportChecks => '확인한 것';

  @override
  String get reportFiles => '바뀐 것';

  @override
  String get reportRemaining => '남은 것';

  @override
  String get reportNext => '다음';

  @override
  String get failureTitle => '실패';

  @override
  String get failureRetryable => '다시 해 볼 수 있음';

  @override
  String get failureNeedsHand => '손이 필요함';

  @override
  String get attachmentAdd => '파일 첨부';

  @override
  String get attachmentUploadFailed => '파일을 올리지 못했습니다.';
}
