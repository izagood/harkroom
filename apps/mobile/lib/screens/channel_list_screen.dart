import 'package:flutter/material.dart';

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
    final rows = app.channels.where((c) => c.isDm == dms).toList(growable: false);

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
                      itemCount: rows.length,
                      itemBuilder: (context, i) {
                        final channel = rows[i];
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
