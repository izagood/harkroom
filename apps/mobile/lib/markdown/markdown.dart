/// 메시지 본문의 **작은 마크다운**. 에이전트의 답이 코드 블록·목록·굵게로 쓰여서, 기호째
/// 흘리면 폰에서 제일 안 읽히는 글이 된다(designer 재설계 MM1).
///
/// ## 왜 패키지를 안 쓰나
///
/// 다루는 것이 적다 — 코드 블록·인라인 코드·목록(중첩 포함)·인용·표·구분선·굵게·기울임·
/// 취소선·링크·제목. 이 정도를
/// 위해 공개 저장소에 렌더러 의존성(그리고 그것이 끌고 오는 HTML·이미지 처리)을 들이면
/// 검토할 표면이 이 파일보다 커진다. 특히 **이미지·HTML 을 그리지 않는다는 것**을 우리가
/// 쥐고 있어야 한다: 남이 쓴 글이 폰에서 외부 이미지를 불러오면 그것이 곧 추적 픽셀이다.
///
/// ## 무엇을 하지 않나
///
/// 이미지·HTML·각주는 **글자 그대로** 둔다. 반쯤 해석해서 원문을 잃는 것보다 원문이 보이는
/// 편이 낫다.
///
/// ## 데스크톱과 같은 규칙
///
/// 표·중첩 목록·구분선·취소선은 데스크톱(`packages/desktop/src/lib/markdown.ts`)의 판정을 그대로
/// 옮겼다 — 같은 글이 폰과 데스크톱에서 다른 모양이 되면 사람은 "어느 쪽이 깨졌나"를 묻게 된다.
/// 특히 표는 **구분줄이 바로 다음 줄에 있고 열 수가 머리글과 같을 때만** 표다. `a | b` 라고 쓴
/// 문장 두 줄을 표로 바꾸면 사람이 쓴 글이 격자 안으로 사라진다.
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
  final List<MdListItem> items;
  final bool ordered;
  final int start;
}

/// 목록 항목. [children] 에는 **중첩 목록만** 들어간다 — 들여쓰기를 여백으로 흉내 내지 않고
/// 실제로 목록을 겹친다(번호가 깊이마다 따로 센다).
class MdListItem {
  const MdListItem(this.text, [this.children = const []]);
  final String text;
  final List<MdList> children;
}

class MdRule extends MdBlock {
  const MdRule();
}

/// 표 칸의 정렬. `null` 은 구분줄이 정렬을 말하지 않았다는 뜻이고 그때는 **왼쪽**이다 — 칸
/// 내용을 보고 숫자면 오른쪽으로 미루는 식의 추측을 하지 않는다(같은 열이 행마다 다르게 선다).
enum MdAlign { left, center, right }

/// GFM 표. [align] 의 길이가 곧 **열 수**이고 모든 행이 그 길이로 맞춰져 들어온다 — 넘친 칸은
/// 버리고 모자란 칸은 빈 칸이다. 칸은 아직 인라인 해석 전의 글이다.
class MdTable extends MdBlock {
  const MdTable(this.align, this.head, this.rows, {this.omittedRows = 0});
  final List<MdAlign?> align;
  final List<String> head;
  final List<List<String>> rows;

  /// 상한([mdTableMaxRows]·[mdTableMaxCells])에 걸려 **그리지 않은 행 수**. 0 이 아니면
  /// 그림이 "…n행 더"를 남긴다 — 말없이 자르면 사람은 표가 거기서 끝난 줄 안다.
  final int omittedRows;
}

/// 표 크기 상한(security #1060 F1). 칸은 모두 위젯이 되고 `IntrinsicColumnWidth` 는 열마다
/// 모든 칸을 잰다 — 짧은 글 하나(`|` 만 있는 줄 수천 개 + 넓은 머리글)가 행을 열 수만큼 빈 칸으로
/// 채우면 수백만 칸이 되어 그 채널을 여는 폰이 멈춘다.
///
/// - 열이 [mdTableMaxCols] 를 넘으면 **표가 아니다** — 단락 글자 그대로 둔다(원문이 보이는 편이 낫다).
/// - 행은 [mdTableMaxRows] 또는 칸 합계 [mdTableMaxCells](머리글 포함)에서 자른다.
const mdTableMaxCols = 32;
const mdTableMaxRows = 200;
const mdTableMaxCells = 2000;

