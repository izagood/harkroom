import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/api_client.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/main.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';
import 'package:integration_test/integration_test.dart';

/// **진짜 워크스페이스에 붙어 "되는 것"을 한 바퀴 도는 시험.**
///
/// `app_boots_test.dart` 는 자격증명 없이 갈 수 있는 데까지만 간다. 이 파일은 로그인 뒤를 돈다 —
/// 채널 목록 · 보내기 · 실시간 수신 · `@` 자동완성 · 스레드 · 리액션 · 첨부 · ask · 받은 것.
///
/// ## 쓰고 버릴 계정으로 돈다
///
/// 사람의 진짜 계정으로 돌리면 시험이 그 사람 이름으로 말하고, 그 사람의 받은 것을 읽음으로
/// 만든다. 초대 토큰으로 계정을 하나 만들고(`POST /auth/register`), 끝나면 운영자가 치운다.
///
/// ## 값은 `--dart-define` 으로 받는다
///
/// 파일에 적으면 비밀번호가 저장소에 남는다. `E2E_SERVER` 가 비면 **통째로 건너뛴다** —
/// 자격증명 없는 기계(CI)에서 `flutter test integration_test` 가 빨개지지 않게.
///
/// ```
/// flutter test integration_test/live_tour_test.dart \
///   --dart-define=E2E_SERVER=https://jaebin.harkroom.com \
///   --dart-define=E2E_LOGIN=e2e-mobile --dart-define=E2E_PASSWORD=... \
///   --dart-define=E2E_CHANNEL=<공개 채널 id> --dart-define=E2E_AGENT=<부를 에이전트 handle> \
///   --dart-define=E2E_ASK=<이 계정에게 세운 ask 메시지 id>   # 없으면 ask·받은 것은 건너뛴다
/// ```
///
/// ## 옆 통로(side)를 하나 더 둔다
///
/// 같은 계정으로 **따로 로그인한 API 클라이언트**다. 앱 밖에서 말을 넣어야 "실시간으로
/// 들어온다"를 볼 수 있고(앱이 보낸 말은 앱이 이미 안다), 앱이 한 일이 **서버에 실제로
/// 남았는지**도 화면이 아니라 이쪽으로 대조한다.
///
/// ## `pumpAndSettle` 을 안 쓴다
///
/// 진짜 소켓이 열려 있고 진행 줄의 회전자가 돈다 — 화면이 "가라앉는" 순간이 오지 않는다.
/// 찾는 것이 나타날 때까지 프레임을 돌리는 [_until] 로 기다린다.
const _server = String.fromEnvironment('E2E_SERVER');
const _login = String.fromEnvironment('E2E_LOGIN');
const _password = String.fromEnvironment('E2E_PASSWORD');
const _channel = String.fromEnvironment('E2E_CHANNEL');
const _agent = String.fromEnvironment('E2E_AGENT');
const _ask = String.fromEnvironment('E2E_ASK');

