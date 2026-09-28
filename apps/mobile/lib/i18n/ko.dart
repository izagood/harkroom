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
}
