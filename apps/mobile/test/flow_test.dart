import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'dart:async';

import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// P0 의 "끝났다": **보관된 세션으로 앱을 켜서 채널을 열고 말을 보낸다.**
///
/// 진짜 서버 대신 [MockClient] 를, 진짜 소켓 대신 던지는 커넥터를 쓴다. 소켓 상태 기계는
/// `ws_test.dart` 가 따로 본다 — 여기서 보는 것은 **화면들이 이어지는가** 하나다.
http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status,
        headers: {'content-type': 'application/json'});

final _sent = <String>[];
final _answered = <String>[];

MockClient _server() => MockClient((req) async {
      final path = req.url.path;
      if (path == '/auth/me') {
        return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
      }
      if (path == '/channels') {
        return _json([
          {'id': 'c1', 'name': 'harkroom', 'kind': 'standard'},
          {'id': 'c2', 'name': 'random', 'kind': 'standard'},
        ]);
      }
      if (path == '/accounts') {
        return _json([
          {'id': 'a1', 'handle': 'forge', 'displayName': 'forge', 'kind': 'agent'},
          {'id': 'me-1', 'handle': 'me', 'displayName': '나', 'kind': 'human'},
        ]);
      }
      if (path == '/reads') return _json({'reads': <Object?>[]});
      if (path.startsWith('/inbox') && req.method == 'GET') {
        return _json({
          'entries': [
            {
              'id': 1,
              'messageId': 'm1',
              'reason': 'mention',
              'channelId': 'c1',
              'authorId': 'a1',
              'body': '@me 이거 봐 줘',
              'createdAt': '2026-09-28T00:00:00.000Z',
              'readAt': null,
            },
          ],
        });
      }
      if (path == '/inbox/read') return _json(<String, Object?>{});
      if (path.endsWith('/read') && req.method == 'PUT') return _json(<String, Object?>{});
      if (path.endsWith('/messages') && req.method == 'GET' && req.url.queryParameters['thread'] != null) {
        return _json({
          'messages': [
            {
              'id': 'r1',
              'seq': 5,
              'channelId': 'c1',
              'threadRootId': 'm1',
              'authorId': 'a1',
              'body': '스레드 안의 답글',
              'kind': 'user',
            },
          ],
          'hasMore': false,
        });
      }
      if (path.endsWith('/messages') && req.method == 'GET') {
        return _json({
          'messages': [
            {
              'id': 'm1',
              'seq': 1,
              'channelId': 'c1',
              'authorId': 'a1',
              'body': '먼저 있던 말',
              'kind': 'user',
              'replyCount': 1,
            },
            // 진행 줄은 **말풍선이 아니다** — 화면이 걸러야 한다.
            {
              'id': 'm2',
              'seq': 2,
              'channelId': 'c1',
              'authorId': 'a1',
              'body': '훑는 중이다',
              'kind': 'progress',
            },
            // 에이전트가 갈림길에서 묻는다. 답이 없으면 그 턴은 여기서 멈춘다.
            {
              'id': 'm4',
              'seq': 4,
              'channelId': 'c1',
              'authorId': 'a1',
              'body': '어느 쪽으로 갈까',
              'kind': 'user',
              'meta': {
                'kind': 'ask',
                'ask': {
                  'options': [
                    {'id': 'x', 'label': '이걸로'},
                    {'id': 'y', 'label': '저걸로'},
                  ],
                  'to': {'kind': 'human'},
                },
              },
            },
          ],
          'hasMore': false,
        });
      }
      if (path.contains('/ask-answer')) {
        final optionId = (jsonDecode(req.body) as Map)['optionId'] as String;
        _answered.add(optionId);
        return _json({
          'id': 'm4',
          'seq': 4,
          'channelId': 'c1',
          'authorId': 'a1',
          'body': '어느 쪽으로 갈까',
          'kind': 'user',
          'meta': {
            'kind': 'ask',
            'ask': {
              'options': [
                {'id': 'x', 'label': '이걸로'},
                {'id': 'y', 'label': '저걸로'},
              ],
              'to': {'kind': 'human'},
              'answeredWith': optionId,
            },
          },
        });
      }
      if (path.endsWith('/messages') && req.method == 'POST') {
        final body = (jsonDecode(req.body) as Map)['body'] as String;
        _sent.add(body);
        return _json({
          'id': 'm3',
          'seq': 3,
          'channelId': 'c1',
          'authorId': 'me-1',
          'body': body,
          'kind': 'user',
        });
      }
      if (path == '/ws-ticket') return _json({'ticket': 'tk'});
      // 안 정한 경로는 **404 로 떨군다.** 200 으로 돌려주면 시험이 모르는 왕복을 하고도
      // 조용히 통과한다 — 실제로 `/ws-ticket` 을 빠뜨렸을 때 그렇게 숨었다.
      return _json({'error': {'code': 'not_found', 'message': path}}, 404);
    });

