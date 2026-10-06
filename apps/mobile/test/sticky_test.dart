// 고정 멘션(데스크탑 `lib/mention.ts` 의 `withStickyMentions`·`keepMentioned` 이식) — 무엇을 붙이고 무엇을 기억하나.
import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/models.dart';
import 'package:harkroom/mention/sticky.dart';

AccountView _acc(String id, String handle, {bool agent = true, bool disabled = false}) => AccountView(
      id: id, handle: handle, displayName: handle, isAgent: agent, isDisabled: disabled, avatarAttachmentId: null,
    );

void main() {
  final forge = _acc('a1', 'forge');
  final codex = _acc('a2', 'Codex');
  final mina = _acc('u1', 'mina', agent: false);
  final me = _acc('me', 'me', agent: false);
  final off = _acc('a3', 'sleepy', disabled: true);
  final all = [forge, codex, mina, me, off];
  final byId = {for (final a in all) a.id: a};

  test('고정한 상대를 순서대로 본문 앞에 붙이고, 본문이 이미 부르는 상대는 건너뛴다', () {
    expect(withStickyMentions('이어서', ['forge', 'codex']), '@forge @codex 이어서');
    expect(withStickyMentions('@Forge 이어서', ['forge', 'codex']), '@codex @Forge 이어서');
    expect(withStickyMentions('이어서', const []), '이어서');
  });

  test('인용·코드 안의 @ 는 부름이 아니므로 고정 상대는 그대로 붙는다', () {
    expect(withStickyMentions('> @forge 가 말했다', ['forge']), '@forge > @forge 가 말했다');
    expect(withStickyMentions('`@forge`', ['forge']), '@forge `@forge`');
  });

  test('보낸 글에서 새로 부른 상대를 id 로 뒤에 더한다 — 모르는 이름·나·이미 고정된 것은 빼고', () {
    expect(keepMentioned(const [], '@forge @nobody @me 봐 줘', all, myId: 'me'), ['a1']);
    expect(keepMentioned(const ['a2'], '@forge @codex', all, myId: 'me'), ['a2', 'a1']);
    expect(keepMentioned(const ['a1'], '@mina', all), ['a1', 'u1']);
    // 아무도 새로 안 불렀으면 같은 목록을 돌려준다(화면을 다시 그릴 까닭이 없다).
    const cur = ['a1'];
    expect(identical(keepMentioned(cur, '그냥 말', all), cur), isTrue);
  });

  test('지금 붙일 상대: 지워진·비활성 계정과 나는 빼고, 저장 순서를 지킨다', () {
    final live = liveStickyAccounts(const ['a2', 'gone', 'a3', 'me', 'a1', 'a2'], byId, myId: 'me');
    expect(live.map((a) => a.id), ['a2', 'a1']);
  });
}
