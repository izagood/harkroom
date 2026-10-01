import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/theme.dart';

/// designer #1026 후속: 채널 맨 위 세 줄(받는 중·못 받음·처음)이 **같은 높이**여야 상태가 바뀔 때
/// 목록이 움직이지 않는다. 전에는 다시 시도 줄이 +14pt, 시작 줄이 −4pt 였다.
void main() {
  Future<double> heightOf(WidgetTester tester, FeedTop top) async {
    await tester.pumpWidget(MaterialApp(
      theme: harkroomTheme(Brightness.light),
      home: I18n(
        strings: stringsFor('ko'),
        child: Scaffold(
          body: Align(
            alignment: Alignment.topCenter,
            child: FeedTopRow(top: top, channelName: 'task', onRetry: () {}),
          ),
        ),
      ),
    ));
    return tester.getSize(find.byType(FeedTopRow)).height;
  }

  testWidgets('세 상태가 같은 높이(44)에 선다', (tester) async {
    for (final top in FeedTop.values) {
      expect(await heightOf(tester, top), FeedTopRow.rowHeight, reason: '$top');
    }
  });

  testWidgets('가운뎃점 양옆 띄움이 같다', (tester) async {
    await heightOf(tester, FeedTop.failed);
    final dot = tester.getRect(find.text('·'));
    final before = tester.getRect(find.text('이전 메시지를 불러오지 못했다'));
    final retry = tester.getRect(find.descendant(of: find.byKey(const Key('older-retry')), matching: find.byType(Text)));
    expect(dot.left - before.right, closeTo(retry.left - dot.right, 0.5));
  });
}
