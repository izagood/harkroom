/// 고정 멘션 — **한 번 부른 상대는 다음 줄부터 저절로 불린다.**
///
/// 데스크탑 작성창(`packages/desktop/src/components/Composer.tsx` 의 `send`)과
/// `lib/mention.ts` 의 `withStickyMentions`·`keepMentioned` 를 옮긴 것이다.
///
/// ## 왜 클라이언트가 붙이나
///
/// 서버에는 "이 스레드에서 전에 부른 에이전트를 계속 깨운다"는 규칙이 **없다** — 서버가
/// 읽는 것은 본문의 멘션뿐이다. 데스크탑은 부른 상대를 기억해 두었다가 다음 글 앞에
/// `@handle` 을 붙여 보내므로 사람 눈에는 "호출이 이어진다". 모바일에 이것이 없어서 같은
/// 스레드에서도 매번 다시 `@` 를 쳐야 했다. 서버가 붙이지 않는 이유는 데스크탑과 같다:
/// 에이전트가 MCP 로 올린 답에도 접두가 붙으면 그 에이전트가 자기 답에 다시 불린다.
///
/// ## 무엇으로 저장하나
///
/// **계정 id** 다(데스크탑 #848). 이름은 바뀌므로 이름으로 저장하면 이름을 바꾼 상대의
/// 칩이 조용히 사라지고, 사람은 고정해 둔 상대가 빠진 줄 모르고 보낸다. 화면과 접두만
/// 이름을 쓰고, 쓰는 순간에만 id 로 바꾼다.
library;

import '../api/models.dart';
import 'mention.dart';

/// 고정해 둔 상대를 본문 앞에 붙인다. 이미 본문이 부르고 있는 handle 은 건너뛴다 —
/// 알림은 어차피 한 번이지만 `@forge @forge` 는 읽는 사람에게 잡음이다.
/// 고정된 순서를 그대로 쓴다: 순서가 바뀌면 사람은 칩을 매번 다시 읽어야 한다.
String withStickyMentions(String body, List<String> handles) {
  final already = mentionedHandles(body).toSet();
  final missing = handles.where((h) => !already.contains(h.toLowerCase())).toList(growable: false);
  return missing.isEmpty ? body : '${missing.map((h) => '@$h').join(' ')} $body';
}

/// 방금 보낸 본문에서 새로 불린 상대(id)를 뒤에 더한다. 이미 고정된 것의 순서는 흔들지 않는다.
///
/// 모르는 이름·나 자신은 더하지 않는다 — 없는 handle 을 붙이면 멘션이 아니라 그냥 글자고,
/// 나를 붙이면 매 줄이 나를 부른다.
List<String> keepMentioned(
  List<String> sticky,
  String body,
  Iterable<AccountView> accounts, {
  String? myId,
}) {
  final byHandle = {for (final a in accounts) a.handle.toLowerCase(): a};
  final kept = sticky.toSet();
  final added = <String>[];
  for (final h in mentionedHandles(body)) {
    final a = byHandle[h];
    if (a == null || a.id == myId || kept.contains(a.id)) continue;
    kept.add(a.id);
    added.add(a.id);
  }
  return added.isEmpty ? sticky : [...sticky, ...added];
}

/// 저장된 id 를 **지금 붙일 수 있는** 계정으로 푼다(고정된 순서).
///
/// 지워진 계정·비활성 계정·나는 뺀다 — 깨어나지 못하는 상대를 매 줄에 붙이면 죽은 handle 만
/// 남는다. 저장본은 건드리지 않는다: 계정 목록이 아직 안 온 순간에 걸러서 되쓰면 고정이 전부
/// 지워진다(데스크탑이 `stickyRaw` 와 `sticky` 를 가른 이유와 같다).
List<AccountView> liveStickyAccounts(
  List<String> sticky,
  Map<String, AccountView> accounts, {
  String? myId,
}) => [
  for (final id in sticky.toSet())
    if (accounts[id] case final a? when !a.isDisabled && a.id != myId) a,
];
