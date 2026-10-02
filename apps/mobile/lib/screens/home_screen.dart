import 'dart:async';

import 'package:flutter/material.dart';

import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import 'channel_list_screen.dart';
import 'inbox_screen.dart';
import 'search_screen.dart';
import '../ui/tokens.dart';

/// 폰의 루트 — **탭 넷**(개정판 3.1: 홈 · DM · 인박스 · 에이전트). 「나」 는 머리의 프로필 사진이다.
///
/// 데스크탑의 3컬럼(레일·사이드바·채널)을 접지 않는다. 접으면 셋 다 좁아진다.
/// 폰에서는 한 번에 하나를 보고, 채널 → 스레드는 **화면을 밀어 넣어** 연다.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  /// 다른 커뮤니티의 수를 받는 시계(D5). 홈이 떠 있는 동안만 돈다.
  Timer? _others;

  @override
  void initState() {
    super.initState();
    final app = AppScope.read(context);
    _others = Timer.periodic(app.otherPollEvery, (_) => app.refreshOtherCounts());
  }

  @override
  void dispose() {
    _others?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final unread = app.inboxUnread;
    // DM 탭 배지 = DM 채널들의 안 읽은 수 합(서버가 센 값).
    var dmUnread = 0;
    for (final c in app.channels) {
      if (c.isDm) dmUnread += app.reads[c.id]?.unread ?? 0;
    }
    // 탭은 [AppState.homeTab] 이 쥔다 — 커뮤니티를 옮기며 부팅 화면을 거쳐도 살아남게.
    final tab = app.homeTab.clamp(0, 3);

    return Scaffold(
      // 떠 있는 막대 뒤로 목록이 흐르게 — 막대가 내용을 가리지 않도록 몸통 아래에 막대 높이만큼 비운다.
      extendBody: true,
      body: IndexedStack(
        index: tab,
        // **`IndexedStack` 이다.** 탭을 옮길 때마다 화면을 새로 만들면 스크롤 위치와
        // 치던 글이 사라진다 — 채널을 보다 받은 것을 확인하고 돌아오는 것이 이 앱에서
        // 가장 흔한 동작이다.
        children: const [
          ChannelListScreen(),
          ChannelListScreen(dms: true),
          InboxScreen(),
          AgentsSoonScreen(),
        ],
      ),
      // 개정판 3.1: 떠 있는 둥근 막대에 탭 넷 + 오른쪽 둥근 찾기 버튼. 찾기 버튼은 어느 탭에서나
      // 같은 자리에 서고 **전체** 범위로 연다(채널·스레드 범위는 그 화면 머리의 돋보기).
      bottomNavigationBar: SafeArea(
        minimum: const EdgeInsets.only(bottom: 8),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 0),
          child: Row(children: [
            Expanded(child: FloatingTabBar(
            selected: tab,
            onSelect: app.selectTab,
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
class FloatingTabBar extends StatelessWidget {
  const FloatingTabBar({super.key, required this.selected, required this.onSelect, required this.items});

  final int selected;
  final ValueChanged<int> onSelect;
  final List<TabItem> items;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return Material(
      color: k.bg,
      elevation: 3,
      shadowColor: Colors.black26,
      shape: StadiumBorder(side: BorderSide(color: k.line)),
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
                        color: i == selected ? k.soft : Colors.transparent,
                        shape: const StadiumBorder(),
                      ),
                      child: Column(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          Badge.count(
                            count: items[i].badge,
                            isLabelVisible: items[i].badge > 0,
                            child: Icon(i == selected ? items[i].selectedIcon : items[i].icon,
                                size: 22, color: i == selected ? k.fg : k.mute),
                          ),
                          const SizedBox(height: 2),
                          Text(
                            items[i].label,
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: i == selected ? FontWeight.w700 : FontWeight.w400,
                              color: i == selected ? k.fg : k.mute,
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
      child: Material(
        color: k.bg,
        elevation: 3,
        shadowColor: Colors.black26,
        shape: CircleBorder(side: BorderSide(color: k.line)),
        child: InkWell(
          key: const Key('tab-search'),
          customBorder: const CircleBorder(),
          onTap: () => openSearch(context),
          child: SizedBox(width: 58, height: 58, child: Icon(Icons.search, size: 24, color: k.fg)),
        ),
      ),
    );
  }
}

/// 에이전트 탭 — S7(도는 턴·기다리는 것) 전까지의 빈 자리.
class AgentsSoonScreen extends StatelessWidget {
  const AgentsSoonScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return Scaffold(
      appBar: AppBar(title: Text(t.tabAgents), actions: const [OpenMeButton(), SizedBox(width: 8)]),
      body: Center(
        child: Padding(
          key: const Key('agents-soon'),
          padding: const EdgeInsets.all(HarkroomSize.gutter),
          child: Text(t.agentsSoon, textAlign: TextAlign.center, style: TextStyle(color: context.tokens.mute)),
        ),
      ),
    );
  }
}