/// 목록 중첩 깊이 상한(security #1060 F2). 더 깊이 들여 쓴 항목은 이 깊이에 붙는다 — 깊이마다
/// 글머리표 폭만큼 오른쪽으로 밀려서, 상한이 없으면 폰 폭을 넘는다.
const mdListMaxDepth = 8;

final _fence = RegExp(r'^\s*(```|~~~)\s*([\w+-]*)\s*$');
final _heading = RegExp(r'^(#{1,6})\s+(.*)$');
final _bullet = RegExp(r'^([ \t]*)[-*+][ \t]+(.*)$');
final _ordered = RegExp(r'^([ \t]*)(\d{1,9})[.)][ \t]+(.*)$');
/// 가로줄. 같은 기호 세 개 이상만 인정한다 — `--` 는 그냥 글자다.
final _rule = RegExp(r'^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$');
/// 표 구분줄의 칸. `-`, `---`, `:--`, `--:`, `:-:` 만 인정한다.
final _delimCell = RegExp(r'^:?-+:?$');
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

    // 가로줄을 목록보다 먼저 본다. `---` 는 `- ` 가 아니라 줄이다.
    if (_rule.hasMatch(line)) {
      flushPara();
      out.add(const MdRule());
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

    // 표. **구분줄이 바로 다음 줄에 있을 때만** 표다 — 앞 줄만 보고는 머리글과 `a | b` 라고
    // 쓴 문장을 구별할 수 없다.
    final table = _tryTable(lines, i);
    if (table != null) {
      flushPara();
      out.add(table.$1);
      i = table.$2;
      continue;
    }

    if (_bullet.hasMatch(line) || _ordered.hasMatch(line)) {
      flushPara();
      // 연속한 항목 줄을 모두 모은 뒤 한 번에 접는다. 중첩 판정은 이웃 항목의 들여쓰기를 봐야
      // 하므로 줄 하나만 보고는 만들 수 없다.
      final raw = <_RawItem>[];
      while (i < lines.length) {
        final bm = _bullet.firstMatch(lines[i]);
        if (bm != null) {
          raw.add(_RawItem(_indentWidth(bm.group(1)!), false, 1, bm.group(2)!));
          i++;
          continue;
        }
        final om = _ordered.firstMatch(lines[i]);
        if (om != null) {
          raw.add(_RawItem(_indentWidth(om.group(1)!), true, int.tryParse(om.group(2)!) ?? 1, om.group(3)!));
          i++;
          continue;
        }
        // 들여 쓴 이어지는 줄은 앞 항목에 붙인다(빈 줄·다른 블록이면 목록이 끝난다).
        if (raw.isNotEmpty && lines[i].startsWith(RegExp(r'\s{2,}')) && lines[i].trim().isNotEmpty) {
          raw.last.text = '${raw.last.text}\n${lines[i].trim()}';
          i++;
          continue;
        }
        break;
      }
      var at = 0;
      while (at < raw.length) {
        final folded = _foldList(raw, at, raw[at].indent);
        out.add(folded.$1);
        at = folded.$2;
      }
      continue;
    }

    para.add(line);
    i++;
  }
  flushPara();
  return out;
}

class _RawItem {
  _RawItem(this.indent, this.ordered, this.start, this.text);
  final int indent;
  final bool ordered;
  final int start;
  String text;
}

/// 들여쓰기 폭. 탭은 두 칸으로 센다 — 목록 깊이 판정에만 쓰는 상대값이다.
int _indentWidth(String s) => s.runes.fold(0, (n, r) => n + (r == 0x09 ? 2 : 1));

