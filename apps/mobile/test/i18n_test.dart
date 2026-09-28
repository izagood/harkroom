import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/i18n/en.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/i18n/ko.dart';
import 'package:harkroom/i18n/strings.dart';

/// 계획서 §7-2 를 지키는 시험.
///
/// 컴파일러가 잡아 주는 것은 **키가 빠진 것**이다(`implements Strings`). 컴파일러가 못
/// 잡는 것이 둘 있고, 이 파일이 그 둘을 본다: 빈 값과 **번역하지 않은 값**.
void main() {
  const en = StringsEn();
  const ko = StringsKo();

  test('두 언어의 키 집합이 같다', () {
    expect(stringsToMap(ko).keys.toSet(), stringsToMap(en).keys.toSet());
  });

  test('빈 문구가 없다', () {
    for (final locale in [en, ko]) {
      stringsToMap(locale).forEach((key, value) {
        expect(value.trim(), isNotEmpty,
            reason: '${locale.localeCode}.$key 가 비어 있다');
      });
    }
  });

  test('ko 를 비워 두지 않는다 — 영어를 그대로 둔 키가 없다', () {
    final enMap = stringsToMap(en);
    final koMap = stringsToMap(ko);
    for (final key in enMap.keys) {
      if (i18nAllowSameAsEnglish.contains(key)) continue;
      expect(koMap[key], isNot(enMap[key]),
          reason: 'ko.$key 가 영어 그대로다. 번역하거나 '
              'i18nAllowSameAsEnglish 에 사유와 함께 넣어라');
    }
  });

  test('모르는 언어 코드는 영어로 떨어진다', () {
    expect(stringsFor('ja').localeCode, 'en');
    expect(stringsFor('ko').localeCode, 'ko');
    expect(stringsFor('en').localeCode, 'en');
  });
}
