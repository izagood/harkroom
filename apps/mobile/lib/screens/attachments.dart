import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import '../time.dart';
import 'artifact_preview.dart';
import 'message_link.dart';
import '../ui/tokens.dart';

/// 그림 넘겨 보기의 **범위**(designer 사양 1·5, 2026-10-02) — 그림을 연 화면이 준다.
/// 채널 화면은 최상위 글(+채널에도 올린 답글), 스레드 화면은 루트와 답글이다. 없으면 그 그림 한 장만 본다.
class GallerySource extends InheritedWidget {
  const GallerySource({super.key, required this.messages, required super.child});

  /// 열 때 **한 번** 부른다 — 열려 있는 동안 새 글이 와도 순서가 흔들리지 않는다.
  final List<MessageRow> Function() messages;

  static GallerySource? maybeOf(BuildContext context) => context.getInheritedWidgetOfExactType<GallerySource>();

  @override
  bool updateShouldNotify(GallerySource oldWidget) => false;
}

class GalleryItem {
  const GalleryItem(this.attachment, this.message);
  final AttachmentRow attachment;

  /// 글을 모르는 자리에서 열면 null — 머리줄 아랫줄과 [글로 가기]를 그리지 않는다.
  final MessageRow? message;
}

/// 넘겨 볼 그림. 글은 seq 순, 한 글 안에서는 첨부 순서. 미리 볼 수 있는 그림만 넣고 미리보기 카드의 표지는 뺀다.
List<GalleryItem> collectGallery(Iterable<MessageRow> messages) {
  final sorted = [...messages]..sort((a, b) => a.seq.compareTo(b.seq));
  return [
    for (final m in sorted)
      for (final a in m.attachments)
        if (a.artifact == null &&
            AttachmentStrip.canPreview(a) &&
            !m.attachments.any((c) => c.artifact?.coverAttachmentId == a.id))
          GalleryItem(a, m),
  ];
}

/// 메시지에 달린 첨부.
///
/// ## 토큰을 URL 에 싣지 않는다
///
/// 첨부는 인증이 필요하다. 쿼리에 토큰을 넣는 쪽이 쉽지만 그 주소는 **로그·캐시·공유에
/// 그대로 남는다.** 그래서 `Image.network` 에 헤더를 넘긴다.
///
/// ## 미리 보이는 것은 이미지뿐
///
/// 데스크탑도 화이트리스트를 한 곳에 두고 그 밖은 안 편다. 여기서는 `contentType` 이
/// `image/` 로 시작하는 것만이고, **SVG 는 이미지가 아니다** — 스크립트를 품을 수 있어
/// 미리보기의 대상이 아니라는 것이 데스크탑의 판단이고, 같은 선을 여기서도 지킨다.
class AttachmentStrip extends StatelessWidget {
  const AttachmentStrip({super.key, required this.attachments, this.message});

  final List<AttachmentRow> attachments;

  /// 이 첨부가 달린 글. 있으면 크게 보기에서 같은 화면의 그림을 넘겨 본다.
  final MessageRow? message;

  static bool canPreview(AttachmentRow a) =>
      a.isImage && a.contentType.toLowerCase() != 'image/svg+xml';

  @override
  Widget build(BuildContext context) {
    if (attachments.isEmpty) return const SizedBox.shrink();
    // 미리보기의 표지는 카드 안에 그린다 — 따로 그림으로 한 번 더 보이면 같은 것이 두 번이다.
    final covers = {for (final a in attachments) if (a.artifact?.coverAttachmentId != null) a.artifact!.coverAttachmentId!};
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final a in attachments)
          if (!covers.contains(a.id))
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: a.artifact != null
                  ? ArtifactCard(
                      attachment: a,
                      cover: attachments.where((c) => c.id == a.artifact!.coverAttachmentId).firstOrNull,
                    )
                  : canPreview(a)
                      ? _Preview(attachment: a, message: message)
                      : _FileRow(attachment: a),
            ),
      ],
    );
  }
}

