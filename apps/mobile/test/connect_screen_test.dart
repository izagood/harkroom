import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/connect/connect_screen.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/theme.dart';

/// 화면이 **문구를 짓지 않고 고르는지** 본다. 버튼·입력칸은 글자가 아니라
/// `Key` 로 집는다 — 문구로 집으면 번역을 고칠 때마다 시험이 깨진다.
Widget _app(String localeCode) => MaterialApp(
      // 배포되는 것과 같은 테마를 쓴다 — 갈라지면 시험이 다른 앱을 보게 된다.
      theme: harkroomTheme(Brightness.light),
      home: I18n(
        strings: stringsFor(localeCode),
        child: const ConnectScreen(),
      ),
    );

void main() {
  testWidgets('http:// 를 넣으면 ATS 사유를 말한다 (en)', (tester) async {
    await tester.pumpWidget(_app('en'));
    await tester.enterText(
        find.byKey(const Key('connect-server-url')), 'http://example.com');
    await tester.tap(find.byKey(const Key('connect-continue')));
    await tester.pump();

    expect(find.text(stringsFor('en').connectErrorInsecure), findsOneWidget);
  });

  testWidgets('같은 오류가 한국어로도 선다', (tester) async {
    await tester.pumpWidget(_app('ko'));
    await tester.enterText(
        find.byKey(const Key('connect-server-url')), 'http://example.com');
    await tester.tap(find.byKey(const Key('connect-continue')));
    await tester.pump();

    expect(find.text(stringsFor('ko').connectErrorInsecure), findsOneWidget);
  });

  testWidgets('https 주소는 오류를 세우지 않는다', (tester) async {
    await tester.pumpWidget(_app('en'));
    await tester.enterText(
        find.byKey(const Key('connect-server-url')), 'https://example.com');
    await tester.tap(find.byKey(const Key('connect-continue')));
    await tester.pump();

    expect(find.text(stringsFor('en').connectErrorInsecure), findsNothing);
    expect(find.text(stringsFor('en').connectErrorMalformed), findsNothing);
  });
}
