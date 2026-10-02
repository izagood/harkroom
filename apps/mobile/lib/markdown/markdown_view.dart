import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../ui/tokens.dart';
import '../i18n/i18n.dart';
import 'markdown.dart';

/// 본문 속 `@handle`. 앞에 handle 글자가 오면 부름이 아니다(`a@b.io`). 원본 `HANDLE_PATTERN` 과 같은 폭.
final _mention = RegExp(r'(^|[^A-Za-z0-9_@-])@[A-Za-z0-9_-]{2,32}');

/// 본문을 마크다운으로 그린다. 메시지 줄이 쓴다.
///
/// 글자 크기·색은 토큰에서 온다(본문 15/1.5). 코드는 고정폭 + `surfaceSunken` 바탕, 인용은 왼쪽 선.
class MarkdownBody extends StatefulWidget {
  const MarkdownBody(this.source, {super.key, this.openLink, this.openMessage});

  final String source;

  /// 링크를 여는 길. 시험이 바꿔 끼운다. 기본은 **앱 밖 브라우저**다 — 앱 안 웹뷰로 열면 남이
  /// 건 페이지가 앱의 모양을 빌린다.
  final Future<void> Function(Uri uri)? openLink;

  /// `harkroom://message/<id>` 를 여는 길(앱 안 이동). **없으면 그 링크는 글자로만 남는다** — 눌러도
  /// 아무 일 없는 링크를 그리면 사람은 앱이 멈춘 줄 안다(데스크톱 `MessageBody` 의 같은 규율).
  final Future<void> Function(String messageId)? openMessage;

  @override
  State<MarkdownBody> createState() => _MarkdownBodyState();
}

class _MarkdownBodyState extends State<MarkdownBody> {
  /// 블록 위젯의 키. 같은 종류가 한 본문에 둘 이상 올 수 있으므로(표 둘·형제 목록 둘) **순번을
  /// 붙인다** — 같은 `Key('md-list')` 를 형제가 나눠 가지면 debug 빌드가 `Duplicate keys` 로
  /// 멈춘다(security #1060 N1). 시험은 [mdKind] 로 종류만 본다.
  var _keySeq = 0;
  Key _key(String kind) => ValueKey<(String, int)>((kind, _keySeq++));

  /// 링크마다 하나. **화면이 사라질 때 버린다** — 안 버리면 줄이 스크롤될 때마다 샌다.
  final _recognizers = <TapGestureRecognizer>[];

  @override
  void dispose() {
    for (final r in _recognizers) {
      r.dispose();
    }
    super.dispose();
  }

  Future<void> _open(MdLink link) async {
    // 앱 안 링크는 OS 를 거치지 않는다. 확인 시트도 없다 — 가는 곳이 이 앱의, 내가 볼 수 있는
    // 메시지뿐이고(서버가 403 으로 거른다) 밖으로 나가는 것이 없다.
    final messageId = link.messageId;
    if (messageId != null) {
      await widget.openMessage?.call(messageId);
      return;
    }
    // 열기 직전에 **한 번 더** 거른다 — 파서가 걸렀어도, 이 함수가 받는 것은 늘 http(s) 여야 한다.
    final safe = link.uri == null ? null : safeLinkUri(link.uri.toString());
    if (safe == null) return;
    // 보이는 글자와 실제 주소가 다를 수 있으면 **열기 전에 실제 주소를 보이고 묻는다.**
    if (linkNeedsConfirm(link)) {
      final ok = await showLinkConfirm(context, safe);
      if (ok != true || !mounted) return;
    }
    final open = widget.openLink ?? (u) => launchUrl(u, mode: LaunchMode.externalApplication);
    await open(safe);
  }

