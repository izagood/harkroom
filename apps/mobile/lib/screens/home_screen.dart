import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';

import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../time.dart';
import '../ui/parts.dart';
import '../ui/states.dart';
import 'channel_list_screen.dart';
import 'message_list_screen.dart';
import 'thread_screen.dart';
import 'inbox_screen.dart';
import 'search_screen.dart';
import 'tab_nav.dart';
import '../ui/tokens.dart';

/// 폰의 루트 — **탭 넷**(개정판 3.1: 홈 · DM · 인박스 · 에이전트). 「나」 는 머리의 프로필 사진이다.
///
/// 데스크탑의 3컬럼(레일·사이드바·채널)을 접지 않는다. 접으면 셋 다 좁아진다.
/// 폰에서는 한 번에 하나를 보고, 채널 → 스레드는 **그 탭의 쌓기에 밀어 넣어** 연다 — 탭 바는 채널·스레드
/// 안에서도 남는다([TabNavigators], 하단 네비 고정 D2).
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  /// 다른 커뮤니티의 수를 받는 시계(D5). 홈이 떠 있는 동안만 돈다.
  Timer? _others;

  /// 탭마다 자기 화면 쌓기. 홈이 사라지면(커뮤니티 전환은 부팅 화면을 거친다) 함께 사라진다 —
  /// 앞 커뮤니티의 채널·스레드가 새 커뮤니티의 탭에 남지 않는다.
  final _tabs = TabNavigators();

  @override
  void initState() {
    super.initState();
    TabNavigators.active = _tabs;
    for (var i = 0; i < TabNavigators.count; i++) {
      _tabs.barHidden(i).addListener(_onBarHidden);
    }
    final app = AppScope.read(context);
    _others = Timer.periodic(app.otherPollEvery, (_) => app.refreshOtherCounts());
  }

  @override
  void dispose() {
    _others?.cancel();
    if (identical(TabNavigators.active, _tabs)) TabNavigators.active = null;
    _tabs.dispose();
    super.dispose();
  }

  void _onBarHidden() {
    if (!mounted) return;
    // 경로는 Navigator 의 build 안에서도 바뀐다 — 그때는 다음 프레임에 다시 그린다.
    if (SchedulerBinding.instance.schedulerPhase == SchedulerPhase.persistentCallbacks) {
      SchedulerBinding.instance.addPostFrameCallback((_) {
        if (mounted) setState(() {});
      });
    } else {
      setState(() {});
    }
  }

  /// 탭을 누른다. 다른 탭이면 옮기기만(그 탭에서 보던 화면이 그대로 있다). **지금 탭을 다시 누르면**
  /// 뿌리로 돌아가고, 이미 뿌리면 맨 위로 굴린다(D4 — 탭 바가 늘 떠 있으니 「목록으로」 가 이 한 번이다).
  void _select(int i) {
    final app = AppScope.read(context);
    if (i != app.homeTab) {
      app.selectTab(i);
      return;
    }
    final nav = _tabs.navigator(i);
    if (nav != null && nav.canPop()) {
      nav.popUntil((r) => r.isFirst);
      return;
    }
    final scroll = _tabs.scrolls[i];
    if (scroll.hasClients) {
      scroll.animateTo(0, duration: const Duration(milliseconds: 250), curve: Curves.easeOut).ignore();
    }
  }

  Widget _tabNavigator(int i, Widget root, int selected) => NavigatorPopHandler(
        // 안드로이드 뒤로는 **보고 있는 탭**의 쌓기를 먼저 뺀다. 뿌리면 앱이 받는다.
        enabled: i == selected,
        onPopWithResult: (_) => _tabs.navigator(i)?.maybePop(),
        child: Navigator(
          key: _tabs.keys[i],
          observers: [_tabs.observers[i]],
          onGenerateRoute: (settings) => MaterialPageRoute<void>(
            settings: settings,
            // 맨 위로 굴리기(D4)는 **뿌리 화면의 목록**만 집는다 — 쌓기 위 채널·스레드 목록은 제 손잡이를 쓴다.
            builder: (_) => PrimaryScrollController(controller: _tabs.scrolls[i], child: root),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    // 인박스 탭 배지 = 나를 기다리는 일 수(G1 (b), 2026-10-13 jaebin) — 데스크톱 배지와 같은 mineCount.
    final unread = app.inboxMine;
    // DM 탭 배지 = DM 채널들의 안 읽은 수 합(서버가 센 값).
    var dmUnread = 0;
    for (final c in app.channels) {
      if (c.isDm) dmUnread += app.reads[c.id]?.unread ?? 0;
    }
    // 탭은 [AppState.homeTab] 이 쥔다 — 커뮤니티를 옮기며 부팅 화면을 거쳐도 살아남게.
    final tab = app.homeTab.clamp(0, 3);
    final mq = MediaQuery.of(context);
    final keyboard = mq.viewInsets.bottom;
    final barHeight = floatingTabBarHeight(mq);
    final barless = _tabs.barHidden(tab).value;
    // 키보드가 올라오면 탭 바는 키보드 뒤로 숨고 입력창만 키보드 위에 남는다(D2). 탭 바는 **키보드가 다 덮은
    // 뒤에** 뺀다 — 오르는 동안은 키보드가 아래에서 덮어 간다. 찾기처럼 탭 바를 숨기는 화면이 맨 위여도 숨긴다.
    final hideBar = keyboard >= barHeight || barless;
    // 안쪽 화면이 비울 아래 여백 = 탭 바 높이 − 키보드(designer #1368 n1). 안쪽 Scaffold 는 키보드만큼 줄어들므로
    // 둘을 더하면 늘 max(탭 바, 키보드) — 키보드가 오르는 첫 프레임에 입력창이 탭 바 높이만큼 떨어졌다가
    // 따라 올라오지 않는다. Scaffold 가 extendBody 로 넣는 여백은 탭 바가 빠지는 순간 0 으로 뛰어서 쓰지 않는다.
    final bodyBottom = barless ? mq.padding.bottom : math.max(barHeight - keyboard, 0.0);

    return Scaffold(
      // 떠 있는 막대 뒤로 목록이 흐르게 — 막대가 내용을 가리지 않도록 몸통 아래에 막대 높이만큼 비운다.
      // 그 높이는 MediaQuery 의 아래 여백으로 쌓기 안 화면까지 내려간다 — 채널·스레드의 입력창이 막대 위에 선다.
      extendBody: true,
      // 키보드는 **안쪽** 화면(채널·스레드의 Scaffold)이 비킨다. 여기서도 비키면 두 번 줄어든다.
      resizeToAvoidBottomInset: false,
      body: MediaQuery(
        data: mq.copyWith(padding: mq.padding.copyWith(bottom: bodyBottom)),
        child: IndexedStack(
        index: tab,
        // **`IndexedStack` 이다.** 탭을 옮길 때마다 화면을 새로 만들면 스크롤 위치와
        // 치던 글이 사라진다 — 채널을 보다 받은 것을 확인하고 돌아오는 것이 이 앱에서
        // 가장 흔한 동작이다. 탭마다 제 쌓기가 있어서 보던 채널·스레드도 남는다.
        children: [
          _tabNavigator(0, const ChannelListScreen(), tab),
          _tabNavigator(1, const ChannelListScreen(dms: true), tab),
          _tabNavigator(2, const InboxScreen(), tab),
          _tabNavigator(3, const AgentsScreen(), tab),
        ],
      )),
      // 개정판 3.1: 떠 있는 둥근 막대에 탭 넷 + 오른쪽 둥근 찾기 버튼. 찾기 버튼은 어느 탭에서나
      // 같은 자리에 서고 **전체** 범위로 연다(채널·스레드 범위는 그 화면 머리의 돋보기).
      bottomNavigationBar: hideBar
          ? null
          : SafeArea(
              key: const Key('home-tab-bar'),
              minimum: const EdgeInsets.only(bottom: 8),
              // 키보드가 오르는 동안 아래 여백이 줄어 막대가 같이 내려가지 않게 — 높이는 [floatingTabBarHeight] 와 같다.
              maintainBottomViewPadding: true,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(12, 0, 12, 0),
                child: Row(children: [
                  Expanded(
                      child: FloatingTabBar(
                    selected: tab,
                    onSelect: _select,
                    items: [
                      TabItem(key: const Key('tab-home'), icon: Icons.home_outlined, selectedIcon: Icons.home, label: t.tabHome),
                      TabItem(key: const Key('tab-dms'), icon: Icons.mail_outline, selectedIcon: Icons.mail, label: t.tabDms, badge: dmUnread),
                      // 안 본 것이 **0 이면 배지를 그리지 않는다** — 빈 배지는 "뭔가 있다"는 거짓 신호다.
                      // 고른 탭에서도 수를 보인다(designer #976 판정 ②).
                      TabItem(key: const Key('tab-inbox'), icon: Icons.inbox_outlined, selectedIcon: Icons.inbox, label: t.tabInbox, badge: unread),
                      TabItem(key: const Key('tab-agents'), icon: Icons.smart_toy_outlined, selectedIcon: Icons.smart_toy, label: t.tabAgents),
                    ],
                  )),
                  const SizedBox(width: 8),
                  const FloatingSearchButton(),
                ]),
              ),
            ),
    );
  }
}

