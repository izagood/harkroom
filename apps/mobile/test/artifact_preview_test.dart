import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/artifact_preview.dart';
import 'package:harkroom/screens/attachments.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 미리보기 ⑤ — 카드·전체 화면·이동 판정. 사양 designer d8ca47be·abcc05cf, 조건 security(스레드 31121b84).

const _base = 'https://server.example.com';

AppState _state(http.Client client) {
  final s = AppState(
    sessions: SessionStore.inMemory(),
    apiFactory: (base, token) => ApiClient(baseUrl: base, token: token, httpClient: client),
    connector: (Uri _) async => throw StateError('시험에서는 소켓을 열지 않는다'),
  );
  s.setServer(_base);
  return s;
}

Widget _wrap(AppState state, Widget child) => MaterialApp(
      theme: harkroomTheme(Brightness.light),
      home: I18n(strings: stringsFor('ko'), child: AppScope(state: state, child: Scaffold(body: child))),
    );

AttachmentRow _page({String id = 'p1', int version = 1, int latest = 1, String title = 'Inbox 보드 시안 A', String? cover}) =>
    AttachmentRow(
      id: id,
      filename: 'board.html',
      contentType: 'text/html',
      byteSize: 2048,
      artifact: ArtifactRef(
        artifactId: 'art-1',
        version: version,
        latestVersion: latest,
        title: title,
        summary: '열 이름 정정',
        coverAttachmentId: cover,
      ),
    );

http.Client _server({int status = 201, List<String>? calls}) => MockClient((req) async {
      calls?.add('${req.method} ${req.url.path}');
      if (req.url.path.endsWith('/preview')) {
        if (status != 201) return http.Response(jsonEncode({'error': {'code': 'x', 'message': 'x'}}), status);
        return http.Response.bytes(
          utf8.encode(jsonEncode({'path': '/preview/tok${calls?.length ?? 0}', 'title': 'Inbox 보드 시안 A', 'version': 1})),
          201,
        );
      }
      return http.Response('not found', 404);
    });

