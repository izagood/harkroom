import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';

import '../api/inbox_board.dart';
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

/// 갈래(데스크톱 A안의 칩과 같다). 「진행 보드」는 모바일에 두지 않는다(designer 모바일 정리).
enum InboxTab { todo, news, later, cleared }

/// 알림을 띄워 두는 시간 — 결정이 섞이면 더 길게(놓치면 결정이 조용히 사라진다, security #1315 n1).
const Duration inboxToastShort = Duration(seconds: 6);
const Duration inboxToastLong = Duration(seconds: 12);

/// 나중에의 깨어날 시각 — 다음 날 아침 9시(내 시계). 데스크톱 `tomorrowMorning` 과 같다.
DateTime tomorrowMorning(DateTime now) => DateTime(now.year, now.month, now.day + 1, 9).toUtc();

int _workCount(Iterable<BoardGroup> groups) => groups.fold(0, (n, g) => n + 1 + g.similar.length);

/// Inbox **A안 — 받은 일**(데스크톱 #1315 를 모바일로, designer 모바일 정리 2026-10-13).
///
/// 줄 하나 = 일(스레드) 하나. 판정은 데스크톱과 같은 `buildBoard`(`api/inbox_board.dart`, 판례 표로 묶여 있다).
/// 데스크톱의 「목록 + 옆 상세」는 폭이 없으니 **목록 → 상세 화면**으로 넘어간다. 줄을 누르면 상세로 가고, 스레드는
/// 상세의 [스레드 열기]로 연다 — 누르자마자 스레드로 가면 결정을 맥락 없이 하게 된다.
///
/// - 왼쪽으로 밀면 치우기(저장 화면과 같은 방향). **결정 카드는 밀어서 치울 수 없다** — 열어서 물음을 본 뒤 상세에서만.
///   나중에는 상세 버튼과 길게 누르기로만 — 밀기를 두 방향에 쓰면 실수가 잦다.
/// - 치우거나 미루면 「N건 치웠다 · 되돌리기」 알림. 알림은 **호출이 끝난 뒤** 뜬다 — 되돌리기가 아직 도는 치우기와
///   겹치지 않는다(호출이 끝날 때까지 되돌리기를 잠그는 것과 같은 효과).
/// - 숫자(머리·탭 배지)는 [AppState.inboxMine] — 데스크톱과 같은 「나를 기다리는 일」(G1 (b)). [모두 읽음]은 없다 —
///   숫자를 줄이는 길은 치우기 하나다.
class InboxScreen extends StatefulWidget {
  const InboxScreen({super.key});

  @override
  State<InboxScreen> createState() => _InboxScreenState();
}

class _InboxScreenState extends State<InboxScreen> {
  InboxTab _tab = InboxTab.todo;
  bool _staleOpen = false;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    final cards = app.boardCards;

    final todo = [for (final c in cards) if (c.column == BoardColumn.mine && c.fold == null) c];
    final stale = [for (final c in cards) if (c.column == BoardColumn.mine && c.fold == BoardFold.stale) c];
    // 소식은 열이 섞이므로 최근에 움직인 순으로 다시 세운다(데스크톱 `InboxList` 와 같다).
    final news = [for (final c in cards) if (c.column != BoardColumn.mine && c.fold == null) c]
      ..sort((a, b) => b.lastActivityAt.compareTo(a.lastActivityAt));
    final later = [for (final c in cards) if (c.fold == BoardFold.later) c];
    final cleared = [for (final c in cards) if (c.fold == BoardFold.cleared) c];
    final counts = {
      InboxTab.todo: todo.length,
      InboxTab.news: news.length,
      InboxTab.later: later.length,
      InboxTab.cleared: cleared.length,
    };
    final mine = app.inboxMine;

