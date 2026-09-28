import 'package:flutter/material.dart';

import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
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
        // 연결 상태를 **제목 줄에 둔다.** 메시지가 안 오는 것과 소켓이 끊긴 것을 사람이
        // 구별할 수 있어야 한다 — 구별할 수 없으면 "조용한 채널"과 "죽은 앱"이 같아 보인다.
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(22),
          child: _ConnectionLine(state: app.connection),
        ),
        actions: [
          IconButton(
            key: const Key('sign-out'),
            tooltip: t.signOut,
            icon: const Icon(Icons.logout),
            onPressed: () => app.signOut(),
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (app.noticeKey != null) _Notice(messageKey: app.noticeKey!),
            Expanded(
              child: app.channels.isEmpty
                  ? Center(child: Text(t.channelsEmpty))
                  : ListView.builder(
                      itemCount: app.channels.length,
                      itemBuilder: (context, i) {
                        final channel = app.channels[i];
                        return ListTile(
                          // 글자로 줄을 집지 않는다 — 이름은 번역되고 바뀐다.
                          key: Key('channel-${channel.id}'),
                          leading: Icon(channel.isDm
                              ? Icons.alternate_email
                              : channel.isPrivate
                                  ? Icons.lock_outline
                                  : Icons.tag),
                          title: Text(channel.name),
                          subtitle: channel.topic == null ? null : Text(channel.topic!),
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

/// 소켓 상태 한 줄. **끊김을 한 가지로 뭉치지 않는다** — 기다리면 낫는 것과 다시
/// 로그인해야 하는 것은 사람이 할 일이 다르다.
class _ConnectionLine extends StatelessWidget {
  const _ConnectionLine({required this.state});

  final SocketState state;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final scheme = Theme.of(context).colorScheme;
    final (String label, Color color) = switch (state) {
      SocketState.online => (t.connectionOnline, scheme.primary),
      SocketState.connecting => (t.connectionConnecting, scheme.outline),
      SocketState.reconnecting => (t.connectionReconnecting, scheme.tertiary),
      SocketState.dead => (t.connectionDead, scheme.error),
    };
    // 붙어 있는 것은 **기본 상태**다. 늘 띄워 두면 그 줄은 곧 안 보이는 것이 되고,
    // 정작 끊겼을 때의 같은 줄도 안 읽힌다.
    if (state == SocketState.online) return const SizedBox(height: 0);
    return Container(
      key: const Key('connection-line'),
      width: double.infinity,
      padding: const EdgeInsets.only(bottom: 4),
      alignment: Alignment.center,
      child: Text(label, style: TextStyle(color: color, fontSize: 12)),
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
    return Material(
      color: Theme.of(context).colorScheme.errorContainer,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 8, 12),
        child: Row(
          children: [
            Expanded(child: Text(text, key: const Key('notice-text'))),
            IconButton(
              icon: const Icon(Icons.close),
              onPressed: () => context.app.clearNotice(),
            ),
          ],
        ),
      ),
    );
  }
}
