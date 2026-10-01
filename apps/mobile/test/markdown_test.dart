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
      expect((b[1] as MdList).items, ['하나', '둘']);
      final ol = b[2] as MdList;
      expect((ol.ordered, ol.start), (true, 3));
      expect(ol.items, ['셋', '넷']);
      expect((b[3] as MdQuote).text, '인용\n이어짐');
    });

    test('표·이미지·HTML 은 글자 그대로 단락에 남는다', () {
      final b = parseMarkdown('| a | b |\n![x](https://i.example.com/p.png)\n<b>hi</b>');
      expect(b.single, isA<MdParagraph>());
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
      final rich = tester.widget<RichText>(find.byType(RichText).first);
      TapGestureRecognizer? r;
      rich.text.visitChildren((span) {
        if (span is TextSpan && span.recognizer is TapGestureRecognizer) {
          r ??= span.recognizer! as TapGestureRecognizer;
        }
        return true;
      });
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

    testWidgets('코드 블록·목록·인용을 그린다', (tester) async {
      await tester.pumpWidget(host(const MarkdownBody('- 하나\n\n> 인용\n\n```\nflutter test\n```')));
      expect(find.byKey(const Key('md-list')), findsOneWidget);
      expect(find.byKey(const Key('md-quote')), findsOneWidget);
      expect(find.byKey(const Key('md-code')), findsOneWidget);
      expect(find.text('flutter test'), findsOneWidget);
    });
  });
}
