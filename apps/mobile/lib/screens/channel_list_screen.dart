import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../ui/states.dart';
import '../ui/parts.dart';
import '../ui/tokens.dart';
import 'community_screens.dart';
import 'saved_screen.dart';
import 'me_screen.dart';
import 'message_list_screen.dart';

/// 채널 목록. 폰의 루트 화면이고, 여기서 채널을 **밀어 넣어** 연다(옆 패널이 아니다).
class ChannelListScreen extends StatelessWidget {
  const ChannelListScreen({super.key, this.dms = false});

  /// DM 탭이면 DM 만, 홈이면 DM 을 뺀 채널만(개정판 3.2 — DM 은 홈 목록에서 빼서 DM 탭으로).
  final bool dms;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    // 치운 채널(hiddenAt)은 세우지 않는다 — 데스크탑 사이드바와 같은 규칙.
    final rows = app.channels
        .where((c) => c.isDm == dms && app.channelPrefs[c.id]?.hidden != true)
        .toList(growable: false);
    // 홈은 묶음으로(S5b): 즐겨찾기 → 사용자 섹션(이름순) → 채널. DM 탭은 한 묶음 그대로.
    final items = <Object>[];
    // 「새로 온 것」 카드를 눌렀으면 안 읽은 채널만, 묶음 없이 한 줄로(S5c).
    final unreadOnly = !dms && app.homeUnreadOnly;
    if (dms) {
      items.addAll(rows);
    } else if (unreadOnly) {
      items.addAll(rows.where((c) => (app.reads[c.id]?.unread ?? 0) > 0));
    } else {
      for (final sec in homeSections(rows, app.channelPrefs)) {
        items.add(sec);
        if (!app.collapsedSections.contains(sec.key)) items.addAll(sec.channels);
      }
    }

