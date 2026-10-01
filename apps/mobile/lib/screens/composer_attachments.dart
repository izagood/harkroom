import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';
import 'attach_pickers.dart';

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

/// 첨부를 고르는 버튼. 누르면 [사진 보관함 / 사진 찍기 / 파일 선택] 시트가 뜬다.
///
/// 예전에는 버튼이 곧장 `pickFiles()` 를 불렀고, 그 기본값(`FileType.any`)은 iOS 에서
/// **파일 앱**을 열었다 — 사진 아이콘을 눌렀는데 사진 보관함도 카메라도 없었다.
/// 순서는 iOS Safari 의 파일 입력 시트를 따른다(사람들이 이미 아는 배치다).
class AttachButton extends StatelessWidget {
  const AttachButton({
    super.key,
    required this.composerKey,
    this.pickers = const PlatformAttachPickers(),
    this.onPicked,
    this.openSettings,
    this.now = DateTime.now,
  });

  final String composerKey;

  /// 시험에서 가짜로 바꾼다.
  final AttachPickers pickers;

  /// 고른 것을 받는 곳. 없으면 `app.attach`(고르자마자 올린다).
  final Future<void> Function(String filename, Uint8List bytes)? onPicked;

  /// 카메라 거절 시트의 [설정 열기]. 없으면 `app-settings:` 를 연다.
  final Future<void> Function()? openSettings;

  /// 카메라 사진 이름(`photo-YYYYMMDD-HHMMSS.jpg`)의 시각.
  final DateTime Function() now;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    return IconButton(
      key: const Key('attach'),
      tooltip: t.attachmentAdd,
      icon: const Icon(Icons.add_circle_outline),
      onPressed: () => _open(context),
    );
  }

  Future<void> _open(BuildContext context) async {
    final t = context.t;
    final messenger = ScaffoldMessenger.of(context);
    // await 뒤에는 context 를 쓰지 않는다 — 토스트 여백(작성칸 위)도 미리 잰다.
    final margin = toastMargin(context);
    final deliver = onPicked ??
        (String name, Uint8List bytes) {
          final app = context.app;
          return app.attach(composerKey, PendingAttachment(filename: name), bytes);
        };

    final hasCamera = await pickers.hasCamera();
    if (!context.mounted) return;
    final choice = await _showAttachSheet(context, hasCamera: hasCamera);
    // 시트는 이미 닫혔다(항목을 누르면 먼저 닫고 picker 를 연다).
    switch (choice) {
      case null:
        return;
      case _AttachChoice.library:
        final picked = await pickers.library();
        for (final f in picked) {
          await _deliver(messenger, t, margin, () async {
            final bytes = await f.read();
            await deliver(libraryFilename(f.name, bytes), bytes);
          });
        }
      case _AttachChoice.camera:
        final PickedAttachment? shot;
        try {
          shot = await pickers.camera();
        } on PlatformException catch (e) {
          if (e.code == 'camera_access_denied' && context.mounted) {
            await _showCameraDenied(context, openSettings ?? _openAppSettings);
          } else {
            messenger.showSnackBar(SnackBar(
              content: Text(t.cameraOpenFailed),
              behavior: SnackBarBehavior.floating,
              margin: margin,
            ));
          }
          return;
        }
        if (shot == null) return;
        final name = cameraFilename(now());
        await _deliver(messenger, t, margin, () async => deliver(name, await shot!.read()));
      case _AttachChoice.file:
        final picked = await pickers.files();
        for (final f in picked) {
          await _deliver(messenger, t, margin, () async => deliver(f.name, await f.read()));
        }
    }
  }

  Future<void> _deliver(
    ScaffoldMessengerState messenger,
    Strings t,
    EdgeInsets margin,
    Future<void> Function() run,
  ) async {
    try {
      await run();
    } on Object {
      // **조용히 지나가지 않는다.** 칩이 사라진 이유를 사람이 알아야 한다.
      messenger.showSnackBar(SnackBar(
        content: Text(t.attachmentUploadFailed),
        behavior: SnackBarBehavior.floating,
        margin: margin,
      ));
    }
  }
}

Future<void> _openAppSettings() async {
  await launchUrl(Uri.parse('app-settings:'));
}

enum _AttachChoice { library, camera, file }

/// 손잡이 있는 하단 시트. 제목과 [취소] 줄은 없다 — 손잡이를 내리거나 바깥을 누르면 닫힌다.
Future<_AttachChoice?> _showAttachSheet(BuildContext context, {required bool hasCamera}) {
  final t = context.t;
  final k = context.tokens;
  Widget row(_AttachChoice c, IconData icon, String label, String key, {bool enabled = true, String? note}) {
    return ListTile(
      key: Key(key),
      enabled: enabled,
      minTileHeight: 52,
      leading: Icon(icon),
      title: Text(label),
      subtitle: note == null ? null : Text(note, style: TextStyle(fontSize: HarkroomType.meta, color: k.mute)),
      // 비활성이면 누르면 아무 일도 없다.
      onTap: enabled ? () => Navigator.of(context).pop(c) : null,
    );
  }

  return showModalBottomSheet<_AttachChoice>(
    context: context,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: Column(
        key: const Key('attach-sheet'),
        mainAxisSize: MainAxisSize.min,
        children: [
          row(_AttachChoice.library, Icons.photo_library_outlined, t.attachLibrary, 'attach-library'),
          row(_AttachChoice.camera, Icons.photo_camera_outlined, t.attachCamera, 'attach-camera',
              enabled: hasCamera, note: hasCamera ? null : t.attachCameraUnavailable),
          row(_AttachChoice.file, Icons.insert_drive_file_outlined, t.attachFile, 'attach-file'),
          const SizedBox(height: 8),
        ],
      ),
    ),
  );
}

/// 카메라 권한이 꺼졌을 때. 링크 확인 시트와 같은 꼴이다. 처음 한 번은 iOS 시스템 프롬프트만
/// 뜨고, 앱이 미리 설명 화면을 띄우지 않는다 — 이 시트는 **이미 거절된 뒤**에만 뜬다.
Future<void> _showCameraDenied(BuildContext context, Future<void> Function() openSettings) {
  final t = context.t;
  final k = context.tokens;
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: Padding(
        key: const Key('camera-denied'),
        padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 0, HarkroomSize.gutter, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(t.cameraDeniedTitle,
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700, color: k.fg)),
            const SizedBox(height: 4),
            Text(t.cameraDeniedBody, style: TextStyle(fontSize: HarkroomType.meta, color: k.mute)),
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    key: const Key('camera-denied-close'),
                    onPressed: () => Navigator.of(ctx).pop(),
                    child: Text(t.cameraDeniedClose),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: FilledButton(
                    key: const Key('camera-denied-settings'),
                    onPressed: () {
                      Navigator.of(ctx).pop();
                      openSettings();
                    },
                    child: Text(t.cameraDeniedOpenSettings),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    ),
  );
}