/// 같은 미리보기의 **알려진 가장 높은 버전**. 서버의 `latestVersion` 은 목록을 읽은 순간 값이라 새 버전 글이
/// 실시간으로 와도 옛 글의 값은 그대로다 — 그래서 지금 메모리에 있는 채널·스레드 글을 함께 본다.
int latestKnownVersion(Iterable<List<MessageRow>> lists, ArtifactRef ref) {
  var best = ref.latestVersion;
  for (final list in lists) {
    for (final m in list) {
      for (final a in m.attachments) {
        final r = a.artifact;
        if (r != null && r.artifactId == ref.artifactId && r.version > best) best = r.version;
      }
    }
  }
  return best;
}

/// 미리보기(아티팩트) 카드(⑤, designer d8ca47be). **목록 안에서 페이지를 띄우지 않는다** — 축소 WebView 를
/// 깔면 스크롤할 때마다 스크립트가 돌고 폰이 무거워진다. 카드 전체가 누르는 자리다. 표지는 같은 글의 그림
/// 첨부이고, SVG 는 [AttachmentStrip.canPreview] 가 거른다(security). 없으면 그림 칸 없이 글 카드로 그린다.
class ArtifactCard extends StatelessWidget {
  const ArtifactCard({super.key, required this.attachment, this.cover});

  final AttachmentRow attachment;
  final AttachmentRow? cover;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final ref = attachment.artifact!;
    final latest = latestKnownVersion([...app.messages.values, ...app.threads.values], ref);
    final api = app.api;
    final coverOk = cover != null && AttachmentStrip.canPreview(cover!) && api != null;
    final theme = Theme.of(context);
    final version = ref.version > 1
        ? t.artifactVersionWithPrev.replaceAll('{v}', '${ref.version}').replaceAll('{prev}', '${ref.version - 1}')
        : t.artifactVersion.replaceAll('{v}', '${ref.version}');
    return Semantics(
      button: true,
      label: '${t.artifactOpen} ${ref.title}',
      child: InkWell(
        key: Key('artifact-card-${attachment.id}'),
        borderRadius: BorderRadius.circular(HarkroomRadius.card),
        onTap: () => openArtifactPreview(context, attachment),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 448),
          child: DecoratedBox(
            decoration: BoxDecoration(
              border: Border.all(color: theme.dividerColor),
              borderRadius: BorderRadius.circular(HarkroomRadius.card),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (coverOk)
                  ClipRRect(
                    borderRadius: const BorderRadius.vertical(top: Radius.circular(HarkroomRadius.card)),
                    child: AspectRatio(
                      aspectRatio: 16 / 9,
                      child: Image.network(
                        api.attachmentUrl(cover!.id),
                        key: const Key('artifact-card-cover'),
                        headers: api.authHeaders,
                        fit: BoxFit.cover,
                        // 표지를 못 받으면 칸을 비워 두지 않는다 — 글 카드만 남긴다.
                        errorBuilder: (context, error, stack) => const SizedBox.shrink(),
                      ),
                    ),
                  ),
                Padding(
                  padding: const EdgeInsets.all(10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(ref.title,
                                style: theme.textTheme.titleSmall, overflow: TextOverflow.ellipsis),
                          ),
                          const SizedBox(width: 6),
                          Text(version, style: theme.textTheme.bodySmall),
                        ],
                      ),
                      if (latest > ref.version)
                        Padding(
                          padding: const EdgeInsets.only(top: 4),
                          child: Container(
                            key: const Key('artifact-card-latest'),
                            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                            decoration: BoxDecoration(
                              border: Border.all(color: theme.dividerColor),
                              borderRadius: BorderRadius.circular(HarkroomRadius.full),
                            ),
                            child: Text(t.artifactLatest.replaceAll('{v}', '$latest'),
                                style: theme.textTheme.labelSmall),
                          ),
                        ),
                      if (ref.summary != null)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(ref.summary!,
                              style: theme.textTheme.bodySmall, maxLines: 2, overflow: TextOverflow.ellipsis),
                        ),
                      Padding(
                        padding: const EdgeInsets.only(top: 2),
                        child: Text('HTML · ${formatBytes(attachment.byteSize)}', style: theme.textTheme.labelSmall),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _Preview extends StatelessWidget {
  const _Preview({required this.attachment, this.message});

  final AttachmentRow attachment;
  final MessageRow? message;

  void _open(BuildContext context) {
    final m = message;
    final source = GallerySource.maybeOf(context);
    var items = <GalleryItem>[];
    var start = -1;
    if (m != null && source != null) {
      items = collectGallery(source.messages());
      start = items.indexWhere((it) => it.attachment.id == attachment.id);
    }
    if (start < 0) {
      items = [GalleryItem(attachment, m)];
      start = 0;
    }
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => ImageGallery(
        items: items,
        start: start,
        // [글로 가기] 는 **이 화면의 context** 로 연다 — 갤러리는 그 전에 닫힌다.
        onGoTo: m == null ? null : (id) => openMessageLink(context, id),
      ),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final api = context.app.api;
    if (api == null) return _FileRow(attachment: attachment);

    return GestureDetector(
      key: Key('attachment-preview-${attachment.id}'),
      onTap: () => _open(context),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(HarkroomRadius.card),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxHeight: 220),
          child: Image.network(
            api.attachmentUrl(attachment.id),
            headers: api.authHeaders,
            fit: BoxFit.cover,
            // **조용히 빈칸을 두지 않는다.** 못 불러온 것과 아직 안 온 것은 다르고,
            // 사람은 그 둘을 구별할 수 있어야 한다.
            errorBuilder: (context, error, stack) => _Failed(text: t.attachmentFailed),
          ),
        ),
      ),
    );
  }
}