    return Scaffold(
      // 머리 왼쪽이 커뮤니티 자리다(설계 ①) — 데스크탑 레일 맨 위 타일과 같은 규칙.
      appBar: AppBar(
        titleSpacing: 8,
        title: dms
            ? Text(t.tabDms)
            : app.activeCommunity == null
                ? Text(t.channelsTitle)
                : const CommunityHeader(),
        // 「나」 는 탭이 아니라 머리 오른쪽의 프로필 사진이다(개정판 3.1·3.8).
        actions: const [OpenMeButton(), SizedBox(width: 8)],
      ),
      body: SafeArea(
        child: Column(
          children: [
            // 끊김은 **모든 화면 공통 띠**다(제목 줄 아래 작은 회색 글씨였다 — 늘 22px 를 차지했고
            // 끊겼을 때도 잘 안 읽혔다).
            const ConnectionBand(),
            if (app.noticeKey != null) _Notice(messageKey: app.noticeKey!),
            if (!dms) ShortcutCards(newCount: rows.where((c) => (app.reads[c.id]?.unread ?? 0) > 0).length),
            Expanded(
              child: rows.isEmpty || (unreadOnly && items.isEmpty)
                  ? Center(child: Text(dms ? t.dmsEmpty : unreadOnly ? t.unreadOnlyEmpty : t.channelsEmpty))
                  : ListView.builder(
                      // 커뮤니티를 옮기면 맨 위부터 — 앞 커뮤니티의 스크롤 자리를 이어받지 않는다(설계 ④).
                      key: PageStorageKey('${dms ? 'dms' : 'channels'}-${app.activeKey}'),
                      itemCount: items.length,
                      itemBuilder: (context, i) {
                        final item = items[i];
                        if (item is HomeSection) {
                          return _SectionHeader(
                            section: item,
                            collapsed: app.collapsedSections.contains(item.key),
                            onTap: () => app.toggleSection(item.key),
                          );
                        }
                        final channel = item as ChannelRow;
                        final unread = app.reads[channel.id]?.unread ?? 0;
                        return ListTile(
                          // 글자로 줄을 집지 않는다 — 이름은 번역되고 바뀐다.
                          key: Key('channel-${channel.id}'),
                          leading: Icon(channel.isDm
                              ? Icons.alternate_email
                              : channel.isPrivate
                                  ? Icons.lock_outline
                                  : Icons.tag),
                          // **안 읽은 채널은 굵게, 읽은 채널은 회색.** 배지만으로는 눈이 오른쪽
                          // 끝까지 가야 안다 — 이름의 굵기가 왼쪽에서 먼저 말한다.
                          title: _ChannelName(name: channel.name, unread: unread > 0),
                          // 주제는 줄을 두 줄로 늘린다 — 44 줄에 넣지 않는다. 채널 머리의
                          // 부제가 그 자리다(S4).
                          // 안 읽은 수는 **서버가 센다.** 클라이언트가 세면 열지 않은
                          // 채널에서 틀리고, 틀린 배지는 없는 배지보다 나쁘다.
                          trailing: UnreadBadge(count: unread),
                          onTap: () {
                            app.openChannel(channel.id);
                            Navigator.of(context).push(MaterialPageRoute<void>(
                              builder: (_) => MessageListScreen(channelId: channel.id),
                            ));
                          },
                        );
                      },
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

/// 한 번 말하고 사람이 지우는 알림.
class _Notice extends StatelessWidget {
  const _Notice({required this.messageKey});

  final String messageKey;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final text = messageKey == 'noticeSessionNotSaved' ? t.noticeSessionNotSaved : messageKey;
    return StatusBand(
      key: const Key('notice-text'),
      text: text,
      tone: BandTone.error,
      onClose: () => context.app.clearNotice(),
    );
  }
}

/// 채널 이름. **안 읽은 채널은 굵게, 읽은 채널은 회색.** 배지만으로는 눈이 오른쪽 끝까지 가야
/// 안다 — 이름의 굵기가 왼쪽에서 먼저 말한다.
///
/// 따로 위젯인 이유: 색을 `itemBuilder` 안에서 토큰으로 집으면 **밝기가 바뀌어도 그 줄이
/// 다시 그려지지 않았다**(다크로 바꾸자 안 읽은 채널 이름이 밝은 판의 먹색으로 남아 바탕에
/// 묻혔다 — 갤러리 다크 그림에서 잡았다). 제 `build` 에서 테마를 읽어야 테마를 구독한다.
class _ChannelName extends StatelessWidget {
  const _ChannelName({required this.name, required this.unread});

  final String name;
  final bool unread;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return Text(
      name,
      style: TextStyle(
        // 채널 이름은 늘 600(A · Paper §4 ※5) — 안 읽음은 굵기가 아니라 글자색과 배지로 가른다.
        fontWeight: FontWeight.w600,
        color: unread ? k.fg : k.fgMuted,
      ),
    );
  }
}

/// 머리 오른쪽의 내 프로필 사진. 누르면 「나」 화면을 밀어 넣는다(시트 모양은 S6).
class OpenMeButton extends StatelessWidget {
  const OpenMeButton({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final me = app.me;
    return IconButton(
      key: const Key('open-me'),
      // 사진만 보이므로 스크린리더에는 이 이름이 들린다 — 무엇이 열리는지 말한다(designer S5a 후속).
      tooltip: context.t.meSettings,
      onPressed: () => openMeSheet(context),
      icon: me == null
          ? const Icon(Icons.account_circle_outlined)
          : HarkroomAvatar(id: me.id, name: me.handle, size: 28),
    );
  }
}

/// 홈의 한 묶음.
class HomeSection {
  const HomeSection({required this.key, required this.kind, required this.name, required this.channels});

  /// 접기 상태의 열쇠: `starred` · `section:<이름>` · `channels`.
  final String key;
  final HomeSectionKind kind;

  /// 사용자 섹션 이름(kind 가 custom 일 때만).
  final String? name;
  final List<ChannelRow> channels;
}

enum HomeSectionKind { starred, custom, channels }

/// 홈 묶음(데스크탑 사이드바와 같은 규칙):
/// - **즐겨찾기**가 맨 위. 별표 채널은 **여기에만** 선다(두 묶음에 같은 채널이 두 줄이면 어느 배지가
///   최신인지 답하지 못한다).
/// - 그다음 사용자 섹션을 이름순으로, 섹션 없는 채널은 맨 아래 「채널」.
/// - 묶음 안은 수동 순서(`sortOrder`, 없으면 뒤) → 이름.
/// - 빈 묶음은 세우지 않는다 — 단 「채널」 은 다른 묶음이 하나도 없을 때도 선다(목록 머리).
List<HomeSection> homeSections(List<ChannelRow> channels, Map<String, ChannelPref> prefs) {
  int byOrder(ChannelRow a, ChannelRow b) {
    final oa = prefs[a.id]?.sortOrder;
    final ob = prefs[b.id]?.sortOrder;
    if (oa != null && ob != null && oa != ob) return oa.compareTo(ob);
    if (oa != null && ob == null) return -1;
    if (oa == null && ob != null) return 1;
    return a.name.toLowerCase().compareTo(b.name.toLowerCase());
  }

  final starred = <ChannelRow>[];
  final bySection = <String, List<ChannelRow>>{};
  final plain = <ChannelRow>[];
  for (final c in channels) {
    final p = prefs[c.id];
    if (p?.starred == true) {
      starred.add(c);
    } else if (p?.section != null) {
      bySection.putIfAbsent(p!.section!, () => []).add(c);
    } else {
      plain.add(c);
    }
  }
  final out = <HomeSection>[];
  if (starred.isNotEmpty) {
    out.add(HomeSection(key: 'starred', kind: HomeSectionKind.starred, name: null, channels: starred..sort(byOrder)));
  }
  final names = bySection.keys.toList()..sort((a, b) => a.toLowerCase().compareTo(b.toLowerCase()));
  for (final n in names) {
    out.add(HomeSection(key: 'section:$n', kind: HomeSectionKind.custom, name: n, channels: bySection[n]!..sort(byOrder)));
  }
  if (plain.isNotEmpty || out.isEmpty) {
    out.add(HomeSection(key: 'channels', kind: HomeSectionKind.channels, name: null, channels: plain..sort(byOrder)));
  }
  return out;
}

/// 묶음 머리 한 줄(개정판 3.2 「☆ 즐겨찾기 ⌃」). 누르면 접고 편다.
class _SectionHeader extends StatelessWidget {
  const _SectionHeader({required this.section, required this.collapsed, required this.onTap});

  final HomeSection section;
  final bool collapsed;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final (icon, title) = switch (section.kind) {
      HomeSectionKind.starred => (Icons.star_outline, t.sectionStarred),
      HomeSectionKind.custom => (Icons.folder_outlined, section.name!),
      HomeSectionKind.channels => (Icons.tag, t.sectionChannels),
    };
    return Semantics(
      button: true,
      expanded: !collapsed,
      child: InkWell(
        key: Key('section-${section.key}'),
        onTap: onTap,
        child: Container(
          height: 36,
          padding: const EdgeInsets.symmetric(horizontal: HarkroomSize.gutter),
          decoration: BoxDecoration(border: Border(top: BorderSide(color: k.border))),
          child: Row(
            children: [
              Icon(icon, size: 15, color: k.fgMuted),
              const SizedBox(width: 6),
              Expanded(
                child: Text(title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: k.fg)),
              ),
              Icon(collapsed ? Icons.expand_more : Icons.expand_less, size: 18, color: k.fgMuted),
            ],
          ),
        ),
      ),
    );
  }
}

/// 홈 맨 위 바로가기 카드 셋(개정판 3.2, S5c): 「내 차례」 → 인박스 탭, 「새로 온 것」 → 안 읽은 채널만,
/// 「저장」 → 저장된 메시지 화면(#219).
/// 「초안」 은 초안 저장이 생길 때(S8), 「도는 에이전트」 는 S7 에서 더한다.
class ShortcutCards extends StatelessWidget {
  const ShortcutCards({super.key, required this.newCount});

  /// 안 읽은 말이 있는 채널 수(DM 은 DM 탭 배지가 센다).
  final int newCount;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    return Padding(
      padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 8, HarkroomSize.gutter, 8),
      child: Row(
        children: [
          Expanded(
            child: _ShortcutCard(
              key: const Key('card-my-turn'),
              icon: Icons.inbox_outlined,
              label: t.cardMyTurn,
              count: app.inboxUnread,
              selected: false,
              onTap: () => app.selectTab(2),
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: _ShortcutCard(
              key: const Key('card-new'),
              icon: Icons.mark_chat_unread_outlined,
              label: t.cardNew,
              count: newCount,
              // 켜져 있는 동안은 카드가 눌린 모양이다 — 목록이 왜 줄었는지 카드가 말한다.
              selected: app.homeUnreadOnly,
              onTap: app.toggleHomeUnreadOnly,
            ),
          ),
          const SizedBox(width: 8),
          Expanded(
            child: _ShortcutCard(
              key: const Key('card-saved'),
              icon: Icons.bookmark_border,
              label: t.cardSaved,
              // 할 것 개수. 0 이어도 카드는 남는다 — 사라지면 어디서 여는지 잊는다(designer 시안 ②).
              count: app.savedOpenCount,
              selected: false,
              onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SavedScreen())),
            ),
          ),
        ],
      ),
    );
  }
}

class _ShortcutCard extends StatelessWidget {
  const _ShortcutCard({
    super.key,
    required this.icon,
    required this.label,
    required this.count,
    required this.selected,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final int count;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    // 아이콘·숫자·이름을 VoiceOver 가 따로 읽지 않게 「저장 3」 한 덩이로 묶는다(designer #1231 n4).
    return Semantics(
      button: true,
      selected: selected,
      label: '$label $count',
      // 안쪽 InkWell 을 의미 트리에서 뺐으니 누르는 동작을 여기에 다시 단다 — 없으면 TalkBack·스위치 제어에서
      // 「버튼인데 안 눌리는」 카드가 된다(designer #1236).
      onTap: onTap,
      excludeSemantics: true,
      child: Material(
        color: selected ? k.surfaceHover : k.surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(HarkroomRadius.card), side: BorderSide(color: k.border)),
        child: InkWell(
          customBorder: RoundedRectangleBorder(borderRadius: BorderRadius.circular(HarkroomRadius.card)),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 9),
            // 카드가 셋이면 375pt 폭에서 칸이 ≈110pt 다 — 아이콘·이름·숫자를 한 줄에 두면 이름이 잘린다.
            // 아이콘과 숫자를 윗줄, 이름을 아랫줄에 둔다(designer 시안 ②).
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(icon, size: 18, color: k.fgMuted),
                    const Spacer(),
                    // 0 은 회색 숫자로 둔다 — 카드 자리가 늘 같아야 엄지가 외운다. 배지(빨강)는 쓰지 않는다.
                    Text('$count',
                        style: TextStyle(
                            fontSize: 15,
                            fontWeight: count > 0 ? FontWeight.w600 : FontWeight.w400,
                            color: count > 0 ? k.fg : k.fgMuted)),
                  ],
                ),
                const SizedBox(height: 2),
                Text(label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 13, fontWeight: FontWeight.w600, color: k.fg)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// 떠 있는 새 메시지 버튼(S5c). 누르면 시트: 채널을 고르거나 사람을 골라 DM 을 연다.
class NewMessageButton extends StatelessWidget {
  const NewMessageButton({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return FloatingActionButton(
      key: const Key('new-message'),
      tooltip: t.newMessage,
      onPressed: () => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (_) => const NewMessageSheet(),
      ),
      child: const Icon(Icons.edit_outlined),
    );
  }
}

class NewMessageSheet extends StatefulWidget {
  const NewMessageSheet({super.key});

  @override
  State<NewMessageSheet> createState() => _NewMessageSheetState();
}

class _NewMessageSheetState extends State<NewMessageSheet> {
  bool _busy = false;

  void _push(NavigatorState nav, String channelId) {
    context.app.openChannel(channelId);
    nav.push(MaterialPageRoute<void>(builder: (_) => MessageListScreen(channelId: channelId)));
  }

  Future<void> _openDm(String accountId) async {
    if (_busy) return;
    setState(() => _busy = true);
    final app = context.app;
    final nav = Navigator.of(context);
    final messenger = ScaffoldMessenger.of(context);
    final failed = context.t.newMessageDmFailed;
    try {
      final id = await app.openDmWith(accountId);
      if (!mounted) return;
      nav.pop();
      // null: 커뮤니티가 바뀌었다 — 시트만 닫고 아무 데로도 가지 않는다.
      if (id != null) _push(nav, id);
    } catch (_) {
      if (!mounted) return;
      setState(() => _busy = false);
      messenger.showSnackBar(SnackBar(content: Text(failed), behavior: SnackBarBehavior.floating));
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final k = context.tokens;
    final channels = app.channels
        .where((c) => !c.isDm && app.channelPrefs[c.id]?.hidden != true)
        .toList(growable: false)
      ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    final people = app.accounts.values
        .where((a) => a.id != app.me?.id && !a.isDisabled)
        .toList(growable: false)
      ..sort((a, b) => a.handle.toLowerCase().compareTo(b.handle.toLowerCase()));
    Widget head(String text) => Padding(
          padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 12, HarkroomSize.gutter, 4),
          child: Text(text, style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: k.fgMuted)),
        );
    return SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * 0.7,
        child: AbsorbPointer(
          absorbing: _busy,
          child: ListView(
            key: const Key('new-message-sheet'),
            children: [
              head(t.sectionChannels),
              for (final c in channels)
                ListTile(
                  key: Key('new-message-channel-${c.id}'),
                  dense: true,
                  leading: Icon(c.isPrivate ? Icons.lock_outline : Icons.tag, size: 20),
                  title: Text(c.name),
                  onTap: () {
                    final nav = Navigator.of(context);
                    nav.pop();
                    _push(nav, c.id);
                  },
                ),
              head(t.newMessagePeople),
              for (final a in people)
                ListTile(
                  key: Key('new-message-person-${a.id}'),
                  dense: true,
                  leading: HarkroomAvatar(id: a.id, name: a.handle, size: 24),
                  title: Text(a.displayName.isNotEmpty ? a.displayName : a.handle),
                  subtitle: a.displayName.isNotEmpty && a.displayName != a.handle ? Text('@${a.handle}') : null,
                  onTap: () => _openDm(a.id),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

/// 그 사람과의 DM 을 열고(없으면 만들고) 그 화면으로 간다. 찾기 바로 가기·에이전트 탭이 쓴다.
///
/// 거듭 누르기와 커뮤니티 전환은 [AppState.openDmWith] 가 막는다(그때는 `null` → 아무것도 안 한다).
Future<void> openDmScreen(BuildContext context, String accountId) async {
  final app = context.app;
  final nav = Navigator.of(context);
  final messenger = ScaffoldMessenger.of(context);
  final failed = context.t.newMessageDmFailed;
  try {
    final id = await app.openDmWith(accountId);
    if (id == null) return;
    await app.openChannel(id);
    await nav.push(MaterialPageRoute<void>(builder: (_) => MessageListScreen(channelId: id)));
  } catch (_) {
    messenger.showSnackBar(SnackBar(content: Text(failed), behavior: SnackBarBehavior.floating));
  }
}
