import 'package:flutter/material.dart';

import '../api/api_error.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../ui/states.dart';
import 'thread_screen.dart';

/// 본문의 `harkroom://message/<id>` 를 눌렀을 때 **앱 안에서** 그 메시지로 간다.
///
/// 가는 곳은 늘 **스레드 화면**이다 — 답글이면 그 스레드, 최상위 글이면 그 글을 루트로 한 스레드.
/// 데스크톱은 최상위 글이면 채널 타임라인을 그 자리로 굴려 강조하지만, 모바일 채널 화면은 아직
/// 특정 자리로 가는 길(around 창)이 없다 — 채널만 열면 옛 글은 화면 밖에 있고 사람은 링크가
/// 안 된 줄 안다. 스레드 화면은 루트를 맨 위에 그리므로 그 글이 바로 보인다.
///
/// 실패는 **반드시 보인다**(데스크톱 `openMessage` 와 같은 세 갈래·같은 말). 조용히 삼키면 사람은
/// 링크가 죽었다고 본다. 이 링크에는 커뮤니티가 적혀 있지 않다(shared `parseMessagePermalink` 주석) —
/// 다른 커뮤니티의 링크는 지금 서버에 없으므로 404 로 "없다"가 된다. 데스크톱과 같다.
Future<void> openMessageLink(BuildContext context, String messageId) async {
  // [다시 시도] 는 토스트가 남은 사이 화면이 닫힌 뒤에도 눌릴 수 있다.
  if (!context.mounted) return;
  final app = AppScope.read(context);
  final t = context.t;
  final navigator = Navigator.of(context);
  final row = await () async {
    try {
      return await app.locateMessage(messageId);
    } on ApiError catch (e) {
      if (context.mounted) {
        showFailureToast(
          context,
          e.status == 404
              ? t.messageLinkGone
              : e.status == 403
                  ? t.messageLinkForbidden
                  : t.messageLinkFailed,
          retry: e.status == 404 || e.status == 403 ? null : () => openMessageLink(context, messageId),
        );
      }
    } on Object {
      // 닿지 못했다 — 기다리면 나을 수 있으니 [다시 시도] 를 단다.
      if (context.mounted) {
        showFailureToast(context, t.messageLinkFailed, retry: () => openMessageLink(context, messageId));
      }
    }
    return null;
  }();
  if (row == null || !context.mounted) return;
  await app.openChannel(row.channelId);
  if (!context.mounted) return;
  await navigator.push(MaterialPageRoute<void>(
    builder: (_) => ThreadScreen(channelId: row.channelId, rootId: row.threadRootId ?? row.id),
  ));
}
