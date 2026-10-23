import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/ui/states.dart';

/// 토스트 자리(개정판 3.3): 작성칸이 있는 화면에서는 작성칸 위, 화면을 옮기면 내린다.
void main() {
  testWidgets('작성칸이 있는 화면 안의 토스트는 작성칸만큼 올라간다', (tester) async {
    late EdgeInsets inside;
    late EdgeInsets outside;
    await tester.pumpWidget(MaterialApp(
      home: Column(children: [
        Builder(builder: (c) {
          outside = toastMargin(c);
          return const SizedBox();
        }),
        ComposerScope(child: Builder(builder: (c) {
          inside = toastMargin(c);
          return const SizedBox();
        })),
      ]),
    ));
    expect(inside.bottom - outside.bottom, composerToastLift);
  });

  testWidgets('화면을 옮기면 떠 있던 토스트를 내린다', (tester) async {
    final messenger = GlobalKey<ScaffoldMessengerState>();
    final nav = GlobalKey<NavigatorState>();
    await tester.pumpWidget(MaterialApp(
      scaffoldMessengerKey: messenger,
      navigatorKey: nav,
      navigatorObservers: [ToastDismisser(messenger)],
      home: const Scaffold(body: SizedBox()),
    ));
    messenger.currentState!.showSnackBar(const SnackBar(content: Text('못 보냈다'), duration: Duration(minutes: 1)));
    await tester.pumpAndSettle();
    expect(find.text('못 보냈다'), findsOneWidget);

    nav.currentState!.push(MaterialPageRoute<void>(builder: (_) => const Scaffold(body: Text('다음 화면'))));
    await tester.pumpAndSettle();
    expect(find.text('다음 화면'), findsOneWidget);
    expect(find.text('못 보냈다'), findsNothing);

    messenger.currentState!.showSnackBar(const SnackBar(content: Text('또'), duration: Duration(minutes: 1)));
    await tester.pumpAndSettle();
    nav.currentState!.pop();
    await tester.pumpAndSettle();
    expect(find.text('또'), findsNothing);
  });

  // Flutter 는 action 이 있으면 persist 를 기본 true 로 잡아 duration 이 지나도 안 내린다 — 「완료로 옮겼다 ·
  // 되돌리기」 띠가 쓸어내려야만 사라졌다(iOS, alice 캡처).
  testWidgets('다시 시도를 단 실패 토스트도 시간이 되면 저절로 내린다', (tester) async {
    await tester.pumpWidget(MaterialApp(
      home: I18n(
        strings: stringsFor('ko'),
        child: Scaffold(body: Builder(builder: (c) => TextButton(
              onPressed: () => showFailureToast(c, '못 보냈다', retry: () {}),
              child: const Text('go'),
            ))),
      ),
    ));
    await tester.tap(find.text('go'));
    await tester.pumpAndSettle();
    expect(find.text('못 보냈다'), findsOneWidget);
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    expect(find.text('못 보냈다'), findsNothing);
  });

  testWidgets('VoiceOver 같은 접근성 탐색 중에는 시간이 지나도 붙잡아 둔다', (tester) async {
    await tester.pumpWidget(MaterialApp(
      builder: (c, child) => MediaQuery(data: MediaQuery.of(c).copyWith(accessibleNavigation: true), child: child!),
      home: I18n(
        strings: stringsFor('ko'),
        child: Scaffold(body: Builder(builder: (c) => TextButton(
              onPressed: () => showFailureToast(c, '못 보냈다', retry: () {}),
              child: const Text('go'),
            ))),
      ),
    ));
    await tester.tap(find.text('go'));
    await tester.pumpAndSettle();
    await tester.pump(const Duration(seconds: 30));
    await tester.pumpAndSettle();
    expect(find.text('못 보냈다'), findsOneWidget);
  });

  test('행동 단 토스트는 전부 actionToastPersists 로 persist 를 정한다(파일마다 행동 수 = 부른 수)', () {
    final offenders = <String>[];
    for (final f in Directory('lib').listSync(recursive: true).whereType<File>().where((f) => f.path.endsWith('.dart'))) {
      // 주석 줄은 세지 않는다 — 설명에 적힌 낱말이 수를 맞춰 주면 빠뜨린 토스트를 못 잡는다(security #1392 n1).
      final src = f.readAsLinesSync().where((l) => !l.trimLeft().startsWith('//')).join('\n');
      final actions = 'SnackBarAction('.allMatches(src).length;
      final persists = RegExp(r'(?<!bool )actionToastPersists\(').allMatches(src).length; // 정의 줄은 빼고 부른 곳만
      if (actions != persists) offenders.add('${f.path} (행동 $actions · persist $persists)');
    }
    expect(offenders, isEmpty);
  });
}
