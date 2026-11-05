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
/// 기준 자리의 틈은 아래 여백 높이 그대로다 — 줄이면 그만큼 보던 줄이 움직인다. 갈라진 동안 이 틈에 구분선을 긋는다.
///
/// **합치기(offset 0 = 맨 아래로 되돌리기)는 틈이 화면 위로 사라진 뒤에만 한다.** 합치면 틈이 없어지는데, 맨 아래에서는
/// 더 내려갈 자리가 없어 offset 으로 메울 수 없다 — 틈이 보일 때 합치면 그 위 줄이 틈 높이만큼 내려앉는다. 그래서
/// 틈이 보이는 동안은 갈라진 채 맨 아래를 따라가고([_follow]), 새 줄이 쌓여 틈이 밀려 올라가면 합친다. 굴리는 중에
/// 합치면 도는 굴림이 옛 좌표로 다음 값을 써 버리므로 멎기를 기다린다.
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

  /// 맨 아래에서 마지막으로 본 seq. 그 뒤에 온 남의 말을 알약에 센다. 옛 페이지를 받아도 목록이 자라므로 길이 차로
  /// 세지 않는다.
  int? seenSeq;

  /// 가른 자리의 seq. 이 뒤의 줄이 기준 아래로 간다. 맨 아래로 돌아와도 합칠 때까지 그대로다([seenSeq] 와 다른 점).
  int? boundarySeq;

  /// 기준 아래에 줄이 있는가.
  bool hasBelow = false;

  bool _followPending = false;

  /// 방금 맨 아래로 돌아왔다. 그때 [seenSeq] 뒤의 줄은 내려오며 본 줄이지 새로 온 줄이 아니라 따라가지 않는다 — 따라가면
  /// 맨 아래 근처에서 멈춘 손을 끝까지 끌어내린다.
  bool _returned = false;

  void dispose() => scroll.removeListener(_track);

  void _track() {
    if (!scroll.hasClients) return;
    final pos = scroll.position;
    final distance = pos.pixels - pos.minScrollExtent;
    final nextAtBottom = distance < bottomSlop;
    final nextFar = distance > pos.viewportDimension;
    if (nextAtBottom == atBottom && nextFar == far) return;
    rebuild(() {
      if (nextAtBottom && !atBottom) _returned = true;
      atBottom = nextAtBottom;
      far = nextFar;
    });
  }

  /// 빌드에서 부른다. 처음 받은 줄·맨 아래에서 보이는 줄은 새 것이 아니다. 맨 아래가 아닐 때 새 줄이 오면 본 자리에서
  /// 가른다. 갈라진 채 맨 아래에 있으면 새 줄을 따라간다.
  void markSeen(Iterable<int> seqs) {
    final latest = seqs.isEmpty ? 0 : seqs.reduce((a, b) => a > b ? a : b);
    final seen = seenSeq;
    if (seen != null && !atBottom) {
      if (latest > seen) boundarySeq ??= seen;
      return;
    }
    if (seen != null && latest > seen && boundarySeq != null && !_returned) _scheduleFollow();
    _returned = false;
    seenSeq = latest;
  }

  /// [items] 중 기준 아래로 갈 첫 줄의 자리. 없으면 길이. 앞머리가 본 줄이면(본 줄에 새 줄이 붙은 묶음) 기준 위에 둔다.
  /// 결과로 [hasBelow] 를 적는다.
  int firstNew(List<FeedItem> items) {
    final boundary = boundarySeq;
    final i = boundary == null ? -1 : items.indexWhere((item) => feedItemSeq(item) > boundary);
    hasBelow = i >= 0;
    // 아래에 줄이 없는 채 맨 아래로 돌아왔으면 가를 까닭이 없다 — 남겨 두면 다음 줄이 맨 아래인데도 갈린다.
    if (!hasBelow && atBottom) boundarySeq = null;
    return i < 0 ? items.length : i;
  }

  /// 목록의 굴림 알림을 여기로 흘린다.
  bool onNotification(Notification n) {
    // 끝 추정이 고쳐져도 컨트롤러 듣는 이에게는 오지 않는다 — 여기서 자리를 다시 잰다.
    if (n is ScrollMetricsNotification && n.depth == 0) _track();
    if (n is ScrollEndNotification && n.depth == 0 && hasBelow) {
      // 멎은 뒤의 상태로 보려고 프레임 끝에 본다. 멎으면 다음 프레임이 없을 수 있어 하나 청한다.
      WidgetsBinding.instance
        ..addPostFrameCallback((_) => _settle())
        ..ensureVisualUpdate();
    }
    return false;
  }

  void _scheduleFollow() {
    _followPending = true;
    WidgetsBinding.instance
      ..addPostFrameCallback((_) => _settle())
      ..ensureVisualUpdate();
  }

  /// 굴림이 멎었을 때: 따라갈 줄이 있으면 맨 아래로 붙이고, 틈이 화면 위로 사라졌으면 합친다.
  void _settle() {
    if (!hasBelow || !scroll.hasClients) return;
    final pos = scroll.position;
    if (pos.isScrollingNotifier.value) return; // 멎으면 이 함수가 다시 불린다.
    if (_followPending) {
      _followPending = false;
      _follow(pos);
    }
    final distance = pos.pixels - pos.minScrollExtent;
    if (distance >= bottomSlop) return;
    if (pos.pixels + pos.viewportDimension > 0) return; // 틈이 아직 화면 안이다.
    // 맨 아래에서 잰 거리는 그대로다 — 합친 뒤의 0 이 지금의 min 이다. 틈 위 줄은 화면 밖이라 보이지 않는다.
    // 끝 추정이 줄어 min 밖에 남아 있었으면(음수) 맨 아래로 친다.
    pos.correctPixels(distance < 0 ? 0 : distance);
    rebuild(() {
      hasBelow = false;
      boundarySeq = null;
      atBottom = true;
      far = false;
    });
  }

  void _follow(ScrollPosition pos) {
    if (pos.pixels > pos.minScrollExtent) pos.jumpTo(pos.minScrollExtent);
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
      if (scroll.hasClients && scroll.position.pixels != scroll.position.minScrollExtent) {
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

/// 기준 자리 틈의 키 — 시험이 높이를 읽을 때도 쓴다.
const feedGapKey = ValueKey('feed-gap');

/// 머리·띠를 비우는 위 여백 조각의 키 — 시험이 읽는다.
const feedOlderKey = ValueKey('feed-older');

const _feedCenterKey = ValueKey('feed-center');

/// 구분선에 글자를 넣을 수 있는 틈의 최소 높이.
const double feedDividerLabelMinHeight = 20;

/// 기준 자리의 틈에 긋는 「새 답글」·「새 메시지」 구분선. 틈 높이를 바꾸지 않는다.
class FeedNewDivider extends StatelessWidget {
  const FeedNewDivider({super.key, required this.height, required this.label});

  final double height;
  final String label;

  @override
  Widget build(BuildContext context) {
    final accent = context.tokens.accent;
    final line = Expanded(child: ColoredBox(key: const Key('feed-new-divider-line'), color: accent, child: const SizedBox(height: 1)));
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter),
      child: Row(
        children: [
          line,
          if (height >= feedDividerLabelMinHeight) ...[
            const SizedBox(width: 8),
            Text(label, style: TextStyle(fontSize: 11, fontWeight: FontWeight.w600, color: accent)),
            const SizedBox(width: 8),
            line,
          ],
        ],
      ),
    );
  }
}

