import 'package:flutter/material.dart';

import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import 'parts.dart';
import 'tokens.dart';

/// 상태 셋(읽는 중·비어 있음·못 읽음)과 실패를 그리는 부품(재설계 §3.9).
///
/// 화면마다 따로 지으면 같은 상태가 화면마다 다른 말이 된다 — 채널은 "없다", 인박스는
/// "비어 있다", 스레드는 아무것도 안 그리는 식으로. 한 벌을 두고 문구만 바꾼다.

/// 읽는 중. **메시지 모양의 자리표시**다 — 회전자 하나보다 "곧 여기에 말이 선다"가 읽힌다.
class LoadingSkeleton extends StatelessWidget {
  const LoadingSkeleton({super.key, this.rows = 4});

  final int rows;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final t = context.t;
    Widget bar(double factor) => FractionallySizedBox(
          widthFactor: factor,
          alignment: Alignment.centerLeft,
          child: Container(
            height: 10,
            decoration: BoxDecoration(color: k.soft, borderRadius: BorderRadius.circular(5)),
          ),
        );
    const widths = [(0.35, 0.9), (0.28, 0.7), (0.4, 0.82), (0.3, 0.6)];
    return Semantics(
      key: const Key('state-loading'),
      label: t.commonLoading,
      child: ExcludeSemantics(
        child: ListView.separated(
          padding: const EdgeInsets.all(HarkroomSize.gutter),
          physics: const NeverScrollableScrollPhysics(),
          itemCount: rows,
          separatorBuilder: (_, _) => const SizedBox(height: 16),
          itemBuilder: (_, i) {
            final (a, b) = widths[i % widths.length];
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  width: HarkroomSize.avatar,
                  height: HarkroomSize.avatar,
                  decoration: BoxDecoration(
                    color: k.soft,
                    borderRadius: BorderRadius.circular(HarkroomSize.avatarRadius),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [bar(a), const SizedBox(height: 8), bar(b)],
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// 비어 있음. 무엇이 비었는지 한 줄, 할 일이 있으면 그 아래 한 줄.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.title, this.hint});

  final String title;
  final String? hint;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    return Center(
      key: const Key('state-empty'),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(title,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: k.fg)),
            if (hint != null) ...[
              const SizedBox(height: 6),
              Text(hint!,
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: HarkroomType.meta, color: k.mute)),
            ],
          ],
        ),
      ),
    );
  }
}

/// 못 읽음. 무엇을 못 읽었는지 + **다시 시도**. 다시 시도가 없으면 사람이 할 수 있는 일이
/// 앱을 껐다 켜는 것뿐이다.
class FailedState extends StatelessWidget {
  const FailedState({
    super.key,
    required this.title,
    required this.onRetry,
    this.cause = LoadFailure.network,
    this.detail,
  });

  final String title;
  final VoidCallback onRetry;

  /// 못 읽은 까닭. 안내 한 줄이 이것으로 갈린다.
  final LoadFailure cause;

  /// 제목 아래 작게 덧붙일 것(부팅 실패의 서버 주소). 주소를 잘못 넣은 경우 그것이 원인이다.
  final String? detail;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final t = context.t;
    return Center(
      key: const Key('state-failed'),
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(title,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600, color: k.fg)),
            if (detail != null) ...[
              const SizedBox(height: 4),
              Text(detail!,
                  key: const Key('state-failed-detail'),
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: HarkroomType.meta, color: k.mute)),
            ],
            const SizedBox(height: 6),
            Text(
                switch (cause) {
                  LoadFailure.network => t.loadFailedHint,
                  LoadFailure.server => t.loadFailedServer,
                  LoadFailure.forbidden => t.loadFailedForbidden,
                },
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: HarkroomType.meta, color: k.mute)),
            const SizedBox(height: 14),
            OutlinedButton(
              key: const Key('state-retry'),
              onPressed: onRetry,
              child: Text(t.commonRetry),
            ),
          ],
        ),
      ),
    );
  }
}

