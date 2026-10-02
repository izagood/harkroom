import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../state/app_state.dart';
import '../ui/states.dart';
import '../ui/tokens.dart';
import 'artifact_preview.dart' show formatBytes;
import 'attach_pickers.dart';
import 'attachments.dart' show ImageViewport;

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

    // 줄 높이 86 — 64 타일 위·오른쪽으로 × 의 누르는 영역(44)이 반 걸칠 자리다(designer 시안 84 + 2).
    return SizedBox(
      key: const Key('composer-attachments'),
      height: 86,
      child: ListView.builder(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 8),
        itemCount: items.length,
        itemBuilder: (context, i) => _PendingTile(
          item: items[i],
          onRemove: () => app.detach(composerKey, items[i]),
          onOpen: () => _openViewer(context, items, items[i], (item) => app.detach(composerKey, item)),
        ),
      ),
    );
  }
}

/// 작성칸의 첨부 한 칸. **그림은 64×64 타일, 그림이 아닌 것은 같은 높이의 파일 카드**다
/// (designer 시안 24878e97, jaebin D4: 캡션 없음 — 이름은 탭해서 전체 화면에서 본다).
/// 예전에는 클립 아이콘과 파일명 칩뿐이라, 사진 보관함에서 고른 `IMG_0001.jpg` 가 무엇인지
/// 보내기 전에 확인할 길이 없었다.
///
/// × 는 22pt 원이고 누르는 영역은 44pt 다 — 터치에는 호버가 없어 늘 보인다.
class _PendingTile extends StatelessWidget {
  const _PendingTile({required this.item, required this.onRemove, required this.onOpen});

  final PendingAttachment item;
  final VoidCallback onRemove;
  final VoidCallback onOpen;

  static const double _tile = 64;
  static const double _hit = 44;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final uploading = item.attachment == null;
    final preview = item.preview;
    // 총 길이를 모르면 `progress` 가 0 에 머문다 — 그때는 **길이 없는 회전자**로 둔다.
    // 0% 에 멈춘 막대는 "멈췄다"로 읽힌다.
    final spinner = SizedBox(
      width: 24,
      height: 24,
      child: CircularProgressIndicator(strokeWidth: 2.5, value: item.progress > 0 ? item.progress : null),
    );

