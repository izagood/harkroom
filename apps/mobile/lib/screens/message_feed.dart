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
  const FeedMessage(this.message);
  final MessageRow message;
}

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

  for (final m in messages) {
    if (m.kind == MessageKind.progress) {
      if (run.isNotEmpty && run.last.authorId != m.authorId) flush();
      run.add(m);
      continue;
    }
    flush();
    out.add(FeedMessage(m));
  }
  flush();
  return out;
}