/// 연속한 항목들을 **중첩된** 목록으로 접는다. 돌려주는 둘째 값은 다음에 볼 항목.
(MdList, int) _foldList(List<_RawItem> items, int from, int indent, [int depth = 0]) {
  final ordered = items[from].ordered;
  final start = items[from].start;
  final out = <({String text, List<MdList> children})>[];
  var i = from;
  while (i < items.length) {
    final it = items[i];
    if (it.indent < indent) break;
    // 깊이 상한에 닿으면 더 깊은 항목도 이 목록의 항목이 된다(겹치지 않는다).
    if (it.indent > indent && out.isNotEmpty && depth + 1 < mdListMaxDepth) {
      final nested = _foldList(items, i, it.indent, depth + 1);
      out.last.children.add(nested.$1);
      i = nested.$2;
      continue;
    }
    // 표시 종류가 바뀌면 다른 목록이다 — 글머리표와 번호를 한 목록에 섞지 않는다.
    if (it.ordered != ordered) break;
    out.add((text: it.text, children: <MdList>[]));
    i++;
  }
  return (
    MdList([for (final o in out) MdListItem(o.text, o.children)], ordered: ordered, start: start),
    i,
  );
}

/// 한 줄을 `|` 경계로 나눈다. **인라인 코드 안의 `|` 는 경계가 아니다**(`` `a|b` `` 는 한 칸).
/// 코드 밖의 `\|` 는 글자 `|` 로 남긴다. 양끝의 `|` 가 만든 빈 칸은 떼어 낸다 — `| a | b |` 와
/// `a | b` 를 같은 두 칸으로 읽는다. 둘째 값은 경계로 쓰인 `|` 가 있었는가.
(List<String>, bool) _splitCells(String line) {
  final cells = <String>[''];
  var piped = false;
  var i = 0;
  while (i < line.length) {
    final ch = line[i];
    if (ch == '`') {
      // 인라인 규칙(`_inline`)과 같은 폭: 같은 줄에서 닫히는 `…` 만 코드다.
      final close = line.indexOf('`', i + 1);
      if (close > i + 1) {
        cells.last += line.substring(i, close + 1);
        i = close + 1;
        continue;
      }
    }
    if (ch == '\\' && i + 1 < line.length && line[i + 1] == '|') {
      cells.last += '|';
      i += 2;
      continue;
    }
    if (ch == '|') {
      piped = true;
      cells.add('');
      i++;
      continue;
    }
    cells.last += ch;
    i++;
  }
  if (cells.length > 1 && cells.first.isEmpty) cells.removeAt(0);
  if (cells.length > 1 && cells.last.isEmpty) cells.removeLast();
  return (cells, piped);
}

/// 이 줄이 표 구분줄이면 열별 정렬, 아니면 `null`. 칸 하나라도 구분줄 모양이 아니면 표가 아니다.
List<MdAlign?>? _delimAligns(String line) {
  final (cells, piped) = _splitCells(line);
  if (!piped) return null;
  final out = <MdAlign?>[];
  for (final cell in cells) {
    final c = cell.trim();
    if (!_delimCell.hasMatch(c)) return null;
    final l = c.startsWith(':');
    final r = c.endsWith(':');
    out.add(l && r ? MdAlign.center : r ? MdAlign.right : l ? MdAlign.left : null);
  }
  return out.isEmpty ? null : out;
}

/// [at] 줄에서 표가 시작하면 그 블록과 다음에 볼 줄을, 아니면 `null`.
(MdTable, int)? _tryTable(List<String> lines, int at) {
  final (head, piped) = _splitCells(lines[at]);
  if (!piped || at + 1 >= lines.length) return null;
  final align = _delimAligns(lines[at + 1]);
  if (align == null || align.length != head.length) return null;
  if (align.length > mdTableMaxCols) return null;
  final maxRows = [mdTableMaxRows, mdTableMaxCells ~/ align.length - 1].reduce((a, b) => a < b ? a : b);
  final rows = <List<String>>[];
  var omitted = 0;
  var j = at + 2;
  // 표는 `|` 가 없는 줄에서 끝난다(빈 줄도 그렇다). 그래야 표 뒤에 붙여 쓴 문장이 마지막
  // 행으로 끌려오지 않는다.
  while (j < lines.length) {
    final (cells, p) = _splitCells(lines[j]);
    if (!p) break;
    j++;
    // 상한 뒤의 행은 **세기만** 한다 — 표의 끝(`|` 없는 줄)까지는 표가 삼킨다. 거기서 끊으면
    // 남은 행이 단락 글자로 쏟아진다.
    if (rows.length >= maxRows) {
      omitted++;
      continue;
    }
    // 행을 머리글의 열 수에 맞춘다 — 넘치는 칸은 버리고 모자란 칸은 빈 칸.
    rows.add([for (var c = 0; c < align.length; c++) c < cells.length ? cells[c].trim() : '']);
  }
  return (MdTable(align, [for (final h in head) h.trim()], rows, omittedRows: omitted), j);
}