    return Scaffold(
      // 반투명 머리(④) — 목록이 그 밑으로 흐른다.
      extendBodyBehindAppBar: true,
      appBar: GlassAppBar(bar: AppBar(
        title: ScreenTitle(
          key: const Key('inbox-title'),
          title: t.tabInbox,
          subtitle: app.communities.length > 1 ? app.activeCommunity?.displayLabel : null,
        ),
        actions: [
          if (app.boardLoad == LoadState.loaded)
            Padding(
              padding: const EdgeInsets.only(right: 8),
              child: Center(
                child: Text(
                  t.inboxMineCount.replaceFirst('{count}', '$mine'),
                  key: const Key('inbox-mine-count'),
                  style: TextStyle(
                    color: mine > 0 ? k.stateTurn : k.fgSubtle,
                    fontSize: 12,
                    fontWeight: mine > 0 ? FontWeight.w600 : FontWeight.w400,
                  ),
                ),
              ),
            ),
          const OpenMeButton(),
          const SizedBox(width: 8),
        ],
      )),
      // 위는 [GlassBody] 가 맡는다. 끊김 띠와 탭 칩은 머리 밑에 고정하고(designer #1373 s1 — 칩은
      // 이 화면의 길잡이라 굴려도 남는다), 다른 커뮤니티 줄은 목록의 첫 줄이라 같이 굴러간다.
      body: SafeArea(
        top: false,
        child: GlassBody(
          // stretch — 칩 줄 바탕이 화면 폭을 다 덮어야 밑의 줄이 양옆으로 비치지 않는다.
          header: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            const ConnectionBand(),
            // 칩 줄 바탕은 불투명 surface — 밑으로 흐르는 줄이 칩 사이로 비치면 칩 글자가 읽히지 않는다.
            if (app.board != null)
              ColoredBox(
                key: const Key('inbox-tab-chips'),
                color: context.tokens.surface,
                child: _TabChips(tab: _tab, counts: counts, onTab: (v) => setState(() => _tab = v)),
              ),
          ]),
          builder: (context, inset) {
            final lead = <Widget>[
              for (final c in app.communities)
                if (c.key != app.activeKey && !c.isExpired && (app.otherWaiting[c.key] ?? 0) > 0)
                  OtherCommunityInboxRow(community: c, count: app.otherWaiting[c.key]!),
            ];
            if (app.board != null) {
              return RefreshIndicator(
                // 당기기 회전자는 머리 밑에서 나온다 — 0 이면 반투명 머리 뒤에 숨는다.
                edgeOffset: inset,
                onRefresh: app.loadBoard,
                child: _list(context, inset: inset, lead: lead, todo: todo, stale: stale, news: news, later: later, cleared: cleared),
              );
            }
            return Padding(
              padding: EdgeInsets.only(top: inset),
              child: Column(children: [
                ...lead,
                Expanded(
                  child: switch (app.boardLoad) {
                    LoadState.loading => const LoadingSkeleton(rows: 3),
                    LoadState.failed => FailedState(
                        title: t.inboxLoadFailed,
                        cause: app.failures['board'] ?? LoadFailure.network,
                        onRetry: app.loadBoard,
                      ),
                    LoadState.loaded => EmptyState(title: t.inboxEmpty, hint: t.inboxEmptyHint),
                  },
                ),
              ]),
            );
          },
        ),
      ),
    );
  }

  Widget _list(
    BuildContext context, {
    required double inset,
    required List<Widget> lead,
    required List<BoardCard> todo,
    required List<BoardCard> stale,
    required List<BoardCard> news,
    required List<BoardCard> later,
    required List<BoardCard> cleared,
  }) {
    final t = context.t;
    final slivers = <Widget>[
      // 머리 + 끊김 띠 + 탭 칩 높이만큼 **고정된 빈 머리** — 아래 묶음 머리(pinned)가 맨 위(반투명 머리 뒤)가
      // 아니라 이 밑에 붙는다. 그리는 것도 누르는 것도 없어 밑으로 흐르는 줄이 그대로 비친다.
      SliverPersistentHeader(pinned: true, delegate: _TopInset(inset)),
      for (final w in lead) SliverToBoxAdapter(child: w),
    ];
    switch (_tab) {
      case InboxTab.todo:
        for (final kind in BoardKind.values) {
          final groups = groupSimilar([for (final c in todo) if (c.kind == kind) c]);
          if (groups.isEmpty) continue;
          slivers.add(SliverMainAxisGroup(slivers: [
            SliverPersistentHeader(
              pinned: true,
              delegate: _SectionHeader(
                keyName: 'inbox-section-${kind.name}',
                text: '${_sectionTitle(t, kind)} · ${_workCount(groups)}',
              ),
            ),
            SliverList.list(children: [for (final g in groups) BoardRow(group: g, tab: _tab)]),
          ]));
        }
        if (todo.isEmpty) {
          slivers.add(SliverToBoxAdapter(
            child: _MineEmpty(newsCount: news.length, onNews: () => setState(() => _tab = InboxTab.news)),
          ));
        }
        if (stale.isNotEmpty) {
          final staleGroups = groupSimilar(stale);
          final decisions = stale.where((c) => c.kind == BoardKind.decision).length;
          slivers.add(SliverToBoxAdapter(
            child: _StaleRow(
              count: stale.length,
              decisions: decisions,
              open: _staleOpen,
              onToggle: () => setState(() => _staleOpen = !_staleOpen),
              // [전부 치우기]는 **펼친 뒤에만** — 접힌 줄 옆에 두면 잘못 눌린다(designer).
              onClearAll: _staleOpen ? () => runBoardAction(context, staleGroups, BoardAction.dismiss) : null,
            ),
          ));
          if (_staleOpen) {
            slivers.add(SliverList.list(children: [for (final g in staleGroups) BoardRow(group: g, tab: _tab)]));
          }
        }
      case InboxTab.news:
      case InboxTab.later:
      case InboxTab.cleared:
        final list = switch (_tab) { InboxTab.news => news, InboxTab.later => later, _ => cleared };
        final groups = groupSimilar(list);
        slivers.add(groups.isEmpty
            ? SliverToBoxAdapter(
                child: Padding(
                  padding: const EdgeInsets.all(HarkroomSize.gutter),
                  child: Text(t.inboxTabEmpty, key: const Key('inbox-tab-empty'), style: TextStyle(color: context.tokens.fgSubtle)),
                ),
              )
            : SliverList.list(children: [for (final g in groups) BoardRow(group: g, tab: _tab)]));
    }
    // 떠 있는 탭 막대 뒤로 흐르는 만큼 바닥을 비운다.
    slivers.add(const SliverToBoxAdapter(child: SizedBox(height: 96)));
    return CustomScrollView(
      key: Key('inbox-list-${_tab.name}'),
      physics: const AlwaysScrollableScrollPhysics(),
      slivers: slivers,
    );
  }
}