/// 떠 있는 탭 바가 차지하는 높이 — 막대(48 + 위아래 5 = 찾기 버튼 58)와 그 아래 안전 여백(최소 8).
/// 키보드와 상관없이 같은 값이다(viewPadding) — 탭 바도 `maintainBottomViewPadding` 으로 같은 높이를 쓴다.
double floatingTabBarHeight(MediaQueryData mq) => 58 + math.max(mq.viewPadding.bottom, 8.0);

/// 탭 하나.
class TabItem {
  const TabItem({required this.key, required this.icon, required this.selectedIcon, required this.label, this.badge = 0});
  final Key key;
  final IconData icon;
  final IconData selectedIcon;
  final String label;
  final int badge;
}

/// 떠 있는 둥근 막대(개정판 3.1). 고른 탭은 옅은 바탕 + 굵게, 배지는 수가 있을 때만.
/// 탭 라벨이 따르는 글자 배율 상한. 아이콘 22 + 틈 2 + 라벨 한 줄이 칸 48 안에 들어가는 값이다.
const double _tabLabelMaxTextScale = 1.3;

class FloatingTabBar extends StatelessWidget {
  const FloatingTabBar({super.key, required this.selected, required this.onSelect, required this.items});

  final int selected;
  final ValueChanged<int> onSelect;
  final List<TabItem> items;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final b = Theme.of(context).brightness;
    // 떠 있는 막대 — 그림자는 `HarkroomShadow.float` 한 종류다(A · Paper §7). Material 의
    // elevation 그림자는 모드마다 값을 고를 수 없어 상자 장식으로 그린다.
    return DecoratedBox(
      decoration: ShapeDecoration(shape: StadiumBorder(side: HarkroomShadow.floatBorder(b)), shadows: HarkroomShadow.float(b)),
      child: Material(
      color: k.surface,
      shape: const StadiumBorder(),
      clipBehavior: Clip.antiAlias,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 5),
        child: Row(
          children: [
            for (var i = 0; i < items.length; i++)
              Expanded(
                child: Semantics(
                  selected: i == selected,
                  button: true,
                  child: InkWell(
                    key: items[i].key,
                    customBorder: const StadiumBorder(),
                    onTap: () => onSelect(i),
                    child: Container(
                      height: 48,
                      decoration: ShapeDecoration(
                        color: i == selected ? k.surfaceHover : Colors.transparent,
                        shape: const StadiumBorder(),
                      ),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Badge.count(
                            count: items[i].badge,
                            isLabelVisible: items[i].badge > 0,
                            child: Icon(i == selected ? items[i].selectedIcon : items[i].icon,
                                size: 22, color: i == selected ? k.fg : k.fgMuted),
                          ),
                          const SizedBox(height: 2),
                          // 칸 높이(48)는 막대 높이([floatingTabBarHeight])에 묶여 있어 키울 수 없다. 큰 글자에서
                          // 라벨이 두 줄로 접히면 칸을 넘친다(375 폭·×1.3 에서 16px) — 그래서 **한 줄**로 묶고,
                          // 칸보다 넓으면 줄여 맞추고, 배율은 이 라벨만 [_tabLabelMaxTextScale] 까지 따른다.
                          // 앱의 다른 글자는 큰 글자를 그대로 따른다.
                          MediaQuery.withClampedTextScaling(
                            maxScaleFactor: _tabLabelMaxTextScale,
                            child: FittedBox(
                              fit: BoxFit.scaleDown,
                              child: Text(
                                items[i].label,
                                maxLines: 1,
                                softWrap: false,
                                style: TextStyle(
                                  fontSize: 11,
                                  fontWeight: i == selected ? FontWeight.w600 : FontWeight.w400,
                                  color: i == selected ? k.fg : k.fgMuted,
                                ),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    ),
    );
  }
}

/// 탭 막대 오른쪽의 둥근 찾기 버튼. 막대와 같은 바탕·그림자·테두리라 한 묶음으로 읽힌다.
/// 높이는 막대(48 + 위아래 5)와 같다.
class FloatingSearchButton extends StatelessWidget {
  const FloatingSearchButton({super.key});

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return Semantics(
      button: true,
      label: context.t.searchButton,
      excludeSemantics: true,
      child: DecoratedBox(
        decoration: ShapeDecoration(
          shape: CircleBorder(side: HarkroomShadow.floatBorder(Theme.of(context).brightness)),
          shadows: HarkroomShadow.float(Theme.of(context).brightness),
        ),
        child: Material(
        color: k.surface,
        shape: const CircleBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: const Key('tab-search'),
          customBorder: const CircleBorder(),
          onTap: () => openSearch(context),
          child: SizedBox(width: 58, height: 58, child: Icon(Icons.search, size: 24, color: k.fg)),
        ),
      ),
      ),
    );
  }
}

/// 에이전트 탭 — S7(도는 턴·기다리는 것) 전까지의 빈 자리.
/// 에이전트 탭(개정판 3.7, S7) — **읽기 전용**. 지금 도는 턴 · 스스로 걸어 둔 예약 · 에이전트 전체.
///
/// 보이는 범위는 서버가 정한다: **그 채널을 볼 수 있으면 본다**(`?scope=visible`, 결정 A). 줄을 누르면
/// 그 스레드로 간다. 터미널 붙기·그만두기 버튼은 **두지 않는다** — 그것은 소유자 문이고 데스크탑에 있다.
class AgentsScreen extends StatelessWidget {
  const AgentsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final k = context.tokens;
    final now = DateTime.now();
    final agents = app.accounts.values.where((a) => a.isAgent && !a.isDisabled).toList(growable: false)
      ..sort((a, b) => a.handle.toLowerCase().compareTo(b.handle.toLowerCase()));
    final running = {for (final x in app.agentActivity) x.agentAccountId};

    Widget head(String text, String key) => Padding(
          key: Key(key),
          padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 14, HarkroomSize.gutter, 4),
          child: Text(text, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: k.fgMuted)),
        );
    String channelName(String id) {
      for (final c in app.channels) {
        if (c.id == id) return c.isDm ? c.name : '#${c.name}';
      }
      return '';
    }

    Future<void> open(String channelId, String? rootId) async {
      await app.openChannel(channelId);
      if (!context.mounted) return;
      await openChannelScreen(
        context,
        channelId,
        (_) => rootId == null
            ? MessageListScreen(channelId: channelId)
            : ThreadScreen(channelId: channelId, rootId: rootId),
      );
    }

    // [inset] = 반투명 머리 + 끊김 띠 높이 — 목록은 화면 맨 위부터 그리고 그만큼 비운다.
    Widget body(double inset) {
    if (app.agentsLoad == LoadState.failed && app.agentActivity.isEmpty && app.agentWakes.isEmpty) {
      return Padding(
        padding: EdgeInsets.only(top: inset),
        child: FailedState(
          title: t.agentsLoadFailed,
          cause: app.failures['agents'] ?? LoadFailure.network,
          onRetry: app.loadAgents,
        ),
      );
    } else if (app.agentsLoad == LoadState.loading && app.agentActivity.isEmpty) {
      return Padding(padding: EdgeInsets.only(top: inset), child: const LoadingSkeleton(rows: 3));
    }
      return RefreshIndicator(
        // 당기기 회전자는 머리 밑에서 나온다 — 0 이면 반투명 머리 뒤에 숨는다.
        edgeOffset: inset,
        onRefresh: app.loadAgents,
        child: ListView(
          key: const Key('agents-list'),
          physics: const AlwaysScrollableScrollPhysics(),
          padding: EdgeInsets.only(top: inset),
          children: [
            head(t.agentsRunning, 'agents-running'),
            if (app.agentActivity.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter, vertical: 6),
                child: Text(t.agentsNoneRunning, style: TextStyle(color: k.fgMuted)),
              ),
            for (final x in app.agentActivity)
              ListTile(
                key: Key('agent-run-${x.agentAccountId}-${x.channelId}-${x.threadRootId ?? ''}'),
                dense: true,
                leading: HarkroomAvatar(id: x.agentAccountId, name: app.displayNameOf(x.agentAccountId), size: 28),
                title: Text(app.displayNameOf(x.agentAccountId)),
                subtitle: Text(
                  [
                    channelName(x.channelId),
                    if (x.startedAt != null) runningLabel(now.difference(x.startedAt!), t),
                    if (x.owned) t.agentsMine,
                  ].where((e) => e.isNotEmpty).join(' · '),
                  style: TextStyle(color: k.fgMuted),
                ),
                onTap: () => open(x.channelId, x.threadRootId),
              ),
            if (app.agentWakes.isNotEmpty) head(t.agentsWaiting, 'agents-waiting'),
            for (final w in app.agentWakes)
              ListTile(
                key: Key('agent-wake-${w.agentAccountId}-${w.threadRootId}'),
                dense: true,
                leading: HarkroomAvatar(id: w.agentAccountId, name: app.displayNameOf(w.agentAccountId), size: 28),
                title: Text(app.displayNameOf(w.agentAccountId)),
                subtitle: Text(
                  [
                    if (w.wakeAt != null) inLabel(w.wakeAt!, now, t),
                    channelName(w.channelId),
                    if (w.reason != null) w.reason!,
                  ].where((e) => e.isNotEmpty).join(' · '),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(color: k.fgMuted),
                ),
                onTap: () => open(w.channelId, w.threadRootId),
              ),
            head(t.agentsAll, 'agents-all'),
            for (final a in agents)
              ListTile(
                key: Key('agent-${a.id}'),
                dense: true,
                leading: HarkroomAvatar(id: a.id, name: a.handle, size: 28),
                title: Text(a.displayName.isNotEmpty ? a.displayName : a.handle),
                subtitle: a.displayName.isNotEmpty && a.displayName != a.handle ? Text('@${a.handle}') : null,
                // 도는 중이면 작은 점 — 위 묶음과 같은 사실을 전체 목록에서도 한눈에.
                trailing: running.contains(a.id)
                    ? Icon(Icons.circle, size: 8, color: k.accent, semanticLabel: t.agentsRunning)
                    : null,
                // 누르면 그 에이전트와의 DM — 탭에서 바로 일을 시킨다(designer ①).
                onTap: () => openDmScreen(context, a.id),
              ),
            // 떠 있는 막대에 마지막 줄이 가리지 않도록.
            const SizedBox(height: 96),
          ],
        ),
      );
    }

    return Scaffold(
      // 반투명 머리(④) — 목록이 그 밑으로 흐르고, 끊김 띠만 머리 밑에 고정한다.
      extendBodyBehindAppBar: true,
      appBar: GlassAppBar(bar: AppBar(title: Text(t.tabAgents), actions: const [OpenMeButton(), SizedBox(width: 8)])),
      body: SafeArea(top: false, child: GlassBody(header: const ConnectionBand(), builder: (context, inset) => body(inset))),
    );
  }
}
