import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'dart:async';

import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/ws.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/screens/agent_model.dart';
import 'package:harkroom/screens/message_tile.dart';
import 'package:harkroom/screens/thread_screen.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:harkroom/ui/tokens.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// P0 의 "끝났다": **보관된 세션으로 앱을 켜서 채널을 열고 말을 보낸다.**
///
/// 진짜 서버 대신 [MockClient] 를, 진짜 소켓 대신 던지는 커넥터를 쓴다. 소켓 상태 기계는
/// `ws_test.dart` 가 따로 본다 — 여기서 보는 것은 **화면들이 이어지는가** 하나다.
http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status,
        headers: {'content-type': 'application/json'});

/// `pumpAndSettle` 대신 쓰는 것.
///
/// **진행 줄의 회전자는 영원히 돈다** — 그게 맞는 화면이다(에이전트가 아직 일하는 중).
/// 그래서 `pumpAndSettle` 은 *"pumpAndSettle timed out"* 으로 죽는다. 애니메이션을
/// 없애서 시험을 통과시키지 않는다: 시험이 배포되는 것과 다른 앱을 보게 된다.
/// 몇 프레임만 돌려 비동기 작업이 끝나게 한다.
Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 8; i += 1) {
    await tester.pump(const Duration(milliseconds: 50));
  }
}

final _sent = <String>[];
final _answered = <String>[];
/// 보낸 글에 실린 `agentModels`(서버 079). 글마다 하나 — 없으면 null.
final _sentModels = <Object?>[];
final _threadModelPuts = <Object?>[];

