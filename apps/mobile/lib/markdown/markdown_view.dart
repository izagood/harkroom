import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../ui/tokens.dart';
import 'markdown.dart';

/// 본문을 마크다운으로 그린다. 메시지 줄이 쓴다.
///
/// 글자 크기·색은 토큰에서 온다(본문 15/1.4). 코드는 고정폭 + `soft` 바탕, 인용은 왼쪽 선.
class MarkdownBody extends StatefulWidget {
  const MarkdownBody(this.source, {super.key, this.openLink});

  final String source;

  /// 링크를 여는 길. 시험이 바꿔 끼운다. 기본은 **앱 밖 브라우저**다 — 앱 안 웹뷰로 열면 남이
  /// 건 페이지가 앱의 모양을 빌린다.
  final Future<void> Function(Uri uri)? openLink;

  @override
  State<MarkdownBody> createState() => _MarkdownBodyState();
}

class _MarkdownBodyState extends State<MarkdownBody> {
  /// 링크마다 하나. **화면이 사라질 때 버린다** — 안 버리면 줄이 스크롤될 때마다 샌다.
  final _recognizers = <TapGestureRecognizer>[];

  @override
  void dispose() {
    for (final r in _recognizers) {
      r.dispose();
    }
    super.dispose();
  }

  Future<void> _open(Uri uri) async {
    // 열기 직전에 **한 번 더** 거른다 — 파서가 걸렀어도, 이 함수가 받는 것은 늘 http(s) 여야 한다.
    final safe = safeLinkUri(uri.toString());
    if (safe == null) return;
    final open = widget.openLink ?? (u) => launchUrl(u, mode: LaunchMode.externalApplication);
    await open(safe);
  }

  @override
  Widget build(BuildContext context) {
    for (final r in _recognizers) {
      r.dispose();
    }
    _recognizers.clear();

    final k = context.tokens;
    final base = TextStyle(fontSize: HarkroomType.body, height: HarkroomType.bodyHeight, color: k.fg);
    final blocks = parseMarkdown(widget.source);
    final children = <Widget>[];
    for (final b in blocks) {
      if (children.isNotEmpty) children.add(const SizedBox(height: 6));
      children.add(_block(context, b, base, k));
    }
    if (children.length == 1) return children.single;
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: children);
  }

  Widget _block(BuildContext context, MdBlock b, TextStyle base, HarkroomTokens k) => switch (b) {
        MdParagraph(:final text) => _rich(text, base, k),
        MdHeading(:final level, :final text) =>
          _rich(text, base.copyWith(fontWeight: FontWeight.w700, fontSize: level <= 2 ? 16 : 15), k),
        MdCode(:final text) => Container(
            key: const Key('md-code'),
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              color: k.soft,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: k.line),
            ),
            // 긴 줄은 **접지 않고 옆으로 민다** — 코드를 접으면 들여쓰기의 뜻이 사라진다.
            child: SingleChildScrollView(
              scrollDirection: Axis.horizontal,
              child: SelectableText(
                text,
                style: TextStyle(
                    fontFamily: 'Menlo', fontFamilyFallback: const ['Courier'],
                    fontSize: 13, height: 1.4, color: k.fg),
              ),
            ),
          ),
        MdQuote(:final text) => Container(
            key: const Key('md-quote'),
            padding: const EdgeInsets.only(left: 10),
            decoration: BoxDecoration(border: Border(left: BorderSide(color: k.line, width: 3))),
            child: _rich(text, base.copyWith(color: k.mute), k),
          ),
        MdList(:final items, :final ordered, :final start) => Column(
            key: const Key('md-list'),
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              for (var i = 0; i < items.length; i++)
                Padding(
                  padding: const EdgeInsets.only(top: 2),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      SizedBox(
                        width: ordered ? 22 : 14,
                        child: Text(ordered ? '${start + i}.' : '•', style: base.copyWith(color: k.mute)),
                      ),
                      Expanded(child: _rich(items[i], base, k)),
                    ],
                  ),
                ),
            ],
          ),
      };

  Widget _rich(String text, TextStyle base, HarkroomTokens k) {
    final spans = <InlineSpan>[];
    for (final piece in parseInline(text)) {
      switch (piece) {
        case MdText(:final text, :final bold, :final italic):
          spans.add(TextSpan(
            text: text,
            style: TextStyle(
              fontWeight: bold ? FontWeight.w700 : null,
              fontStyle: italic ? FontStyle.italic : null,
            ),
          ));
        case MdInlineCode(:final text):
          spans.add(TextSpan(
            text: text,
            style: TextStyle(
              fontFamily: 'Menlo',
              fontFamilyFallback: const ['Courier'],
              fontSize: 13,
              color: k.accent,
              backgroundColor: k.soft,
            ),
          ));
        case MdLink(:final text, :final uri):
          if (uri == null) {
            // 열 수 없는 스킴: **글자만** 남긴다. 누를 수 있게 그리면 사람은 열린다고 믿는다.
            spans.add(TextSpan(text: text));
          } else {
            final r = TapGestureRecognizer()..onTap = () => _open(uri);
            _recognizers.add(r);
            spans.add(TextSpan(
              text: text,
              recognizer: r,
              style: TextStyle(color: k.link, decoration: TextDecoration.underline),
              semanticsLabel: text,
            ));
          }
      }
    }
    return Text.rich(TextSpan(style: base, children: spans));
  }
}