    final Widget body;
    final double width;
    if (preview != null) {
      width = _tile;
      body = Semantics(
        button: true,
        label: item.filename,
        child: GestureDetector(
          key: Key('pending-open-${item.filename}'),
          onTap: onOpen,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(8),
            child: Stack(
              fit: StackFit.expand,
              children: [
                Opacity(
                  opacity: uploading ? 0.5 : 1,
                  child: Image.memory(
                    preview,
                    key: Key('pending-thumb-${item.filename}'),
                    fit: BoxFit.cover,
                    // 64pt × 3배 — 고른 원본(수 MB)을 그대로 풀면 타일 하나가 메모리를 수십 MB 먹는다.
                    cacheWidth: 192,
                    gaplessPlayback: true,
                    errorBuilder: (context, error, stack) =>
                        ColoredBox(color: k.soft, child: Icon(Icons.image_not_supported_outlined, color: k.mute)),
                  ),
                ),
                if (uploading) Center(child: spinner),
              ],
            ),
          ),
        ),
      );
    } else {
      width = 168;
      body = Container(
        key: Key('pending-file-${item.filename}'),
        padding: const EdgeInsets.symmetric(horizontal: 10),
        decoration: BoxDecoration(
          color: k.soft,
          border: Border.all(color: k.line),
          borderRadius: BorderRadius.circular(8),
        ),
        child: Row(
          children: [
            if (uploading) spinner else Icon(Icons.insert_drive_file_outlined, color: k.mute),
            const SizedBox(width: 8),
            Expanded(
              child: Column(
                mainAxisAlignment: MainAxisAlignment.center,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(item.filename,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(fontSize: HarkroomType.meta, fontWeight: FontWeight.w600, color: k.fg)),
                  if (item.byteSize != null)
                    Text(formatBytes(item.byteSize!), style: TextStyle(fontSize: HarkroomType.meta, color: k.mute)),
                ],
              ),
            ),
          ],
        ),
      );
    }

    // 바깥 칸은 타일 + 누르는 영역 반쪽(22)이다 — 칸 밖으로 삐져나온 영역은 눌리지 않는다.
    return SizedBox(
      key: Key('pending-${item.filename}'),
      width: width + _hit / 2,
      height: _tile + _hit / 2,
      child: Stack(
        children: [
          Positioned(left: 0, bottom: 0, width: width, height: _tile, child: body),
          Positioned(
            right: 0,
            top: 0,
            width: _hit,
            height: _hit,
            child: Semantics(
              button: true,
              label: t.attachmentRemoveNamed(item.filename),
              child: GestureDetector(
                key: Key('pending-remove-${item.filename}'),
                behavior: HitTestBehavior.opaque,
                // 올리는 중에도 뗄 수 있다 — 잘못 고른 것을 기다리게 하지 않는다.
                onTap: onRemove,
                child: Center(
                  child: Container(
                    width: 22,
                    height: 22,
                    decoration: BoxDecoration(
                      color: k.ink,
                      shape: BoxShape.circle,
                      border: Border.all(color: k.bg, width: 1.5),
                    ),
                    child: Icon(Icons.close, size: 14, color: k.bg),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// 그림 타일을 누르면 여는 전체 화면 보기. 보낸 첨부의 뷰어(#1044 [ImageViewport])를 그대로 쓴다.
/// 이름은 위, 크기·n/전체·[첨부에서 빼기]는 아래 — 타일에 캡션을 달지 않은 대신 여기서 확인한다.
void _openViewer(
  BuildContext context,
  List<PendingAttachment> items,
  PendingAttachment start,
  void Function(PendingAttachment) remove,
) {
  // 그림만 넘긴다 — 파일 카드는 펼칠 그림이 없다. 목록은 **연 순간의 사본**이다.
  final images = [for (final p in items) if (p.preview != null) p];
  final index = images.indexOf(start);
  if (index < 0) return;
  Navigator.of(context).push(MaterialPageRoute<void>(
    builder: (_) => PendingViewer(items: images, initialIndex: index, onRemove: remove),
  ));
}

/// 작성칸에 붙인 그림의 전체 화면 보기. 좌우로 넘긴다.
class PendingViewer extends StatefulWidget {
  const PendingViewer({super.key, required this.items, required this.initialIndex, required this.onRemove});

  final List<PendingAttachment> items;
  final int initialIndex;
  final void Function(PendingAttachment) onRemove;

  @override
  State<PendingViewer> createState() => _PendingViewerState();
}

class _PendingViewerState extends State<PendingViewer> {
  late final PageController _pages = PageController(initialPage: widget.initialIndex);
  late final List<PendingAttachment> _items = [...widget.items];
  late int _index = widget.initialIndex;

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  void _remove() {
    final item = _items[_index];
    widget.onRemove(item);
    // 마지막 한 장을 빼면 볼 것이 없다 — 작성칸으로 돌아간다.
    if (_items.length == 1) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _items.removeAt(_index);
      if (_index >= _items.length) _index = _items.length - 1;
    });
    _pages.jumpToPage(_index);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final item = _items[_index];
    const white = TextStyle(color: Colors.white);
    return Scaffold(
      key: const Key('pending-viewer'),
      // 레터박스는 검정이다 — 보낸 첨부의 뷰어와 같다.
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(item.filename, overflow: TextOverflow.ellipsis),
      ),
      body: PageView.builder(
        controller: _pages,
        itemCount: _items.length,
        onPageChanged: (i) => setState(() => _index = i),
        itemBuilder: (context, i) => ImageViewport(
          image: MemoryImage(_items[i].preview!),
          errorText: t.attachmentFailed,
        ),
      ),
      bottomNavigationBar: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 4, 8, 4),
          child: Row(
            children: [
              if (item.byteSize != null) Text(formatBytes(item.byteSize!), style: white),
              const SizedBox(width: 12),
              Text('${_index + 1}/${_items.length}', key: const Key('pending-viewer-count'), style: white),
              const Spacer(),
              TextButton(
                key: const Key('pending-viewer-remove'),
                onPressed: _remove,
                child: Text(t.attachmentRemove),
              ),
            ],
          ),
        ),
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