/// 아래에서부터 쌓는 피드 목록. [older] 는 본 줄(기준 위), [below] 는 기준 아래 줄이다. [padding] 의 아래 높이는 늘
/// 기준 자리의 틈으로 남긴다 — 빼면 그만큼 보던 줄이 움직인다. [below] 가 있으면 틈에 [dividerLabel] 구분선을 긋는다.
Widget feedScrollView({
  required Key key,
  required ScrollController controller,
  required EdgeInsets padding,
  required Widget older,
  required String dividerLabel,
  Widget? below,
}) =>
    CustomScrollView(
      key: key,
      controller: controller,
      reverse: true,
      center: _feedCenterKey,
      // 짧은 채널도 늘 끌리게 둔다 — 끌기 시작이 키보드를 내린다([FeedKeyboardDismiss]).
      // 안 그러면 Android 에서 한 화면에 다 드는 채널은 끌기가 아예 시작되지 않는다.
      physics: const AlwaysScrollableScrollPhysics(),
      slivers: [
        if (below != null) SliverPadding(padding: EdgeInsets.only(bottom: padding.bottom), sliver: below),
        SliverToBoxAdapter(
          key: _feedCenterKey,
          child: SizedBox(
            key: feedGapKey,
            height: padding.bottom,
            child: below == null ? null : FeedNewDivider(height: padding.bottom, label: dividerLabel),
          ),
        ),
        SliverPadding(key: feedOlderKey, padding: EdgeInsets.only(top: padding.top), sliver: older),
      ],
    );
