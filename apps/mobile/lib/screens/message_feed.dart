import '../api/models.dart';
import 'agent_exchange.dart';

/// 화면에 실제로 그릴 줄들. **이어진 진행은 한 줄로 접힌다.**
///
/// 순수 함수로 빼 둔 이유: 이 접기는 화면 두 곳(채널·스레드)이 똑같이 해야 하고,
/// 위젯 안에 묻어 두면 시험하기 어렵다. 접는 규칙이 두 화면에서 갈라지면 같은 스레드가
/// 서로 다르게 보인다.
sealed class FeedItem {
  const FeedItem();
}

/// 말풍선·카드처럼 **한 메시지가 한 줄**인 것.
class FeedMessage extends FeedItem {
  const FeedMessage(this.message, {this.continued = false, this.dayBreak = false});
  final MessageRow message;

  /// 바로 앞 말과 **같은 사람이 5분 안에 이어 말했다** — 아바타·이름 없이 붙인다(재설계 §2).
  /// 매 줄에 이름을 달면 한 사람이 세 줄을 쓸 때 화면의 절반이 이름이 된다.
  final bool continued;

  /// 이 말 앞에서 **날짜가 바뀐다**(현지 시각 기준). 화면은 그 앞에 날짜 줄을 넣는다.
  final bool dayBreak;
}

/// 이어 말한 것으로 볼 시간. Slack·데스크탑과 같은 5분이다.
const continuationWindow = Duration(minutes: 5);

/// 이어진 진행 묶음. 마지막 것이 "지금 하는 일"이다.
class FeedProgressRun extends FeedItem {
  const FeedProgressRun(this.run);
  final List<MessageRow> run;
}

/// 메시지들을 그릴 줄로 바꾼다.
///
/// 규칙은 둘뿐이다:
/// - `progress` 가 **연달아** 오면 하나로 묶는다. 사이에 다른 말이 끼면 묶음이 끊긴다 —
///   그래야 "이 진행이 무엇 뒤에 일어난 일인가"가 순서로 남는다.
/// - **작성자가 바뀌면 묶음이 끊긴다.** 두 에이전트가 동시에 도는 스레드에서 한 줄로
///   합치면 누가 무엇을 하는지 사라진다.
List<FeedItem> buildFeed(List<MessageRow> messages) {
  final out = <FeedItem>[];
  var run = <MessageRow>[];

  void flush() {
    if (run.isEmpty) return;
    out.add(FeedProgressRun(List.unmodifiable(run)));
    run = <MessageRow>[];
  }

  // 묶기의 기준은 **바로 앞의 말**이다. 사이에 진행 줄이 끼면 끊는다 — 그 사이에 일이
  // 있었다는 것이 순서로 남아야 한다.
  MessageRow? prev;
  DateTime? prevDay;
  for (final m in messages) {
    final local = m.createdAt.toLocal();
    final day = DateTime(local.year, local.month, local.day);
    // **첫 줄 위에도** 날짜를 세운다 — 맨 위에 날짜가 없으면 위로 밀었을 때 언제 한 말인지
    // 알 수 없다(designer #980).
    final dayBreak = prevDay == null || day != prevDay;
    prevDay = day;
    if (m.kind == MessageKind.progress) {
      if (run.isNotEmpty && run.last.authorId != m.authorId) flush();
      run.add(m);
      prev = null;
      continue;
    }
    flush();
    final continued = !dayBreak &&
        prev != null &&
        prev.authorId == m.authorId &&
        prev.isSpeech &&
        m.isSpeech &&
        // 시스템 줄은 누구의 말도 아니다(시스템 줄 C안 c1) — 앞뒤 어느 글과도 묶지 않는다. 묶으면 사람 글 밑에
        // 머리 없이 붙어 그 사람이 한 줄 더 쓴 것처럼 보였다.
        m.kind != MessageKind.system &&
        prev.kind != MessageKind.system &&
        m.meta['kind'] == null &&
        prev.meta['kind'] == null &&
        m.createdAt.difference(prev.createdAt) < continuationWindow;
    out.add(FeedMessage(m, continued: continued, dayBreak: dayBreak));
    prev = m;
  }
  flush();
  return out;
}

/// 접힌 에이전트 주고받기 — 그 구간의 줄들([items])을 한 줄로 접는다.
///
/// **무엇을 접는지는 여기서 정하지 않는다** — 데스크톱과 같은 판정(`agent_exchange.dart`)이 낸
/// 구간을 그대로 옮길 뿐이다. 이 타입은 그 구간을 이미 지은 줄들([buildFeed])에 덧씌운다.
class FeedExchange extends FeedItem {
  const FeedExchange({required this.items, required this.slot});

  /// 펼치면 원래 자리에 그대로 서는 줄들(진행 묶음 포함).
  final List<FeedItem> items;

  /// 판정이 낸 구간 — 참여자·결론·마지막 말을 읽는다.
  final FoldExchange slot;

  /// 펼침 상태의 키 — 구간의 첫 행 id. 새 답글이 붙어도 앞머리는 그대로다.
  String get key => slot.rows.first.id;
}

/// [feed] 의 줄 중 [slots] 가 주고받기로 접은 구간을 [FeedExchange] 로 덮는다.
///
/// 줄 경계가 어긋나지 않는 이유: 진행 묶음은 양쪽 다 「같은 저자의 연속 진행」이고, 주고받기
/// 구간은 그 묶음을 쪼개지 않는다(구간은 말 사이 또는 맨 끝의 도는 진행 앞에서만 끊긴다).
/// 접힌 구간 바로 뒤의 말은 이어 말한 줄로 붙이지 않는다 — 머리(이름)가 접힌 줄 안에 있으면
/// 그 말이 누구 것인지 사라진다.
List<FeedItem> foldExchanges(List<FeedItem> feed, List<FoldSlot> slots) {
  final owner = <String, FoldExchange>{};
  for (final s in slots) {
    if (s is FoldExchange) {
      for (final m in s.rows) {
        owner[m.id] = s;
      }
    }
  }
  if (owner.isEmpty) return feed;

  String firstId(FeedItem it) => switch (it) {
        FeedMessage(:final message) => message.id,
        FeedProgressRun(:final run) => run.first.id,
        FeedExchange(:final key) => key,
      };

  final out = <FeedItem>[];
  FoldExchange? open;
  var group = <FeedItem>[];
  void close() {
    if (open == null) return;
    out.add(FeedExchange(items: List.unmodifiable(group), slot: open!));
    open = null;
    group = <FeedItem>[];
  }

  for (final it in feed) {
    final ex = owner[firstId(it)];
    if (ex != null && identical(ex, open)) {
      group.add(it);
      continue;
    }
    final wasFolded = open != null;
    close();
    if (ex != null) {
      open = ex;
      group.add(it);
      continue;
    }
    out.add(wasFolded && it is FeedMessage && it.continued
        ? FeedMessage(it.message, dayBreak: it.dayBreak)
        : it);
  }
  close();
  return out;
}