String _sectionTitle(Strings t, BoardKind kind) => switch (kind) {
      BoardKind.decision => t.inboxSectionDecision,
      BoardKind.blocker => t.inboxSectionBlocker,
      BoardKind.news => t.inboxSectionNews,
    };

String _kindLabel(Strings t, BoardKind kind) => switch (kind) {
      BoardKind.decision => t.inboxKindDecision,
      BoardKind.blocker => t.inboxKindBlocker,
      BoardKind.news => t.inboxKindNews,
    };

String _tabLabel(Strings t, InboxTab tab) => switch (tab) {
      InboxTab.todo => t.inboxTabTodo,
      InboxTab.news => t.inboxTabNews,
      InboxTab.later => t.inboxTabLater,
      InboxTab.cleared => t.inboxTabCleared,
    };

class _TabChips extends StatelessWidget {
  const _TabChips({required this.tab, required this.counts, required this.onTab});

  final InboxTab tab;
  final Map<InboxTab, int> counts;
  final ValueChanged<InboxTab> onTab;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    return SingleChildScrollView(
      scrollDirection: Axis.horizontal,
      padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 6, HarkroomSize.gutter, 6),
      child: Row(
        children: [
          for (final v in InboxTab.values)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: ChoiceChip(
                key: Key('inbox-tab-${v.name}'),
                label: Text('${_tabLabel(t, v)} ${counts[v] ?? 0}'),
                selected: tab == v,
                showCheckmark: false,
                selectedColor: k.accentSurface,
                labelStyle: TextStyle(color: tab == v ? k.accentText : k.fgMuted, fontSize: 13),
                onSelected: (_) => onTab(v),
              ),
            ),
        ],
      ),
    );
  }
}

/// 반투명 머리 밑을 비우는 고정 빈 머리 — [InboxScreen] 의 묶음 머리가 이 밑에 붙는다.
class _TopInset extends SliverPersistentHeaderDelegate {
  _TopInset(this.height);

  final double height;

  @override
  double get minExtent => height;

  @override
  double get maxExtent => height;

  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) =>
      const SizedBox.expand(key: Key('inbox-top-inset'));

  @override
  bool shouldRebuild(_TopInset old) => old.height != height;
}

