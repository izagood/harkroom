import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/i18n/en.dart';
import 'package:harkroom/screens/message_tile.dart';

// 상태 칸 길게 누르기 문장 — 상태 · 누구 · 이유(데스크톱 statusSentence 와 같은 순서, designer nit).
void main() {
  const t = StringsEn();
  String? nameOf(String id) => const {'bot': 'harkbot', 'u2': 'security'}[id];
  ThreadStatusMark mark(String status, String? reason) =>
      ThreadStatusMark(status: status, emoji: '?', accountId: 'bot', reason: reason);

  test('이유가 없어도 상태와 주인은 보인다 — 끝남은 "Done · 주인"', () {
    expect(threadStatusSentence(mark('done', null), t, nameOf), 'Done · harkbot');
    expect(threadStatusSentence(mark('running', null), t, nameOf), 'Working · harkbot');
  });

  test('🙋·🚨 는 이유를 붙이고 80자에서 자른다', () {
    expect(threadStatusSentence(mark('my-turn', '어느 쪽?'), t, nameOf), 'Your turn · harkbot · 어느 쪽?');
    final long = 'x' * 100;
    expect(threadStatusSentence(mark('stuck', long), t, nameOf), 'Stuck · harkbot · ${'x' * 80}…');
  });

  test('⏳ 의 이유는 상대 이름으로 바꾸고, 모르는 id 는 뺀다', () {
    expect(threadStatusSentence(mark('waiting', 'u2'), t, nameOf), 'Waiting · harkbot · security');
    expect(threadStatusSentence(mark('waiting', 'zzz'), t, nameOf), 'Waiting · harkbot');
  });

  test('주인을 모르면 "An agent"', () {
    const s = ThreadStatusMark(status: 'received', emoji: '👀', accountId: 'nope', reason: null);
    expect(threadStatusSentence(s, t, nameOf), 'Received · An agent');
  });
}
