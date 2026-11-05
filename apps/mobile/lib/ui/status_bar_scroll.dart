import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

/// iOS 상태 표시줄을 누르면 [controller] 의 목록을 **화면 위쪽 끝**으로 굴린다.
///
/// [Scaffold] 도 같은 일을 하지만 [PrimaryScrollController] 만 굴리고, 늘 offset 0 으로 간다. 채널·스레드는
/// 제 손잡이를 쓰는 데다 `reverse` 라서 offset 0 이 맨 아래(최신)다 — 그래서 여기서 따로 받는다.
///
/// 앞에 보이는 화면인지는 Scaffold 와 같은 방법으로 가린다: (0,0) 을 hit test 해서 이 위젯이 경로에 있어야 한다.
/// 그래야 숨은 탭·덮인 경로·시트 뒤의 목록이 같이 굴러가지 않는다. 그 까닭에 [child] 는 Scaffold 째로 감싼다 —
/// 목록만 감싸면 (0,0) 을 머리(AppBar)가 먼저 받아 이 위젯까지 오지 않는다.
class StatusBarScroll extends StatefulWidget {
  const StatusBarScroll({super.key, required this.controller, required this.child});

  final ScrollController controller;
  final Widget child;

  @override
  State<StatusBarScroll> createState() => _StatusBarScrollState();
}

class _StatusBarScrollState extends State<StatusBarScroll> with WidgetsBindingObserver {
  final _key = GlobalKey();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  bool get _inForeground {
    final target = _key.currentContext?.findRenderObject();
    if (target == null) return false;
    final result = HitTestResult();
    WidgetsBinding.instance.hitTestInView(result, Offset.zero, View.of(context).viewId);
    return result.path.any((entry) => entry.target == target);
  }

  @override
  void handleStatusBarTap() {
    super.handleStatusBarTap();
    if (widget.controller.hasClients && _inForeground) scrollToVisualTop(widget.controller).ignore();
  }

  @override
  Widget build(BuildContext context) =>
      MetaData(key: _key, behavior: HitTestBehavior.translucent, child: widget.child);
}

/// 목록을 화면 위쪽 끝으로 굴린다 — `reverse` 면 실어 둔 것 중 **가장 오래된 쪽**이다.
///
/// 줄 높이가 제각각인 지연 목록의 끝은 추정값이라 첫 굴림이 끝에 못 미치고 끝날 수 있어, 닿을 때까지 몇 번 더
/// 짧게 굴린다. 끝에 닿으면 이전 페이지 받기는 목록의 평소 길(`_maybeLoadOlder`)을 탄다. 전체 기록까지 쫓아가지
/// 않도록 횟수를 묶었다 — 더 오래된 말로 가려면 한 번 더 누른다. 손가락이 끼어들면 그 자리에서 멈춘다.
Future<void> scrollToVisualTop(ScrollController controller) async {
  const legs = 3;
  for (var i = 0; i < legs; i++) {
    if (!controller.hasClients) return;
    final pos = controller.position;
    final target = pos.axisDirection == AxisDirection.up ? pos.maxScrollExtent : pos.minScrollExtent;
    if ((pos.pixels - target).abs() < 1) return;
    // 첫 굴림의 시간·곡선은 Scaffold 의 상태 표시줄 처리와 같다 — 앱 안 어느 목록에서든 같은 느낌으로.
    await controller.animateTo(
      target,
      duration: Duration(milliseconds: i == 0 ? 1000 : 250),
      curve: Curves.easeOutCirc,
    );
    if (!controller.hasClients || (controller.position.pixels - target).abs() >= 1) return;
  }
}