class _SectionHeader extends SliverPersistentHeaderDelegate {
  const _SectionHeader({required this.keyName, required this.text});

  final String keyName;
  final String text;

  @override
  double get minExtent => 30;
  @override
  double get maxExtent => 30;

  // 색은 [_SectionHeaderBar] 가 제 build 에서 읽는다 — 이 build 는 [shouldRebuild] 가 false 면 다시 안 불려서,
  // 여기서 테마를 읽으면 다크로 바뀌어도 밝은 바탕이 남는다(designer s1, 갤러리 45번의 흰 띠).
  @override
  Widget build(BuildContext context, double shrinkOffset, bool overlapsContent) =>
      _SectionHeaderBar(key: Key(keyName), text: text);

  @override
  bool shouldRebuild(_SectionHeader oldDelegate) => oldDelegate.text != text;
}

class _SectionHeaderBar extends StatelessWidget {
  const _SectionHeaderBar({super.key, required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return Container(
      // 목록과 같은 바탕 — 머리가 화면에서 가장 밝은 것이 되지 않게(designer s1).
      color: Theme.of(context).scaffoldBackgroundColor,
      alignment: Alignment.centerLeft,
      padding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter),
      child: Text(text, style: TextStyle(color: k.fgMuted, fontSize: 12, fontWeight: FontWeight.w600)),
    );
  }
}

class _MineEmpty extends StatelessWidget {
  const _MineEmpty({required this.newsCount, required this.onNews});

  final int newsCount;
  final VoidCallback onNews;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Padding(
      padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 24, HarkroomSize.gutter, 8),
      child: Column(
        key: const Key('inbox-mine-empty'),
        children: [
          Text(t.inboxMineEmpty, style: TextStyle(color: context.tokens.fgMuted)),
          if (newsCount > 0)
            TextButton(
              key: const Key('inbox-show-news'),
              onPressed: onNews,
              child: Text(t.inboxShowNews.replaceFirst('{count}', '$newsCount')),
            ),
        ],
      ),
    );
  }
}

class _StaleRow extends StatelessWidget {
  const _StaleRow({required this.count, required this.decisions, required this.open, required this.onToggle, this.onClearAll});

  final int count;
  final int decisions;
  final bool open;
  final VoidCallback onToggle;
  final VoidCallback? onClearAll;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    return Container(
      decoration: BoxDecoration(border: Border(top: BorderSide(color: k.border))),
      child: Row(
        children: [
          Expanded(
            child: InkWell(
              key: const Key('inbox-stale-toggle'),
              onTap: onToggle,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 12, 8, 12),
                child: Text.rich(
                  key: const Key('inbox-stale-label'),
                  TextSpan(children: [
                    TextSpan(text: t.inboxStale.replaceFirst('{count}', '$count')),
                    // 잊힌 권한 요청이 있다는 것은 보여야 한다(designer n2).
                    if (decisions > 0)
                      TextSpan(
                        text: ' · ${t.inboxStaleDecisions.replaceFirst('{count}', '$decisions')}',
                        style: TextStyle(color: k.stateTurn),
                      ),
                  ]),
                  style: TextStyle(color: k.fgSubtle, fontSize: 13),
                ),
              ),
            ),
          ),
          if (onClearAll != null)
            TextButton(key: const Key('inbox-stale-clear-all'), onPressed: onClearAll, child: Text(t.inboxClearAll)),
          Icon(open ? Icons.expand_less : Icons.expand_more, color: k.fgSubtle),
          const SizedBox(width: 12),
        ],
      ),
    );
  }
}

/// 줄 하나. 왼쪽 얼굴 · 제목 한 줄(+ ×N) · 「누가 · #채널」, 오른쪽 한 칸에 시각과 「새 말」.
class BoardRow extends StatelessWidget {
  const BoardRow({super.key, required this.group, required this.tab});

  final BoardGroup group;
  final InboxTab tab;

  bool get _folded => group.card.fold == BoardFold.later || group.card.fold == BoardFold.cleared;

