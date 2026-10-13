import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 스레드 화면이 에이전트 주고받기를 **판정대로** 접어 그리는지 — 판정 자체는 계약 시험
/// (`agent_exchange_contract_test.dart`)이 데스크톱 표로 지킨다. 여기서는 화면이 그 판정을 쓰는지,
/// 접힌 줄을 누르면 펼쳐지고 다시 누르면 접히는지, 찾기·링크로 온 줄이 접힌 구간 안이면 펼친 채 여는지를 본다.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

// 원글은 에이전트(forge) 것이다 — 원글이 사람이면 첫 답 예외가 어떻게 걸리는지가 jaebin 결정 대기라
// (스레드 d2e624cd A/B) 그 갈래에 기대지 않는 모양으로 짠다.
const _rows = [
  ('root', 'forge', '원글: 테스트 돌려 줘'),
  ('r2', 'codex', '돌리는 중이다'),
  ('r3', 'forge', '실패 둘 고쳤다'),
  ('r4', 'codex', '다시 돌렸다 전부 통과'),
  ('r5', 'me-1', '사람 말: 고마워'),
];

MockClient _client() => MockClient((req) async {
      final path = req.url.path;
      if (path == '/auth/me') return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
      if (path == '/channels') return _json({'channels': [{'id': 'c1', 'name': 'task', 'kind': 'standard'}]});
      if (path == '/accounts') {
        return _json({
          'accounts': [
            {'id': 'me-1', 'handle': 'me', 'displayName': '나', 'kind': 'human'},
            {'id': 'forge', 'handle': 'forge', 'displayName': 'forge', 'kind': 'agent'},
            {'id': 'codex', 'handle': 'codex', 'displayName': 'codex', 'kind': 'agent'},
          ],
        });
      }
      if (path == '/reads') return _json({'reads': <Object?>[]});
      if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
      if (path.contains('/agent-models') || path.contains('/auto-mentions')) {
        return _json({'agentModels': <Object?>[], 'autoMentions': <Object?>[]});
      }
      if (path == '/channels/c1/messages') {
        if (req.url.queryParameters['thread'] != 'root') return _json({'messages': <Object?>[], 'hasMore': false});
        var seq = 0;
        return _json({
          'messages': [
            for (final (id, author, body) in _rows)
              {
                'id': id,
                'seq': ++seq,
                'channelId': 'c1',
                'threadRootId': id == 'root' ? null : 'root',
                'authorId': author,
                'body': body,
                'kind': 'user',
                'replyCount': id == 'root' ? _rows.length - 1 : null,
                'createdAt': DateTime.utc(2026, 10, 13, 9).add(Duration(minutes: seq)).toIso8601String(),
              },
          ],
          'hasMore': false,
        });
      }
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

Future<void> _open(WidgetTester tester, {String? highlightId, int? highlightSeq}) async {
  final app = (await tester.runAsync(_boot))!;
  addTearDown(app.dispose);
  await tester.pumpWidget(MaterialApp(
    theme: harkroomTheme(Brightness.light),
    builder: (context, child) => I18n(strings: stringsFor('ko'), child: AppScope(state: app, child: child!)),
    home: ThreadScreen(channelId: 'c1', rootId: 'root', highlightId: highlightId, highlightSeq: highlightSeq),
  ));
  await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
  await tester.pump();
  await tester.pump(const Duration(milliseconds: 400));
  expect(app.threadLoad['root'], LoadState.loaded);
}

final _fold = find.byKey(const Key('exchange-r2'));

void main() {
  testWidgets('에이전트끼리 주고받은 답글은 한 줄로 접히고, 원글과 사람 말은 그대로 선다', (tester) async {
    await _open(tester);
    expect(_fold, findsOneWidget);
    // 접힌 줄: 참여자 → 마지막 말 → 횟수.
    final line = tester.widget<Text>(find.descendant(of: _fold, matching: find.byType(Text))).textSpan!.toPlainText();
    expect(line, contains('codex ↔ forge'));
    expect(line, contains('다시 돌렸다 전부 통과'));
    expect(line, contains(stringsFor('ko').exchangeCount(3)));
    for (final hidden in ['돌리는 중이다', '실패 둘 고쳤다']) {
      expect(find.textContaining(hidden), findsNothing, reason: hidden);
    }
    expect(find.textContaining('원글: 테스트 돌려 줘'), findsOneWidget);
    expect(find.textContaining('사람 말: 고마워'), findsOneWidget);
  });

  testWidgets('접힌 줄을 누르면 펼쳐지고, 다시 누르면 접힌다', (tester) async {
    await _open(tester);
    await tester.tap(_fold);
    await tester.pump();
    for (final shown in ['돌리는 중이다', '실패 둘 고쳤다']) {
      expect(find.textContaining(shown), findsOneWidget, reason: shown);
    }
    expect(tester.widget<Semantics>(find.ancestor(of: _fold, matching: find.byType(Semantics)).first).properties.expanded, isTrue);
    await tester.tap(_fold);
    await tester.pump();
    expect(find.textContaining('돌리는 중이다'), findsNothing);
  });

  testWidgets('찾기·링크로 온 줄이 접힌 구간 안이면 펼친 채 연다', (tester) async {
    await _open(tester, highlightId: 'r3', highlightSeq: 3);
    expect(_fold, findsOneWidget);
    expect(find.textContaining('실패 둘 고쳤다'), findsOneWidget);
    // 강조가 걸린 동안은 눌러도 닫히지 않는다 — 가리킨 줄이 사라지면 안 된다.
    await tester.tap(_fold);
    await tester.pump();
    expect(find.textContaining('실패 둘 고쳤다'), findsOneWidget);
  });
}
