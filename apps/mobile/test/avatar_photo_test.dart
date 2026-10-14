import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/ui/parts.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 아바타가 **사진을 그리는지**(10-14 신고: 데스크톱에서 올린 사진이 모바일에선 늘 글자였다 — 그리는 부품이
/// `avatarAttachmentId` 를 아예 안 썼다). 사진 바이트는 시험에서 못 받으니(위젯 시험의 HTTP 는 막혀 있다) 사진
/// 위젯이 섰는지·주소에 첨부 id 가 실렸는지만 본다.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

MockClient _client() => MockClient((req) async {
      final path = req.url.path;
      if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
      if (path == '/channels') return _json({'channels': <Object?>[]});
      if (path == '/accounts') {
        return _json({
          'accounts': [
            {'id': 'me-1', 'handle': 'me', 'displayName': '나', 'kind': 'human', 'avatarAttachmentId': 'att-me'},
            {'id': 'forge', 'handle': 'forge', 'displayName': 'forge', 'kind': 'agent', 'avatarAttachmentId': null},
          ],
        });
      }
      if (path == '/reads') return _json({'reads': <Object?>[]});
      if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
      if (path == '/ws-ticket') return _json({'ticket': 'tk'});
      return _json({'error': {'code': 'not_found', 'message': path}}, 404);
    });

Future<AppState> _boot() async {
  final app = AppState(
    sessions: SessionStore.inMemory(
      seed: jsonEncode({
        'active': 'me-1',
        'communities': [
          {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
        ],
      }),
    ),
    apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: _client()),
    connector: (_) async => throw StateError('소켓 없음'),
  );
  await app.boot();
  return app;
}

void main() {
  testWidgets('사진이 걸린 계정은 사진을, 없는 계정은 글자를 그린다 — 다른 기기에서 바꾸면 바로 따라온다', (tester) async {
    final app = (await tester.runAsync(_boot))!;
    addTearDown(app.dispose);
    await tester.pumpWidget(MaterialApp(
      home: AppScope(
        state: app,
        child: const Row(children: [
          HarkroomAvatar(id: 'me-1', name: 'me'),
          HarkroomAvatar(id: 'forge', name: 'forge'),
        ]),
      ),
    ));

    final mine = tester.widget<Image>(find.byKey(const ValueKey('avatar-photo-att-me')));
    final url = (mine.image as NetworkImage).url;
    // 주소마다 첨부 id 가 실려야 사진을 바꿨을 때 이미지 캐시가 옛 사진을 내지 않는다.
    expect(url, 'https://h.example.com/accounts/me-1/avatar?v=att-me');
    expect((mine.image as NetworkImage).headers?['authorization'], 'Bearer tok');
    expect(find.byKey(const ValueKey('avatar-photo-att-forge')), findsNothing);
    expect(find.text('F'), findsOneWidget);

    app.applyEvent({'type': 'avatar.changed', 'accountId': 'forge', 'avatarAttachmentId': 'att-forge'});
    await tester.pump();
    expect(find.byKey(const ValueKey('avatar-photo-att-forge')), findsOneWidget);

    app.applyEvent({'type': 'avatar.changed', 'accountId': 'forge', 'avatarAttachmentId': null});
    await tester.pump();
    expect(find.byKey(const ValueKey('avatar-photo-att-forge')), findsNothing);
  });

  testWidgets('AppScope 가 없는 자리에서는 글자만 그린다', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: HarkroomAvatar(id: 'x', name: 'xena')));
    expect(find.text('X'), findsOneWidget);
  });
}
