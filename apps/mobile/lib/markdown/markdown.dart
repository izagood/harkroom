/// 메시지 본문의 **작은 마크다운**. 에이전트의 답이 코드 블록·목록·굵게로 쓰여서, 기호째
/// 흘리면 폰에서 제일 안 읽히는 글이 된다(designer 재설계 MM1).
///
/// ## 왜 패키지를 안 쓰나
///
/// 다루는 것이 적다 — 코드 블록·인라인 코드·목록·인용·굵게·기울임·링크·제목. 이 정도를
/// 위해 공개 저장소에 렌더러 의존성(그리고 그것이 끌고 오는 HTML·이미지 처리)을 들이면
/// 검토할 표면이 이 파일보다 커진다. 특히 **이미지·HTML 을 그리지 않는다는 것**을 우리가
/// 쥐고 있어야 한다: 남이 쓴 글이 폰에서 외부 이미지를 불러오면 그것이 곧 추적 픽셀이다.
///
/// ## 무엇을 하지 않나
///
/// 표·이미지·HTML·각주·중첩 목록(들여쓰기)은 **글자 그대로** 둔다. 반쯤 해석해서 원문을 잃는
/// 것보다 원문이 보이는 편이 낫다.
library;

/// 블록 하나.
sealed class MdBlock {
  const MdBlock();
}

class MdParagraph extends MdBlock {
  const MdParagraph(this.text);
  final String text;
}

class MdHeading extends MdBlock {
  const MdHeading(this.level, this.text);
  final int level;
  final String text;
}

/// 펜스 코드 블록. **안의 글은 해석하지 않는다**(멘션·링크·굵게 모두 글자 그대로).
class MdCode extends MdBlock {
  const MdCode(this.text, {this.language});
  final String text;
  final String? language;
}

class MdQuote extends MdBlock {
  const MdQuote(this.text);
  final String text;
}

class MdList extends MdBlock {
  const MdList(this.items, {required this.ordered, this.start = 1});
  final List<String> items;
  final bool ordered;
  final int start;
}

final _fence = RegExp(r'^\s*(```|~~~)\s*([\w+-]*)\s*$');
final _heading = RegExp(r'^(#{1,6})\s+(.*)$');
final _bullet = RegExp(r'^\s*[-*+]\s+(.*)$');
final _ordered = RegExp(r'^\s*(\d{1,9})[.)]\s+(.*)$');
final _quote = RegExp(r'^\s*>\s?(.*)$');

/// 본문을 블록으로 나눈다. 줄 단위로 한 번 훑는다.
List<MdBlock> parseMarkdown(String source) {
  final lines = source.replaceAll('\r\n', '\n').split('\n');
  final out = <MdBlock>[];
  final para = <String>[];

  void flushPara() {
    if (para.isEmpty) return;
    out.add(MdParagraph(para.join('\n')));
    para.clear();
  }

  var i = 0;
  while (i < lines.length) {
    final line = lines[i];

    final fence = _fence.firstMatch(line);
    if (fence != null) {
      flushPara();
      final marker = fence.group(1)!;
      final lang = fence.group(2);
      final body = <String>[];
      i++;
      // 닫는 펜스가 없으면 **끝까지가 코드**다(CommonMark 와 같다). 에이전트가 답을 쓰다 만
      // 경우에도 아래 글이 갑자기 굵게·링크로 바뀌지 않는다.
      while (i < lines.length && lines[i].trim() != marker) {
        body.add(lines[i]);
        i++;
      }
      out.add(MdCode(body.join('\n'), language: (lang == null || lang.isEmpty) ? null : lang));
      i++;
      continue;
    }

    if (line.trim().isEmpty) {
      flushPara();
      i++;
      continue;
    }

    final h = _heading.firstMatch(line);
    if (h != null) {
      flushPara();
      out.add(MdHeading(h.group(1)!.length, h.group(2)!.trim()));
      i++;
      continue;
    }

    if (_quote.hasMatch(line)) {
      flushPara();
      final body = <String>[];
      while (i < lines.length && _quote.hasMatch(lines[i])) {
        body.add(_quote.firstMatch(lines[i])!.group(1)!);
        i++;
      }
      out.add(MdQuote(body.join('\n')));
      continue;
    }

    final b = _bullet.firstMatch(line);
    final o = _ordered.firstMatch(line);
    if (b != null || o != null) {
      flushPara();
      final ordered = o != null;
      final start = ordered ? int.tryParse(o.group(1)!) ?? 1 : 1;
      final items = <String>[];
      while (i < lines.length) {
        final bm = _bullet.firstMatch(lines[i]);
        final om = _ordered.firstMatch(lines[i]);
        final m = ordered ? om : bm;
        if (m != null) {
          items.add(ordered ? m.group(2)! : m.group(1)!);
          i++;
          continue;
        }
        // 들여 쓴 이어지는 줄은 앞 항목에 붙인다(빈 줄·다른 블록이면 목록이 끝난다).
        if (items.isNotEmpty && lines[i].startsWith(RegExp(r'\s{2,}')) && lines[i].trim().isNotEmpty) {
          items[items.length - 1] = '${items.last}\n${lines[i].trim()}';
          i++;
          continue;
        }
        break;
      }
      out.add(MdList(items, ordered: ordered, start: start));
      continue;
    }

    para.add(line);
    i++;
  }
  flushPara();
  return out;
}

