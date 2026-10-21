import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/screens/channel_list_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// S4: 서버 섹션 표(0.4.140~) 위의 홈 — 순서·빈 섹션·접기(서버 저장)·D4·길게 눌러 옮기기·작은 폰 시트.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

class _Idle implements WsConnection {
  final _ctrl = StreamController<String>();
  @override
  int? get closeCode => null;
  @override
  Stream<String> get messages => _ctrl.stream;
  @override
  void send(String payload) {}
  @override
  Future<void> close() async {
    if (!_ctrl.isClosed) await _ctrl.close();
  }
}


/// 섹션 12개 — 시트가 작은 폰에서 스크롤돼야 하는 수.
final _sections = [
  for (var i = 0; i < 12; i++) {'id': 's$i', 'name': i == 0 ? '회사' : i == 1 ? '개인' : '섹션 $i', 'position': i, 'collapsed': false},
];

class _Server {
  final calls = <String>[];
  final bodies = <Object?>[];
  bool withSections = true;
  bool inboxMentionC2 = false;

  MockClient get client => MockClient((req) async {
        final path = req.url.path;
        if (req.method != 'GET') {
          calls.add('${req.method} $path');
          bodies.add(req.body.isEmpty ? null : jsonDecode(req.body));
        }
        if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': 'me', 'isAdmin': false});
        if (path == '/channels') {
          return _json({
            'channels': [
              {'id': 'c1', 'name': 'cmdb', 'kind': 'standard'},
              {'id': 'c2', 'name': 'rcms', 'kind': 'standard'},
              {'id': 'c3', 'name': 'harkroom', 'kind': 'standard'},
              {'id': 'c4', 'name': 'study', 'kind': 'standard'},
            ],
          });
        }
        if (path == '/dms') return _json({'dms': <Object?>[]});
        if (path == '/accounts') return _json({'accounts': <Object?>[]});
        if (path == '/reads') {
          return _json({
            'reads': [
              {'channelId': 'c1', 'lastReadSeq': 0, 'unread': 1},
              {'channelId': 'c2', 'lastReadSeq': 0, 'unread': 4},
            ],
          });
        }
        if (path == '/channels/prefs') {
          return _json({
            'prefs': [
              {'channelId': 'c1', 'section': '회사', 'sectionId': 's0'},
              {'channelId': 'c2', 'section': '회사', 'sectionId': 's0'},
              {'channelId': 'c3', 'section': '개인', 'sectionId': 's1'},
            ],
            if (withSections) 'sections': _sections,
          });
        }
        if (path == '/channel-sections' && req.method == 'POST') {
          return _json({'section': {'id': 'snew', 'name': (jsonDecode(req.body) as Map)['name'], 'position': 12, 'collapsed': false}}, 201);
        }
        if (path.startsWith('/channel-sections/') || path.endsWith('/pref')) return _json({});
        if (path.startsWith('/inbox')) {
          return _json({
            'entries': [
              if (inboxMentionC2)
                {'id': 1, 'messageId': 'm1', 'reason': 'mention', 'channelId': 'c2', 'body': 'hi',
                 'createdAt': '2026-10-21T00:00:00Z', 'readAt': null},
            ],
          });
        }
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
        return _json({'error': {'code': 'not_found', 'message': path}}, 404);
      });
}

Future<AppState> _pump(WidgetTester tester, _Server server) async {
  final app = AppState(
    sessions: SessionStore.inMemory(
      seed: jsonEncode({
        'active': 'me-1',
        'communities': [
          {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
        ],
      }),
    ),
    apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: server.client),
    connector: (_) async => _Idle(),
  );
  addTearDown(app.dispose);
  await tester.pumpWidget(HarkroomApp(state: app));
  await tester.pumpAndSettle();
  return app;
}

