import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import 'message_feed.dart';
import 'message_list_screen.dart';

/// 스레드 하나. 루트를 맨 위에 두고 그 아래 답글이 붙는다.
///
/// ## 왜 따로 읽나
///
/// 채널 목록에는 **루트만** 실린다. 답글까지 채널에 섞으면 스레드를 만든 이유가
/// 지워지고(긴 작업 하나가 채널을 덮는다), 목록 응답도 스레드 수만큼 부푼다.
/// 그래서 여기서 `?thread=` 로 따로 읽는다.
class ThreadScreen extends StatefulWidget {
  const ThreadScreen({super.key, required this.channelId, required this.rootId});

  final String channelId;
  final String rootId;

  @override
  State<ThreadScreen> createState() => _ThreadScreenState();
}

class _ThreadScreenState extends State<ThreadScreen> {
  final _composer = TextEditingController();
  bool _sending = false;

  bool _loaded = false;

  /// **`initState` 가 아니라 여기서 읽는다.**
  ///
  /// `context.app` 은 `InheritedWidget` 을 구독하는 일이고, Flutter 는 그것을
  /// `initState` 안에서 금지한다(*"dependOnInheritedWidgetOfExactType was called before
  /// initState() completed"*). 시험이 이걸 잡았다 — 실기기였으면 스레드를 처음 여는
  /// 순간 빨간 화면이었다.
  ///
  /// `didChangeDependencies` 는 의존이 바뀔 때마다 다시 불리므로 한 번만 읽도록 막는다.
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_loaded) return;
    _loaded = true;
    // 루트는 채널에서 이미 왔지만 답글은 여기서 처음 온다.
    context.app.openThread(widget.channelId, widget.rootId);
  }

  @override
  void dispose() {
    _composer.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() => _sending = true);
    // 먼저 비운다 — 남아 있으면 사람은 안 갔다고 생각하고 다시 누른다.
    _composer.clear();
    try {
      await context.app.send(widget.channelId, text, threadRootId: widget.rootId);
    } on Object {
      if (mounted) _composer.text = text;
      rethrow;
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;

    MessageRow? root;
    for (final m in app.messages[widget.channelId] ?? const <MessageRow>[]) {
      if (m.id == widget.rootId) {
        root = m;
        break;
      }
    }
    // 채널 화면에서 들어온 답글은 **말풍선이 되는 것만** 그린다(`progress`·`wake` 제외) —
    // 채널에서와 같은 기준이어야 같은 스레드가 두 화면에서 달라 보이지 않는다.
    final replies = buildFeed(app.threads[widget.rootId] ?? const <MessageRow>[]);

    return Scaffold(
      appBar: AppBar(title: Text(t.threadTitle)),
      body: SafeArea(
        child: Column(
          children: [
            // `onOpenThread` 를 주지 않는다 — **이미 스레드 안이라 들어갈 곳이 없다.**
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(vertical: 8),
                children: [
                  if (root != null) buildFeedItem(context, FeedMessage(root)),
                  if (root != null) const Divider(),
                  ...replies.map((item) => buildFeedItem(context, item)),
                ],
              ),
            ),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 8, 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      key: const Key('thread-composer'),
                      controller: _composer,
                      minLines: 1,
                      maxLines: 5,
                      decoration: InputDecoration(
                        hintText: t.threadReplyHint,
                        border: const OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                  IconButton(
                    key: const Key('thread-send'),
                    tooltip: t.composerSend,
                    icon: const Icon(Icons.send),
                    onPressed: _sending ? null : _send,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

}
