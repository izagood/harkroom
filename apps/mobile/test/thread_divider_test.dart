import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/ui/states.dart';

/// designer #1040: 「답글 n개」 줄과 첫 답글의 날짜 줄이 겹치지 않게 하나로 합친다.
void main() {
  final t = stringsFor('ko');
  // 고정 시각 — `DateTime.now()` 면 자정 직전에 돌 때 「오늘」 이 「어제」 로 바뀌어 빨개진다(security #1043).
  final now = DateTime(2026, 10, 2, 12);
  final threeDaysAgo = now.subtract(const Duration(days: 3));

  test('원글과 첫 답글이 다른 날이면 구분 줄에 날짜를 붙인다', () {
    expect(threadDividerLabel(t, 2, rootAt: threeDaysAgo, firstReplyAt: now, now: now), '답글 2개 · 오늘');
  });

  test('같은 날이면 숫자만', () {
    expect(threadDividerLabel(t, 1, rootAt: now, firstReplyAt: now, now: now), '답글 1개');
  });

  test('원글을 모르면 날짜를 붙인다 · 답글이 없으면 숫자만', () {
    expect(threadDividerLabel(t, 3, firstReplyAt: now, now: now), '답글 3개 · 오늘');
    expect(threadDividerLabel(t, 0, rootAt: now, now: now), '답글 0개');
  });

  test('@ 한 글자·공백만이면 보낼 것이 없다', () {
    expect(SendButton.nothingToSend(''), isTrue);
    expect(SendButton.nothingToSend('  @ '), isTrue);
    expect(SendButton.nothingToSend('@forge'), isFalse);
    expect(SendButton.nothingToSend('a'), isFalse);
  });
}
