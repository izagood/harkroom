import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/theme.dart';
import 'package:harkroom/ui/parts.dart';

/// 작성칸 자동 높이(2026-10-21) — 한 줄에서 시작해 위로 자라고, 키보드 위 남은 높이의 40% 에서
/// 멈춘 뒤 칸 안에서 굴러간다. 보내서 비면 한 줄로 돌아온다.

final _controller = TextEditingController();
final _focus = FocusNode();

Widget _wrap({double keyboard = 0}) => MaterialApp(
      theme: harkroomTheme(Brightness.light),
      home: MediaQuery(
        data: MediaQueryData(size: const Size(400, 800), viewInsets: EdgeInsets.only(bottom: keyboard)),
        // 화면처럼 Scaffold **바깥** context 로 잰다 — Scaffold 는 안쪽 MediaQuery 의 키보드를 지운다.
        child: Builder(
          builder: (screen) => Scaffold(
          body: Column(children: [
            const Expanded(child: SizedBox.expand()),
            Builder(
              builder: (context) => composerField(
                key: const Key('composer'),
                context: screen,
                controller: _controller,
                focusNode: _focus,
                onChanged: (_) {},
                decoration: composerDecoration(context, 'hint'),
              ),
            ),
          ]),
        )),
      ),
    );

double _height(WidgetTester tester) => tester.getSize(find.byKey(const Key('composer'))).height;

String _lines(int n) => List.generate(n, (i) => 'line $i').join('\n');

void main() {
  setUp(() => _controller.text = '');

  testWidgets('줄이 늘면 자라고, 줄면 다시 줄어든다', (tester) async {
    await tester.pumpWidget(_wrap());
    final one = _height(tester);
    await tester.enterText(find.byKey(const Key('composer')), _lines(4));
    await tester.pump();
    final four = _height(tester);
    expect(four, greaterThan(one * 2));
    await tester.enterText(find.byKey(const Key('composer')), _lines(2));
    await tester.pump();
    expect(_height(tester), lessThan(four));
    // 보내서 비면 한 줄 키로 돌아온다.
    await tester.enterText(find.byKey(const Key('composer')), '');
    await tester.pump();
    expect(_height(tester), one);
  });

  testWidgets('옛 다섯 줄 상한을 넘어 자란다', (tester) async {
    await tester.pumpWidget(_wrap());
    await tester.enterText(find.byKey(const Key('composer')), _lines(5));
    await tester.pump();
    final five = _height(tester);
    await tester.enterText(find.byKey(const Key('composer')), _lines(8));
    await tester.pump();
    expect(_height(tester), greaterThan(five));
  });

  testWidgets('상한은 남은 높이의 40% — 넘으면 칸 안에서 굴러 커서 줄이 보인다', (tester) async {
    await tester.pumpWidget(_wrap());
    await tester.enterText(find.byKey(const Key('composer')), _lines(80));
    await tester.pump();
    // 커서 줄로 굴러가는 것은 짧은 움직임(animateTo)이다 — 끝날 때까지 흘린다.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
    expect(_height(tester), closeTo(800 * composerGrowShare, 0.5));
    // 커서는 글 끝에 있다 — 칸이 끝까지 굴러 있어야 한다.
    final scrollable = tester.state<ScrollableState>(
      find.descendant(of: find.byKey(const Key('composer')), matching: find.byType(Scrollable)),
    );
    expect(scrollable.position.pixels, greaterThan(0));
    expect(scrollable.position.pixels, closeTo(scrollable.position.maxScrollExtent, 1));
  });

  testWidgets('키보드가 오르면 그 위 남은 높이로 상한을 다시 잰다', (tester) async {
    await tester.pumpWidget(_wrap(keyboard: 300));
    await tester.enterText(find.byKey(const Key('composer')), _lines(80));
    await tester.pump();
    expect(_height(tester), closeTo((800 - 300) * composerGrowShare, 0.5));
  });

  testWidgets('남은 높이가 아무리 작아도 한 줄 칸 아래로는 안 줄어든다', (tester) async {
    await tester.pumpWidget(_wrap(keyboard: 760));
    await tester.enterText(find.byKey(const Key('composer')), _lines(80));
    await tester.pump();
    expect(_height(tester), composerMinHeight);
  });
}