/// 끊김 띠. **모든 화면의 머리 바로 아래**에 같은 것을 둔다 — 한 화면에만 있으면 다른
/// 화면에서는 "조용한 채널"과 "죽은 앱"이 같아 보인다.
///
/// 붙어 있으면 아무것도 그리지 않는다. 처음 붙는 중(`connecting`)도 그리지 않는다 — 앱을 켤
/// 때마다 노란 띠가 깜빡이면 띠가 곧 안 보이는 것이 되고, 정작 끊겼을 때도 안 읽힌다.
class ConnectionBand extends StatelessWidget {
  const ConnectionBand({super.key});

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final t = context.t;
    return switch (app.connection) {
      SocketState.online || SocketState.connecting => const SizedBox.shrink(),
      // 기다리면 낫는다. "다시"는 백오프를 건너뛰고 지금 붙어 본다.
      SocketState.reconnecting => StatusBand(
          key: const Key('connection-band'),
          text: t.connectionLostBand,
          actionLabel: t.connectionRetryNow,
          onAction: app.reconnectNow,
        ),
      // 기다려도 낫지 않는다 — 자격증명이 죽었다. 할 일은 다시 로그인뿐이다.
      SocketState.dead => StatusBand(
          key: const Key('connection-band'),
          tone: BandTone.error,
          text: t.connectionDead,
          actionLabel: t.connectionSignInAgain,
          onAction: app.signOut,
        ),
    };
  }
}

/// 보내지 못한 말 한 줄. **목록 안에, 보낸 자리에** 선다 — 작성칸 위 토스트로 띄우면 몇 초
/// 뒤 사라지고, 무엇이 안 갔는지를 사람이 기억해야 한다.
class FailedSendRow extends StatelessWidget {
  const FailedSendRow({super.key, required this.item});

  final FailedSend item;

  @override
  Widget build(BuildContext context) {
    final k = context.tokens;
    final t = context.t;
    final app = context.app;
    final me = app.me;
    return Container(
      key: Key('failed-${item.localId}'),
      margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
      padding: const EdgeInsets.fromLTRB(8, 8, 4, 4),
      decoration: BoxDecoration(color: k.errSoft, borderRadius: BorderRadius.circular(8)),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          HarkroomAvatar(id: me?.id ?? '', name: me?.handle ?? '?'),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(t.sendFailed,
                    style: TextStyle(
                        fontSize: HarkroomType.meta, fontWeight: FontWeight.w600, color: k.err)),
                const SizedBox(height: 2),
                Text(item.body,
                    style: TextStyle(
                        fontSize: HarkroomType.body, height: HarkroomType.bodyHeight, color: k.fg)),
                Row(
                  children: [
                    TextButton(
                      key: Key('resend-${item.localId}'),
                      onPressed: item.retrying ? null : () => app.resend(item),
                      style: TextButton.styleFrom(foregroundColor: k.err),
                      child: Text(item.retrying ? t.sending : t.resend),
                    ),
                    TextButton(
                      key: Key('discard-${item.localId}'),
                      onPressed: item.retrying ? null : () => app.discardFailed(item),
                      style: TextButton.styleFrom(foregroundColor: k.mute),
                      child: Text(t.discard),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// 보내기 버튼. **첨부가 올라가는 동안은 잠기고 진행 원이 된다** — 전에는 그때 눌러도
/// 작성칸이 먼저 비워지고 보내기는 조용히 멈춰서, 친 글이 사라졌다.
class SendButton extends StatelessWidget {
  const SendButton({
    super.key,
    required this.composerKey,
    required this.busy,
    required this.onPressed,
    this.empty = false,
  });

  final String composerKey;
  final bool busy;

  /// 보낼 글이 없다 — 버튼을 흐리게(soft) 둔다. 눌러도 아무 일이 없는데 주황이면 눌러 보게 된다.
  final bool empty;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final t = context.t;
    final uploading = app.isUploading(composerKey);
    if (uploading) {
      return IconButton(
        tooltip: t.sendWaitsForUpload,
        style: sendButtonStyle(context),
        onPressed: null,
        icon: const SizedBox(
          width: 20,
          height: 20,
          child: CircularProgressIndicator(strokeWidth: 2),
        ),
      );
    }
    return IconButton(
      tooltip: t.composerSend,
      style: sendButtonStyle(context),
      icon: const Icon(Icons.send, size: 20),
      onPressed: busy || empty ? null : onPressed,
    );
  }
}

/// 실패를 잠깐 알리는 토스트(ask 답·리액션처럼 줄 안에 남길 자리가 없는 것). **다시 시도**를
/// 단다 — "실패했다"만 말하면 사람은 같은 버튼을 다시 찾아 눌러야 한다.
void showFailureToast(BuildContext context, String text, {VoidCallback? retry}) {
  final t = context.t;
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(
    content: Text(text),
    action: retry == null ? null : SnackBarAction(label: t.commonRetry, onPressed: retry),
  ));
}