  /// 밀어서 치울 수 있나 — **결정 카드는 안 된다**(열어서 본 뒤 상세에서만). 이미 접힌 것(미룬·치운)도 아니다.
  bool get swipeable => !_folded && group.card.kind != BoardKind.decision;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final card = group.card;
    final row = Semantics(
      customSemanticsActions: {
        if (swipeable) CustomSemanticsAction(label: t.inboxDismiss): () => runBoardAction(context, [group], BoardAction.dismiss),
        if (!_folded) CustomSemanticsAction(label: t.inboxLater): () => runBoardAction(context, [group], BoardAction.later),
        if (_folded) CustomSemanticsAction(label: t.inboxPutBack): () => runBoardAction(context, [group], BoardAction.restore),
      },
      child: InkWell(
        key: Key('inbox-card-${card.rootId}'),
        onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => InboxDetailScreen(rootId: card.rootId))),
        onLongPress: () => _rowSheet(context),
        child: _body(context),
      ),
    );
    if (!swipeable) return row;
    return Dismissible(
      key: ValueKey('inbox-swipe-${card.rootId}'),
      direction: DismissDirection.endToStart,
      dismissThresholds: const {DismissDirection.endToStart: 0.35},
      background: const SizedBox.shrink(),
      secondaryBackground: Container(
        color: k.surfaceSunken,
        alignment: Alignment.centerRight,
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Row(mainAxisSize: MainAxisSize.min, children: [
          Icon(Icons.check, color: k.fg, size: 18),
          const SizedBox(width: 6),
          Text(t.inboxDismiss, style: TextStyle(color: k.fg, fontWeight: FontWeight.w700, fontSize: 13)),
        ]),
      ),
      // 언제나 false — 줄은 판이 지운다. `setBoardState` 가 호출 **전에** 먼저 바꾼 상태로 줄을 빼므로 다음 그림에서
      // 바로 사라지고, 실패하면 판이 되살린다(designer s2). 그래서 호출을 기다리지 않는다. true 면 실패한 줄이 판에
      // 되살아날 때 Dismissible 이 꼬인다.
      confirmDismiss: (_) async {
        unawaited(runBoardAction(context, [group], BoardAction.dismiss));
        return false;
      },
      child: row,
    );
  }

  Widget _body(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    final card = group.card;
    final whoId = card.whoId;
    final who = whoId == null ? null : app.accounts[whoId]?.handle ?? app.displayNameOf(whoId);
    final days = daysWaiting(card.sinceAt, DateTime.now().millisecondsSinceEpoch);
    final when = days != null ? t.inboxDays.replaceFirst('{count}', '$days') : agoLabel(card.sinceAt, DateTime.now().toUtc(), t);
    final channel = app.boardChannelLabel(card.channelId);
    return Container(
      decoration: BoxDecoration(border: Border(bottom: BorderSide(color: k.border))),
      padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 10, 12, 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (whoId != null)
            HarkroomAvatar(id: whoId, name: who ?? '', size: HarkroomSize.avatarSmall)
          else
            const SizedBox(width: HarkroomSize.avatarSmall),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(children: [
                  Flexible(
                    child: Text(
                      renderMentions(card.summary, app.accounts, t.mentionUnknown),
                      key: Key('inbox-card-summary-${card.rootId}'),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: k.fg, fontSize: 15, fontWeight: card.unread ? FontWeight.w600 : FontWeight.w400),
                    ),
                  ),
                  if (group.similar.isNotEmpty)
                    Container(
                      key: Key('inbox-card-similar-${card.rootId}'),
                      margin: const EdgeInsets.only(left: 6),
                      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                      decoration: BoxDecoration(color: k.surfaceSunken, borderRadius: BorderRadius.circular(8)),
                      child: Text('×${group.similar.length + 1}', style: TextStyle(color: k.fgMuted, fontSize: 12)),
                    ),
                ]),
                const SizedBox(height: 2),
                // 이름은 자르지 않고 채널부터 줄인다 — 채널은 세 글자 폭은 남긴다(designer).
                Row(children: [
                  if (who != null) Text(who, key: Key('inbox-card-who-${card.rootId}'), style: TextStyle(color: k.fgMuted, fontSize: 12)),
                  Flexible(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(minWidth: 32),
                      child: Text(
                        '${who == null ? '' : ' · '}$channel',
                        key: Key('inbox-card-channel-${card.rootId}'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(color: k.fgSubtle, fontSize: 12),
                      ),
                    ),
                  ),
                ]),
              ],
            ),
          ),
          const SizedBox(width: 8),
          // 오른쪽 한 칸 — 기다린 시간(날수면 빨강) · 새 말 · (할 일 밖에서는) 종류.
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                when,
                key: Key('inbox-card-age-${card.rootId}'),
                style: TextStyle(fontSize: 12, color: days != null && card.column == BoardColumn.mine ? k.stateTurn : k.fgSubtle),
              ),
              const SizedBox(height: 2),
              Row(mainAxisSize: MainAxisSize.min, children: [
                if (card.unread) Text(t.inboxNew, key: Key('inbox-card-new-${card.rootId}'), style: TextStyle(fontSize: 12, color: k.accentText)),
                if (tab != InboxTab.todo) ...[
                  if (card.unread) const SizedBox(width: 4),
                  Text(_kindLabel(t, card.kind), key: Key('inbox-card-kind-${card.rootId}'), style: TextStyle(fontSize: 12, color: k.fgSubtle)),
                ],
              ]),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _rowSheet(BuildContext context) async {
    final t = context.t;
    final pick = await showModalBottomSheet<BoardAction>(
      context: context,
      useRootNavigator: true,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          if (!_folded)
            ListTile(
              key: const Key('inbox-action-later'),
              leading: const Icon(Icons.schedule),
              title: Text(t.inboxLater),
              onTap: () => Navigator.of(sheet).pop(BoardAction.later),
            ),
          if (swipeable)
            ListTile(
              key: const Key('inbox-action-dismiss'),
              leading: const Icon(Icons.check),
              title: Text(t.inboxDismiss),
              onTap: () => Navigator.of(sheet).pop(BoardAction.dismiss),
            ),
          if (_folded)
            ListTile(
              key: const Key('inbox-action-restore'),
              leading: const Icon(Icons.undo),
              title: Text(t.inboxPutBack),
              onTap: () => Navigator.of(sheet).pop(BoardAction.restore),
            ),
        ]),
      ),
    );
    if (pick == null || !context.mounted) return;
    await runBoardAction(context, [group], pick);
  }
}