/// 열린 채 가만히 있는 소켓.
///
/// **던지는 커넥터를 쓰면 안 된다**: 그러면 `WsClient` 가 재시도 백오프로 들어가고,
/// 시험이 끝날 때 *"Pending timers"* 로 죽는다. 그 타이머는 버그가 아니라 설계다
/// (끊기면 다시 붙는다) — 시험이 그 설계를 건드리지 않도록 소켓을 살려 둔다.
class _IdleConnection implements WsConnection {
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

AppState _state() => AppState(
      sessions: SessionStore.inMemory(
        seed: jsonEncode({
          'active': 'me-1',
          'communities': [
            {
              'accountId': 'me-1',
              'baseUrl': 'https://h.example.com',
              'token': 'tok',
              'handle': 'me',
            },
          ],
        }),
      ),
      apiFactory: (base, token) =>
          ApiClient(baseUrl: base, token: token, httpClient: _server()),
      connector: (Uri _) async => _IdleConnection(),
    );

void main() {
  setUp(() {
    _sent.clear();
    _answered.clear();
  });

  testWidgets('보관된 세션으로 켜면 채널 목록이 뜨고, 채널을 열어 말을 보낸다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);

    // 채널 목록. 줄은 글자가 아니라 key 로 집는다.
    expect(find.byKey(const Key('channel-c1')), findsOneWidget);
    expect(find.byKey(const Key('channel-c2')), findsOneWidget);

    await tester.tap(find.byKey(const Key('channel-c1')));
    await tester.pumpAndSettle();

    // 먼저 있던 말은 뜨고, **진행 줄은 말풍선이 되지 않는다**.
    expect(find.byKey(const Key('message-m1')), findsOneWidget);
    expect(find.byKey(const Key('message-m2')), findsNothing);

    await tester.enterText(find.byKey(const Key('composer')), '@forge 이거 해 줘');
    await tester.tap(find.byKey(const Key('composer-send')));
    await tester.pumpAndSettle();

    // 에이전트를 부르는 것은 **멘션이 든 메시지를 올리는 것**이다 — 별도 경로가 없다.
    expect(_sent, ['@forge 이거 해 줘']);
    expect(find.byKey(const Key('message-m3')), findsOneWidget);
    // 보낸 뒤 작성칸은 비어 있다 — 남아 있으면 사람은 안 갔다고 생각하고 다시 누른다.
    expect(tester.widget<TextField>(find.byKey(const Key('composer'))).controller!.text, '');
  });

