import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../mention/sticky.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../ui/parts.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';
import 'agent_model.dart';
import 'composer_attachments.dart';
import 'mention_button.dart';
import 'message_feed.dart';
import 'message_list_screen.dart';
import 'message_tile.dart';

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
  /// @ 버튼이 칸에 포커스를 주려고 쥔다.
  final _composerFocus = FocusNode();
  bool _sending = false;
  /// 작성칸 모델 칩으로 고른 값(서버 079). 서버의 스레드 지정이 되므로 보낸 뒤에도 칩은 그 값을 이어 보인다.
  Map<String, ModelPick> _picks = const {};

  bool _loaded = false;

  /// 목록 맨 위(reverse 라 끝)에 닿으면 옛 답글을 받는다 — 채널 화면의 `_maybeLoadOlder` 와 같다.
  final _scroll = ScrollController();

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_maybeLoadOlder);
  }

  void _maybeLoadOlder() {
    if (!_scroll.hasClients) return;
    final pos = _scroll.position;
    if (pos.pixels < pos.maxScrollExtent - 400) return;
    // 듣는 자리는 빌드 밖이라 `context.app`(구독)을 부르지 않는다.
    AppScope.read(context).loadOlderThread(widget.channelId, widget.rootId);
  }

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
    _scroll.removeListener(_maybeLoadOlder);
    _scroll.dispose();
    _composer.dispose();
    _composerFocus.dispose();
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

    // 루트는 채널 목록의 것을 먼저 쓰고(채널 화면과 같은 줄), 없으면 스레드 응답에 함께 온
    // 것을 쓴다 — 받은 것 탭에서 들어오면 루트가 채널의 최근 페이지 밖일 수 있다.
    // 답글 목록(`threads`)에는 루트가 없다(`AppState.threadRoots` 주석).
    MessageRow? root = app.threadRoots[widget.rootId];
    for (final m in app.messages[widget.channelId] ?? const <MessageRow>[]) {
      if (m.id == widget.rootId) {
        root = m;
        break;
      }
    }
    // 채널 화면에서 들어온 답글은 **말풍선이 되는 것만** 그린다(`progress`·`wake` 제외) —
    // 채널에서와 같은 기준이어야 같은 스레드가 두 화면에서 달라 보이지 않는다.
    // 원글은 상태층이 `threadRoots` 로 갈라 둔다 — `threads` 에는 답글만 있다.
    final built = buildFeed(app.threads[widget.rootId] ?? const <MessageRow>[]);
    // **첫 답글 위에는 날짜 줄을 세우지 않는다** — 바로 위 「답글 n개」 줄과 구분선이 둘 연달아 서면
    // 위계가 흐려진다(designer #1040). 원글과 날짜가 다르면 그 날짜를 구분 줄 글자에 붙인다.
    final first = built.isEmpty ? null : built.first;
    final replies = first is FeedMessage && first.dayBreak
        ? [FeedMessage(first.message, continued: first.continued), ...built.skip(1)]
        : built;
    final firstReplyAt = first is FeedMessage ? first.message.createdAt : null;
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

    ChannelRow? channel;
    for (final c in app.channels) {
      if (c.id == widget.channelId) {
        channel = c;
        break;
      }
    }
    // 답글 수는 서버가 센 원글의 `replyCount` 를 믿는다. 아직 없으면 받은 말풍선 수(진행 줄 묶음은 빼고).
    final replyCount = root?.replyCount ?? replies.whereType<FeedMessage>().length;
    final countLabel = repliesCountLabel(t, replyCount);
    final dividerLabel = threadDividerLabel(t, replyCount, rootAt: root?.createdAt, firstReplyAt: firstReplyAt);
    final where = channelLabel(channel);

    // 위에서 아래로 놓을 줄들. 화면에는 **뒤집어서**(아래부터) 쌓는다 — 열면 최신 답글이 작성칸
    // 바로 위에 오고, 새 답글이 와도 맨 아래에 붙은 채로 따라간다(개정판 3.5). 짧은 스레드는
    // 아래로 붙는다(사양 목업과 같다).
    final rows = <Widget>[
      if (root != null)
        buildFeedItem(context, FeedMessage(root))
      // 원글을 끝내 못 찾았다(지워졌거나 둘 다에 없다) — 답글만 덩그러니 남지 않게 그 자리를 말한다.
      else if (load == LoadState.loaded)
        ThreadRootMissing(text: t.threadRootMissing),
      if (root != null || load == LoadState.loaded) ThreadRepliesDivider(label: dividerLabel),
      // 옛 답글을 받는 중·못 받음 — 채널 맨 위와 같은 44 줄. 「처음」 줄은 세우지 않는다: 바로 위의
      // 원글이 스레드의 처음이다. 옛 서버(hasMore 를 안 줌)에서는 둘 다 서지 않아 지금과 같다.
      if (app.loadingOlderThread.contains(widget.rootId))
        FeedTopRow(top: FeedTop.loading, channelName: '', onRetry: () {})
      else if (app.olderThreadFailed.contains(widget.rootId))
        FeedTopRow(
          top: FeedTop.failed,
          channelName: '',
          onRetry: () => app.retryOlderThread(widget.channelId, widget.rootId),
        ),
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
    ];

    return Scaffold(
      // 개정판 3.5: 「스레드」 + 부제 「# task · 답글 n개」.
      appBar: AppBar(
        title: ScreenTitle(
          title: t.threadTitle,
          subtitle: where.isEmpty ? countLabel : '$where · $countLabel',
        ),
      ),
      // 토스트를 작성칸 위로 올린다(states.dart ComposerScope).
      body: ComposerScope(child: SafeArea(
        child: Column(
          children: [
            ThreadModelBar(channelId: widget.channelId, rootId: widget.rootId, agentIds: threadAgents),
            // `onOpenThread` 를 주지 않는다 — **이미 스레드 안이라 들어갈 곳이 없다.**
            const ConnectionBand(),
            Expanded(
              child: ListView(
                key: const Key('thread-feed'),
                controller: _scroll,
                reverse: true,
                padding: const EdgeInsets.symmetric(vertical: 8),
                children: rows.reversed.toList(growable: false),
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
                  MentionButton(
                    controller: _composer,
                    focusNode: _composerFocus,
                    onInserted: () => setState(() {}),
                  ),
                  Expanded(
                    child: TextField(
                      key: const Key('thread-composer'),
                      controller: _composer,
                      focusNode: _composerFocus,
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
                    empty: SendButton.nothingToSend(_composer.text),
                    onPressed: _send,
                  ),
                ],
              ),
            ),
          ],
        ),
      )),
    );
  }

}