enum BoardAction { dismiss, later, restore }

/// 치우기·나중에·되돌리기의 한 길. 줄·길게 누르기·상세·스크린리더·전부 치우기가 모두 여기로 온다.
///
/// 알림은 **호출이 끝난 뒤** 띄운다 — 되돌리기가 아직 도는 치우기와 겹치지 않게. 메신저·세대를 미리 쥔다:
/// 되돌리기를 누를 때 그 줄도, 어쩌면 상세 화면도 이미 사라졌다.
Future<void> runBoardAction(BuildContext context, List<BoardGroup> groups, BoardAction action) async {
  if (groups.isEmpty) return;
  final app = context.app;
  final t = context.t;
  final messenger = ScaffoldMessenger.of(context);
  final gen = app.sessionGeneration;
  final n = _workCount(groups);
  final hasDecision = groups.any((g) => [g.card, ...g.similar].any((c) => c.kind == BoardKind.decision));
  try {
    switch (action) {
      case BoardAction.dismiss:
        await app.setBoardState(groups, 'done');
      case BoardAction.later:
        await app.setBoardState(groups, 'later', until: tomorrowMorning(DateTime.now()));
      case BoardAction.restore:
        await app.setBoardState(groups, null);
    }
  } on Object {
    if (app.sessionGeneration != gen) return;
    messenger
      ..removeCurrentSnackBar()
      ..showSnackBar(SnackBar(
        key: const Key('inbox-toast-failed'),
        content: Text(t.inboxActionFailed),
        behavior: SnackBarBehavior.floating,
      ));
    return;
  }
  if (app.sessionGeneration != gen || action == BoardAction.restore) {
    messenger.removeCurrentSnackBar();
    return;
  }
  messenger
    ..removeCurrentSnackBar()
    ..showSnackBar(SnackBar(
      key: const Key('inbox-toast'),
      content: Text((action == BoardAction.dismiss ? t.inboxDismissed : t.inboxSnoozed).replaceFirst('{count}', '$n')),
      behavior: SnackBarBehavior.floating,
      duration: hasDecision ? inboxToastLong : inboxToastShort,
      action: SnackBarAction(
        key: const Key('inbox-toast-undo'),
        label: t.inboxUndo,
        onPressed: () {
          if (app.sessionGeneration != gen) return;
          unawaited(app.setBoardState(groups, null).catchError((Object _) {}));
        },
      ),
    ));
}