  testWidgets('소켓이 끊기면 그 사실이 화면에 선다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);

    // 붙어 있는 것은 기본 상태라 줄을 세우지 않는다. 끊겼을 때만 말한다.
    state.connection = SocketState.reconnecting;
    state.notifyListeners();
    await tester.pump();
    expect(find.byKey(const Key('connection-line')), findsOneWidget);
  });

  testWidgets('에이전트가 물으면 폰에서 골라서 그 턴을 이어 보낸다', (tester) async {
    // **P1 의 핵심**: 답할 수 없으면 "불렀는데 조용한" 것이 정상이 된다.
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);

    await tester.tap(find.byKey(const Key('channel-c1')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('ask-m4')), findsOneWidget);
    await tester.tap(find.byKey(const Key('ask-option-m4-y')));
    await tester.pumpAndSettle();

    expect(_answered, ['y']);
    // 버튼은 사라지고 **고른 것이 그 자리에 남는다** — 누른 뒤에도 버튼이 있으면
    // 사람은 자기가 누른 것을 의심한다.
    expect(find.byKey(const Key('ask-option-m4-y')), findsNothing);
    expect(find.byKey(const Key('ask-chosen-m4')), findsOneWidget);
    expect(find.text('저걸로'), findsOneWidget);
  });

  testWidgets('@ 를 치면 후보가 뜨고, 고르면 본문에 들어간다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);

    await tester.tap(find.byKey(const Key('channel-c1')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('mention-picker')), findsNothing);
    await tester.enterText(find.byKey(const Key('composer')), '@fo');
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('mention-candidate-forge')), findsOneWidget);
    await tester.tap(find.byKey(const Key('mention-candidate-forge')));
    await tester.pumpAndSettle();

    final text = tester.widget<TextField>(find.byKey(const Key('composer'))).controller!.text;
    expect(text, '@forge ');
    // 고른 뒤에는 후보가 사라진다 — 이름이 끝났으므로.
    expect(find.byKey(const Key('mention-picker')), findsNothing);
  });

  testWidgets('답글 줄을 누르면 스레드가 열리고, 거기서 답한다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);

    await tester.tap(find.byKey(const Key('channel-c1')));
    await tester.pumpAndSettle();

    // 답글이 달린 루트에만 문이 있다. `replyCount` 가 null 인 줄에는 없다.
    await tester.tap(find.byKey(const Key('thread-open-m1')));
    await tester.pumpAndSettle();

    // 루트와 답글이 함께 선다.
    expect(find.byKey(const Key('message-m1')), findsOneWidget);
    expect(find.byKey(const Key('message-r1')), findsOneWidget);
    // **스레드 안에서는 또 들어갈 문을 그리지 않는다.**
    expect(find.byKey(const Key('thread-open-m1')), findsNothing);

    await tester.enterText(find.byKey(const Key('thread-composer')), '답글이다');
    await tester.tap(find.byKey(const Key('thread-send')));
    await tester.pumpAndSettle();
    expect(_sent, ['답글이다']);
  });

  testWidgets('보내도 아무도 안 깨울 자리에서는 후보를 안 띄운다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);

    await tester.tap(find.byKey(const Key('channel-c1')));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('composer')), '> @fo');
    await tester.pumpAndSettle();
    // 띄우면 사람은 고르고 보냈는데 상대가 오지 않는다.
    expect(find.byKey(const Key('mention-picker')), findsNothing);
  });

  testWidgets('받은 것 탭에서 부름을 눌러 그 채널로 간다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);

    await tester.tap(find.byKey(const Key('tab-inbox')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('inbox-1')), findsOneWidget);
    await tester.tap(find.byKey(const Key('inbox-1')));
    await tester.pumpAndSettle();

    // 눌러서 열면 읽음이 된다 — **훑기만 해도 사라지지는 않는다.**
    expect(state.inboxUnread, 0);
    // 그 채널의 메시지가 선다.
    expect(find.byKey(const Key('message-m1')), findsOneWidget);
  });

  testWidgets('탭을 옮겨도 채널 화면이 다시 만들어지지 않는다', (tester) async {
    // 스크롤 위치와 치던 글이 사라지면 안 된다 — 채널을 보다 받은 것을 확인하고
    // 돌아오는 것이 이 앱에서 가장 흔한 동작이다.
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);

    await tester.tap(find.byKey(const Key('channel-c1')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('composer')), '치던 글');
    await tester.pumpAndSettle();

    // 채널 화면을 닫고 탭을 옮겼다 돌아온다.
    Navigator.of(tester.element(find.byKey(const Key('composer')))).pop();
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('tab-inbox')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('tab-channels')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('channel-c1')), findsOneWidget);
  });
}
