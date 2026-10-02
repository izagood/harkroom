import 'dart:async';

import 'package:flutter/material.dart';

import '../i18n/i18n.dart';
import '../screens/message_list_screen.dart';
import '../screens/thread_screen.dart';
import '../state/app_scope.dart';
import 'push_coordinator.dart';
import 'push_platform.dart';

/// 준비된 앱(홈) 위에 서서 푸시의 화면 일을 한다.
/// - 첫 로그인 뒤 **한 번** 안내 시트를 띄운다(결정 7). OS 권한 창은 사람이 [켜기]를 누를 때만 뜬다
///   — 이유를 모르는 채로 뜬 시스템 창은 거절되기 쉽고, 한 번 거절하면 앱이 다시 물을 수 없다.
/// - 누른 알림이 가리키는 채널·스레드를 연다(커뮤니티 전환은 [PushCoordinator] 가 이미 했다).
class PushGate extends StatefulWidget {
  const PushGate({super.key, required this.push, required this.child});

  final PushCoordinator? push;
  final Widget child;

  @override
  State<PushGate> createState() => _PushGateState();
}

class _PushGateState extends State<PushGate> {
  @override
  void initState() {
    super.initState();
    final push = widget.push;
    if (push == null) return;
    push.addListener(_consume);
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      if (!mounted) return;
      _consume();
      await push.start();
      if (mounted) await _maybePrompt(push);
    });
  }

  @override
  void dispose() {
    widget.push?.removeListener(_consume);
    super.dispose();
  }

  Future<void> _maybePrompt(PushCoordinator push) async {
    try {
      if (await push.platform.status() != PushPermission.notDetermined) return;
      if (await push.platform.wasPrompted()) return;
    } on Object {
      return; // 채널 없음 — 푸시 없는 환경
    }
    if (!mounted) return;
    final enable = await showModalBottomSheet<bool>(
      context: context,
      showDragHandle: true,
      builder: (context) => const _PushPromptSheet(),
    );
    if (enable == true) {
      await push.enable();
    } else {
      await push.platform.markPrompted();
    }
  }

  void _consume() {
    final push = widget.push;
    if (push == null || !mounted) return;
    final target = push.takePending();
    if (target == null) return;
    final app = context.app;
    unawaited(app.openChannel(target.channelId));
    final root = target.threadRootId;
    unawaited(Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => root == null
          ? MessageListScreen(channelId: target.channelId)
          : ThreadScreen(channelId: target.channelId, rootId: root),
    )));
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class _PushPromptSheet extends StatelessWidget {
  const _PushPromptSheet();

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    // 큰 글자·작은 화면에서도 넘치지 않게 스크롤로 둔다.
    return SafeArea(
      child: SingleChildScrollView(
        key: const Key('push-prompt'),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(24, 0, 24, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Icon(Icons.notifications_active_outlined, size: 40),
            const SizedBox(height: 12),
            Text(t.pushPromptTitle, textAlign: TextAlign.center, style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            Text(t.pushPromptBody, textAlign: TextAlign.center),
            const SizedBox(height: 20),
            FilledButton(
              key: const Key('push-prompt-enable'),
              onPressed: () => Navigator.of(context).pop(true),
              child: Text(t.pushPromptEnable),
            ),
            TextButton(
              key: const Key('push-prompt-later'),
              onPressed: () => Navigator.of(context).pop(false),
              child: Text(t.pushPromptLater),
            ),
          ],
        ),
      ),
      ),
    );
  }
}
