import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/theme.dart';
import 'package:harkroom/ui/parts.dart';
import 'package:harkroom/ui/states.dart';
import 'package:harkroom/ui/tokens.dart';

Widget _host(Widget child, {Brightness brightness = Brightness.light}) => MaterialApp(
      theme: harkroomTheme(brightness),
      home: Scaffold(body: Center(child: child)),
    );

void main() {
  group('테마', () {
    test('두 밝기 모두 토큰을 싣는다 — 화면이 context.tokens 로 집는다', () {
      for (final b in Brightness.values) {
        expect(harkroomTheme(b).extension<HarkroomTokens>(), isNotNull);
      }
    });

    test('남보라 씨앗색을 쓰지 않는다 — 주 색은 먹색, 강조는 주황 하나', () {
      final t = harkroomTheme(Brightness.light);
      expect(t.colorScheme.primary, HarkroomTokens.light.ink);
      expect(t.colorScheme.secondary, HarkroomTokens.light.accent);
      expect(t.badgeTheme.backgroundColor, HarkroomTokens.light.accent);
    });

    test('제목은 왼쪽이다', () {
      expect(harkroomTheme(Brightness.light).appBarTheme.centerTitle, isFalse);
    });

    test('"내 차례" 면이 비어 있지 않다 — 비우면 Material 이 먹색을 지어낸다', () {
      final s = harkroomTheme(Brightness.light).colorScheme;
      expect(s.primaryContainer, HarkroomTokens.light.accentSoft);
      expect(s.onPrimaryContainer, HarkroomTokens.light.fg);
    });
  });

  group('아바타', () {
    test('같은 id 는 늘 같은 색이다(이름이 바뀌어도)', () {
      final a = HarkroomAvatar.colorFor('00000000-0000-4000-8000-000000000001');
      expect(HarkroomAvatar.colorFor('00000000-0000-4000-8000-000000000001'), a);
      expect(HarkroomAvatar.palette, contains(a));
    });

    test('첫 글자 — 기호는 건너뛰고 영문은 대문자', () {
      expect(HarkroomAvatar.initialOf('forge'), 'F');
      expect(HarkroomAvatar.initialOf('@_task'), 'T');
      expect(HarkroomAvatar.initialOf('재빈'), '재');
      expect(HarkroomAvatar.initialOf('—'), '?');
    });

    testWidgets('36 둥근 사각으로 그린다', (tester) async {
      await tester.pumpWidget(_host(const HarkroomAvatar(id: 'x', name: 'forge')));
      final size = tester.getSize(find.byType(HarkroomAvatar));
      expect(size, const Size(HarkroomSize.avatar, HarkroomSize.avatar));
      expect(find.text('F'), findsOneWidget);
    });
  });

  group('안 읽음 배지', () {
    testWidgets('0 이면 아무것도 그리지 않는다', (tester) async {
      await tester.pumpWidget(_host(const UnreadBadge(count: 0)));
      expect(find.byType(Text), findsNothing);
    });

    testWidgets('주황 바탕에 수, 세 자리부터 99+', (tester) async {
      await tester.pumpWidget(_host(const UnreadBadge(count: 120)));
      expect(find.text('99+'), findsOneWidget);
      final box = tester.widget<Container>(find.byKey(const Key('unread-120')));
      expect((box.decoration! as BoxDecoration).color, HarkroomTokens.light.accent);
    });
  });

  group('상태 띠', () {
    testWidgets('행동과 닫기를 달 수 있고, 누르면 부른다', (tester) async {
      var acted = 0;
      var closed = 0;
      await tester.pumpWidget(_host(StatusBand(
        text: '연결 끊김',
        actionLabel: '다시',
        onAction: () => acted++,
        onClose: () => closed++,
      )));
      await tester.tap(find.text('다시'));
      await tester.tap(find.byIcon(Icons.close));
      expect((acted, closed), (1, 1));
    });

    testWidgets('면을 칠하지 않는다 — 옅은 바탕(warnSoft)', (tester) async {
      await tester.pumpWidget(_host(const StatusBand(text: '연결 끊김')));
      final m = tester.widget<Material>(
          find.descendant(of: find.byType(StatusBand), matching: find.byType(Material)).first);
      expect(m.color, HarkroomTokens.light.warnSoft);
    });
  });

  testWidgets('화면 제목 — 부제가 있으면 두 줄, 없으면 한 줄', (tester) async {
    await tester.pumpWidget(_host(const ScreenTitle(title: '# task', subtitle: '멤버 12')));
    expect(find.text('# task'), findsOneWidget);
    expect(find.text('멤버 12'), findsOneWidget);
    await tester.pumpWidget(_host(const ScreenTitle(title: '# task')));
    expect(find.byType(Column), findsNothing);
  });

  testWidgets('목록 자리 탭 — 스크롤이 없는 자리(비어 있음·못 읽음)에서도 키보드만 내리고 글은 둔다', (tester) async {
    final field = TextEditingController(text: '쓰던 글');
    final focus = FocusNode();
    addTearDown(field.dispose);
    addTearDown(focus.dispose);
    await tester.pumpWidget(MaterialApp(
      home: Scaffold(
        body: Column(children: [
          const Expanded(child: FeedKeyboardDismiss(child: Center(child: Text('비어 있다')))),
          TextField(controller: field, focusNode: focus),
        ]),
      ),
    ));
    focus.requestFocus();
    await tester.pump();
    expect(focus.hasFocus, isTrue);
    await tester.tapAt(tester.getTopLeft(find.byType(FeedKeyboardDismiss)) + const Offset(20, 20));
    await tester.pump();
    expect(focus.hasFocus, isFalse);
    expect(field.text, '쓰던 글');
  });
}
