/// 내가 **얼마나 자주** 누구를 불렀는가 — 멘션 후보 칩의 순서를 정하는 재료.
///
/// ## 무엇을 세나
///
/// **내가 쓴 메시지**에 든 멘션 토큰 `<@계정id>` 를 센다. 한 메시지에 같은 상대가 두 번
/// 나와도 한 번이다 — 세려는 것은 "몇 번 불렀나"이지 "본문에 이름이 몇 번 적혔나"가 아니다.
///
/// - **id 로 센다.** 서버는 저장할 때 `@handle` 을 `<@id>` 로 바꿔 둔다(#271·#845). 그래서
///   상대가 이름을 바꿔도 지난 부름이 그대로 그 상대의 몫으로 남는다. handle 을 키로 세면
///   이름이 바뀌는 순간 기록을 잃는다.
/// - **집합·팀 토큰은 안 센다.** 칩 줄은 계정만 세운다.
/// - **이 기기가 지금 들고 있는 메시지만** 본다(열어 본 채널의 최근 쪽·스레드). 서버에
///   묻거나 기기에 따로 쌓지 않는다 — 새 상태를 하나 더 두면 지운 글·고친 글과 어긋나는
///   길이 생긴다. 그 대가로 앱을 막 켰을 때는 지금 채널의 최근 글만 근거가 된다.
library;

import '../api/models.dart';

/// 한 상대를 부른 기록.
class MentionUse {
  const MentionUse({required this.count, required this.last});

  /// 그 상대를 부른 내 메시지 수.
  final int count;

  /// 마지막으로 부른 때. 횟수가 같을 때 최근 쪽을 앞에 세운다.
  final DateTime last;
}

/// 계정 토큰만 잡는다 — 접두(`group:`·`team:`)가 붙은 것은 `:` 에서 걸러진다.
///
/// `render.dart` 처럼 uuid 모양을 따지지 않는 이유: 여기서 잘못 잡아도 그 id 는
/// 후보 목록에 없으므로 순서에 아무 일도 하지 않는다. 그리지 않고 세기만 한다.
final RegExp _accountToken = RegExp(r'<@([^:>\s]+)>');

/// [messages] 중 [myId] 가 쓴 것에서 부른 상대를 센다. 같은 메시지가 두 번 들어와도
/// (채널 목록과 스레드 목록에 같은 답글이 함께 있을 수 있다) id 로 한 번만 센다.
Map<String, MentionUse> countMentionUse(
  Iterable<MessageRow> messages,
  String myId,
) {
  final seen = <String>{};
  final out = <String, MentionUse>{};
  for (final m in messages) {
    if (m.authorId != myId || !seen.add(m.id)) continue;
    final ids = {for (final t in _accountToken.allMatches(m.body)) t.group(1)!};
    for (final id in ids) {
      if (id == myId) continue;
      final prev = out[id];
      out[id] = MentionUse(
        count: (prev?.count ?? 0) + 1,
        last: prev == null || m.createdAt.isAfter(prev.last) ? m.createdAt : prev.last,
      );
    }
  }
  return out;
}