/// 인라인 조각.
sealed class MdInline {
  const MdInline();
}

class MdText extends MdInline {
  const MdText(this.text, {this.bold = false, this.italic = false, this.strike = false});
  final String text;
  final bool bold;
  final bool italic;
  final bool strike;
}

class MdInlineCode extends MdInline {
  const MdInlineCode(this.text);
  final String text;
}

/// 링크. [uri] 가 `null` 이면 **열 수 없는 링크**다(http(s) 가 아니다) — 글자만 보이고 누를 수 없다.
class MdLink extends MdInline {
  const MdLink(this.text, this.uri, {this.labelled = false});
  final String text;
  final Uri? uri;

  /// `[글](주소)` 처럼 **보이는 글자와 주소가 따로**인 링크. 맨 주소는 `false` 다.
  final bool labelled;
}

/// 열기 전에 **실제 주소를 보여 주고 물어야 하는가**(security #980).
///
/// - `[글](주소)` 는 늘 묻는다 — 보이는 글자는 아무 주소나 흉내 낼 수 있다
///   (`[https://github.com/…](https://github-login.evil.example)`).
/// - 맨 주소라도 `user@host` 꼴(userinfo)이면 묻는다 — `https://github.com@evil.example`
///   은 앞이 github 처럼 보이지만 열리는 곳은 `evil.example` 이다.
/// - 호스트에 ASCII 가 아닌 글자가 있으면 묻는다 — 닮은 글자로 꾸민 도메인일 수 있다.
bool linkNeedsConfirm(MdLink link) {
  final uri = link.uri;
  if (uri == null) return false;
  return link.labelled || uri.userInfo.isNotEmpty || hostLooksSpoofable(uri);
}

/// 호스트에 ASCII 가 아닌 글자(또는 퓨니코드 `xn--`)가 있다. Dart 의 `Uri` 는 비ASCII 호스트를
/// **퍼센트 인코딩**해서 들고 있으므로(`а` → `%D0%B0`) `%` 도 같은 신호로 본다.
bool hostLooksSpoofable(Uri uri) =>
    uri.host.contains('%') ||
    uri.host.runes.any((r) => r > 0x7f) ||
    uri.host.split('.').any((p) => p.startsWith('xn--'));

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
  r'|(https?://[^\s<>()\[\]]+[^\s<>()\[\].,;:!?"\x27])'
  // 취소선. 여는 `~~` 뒤·닫는 `~~` 앞이 공백이면 짝이 아니다(데스크톱과 같다).
  r'|~~([^~\s](?:[^~\n]*[^~\s])?)~~',
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
      out.add(MdLink(m.group(2)!, safeLinkUri(m.group(3)!), labelled: true));
    } else if (m.group(4) != null || m.group(5) != null) {
      out.add(MdText(m.group(4) ?? m.group(5)!, bold: true));
    } else if (m.group(6) != null) {
      out.add(MdText(m.group(6)!, italic: true));
    } else if (m.group(7) != null) {
      out.add(MdLink(m.group(7)!, safeLinkUri(m.group(7)!)));
    } else if (m.group(8) != null) {
      out.add(MdText(m.group(8)!, strike: true));
    }
    last = m.end;
  }
  if (last < text.length) out.add(MdText(text.substring(last)));
  return out;
}
