import 'package:flutter/material.dart';

import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import 'channel_list_screen.dart';
import 'inbox_screen.dart';
import 'me_screen.dart';

/// 폰의 루트 — **탭 셋**(계획서 §6).
///
/// 데스크탑의 3컬럼(레일·사이드바·채널)을 접지 않는다. 접으면 셋 다 좁아진다.
/// 폰에서는 한 번에 하나를 보고, 채널 → 스레드는 **화면을 밀어 넣어** 연다.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  int _tab = 0;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final unread = context.app.inboxUnread;

    return Scaffold(
      body: IndexedStack(
        index: _tab,
        // **`IndexedStack` 이다.** 탭을 옮길 때마다 화면을 새로 만들면 스크롤 위치와
        // 치던 글이 사라진다 — 채널을 보다 받은 것을 확인하고 돌아오는 것이 이 앱에서
        // 가장 흔한 동작이다.
        children: const [ChannelListScreen(), InboxScreen(), MeScreen()],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() => _tab = i),
        destinations: [
          NavigationDestination(
            key: const Key('tab-channels'),
            icon: const Icon(Icons.forum_outlined),
            selectedIcon: const Icon(Icons.forum),
            label: t.tabChannels,
          ),
          NavigationDestination(
            key: const Key('tab-inbox'),
            // 안 본 것이 **0 이면 배지를 그리지 않는다** — 빈 배지는 "뭔가 있다"는
            // 거짓 신호다.
            icon: Badge.count(
              count: unread,
              isLabelVisible: unread > 0,
              child: const Icon(Icons.inbox_outlined),
            ),
            selectedIcon: const Icon(Icons.inbox),
            label: t.tabInbox,
          ),
          NavigationDestination(
            key: const Key('tab-me'),
            icon: const Icon(Icons.person_outline),
            selectedIcon: const Icon(Icons.person),
            label: t.tabMe,
          ),
        ],
      ),
    );
  }
}