/// 원글과 답글 사이의 구분 줄 「답글 n개」(개정판 3.5).
class ThreadRepliesDivider extends StatelessWidget {
  const ThreadRepliesDivider({super.key, required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return Padding(
      key: const Key('thread-replies-divider'),
      padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 8, HarkroomSize.gutter, 4),
      child: Row(
        children: [
          Text(label, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: k.mute)),
          const SizedBox(width: 8),
          Expanded(child: Divider(height: 1, color: k.line)),
        ],
      ),
    );
  }
}

/// 「답글 n개」. 0 도 숫자로 쓴다 — 스레드 안에서 "답글 달기" 는 할 일이 아니라 이미 하는 중이다.
String repliesCountLabel(Strings t, int count) =>
    count == 1 ? t.threadRepliesOne : t.threadRepliesMany.replaceFirst('{n}', '$count');

/// 원글을 못 찾았을 때 그 자리의 회색 한 줄(designer #1040).
class ThreadRootMissing extends StatelessWidget {
  const ThreadRootMissing({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    return Padding(
      key: const Key('thread-root-missing'),
      padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 12, HarkroomSize.gutter, 4),
      child: Text(text, style: TextStyle(fontSize: 12, color: context.tokens.mute)),
    );
  }
}

/// 「답글 n개」 구분 줄의 글자. 첫 답글이 원글과 다른 날이면(또는 원글을 모르면) 그 날짜를 붙인다 —
/// 「답글 2개 · 오늘」. 첫 답글 위에는 날짜 줄을 따로 세우지 않으므로 날짜는 여기서만 말한다.
String threadDividerLabel(Strings t, int count, {DateTime? rootAt, DateTime? firstReplyAt}) {
  final label = repliesCountLabel(t, count);
  if (firstReplyAt == null) return label;
  if (rootAt != null && sameLocalDay(rootAt, firstReplyAt)) return label;
  return '$label · ${dayLabel(t, firstReplyAt)}';
}
