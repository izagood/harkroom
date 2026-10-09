import 'package:flutter/material.dart';

import '../api/agent_meta.dart';
import '../api/ask.dart';
import '../api/models.dart';
import '../i18n/i18n.dart';
import '../mention/sticky.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../ui/parts.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';
import 'agent_model.dart';
import 'agent_rows.dart';
import 'ask_card.dart';
import 'composer_attachments.dart';
import 'mention_button.dart';
import 'merge_once_note.dart';
import 'message_feed.dart';
import 'message_tile.dart';
import 'search_screen.dart';
import 'thread_screen.dart';
import 'attachments.dart';

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
  /// @ 버튼이 칸에 포커스를 주려고 쥔다.
  final _composerFocus = FocusNode();
  final _scroll = ScrollController();
  bool _sending = false;
  /// 작성칸 모델 칩으로 고른 값(서버 079). 보내면 비운다(결정 12).
  Map<String, ModelPick> _picks = const {};

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_maybeLoadOlder);
    // 쓰던 글(D8)을 되살리고, 칠 때마다 적어 둔다. 커뮤니티 key 는 **지금** 쥔다 — 옮긴 뒤 이 화면이
    // 닫혀도 글은 이 커뮤니티 자리에 남는다.
    final app = AppScope.read(context);
    _community = app.activeKey;
    _composer.text = app.draftFor(widget.channelId);
    _composer.addListener(_keepDraft);
  }

  String? _community;

  void _keepDraft() {
    final c = _community;
    if (c != null) AppScope.read(context).saveDraft(c, widget.channelId, _composer.text);
  }

  /// 목록 **맨 위**(reverse 라 끝)에 가까워지면 이전 페이지를 받는다. 데스크탑 `ChannelPane` 의
  /// `maybeLoadOlder` 와 같은 일이다 — 없으면 첫 페이지 밖의 말은 영영 볼 수 없다.
  void _maybeLoadOlder() {
    if (!_scroll.hasClients) return;
    final pos = _scroll.position;
    if (pos.pixels < pos.maxScrollExtent - 400) return;
    // 듣는 자리는 빌드 밖이라 `context.app`(구독)을 부르지 않는다.
    AppScope.read(context).loadOlder(widget.channelId);
  }

  @override
  void dispose() {
    _scroll.removeListener(_maybeLoadOlder);
    _composer.removeListener(_keepDraft);
    _composer.dispose();
    _composerFocus.dispose();
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
    // **자동·고정 멘션은 보내는 순간 본문에 들어간다**(데스크탑 `Composer.tsx` 의 `send` 와 같다).
    // 서버는 본문의 멘션만 읽으므로, 붙이지 않으면 한 번 부른 에이전트가 다음 줄에 깨지 않는다.
    // 모델 지정도 붙인 본문으로 센다 — 친 글로 세면 고정으로 부른 상대의 지정이 빠진다.
    final body = withStickyMentions(text, app.composerPrefix(widget.channelId, widget.channelId));
    try {
      final went = await app.send(
        widget.channelId,
        body,
        agentModels: picksForBody(picks, body, app.accounts.values),
      );
      // 이번에 부른 상대는 다음 줄부터 고정이다. 고정에 더하는 것은 **사람이 친 글**에서 —
      // 접두는 이미 고정된 것이다.
      if (went) {
        app.keepStickyMentions(widget.channelId, text);
        // 이번만 뺀 자동 멘션은 이 글로 끝이다 — 다음 글에는 다시 붙는다.
        app.clearAutoSkips(widget.channelId);
      }
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
    final top = feedTopOf(app, widget.channelId);
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

    final label = channelLabel(channel);
    return GallerySource(
      // 크게 보기에서 넘겨 볼 그림의 범위(그림 넘겨 보기 사양 1·5).
      messages: () => (app.messages[widget.channelId] ?? const <MessageRow>[]).where((m) => m.inChannelFeed).toList(),
      child: Scaffold(
      // 개정판 3.3: 왼쪽 정렬 "# task" + 부제(주제). 주제가 없으면 한 줄.
      appBar: AppBar(
        title: ScreenTitle(title: label, subtitle: channel?.topic),
        // 머리 돋보기 → **이 채널** 범위로 연다(데스크톱 채널 머리 버튼과 같은 물음).
        actions: [
          SearchButton(key: const Key('channel-search'), scope: SearchScope.channel, channelId: widget.channelId),
          const SizedBox(width: 4),
        ],
      ),
      // 토스트를 작성칸 위로 올린다(states.dart ComposerScope).
      body: ComposerScope(child: SafeArea(
        child: Column(
          children: [
            const ConnectionBand(),
            Expanded(
              child: FeedKeyboardDismiss(child: switch (app.channelLoad[widget.channelId]) {
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
                  // 첫 페이지 중 **가장 오래된 것**이 보이고, 새 말은 화면 밖 아래로 붙는다 —
                  // 채팅에서 사람이 보려는 것은 늘 맨 아래다. 짧은 시험 목록에서는 한 화면에
                  // 다 들어가서 드러나지 않았다.
                  : ListView.builder(
                      key: const Key('channel-feed'),
                      controller: _scroll,
                      reverse: true,
                      // 짧은 채널도 늘 끌리게 둔다 — 끌기 시작이 키보드를 내린다([FeedKeyboardDismiss]).
                      // 안 그러면 Android 에서 한 화면에 다 드는 채널은 끌기가 아예 시작되지 않는다.
                      physics: const AlwaysScrollableScrollPhysics(),
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      // 못 보낸 말이 **맨 아래**(reverse 라 앞쪽)에 선다 — 보낸 자리다. 맨 위(끝)에는
                      // 회전자·"다시 시도"·채널 시작 중 하나를 둔다([FeedTop]).
                      itemCount: feed.length + failed.length + (top == null ? 0 : 1),
                      itemBuilder: (context, i) => i == feed.length + failed.length
                          ? FeedTopRow(
                              top: top!,
                              channelName: channel?.name ?? '',
                              onRetry: () => app.retryOlder(widget.channelId),
                            )
                          : i < failed.length
                          ? FailedSendRow(item: failed[failed.length - 1 - i])
                          : buildFeedItem(
                        context,
                        feed[feed.length - 1 - (i - failed.length)],
                        // 채널에 올라온 답글(alsoInChannel)은 그 원글의 스레드로 간다.
                        onOpenThread: (m) => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => ThreadScreen(
                              channelId: widget.channelId,
                              rootId: m.threadRootId ?? m.id,
                            ),
                          ),
                        ),
                        onReplyInThread: (m) => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => ThreadScreen(
                              channelId: widget.channelId,
                              rootId: m.id,
                              focusComposer: true,
                            ),
                          ),
                        ),
                      ),
                    ),
              }),
            ),
            MentionModelBar(
              controller: _composer,
              picks: _picks,
              channelId: widget.channelId,
              composerKey: widget.channelId,
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
                  MentionButton(
                    controller: _composer,
                    focusNode: _composerFocus,
                    onInserted: () => setState(() {}),
                  ),
                  Expanded(
                    child: TextField(
                      key: const Key('composer'),
                      controller: _composer,
                      focusNode: _composerFocus,
                      // 글자가 바뀔 때마다 후보를 다시 세운다. 커서만 움직여도 바뀌므로
                      // `onChanged` 로는 모자라지만, 그 경우는 다음 입력에 따라잡힌다.
                      onChanged: (_) => setState(() {}),
                      minLines: 1,
                      maxLines: 5,
                      textInputAction: TextInputAction.newline,
                      decoration: composerDecoration(
                        context,
                        t.composerHint.replaceAll('{name}', label),
                      ),
                    ),
                  ),
                  SendButton(
                    key: const Key('composer-send'),
                    composerKey: widget.channelId,
                    busy: _sending,
                    empty: SendButton.nothingToSend(_composer.text),
                    onPressed: _send,
                  ),
                ],
              ),
            ),
          ],
        ),
      )),
    ));
  }
}

