import 'package:flutter/material.dart';

import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../ui/states.dart';
import '../ui/parts.dart';
import '../ui/tokens.dart';
import 'message_list_screen.dart';

/// 채널 목록. 폰의 루트 화면이고, 여기서 채널을 **밀어 넣어** 연다(옆 패널이 아니다).
class ChannelListScreen extends StatelessWidget {
  const ChannelListScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;

    return Scaffold(
      appBar: AppBar(
        title: Text(t.channelsTitle),
      ),
      body: SafeArea(
        child: Column(
          children: [
            // 끊김은 **모든 화면 공통 띠**다(제목 줄 아래 작은 회색 글씨였다 — 늘 22px 를 차지했고
            // 끊겼을 때도 잘 안 읽혔다).
            const ConnectionBand(),
            if (app.noticeKey != null) _Notice(messageKey: app.noticeKey!),
            Expanded(
              child: app.channels.isEmpty
                  ? Center(child: Text(t.channelsEmpty))
                  : ListView.builder(
                      itemCount: app.channels.length,
                      itemBuilder: (context, i) {
                        final channel = app.channels[i];
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
