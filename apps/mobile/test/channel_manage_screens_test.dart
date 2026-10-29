import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/i18n/i18n.dart';
import 'package:harkroom/screens/channel_list_screen.dart';
import 'package:harkroom/screens/channel_manage.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_scope.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/theme.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// 채널 만들기·정보·편집 화면(시안 v1 결정 1~10) — 손잡이는 능력이 있을 때만, 이름 칸은 입력 중 규칙에 맞춘다.

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status, headers: {'content-type': 'application/json'});

Map<String, Object?> _channel(String id, String name, {String visibility = 'public'}) => {
      'id': id,
      'name': name,
      'topic': '',
      'kind': 'standard',
      'repo': null,
      'archivedAt': null,
      'visibility': visibility,
      'createdAt': '2026-10-30T00:00:00.000Z',
    };

class _Server {
  _Server(this.capabilities, {this.admin = false, this.removeStatus = 200});

  final List<String> capabilities;
  final bool admin;
  final int removeStatus;
  final deletes = <String>[];
  final posts = <Map<String, Object?>>[];

  MockClient client() => MockClient((req) async {
        final path = req.url.path;
        if (path == '/auth/me') {
          return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': admin, 'capabilities': capabilities});
        }
        if (path == '/channels' && req.method == 'GET') {
          return _json({'channels': [_channel('c-1', 'general', visibility: 'private')]});
        }
        if (path == '/channels' && req.method == 'POST') {
          final b = jsonDecode(req.body) as Map<String, Object?>;
          posts.add(b);
          if (b['name'] == 'general') {
            return _json({'error': {'code': 'channel_name_taken', 'message': 'taken'}}, 409);
          }
          return _json(_channel('c-new', b['name'] as String), 201);
        }
        if (path == '/channels/c-1/members/o-1' && req.method == 'DELETE') {
          deletes.add(path);
          if (removeStatus != 200) return _json({'error': {'code': 'forbidden', 'message': 'no'}}, removeStatus);
          return _json({'members': [{'accountId': 'me-1', 'handle': 'me'}]});
        }
        if (path == '/channels/c-1/members') {
          return _json({'members': [{'accountId': 'me-1', 'handle': 'me'}, {'accountId': 'o-1', 'handle': 'other'}]});
        }
        if (path == '/accounts') {
          return _json({
            'accounts': [
              {'id': 'me-1', 'handle': 'me', 'displayName': '나', 'kind': 'human'},
              {'id': 'o-1', 'handle': 'other', 'displayName': '', 'kind': 'agent'},
            ],
          });
        }
        if (path == '/reads') return _json({'reads': <Object?>[]});
        if (path.startsWith('/inbox')) return _json({'entries': <Object?>[]});
        if (path == '/ws-ticket') return _json({'ticket': 'tk'});
        return _json({'error': {'code': 'not_found', 'message': path}}, 404);
      });
}

Future<AppState> _boot(WidgetTester tester, _Server server) async {
  final app = AppState(
    sessions: SessionStore.inMemory(
      seed: jsonEncode({
        'active': 'me-1',
        'communities': [
          {'accountId': 'me-1', 'baseUrl': 'https://h.example.com', 'token': 'tok', 'handle': 'me'},
        ],
      }),
    ),
    apiFactory: (b, t) => ApiClient(baseUrl: b, token: t, httpClient: server.client()),
    connector: (_) async => throw StateError('소켓 없음'),
  );
  await tester.runAsync(app.boot);
  return app;
}

Future<void> _pump(WidgetTester tester, AppState app, Widget child) => tester.pumpWidget(MaterialApp(
      theme: harkroomTheme(Brightness.light),
      home: I18n(strings: stringsFor('ko'), child: AppScope(state: app, child: child)),
    ));

TextEditingValue _type(String text) => const ChannelNameFormatter()
    .formatEditUpdate(TextEditingValue.empty, TextEditingValue(text: text, selection: TextSelection.collapsed(offset: text.length)));

