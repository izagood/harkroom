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
    };
