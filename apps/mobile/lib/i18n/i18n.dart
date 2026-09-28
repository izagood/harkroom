
import 'package:flutter/widgets.dart';

import 'en.dart';
import 'ko.dart';
import 'strings.dart';

export 'strings.dart' show Strings;

/// 앱이 아는 언어. 순서가 곧 **우선순위**다 — 기기 언어가 어느 것에도 맞지 않으면
/// 첫 번째(영어)로 떨어진다.
const List<Locale> supportedLocales = [Locale('en'), Locale('ko')];

/// 언어 코드 → 문구 묶음. 모르는 코드는 영어다.
Strings stringsFor(String localeCode) =>
    switch (localeCode) { 'ko' => const StringsKo(), _ => const StringsEn() };

/// 지금 화면이 쓰는 문구를 위젯 나무에 걸어 둔다.
///
/// ## 왜 `InheritedWidget` 인가
///
/// 문구를 전역 변수로 두면 언어를 바꿔도 **이미 그려진 화면이 다시 그려지지 않는다**.
/// 그러면 설정에서 언어를 바꾼 사람은 앱을 껐다 켜야 하고, 그것은 §7-2 가 "앱 안에서
/// 바꿀 수 있게 둔다"고 적은 것을 어긴다. `InheritedWidget` 은 값이 바뀌면 이것을 읽는
/// 위젯만 정확히 다시 그린다.
class I18n extends InheritedWidget {
  const I18n({super.key, required this.strings, required super.child});

  final Strings strings;

  static Strings of(BuildContext context) {
    final scope = context.dependOnInheritedWidgetOfExactType<I18n>();
    assert(scope != null, 'I18n 이 위젯 나무에 없다 — 앱 루트에 I18n 을 두어야 한다.');
    return scope!.strings;
  }

  @override
  bool updateShouldNotify(I18n oldWidget) => oldWidget.strings != strings;
}

/// `context.t.connectTitle` 로 읽는다. 데스크탑의 `useT()` 와 같은 자리다.
extension I18nContext on BuildContext {
  Strings get t => I18n.of(this);
}
