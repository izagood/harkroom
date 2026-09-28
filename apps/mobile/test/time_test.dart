import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/time.dart';

void main() {
  final t = stringsFor('en');

  group('길이는 성기게 적는다', () {
    // 곁눈으로 읽는 자리라 초까지 적으면 매 초 글자가 바뀌어 옆을 읽기 어렵다.
    test('1분 미만은 숫자를 쓰지 않는다', () {
      expect(durationLabel(const Duration(seconds: 42), t), t.timeUnderMinute);
    });

    test('분·시간·일', () {
      expect(durationLabel(const Duration(minutes: 4), t), '4m');
      expect(durationLabel(const Duration(hours: 2, minutes: 5), t), '2h 5m');
      expect(durationLabel(const Duration(hours: 3), t), '3h');
      expect(durationLabel(const Duration(days: 2), t), '2d');
    });
  });

  test('도는 중과 끝난 것을 갈라 적는다', () {
    expect(runningLabel(const Duration(minutes: 4), t), 'running 4m');
    expect(tookLabel(const Duration(minutes: 4), t), 'took 4m');
  });

  group('지난 일', () {
    final now = DateTime.utc(2026, 9, 28, 12);
    test('1분 미만은 "방금"', () {
      expect(agoLabel(now.subtract(const Duration(seconds: 10)), now, t), t.timeJustNow);
    });
    test('미래를 과거로 적지 않는다', () {
      expect(agoLabel(now.add(const Duration(minutes: 5)), now, t), t.timeJustNow);
    });
    test('4분 전', () {
      expect(agoLabel(now.subtract(const Duration(minutes: 4)), now, t), '4m ago');
    });
  });

  group('아직 오지 않은 것', () {
    final now = DateTime.utc(2026, 9, 28, 12);
    test('4분 뒤', () {
      expect(inLabel(now.add(const Duration(minutes: 4)), now, t), 'in 4m');
    });
    test('시각이 지났으면 숫자를 쓰지 않는다 — "0분 뒤"는 쓸모없는 말이다', () {
      expect(inLabel(now.subtract(const Duration(minutes: 3)), now, t), t.timeSoon);
      expect(inLabel(now.add(const Duration(seconds: 5)), now, t), t.timeSoon);
    });
  });

  test('한국어도 같은 규칙으로 선다', () {
    final ko = stringsFor('ko');
    expect(durationLabel(const Duration(minutes: 4), ko), '4분');
    expect(inLabel(DateTime.utc(2026, 9, 28, 12, 4), DateTime.utc(2026, 9, 28, 12), ko), '4분 뒤');
  });
}
