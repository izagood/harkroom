/// 본문에서 **실제로 불리는 handle** 을 찾는다.
///
/// ## 이 파일은 사본이다 — 그리고 그 사실이 설계의 전부다
///
/// 원본은 `packages/shared/src/index.ts` 의 `mentionedHandles` 이고, 서버의 알림 발송과
/// 데스크탑의 강조가 **그 하나**를 읽는다. 그래서 지금까지 둘은 갈라질 수가 없었다.
/// 이 파일이 **두 번째 구현**이고, 공유가 막아 주던 것이 여기서 처음 뚫린다.
///
/// 갈라지면 무슨 일이 나는가:
/// - 강조되지 않은 글이 **몰래 에이전트를 깨운다**(사람이 시키지 않은 턴이 뜬다)
/// - 강조된 글이 **아무도 안 깨운다**(불렀다고 믿는데 조용하다)
///
/// 둘 다 사람이 화면을 믿을 수 없게 만든다. 그래서 이 포팅은 **표로 묶여 있다**:
/// `packages/shared/test/fixtures/mentionCases.json` 을 TS 시험과 Dart 시험이 함께 읽는다
/// (`test/mention_test.dart`). 규칙을 고치려면 TS 를 고치고 표를 다시 뽑아야 하며,
/// 그러면 이쪽 시험이 빨개져서 **포팅을 안 고쳤다는 사실이 CI 에 먼저 보인다.**
///
/// ## 무엇이 부름이 아닌가
///
/// 세 가지를 걷어낸 나머지에서만 찾는다:
/// - **코드**(#298) — 인라인 백틱과 펜스 블록
/// - **인용 줄**(#592) — `>` 로 시작하는 줄
/// - **링크** — 주소 안의 `@` 는 이름이 아니다(`https://x.io/@forge`)
library;

/// handle 의 문자와 길이. 원본 `HANDLE_PATTERN` 과 같아야 한다.
const String handlePattern = '[a-zA-Z0-9_-]{2,32}';

/// 앞에 handle 문자가 오면 부름이 아니다 — `x@forge` 는 주소의 일부지 부름이 아니다.
final RegExp _mention = RegExp('(^|[^a-zA-Z0-9_-])@($handlePattern)');

/// 줄 전체가 펜스여야 한다. 문장 안에 섞인 ``` 는 펜스가 아니다.
final RegExp _fenceLine = RegExp(r'^[ \t]*```([^\n`]*)$');

/// 인라인 코드. **개행을 넘지 않는다** — 짝 없는 백틱 하나가 뒤의 본문 전체를 코드로
/// 삼키면 메시지가 사라진 것처럼 보인다.
final RegExp _inlineCode = RegExp(r'(?<!`)`([^`\n]+)`(?!`)');

/// 인용 줄. 들여쓰기는 **세 칸까지**다(네 칸은 마크다운에서 코드다).
final RegExp _quoteLine = RegExp('^ {0,3}>[ \t]?(.*)\$');

/// 링크 후보. `://` 를 요구하지 않는다 — 스킴 판정은 [_isDrawnLink] 가 한다.
final RegExp _urlCandidate = RegExp(r'[a-zA-Z][a-zA-Z0-9+.-]*:[^\s]+');

/// 화면이 **실제로 링크로 칠하는** 스킴만 걷어낸다.
///
/// 넓게 잡으면 `cc:@forge` 같은 평문이 주소로 오인되어 **사람의 부름이 삼켜지고**,
/// 좁게 잡으면 주소 안의 이름이 턴을 띄운다. 그래서 허용 목록이 판정의 중심이다.
const List<String> linkSchemes = ['http', 'https'];

bool _isDrawnLink(String token) {
  final uri = Uri.tryParse(token.trim());
  if (uri == null || !uri.hasScheme) return false;
  return linkSchemes.contains(uri.scheme.toLowerCase());
}

/// 문장 끝에 붙어 온 문장부호는 주소가 아니다 — `자세히는 https://a.io/b.` 의 마침표까지
/// 링크에 넣으면 열리지 않는 주소가 된다. **짝이 맞는 괄호는 남긴다**(위키 주소가 쓴다).
String trimTrailingPunctuation(String token) {
  var end = token.length;
  while (end > 0) {
    final ch = token[end - 1];
    if ('.,;:!?\'"'.contains(ch)) {
      end -= 1;
      continue;
    }
    if (ch == ')' || ch == ']') {
      final open = ch == ')' ? '(' : '[';
      final slice = token.substring(0, end);
      final balanced = open.allMatches(slice).length <= ch.allMatches(slice).length;
      if (balanced) {
        end -= 1;
        continue;
      }
    }
    break;
  }
  return token.substring(0, end);
}

