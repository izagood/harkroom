import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';

import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';

/// 작성칸에 붙여 둔 첨부와, 파일을 고르는 버튼.
///
/// ## 고르자마자 올린다
///
/// 보낼 때 몰아서 올리면 보내기 버튼이 몇 초씩 멈추고, 그 동안 실패하면 사람은 **친 글까지
/// 잃는다.** 미리 올려 두면 보내기는 id 만 싣는다 — 서버가 "업로드가 메시지보다 먼저
/// 존재한다"로 설계한 이유와 같은 방향이다.
class ComposerAttachments extends StatelessWidget {
  const ComposerAttachments({super.key, required this.composerKey});

  /// 채널 id 또는 스레드 루트 id. **둘이 따로여야** 채널에서 고른 사진이 스레드 답글에
  /// 딸려 가지 않는다.
  final String composerKey;

  @override
  Widget build(BuildContext context) {
    final app = context.app;
    final items = app.pending[composerKey] ?? const <PendingAttachment>[];
    if (items.isEmpty) return const SizedBox.shrink();

    return SizedBox(
      key: const Key('composer-attachments'),
      height: 56,
      child: ListView.builder(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        itemCount: items.length,
        itemBuilder: (context, i) {
          final item = items[i];
          final uploading = item.attachment == null;
          return Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
            child: InputChip(
              key: Key('pending-${item.filename}'),
              avatar: uploading
                  ? SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        // 총 길이를 모르면 `progress` 가 0 에 머문다 — 그때는 **길이 없는
                        // 회전자**로 둔다. 0% 에 멈춘 막대는 "멈췄다"로 읽힌다.
                        value: item.progress > 0 ? item.progress : null,
                      ),
                    )
                  : const Icon(Icons.attach_file, size: 16),
              label: Text(item.filename, overflow: TextOverflow.ellipsis),
              // 올리는 중에도 뗄 수 있다 — 잘못 고른 것을 기다리게 하지 않는다.
              onDeleted: () => app.detach(composerKey, item),
            ),
          );
        },
      ),
    );
  }
}

/// 파일을 고르는 버튼.
class AttachButton extends StatelessWidget {
  const AttachButton({super.key, required this.composerKey});

  final String composerKey;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return IconButton(
      key: const Key('attach'),
      tooltip: t.attachmentAdd,
      icon: const Icon(Icons.add_photo_alternate_outlined),
      onPressed: () => _pick(context),
    );
  }

  Future<void> _pick(BuildContext context) async {
    final app = context.app;
    final messenger = ScaffoldMessenger.of(context);
    final t = context.t;

    // 취소하면 **빈 목록**이다(`null` 이 아니다 — file_picker 13 에서 바뀌었다).
    final picked = await FilePicker.pickFiles();
    if (picked.isEmpty) return;

    for (final f in picked) {
      try {
        // `readAsBytes` 로 받는다. iOS 의 사진 라이브러리 항목은 경로만으로는 앱이 못
        // 읽는 자리에 있을 수 있어서, 플러그인이 대신 읽어 주는 이 통로를 쓴다.
        final bytes = await f.readAsBytes();
        await app.attach(composerKey, PendingAttachment(filename: f.name), bytes);
      } on Object {
        // **조용히 지나가지 않는다.** 칩이 사라진 이유를 사람이 알아야 한다.
        messenger.showSnackBar(SnackBar(content: Text(t.attachmentUploadFailed)));
      }
    }
  }
}