MockClient _server() => MockClient((req) async {
      final path = req.url.path;
      if (path == '/auth/me') {
        return _json({'id': 'me-1', 'handle': 'me', 'displayName': '나', 'isAdmin': false});
      }
      if (path == '/channels') {
        return _json({
          'channels': [
            {'id': 'c1', 'name': 'harkroom', 'kind': 'standard'},
            {'id': 'c2', 'name': 'random', 'kind': 'standard'},
          ],
        });
      }
      if (path == '/accounts') {
        return _json({
          'accounts': [
            {'id': 'a1', 'handle': 'forge', 'displayName': 'forge', 'kind': 'agent'},
            {'id': 'a2', 'handle': 'scout', 'displayName': 'scout', 'kind': 'agent'},
            {'id': 'a3', 'handle': 'lumen', 'displayName': 'lumen', 'kind': 'agent'},
            {'id': 'me-1', 'handle': 'me', 'displayName': '나', 'kind': 'human'},
          ],
        });
      }
      if (path == '/reads') return _json({'reads': <Object?>[]});
      // 채널 자동 멘션(#173): c2 는 scout 를 매 글에 붙이고(always), lumen 을 데리고 있다(available).
      if (path == '/channels/c2/auto-mentions') {
        return _json({
          'autoMentions': [
            {'channelId': 'c2', 'agentAccountId': 'a2', 'handle': 'scout', 'mode': 'always'},
            {'channelId': 'c2', 'agentAccountId': 'a3', 'handle': 'lumen', 'mode': 'available'},
          ],
        });
      }
      if (path.endsWith('/auto-mentions')) return _json({'autoMentions': <Object?>[]});
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
        // **실서버처럼 루트를 맨 앞에 함께 준다**(server `listMessages` 의 thread 갈래 —
        // `m.id = $2` 와 `thread_root_id = $2` 를 합친다). 예전 가짜는 답글만 줘서, 화면이
        // 루트를 두 번 그리는 것을 시험이 못 봤다.
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
        _sentModels.add((jsonDecode(req.body) as Map)['agentModels']);
        // **실서버처럼 멘션을 id 토큰으로 바꿔 돌려준다**(#271·#845) — 화면은 그것을 다시
        // `@handle` 로 그리고, 멘션 후보의 "자주 부른 순"은 그 토큰을 센다.
        const ids = {'forge': 'a1', 'scout': 'a2', 'lumen': 'a3'};
        final stored = body.replaceAllMapped(
          RegExp(r'@([a-z]+)'),
          (m) => ids[m.group(1)] == null ? m.group(0)! : '<@${ids[m.group(1)]}>',
        );
        return _json({
          'id': 'm3',
          'seq': 3,
          'channelId': 'c1',
          'authorId': 'me-1',
          'body': stored,
          'kind': 'user',
        });
      }
      if (path == '/agents/a1/model-options') {
        return _json({
          'harness': 'claude-code', 'model': 'sonnet', 'effort': null,
          'models': [
            {'id': 'opus', 'efforts': ['low', 'xhigh']},
            {'id': 'sonnet', 'efforts': ['low']},
          ],
        });
      }
      if (path.endsWith('/agent-models') && req.method == 'GET') return _json({'agentModels': <Object?>[]});
      if (path.contains('/agent-models/') && req.method == 'PUT') {
        final b = jsonDecode(req.body) as Map;
        _threadModelPuts.add(b);
        return _json({
          'row': {'agentId': 'a1', 'harness': 'claude-code', 'model': b['model'], 'effort': b['effort'], 'stale': false},
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
    await _settle(tester);

    // 먼저 있던 말은 뜨고, **진행 줄은 말풍선이 되지 않는다**.
    expect(find.byKey(const Key('message-m1')), findsOneWidget);
    expect(find.byKey(const Key('message-m2')), findsNothing);
    // 서버가 더 오래된 것이 없다고 했다 → 맨 위에 채널 시작 줄이 선다(designer #996).
    expect(find.byKey(const Key('channel-start')), findsOneWidget);
    expect(find.textContaining('#harkroom'), findsWidgets);

    await tester.enterText(find.byKey(const Key('composer')), '@forge 이거 해 줘');
    // 친 글이 있어야 보내기가 살아난다(빈 칸이면 soft) — 그 한 프레임을 그린다.
    await tester.pump();
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);

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

    // 붙어 있는 것은 기본 상태라 띠를 세우지 않는다. 끊겼을 때만 말한다.
    expect(find.byKey(const Key('connection-band')), findsNothing);
    state.connection = SocketState.reconnecting;
    state.notifyListeners();
    await tester.pump();
    expect(find.byKey(const Key('connection-band')), findsOneWidget);
  });

  testWidgets('진행은 말풍선이 아니라 한 줄로 접힌다', (tester) async {
    // P1 까지는 진행을 **버렸다** — 그래서 오래 도는 스레드가 조용해 보였다.
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);

    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);

    // 진행은 말풍선(`message-m2`)이 아니라 진행 줄(`progress-m2`)이다.
    expect(find.byKey(const Key('message-m2')), findsNothing);
    expect(find.byKey(const Key('progress-m2')), findsOneWidget);
  });

  testWidgets('에이전트가 물으면 폰에서 골라서 그 턴을 이어 보낸다', (tester) async {
    // **P1 의 핵심**: 답할 수 없으면 "불렀는데 조용한" 것이 정상이 된다.
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);

    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);

    expect(find.byKey(const Key('ask-m4')), findsOneWidget);
    await tester.tap(find.byKey(const Key('ask-option-m4-y')));
    await _settle(tester);

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
    await _settle(tester);

    expect(find.byKey(const Key('mention-picker')), findsNothing);
    await tester.enterText(find.byKey(const Key('composer')), '@fo');
    await _settle(tester);

    expect(find.byKey(const Key('mention-candidate-forge')), findsOneWidget);
    await tester.tap(find.byKey(const Key('mention-candidate-forge')));
    await _settle(tester);

    final text = tester.widget<TextField>(find.byKey(const Key('composer'))).controller!.text;
    expect(text, '@forge ');
    // 고른 뒤에는 후보가 사라진다 — 이름이 끝났으므로.
    expect(find.byKey(const Key('mention-picker')), findsNothing);
  });

  testWidgets('@ 후보는 내가 자주 부른 상대가 먼저다(없으면 이름순)', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);

    List<String> chips() => tester
        .widgetList<ActionChip>(find.descendant(
          of: find.byKey(const Key('mention-picker')),
          matching: find.byType(ActionChip),
        ))
        .map((c) => (c.key! as ValueKey<String>).value)
        .toList();

    await tester.enterText(find.byKey(const Key('composer')), '@');
    await _settle(tester);
    expect(chips().take(3), [
      'mention-candidate-forge',
      'mention-candidate-lumen',
      'mention-candidate-me',
    ]);

    await tester.enterText(find.byKey(const Key('composer')), '@lumen 봐 줘');
    await _settle(tester);
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);

    await tester.enterText(find.byKey(const Key('composer')), '@');
    await _settle(tester);
    expect(chips().first, 'mention-candidate-lumen');
  });

  testWidgets('@ 로 에이전트를 고르면 그 자리가 모델 빠른 줄이 되고, 고른 모델이 그 글과 함께 간다', (tester) async {
    _sentModels.clear();
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);

    await tester.enterText(find.byKey(const Key('composer')), '@fo');
    await _settle(tester);
    await tester.tap(find.byKey(const Key('mention-candidate-forge')));
    await _settle(tester);
    // 빠른 줄: 기본 / 목록 앞 / 더보기.
    expect(find.byKey(const Key('model-quick-row')), findsOneWidget);
    await tester.tap(find.byKey(const Key('model-quick-opus')));
    await _settle(tester);
    expect(find.textContaining('@forge · opus'), findsOneWidget);

    await tester.enterText(find.byKey(const Key('composer')), '@forge 고도화해 줘');
    await _settle(tester);
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);
    expect(_sentModels.last, [
      {'agentId': 'a1', 'model': 'opus', 'effort': null},
    ]);
    // 결정 12: 보낸 뒤 칩은 기본이다. 한 번 불렀으니 그 칩은 이제 고정 칩이다(모델 칩을 겸한다).
    await tester.enterText(find.byKey(const Key('composer')), '@forge 다음');
    await _settle(tester);
    expect(find.byKey(const Key('sticky-mention-forge')), findsOneWidget);
    expect(find.textContaining('@forge · opus'), findsNothing);
  });

  testWidgets('고르지 않고 계속 쓰면 기본으로 부른다 — agentModels 를 싣지 않는다', (tester) async {
    _sentModels.clear();
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);
    await tester.enterText(find.byKey(const Key('composer')), '@forge 안녕');
    await _settle(tester);
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);
    expect(_sentModels.last, isNull);
  });

  testWidgets('스레드 화면에도 @ 후보 줄과 머리 모델 줄이 있고, 바텀시트로 스레드 지정을 바꾼다', (tester) async {
    _threadModelPuts.clear();
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('thread-open-m1')));
    await _settle(tester);

    await tester.enterText(find.byKey(const Key('thread-composer')), '@fo');
    await _settle(tester);
    expect(find.byKey(const Key('mention-candidate-forge')), findsOneWidget);

    // 지정이 없으면 접힌 칩 하나 → 누르면 에이전트 칩.
    await tester.tap(find.byKey(const Key('thread-models-collapsed')));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('thread-model-chip-forge')));
    await _settle(tester);
    expect(find.byKey(const Key('model-sheet')), findsOneWidget);
    await tester.tap(find.byKey(const Key('model-option-opus')));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('effort-option-xhigh')));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('model-apply')));
    await _settle(tester);
    expect(_threadModelPuts.last, {'model': 'opus', 'effort': 'xhigh'});
    expect(find.textContaining('@forge · opus · xhigh'), findsWidgets);
  });

  testWidgets('답글 줄을 누르면 스레드가 열리고, 거기서 답한다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);

    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);

    // 답글이 달린 루트에만 문이 있다. `replyCount` 가 null 인 줄에는 없다.
    await tester.tap(find.byKey(const Key('thread-open-m1')));
    await _settle(tester);

    // 루트와 답글이 함께 선다.
    //
    // **`ThreadScreen` 안으로 좁혀서 센다**: 밀어 넣은 화면이라 뒤의 채널 화면이 나무에
    // 그대로 남아 있고, 거기에도 같은 루트가 있다. 좁히지 않으면 "둘 있다"로 빨개지는데
    // 그건 버그가 아니라 시험이 잘못 센 것이다.
    final inThread = find.descendant(
      of: find.byType(ThreadScreen),
      matching: find.byKey(const Key('message-m1')),
    );
    expect(inThread, findsOneWidget);
    expect(find.byKey(const Key('message-r1')), findsOneWidget);
    // S4c: 원글은 위에 **한 번만**(응답에 실린 원글을 답글로 또 그리지 않는다), 그 아래 「답글 1개」.
    expect(find.descendant(of: find.byType(ThreadScreen), matching: find.text('먼저 있던 말')), findsOneWidget);
    expect(find.byKey(const Key('thread-replies-divider')), findsOneWidget);
    // 머리 부제에 채널과 답글 수. 목록은 아래부터 쌓는다.
    final screen = find.byType(ThreadScreen);
    expect(find.descendant(of: screen, matching: find.textContaining('# harkroom')), findsOneWidget);
    expect(tester.widget<ListView>(find.byKey(const Key('thread-feed'))).reverse, isTrue);
    // S4d: 첫 답글 위에는 날짜 줄이 서지 않는다(구분 줄과 겹치지 않게).
    expect(find.descendant(of: screen, matching: find.byType(DayDivider)), findsNothing);
    // **스레드 안에서는 또 들어갈 문을 그리지 않는다.**
    expect(
      find.descendant(
        of: find.byType(ThreadScreen),
        matching: find.byKey(const Key('thread-open-m1')),
      ),
      findsNothing,
    );

    await tester.enterText(find.byKey(const Key('thread-composer')), '답글이다');
    // 친 글이 있어야 보내기가 살아난다(빈 칸이면 soft) — 그 한 프레임을 그린다.
    await tester.pump();
    await tester.tap(find.byKey(const Key('thread-send')));
    await _settle(tester);
    expect(_sent, ['답글이다']);
  });

  testWidgets('한 번 부른 에이전트는 다음 줄부터 저절로 불린다 — 칩이 서고, × 로 그만 부른다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);

    expect(find.byKey(const Key('sticky-mentions')), findsNothing);
    await tester.enterText(find.byKey(const Key('composer')), '@forge 이거 해 줘');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);
    expect(find.byKey(const Key('sticky-mention-forge')), findsOneWidget);

    // 서버는 본문의 멘션만 읽는다 — 다음 줄 본문에 `@forge` 가 실려야 에이전트가 깬다.
    await tester.enterText(find.byKey(const Key('composer')), '이어서 해 줘');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);
    expect(_sent.last, '@forge 이어서 해 줘');

    // × 를 누르면 더는 안 붙는다.
    final chip = tester.widget<InputChip>(
      find.descendant(of: find.byKey(const Key('sticky-mention-forge')), matching: find.byType(InputChip)),
    );
    chip.onDeleted!();
    await _settle(tester);
    expect(find.byKey(const Key('sticky-mentions')), findsNothing);
    await tester.enterText(find.byKey(const Key('composer')), '혼잣말');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);
    expect(_sent.last, '혼잣말');
  });

  testWidgets('고정된 에이전트는 작성칸 위에 칩 하나로만 선다(📌 + 모델) — 본문에서 다시 불러도 두 번 서지 않는다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);
    await tester.enterText(find.byKey(const Key('composer')), '@forge 시작');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);

    final inBar = find.descendant(of: find.byType(MentionModelBar), matching: find.textContaining('@forge'));
    // 본문이 비었을 때: 고정 칩 하나, 모델 칩 줄은 없다.
    expect(inBar, findsOneWidget);
    expect(
      find.descendant(of: find.byKey(const Key('sticky-mention-forge')), matching: find.textContaining('@forge · ')),
      findsOneWidget,
    );
    expect(find.byKey(const Key('called-model-chips')), findsNothing);
    // 본문에서 다시 불러도 그대로 하나다.
    await tester.enterText(find.byKey(const Key('composer')), '@forge 이어서');
    await _settle(tester);
    expect(inBar, findsOneWidget);
    expect(find.byKey(const Key('model-chip-forge')), findsNothing);
  });

  testWidgets('스레드에서 부른 에이전트는 스레드를 나갔다 와도 이어서 불린다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('thread-open-m1')));
    await _settle(tester);

    await tester.enterText(find.byKey(const Key('thread-composer')), '@forge 봐 줘');
    await tester.tap(find.byKey(const Key('thread-send')));
    await _settle(tester);
    expect(_sent.last, '@forge 봐 줘');

    // 스레드 화면은 나가면 버려진다 — 고정이 화면에 살면 여기서 사라진다.
    await tester.pageBack();
    await _settle(tester);
    await _settle(tester);
    expect(find.byType(ThreadScreen), findsNothing);
    // 스레드의 고정은 채널 작성칸으로 새지 않는다.
    expect(find.byKey(const Key('sticky-mentions')), findsNothing);
    await tester.tap(find.byKey(const Key('thread-open-m1')));
    await _settle(tester);
    expect(find.byKey(const Key('sticky-mention-forge')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('thread-composer')), '이어서');
    await tester.tap(find.byKey(const Key('thread-send')));
    await _settle(tester);
    expect(_sent.last, '@forge 이어서');
  });

  testWidgets('고정으로 부르는 에이전트에게 고른 모델도 그 글과 함께 간다(접두가 붙은 본문으로 센다)', (tester) async {
    _sentModels.clear();
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);
    await tester.enterText(find.byKey(const Key('composer')), '@forge 시작');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);

    // 본문에 `@forge` 를 안 쳐도 고정 칩이 모델 칩을 겸한다 — 몸통을 누르면 모델 시트가 열린다.
    await tester.enterText(find.byKey(const Key('composer')), '고도화');
    await _settle(tester);
    await tester.tap(find.byKey(const Key('sticky-mention-forge')));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('model-option-opus')));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('model-apply')));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);
    expect(_sent.last, '@forge 고도화');
    expect(_sentModels.last, [
      {'agentId': 'a1', 'model': 'opus', 'effort': null},
    ]);
  });

  testWidgets('채널 자동 멘션(always)은 매 글 앞에 붙고, 칩의 × 는 이번 글에서만 뺀다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c2')));
    await _settle(tester);

    expect(find.byKey(const Key('auto-mention-scout')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('composer')), '안녕');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);
    expect(_sent.last, '@scout 안녕');

    InputChip chipOf(String key) => tester.widget<InputChip>(
          find.descendant(of: find.byKey(Key(key)), matching: find.byType(InputChip)),
        );
    chipOf('auto-mention-scout').onDeleted!();
    await _settle(tester);
    expect(find.byKey(const Key('auto-mention-scout')), findsNothing);
    await tester.enterText(find.byKey(const Key('composer')), '혼잣말');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);
    expect(_sent.last, '혼잣말');

    // 설정은 그대로다 — 다음 글에는 다시 붙는다.
    expect(find.byKey(const Key('auto-mention-scout')), findsOneWidget);
    await tester.enterText(find.byKey(const Key('composer')), '다시');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);
    expect(_sent.last, '@scout 다시');
  });

  testWidgets('"이 채널의 에이전트"(available)는 붙지 않고 후보로 서며, 누르면 고정된다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c2')));
    await _settle(tester);

    expect(find.byKey(const Key('channel-agent-lumen')), findsOneWidget);
    await tester.tap(find.byKey(const Key('channel-agent-lumen')));
    await _settle(tester);
    // 칩이 고정 칩으로 옮겨 간다 — 같은 상대가 두 자리에 서지 않는다.
    expect(find.byKey(const Key('channel-agent-lumen')), findsNothing);
    expect(find.byKey(const Key('sticky-mention-lumen')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('composer')), '봐 줘');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);
    // 자동이 먼저, 고정이 뒤.
    expect(_sent.last, '@scout @lumen 봐 줘');
  });

  testWidgets('자동 멘션 상대를 직접 불러도 칩은 하나다 — 고정 칩·모델 칩으로 두 번 서지 않는다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c2')));
    await _settle(tester);

    await tester.enterText(find.byKey(const Key('composer')), '@scout 직접');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);
    // 본문이 이미 부르므로 접두를 또 붙이지 않는다.
    expect(_sent.last, '@scout 직접');

    final inBar = find.descendant(of: find.byType(MentionModelBar), matching: find.textContaining('@scout'));
    expect(inBar, findsOneWidget);
    expect(find.byKey(const Key('sticky-mention-scout')), findsNothing);
    // 본문에 다시 쳐도 하나다.
    await tester.enterText(find.byKey(const Key('composer')), '@scout 또');
    await _settle(tester);
    expect(inBar, findsOneWidget);
    expect(find.byKey(const Key('called-model-chips')), findsNothing);
  });

  testWidgets('스레드 작성칸에도 그 채널의 자동 멘션이 붙는다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c2')));
    await _settle(tester);
    await tester.tap(find.byKey(const Key('thread-open-m1')));
    await _settle(tester);

    expect(
      find.descendant(of: find.byType(ThreadScreen), matching: find.byKey(const Key('auto-mention-scout'))),
      findsOneWidget,
    );
    await tester.enterText(find.byKey(const Key('thread-composer')), '답글');
    await tester.tap(find.byKey(const Key('thread-send')));
    await _settle(tester);
    expect(_sent.last, '@scout 답글');
  });

  testWidgets('보내도 아무도 안 깨울 자리에서는 후보를 안 띄운다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);

    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);

    await tester.enterText(find.byKey(const Key('composer')), '> @fo');
    await _settle(tester);
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
    await _settle(tester);

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
    await _settle(tester);
    await tester.enterText(find.byKey(const Key('composer')), '치던 글');
    await _settle(tester);

    // 채널 화면을 닫고 탭을 옮겼다 돌아온다.
    Navigator.of(tester.element(find.byKey(const Key('composer')))).pop();
    await _settle(tester);
    await tester.tap(find.byKey(const Key('tab-inbox')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('tab-home')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('channel-c1')), findsOneWidget);
  });

  testWidgets('빈 작성칸이면 보내기가 흐리고 아무것도 안 가며, 글을 치면 주황이 된다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);
    final soft = tester.element(find.byKey(const Key('composer'))).tokens.soft;
    Color? bg() => tester
        .widget<IconButton>(
            find.descendant(of: find.byKey(const Key('composer-send')), matching: find.byType(IconButton)))
        .style!
        .backgroundColor!
        .resolve(<WidgetState>{});
    expect(bg(), soft);
    await tester.enterText(find.byKey(const Key('composer')), '   ');
    await tester.pump();
    expect(bg(), soft, reason: '공백만이면 보낼 것이 없다');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _settle(tester);
    expect(_sent, isEmpty);
    await tester.enterText(find.byKey(const Key('composer')), '안녕');
    await tester.pump();
    expect(bg(), isNot(soft));
    // 자리표시는 채널 이름으로("# harkroom 에 메시지" / "Message # harkroom").
    final hint = tester.widget<TextField>(find.byKey(const Key('composer'))).decoration!.hintText!;
    expect(hint, contains('# harkroom'));
    expect(hint, isNot(contains('{name}')));
  });

  testWidgets('@ 버튼을 누르면 칸에 @ 가 들어가 후보가 뜬다(앞 글자가 있으면 띄우고)', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    await tester.tap(find.byKey(const Key('channel-c1')));
    await _settle(tester);

    expect(find.byKey(const Key('mention-picker')), findsNothing);
    await tester.tap(find.byKey(const Key('mention-add')));
    await _settle(tester);
    TextField field() => tester.widget<TextField>(find.byKey(const Key('composer')));
    expect(field().controller!.text, '@');
    expect(find.byKey(const Key('mention-candidate-forge')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('composer')), '안녕');
    await tester.pump();
    await tester.tap(find.byKey(const Key('mention-add')));
    await _settle(tester);
    expect(field().controller!.text, '안녕 @');
  });

  testWidgets('원글이 채널 목록에 없으면(오래된 스레드) ?thread= 응답의 원글을 위에 한 번 그린다', (tester) async {
    final state = _state();
    await tester.pumpWidget(HarkroomApp(state: state));
    await tester.pumpAndSettle();
    addTearDown(state.dispose);
    // 채널을 열지 않고 스레드로 바로 간다 — 인박스에서 오래된 스레드를 연 것과 같다(채널 목록에 원글 없음).
    expect(state.messages['c1'], isNull);
    Navigator.of(tester.element(find.byKey(const Key('channel-c1')))).push(
      MaterialPageRoute<void>(builder: (_) => const ThreadScreen(channelId: 'c1', rootId: 'm1')),
    );
    await _settle(tester);
    final screen = find.byType(ThreadScreen);
    expect(find.descendant(of: screen, matching: find.byKey(const Key('message-m1'))), findsOneWidget);
    expect(find.descendant(of: screen, matching: find.byKey(const Key('thread-replies-divider'))), findsOneWidget);
    expect(find.descendant(of: screen, matching: find.byKey(const Key('message-r1'))), findsOneWidget);
  });

  group('키보드 내림 — 목록을 끌거나 빈 곳을 탭하면 포커스만 푼다', () {
    bool focused(WidgetTester tester, String key) =>
        tester.widget<TextField>(find.byKey(Key(key))).focusNode!.hasFocus;
    String text(WidgetTester tester, String key) =>
        tester.widget<TextField>(find.byKey(Key(key))).controller!.text;

    testWidgets('채널: 목록을 끌면 키보드가 내려가고, 쓰던 글·멘션 핀은 남는다', (tester) async {
      final state = _state();
      await tester.pumpWidget(HarkroomApp(state: state));
      await tester.pumpAndSettle();
      addTearDown(state.dispose);
      await tester.tap(find.byKey(const Key('channel-c1')));
      await _settle(tester);
      // 핀을 하나 세운다 — 내림이 작성칸 상태까지 비우면 여기서 드러난다.
      await tester.enterText(find.byKey(const Key('composer')), '@forge 시작');
      await tester.tap(find.byKey(const Key('composer-send')));
      await _settle(tester);
      expect(find.byKey(const Key('sticky-mention-forge')), findsOneWidget);

      await tester.tap(find.byKey(const Key('composer')));
      await tester.enterText(find.byKey(const Key('composer')), '쓰던 글');
      await tester.pump();
      expect(focused(tester, 'composer'), isTrue);

      // 위로 끌어올린다(reverse 목록이라 지난 말 쪽).
      await tester.drag(find.byKey(const Key('channel-feed')), const Offset(0, 300));
      await _settle(tester);
      expect(focused(tester, 'composer'), isFalse);
      expect(text(tester, 'composer'), '쓰던 글');
      expect(find.byKey(const Key('sticky-mention-forge')), findsOneWidget);
    });

    testWidgets('채널: 새 말이 와서 목록이 움직이는 것처럼 코드가 스크롤하면 내리지 않는다', (tester) async {
      final state = _state();
      await tester.pumpWidget(HarkroomApp(state: state));
      await tester.pumpAndSettle();
      addTearDown(state.dispose);
      await tester.tap(find.byKey(const Key('channel-c1')));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('composer')));
      await tester.pump();
      expect(focused(tester, 'composer'), isTrue);

      final scroll = tester.widget<ListView>(find.byKey(const Key('channel-feed'))).controller!;
      scroll.jumpTo(40);
      await tester.pump();
      unawaited(scroll.animateTo(0, duration: const Duration(milliseconds: 100), curve: Curves.linear));
      await _settle(tester);
      expect(focused(tester, 'composer'), isTrue);
    });

    testWidgets('채널: 목록 빈 곳을 한 번 탭하면 내려간다', (tester) async {
      final state = _state();
      await tester.pumpWidget(HarkroomApp(state: state));
      await tester.pumpAndSettle();
      addTearDown(state.dispose);
      await tester.tap(find.byKey(const Key('channel-c1')));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('composer')));
      await tester.enterText(find.byKey(const Key('composer')), '쓰던 글');
      await tester.pump();
      expect(focused(tester, 'composer'), isTrue);

      // 목록은 아래부터 쌓이므로 맨 위 띠는 빈 곳이다.
      await tester.tapAt(tester.getTopLeft(find.byKey(const Key('channel-feed'))) + const Offset(100, 4));
      await _settle(tester);
      expect(focused(tester, 'composer'), isFalse);
      expect(text(tester, 'composer'), '쓰던 글');
    });

    testWidgets('스레드: 한 화면에 다 드는 짧은 스레드도 끌면 내려가고, 빈 곳 탭도 듣는다', (tester) async {
      final state = _state();
      await tester.pumpWidget(HarkroomApp(state: state));
      await tester.pumpAndSettle();
      addTearDown(state.dispose);
      await tester.tap(find.byKey(const Key('channel-c1')));
      await _settle(tester);
      await tester.tap(find.byKey(const Key('thread-open-m1')));
      await _settle(tester);

      await tester.tap(find.byKey(const Key('thread-composer')));
      await tester.enterText(find.byKey(const Key('thread-composer')), '답글 쓰는 중');
      await tester.pump();
      expect(focused(tester, 'thread-composer'), isTrue);
      // 이 스레드는 스크롤할 거리가 0 이다 — 목록이 안 움직여도 끌기는 듣는다.
      expect(tester.widget<ListView>(find.byKey(const Key('thread-feed'))).controller!.position.maxScrollExtent, 0);
      await tester.drag(find.byKey(const Key('thread-feed')), const Offset(0, 300));
      await _settle(tester);
      expect(focused(tester, 'thread-composer'), isFalse);
      expect(text(tester, 'thread-composer'), '답글 쓰는 중');

      await tester.tap(find.byKey(const Key('thread-composer')));
      await tester.pump();
      expect(focused(tester, 'thread-composer'), isTrue);
      await tester.tapAt(tester.getTopLeft(find.byKey(const Key('thread-feed'))) + const Offset(100, 4));
      await _settle(tester);
      expect(focused(tester, 'thread-composer'), isFalse);
      expect(text(tester, 'thread-composer'), '답글 쓰는 중');
    });
  });
}
