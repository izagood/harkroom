import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/channel_list_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 채널 줄의 공개 범위·보관 — 서버 `ChannelRow` 는 `visibility`·`archivedAt` 을 싣는다(`isPrivate` 칸은 없다).

http.Response _json(Object body) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), 200, headers: {'content-type': 'application/json'});

Map<String, Object?> _ch(String id, {String visibility = 'public', String? archivedAt}) =>
    {'id': id, 'name': id, 'kind': 'standard', 'topic': '', 'visibility': visibility, 'archivedAt': archivedAt};

void main() {
  group('ChannelRow.fromJson', () {
    test('visibility private 이면 비공개다', () {
      expect(ChannelRow.fromJson(_ch('a', visibility: 'private')).isPrivate, isTrue);
      expect(ChannelRow.fromJson(_ch('a')).isPrivate, isFalse);
    });

    test('서버가 주지 않는 isPrivate 칸은 읽지 않는다', () {
      expect(ChannelRow.fromJson({..._ch('a'), 'isPrivate': true}).isPrivate, isFalse);
    });

    test('archivedAt 이 있으면 보관된 채널이다', () {
      expect(ChannelRow.fromJson(_ch('a', archivedAt: '2026-10-01T00:00:00Z')).isArchived, isTrue);
      expect(ChannelRow.fromJson(_ch('a')).isArchived, isFalse);
    });

    test('withName 은 보관 표시를 잃지 않는다', () {
      final row = ChannelRow.fromJson(_ch('a', visibility: 'private', archivedAt: '2026-10-01T00:00:00Z')).withName('b');
      expect(row.isArchived, isTrue);
      expect(row.isPrivate, isTrue);
    });
  });

  testWidgets('홈 목록: 비공개는 자물쇠, 보관된 채널은 빠지되 채널 표에는 남는다', (tester) async {
    final client = MockClient((req) async {
      final path = req.url.path;
      if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
      if (path == '/channels') {
        return _json({
          'channels': [
            _ch('open'),
            _ch('secret', visibility: 'private'),
            _ch('old', archivedAt: '2026-10-01T00:00:00Z'),
          ],
        });
      }
      if (path == '/accounts') return _json({'accounts': <Object?>[]});
      if (path == '/reads') return _json({'reads': <Object?>[]});
      if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
      if (path == '/ws-ticket') return _json({'ticket': 'tk'});
      return http.Response('{"error":{"code":"not_found"}}', 404);
    });
    final app = AppState(
      sessions: SessionStore.inMemory(
        seed: jsonEncode({
          'active': 'me-1',
          'communities': [
            {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
          ],
        }),
      ),
      apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: client),
      connector: (_) async => throw StateError('소켓 없음'),
    );
    await tester.runAsync(app.boot);
    await tester.pumpWidget(MaterialApp(
      theme: harkroomTheme(Brightness.light),
      home: I18n(
        strings: stringsFor('ko'),
        child: AppScope(state: app, child: const Scaffold(body: ChannelListScreen())),
      ),
    ));
    await tester.pump();

    expect(find.byKey(const Key('channel-open')), findsOneWidget);
    expect(find.byKey(const Key('channel-secret')), findsOneWidget);
    expect(find.byKey(const Key('channel-old')), findsNothing, reason: '보관된 채널은 홈 목록에 서지 않는다');
    expect(app.channels.any((c) => c.id == 'old'), isTrue, reason: '링크·검색이 이름을 찾도록 표에는 남긴다');
    expect(
      find.descendant(of: find.byKey(const Key('channel-secret')), matching: find.byIcon(Icons.lock_outline)),
      findsOneWidget,
    );
    expect(
      find.descendant(of: find.byKey(const Key('channel-open')), matching: find.byIcon(Icons.tag)),
      findsOneWidget,
    );
  });
}