class _Span {
  _Span(this.start, this.end);
  final int start;
  int end;
}

/// 코드가 아닌 구간들. 원본 `splitCode` 의 `plain` 조각과 같은 것이다.
List<_Span> _plainSpans(String body) {
  final lines = body.split('\n');
  final lineStart = <int>[];
  {
    var at = 0;
    for (final line in lines) {
      lineStart.add(at);
      at += line.length + 1;
    }
  }

  // 먼저 펜스 블록을 구간으로 잡는다.
  final fenced = <_Span>[];
  var i = 0;
  while (i < lines.length) {
    if (!_fenceLine.hasMatch(lines[i])) {
      i += 1;
      continue;
    }
    var close = -1;
    for (var j = i + 1; j < lines.length; j += 1) {
      if (_fenceLine.hasMatch(lines[j])) {
        close = j;
        break;
      }
    }
    // **안 닫힌 펜스는 코드가 아니다.** 닫히지 않은 백틱 세 개가 뒤의 본문 전체를
    // 삼키면 메시지가 통째로 사라진 것처럼 보인다.
    if (close == -1) {
      i += 1;
      continue;
    }
    fenced.add(_Span(lineStart[i], lineStart[close] + lines[close].length));
    i = close + 1;
  }

  // 펜스 밖에서 인라인 코드를 한 번 더 걷어낸다.
  final code = <_Span>[...fenced];
  for (final m in _inlineCode.allMatches(body)) {
    final inFence = fenced.any((f) => m.start >= f.start && m.start < f.end);
    if (!inFence) code.add(_Span(m.start, m.end));
  }
  code.sort((a, b) => a.start.compareTo(b.start));

  // 코드 구간을 뺀 나머지가 평문이다.
  final out = <_Span>[];
  var cursor = 0;
  for (final c in code) {
    if (c.start > cursor) out.add(_Span(cursor, c.start));
    cursor = cursor > c.end ? cursor : c.end;
  }
  if (cursor < body.length) out.add(_Span(cursor, body.length));
  return out;
}

/// 인용 줄과 링크 토큰. **합친 뒤 정렬·병합한다** — 겹친 채로 두면 커서가 뒤로 갈 수
/// 없어 한쪽이 조용히 새는 자리가 된다(`> 참고 https://x.com/@forge` 가 그 모양이다).
List<_Span> _skipSpans(String body) {
  final cut = <_Span>[];
  var at = 0;
  for (final line in body.split('\n')) {
    if (_quoteLine.hasMatch(line)) cut.add(_Span(at, at + line.length));
    at += line.length + 1;
  }
  for (final m in _urlCandidate.allMatches(body)) {
    final token = trimTrailingPunctuation(m[0]!);
    if (token.isEmpty || !_isDrawnLink(token)) continue;
    cut.add(_Span(m.start, m.start + token.length));
  }
  cut.sort((a, b) => a.start.compareTo(b.start));

  final merged = <_Span>[];
  for (final s in cut) {
    if (merged.isNotEmpty && s.start <= merged.last.end) {
      if (s.end > merged.last.end) merged.last.end = s.end;
    } else {
      merged.add(_Span(s.start, s.end));
    }
  }
  return merged;
}

/// 멘션을 찾을 **평문만** 이어 붙인다.
///
/// 개행으로 잇는 이유: 개행은 handle 문자가 아니므로 조각의 경계가 `[^a-zA-Z0-9_-]` 를
/// 만족한다. 그냥 붙이면 조각 끝의 글자와 다음 조각의 `@` 가 붙어 **없던 부름이 생기거나
/// 있던 부름이 사라진다.**
String mentionScanText(String body) {
  final parts = <String>[];
  final skip = _skipSpans(body);
  for (final seg in _plainSpans(body)) {
    var cursor = seg.start;
    for (final s in skip) {
      if (s.end <= cursor || s.start >= seg.end) continue;
      if (s.start > cursor) parts.add(body.substring(cursor, s.start));
      final next = s.end < seg.end ? s.end : seg.end;
      if (next > cursor) cursor = next;
    }
    if (cursor < seg.end) parts.add(body.substring(cursor, seg.end));
  }
  return parts.join('\n');
}

/// 이 본문이 **실제로 부르는** handle 들. 소문자로 접고 중복을 없앤다.
List<String> mentionedHandles(String body) {
  final found = <String>{};
  for (final m in _mention.allMatches(mentionScanText(body))) {
    final handle = m[2];
    if (handle != null && handle.isNotEmpty) found.add(handle.toLowerCase());
  }
  return found.toList(growable: false);
}
