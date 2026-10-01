import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';
import 'artifact_preview.dart';

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
  const AttachmentStrip({super.key, required this.attachments});

  final List<AttachmentRow> attachments;

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
                      ? _Preview(attachment: a)
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
        borderRadius: BorderRadius.circular(8),
        onTap: () => openArtifactPreview(context, attachment),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 448),
          child: DecoratedBox(
            decoration: BoxDecoration(
              border: Border.all(color: theme.dividerColor),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                if (coverOk)
                  ClipRRect(
                    borderRadius: const BorderRadius.vertical(top: Radius.circular(8)),
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
                              borderRadius: BorderRadius.circular(999),
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
  const _Preview({required this.attachment});

  final AttachmentRow attachment;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final api = context.app.api;
    if (api == null) return _FileRow(attachment: attachment);

    return GestureDetector(
      key: Key('attachment-preview-${attachment.id}'),
      onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(
        builder: (_) => _FullScreen(attachment: attachment),
      )),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(8),
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

/// 크게 보기. 핀치 확대까지만 한다 — 편집도 공유도 이 단계의 일이 아니다.
class _FullScreen extends StatelessWidget {
  const _FullScreen({required this.attachment});

  final AttachmentRow attachment;

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final api = context.app.api;
    return Scaffold(
      // 레터박스는 검정이다. 흰 바탕 스크린샷이 흰 여백에 섞여 그림 끝이 안 보이지 않게.
      backgroundColor: Colors.black,
      appBar: AppBar(title: Text(attachment.filename)),
      body: api == null
          ? Center(child: Text(t.attachmentFailed, style: const TextStyle(color: Colors.white)))
          : ImageViewport(
              image: NetworkImage(api.attachmentUrl(attachment.id), headers: api.authHeaders),
              errorText: t.attachmentFailed,
            ),
    );
  }
}

/// 이미지를 본문 영역에 **맞춰(contain)** 띄우고 핀치로 키운다.
///
/// 크기를 이미지에게 맡기지 않는다. 예전에는 `Center > InteractiveViewer > Image`
/// 로 fit 없이 두어 그림 크기가 이미지의 고유 크기와 느슨한 제약의 셈에 달려 있었다.
/// 여기서는 본문 크기 그대로의 칸을 만들고 `BoxFit.scaleDown` 으로 그 안에 넣는다 —
/// 가로로 긴 것도 세로로 긴 것도 처음에는 통째로 보이고, 남는 쪽은 띠로 남는다.
/// 칸보다 작은 이미지는 **키우지 않는다** — 늘리면 뭉개져 깨진 것처럼 읽힌다.
/// 더 보고 싶으면 핀치로 키운다. 맞춤보다 작게 오므리는 것은 쓸모가 없어 막는다.
class ImageViewport extends StatelessWidget {
  const ImageViewport({super.key, required this.image, required this.errorText});

  final ImageProvider image;
  final String errorText;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, box) => InteractiveViewer(
        minScale: 1,
        maxScale: 6,
        child: SizedBox(
          width: box.maxWidth,
          height: box.maxHeight,
          child: Image(
            key: const Key('attachment-fullscreen-image'),
            image: image,
            fit: BoxFit.scaleDown,
            errorBuilder: (context, error, stack) =>
                Center(child: Text(errorText, style: const TextStyle(color: Colors.white))),
          ),
        ),
      ),
    );
  }
}