  @override
  Widget build(BuildContext context) {
    for (final r in _recognizers) {
      r.dispose();
    }
    _recognizers.clear();
    _keySeq = 0;

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
          _rich(text, base.copyWith(fontWeight: FontWeight.w600, fontSize: level <= 2 ? 16 : 15), k),
        MdCode(:final text) => Container(
            key: _key('md-code'),
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
            decoration: BoxDecoration(
              color: k.surfaceSunken,
              borderRadius: BorderRadius.circular(6),
              border: Border.all(color: k.border),
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
            key: _key('md-quote'),
            padding: const EdgeInsets.only(left: 10),
            decoration: BoxDecoration(border: Border(left: BorderSide(color: k.border, width: 3))),
            child: _rich(text, base.copyWith(color: k.fgMuted), k),
          ),
        MdList() => _list(b, base, k, 0),
        MdRule() => Container(
            key: _key('md-rule'),
            height: 1,
            margin: const EdgeInsets.symmetric(vertical: 4),
            color: k.border,
          ),
        MdTable() => _table(b, base, k),
      };

  /// 목록. 중첩 목록은 **항목 안에** 겹쳐 그린다 — 번호가 깊이마다 따로 세고, 글머리표 모양이
  /// 깊이를 말해 준다(• ◦ ▪).
  Widget _list(MdList list, TextStyle base, HarkroomTokens k, int depth) => Column(
        key: _key('md-list'),
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < list.items.length; i++)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: list.ordered ? 22 : 14,
                    child: Text(list.ordered ? '${list.start + i}.' : _bullets[depth % _bullets.length],
                        style: base.copyWith(color: k.fgMuted)),
                  ),
                  Expanded(
                    child: list.items[i].children.isEmpty
                        ? _rich(list.items[i].text, base, k)
                        : Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              _rich(list.items[i].text, base, k),
                              for (final c in list.items[i].children) _list(c, base, k, depth + 1),
                            ],
                          ),
                  ),
                ],
              ),
            ),
        ],
      );

  static const _bullets = ['•', '◦', '▪'];

  /// 표. 폰은 좁다 — 칸을 짓눌러 한 글자씩 접지 않고 **표 전체를 옆으로 민다**(코드 블록과 같다).
  /// 대신 칸 하나가 화면을 다 먹지 않게 폭에 상한을 두고, 그 안에서는 줄을 접는다.
  Widget _table(MdTable t, TextStyle base, HarkroomTokens k) {
    final cellStyle = base.copyWith(fontSize: 14, height: 1.35);
    TextAlign alignOf(int c) => switch (t.align[c]) {
          MdAlign.center => TextAlign.center,
          MdAlign.right => TextAlign.right,
          _ => TextAlign.left,
        };
    Widget cell(String text, int c, {bool head = false}) => ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 240),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
            child: _rich(text, head ? cellStyle.copyWith(fontWeight: FontWeight.w600) : cellStyle, k,
                align: alignOf(c)),
          ),
        );
    final grid = SingleChildScrollView(
      key: _key('md-table'),
      scrollDirection: Axis.horizontal,
      child: Table(
        defaultColumnWidth: const IntrinsicColumnWidth(),
        defaultVerticalAlignment: TableCellVerticalAlignment.top,
        border: TableBorder.all(color: k.border),
        children: [
          TableRow(
            decoration: BoxDecoration(color: k.surfaceSunken),
            children: [for (var c = 0; c < t.head.length; c++) cell(t.head[c], c, head: true)],
          ),
          for (final row in t.rows)
            TableRow(children: [for (var c = 0; c < row.length; c++) cell(row[c], c)]),
        ],
      ),
    );
    if (t.omittedRows == 0) return grid;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        grid,
        Padding(
          padding: const EdgeInsets.only(top: 4),
          child: Text(
            context.t.markdownTableMoreRows.replaceAll('{n}', '${t.omittedRows}'),
            key: _key('md-table-more'),
            style: TextStyle(fontSize: HarkroomType.meta, color: k.fgMuted),
          ),
        ),
      ],
    );
  }

  Widget _rich(String text, TextStyle base, HarkroomTokens k, {TextAlign align = TextAlign.start}) {
    final spans = <InlineSpan>[];
    for (final piece in parseInline(text)) {
      switch (piece) {
        case MdText(:final text, :final bold, :final italic, :final strike):
          final style = TextStyle(
            fontWeight: bold ? FontWeight.w600 : null,
            fontStyle: italic ? FontStyle.italic : null,
            decoration: strike ? TextDecoration.lineThrough : null,
          );
          // `@handle` 은 **칩**으로 — 사람을 부르는 말이 본문에 묻히면 "나를 불렀나"를 다시
          // 읽어야 한다(사양 3.3). 코드 안의 `@` 는 여기 오지 않는다(코드 조각은 따로다).
          var last = 0;
          for (final m in _mention.allMatches(text)) {
            final at = m.start + m.group(1)!.length;
            if (at > last) spans.add(TextSpan(text: text.substring(last, at), style: style));
            spans.add(TextSpan(
              text: text.substring(at, m.end),
              style: style.copyWith(
                color: k.link,
                backgroundColor: k.accentSurface,
                fontWeight: FontWeight.w600,
              ),
            ));
            last = m.end;
          }
          if (last < text.length) spans.add(TextSpan(text: text.substring(last), style: style));
        case MdInlineCode(:final text):
          spans.add(TextSpan(
            text: text,
            style: TextStyle(
              fontFamily: 'Menlo',
              fontFamilyFallback: const ['Courier'],
              fontSize: 13,
              color: k.accent,
              backgroundColor: k.surfaceRaised,
            ),
          ));
        case MdLink(:final text, :final uri, :final messageId):
          final openable = uri != null || (messageId != null && widget.openMessage != null);
          if (!openable) {
            // 열 수 없는 스킴: **글자만** 남긴다. 누를 수 있게 그리면 사람은 열린다고 믿는다.
            spans.add(TextSpan(text: text));
          } else {
            final r = TapGestureRecognizer()..onTap = () => _open(piece);
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
    return Text.rich(TextSpan(style: base, children: spans), textAlign: align);
  }
}

/// 블록 위젯 [key] 의 종류(`md-table`·`md-list`…). 그 밖의 키면 `null`.
String? mdKind(Key? key) => key is ValueKey<(String, int)> ? key.value.$1 : null;

/// 링크를 열기 전에 **실제 주소**를 보이고 묻는 시트. 호스트를 크게, 전체 주소를 작게 둔다 —
/// 사람이 확인할 것은 "어디로 가는가"이고, 그것은 호스트다.
Future<bool?> showLinkConfirm(BuildContext context, Uri uri) {
  final t = context.t;
  final k = context.tokens;
  return showModalBottomSheet<bool>(
    context: context,
    showDragHandle: true,
    builder: (ctx) => SafeArea(
      child: Padding(
        key: const Key('link-confirm'),
        padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 0, HarkroomSize.gutter, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(t.linkConfirmTitle, style: TextStyle(fontSize: HarkroomType.meta, color: k.fgMuted)),
            const SizedBox(height: 4),
            Text(uri.host,
                key: const Key('link-confirm-host'),
                style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600, color: k.fg)),
            const SizedBox(height: 4),
            SelectableText(uri.toString(), style: TextStyle(fontSize: HarkroomType.meta, color: k.fgMuted)),
            // 경고는 **해당하는 것마다 한 줄씩** — 둘 다 해당하는데 하나만 보이면 나머지 위험을 모른다.
            for (final (key, text) in [
              if (uri.userInfo.isNotEmpty) ('link-warn-userinfo', t.linkUserInfoWarning),
              if (hostLooksSpoofable(uri)) ('link-warn-nonascii', t.linkNonAsciiWarning),
            ]) ...[
              const SizedBox(height: 8),
              Container(
                key: Key(key),
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
                decoration: BoxDecoration(color: k.warningSurface, borderRadius: BorderRadius.circular(6)),
                child: Text(text, style: TextStyle(fontSize: HarkroomType.meta, color: k.warning)),
              ),
            ],
            const SizedBox(height: 12),
            Row(
              children: [
                Expanded(
                  child: TextButton(
                    key: const Key('link-cancel'),
                    onPressed: () => Navigator.of(ctx).pop(false),
                    child: Text(t.linkConfirmCancel),
                  ),
                ),
                const SizedBox(width: 8),
                // [열기] 는 **테두리 버튼**(개정판) — 확인을 묻는 자리에서 주황으로 칠하면 보지 않고
                // 누르게 된다.
                Expanded(
                  child: OutlinedButton(
                    key: const Key('link-open'),
                    onPressed: () => Navigator.of(ctx).pop(true),
                    child: Text(t.linkConfirmOpen, style: const TextStyle(fontWeight: FontWeight.w600)),
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
