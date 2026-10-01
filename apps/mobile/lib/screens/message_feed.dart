import '../api/models.dart';

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
        m.meta['kind'] == null &&
        prev.meta['kind'] == null &&
        m.createdAt.difference(prev.createdAt) < continuationWindow;
    out.add(FeedMessage(m, continued: continued, dayBreak: dayBreak));
    prev = m;
  }
  flush();
  return out;
}
