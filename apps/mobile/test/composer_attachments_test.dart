import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/composer_attachments.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 작성칸 첨부 미리보기 — designer 시안 24878e97, jaebin D4(캡션 없음, 탭하면 전체 화면).

final _png = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');

AppState _state() {
  final s = AppState(
    sessions: SessionStore.inMemory(),
    apiFactory: (base, token) =>
        ApiClient(baseUrl: base, token: token, httpClient: MockClient((_) async => http.Response('{}', 500))),
    connector: (Uri _) async => throw StateError('시험에서는 소켓을 열지 않는다'),
  );
  s.setServer('https://server.example.com');
  return s;
}

// 앱처럼 `builder` 로 감싼다 — 전체 화면 보기는 새 경로라 `home` 아래에 둔 I18n·AppScope 를 못 본다.
Widget _wrap(AppState state) => MaterialApp(
      theme: harkroomTheme(Brightness.light),
      builder: (context, child) => I18n(strings: stringsFor('ko'), child: AppScope(state: state, child: child!)),
      home: const Scaffold(body: ComposerAttachments(composerKey: 'c1')),
    );

PendingAttachment _image(String name, {bool done = true}) => PendingAttachment(filename: name)
  ..preview = _png
  ..byteSize = 2048
  ..attachment = done ? AttachmentRow(id: 'id-$name', filename: name, contentType: 'image/png', byteSize: 2048) : null;

void main() {
  test('그릴 이름은 그림만이다 — SVG 는 그림이 아니다', () {
    expect(isPreviewableName('IMG_0001.HEIC'), isTrue);
    expect(isPreviewableName('shot.png'), isTrue);
    expect(isPreviewableName('logo.svg'), isFalse);
    expect(isPreviewableName('계획.pdf'), isFalse);
    expect(isPreviewableName('noext'), isFalse);
  });

  testWidgets('그림은 64 타일로 그리고 이름 캡션은 달지 않는다', (tester) async {
    final app = _state()..pending['c1'] = [_image('shot.png')];
    await tester.pumpWidget(_wrap(app));

    expect(find.byKey(const Key('pending-thumb-shot.png')), findsOneWidget);
    expect(tester.getSize(find.byKey(const Key('pending-open-shot.png'))), const Size(64, 64));
    expect(find.text('shot.png'), findsNothing);
  });

  testWidgets('그림이 아닌 첨부는 이름·크기가 보이는 같은 높이 카드다', (tester) async {
    final app = _state()
      ..pending['c1'] = [
        PendingAttachment(filename: '계획.pdf')
          ..byteSize = 2048
          ..attachment = const AttachmentRow(id: 'p', filename: '계획.pdf', contentType: 'application/pdf', byteSize: 2048),
      ];
    await tester.pumpWidget(_wrap(app));

    expect(find.text('계획.pdf'), findsOneWidget);
    expect(find.text('2.0 KB'), findsOneWidget);
    expect(tester.getSize(find.byKey(const Key('pending-file-계획.pdf'))).height, 64);
  });

  testWidgets('× 의 누르는 영역은 44 이고 누르면 뗀다', (tester) async {
    final app = _state()..pending['c1'] = [_image('shot.png', done: false)];
    await tester.pumpWidget(_wrap(app));

    final remove = find.byKey(const Key('pending-remove-shot.png'));
    expect(tester.getSize(remove), const Size(44, 44));
    await tester.tap(remove);
    await tester.pump();
    expect(app.pending['c1'], isNull);
  });

  testWidgets('타일을 누르면 전체 화면 — 이름·n/전체, 좌우로 넘기고 [첨부에서 빼기]로 뗀다', (tester) async {
    final app = _state()..pending['c1'] = [_image('a.png'), _image('b.png')];
    await tester.pumpWidget(_wrap(app));

    await tester.tap(find.byKey(const Key('pending-open-b.png')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));

    expect(find.byKey(const Key('pending-viewer')), findsOneWidget);
    expect(find.text('b.png'), findsOneWidget);
    expect(find.text('2/2'), findsOneWidget);

    await tester.fling(find.byType(PageView), const Offset(600, 0), 2000);
    await tester.pump(const Duration(milliseconds: 600));
    expect(find.text('1/2'), findsOneWidget);
    expect(find.text('a.png'), findsOneWidget);

    await tester.tap(find.byKey(const Key('pending-viewer-remove')));
    await tester.pump();
    expect(app.pending['c1']!.map((p) => p.filename), ['b.png']);
    expect(find.text('1/1'), findsOneWidget);

    // 마지막 한 장을 빼면 작성칸으로 돌아간다.
    await tester.tap(find.byKey(const Key('pending-viewer-remove')));
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(find.byKey(const Key('pending-viewer')), findsNothing);
    expect(app.pending['c1'], isNull);
  });
}
