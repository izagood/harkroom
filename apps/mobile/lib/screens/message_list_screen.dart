import 'package:flutter/material.dart';

import '../api/agent_meta.dart';
import '../api/ask.dart';
import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../ui/states.dart';
import 'agent_model.dart';
import 'agent_rows.dart';
import 'ask_card.dart';
import 'composer_attachments.dart';
import 'message_feed.dart';
import 'message_tile.dart';
import 'thread_screen.dart';

/// 한 채널의 말들 + 작성칸. P0 의 마지막 화면이다.
///
/// **스레드는 아직 열지 않는다**(P1). 지금은 채널의 흐름을 한 줄로 보여 주고, 답글이
/// 달린 루트에는 그 사실만 표시한다 — 없는 화면으로 들어가는 문을 그리지 않는다.
class MessageListScreen extends StatefulWidget {
  const MessageListScreen({super.key, required this.channelId});

  final String channelId;

  @override
  State<MessageListScreen> createState() => _MessageListScreenState();
}

class _MessageListScreenState extends State<MessageListScreen> {
  final _composer = TextEditingController();
  final _scroll = ScrollController();
  bool _sending = false;
  /// 작성칸 모델 칩으로 고른 값(서버 079). 보내면 비운다(결정 12).
  Map<String, ModelPick> _picks = const {};

