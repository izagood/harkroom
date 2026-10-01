import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
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
}