class _FileRow extends StatelessWidget {
  const _FileRow({required this.attachment});

  final AttachmentRow attachment;

  @override
  Widget build(BuildContext context) {
    return Row(
      key: Key('attachment-file-${attachment.id}'),
      mainAxisSize: MainAxisSize.min,
      children: [
        const Icon(Icons.attach_file, size: 16),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            attachment.filename,
            style: Theme.of(context).textTheme.bodySmall,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
  }
}

class _Failed extends StatelessWidget {
  const _Failed({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.all(8),
        child: Text(text, style: Theme.of(context).textTheme.bodySmall),
      );
}

/// 크게 보기 + 넘겨 보기(designer 사양 5, 2026-10-02). 핀치 확대까지만 한다 — 편집도 공유도 이 단계의 일이 아니다.
///
/// - 좌우 스와이프로 같은 화면의 그림을 넘긴다(`PageView`). **확대 중(배율 > 1)이면 넘기지 않는다** — 그 스와이프는
///   그림을 움직이는 것이다. 맞춤으로 돌아오면(더블탭) 다시 넘긴다.
/// - 끝에서 멈춘다. 새 장은 맞춤으로 연다(장마다 따로 사는 `ImageViewport`). 이웃(±1)은 미리 받는다.
class ImageGallery extends StatefulWidget {
  const ImageGallery({super.key, required this.items, required this.start, this.onGoTo});

  final List<GalleryItem> items;
  final int start;
  final void Function(String messageId)? onGoTo;

  @override
  State<ImageGallery> createState() => _ImageGalleryState();
}

class _ImageGalleryState extends State<ImageGallery> {
  late final PageController _pages = PageController(initialPage: widget.start);
  late int _index = widget.start;
  bool _zoomed = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _precacheAround(_index);
  }

  @override
  void dispose() {
    _pages.dispose();
    super.dispose();
  }

  ImageProvider? _image(int i) {
    final api = context.app.api;
    if (api == null || i < 0 || i >= widget.items.length) return null;
    return NetworkImage(api.attachmentUrl(widget.items[i].attachment.id), headers: api.authHeaders);
  }

  void _precacheAround(int i) {
    for (final n in [i - 1, i + 1]) {
      final img = _image(n);
      // 못 받아도 조용히 둔다 — 그 장에 가면 장 자체가 실패를 말한다.
      if (img != null) precacheImage(img, context, onError: (_, _) {});
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final app = context.app;
    final item = widget.items[_index];
    final total = widget.items.length;
    final m = item.message;
    final sender = m == null ? null : (app.accounts[m.authorId]?.handle ?? app.displayNameOf(m.authorId));
    return Scaffold(
      // 레터박스는 검정이다. 흰 바탕 스크린샷이 흰 여백에 섞여 그림 끝이 안 보이지 않게.
      backgroundColor: Colors.black,
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(total > 1 ? '${_index + 1} / $total' : item.attachment.filename,
                key: const Key('gallery-title')),
            if (m != null && sender != null)
              Text('$sender · ${agoLabel(m.createdAt, DateTime.now().toUtc(), t)}',
                  key: const Key('gallery-subtitle'), style: Theme.of(context).textTheme.bodySmall),
          ],
        ),
        actions: [
          if (m != null && widget.onGoTo != null)
            PopupMenuButton<String>(
              key: const Key('gallery-menu'),
              onSelected: (_) {
                Navigator.of(context).pop();
                widget.onGoTo!(m.id);
              },
              itemBuilder: (_) => [
                PopupMenuItem(value: 'goto', key: const Key('gallery-goto'), child: Text(t.attachmentGoToMessage)),
              ],
            ),
        ],
      ),
      body: _image(_index) == null
          ? Center(child: Text(t.attachmentFailed, style: const TextStyle(color: Colors.white)))
          : PageView.builder(
              key: const Key('gallery-pages'),
              controller: _pages,
              itemCount: total,
              physics: _zoomed ? const NeverScrollableScrollPhysics() : const PageScrollPhysics(),
              onPageChanged: (i) {
                setState(() {
                  _index = i;
                  _zoomed = false;
                });
                _precacheAround(i);
              },
              itemBuilder: (context, i) => ImageViewport(
                key: ValueKey(widget.items[i].attachment.id),
                image: _image(i)!,
                errorText: t.attachmentFailed,
                onZoomChanged: i == _index ? (z) { if (z != _zoomed) setState(() => _zoomed = z); } : null,
              ),
            ),
    );
  }
}