/// 상세 화면 — 고른 일 하나. 누가 · #채널 · 시각 · 답글 N, 한 문장, 「마지막 말」, 선택지(한 줄에 하나), 아래
/// 고정 행동 줄 [스레드 열기][나중에][치우기]. 판이 다시 와서 이 일이 목록에서 빠져도 마지막 모습을 들고 있는다.
class InboxDetailScreen extends StatefulWidget {
  const InboxDetailScreen({super.key, required this.rootId});

  final String rootId;

  @override
  State<InboxDetailScreen> createState() => _InboxDetailScreenState();
}

class _InboxDetailScreenState extends State<InboxDetailScreen> {
  bool _busy = false;
  BoardGroup? _last;

  /// 이 일이 든 묶음. 묶인 줄의 맨 앞이 아니어도 그 묶음을 돌려준다(치우면 묶인 일 전부).
  BoardGroup? _find(List<BoardCard> cards) {
    final card = cards.where((c) => c.rootId == widget.rootId).firstOrNull;
    if (card == null) return null;
    final peers = [for (final c in cards) if (c.column == card.column && c.fold == card.fold && c.kind == card.kind) c];
    for (final g in groupSimilar(peers)) {
      if (g.card.rootId == widget.rootId || g.similar.any((c) => c.rootId == widget.rootId)) return g;
    }
    return BoardGroup(card);
  }