/// 줄 하나를 그린다. **채널 화면과 스레드 화면이 같은 함수를 쓴다** — 갈라지면 같은
/// 메시지가 두 화면에서 다르게 보인다.
Widget buildFeedItem(
  BuildContext context,
  FeedItem item, {
  void Function(MessageRow)? onOpenThread,
  void Function(MessageRow)? onReplyInThread,
  Widget Function(Widget row)? mark,
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
    final onceNumber = ask != null ? MergeOnceNote.pendingNumber(m.meta, context.app.me?.id) : null;
    final Widget? card = ask != null
        ? (onceNumber == null
            ? AskCard(message: m, ask: ask)
            : Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                MergeOnceNote(message: m, number: onceNumber),
                AskCard(message: m, ask: ask),
              ]))
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
      // 「스레드에서 답글」은 **최상위 글**에만 — 답글(채널에 올라온 것 포함)은 이미 어느 스레드의 말이다.
      onReplyInThread: onReplyInThread == null || m.threadRootId != null ? null : () => onReplyInThread(m),
    );
  }
  // 찾은 줄 강조(`mark`)는 **줄에만** 씌운다 — 날짜 구분선까지 감싸면 구분선이 함께 번쩍여
  // 무엇을 찾았는지가 흐려진다(designer 찾기 F2 n1).
  if (mark != null) row = mark(row);
  if (!feed.dayBreak) return row;
  return Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [DayDivider(at: m.createdAt), row],
  );
}