/// 세로로 **많이** 긴 그림인가 — 높이/폭이 화면 높이/폭의 1.5배를 넘는다(designer 3192efed 6).
///
/// 그런 그림(HTML 시안 전체 캡처 같은 것)을 통째로 맞추면 화면 높이에 줄어 폭이 손가락 하나가 되고 글자가 안
/// 읽힌다. 그래서 폭에 맞추고 세로로 움직이게 한다. 나머지 그림은 지금처럼 통째로 맞춘다.
bool isTallImage(Size image, Size view) {
  if (image.width <= 0 || view.width <= 0 || view.height <= 0) return false;
  return image.height / image.width > (view.height / view.width) * 1.5;
}

/// 이미지를 본문 영역에 **맞춰(contain)** 띄우고 핀치로 키운다.
///
/// 크기를 이미지에게 맡기지 않는다. 예전에는 `Center > InteractiveViewer > Image`
/// 로 fit 없이 두어 그림 크기가 이미지의 고유 크기와 느슨한 제약의 셈에 달려 있었다.
/// 여기서는 본문 크기 그대로의 칸을 만들고 `BoxFit.scaleDown` 으로 그 안에 넣는다 —
/// 가로로 긴 것도 세로로 긴 것도 처음에는 통째로 보이고, 남는 쪽은 띠로 남는다.
/// 칸보다 작은 이미지는 **키우지 않는다** — 늘리면 뭉개져 깨진 것처럼 읽힌다.
/// 더 보고 싶으면 핀치로 키운다. 맞춤보다 작게 오므리는 것은 쓸모가 없어 막는다.
///
/// **예외 — 세로로 많이 긴 그림**([isTallImage])은 폭에 맞추고 맨 위부터 세로로 움직인다. 더블탭은
/// 맞춤 ↔ 2배다(누른 자리를 중심으로).
class ImageViewport extends StatefulWidget {
  const ImageViewport({super.key, required this.image, required this.errorText, this.onZoomChanged});