void main() {
  test('homeSections: 서버 섹션은 position 순, 빈 섹션도 서고, 모르는 id 는 「채널」 로', () {
    ChannelRow c(String id) => ChannelRow.fromJson({'id': id, 'name': id, 'kind': 'standard'});
    final prefs = {
      'a': ChannelPref.fromJson({'channelId': 'a', 'section': 'B', 'sectionId': 'sb'}),
      'b': ChannelPref.fromJson({'channelId': 'b', 'section': 'X', 'sectionId': 'gone'}),
    };
    final secs = homeSections([c('a'), c('b')], prefs, sections: const [
      ChannelSection(id: 'sb', name: 'B', position: 1, collapsed: false),
      ChannelSection(id: 'sa', name: 'A', position: 0, collapsed: false),
    ]);
    expect(secs.map((s) => s.key), ['sid:sa', 'sid:sb', 'channels']);
    expect(secs[0].channels, isEmpty);
    expect(secs[1].channels.map((x) => x.id), ['a']);
    expect(secs[2].channels.map((x) => x.id), ['b']);
  });

  testWidgets('접기는 서버에 적고, 접혀도 부름 채널은 남고 숨은 안 읽음은 머리에 점', (tester) async {
    final server = _Server()..inboxMentionC2 = true;
    final app = await _pump(tester, server);
    expect(find.byKey(const Key('section-empty-sid:s2')), findsOneWidget, reason: '빈 섹션은 안내 한 줄');
    await tester.tap(find.byKey(const Key('section-sid:s0')));
    await tester.pumpAndSettle();
    expect(server.calls, contains('PATCH /channel-sections/s0'));
    expect(server.bodies.last, {'collapsed': true});
    expect(app.isSectionCollapsed('sid:s0'), isTrue);
    expect(find.byKey(const Key('channel-c2')), findsOneWidget, reason: '멘션 온 rcms 는 남는다');
    expect(find.byKey(const Key('channel-c1')), findsNothing, reason: '점만 있는 cmdb 는 숨는다');
    expect(find.byKey(const Key('section-dot-sid:s0')), findsOneWidget);
  });

  testWidgets('옛 서버(sections 없음)면 이름으로 묶고 길게 눌러도 시트가 없다', (tester) async {
    final server = _Server()..withSections = false;
    final app = await _pump(tester, server);
    expect(app.sections, isNull);
    expect(find.byKey(const Key('section-section:회사')), findsOneWidget);
    await tester.longPress(find.byKey(const Key('channel-c4')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('section-move-sheet')), findsNothing);
  });

  for (final scale in [1.0, 1.3]) {
    testWidgets('작은 폰(375×667, 글자 ×$scale): 길게 누르기 시트가 넘치지 않고 스크롤되며 옮기기를 적는다', (tester) async {
      tester.view.physicalSize = const Size(750, 1334);
      tester.view.devicePixelRatio = 2.0;
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.view.reset);
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      final server = _Server();
      final app = await _pump(tester, server);
      // 글자 ×1.3 에서 **하단 탭 바**(home_screen.dart)가 16px 넘친다 — 이 PR 전부터 있던 일이라 걷어 낸다(PR 본문에 적었다).
      // 그래서 ×1.3 의 시트 넘침은 아래 크기·스크롤로 잰다. ×1.0 에서는 예외가 하나도 없어야 한다.
      final pre = tester.takeException();
      if (scale == 1.0) expect(pre, isNull);

      await tester.longPress(find.byKey(const Key('channel-c3')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('section-move-sheet')), findsOneWidget);
      final atSheet = tester.takeException();
      if (scale == 1.0) expect(atSheet, isNull, reason: '시트에 RenderFlex 넘침 없음');
      final sheet = tester.getRect(find.byKey(const Key('section-move-sheet')));
      expect(sheet.bottom, lessThanOrEqualTo(667));
      expect(sheet.height, lessThanOrEqualTo(667 * 0.8 + 0.5));
      // 지금 섹션(개인)에 ✓, 맨 아래 「섹션에서 빼기」 는 굴려서 닿는다.
      expect(find.descendant(of: find.byKey(const Key('section-move-s1')), matching: find.byIcon(Icons.check)), findsOneWidget);
      await tester.scrollUntilVisible(find.byKey(const Key('section-move-remove')), 80,
          scrollable: find.descendant(of: find.byKey(const Key('section-move-sheet')), matching: find.byType(Scrollable)));
      await tester.ensureVisible(find.byKey(const Key('section-move-remove')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('section-move-remove')));
      await tester.pumpAndSettle();
      tester.takeException();
      final i = server.calls.indexOf('PATCH /channels/c3/pref');
      expect(i, isNot(-1));
      expect(server.bodies[i], {'sectionId': null});
      expect(app.channelPrefs['c3']?.sectionId, isNull);
    });
  }

  testWidgets('「새 섹션…」 은 이름을 받아 만들면서 그 채널을 넣는다', (tester) async {
    final server = _Server();
    final app = await _pump(tester, server);
    await tester.longPress(find.byKey(const Key('channel-c1')));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.byKey(const Key('section-move-new')), 80,
        scrollable: find.descendant(of: find.byKey(const Key('section-move-sheet')), matching: find.byType(Scrollable)));
    await tester.tap(find.byKey(const Key('section-move-new')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('section-new-name')), '  실험 ');
    await tester.tap(find.byKey(const Key('section-new-create')));
    await tester.pumpAndSettle();
    expect(server.calls.last, 'POST /channel-sections');
    expect(server.bodies.last, {'name': '실험', 'channelIds': ['c1']});
    expect(app.channelPrefs['c1']?.sectionId, 'snew');
    expect(app.sections!.last.name, '실험');
  });
}
