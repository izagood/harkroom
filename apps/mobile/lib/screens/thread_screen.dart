import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../mention/sticky.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../ui/parts.dart';
import '../ui/states.dart';
import 'agent_model.dart';
import 'composer_attachments.dart';
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
  /// 작성칸 모델 칩으로 고른 값(서버 079). 서버의 스레드 지정이 되므로 보낸 뒤에도 칩은 그 값을 이어 보인다.
  Map<String, ModelPick> _picks = const {};

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
    final app = context.app;
    // 첨부가 올라가는 중이면 비우지 않고 멈춘다(채널 화면과 같은 이유).
    if (app.isUploading(widget.rootId)) return;
    setState(() => _sending = true);
    // 먼저 비운다 — 남아 있으면 사람은 안 갔다고 생각하고 다시 누른다. 못 보낸 말은 목록에 남는다.
    _composer.clear();
    final picks = _picks;
    setState(() => _picks = const {});
    // 자동·고정 멘션을 붙인 것이 **서버로 가는 본문**이다(채널 화면과 같다). 모델 지정도 이 본문으로
    // 센다 — 친 글로 세면 고정으로 부른 에이전트에게 고른 모델이 빠진다.
    final body = withStickyMentions(text, app.composerPrefix(widget.channelId, widget.rootId));
    try {
      final went = await app.send(
        widget.channelId,
        body,
        threadRootId: widget.rootId,
        agentModels: picksForBody(
          picks, body, app.accounts.values,
          threadRows: app.threadAgentModels[widget.rootId] ?? const [],
        ),
      );
      // 이번에 부른 상대는 다음 줄부터 고정이다.
      if (went) {
        app.keepStickyMentions(widget.rootId, text);
        // 이번만 뺀 자동 멘션은 이 글로 끝이다 — 다음 글에는 다시 붙는다.
        app.clearAutoSkips(widget.rootId);
      }
      if (!went && mounted) {
        if (_composer.text.isEmpty) _composer.text = text;
        setState(() => _picks = picks);
      }
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
    final failed = app.failedSends[widget.rootId] ?? const <FailedSend>[];
    final load = app.threadLoad[widget.rootId];
    // 머리 모델 줄에 세울 에이전트: 스레드 글의 작성자 중 에이전트 + 본문이 부른 에이전트.
    final threadAgents = <String>[];
    for (final m in [?root, ...?app.threads[widget.rootId]]) {
      if (app.accounts[m.authorId]?.isAgent ?? false) {
        if (!threadAgents.contains(m.authorId)) threadAgents.add(m.authorId);
      }
      for (final id in calledAgentIds(m.body, app.accounts.values)) {
        if (!threadAgents.contains(id)) threadAgents.add(id);
      }
    }

    return Scaffold(
      appBar: AppBar(title: Text(t.threadTitle)),
      body: SafeArea(
        child: Column(
          children: [
            ThreadModelBar(channelId: widget.channelId, rootId: widget.rootId, agentIds: threadAgents),
            // `onOpenThread` 를 주지 않는다 — **이미 스레드 안이라 들어갈 곳이 없다.**
            const ConnectionBand(),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(vertical: 8),
                children: [
                  if (root != null) buildFeedItem(context, FeedMessage(root)),
                  if (root != null) const Divider(),
                  // 원글은 채널에서 이미 왔으니 늘 보인다. **답글 자리만** 상태 셋으로 나눈다.
                  if (load == null || load == LoadState.loading)
                    const SizedBox(height: 200, child: LoadingSkeleton(rows: 2))
                  else if (load == LoadState.failed)
                    SizedBox(
                      height: 220,
                      child: FailedState(
                        title: t.threadLoadFailed,
                        cause: app.failures[widget.rootId] ?? LoadFailure.network,
                        onRetry: () => app.openThread(widget.channelId, widget.rootId),
                      ),
                    )
                  else
                    ...replies.map((item) => buildFeedItem(context, item)),
                  ...failed.map((item) => FailedSendRow(item: item)),
                ],
              ),
            ),
            // **스레드의 작성칸은 자기 키를 쓴다** — 채널에서 고른 사진이 답글에
            // 딸려 가지 않게.
            // 스레드 화면에도 `@` 후보 줄을 둔다 — 없던 동안 스레드 안에서는 모델을 고를 길이 없었다.
            MentionModelBar(
              controller: _composer,
              picks: _picks,
              channelId: widget.channelId,
              composerKey: widget.rootId,
              threadRootId: widget.rootId,
              onPicksChanged: (next) => setState(() => _picks = next),
            ),
            ComposerAttachments(composerKey: widget.rootId),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 8, 8, 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  AttachButton(composerKey: widget.rootId),
                  Expanded(
                    child: TextField(
                      key: const Key('thread-composer'),
                      controller: _composer,
                      onChanged: (_) => setState(() {}),
                      minLines: 1,
                      maxLines: 5,
                      decoration: composerDecoration(context, t.threadReplyHint),
                    ),
                  ),
                  SendButton(
                    key: const Key('thread-send'),
                    composerKey: widget.rootId,
                    busy: _sending,
                    empty: _composer.text.trim().isEmpty,
                    onPressed: _send,
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