  @override
  void dispose() {
    _composer.dispose();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _composer.text.trim();
    if (text.isEmpty || _sending) return;
    final app = context.app;
    // 첨부가 올라가는 중이면 **비우지 않고 멈춘다**(버튼도 잠겨 있다) — 전에는 비운 뒤에
    // 보내기가 조용히 멈춰 친 글이 사라졌다.
    if (app.isUploading(widget.channelId)) return;
    setState(() => _sending = true);
    // **먼저 비운다.** 보내는 동안 글자가 남아 있으면 사람은 안 갔다고 생각하고 다시
    // 누른다. 못 보낸 말은 작성칸이 아니라 목록 안에 "보내지 못했다"로 남는다.
    _composer.clear();
    final picks = _picks;
    setState(() => _picks = const {});
    try {
      final went = await app.send(
        widget.channelId,
        text,
        agentModels: picksForBody(picks, text, app.accounts.values),
      );
      // 못 보냈으면(첨부가 올라가는 중) 친 글과 고른 모델을 작성칸에 되돌린다.
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
    final all = app.messages[widget.channelId] ?? const <MessageRow>[];
    // `progress`·`wake` 는 말풍선이 아니다(서버가 `kind` 로 이미 갈라 준다). P0 에서는
    // 그것들을 **그리지 않는다** — 상태 줄·대기 줄은 P2 의 일이고, 그 전까지 말풍선으로
    // 흘리면 채널이 진행 로그로 덮인다.
    // **이제 전부 그린다.** P1 까지는 `progress`·`wake` 를 버렸는데, 그러면 오래 도는
    // 스레드가 조용해 보였다 — 진행은 한 줄로 접히고 대기는 대기 줄이 된다.
    final feed = buildFeed(all.where((m) => m.inChannelFeed).toList(growable: false));
    final failed = app.failedSends[widget.channelId] ?? const <FailedSend>[];
    // `firstOrNull` 은 `package:collection` 것이다. 의존성 하나를 이것 때문에 들이지
    // 않는다 — 채널이 목록에서 사라지는 경우(다른 기기에서 나갔다)가 있으므로 null 은
    // 정상이고, 그때 제목은 빈 줄로 둔다.
    ChannelRow? channel;
    for (final c in app.channels) {
      if (c.id == widget.channelId) {
        channel = c;
        break;
      }
    }

    return Scaffold(
      appBar: AppBar(title: Text(channel?.name ?? '')),
      body: SafeArea(
        child: Column(
          children: [
            const ConnectionBand(),
            Expanded(
              child: switch (app.channelLoad[widget.channelId]) {
                // 아직 판정 전(열자마자)도 읽는 중으로 본다 — 그 한 프레임에 "비어 있다"가
                // 스쳐 지나가면 사람은 빈 채널로 읽는다.
                null || LoadState.loading => const LoadingSkeleton(),
                LoadState.failed => FailedState(
                    title: t.messagesLoadFailed,
                    cause: app.failures[widget.channelId] ?? LoadFailure.network,
                    onRetry: () => app.openChannel(widget.channelId),
                  ),
                LoadState.loaded => feed.isEmpty && failed.isEmpty
                  ? EmptyState(title: t.messagesEmpty, hint: t.messagesEmptyHint)
                  // **아래에서부터 쌓는다**(`reverse`). 위에서부터면 채널을 열었을 때 불러온
                  // 50개 중 **가장 오래된 것**이 보이고, 새 말은 화면 밖 아래로 붙는다 —
                  // 채팅에서 사람이 보려는 것은 늘 맨 아래다. 짧은 시험 목록에서는 한 화면에
                  // 다 들어가서 드러나지 않았다.
                  : ListView.builder(
                      key: const Key('channel-feed'),
                      controller: _scroll,
                      reverse: true,
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      // 못 보낸 말이 **맨 아래**(reverse 라 앞쪽)에 선다 — 보낸 자리다.
                      itemCount: feed.length + failed.length,
                      itemBuilder: (context, i) => i < failed.length
                          ? FailedSendRow(item: failed[failed.length - 1 - i])
                          : buildFeedItem(
                        context,
                        feed[feed.length - 1 - (i - failed.length)],
                        onOpenThread: (m) => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => ThreadScreen(
                              channelId: widget.channelId,
                              rootId: m.id,
                            ),
                          ),
                        ),
                      ),
                    ),
              },
            ),
            MentionModelBar(
              controller: _composer,
              picks: _picks,
              onPicksChanged: (next) => setState(() => _picks = next),
            ),
            ComposerAttachments(composerKey: widget.channelId),
            const Divider(height: 1),
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 8, 8, 12),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  AttachButton(composerKey: widget.channelId),
                  Expanded(
                    child: TextField(
                      key: const Key('composer'),
                      controller: _composer,
                      // 글자가 바뀔 때마다 후보를 다시 세운다. 커서만 움직여도 바뀌므로
                      // `onChanged` 로는 모자라지만, 그 경우는 다음 입력에 따라잡힌다.
                      onChanged: (_) => setState(() {}),
                      minLines: 1,
                      maxLines: 5,
                      textInputAction: TextInputAction.newline,
                      decoration: InputDecoration(
                        // 에이전트를 부르는 방법이 **여기에만** 적혀 있다 — 별도 버튼이
                        // 없으므로 화면이 말해 주지 않으면 알 길이 없다.
                        hintText: t.composerHint,
                        border: const OutlineInputBorder(),
                        isDense: true,
                      ),
                    ),
                  ),
                  SendButton(
                    key: const Key('composer-send'),
                    composerKey: widget.channelId,
                    busy: _sending,
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

/// 줄 하나를 그린다. **채널 화면과 스레드 화면이 같은 함수를 쓴다** — 갈라지면 같은
/// 메시지가 두 화면에서 다르게 보인다.
Widget buildFeedItem(
  BuildContext context,
  FeedItem item, {
  void Function(MessageRow)? onOpenThread,
}) {
  if (item is FeedProgressRun) return ProgressRow(run: item.run);
  final feed = item as FeedMessage;
  final m = feed.message;

  final wake = WakeMeta.read(m.meta);
  // 깨움은 사람의 말이 아니다 — 줄이 아니라 대기 줄로 둔다.
  Widget row;
  if (wake != null) {
    row = WakeRow(message: m, wake: wake);
  } else {
    // 판정 순서가 있다: `meta` 가 아는 모양이면 카드를 **덧붙이고**, 아니면 본문만.
    // 카드는 줄을 대신하지 않는다 — 대신하면 무엇을 묻는지와 누가 묻는지가 사라졌다.
    final ask = AskMeta.read(m.meta);
    final report = ask == null ? ReportMeta.read(m.meta) : null;
    final failure = ask == null && report == null ? FailureMeta.read(m.meta) : null;
    final Widget? card = ask != null
        ? AskCard(message: m, ask: ask)
        : report != null
            ? ReportCard(message: m, report: report)
            : failure != null
                ? FailureCard(message: m, failure: failure)
                : null;
    row = MessageTile(
      message: m,
      continued: feed.continued,
      card: card,
      onOpenThread: onOpenThread == null ? null : () => onOpenThread(m),
    );
  }
  if (!feed.dayBreak) return row;
  return Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [DayDivider(at: m.createdAt), row],
  );
}
