import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../ui/states.dart';
import '../ui/parts.dart';
import '../ui/tokens.dart';
import 'community_screens.dart';
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
    if (dms) {
      items.addAll(rows);
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
            Expanded(
              child: rows.isEmpty
                  ? Center(child: Text(dms ? t.dmsEmpty : t.channelsEmpty))
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
        fontWeight: unread ? FontWeight.w700 : FontWeight.w400,
        color: unread ? k.fg : k.mute,
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
      tooltip: context.t.tabMe,
      onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const MeScreen())),
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
          decoration: BoxDecoration(border: Border(top: BorderSide(color: k.line))),
          child: Row(
            children: [
              Icon(icon, size: 15, color: k.mute),
              const SizedBox(width: 6),
              Expanded(
                child: Text(title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(fontSize: 12, fontWeight: FontWeight.w600, color: k.fg)),
              ),
              Icon(collapsed ? Icons.expand_more : Icons.expand_less, size: 18, color: k.mute),
            ],
          ),
        ),
      ),
    );
  }
}
