import 'package:flutter/material.dart';

import '../api/models.dart';
import '../i18n/i18n.dart';
import '../state/app_scope.dart';

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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (final a in attachments)
          Padding(
            padding: const EdgeInsets.only(top: 6),
            child: canPreview(a) ? _Preview(attachment: a) : _FileRow(attachment: a),
          ),
      ],
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
      appBar: AppBar(title: Text(attachment.filename)),
      body: Center(
        child: api == null
            ? Text(t.attachmentFailed)
            : InteractiveViewer(
                child: Image.network(
                  api.attachmentUrl(attachment.id),
                  headers: api.authHeaders,
                  errorBuilder: (context, error, stack) => Text(t.attachmentFailed),
                ),
              ),
      ),
    );
  }
}
