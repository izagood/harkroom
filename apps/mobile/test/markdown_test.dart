import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/markdown/markdown.dart';
import 'package:harkroom/markdown/markdown_view.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/theme.dart';
import 'package:harkroom/ui/tokens.dart';

void main() {
  group('블록', () {
    test('펜스 코드 — 안의 글은 해석하지 않는다', () {
      final b = parseMarkdown('앞\n```dart\n**굵게 아님** [x](https://a.example.com)\n```\n뒤');
      expect(b.length, 3);
      final code = b[1] as MdCode;
      expect(code.language, 'dart');
      expect(code.text, '**굵게 아님** [x](https://a.example.com)');
    });

    test('닫히지 않은 펜스는 끝까지 코드다', () {
      final b = parseMarkdown('```\n쓰다 만\n**코드**');
      expect((b.single as MdCode).text, '쓰다 만\n**코드**');
    });

    test('목록·번호 목록·인용·제목', () {
      final b = parseMarkdown('# 제목\n- 하나\n- 둘\n\n3. 셋\n4. 넷\n\n> 인용\n> 이어짐');
      expect((b[0] as MdHeading).level, 1);
      expect((b[1] as MdList).items.map((e) => e.text), ['하나', '둘']);
      final ol = b[2] as MdList;
      expect((ol.ordered, ol.start), (true, 3));
      expect(ol.items.map((e) => e.text), ['셋', '넷']);
      expect((b[3] as MdQuote).text, '인용\n이어짐');
    });

    test('이미지·HTML 은 글자 그대로 단락에 남는다 — 구분줄 없는 | 도', () {
      final b = parseMarkdown('| a | b |\n![x](https://i.example.com/p.png)\n<b>hi</b>');
      expect(b.single, isA<MdParagraph>());
      expect((b.single as MdParagraph).text, contains('![x](https://i.example.com/p.png)'));
    });

    // 아래는 데스크톱 `test/bodyMarkdown.test.tsx` 의 예시를 그대로 옮긴 것이다 — 같은 글이
    // 폰과 데스크톱에서 같은 구조가 되는지 본다.
    test('들여쓴 항목은 중첩 목록이 된다 — 안쪽이 바깥 항목 안에 있다', () {
      final b = parseMarkdown('1. 바깥\n   - 안쪽 하나\n   - 안쪽 둘\n2. 다시 바깥');
      final outer = b.single as MdList;
      expect(outer.ordered, isTrue);
      expect(outer.items.map((e) => e.text), ['바깥', '다시 바깥']);
      final inner = outer.items[0].children.single;
      expect(inner.ordered, isFalse);
      expect(inner.items.map((e) => e.text), ['안쪽 하나', '안쪽 둘']);
      expect(outer.items[1].children, isEmpty);
    });

    test('중첩은 상한 깊이까지만 — 더 깊은 항목은 그 깊이에 붙는다', () {
      final src = List.generate(122, (d) => '${' ' * d}- 깊이$d').join('\n');
      var list = parseMarkdown(src).single as MdList;
      var depth = 1;
      while (list.items.last.children.isNotEmpty) {
        list = list.items.last.children.single;
        depth++;
      }
      expect(depth, mdListMaxDepth);
      expect(list.items.length, 122 - (mdListMaxDepth - 1));
      expect(list.items.last.text, '깊이121');
    });

    test('표시 종류가 바뀌면 다른 목록이다', () {
      final b = parseMarkdown('- 점\n1. 번호');
      expect(b.length, 2);
      expect([for (final l in b.cast<MdList>()) l.ordered], [false, true]);
    });

    test('--- 만 있는 줄은 가로줄이다 — 글머리표가 아니다', () {
      final b = parseMarkdown('위\n\n---\n\n아래');
      expect(b.map((x) => x.runtimeType), [MdParagraph, MdRule, MdParagraph]);
      expect(parseMarkdown('--').single, isA<MdParagraph>());
    });
  });

  group('표', () {
    const table = '| claim | 판단 | 근거 |\n'
        '| --- | :---: | ---: |\n'
        '| `model-cache-ax-k1` 50Gi | **버린다** | `.compile.lock` 하나다 |\n'
        '| model-cache | 재바인딩 | 선언이 있다 |';

    test('머리글 + 구분줄이면 표다 — 정렬은 구분줄이 말한 것만 따른다', () {
      final t = parseMarkdown(table).single as MdTable;
      expect(t.align, [null, MdAlign.center, MdAlign.right]);
      expect(t.head, ['claim', '판단', '근거']);
      expect(t.rows.length, 2);
      expect(t.rows[1], ['model-cache', '재바인딩', '선언이 있다']);
    });

    test('칸 안의 코드·강조는 그대로 살아 있다', () {
      final row = (parseMarkdown(table).single as MdTable).rows[0];
      expect(parseInline(row[0]).whereType<MdInlineCode>().single.text, 'model-cache-ax-k1');
      expect(parseInline(row[1]).whereType<MdText>().single.bold, isTrue);
    });

    test('구분줄이 없으면 표가 아니다 — 사람이 쓴 문장을 격자에 넣지 않는다', () {
      const plain = '왼쪽 | 오른쪽\n위 | 아래';
      expect((parseMarkdown(plain).single as MdParagraph).text, plain);
    });

    test('열 수가 어긋난 구분줄은 표를 만들지 않는다', () {
      expect(parseMarkdown('a | b | c\n| --- |').whereType<MdTable>(), isEmpty);
    });

    test('행마다 칸 수가 달라도 머리글 열 수로 맞춘다', () {
      final t = parseMarkdown('| a | b |\n| --- | --- |\n| 하나 |\n| 하나 | 둘 | 셋 |').single as MdTable;
      expect(t.rows, [
        ['하나', ''],
        ['하나', '둘'],
      ]);
    });

    test('인라인 코드 안의 | 는 칸 경계가 아니다 — \\| 는 글자 | 다', () {
      final t = parseMarkdown('| cmd | 뜻 |\n| --- | --- |\n| `a|b` | x \\| y |').single as MdTable;
      expect(t.rows.single, ['`a|b`', 'x | y']);
    });

    test('코드 블록 안의 표는 표가 아니다', () {
      final b = parseMarkdown('```\n| a | b |\n| --- | --- |\n```');
      expect((b.single as MdCode).text, contains('| --- | --- |'));
    });

    test('표는 | 가 없는 줄에서 끝난다 — 뒤 문장이 마지막 행으로 끌려오지 않는다', () {
      final b = parseMarkdown('| a | b |\n| --- | --- |\n| 하나 | 둘 |\n표 뒤의 문장');
      expect((b[0] as MdTable).rows.length, 1);
      expect((b[1] as MdParagraph).text, '표 뒤의 문장');
    });

    // security #1060 F1: `|` 만 있는 줄을 머리글 열 수만큼 빈 칸으로 채우면 8000자 글 하나가
    // 200만 칸이 된다.
    final bomb = '${'|a' * 1000}\n${'|-' * 1000}\n${List.filled(1999, '|').join('\n')}';

    test('열이 상한을 넘는 표는 표가 아니다 — 글자 그대로 남는다', () {
      final b = parseMarkdown(bomb);
      expect(b.whereType<MdTable>(), isEmpty);
      expect(b.whereType<MdParagraph>().first.text, startsWith('|a|a'));
      String table(int cols) => '${'| a ' * cols}|\n${'|---' * cols}|\n${'| x ' * cols}|';
      expect(parseMarkdown(table(mdTableMaxCols)).single, isA<MdTable>());
      expect(parseMarkdown(table(mdTableMaxCols + 1)).whereType<MdTable>(), isEmpty);
    });

    test('행은 상한에서 자르고 숨긴 수를 센다 — 표 뒤 문장은 그대로 문장이다', () {
      final rows = List.generate(500, (i) => '| $i | x |').join('\n');
      final b = parseMarkdown('| a | b |\n|---|---|\n$rows\n표 뒤');
      final t = b[0] as MdTable;
      expect(t.rows.length, mdTableMaxRows);
      expect(t.omittedRows, 500 - mdTableMaxRows);
      expect((b[1] as MdParagraph).text, '표 뒤');
    });

    test('칸 합계도 상한 안이다 — 넓은 표는 행이 더 일찍 잘린다', () {
      const cols = mdTableMaxCols;
      final rows = List.filled(300, '|' * (cols + 1)).join('\n');
      final t = parseMarkdown('${'|a' * cols}|\n${'|-' * cols}|\n$rows').single as MdTable;
      expect((t.rows.length + 1) * cols, lessThanOrEqualTo(mdTableMaxCells));
      expect(t.rows.length + t.omittedRows, 300);
    });

    test('넓은 열 + 수천 행 본문도 표 칸은 상한 안이다', () {
      final b = parseMarkdown('${'|a' * mdTableMaxCols}\n${'|-' * mdTableMaxCols}\n${List.filled(1999, '|').join('\n')}');
      final t = b.single as MdTable;
      expect((t.rows.length + 1) * t.align.length, lessThanOrEqualTo(mdTableMaxCells));
    });

    test('문단 바로 뒤의 표도 표다', () {
      final b = parseMarkdown('정리:\n| a | b |\n|---|---|\n| 1 | 2 |');
      expect(b.map((x) => x.runtimeType), [MdParagraph, MdTable]);
    });
  });

  group('인라인', () {
    test('굵게·기울임·코드·링크', () {
      final p = parseInline('**굵게** *기울임* `코드` [링크](https://a.example.com/x)');
      expect(p.whereType<MdText>().where((t) => t.bold).single.text, '굵게');
      expect(p.whereType<MdText>().where((t) => t.italic).single.text, '기울임');
      expect(p.whereType<MdInlineCode>().single.text, '코드');
      expect(p.whereType<MdLink>().single.uri.toString(), 'https://a.example.com/x');
    });

    test('~~ 는 취소선이다 — 기호는 남지 않고, 띄어 쓴 ~~ 는 짝이 아니다', () {
      final p = parseInline('**굵게** 와 *기울임* 과 ~~취소~~');
      expect(p.whereType<MdText>().where((t) => t.strike).single.text, '취소');
      expect(p.whereType<MdText>().map((t) => t.text).join(), '굵게 와 기울임 과 취소');
      expect(parseInline('a ~~ b ~~ c').whereType<MdText>().any((t) => t.strike), isFalse);
      expect(parseInline('`~~x~~`').single, isA<MdInlineCode>());
    });

    test('코드 안의 별표·링크는 서식이 아니다', () {
      final p = parseInline('`a **b** [c](https://d.example.com)`');
      expect(p.single, isA<MdInlineCode>());
    });

    test('맨 주소도 링크다 — 끝의 문장부호는 주소가 아니다', () {
      final p = parseInline('여기 https://a.example.com/x. 봐');
      expect(p.whereType<MdLink>().single.uri.toString(), 'https://a.example.com/x');
    });
  });

  group('열어도 되는 주소', () {
    test('http·https 만 연다', () {
      expect(safeLinkUri('https://a.example.com'), isNotNull);
      expect(safeLinkUri('HTTP://a.example.com'), isNotNull);
      for (final bad in [
        'javascript:alert(1)',
        'JavaScript:alert(1)',
        'file:///etc/passwd',
        'tel:010',
        'myapp://open',
        'data:text/html,x',
        'https://',
        '//a.example.com',
      ]) {
        expect(safeLinkUri(bad), isNull, reason: bad);
      }
    });

    test('열 수 없는 스킴의 링크는 글자만 남는다', () {
      final link = parseInline('[눌러](javascript:alert(1))').whereType<MdLink>().toList();
      // `(1)` 의 닫는 괄호에서 주소가 끊기더라도, 어떤 경우든 열 수 있는 링크가 되면 안 된다.
      expect(link.every((l) => l.uri == null), isTrue);
    });
  });

  group('그림', () {
    Widget host(Widget child) => MaterialApp(
          theme: harkroomTheme(Brightness.light),
          home: I18n(strings: stringsFor('ko'), child: Scaffold(body: child)),
        );

    /// 첫 번째 누를 수 있는 링크를 누른다.
    Future<void> tapFirstLink(WidgetTester tester) async {
      TapGestureRecognizer? r;
      for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
        rich.text.visitChildren((span) {
          if (span is TextSpan && span.recognizer is TapGestureRecognizer) {
            r ??= span.recognizer! as TapGestureRecognizer;
          }
          return true;
        });
      }
      r!.onTap!();
      await tester.pumpAndSettle();
    }

    testWidgets('맨 주소는 보이는 그대로라 바로 연다', (tester) async {
      final opened = <Uri>[];
      await tester.pumpWidget(host(MarkdownBody(
        '여기 https://docs.example.com/a 봐',
        openLink: (u) async => opened.add(u),
      )));
      await tapFirstLink(tester);
      expect(find.byKey(const Key('link-confirm')), findsNothing);
      expect(opened.single.toString(), 'https://docs.example.com/a');
    });

    testWidgets('[글](주소) 는 시트를 거치지 않고는 열리지 않는다 — 취소하면 안 열린다', (tester) async {
      final opened = <Uri>[];
      await tester.pumpWidget(host(MarkdownBody(
        '[https://github.com/izagood/harkroom](https://github-login.evil.example/x)',
        openLink: (u) async => opened.add(u),
      )));
      await tapFirstLink(tester);
      expect(find.byKey(const Key('link-confirm')), findsOneWidget);
      // 시트는 **실제 호스트**를 크게 보인다.
      expect(tester.widget<Text>(find.byKey(const Key('link-confirm-host'))).data,
          'github-login.evil.example');
      expect(opened, isEmpty);
      await tester.tap(find.byKey(const Key('link-cancel')));
      await tester.pumpAndSettle();
      expect(opened, isEmpty);
    });

    testWidgets('시트에서 [열기]를 누르면 그 주소를 연다', (tester) async {
      final opened = <Uri>[];
      await tester.pumpWidget(host(MarkdownBody(
        '[문서](https://docs.example.com/a)',
        openLink: (u) async => opened.add(u),
      )));
      await tapFirstLink(tester);
      await tester.tap(find.byKey(const Key('link-open')));
      await tester.pumpAndSettle();
      expect(opened.single.toString(), 'https://docs.example.com/a');
    });

    testWidgets('userinfo 가 붙은 맨 주소도 시트를 거친다', (tester) async {
      final opened = <Uri>[];
      await tester.pumpWidget(host(MarkdownBody(
        'https://github.com@evil.example/x',
        openLink: (u) async => opened.add(u),
      )));
      await tapFirstLink(tester);
      expect(find.byKey(const Key('link-confirm')), findsOneWidget);
      expect(tester.widget<Text>(find.byKey(const Key('link-confirm-host'))).data, 'evil.example');
      expect(find.text(stringsFor('ko').linkUserInfoWarning), findsOneWidget);
      expect(opened, isEmpty);
    });

    test('닮은 글자 호스트는 물어야 한다', () {
      final l = parseInline('https://xn--80ak6aa92e.com/x').whereType<MdLink>().single;
      expect(linkNeedsConfirm(l), isTrue);
      expect(hostLooksSpoofable(Uri.parse('https://аpple.example')), isTrue);
      expect(hostLooksSpoofable(Uri.parse('https://apple.example')), isFalse);
    });

    testWidgets('본문의 @handle 은 칩으로, 코드 안의 @ 와 메일 주소는 그대로', (tester) async {
      await tester.pumpWidget(host(const MarkdownBody('@harkroom 봐 `@not` a@example.com')));
      final rich = tester.widget<RichText>(find.byType(RichText).first);
      final chips = <String>[];
      rich.text.visitChildren((span) {
        if (span is TextSpan && span.style?.backgroundColor == HarkroomTokens.light.mentionSoft) {
          chips.add(span.text!);
        }
        return true;
      });
      expect(chips, ['@harkroom']);
    });

    testWidgets('javascript 링크는 누를 수 없다', (tester) async {
      await tester.pumpWidget(host(const MarkdownBody('[눌러](javascript:void)')));
      var tappable = false;
      final rich = tester.widget<RichText>(find.byType(RichText).first);
      rich.text.visitChildren((span) {
        if (span is TextSpan && span.recognizer != null) tappable = true;
        return true;
      });
      expect(tappable, isFalse);
    });

    testWidgets('표는 격자로 그리고 옆으로 민다 — 구분줄은 화면에 남지 않는다', (tester) async {
      await tester.pumpWidget(host(const MarkdownBody(
          '| 이름 | 상태 |\n|:--|--:|\n| **forge** | ~~멈춤~~ 돎 |\n| [문서](https://docs.example.com/a) | `ok` |')));
      final scroll = tester.widget<SingleChildScrollView>(find.byKey(const Key('md-table')));
      expect(scroll.scrollDirection, Axis.horizontal);
      final table = tester.widget<Table>(find.byType(Table));
      expect(table.children.length, 3);
      final all = tester.widgetList<RichText>(find.byType(RichText)).map((r) => r.text.toPlainText()).toList();
      expect(all, containsAll(['이름', '상태', 'forge', '멈춤 돎', '문서', 'ok']));
      expect(all.any((t) => t.contains('|') || t.contains('--')), isFalse);
      // 정렬은 구분줄대로: 첫 열 왼쪽, 둘째 열 오른쪽.
      final align = {
        for (final r in tester.widgetList<RichText>(find.byType(RichText))) r.text.toPlainText(): r.textAlign
      };
      expect(align['이름'], TextAlign.left);
      expect(align['상태'], TextAlign.right);
      // 칸 안의 [글](주소) 도 확인 시트를 거친다.
      final opened = <Uri>[];
      await tester.pumpWidget(host(MarkdownBody('| a |\n|---|\n| [문서](https://docs.example.com/a) |',
          openLink: (u) async => opened.add(u))));
      await tapFirstLink(tester);
      expect(find.byKey(const Key('link-confirm')), findsOneWidget);
      expect(opened, isEmpty);
    });

    testWidgets('넓은 표는 화면을 넘어도 넘침 오류 없이 옆으로 밀린다', (tester) async {
      tester.view.physicalSize = const Size(390 * 3, 844 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final wide = List.filled(6, '아주 긴 열 이름이 들어간 칸입니다').join(' | ');
      await tester.pumpWidget(host(MarkdownBody('| $wide |\n|${List.filled(6, '---').join('|')}|\n| ${List.filled(6, 'x').join(' | ')} |')));
      expect(tester.takeException(), isNull);
      expect(tester.getSize(find.byType(Table)).width, greaterThan(390));
    });

    testWidgets('폭탄 본문(1000열×1999행)도 바로 그린다', (tester) async {
      final bomb = '${'|a' * 1000}\n${'|-' * 1000}\n${List.filled(1999, '|').join('\n')}';
      final wideBomb = '${'|a' * mdTableMaxCols}\n${'|-' * mdTableMaxCols}\n${List.filled(1999, '|').join('\n')}';
      final sw = Stopwatch()..start();
      await tester.pumpWidget(host(SingleChildScrollView(child: MarkdownBody(bomb))));
      await tester.pumpWidget(host(SingleChildScrollView(child: MarkdownBody(wideBomb))));
      expect(sw.elapsed, lessThan(const Duration(seconds: 5)));
      expect(tester.takeException(), isNull);
      expect(find.byKey(const Key('md-table-more')), findsOneWidget);
    });

    testWidgets('잘린 표는 숨긴 행 수를 말한다', (tester) async {
      final rows = List.generate(205, (i) => '| $i |').join('\n');
      await tester.pumpWidget(host(SingleChildScrollView(child: MarkdownBody('| a |\n|---|\n$rows'))));
      expect(tester.widget<Text>(find.byKey(const Key('md-table-more'))).data, '…5행 더');
    });

    testWidgets('깊이 122 목록도 폰 폭에서 넘치지 않는다', (tester) async {
      tester.view.physicalSize = const Size(390 * 3, 844 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final src = List.generate(122, (d) => '${' ' * d}- 깊이$d').join('\n');
      await tester.pumpWidget(host(SingleChildScrollView(child: MarkdownBody(src))));
      expect(tester.takeException(), isNull);
      expect(find.byKey(const Key('md-list')), findsNWidgets(mdListMaxDepth));
    });

    testWidgets('취소선·구분선·중첩 목록을 그린다', (tester) async {
      await tester.pumpWidget(host(const MarkdownBody('~~취소~~\n\n---\n\n- 바깥\n  - 안쪽')));
      expect(find.byKey(const Key('md-rule')), findsOneWidget);
      expect(find.byKey(const Key('md-list')), findsNWidgets(2));
      var struck = false;
      tester.widget<RichText>(find.byType(RichText).first).text.visitChildren((span) {
        if (span is TextSpan && span.text == '취소' && span.style?.decoration == TextDecoration.lineThrough) {
          struck = true;
        }
        return true;
      });
      expect(struck, isTrue);
      // 안쪽 글머리표는 깊이가 다르다는 것을 모양으로 말한다.
      expect(find.text('•'), findsOneWidget);
      expect(find.text('◦'), findsOneWidget);
    });

    testWidgets('코드 블록·목록·인용을 그린다', (tester) async {
      await tester.pumpWidget(host(const MarkdownBody('- 하나\n\n> 인용\n\n```\nflutter test\n```')));
      expect(find.byKey(const Key('md-list')), findsOneWidget);
      expect(find.byKey(const Key('md-quote')), findsOneWidget);
      expect(find.byKey(const Key('md-code')), findsOneWidget);
      expect(find.text('flutter test'), findsOneWidget);
    });
  });
}