/// 채널 목록 맨 위에 서는 한 줄. 셋 중 하나이거나 없다.
enum FeedTop {
  /// 이전 페이지를 받는 중 — 작은 회전자.
  loading,

  /// 이전 페이지를 못 받았다 — "다시 시도". 스크롤로는 다시 부르지 않는다.
  failed,

  /// 더 오래된 말이 없다 — "여기가 #채널 의 처음이다". 없으면 끝에 닿았는지 아직 받는 중인지
  /// 갈리지 않는다(designer #996).
  start,
}

/// 지금 맨 위에 세울 줄. 아직 더 있지만 받는 중도 실패도 아니면 `null`(위로 밀면 받는다).
FeedTop? feedTopOf(AppState app, String channelId) {
  if (app.loadingOlder.contains(channelId)) return FeedTop.loading;
  if (app.olderFailed.contains(channelId)) return FeedTop.failed;
  if (app.channelHasMore[channelId] == false) return FeedTop.start;
  return null;
}

class FeedTopRow extends StatelessWidget {
  const FeedTopRow({super.key, required this.top, required this.channelName, required this.onRetry});

  final FeedTop top;
  final String channelName;
  final VoidCallback onRetry;

  /// 세 상태가 같이 쓰는 줄 높이(누르는 영역 44 와 같다).
  static const rowHeight = 44.0;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final t = context.t;
    final muted = TextStyle(fontSize: 12, color: k.fgMuted);
    // **세 상태가 같은 높이 상자에 선다**(designer #1026 후속). 높이가 다르면 받는 중 → 못 받음 →
    // 처음 으로 바뀔 때 목록이 그만큼 움직였다(다시 시도 +14pt, 시작 줄 −4pt).
    final Widget child = switch (top) {
      FeedTop.loading => const SizedBox(
          width: 18,
          height: 18,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      FeedTop.failed => Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Flexible(child: Text(t.olderLoadFailed, style: muted)),
            // 가운뎃점 양옆을 같게 — 버튼 안쪽 여백을 빼고 띄움은 여기서만 준다.
            const SizedBox(width: 6),
            Text('·', style: muted),
            const SizedBox(width: 6),
            TextButton(
              key: const Key('older-retry'),
              onPressed: onRetry,
              // 기본 최소 높이 48 이 줄을 키웠다. 누르는 높이는 바깥 44 상자가 맡는다.
              style: TextButton.styleFrom(
                padding: EdgeInsets.zero,
                minimumSize: const Size(0, rowHeight),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              ),
              child: Text(t.commonRetry),
            ),
          ],
        ),
      FeedTop.start => Text(
          t.channelStartLine.replaceFirst('{name}', channelName),
          textAlign: TextAlign.center,
          style: muted,
        ),
    };
    return SizedBox(
      key: Key(switch (top) {
        FeedTop.loading => 'loading-older',
        FeedTop.failed => 'older-failed',
        FeedTop.start => 'channel-start',
      }),
      height: rowHeight,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter),
        child: Center(child: child),
      ),
    );
  }
}

/// 머리·자리표시에 쓰는 채널 이름. 채널은 "# task", DM 은 상대 이름 그대로.
/// 채널이 목록에서 사라졌으면(다른 기기에서 나갔다) 빈 줄.
String channelLabel(ChannelRow? channel) {
  if (channel == null) return '';
  return channel.isDm ? channel.name : '# ${channel.name}';
}
