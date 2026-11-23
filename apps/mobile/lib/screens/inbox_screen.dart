import 'dart:async';

import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../mention/render.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../time.dart';
import '../ui/parts.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';
import 'channel_list_screen.dart';
import 'community_screens.dart';
import 'message_list_screen.dart';
import 'thread_screen.dart';

/// Inbox — **안 읽은 멘션·DM** 목록([AppState.inboxMentions] — `GET /inbox` 로 이미 받은 것에서, 새것 먼저).
///
/// 「내 작업」 보드(`GET /inbox/board`)는 걷었다. 줄을 누르면 그 줄을 읽음으로 만들고(`POST /inbox/read`) 스레드를
/// 연다 — 스레드가 아니면 그 채널을 연다. 숫자(머리·탭 배지)는 [AppState.inboxMentionCount] 다.
class InboxScreen extends StatelessWidget {
  const InboxScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    final unread = app.inboxMentions..sort((a, b) => b.createdAt.compareTo(a.createdAt));
    final count = unread.length;

    return Scaffold(
      extendBodyBehindAppBar: true,
      appBar: GlassAppBar(bar: AppBar(
        title: ScreenTitle(
          key: const Key('inbox-title'),
          title: t.tabInbox,
          subtitle: app.communities.length > 1 ? app.activeCommunity?.displayLabel : null,
        ),
        actions: [
          if (app.inboxLoad == LoadState.loaded)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Center(
                child: Text(
                  t.inboxUnreadCount.replaceFirst('{count}', '$count'),
                  key: const Key('inbox-unread-count'),
                  style: TextStyle(
                    color: count > 0 ? k.stateTurn : k.fgSubtle,
                    fontSize: 12,
                    fontWeight: count > 0 ? FontWeight.w600 : FontWeight.w400,
                  ),
                ),
              ),
            ),
          const OpenMeButton(),
          const SizedBox(width: 8),
        ],
      )),
      body: SafeArea(
        top: false,
        child: GlassBody(
          header: const ConnectionBand(),
          builder: (context, inset) {
            final lead = <Widget>[
              for (final c in app.communities)
                if (c.key != app.activeKey && !c.isExpired && (app.otherWaiting[c.key] ?? 0) > 0)
                  OtherCommunityInboxRow(community: c, count: app.otherWaiting[c.key]!),
            ];
            if (app.inboxLoad == LoadState.loaded) {
              return RefreshIndicator(
                edgeOffset: inset,
                onRefresh: app.loadInbox,
                // 비어도 목록이다 — 당겨서 새로고침과 상태 표시줄 탭(맨 위로)이 같은 손잡이를 쓴다.
                child: ListView(
                  key: const Key('inbox-list'),
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: EdgeInsets.only(top: inset),
                  children: [
                    ...lead,
                    if (unread.isEmpty)
                      SizedBox(height: 320, child: EmptyState(title: t.inboxEmpty, hint: t.inboxEmptyHint))
                    else
                      for (final e in unread) InboxEntryRow(entry: e),
                  ],
                ),
              );
            }
            return Padding(
              padding: EdgeInsets.only(top: inset),
              child: Column(children: [
                ...lead,
                Expanded(
                  child: switch (app.inboxLoad) {
                    LoadState.loading => const LoadingSkeleton(rows: 3),
                    LoadState.failed => FailedState(
                        title: t.inboxLoadFailed,
                        cause: app.failures['inbox'] ?? LoadFailure.network,
                        onRetry: app.loadInbox,
                      ),
                    LoadState.loaded => const SizedBox.shrink(),
                  },
                ),
              ]),
            );
          },
        ),
      ),
    );
  }
}

String inboxReasonLabel(Strings t, InboxReason r) => switch (r) {
      InboxReason.mention || InboxReason.teamMention => t.inboxReasonMention,
      InboxReason.threadReply => t.inboxReasonThreadReply,
      InboxReason.dm => t.inboxReasonDm,
      InboxReason.askAnswered => t.inboxReasonAskAnswered,
      InboxReason.askClosed => t.inboxReasonAskClosed,
      _ => t.inboxReasonOther,
    };

/// 안 읽은 부름 한 줄. 왼쪽 얼굴 · 말(두 줄까지) · 「누가 · #채널 · 왜」, 오른쪽에 시각.
class InboxEntryRow extends StatelessWidget {
  const InboxEntryRow({super.key, required this.entry});

  final InboxEntry entry;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    final e = entry;
    final authorId = e.system ? null : e.authorId;
    final who = authorId == null ? null : app.accounts[authorId]?.handle ?? app.displayNameOf(authorId);
    final channel = app.channels.where((c) => c.id == e.channelId).firstOrNull;
    final channelLabel = channel == null ? '#…' : (channel.isDm ? channel.name : '#${channel.name}');
    final meta = [?who, channelLabel, inboxReasonLabel(t, e.reason)].join(' · ');
    return InkWell(
      key: Key('inbox-entry-${e.id}'),
      onTap: () => _open(context),
      child: Container(
        decoration: BoxDecoration(border: Border(bottom: BorderSide(color: k.border))),
        padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 10, 12, 10),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (authorId != null)
              HarkroomAvatar(id: authorId, name: who ?? '', size: HarkroomSize.avatarSmall)
            else
              const SizedBox(width: HarkroomSize.avatarSmall),
            const SizedBox(width: 10),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(
                  renderMentions(e.body, app.accounts, t.mentionUnknown),
                  key: Key('inbox-entry-body-${e.id}'),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: k.fg, fontSize: 15, fontWeight: FontWeight.w600),
                ),
                const SizedBox(height: 2),
                Text(meta, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(color: k.fgMuted, fontSize: 12)),
              ]),
            ),
            const SizedBox(width: 8),
            Text(agoLabel(e.createdAt, DateTime.now().toUtc(), t), style: TextStyle(fontSize: 12, color: k.fgSubtle)),
          ],
        ),
      ),
    );
  }

  /// 읽음으로 만들고(화면 먼저 — `POST /inbox/read`) 그 스레드를 연다. 스레드 밖의 말이면 그 채널로 간다.
  Future<void> _open(BuildContext context) async {
    final app = context.app;
    final navigator = Navigator.of(context);
    final e = entry;
    unawaited(app.markInboxRead([e.id]));
    await app.openChannel(e.channelId);
    final root = e.threadRootId;
    await navigator.push(MaterialPageRoute<void>(
      builder: (_) => root != null ? ThreadScreen(channelId: e.channelId, rootId: root) : MessageListScreen(channelId: e.channelId),
    ));
  }
}