void main() {
  group('이동 판정', () {
    const initial = '$_base/preview/tok';
    PreviewNavigation decide(String url, {bool main = true, bool loaded = false}) =>
        decidePreviewNavigation(requested: url, initial: initial, isMainFrame: main, initialLoaded: loaded);

    test('우리가 띄운 첫 로드만 받는다', () {
      expect(decide(initial), PreviewNavigation.allow);
    });
    test('페이지가 스스로 다른 http(s) 로 가면 막고 브라우저로 넘긴다', () {
      expect(decide('https://example.com/?q=x', loaded: true), PreviewNavigation.openOutside);
      expect(decide('https://example.com/'), PreviewNavigation.openOutside);
    });
    // security F1: 서명 URL·미리보기 경로는 어떤 경우에도 밖(사파리)으로 넘기지 않는다 — 막기만 한다.
    test('첫 로드가 끝난 뒤 같은 서명 URL 이 다시 오면 막기만 한다(밖으로 안 간다)', () {
      expect(decide(initial, loaded: true), PreviewNavigation.block);
    });
    test('다른 미리보기 경로는 첫 로드 전이라도 막기만 한다', () {
      expect(decide('$_base/preview/other'), PreviewNavigation.block);
      expect(decide('https://SERVER.example.com:443//preview/other', loaded: true), PreviewNavigation.block);
    });
    // security F1: WKWebView 가 돌려주는 주소는 글자가 다를 수 있다 — 정규화해 견준다.
    test('정규화만 다른 첫 로드는 허용한다', () {
      for (final u in [
        'https://SERVER.example.com/preview/tok',
        'https://server.example.com:443/preview/tok',
        'https://server.example.com//preview/tok',
      ]) {
        expect(decide(u), PreviewNavigation.allow, reason: u);
      }
      // scheme 만 바꾼 같은 서버의 미리보기 경로도 밖으로 넘기지 않는다(페이지는 자기 토큰을 안다).
      expect(decide('http://server.example.com/preview/tok'), PreviewNavigation.block);
      expect(decide('https://server.example.com:8443/preview/tok', loaded: true), PreviewNavigation.block);
    });
    test('하위 프레임은 전부 막는다', () {
      expect(decide(initial, main: false), PreviewNavigation.block);
      expect(decide('https://example.com/', main: false), PreviewNavigation.block);
    });
    test('http(s) 가 아닌 것은 막기만 한다', () {
      for (final u in ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'tel:123']) {
        expect(decide(u, loaded: true), PreviewNavigation.block, reason: u);
      }
    });
  });

  // security F2: 밖으로 넘기기 전에 묻는다. 묻는 동안 들어온 이동은 버린다.
  group('밖으로 넘기기', () {
    test('확인 전에는 열지 않고, [브라우저로 열기]를 눌러야 연다', () async {
      final launched = <Uri>[];
      final answer = Completer<bool>();
      final gate = OutsideNavigationGate(confirm: (_) => answer.future, launch: (u) async => launched.add(u));
      final pending = gate.handle(Uri.parse('https://example.com/a'));
      await Future<void>.delayed(Duration.zero);
      expect(launched, isEmpty);
      answer.complete(true);
      await pending;
      expect(launched, [Uri.parse('https://example.com/a')]);
    });
    test('[취소]면 열지 않는다', () async {
      final launched = <Uri>[];
      final gate = OutsideNavigationGate(confirm: (_) async => false, launch: (u) async => launched.add(u));
      await gate.handle(Uri.parse('https://example.com/a'));
      expect(launched, isEmpty);
    });
    test('물음이 떠 있는 동안의 이동은 조용히 버린다 — 사파리가 연달아 뜨지 않는다', () async {
      final asked = <Uri>[];
      final answer = Completer<bool>();
      final gate = OutsideNavigationGate(
        confirm: (u) { asked.add(u); return answer.future; },
        launch: (_) async {},
      );
      final first = gate.handle(Uri.parse('https://example.com/1'));
      expect(await gate.handle(Uri.parse('https://example.com/2')), isFalse);
      answer.complete(false);
      await first;
      expect(asked, [Uri.parse('https://example.com/1')]);
    });
    testWidgets('묻는 창은 호스트를 보인다', (tester) async {
      late BuildContext ctx;
      await tester.pumpWidget(_wrap(_state(_server()), Builder(builder: (c) { ctx = c; return const SizedBox(); })));
      final result = confirmLeavePreview(ctx, Uri.parse('https://evil.example.net/login?next=x'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('artifact-leave-dialog')), findsOneWidget);
      expect(find.text('이 페이지가 evil.example.net 로 이동하려 한다.'), findsOneWidget);
      await tester.tap(find.byKey(const Key('artifact-leave-cancel')));
      await tester.pumpAndSettle();
      expect(await result, isFalse);
    });
  });

  group('모델', () {
    test('첨부의 artifact 를 읽는다 — 없으면 null', () {
      final a = AttachmentRow.fromJson({
        'id': 'p1', 'filename': 'b.html', 'contentType': 'text/html', 'sizeBytes': 10,
        'artifact': {'artifactId': 'a', 'version': 2, 'latestVersion': 3, 'title': 'v2 제목', 'latestTitle': 'v3 제목', 'summary': null, 'coverAttachmentId': null},
      });
      expect(a.artifact!.version, 2);
      expect(a.artifact!.latestTitle, 'v3 제목');
      expect(AttachmentRow.fromJson({'id': 'n', 'filename': 'n.txt', 'contentType': 'text/plain', 'sizeBytes': 1}).artifact, isNull);
    });
  });

  group('카드', () {
    testWidgets('글 카드 — 제목·버전·요약·크기, 목록 안에 WebView 없음', (tester) async {
      await tester.pumpWidget(_wrap(_state(_server()), AttachmentStrip(attachments: [_page()])));
      expect(find.byKey(const Key('artifact-card-p1')), findsOneWidget);
      expect(find.text('Inbox 보드 시안 A'), findsOneWidget);
      expect(find.text('v1'), findsOneWidget);
      expect(find.text('열 이름 정정'), findsOneWidget);
      expect(find.text('HTML · 2.0 KB'), findsOneWidget);
      expect(find.byKey(const Key('artifact-card-cover')), findsNothing);
    });

    testWidgets('고쳐 올린 카드는 "이전 n개" 를, 옛 카드는 최신 알약을 단다', (tester) async {
      await tester.pumpWidget(_wrap(_state(_server()), AttachmentStrip(attachments: [_page(version: 3, latest: 3, title: '시안 B')])));
      expect(find.text('v3 · 이전 2개'), findsOneWidget);
      expect(find.byKey(const Key('artifact-card-latest')), findsNothing);
      await tester.pumpWidget(_wrap(_state(_server()), AttachmentStrip(attachments: [_page(latest: 3)])));
      expect(find.text('최신 v3 있음'), findsOneWidget);
      // 옛 카드의 제목은 그 버전 것이다.
      expect(find.text('Inbox 보드 시안 A'), findsOneWidget);
    });

    testWidgets('svg 표지는 그리지 않고, 표지 첨부를 따로 한 번 더 그리지 않는다', (tester) async {
      const svg = AttachmentRow(id: 'c1', filename: 'c.svg', contentType: 'image/svg+xml', byteSize: 5);
      await tester.pumpWidget(_wrap(_state(_server()), AttachmentStrip(attachments: [_page(cover: 'c1'), svg])));
      expect(find.byKey(const Key('artifact-card-cover')), findsNothing);
      expect(find.byKey(const Key('attachment-file-c1')), findsNothing);
    });
  });

  group('전체 화면', () {
    Widget screen(AppState s, {PreviewFrameBuilder? frame}) => _wrap(
          s,
          ArtifactScreen(
            attachment: _page(),
            frameBuilder: frame ?? (context, url, _) => Text('frame:$url', key: const Key('fake-frame')),
          ),
        );

    testWidgets('서명 경로를 받아 앱 서버 주소로 열고, 머리줄은 프레임 밖에 둔다', (tester) async {
      final calls = <String>[];
      await tester.pumpWidget(screen(_state(_server(calls: calls))));
      await tester.pumpAndSettle();
      expect(calls, ['POST /attachments/p1/preview']);
      expect(find.text('frame:$_base/preview/tok1'), findsOneWidget);
      expect(find.byKey(const Key('artifact-title')), findsOneWidget);
      expect(find.textContaining('에이전트가 만든 페이지'), findsOneWidget);
    });

    testWidgets('다시 불러오기는 새 서명 경로를 받는다(만료는 오류가 아니다)', (tester) async {
      final calls = <String>[];
      await tester.pumpWidget(screen(_state(_server(calls: calls))));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('artifact-reload')));
      await tester.pumpAndSettle();
      expect(calls.length, 2);
      expect(find.text('frame:$_base/preview/tok2'), findsOneWidget);
    });

    for (final (status, state) in [(413, 'tooLarge'), (403, 'forbidden'), (404, 'gone'), (500, 'failed')]) {
      testWidgets('열 수 없으면 이유를 말한다 ($status)', (tester) async {
        await tester.pumpWidget(screen(_state(_server(status: status))));
        await tester.pumpAndSettle();
        expect(find.byKey(Key('artifact-state-$state')), findsOneWidget);
        expect(find.byKey(const Key('fake-frame')), findsNothing);
      });
    }
  });
}
