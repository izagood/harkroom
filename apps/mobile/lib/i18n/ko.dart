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
}