/// 인라인 조각.
sealed class MdInline {
  const MdInline();
}

class MdText extends MdInline {
  const MdText(this.text, {this.bold = false, this.italic = false});
  final String text;
  final bool bold;
  final bool italic;
}

class MdInlineCode extends MdInline {
  const MdInlineCode(this.text);
  final String text;
}

/// 링크. [uri] 가 `null` 이면 **열 수 없는 링크**다(http(s) 가 아니다) — 글자만 보이고 누를 수 없다.
class MdLink extends MdInline {
  const MdLink(this.text, this.uri);
  final String text;
  final Uri? uri;
}

/// 열어도 되는 주소인가. **http·https 만** 연다 — `javascript:`·`file:`·`tel:`·앱 스킴은
/// 남이 쓴 글이 폰에서 무엇을 실행하게 하는 길이다. 호스트가 없는 것도 막는다.
Uri? safeLinkUri(String raw) {
  final uri = Uri.tryParse(raw.trim());
  if (uri == null) return null;
  final scheme = uri.scheme.toLowerCase();
  if (scheme != 'http' && scheme != 'https') return null;
  if (uri.host.isEmpty) return null;
  return uri;
}

// 순서가 뜻이다: 코드가 먼저 — 코드 안의 `**` 나 `[...]` 는 서식이 아니다.
final _inline = RegExp(
  r'`([^`\n]+)`'
  r'|\[([^\]\n]+)\]\(([^)\s]+)\)'
  r'|\*\*([^*\n]+)\*\*'
  r'|__([^_\n]+)__'
  r'|(?<![\w*])\*([^*\n]+)\*(?![\w*])'
  r'|(https?://[^\s<>()\[\]]+[^\s<>()\[\].,;:!?"\x27])',
);

/// 한 단락을 인라인 조각으로 나눈다.
List<MdInline> parseInline(String text) {
  final out = <MdInline>[];
  var last = 0;
  for (final m in _inline.allMatches(text)) {
    if (m.start > last) out.add(MdText(text.substring(last, m.start)));
    if (m.group(1) != null) {
      out.add(MdInlineCode(m.group(1)!));
    } else if (m.group(2) != null) {
      out.add(MdLink(m.group(2)!, safeLinkUri(m.group(3)!)));
    } else if (m.group(4) != null || m.group(5) != null) {
      out.add(MdText(m.group(4) ?? m.group(5)!, bold: true));
    } else if (m.group(6) != null) {
      out.add(MdText(m.group(6)!, italic: true));
    } else if (m.group(7) != null) {
      out.add(MdLink(m.group(7)!, safeLinkUri(m.group(7)!)));
    }
    last = m.end;
  }
  if (last < text.length) out.add(MdText(text.substring(last)));
  return out;
}