  final ImageProvider image;
  final String errorText;

  /// 맞춤보다 커졌는가(true)·맞춤으로 돌아왔는가(false). 넘겨 보기가 스와이프를 넘김으로 쓸지 정한다.
  final ValueChanged<bool>? onZoomChanged;

  @override
  State<ImageViewport> createState() => _ImageViewportState();
}

class _ImageViewportState extends State<ImageViewport> {
  Size? _size;
  ImageStream? _stream;
  late final ImageStreamListener _listener = ImageStreamListener((info, _) {
    if (!mounted) return;
    setState(() => _size = Size(info.image.width.toDouble(), info.image.height.toDouble()));
  }, onError: (_, _) {});
  late final TransformationController _tc = TransformationController()..addListener(_onTransform);
  Offset _doubleTapAt = Offset.zero;
  bool _zoomed = false;

  void _onTransform() {
    final z = _tc.value.getMaxScaleOnAxis() > 1.01;
    if (z == _zoomed) return;
    _zoomed = z;
    widget.onZoomChanged?.call(z);
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final stream = widget.image.resolve(createLocalImageConfiguration(context));
    if (stream.key != _stream?.key) {
      _stream?.removeListener(_listener);
      _stream = stream..addListener(_listener);
    }
  }

  @override
  void dispose() {
    _stream?.removeListener(_listener);
    _tc.dispose();
    super.dispose();
  }

  void _toggleZoom() {
    if (_tc.value.getMaxScaleOnAxis() > 1.01) {
      _tc.value = Matrix4.identity();
      return;
    }
    // 누른 자리가 그 자리에 남게 2배로.
    final p = _doubleTapAt;
    _tc.value = Matrix4.identity()
      ..translateByDouble(-p.dx, -p.dy, 0, 1)
      ..scaleByDouble(2, 2, 1, 1);
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, box) {
        final size = _size;
        if (size != null && isTallImage(size, box.biggest)) {
          final width = box.maxWidth;
          final height = width * size.height / size.width;
          return GestureDetector(
            onDoubleTapDown: (d) => _doubleTapAt = d.localPosition,
            onDoubleTap: _toggleZoom,
            child: InteractiveViewer(
              key: const Key('attachment-tall-viewport'),
              transformationController: _tc,
              constrained: false,
              minScale: 1,
              maxScale: 6,
              child: SizedBox(
                width: width,
                height: height,
                child: Image(
                  key: const Key('attachment-fullscreen-image'),
                  image: widget.image,
                  fit: BoxFit.fill,
                  errorBuilder: (context, error, stack) =>
                      Center(child: Text(widget.errorText, style: const TextStyle(color: Colors.white))),
                ),
              ),
            ),
          );
        }
        return InteractiveViewer(
          transformationController: _tc,
          minScale: 1,
          maxScale: 6,
          child: SizedBox(
            width: box.maxWidth,
            height: box.maxHeight,
            child: Image(
              key: const Key('attachment-fullscreen-image'),
              image: widget.image,
              fit: BoxFit.scaleDown,
              errorBuilder: (context, error, stack) =>
                  Center(child: Text(widget.errorText, style: const TextStyle(color: Colors.white))),
            ),
          ),
        );
      },
    );
  }
}