/// 1×1 투명 PNG. 미리보기가 이미지일 때만 그려지므로 진짜 이미지 바이트가 필요하다.
final _png = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('로그인 뒤 한 바퀴', skip: _server.isEmpty, (tester) async {
    final nonce = DateTime.now().millisecondsSinceEpoch.toRadixString(36);
    final side = ApiClient(baseUrl: _server);
    side.token = await side.login(_login, _password);

    // 키체인 대신 메모리 — 시험이 기기의 진짜 세션을 덮지 않게. 소켓은 **진짜**다.
    final app = AppState(sessions: SessionStore.inMemory());
    addTearDown(app.dispose);
    await tester.pumpWidget(HarkroomApp(state: app));
    await _until(tester, find.byKey(const Key('connect-server-url')));

    // ── 로그인
    await tester.enterText(find.byKey(const Key('connect-server-url')), _server);
    await tester.tap(find.byKey(const Key('connect-continue')));
    await _until(tester, find.byKey(const Key('login-id')));
    await tester.enterText(find.byKey(const Key('login-id')), _login);
    await tester.enterText(find.byKey(const Key('login-password')), _password);
    await tester.tap(find.byKey(const Key('login-submit')));

    // ── 채널 목록 → 시험 채널
    await _until(tester, find.byKey(const Key('channel-$_channel')));
    await tester.tap(find.byKey(const Key('channel-$_channel')));
    await _until(tester, find.byKey(const Key('composer')));

    // ── 보내기: 화면에 뜨고 **서버에도 남는다**
    await tester.enterText(find.byKey(const Key('composer')), 'e2e send $nonce');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _until(tester, find.textContaining('e2e send $nonce'));
    expect(await _serverHas(side, 'e2e send $nonce'), isTrue);

    // ── 실시간 수신: 앱 밖에서 넣은 말이 새로고침 없이 뜬다
    await side.postMessage(_channel, 'e2e live $nonce');
    await _until(tester, find.textContaining('e2e live $nonce'));

    // ── 리액션: 옆에서 단 것을 앱에서 누르면 떨어진다(내가 유일한 사람이라 칸이 사라진다)
    final reacted = await side.postMessage(_channel, 'e2e react $nonce');
    await side.addReaction(_channel, reacted.id, '👍');
    final chip = find.byKey(Key('reaction-${reacted.id}-👍'));
    await _until(tester, chip);
    await tester.ensureVisible(chip);
    await tester.tap(chip);
    await _until(tester, chip, gone: true);
    final after = await _find(side, reacted.id);
    expect(after?.reactions.where((r) => r.emoji == '👍'), isEmpty);

    // ── 스레드: 답글 줄을 눌러 열고, 거기서 답한다
    final root = await side.postMessage(_channel, 'e2e thread $nonce');
    await side.postMessage(_channel, 'e2e reply-side $nonce', threadRootId: root.id);
    final open = find.byKey(Key('thread-open-${root.id}'));
    await _until(tester, open);
    await tester.ensureVisible(open);
    await tester.tap(open);
    await _until(tester, find.byKey(const Key('thread-composer')));
    await tester.enterText(find.byKey(const Key('thread-composer')), 'e2e reply-app $nonce');
    await tester.tap(find.byKey(const Key('thread-send')));
    await _until(tester, find.textContaining('e2e reply-app $nonce'));
    await tester.pageBack();
    await _until(tester, find.byKey(const Key('composer')));

    // ── 첨부: 고른 뒤의 경로(올리기 → 보내기 → 미리보기)
    // 파일 고르기 창은 iOS 의 것이라 시험이 누를 수 없다 — 버튼이 고른 뒤에 부르는 것과
    // **같은 함수**를 부른다.
    await app.attach(_channel, PendingAttachment(filename: 'e2e-$nonce.png'), _png);
    await _until(tester, find.byKey(Key('pending-e2e-$nonce.png')));
    await tester.enterText(find.byKey(const Key('composer')), 'e2e attach $nonce');
    await tester.tap(find.byKey(const Key('composer-send')));
    await _until(tester, find.byWidgetPredicate(_keyStarts('attachment-preview-')));

    // ── `@` 자동완성 → 에이전트 부르기. **진짜로 그 에이전트의 턴이 뜬다.**
    if (_agent.isNotEmpty) {
      await tester.enterText(
          find.byKey(const Key('composer')), '@${_agent.substring(0, 2)}');
      final candidate = find.byKey(Key('mention-candidate-$_agent'));
      await _until(tester, candidate);
      await tester.tap(candidate);
      await tester.pump();
      final field = tester.widget<TextField>(find.byKey(const Key('composer')));
      expect(field.controller!.text, startsWith('@$_agent '));
      await tester.enterText(find.byKey(const Key('composer')),
          '${field.controller!.text}모바일 e2e 확인용이다. "받았다" 한 줄만 답해 줘. $nonce');
      await tester.tap(find.byKey(const Key('composer-send')));
      await _until(tester, find.textContaining('모바일 e2e 확인용이다'));
      // 막혔는지(mentionDenied·capped)는 화면이 아니라 서버의 meta 로 본다.
      final sent = (await side.messages(_channel, limit: 20))
          .messages
          .lastWhere((m) => m.body.contains(nonce) && m.body.startsWith('@'));
      debugPrint('E2E mention meta: ${jsonEncode(sent.meta)}');
    }

    // ── ask 답하기 · 받은 것
    if (_ask.isNotEmpty) {
      final option = find.byWidgetPredicate(_keyStarts('ask-option-$_ask-'));
      await _until(tester, option, scroll: true);
      await tester.tap(option.first);
      await _until(tester, find.byKey(Key('ask-chosen-$_ask')));

      await tester.tap(find.byKey(const Key('tab-inbox')));
      final entry = find.byWidgetPredicate(_keyStarts('inbox-'));
      await _until(tester, entry);
      await tester.tap(entry.first);
      await _until(tester, find.byKey(const Key('composer')));
    }

    expect(tester.takeException(), isNull);
  });
}

bool Function(Widget) _keyStarts(String prefix) => (w) {
      final k = w.key;
      return k is ValueKey<String> && k.value.startsWith(prefix) && k.value != 'inbox-mark-all';
    };

Future<void> _until(
  WidgetTester tester,
  Finder finder, {
  bool gone = false,
  bool scroll = false,
  Duration timeout = const Duration(seconds: 20),
}) async {
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    await tester.pump(const Duration(milliseconds: 100));
    final present = finder.evaluate().isNotEmpty;
    if (present != gone) return;
    // 목록이 길면 찾는 것이 화면 밖에 있다 — 위로 한 번씩 민다.
    if (scroll && !gone) {
      final list = find.byType(Scrollable);
      if (list.evaluate().isNotEmpty) await tester.drag(list.first, const Offset(0, 300));
    }
  }
  fail('${gone ? '사라지지' : '나타나지'} 않았다: $finder');
}

Future<bool> _serverHas(ApiClient side, String text) async =>
    (await side.messages(_channel, limit: 20)).messages.any((m) => m.body.contains(text));

Future<MessageRow?> _find(ApiClient side, String id) async {
  final page = await side.messages(_channel, limit: 50);
  for (final m in page.messages) {
    if (m.id == id) return m;
  }
  return null;
}
