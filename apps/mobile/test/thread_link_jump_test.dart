import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 긴 스레드(답글 59개, 줄마다 키가 크다)에서 링크로 들어가면 **그 줄이 화면에 선다** — 루트든 가운데 답글이든.
///
/// 2026-10-13 신고: #harkroom 스레드 루트 링크(답글 59개)를 누르면 스레드 한가운데에서 멈췄다. 목록은 화면 밖
/// 줄을 짓지 않아 한 화면씩 밀며 찾는데, 그 시도를 30번(약 24화면)으로 끊었고 빌드마다 찾기 사슬이 겹쳐
/// 그 30번을 나눠 썼다 — 줄이 긴 스레드에서는 루트에 닿기 전에 포기했다.

const _root = 'aaaaaaaa-0000-4000-8000-000000000000';
String _replyId(int seq) => 'bbbbbbbb-0000-4000-8000-${seq.toString().padLeft(12, '0')}';
const _rootSeq = 3;
// 답글 59개: seq 10..68.
final _replySeqs = [for (var s = 10; s < 69; s++) s];

http.Response _json(Object body) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), 200, headers: {'content-type': 'application/json'});

// 줄마다 표·목록이 든 긴 보고처럼 키가 크다(한 화면 남짓).
final _tall = List.generate(40, (i) => '줄 $i — 긴 보고 본문').join('\n\n');

Map<String, Object?> _row(String id, int seq, {String? root}) => {
      'id': id,
      'seq': seq,
      'channelId': 'c1',
      'threadRootId': root,
      'authorId': 'a1',
      'body': root == null ? '원글 $_tall' : '답글 $seq $_tall',
      'kind': 'user',
      'createdAt': DateTime.utc(2026, 10, 1).add(Duration(minutes: seq)).toIso8601String(),
    };

MockClient _client() => MockClient((req) async {
      final path = req.url.path;
      if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
      if (path == '/channels') {
        return _json({
          'channels': [
            {'id': 'c1', 'name': 'harkroom', 'kind': 'standard'},
          ],
        });
      }
      if (path == '/channels/c1/messages') {
        final q = req.url.queryParameters;
        if (q['thread'] == _root) {
          final limit = int.parse(q['limit'] ?? '100');
          final replies = [for (final s in _replySeqs) _row(_replyId(s), s, root: _root)];
          if (q['around'] != null) {
            // 서버(services/messages.ts)와 같은 창: around 이하 floor(limit/2), 초과 ceil(limit/2).
            final a = int.parse(q['around']!);
            final below = replies.where((m) => (m['seq']! as int) <= a).toList();
            final above = replies.where((m) => (m['seq']! as int) > a).take((limit / 2).ceil()).toList();
            final lower = below.length > limit ~/ 2 ? below.sublist(below.length - limit ~/ 2) : below;
            return _json({'messages': [_row(_root, _rootSeq), ...lower, ...above], 'hasMore': false});
          }
          if (q['before'] != null) {
            final b = int.parse(q['before']!);
            return _json({'messages': replies.where((m) => (m['seq']! as int) < b).toList(), 'hasMore': false});
          }
          return _json({'messages': [_row(_root, _rootSeq), ...replies], 'hasMore': false});
        }
        return _json({'messages': [_row(_root, _rootSeq)], 'hasMore': false});
      }
      if (path == '/ws-ticket') return _json({'ticket': 'tk'});
      if (path.contains('/agent-models') || path.contains('/auto-mentions')) {
        return _json({'agentModels': <Object?>[], 'autoMentions': <Object?>[]});
      }
      if (path == '/accounts') return _json({'accounts': <Object?>[]});
      if (path == '/reads') return _json({'reads': <Object?>[]});
      if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
      return _json({'messages': <Object?>[], 'hasMore': false});
    });

class _Idle implements WsConnection {
  final _c = StreamController<String>();
  @override
  int? get closeCode => null;
  @override
  Stream<String> get messages => _c.stream;
  @override
  void send(String payload) {}
  @override
  Future<void> close() async => _c.close();
}

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
    // 붙은 채 조용한 소켓 — 끊긴 소켓은 재접속 시계를 남겨 시험 끝에서 걸린다.
    connector: (_) async => _Idle(),
  );
  await app.boot();
  // 링크 길(`locateMessage`)이 루트를 넣어 두는 것과 같다.
  app.threadRoots[_root] = MessageRow.fromJson(_row(_root, _rootSeq));
  return app;
}

Future<void> _open(WidgetTester tester, AppState app, {required String id, required int seq}) async {
  tester.view.physicalSize = const Size(1290, 2796);
  tester.view.devicePixelRatio = 3;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(MaterialApp(
    theme: harkroomTheme(Brightness.light),
    builder: (context, child) => I18n(strings: stringsFor('ko'), child: AppScope(state: app, child: child!)),
    home: ThreadScreen(channelId: 'c1', rootId: _root, highlightId: id, highlightSeq: seq),
  ));
  // 가짜 HTTP 는 진짜 비동기다 — 답을 받게 하고 찾기 사슬이 끝날 때까지 프레임을 돌린다.
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 30)));
    for (var f = 0; f < 60; f++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
  }
  await tester.pump(const Duration(milliseconds: 500));
}

Future<void> _expectOnScreen(WidgetTester tester) async {
  final hit = find.byType(HitFlash);
  expect(hit, findsOneWidget, reason: '강조할 줄이 지어져 있어야 한다(화면 밖이면 지연 빌드라 없다)');
  final r = tester.getRect(hit);
  final screen = tester.getRect(find.byType(Scaffold).first);
  expect(r.overlaps(screen), isTrue, reason: '강조한 줄이 화면 안에 있어야 한다: $r / $screen');
  // 강조(2초) 시계를 흘려 보낸다.
  await tester.pumpWidget(const SizedBox());
  await tester.pump(const Duration(seconds: 5));
}

void main() {
  testWidgets('루트 링크 → 긴 스레드의 맨 위 원글이 화면에 선다', (tester) async {
    final app = await _boot();
    addTearDown(app.dispose);
    await _open(tester, app, id: _root, seq: _rootSeq);
    expect(find.textContaining('원글 줄 0'), findsOneWidget);
    await _expectOnScreen(tester);
  });

  testWidgets('가운데 답글 링크 → 그 답글이 화면에 선다', (tester) async {
    final app = await _boot();
    addTearDown(app.dispose);
    await _open(tester, app, id: _replyId(30), seq: 30);
    await _expectOnScreen(tester);
  });

  testWidgets('맨 처음 답글 링크 → 그 답글이 화면에 선다', (tester) async {
    final app = await _boot();
    addTearDown(app.dispose);
    await _open(tester, app, id: _replyId(10), seq: 10);
    await _expectOnScreen(tester);
  });
}
