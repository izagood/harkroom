import 'package:flutter/material.dart';

import '../ui/tokens.dart';
import 'message_feed.dart';

/// 맨 아래에서 벗어나 읽는 동안 **보던 줄을 고정한다** — 채널과 스레드가 함께 쓴다.
///
/// `reverse` 목록에서 새 줄은 offset 0 쪽에 끼어들어, offset 이 그대로면 보던 줄이 그 높이만큼 밀린다. 화면 밖 줄은
/// 짓지 않아 높이를 모르므로 offset 을 보정할 수 없다. 대신 목록을 **본 자리에서 둘로 가른다**: 본 줄은 기준(center)
/// 위로, 그 뒤에 온 줄은 기준 아래 조각으로 쌓는다. 기준이 그대로이니 보던 줄이 움직이지 않고, 아래로 내리면 새 줄을
/// 차례로 지나간다. 그동안 맨 아래는 0 이 아니라 `minScrollExtent` 다.
///
/// 맨 아래에 닿아 굴림이 멎으면 두 조각을 다시 하나로 합친다(offset 0 = 맨 아래로 돌아온다). 굴리는 중에 합치면
/// 도는 굴림이 옛 좌표로 다음 값을 써 버리므로 멎기를 기다린다.
class FeedPin {
  FeedPin(this.scroll, {required this.rebuild}) {
    scroll.addListener(_track);
  }

  final ScrollController scroll;
  final void Function(VoidCallback) rebuild;

  /// 맨 아래 근처 기준(px). 이 안이면 맨 아래 줄이 보인다고 본다.
  static const double bottomSlop = 48;

  bool atBottom = true;

  /// 맨 아래에서 한 화면 넘게 올라갔는가.
  bool far = false;

  /// 맨 아래에서 마지막으로 본 seq. 그 뒤의 줄이 「새 줄」이고 기준 아래로 간다. 옛 페이지를 받아도 목록이 자라므로
  /// 길이 차로 세지 않는다.
  int? seenSeq;

  /// 기준 아래에 줄이 있는가 — 화면이 빌드에서 적는다.
  bool hasBelow = false;

  void dispose() => scroll.removeListener(_track);

  void _track() {
    if (!scroll.hasClients) return;
    final pos = scroll.position;
    final distance = pos.pixels - pos.minScrollExtent;
    final nextAtBottom = distance < bottomSlop;
    final nextFar = distance > pos.viewportDimension;
    if (nextAtBottom == atBottom && nextFar == far) return;
    rebuild(() {
      atBottom = nextAtBottom;
      far = nextFar;
    });
  }

  /// 빌드에서 부른다. 처음 받은 줄·맨 아래에서 보이는 줄은 새 것이 아니다. 기준 아래에 줄이 남아 있으면 합칠 때까지
  /// 그대로 둔다 — 여기서 비우면 좌표가 어긋난다.
  void markSeen(Iterable<int> seqs) {
    if (seenSeq != null && (!atBottom || hasBelow)) return;
    seenSeq = seqs.isEmpty ? 0 : seqs.reduce((a, b) => a > b ? a : b);
  }

  /// [items] 중 기준 아래로 갈 첫 줄의 자리. 없으면 길이. 앞머리가 본 줄이면(본 줄에 새 줄이 붙은 묶음) 기준 위에 둔다.
  int firstNew(List<FeedItem> items) {
    final seen = seenSeq;
    if (seen == null) return items.length;
    final i = items.indexWhere((item) => feedItemSeq(item) > seen);
    return i < 0 ? items.length : i;
  }

  /// 목록의 굴림 알림을 여기로 흘린다.
  bool onNotification(ScrollNotification n) {
    if (n.depth == 0 && n is ScrollEndNotification && hasBelow) {
      // 멎은 뒤의 상태로 보려고 프레임 끝에 본다. 멎으면 다음 프레임이 없을 수 있어 하나 청한다.
      WidgetsBinding.instance
        ..addPostFrameCallback((_) => _merge())
        ..ensureVisualUpdate();
    }
    return false;
  }

  void _merge() {
    if (!hasBelow || !scroll.hasClients) return;
    final pos = scroll.position;
    final distance = pos.pixels - pos.minScrollExtent;
    if (distance >= bottomSlop || pos.isScrollingNotifier.value) return;
    // 맨 아래에서 잰 거리는 그대로다 — 합친 뒤의 0 이 지금의 min 이다.
    pos.correctPixels(distance);
    rebuild(() {
      hasBelow = false;
      seenSeq = null;
    });
  }

  /// 내가 글을 보내면 맨 아래로 간다 — 내 글이 기준 아래 화면 밖에 서면 안 간 것으로 보인다.
  void revealOwnSend() {
    if (!atBottom) jumpFeedToBottom(scroll);
  }
}

int feedItemSeq(FeedItem item) => switch (item) {
      FeedMessage(:final message) => message.seq,
      FeedProgressRun(:final run) => run.first.seq,
      FeedExchange(:final slot) => slot.rows.first.seq,
    };

/// 맨 아래로 굴린다. 화면 밖 줄은 짓지 않아 높이를 어림하므로, 닿은 프레임의 배치에서 실제 높이로 고쳐져 한 줄쯤 위에
/// 멈출 수 있다(시험이 잡았다 — 위로 굴린 동안 새 답글이 붙은 경우). 그 프레임이 끝난 뒤 남았으면 맨 아래로 붙인다.
void scrollFeedToBottom(ScrollController scroll) {
  scroll.animateTo(scroll.position.minScrollExtent, duration: HarkroomMotion.base, curve: HarkroomMotion.ease).then((_) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (scroll.hasClients && scroll.position.pixels > scroll.position.minScrollExtent) {
        scroll.jumpTo(scroll.position.minScrollExtent);
      }
    });
  });
}

/// 알약의 맨 아래 가기 — 세 화면보다 멀면 한 화면 거리로 먼저 건너뛰고 굴린다(긴 애니메이션은 지연 빌드로
/// 버벅이고 오래 걸린다).
void jumpFeedToBottom(ScrollController scroll) {
  if (!scroll.hasClients) return;
  final pos = scroll.position;
  if (pos.pixels - pos.minScrollExtent > pos.viewportDimension * 3) {
    scroll.jumpTo(pos.minScrollExtent + pos.viewportDimension);
  }
  scrollFeedToBottom(scroll);
}

/// 기준이 되는 조각의 키 — 시험이 여백을 읽을 때도 쓴다.
const feedCenterKey = ValueKey('feed-center');

/// 아래에서부터 쌓는 피드 목록. [older] 는 본 줄(기준 위), [below] 는 기준 아래 줄이다. [padding] 의 아래 여백은 늘
/// 기준 위 조각에 남긴다 — 빼면 그만큼 보던 줄이 움직인다.
Widget feedScrollView({
  required Key key,
  required ScrollController controller,
  required EdgeInsets padding,
  required Widget older,
  Widget? below,
}) =>
    CustomScrollView(
      key: key,
      controller: controller,
      reverse: true,
      center: feedCenterKey,
      // 짧은 채널도 늘 끌리게 둔다 — 끌기 시작이 키보드를 내린다([FeedKeyboardDismiss]).
      // 안 그러면 Android 에서 한 화면에 다 드는 채널은 끌기가 아예 시작되지 않는다.
      physics: const AlwaysScrollableScrollPhysics(),
      slivers: [
        if (below != null) SliverPadding(padding: EdgeInsets.only(bottom: padding.bottom), sliver: below),
        SliverPadding(key: feedCenterKey, padding: padding, sliver: older),
      ],
    );
