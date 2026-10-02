import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/message_feed.dart';
import 'package:harkroom/screens/message_list_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:harkroom/screens/message_tile.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 찾은 줄 강조(`mark`)는 **그 줄에만** 씌운다 — 날짜 구분선까지 번쩍이면 무엇을 찾았는지 흐려진다
/// (designer 찾기 F2 n1).
void main() {
  testWidgets('날짜가 바뀌는 줄을 강조해도 날짜 구분선은 강조 밖이다', (tester) async {
    final state = AppState(
      sessions: SessionStore.inMemory(),
      apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: MockClient((_) async => http.Response('{}', 404))),
      connector: (Uri _) async => throw StateError('소켓을 열지 않는다'),
    );
    addTearDown(state.dispose);
    final m = MessageRow.fromJson({
      'id': 'm1',
      'seq': 1,
      'channelId': 'c1',
      'authorId': 'a1',
      'body': '찾은 답글',
      'kind': 'user',
      'createdAt': DateTime.utc(2026, 9, 1).toIso8601String(),
    });
    await tester.pumpWidget(MaterialApp(
      theme: harkroomTheme(Brightness.light),
      home: I18n(
        strings: stringsFor('ko'),
        child: AppScope(
          state: state,
          child: Scaffold(
            body: Builder(
              builder: (context) => buildFeedItem(
                context,
                FeedMessage(m, dayBreak: true),
                mark: (row) => KeyedSubtree(key: const Key('marked'), child: row),
              ),
            ),
          ),
        ),
      ),
    ));
    expect(find.byType(DayDivider), findsOneWidget);
    expect(find.descendant(of: find.byKey(const Key('marked')), matching: find.byType(DayDivider)), findsNothing);
    expect(find.descendant(of: find.byKey(const Key('marked')), matching: find.text('찾은 답글')), findsOneWidget);
  });
}