void main() {
  group('이름 칸 규칙(결정 3)', () {
    test('대문자는 소문자, 띄어쓰기는 - 로 바로 바꾼다', () {
      expect(_type('RCMS Deploy').text, 'rcms-deploy');
      expect(_type('a\tB').text, 'a-b');
    });

    test('바꿀 수 없는 글자는 지우지 않고 남긴다 — 길이·커서가 그대로다', () {
      final v = _type('배포 Review');
      expect(v.text, '배포-review');
      expect(v.selection.baseOffset, '배포 Review'.length);
    });

    test('한글 조합 중에도 조합 범위를 잃지 않는다', () {
      const composing = TextEditingValue(
        text: 'A한',
        selection: TextSelection.collapsed(offset: 2),
        composing: TextRange(start: 1, end: 2),
      );
      final v = const ChannelNameFormatter().formatEditUpdate(TextEditingValue.empty, composing);
      expect(v.text, 'a한');
      expect(v.composing, const TextRange(start: 1, end: 2));
    });

    test('빨간 줄: 쓸 수 없는 글자 · 48자 넘음, 빈 칸과 맞는 이름은 없음', () {
      final t = stringsFor('ko');
      expect(channelNameProblem(t, ''), isNull);
      expect(channelNameProblem(t, 'design-review_2'), isNull);
      expect(channelNameProblem(t, '배포-검토'), t.chNameBadChars);
      expect(channelNameProblem(t, 'a' * 49), t.chNameTooLong);
    });
  });

  testWidgets('홈 머리 ＋ 는 channel.create 가 있을 때만 선다(결정 1·10)', (tester) async {
    final without = await _boot(tester, _Server(const []));
    await _pump(tester, without, const Scaffold(body: ChannelListScreen()));
    expect(find.byKey(const Key('new-channel')), findsNothing);

    final withCap = await _boot(tester, _Server(const ['channel.create']));
    await _pump(tester, withCap, const Scaffold(body: ChannelListScreen()));
    expect(find.byKey(const Key('new-channel')), findsOneWidget);
  });

  testWidgets('새 채널: 입력하며 바꾸고, 못 쓰는 글자면 [만들기]가 꺼지고 빨간 줄', (tester) async {
    final app = await _boot(tester, _Server(const ['channel.create']));
    await _pump(tester, app, const NewChannelScreen());
    final create = find.byKey(const Key('new-channel-create'));
    expect(tester.widget<TextButton>(create).onPressed, isNull, reason: '빈 이름');

    await tester.enterText(find.byKey(const Key('new-channel-name')), 'Design Review');
    await tester.pump();
    expect(find.text('design-review'), findsOneWidget);
    expect(tester.widget<TextButton>(create).onPressed, isNotNull);

    await tester.enterText(find.byKey(const Key('new-channel-name')), '배포');
    await tester.pump();
    expect(find.text(stringsFor('ko').chNameBadChars), findsOneWidget);
    expect(tester.widget<TextButton>(create).onPressed, isNull);
  });

  testWidgets('새 채널: 이름 중복 409 는 칸 아래 빨간 줄, 칸 값은 그대로', (tester) async {
    final server = _Server(const ['channel.create']);
    final app = await _boot(tester, server);
    await _pump(tester, app, const NewChannelScreen());
    await tester.enterText(find.byKey(const Key('new-channel-name')), 'general');
    await tester.pump();
    await tester.runAsync(() async {
      await tester.tap(find.byKey(const Key('new-channel-create')));
      await Future<void>.delayed(const Duration(milliseconds: 50));
    });
    await tester.pump();
    expect(server.posts.single['name'], 'general');
    expect(find.text(stringsFor('ko').chNameTaken), findsOneWidget);
    expect(find.text('general'), findsOneWidget);
  });

  testWidgets('채널 정보: channel.manage 없으면 [편집]·보관이 숨는다(결정 10), 삭제는 없다(결정 8)', (tester) async {
    final app = await _boot(tester, _Server(const []));
    await _pump(tester, app, const ChannelInfoScreen(channelId: 'c-1'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    expect(find.byKey(const Key('channel-info-edit')), findsNothing);
    expect(find.byKey(const Key('channel-info-archive')), findsNothing);
    expect(find.byKey(const Key('channel-info-delete')), findsNothing);
    expect(find.byKey(const Key('channel-info-leave')), findsOneWidget);
  });

  testWidgets('채널 정보: channel.manage 가 있으면 [편집]·보관이 선다', (tester) async {
    final app = await _boot(tester, _Server(const ['channel.manage']));
    await _pump(tester, app, const ChannelInfoScreen(channelId: 'c-1'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    expect(find.byKey(const Key('channel-info-edit')), findsOneWidget);
    expect(find.byKey(const Key('channel-info-archive')), findsOneWidget);
  });

  testWidgets('채널 편집: 공개 범위는 읽기 전용 줄로만 보인다(결정 7)', (tester) async {
    final app = await _boot(tester, _Server(const ['channel.manage']));
    final channel = app.channels.firstWhere((c) => c.id == 'c-1');
    await _pump(tester, app, ChannelEditScreen(channel: channel));
    expect(find.byKey(const Key('channel-edit-visibility')), findsOneWidget);
    expect(find.text(stringsFor('ko').chVisibilityDesktopOnly), findsOneWidget);
    expect(find.byType(SegmentedButton<bool>), findsNothing);
  });

  testWidgets('비공개 채널 머리는 # 대신 🔒(designer #1675 #1)', (tester) async {
    final app = await _boot(tester, _Server(const []));
    final channel = app.channels.firstWhere((c) => c.id == 'c-1');
    await _pump(tester, app, Scaffold(appBar: AppBar(title: ChannelTitleButton(channel: channel))));
    expect(find.text('🔒 general'), findsOneWidget);
    expect(find.text('# general'), findsNothing);
  });

  for (final refused in [false, true]) {
    testWidgets('밀어 내보내기: 서버가 ${refused ? '거절하면 줄이 남는다' : '받으면 줄이 빠진다'}(security #1675 s2)', (tester) async {
      final server = _Server(const ['channel.manage'], admin: true, removeStatus: refused ? 403 : 200);
      final app = await _boot(tester, server);
      await _pump(tester, app, const ChannelInfoScreen(channelId: 'c-1'));
      await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
      await tester.pump();
      expect(find.byKey(const Key('channel-member-o-1')), findsOneWidget);

      await tester.drag(find.byKey(const Key('channel-member-dismiss-o-1')), const Offset(-600, 0));
      await tester.pumpAndSettle();
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const Key('channel-confirm-ok')));
        await Future<void>.delayed(const Duration(milliseconds: 50));
      });
      await tester.pumpAndSettle();
      expect(server.deletes, ['/channels/c-1/members/o-1']);
      expect(find.byKey(const Key('channel-member-o-1')), refused ? findsOneWidget : findsNothing);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets('새 채널: 공개·비공개 모두 설명 줄이 선다(designer n1)', (tester) async {
    final app = await _boot(tester, _Server(const ['channel.create']));
    await _pump(tester, app, const NewChannelScreen());
    final t = stringsFor('ko');
    expect(find.text(t.chPublicHint), findsOneWidget);
    await tester.tap(find.byKey(const Key('new-channel-private')));
    await tester.pump();
    expect(find.text(t.chPrivateHint), findsOneWidget);
    expect(find.text(t.chPublicHint), findsNothing);
  });

  testWidgets('채널 정보: 에이전트 계정 멤버 줄에만 smart_toy 가 뜬다(n7)', (tester) async {
    final app = await _boot(tester, _Server(const []));
    await _pump(tester, app, const ChannelInfoScreen(channelId: 'c-1'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 50)));
    await tester.pump();
    Finder bot(String id) =>
        find.descendant(of: find.byKey(Key('channel-member-$id')), matching: find.byIcon(Icons.smart_toy_outlined));
    expect(bot('o-1'), findsOneWidget);
    expect(bot('me-1'), findsNothing);
  });
}