  Future<void> _act(BoardGroup group, BoardAction a) async {
    if (_busy) return;
    if (a == BoardAction.restore) {
      setState(() => _busy = true);
      await runBoardAction(context, [group], a);
      if (mounted) setState(() => _busy = false);
      return;
    }
    // 치우거나 미루면 **먼저** 목록으로 돌아간다 — 그 자리 다음 줄이 보이고(designer: J/K 대신), 되돌리기 알림이
    // 목록 위에 선다. `runBoardAction` 은 첫 await 전에 앱·문구·메신저를 쥐므로 닫히는 화면의 context 로도 된다.
    _busy = true;
    final ctx = context;
    Navigator.of(context).pop();
    await runBoardAction(ctx, [group], a);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    final group = _find(app.boardCards) ?? _last;
    if (group == null) return Scaffold(appBar: AppBar(), body: const SizedBox.shrink());
    _last = group;
    final card = group.card;
    final folded = card.fold == BoardFold.later || card.fold == BoardFold.cleared;
    final whoId = card.whoId;
    final who = whoId == null ? null : app.accounts[whoId]?.handle ?? app.displayNameOf(whoId);
    final replies = card.replyCount ?? 0;
    final latest = card.entries.where((e) {
      final line = oneSentence(e.body);
      return line.isNotEmpty && line != card.summary;
    }).firstOrNull;
    final latestAuthor = latest?.authorId;
    final latestWho = latestAuthor == null ? null : app.accounts[latestAuthor]?.handle;
    final meta = TextStyle(color: k.fgSubtle, fontSize: 13);

    return Scaffold(
      appBar: AppBar(title: Text(_kindLabel(t, card.kind))),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView(
                key: const Key('inbox-detail'),
                padding: const EdgeInsets.all(HarkroomSize.gutter),
                children: [
                  Wrap(crossAxisAlignment: WrapCrossAlignment.center, spacing: 6, children: [
                    if (whoId != null) HarkroomAvatar(id: whoId, name: who ?? '', size: 20),
                    if (who != null) Text(who, style: TextStyle(color: k.fgMuted, fontWeight: FontWeight.w600, fontSize: 13)),
                    Text('· ${app.boardChannelLabel(card.channelId)}', style: meta),
                    Text('· ${agoLabel(card.sinceAt, DateTime.now().toUtc(), t)}', style: meta),
                    if (replies > 0)
                      Text('· ${t.inboxReplies.replaceFirst('{count}', '$replies')}',
                          key: Key('inbox-detail-replies-${card.rootId}'), style: meta),
                  ]),
                  const SizedBox(height: 12),
                  Text(
                    renderMentions(card.summary, app.accounts, t.mentionUnknown) +
                        (group.similar.isEmpty ? '' : '  ×${group.similar.length + 1}'),
                    key: const Key('inbox-detail-summary'),
                    style: TextStyle(color: k.fg, fontSize: 17, height: 1.35),
                  ),
                  if (latest != null) ...[
                    const SizedBox(height: 12),
                    Container(
                      key: const Key('inbox-detail-latest'),
                      padding: const EdgeInsets.all(10),
                      decoration: BoxDecoration(
                        color: k.surfaceSunken,
                        borderRadius: BorderRadius.circular(8),
                        border: Border.all(color: k.border),
                      ),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(latestWho == null ? t.inboxLatest : '${t.inboxLatest} · $latestWho',
                            style: TextStyle(color: k.fgMuted, fontSize: 12, fontWeight: FontWeight.w600)),
                        const SizedBox(height: 4),
                        Text(renderMentions(oneSentence(latest.body), app.accounts, t.mentionUnknown),
                            style: TextStyle(color: k.fg, fontSize: 14)),
                      ]),
                    ),
                  ],
                  // 선택지는 한 줄에 하나 — 행동 줄과 떨어져 있다(designer d1·n3: [치우기]가 「거절」로 읽히지 않게).
                  if (card.ask != null) ...[
                    const SizedBox(height: 16),
                    for (final o in card.ask!.options)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: OutlinedButton(
                          key: Key('inbox-detail-answer-${o.id}'),
                          style: OutlinedButton.styleFrom(alignment: Alignment.centerLeft, padding: const EdgeInsets.all(14)),
                          onPressed: _busy ? null : () => _answer(card, o.id),
                          child: Text(o.label, style: TextStyle(color: k.fg, fontSize: 15)),
                        ),
                      ),
                  ],
                ],
              ),
            ),
            // 아래 고정 행동 줄. 물음 카드에서는 [스레드 열기]를 테두리 버튼으로 — 선택지가 먼저 눈에 든다(designer n7).
            Container(
              key: const Key('inbox-detail-actions'),
              decoration: BoxDecoration(color: k.surface, border: Border(top: BorderSide(color: k.border))),
              padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 10, HarkroomSize.gutter, 10),
              child: Row(children: [
                Expanded(
                  child: card.ask != null
                      ? OutlinedButton(key: const Key('inbox-detail-open'), onPressed: () => _openThread(card), child: Text(t.inboxOpenThread))
                      : FilledButton(key: const Key('inbox-detail-open'), onPressed: () => _openThread(card), child: Text(t.inboxOpenThread)),
                ),
                const SizedBox(width: 8),
                if (folded)
                  TextButton(
                    key: const Key('inbox-detail-restore'),
                    onPressed: _busy ? null : () => _act(group, BoardAction.restore),
                    child: Text(t.inboxPutBack),
                  )
                else ...[
                  TextButton(
                    key: const Key('inbox-detail-later'),
                    onPressed: _busy ? null : () => _act(group, BoardAction.later),
                    child: Text(t.inboxLater),
                  ),
                  TextButton(
                    key: const Key('inbox-detail-dismiss'),
                    onPressed: _busy ? null : () => _act(group, BoardAction.dismiss),
                    child: Text(t.inboxDismiss),
                  ),
                ],
              ]),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _answer(BoardCard card, String optionId) async {
    final app = context.app;
    final t = context.t;
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      await app.answerAsk(card.channelId, card.ask!.messageId, optionId);
      await app.loadBoard();
    } on Object {
      messenger.showSnackBar(SnackBar(content: Text(t.inboxActionFailed)));
    }
    if (mounted) setState(() => _busy = false);
  }

  /// 그 스레드를 연다(읽음은 이때). 채널 바로 밑의 말 하나뿐이면 그 채널로 간다.
  Future<void> _openThread(BoardCard card) async {
    final app = context.app;
    final navigator = Navigator.of(context);
    unawaited(app.markBoardCardRead(card));
    await app.openChannel(card.channelId);
    final isThread = card.entries.any((e) => e.threadRootId != null) || (card.replyCount ?? 0) > 0;
    await navigator.push(MaterialPageRoute<void>(
      builder: (_) => isThread ? ThreadScreen(channelId: card.channelId, rootId: card.rootId) : MessageListScreen(channelId: card.channelId),
    ));
  }
}
