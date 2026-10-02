/// 컴포저의 멘션 자동완성 — **커서가 지금 어떤 이름을 치고 있는가.**
///
/// ## 왜 판정과 자동완성이 다른 함수인가
///
/// `mention.dart` 는 **다 쓴 글**에서 실제로 불리는 이름을 찾는다(서버의 알림 판정과
/// 같은 규칙). 이 파일은 **쓰는 중인 글**에서 커서 앞의 조각을 본다. 둘은 답이 다르다:
/// `@fo` 는 아직 아무도 부르지 않지만 자동완성은 떠야 한다.
///
/// 그래도 **경계는 같아야 한다.** 코드나 인용 줄 안에서 치는 `@` 는 보내도 아무도 안
/// 깨우므로(#298·#592), 거기서 후보를 띄우면 화면이 거짓말을 한다 — 사람은 고르고
/// 보냈는데 상대는 오지 않는다. 그래서 여기서도 같은 구간을 걷어낸다.
library;

import 'mention.dart';
import 'usage.dart';

/// 지금 자동완성이 붙는 자리.
class MentionQuery {
  const MentionQuery({required this.start, required this.prefix});

  /// `@` 의 위치(본문 기준). 고른 이름을 끼워 넣을 때 여기부터 커서까지를 바꾼다.
  final int start;

  /// `@` 뒤에 지금까지 친 글자. 빈 문자열일 수 있다(`@` 만 친 순간).
  final String prefix;
}

/// handle 에 쓸 수 있는 글자인가. `mention.dart` 의 `handlePattern` 과 같은 집합이다.
bool _isHandleChar(String ch) {
  final c = ch.codeUnitAt(0);
  return (c >= 0x30 && c <= 0x39) || // 0-9
      (c >= 0x41 && c <= 0x5A) || // A-Z
      (c >= 0x61 && c <= 0x7A) || // a-z
      ch == '_' ||
      ch == '-';
}

/// 커서 앞이 멘션을 치는 중이면 그 자리를, 아니면 `null`.
///
/// 규칙은 [mentionedHandles] 와 같은 경계를 쓴다:
/// - `@` 바로 앞이 handle 글자면 **아니다**(`x@forge` 는 주소의 일부다)
/// - 친 글자에 handle 아닌 것이 섞이면 **아니다**(공백이 오면 이름은 끝났다)
/// - 코드·인용 줄·링크 안이면 **아니다** — 거기서 띄우면 화면이 거짓말을 한다
MentionQuery? mentionQueryAt(String text, int cursor) {
  if (cursor < 0 || cursor > text.length) return null;

  var i = cursor;
  while (i > 0 && _isHandleChar(text[i - 1])) {
    i -= 1;
  }
  if (i == 0 || text[i - 1] != '@') return null;
  final at = i - 1;
  if (at > 0 && _isHandleChar(text[at - 1])) return null;

  // 보내면 아무도 안 깨울 자리에서는 후보를 띄우지 않는다.
  if (_isSuppressed(text, at)) return null;

  return MentionQuery(start: at, prefix: text.substring(i, cursor));
}

/// 이 위치가 멘션 판정에서 걷어내지는 구간인가.
///
/// `mentionScanText` 를 **직접 부르지 않는 이유**: 그 함수는 조각을 이어 붙인 문자열을
/// 돌려주므로 원문 위치가 사라진다. 대신 같은 규칙으로 *이 지점 하나*를 본다 —
/// 판정이 둘로 갈라지지 않게, 규칙이 바뀌면 여기도 함께 고친다는 것을 시험이 지킨다
/// (`test/mention_suggest_test.dart` 가 두 함수의 답을 견준다).
bool _isSuppressed(String text, int at) {
  // 쓰는 중인 글에는 **닫히지 않은 코드/펜스**가 흔하다. 다 쓴 글의 규칙을 그대로 쓰면
  // 닫는 백틱을 치기 전까지 후보가 안 뜬다 — 그건 규칙이 아니라 불편이다.
  // 그래서 "이 지점 뒤에 닫는 짝이 있는가"를 보고, 없으면 코드로 치지 않는다.
  final head = text.substring(0, at);

  // 인용 줄: 이 줄이 `>` 로 시작하는가.
  final lineStart = head.lastIndexOf('\n') + 1;
  final lineEndRaw = text.indexOf('\n', at);
  final lineEnd = lineEndRaw == -1 ? text.length : lineEndRaw;
  final line = text.substring(lineStart, lineEnd);
  if (RegExp('^ {0,3}>').hasMatch(line)) return true;

  // 다 쓴 글의 판정에서 이 지점이 살아남는지 본다. 살아남지 못하면(코드·링크 안)
  // 후보를 띄우지 않는다.
  return !_survivesScan(text, at);
}

/// 원문 위치 [at] 이 멘션을 찾는 구간에 들어 있는가.
///
/// 표시용 이름을 하나 끼워 넣어 [mentionedHandles] 가 그것을 보는지로 판정한다.
/// **규칙을 두 벌 갖지 않는 가장 싼 방법**이다 — 구간 계산을 여기서 다시 하면 그것이
/// 세 번째 구현이 된다.
bool _survivesScan(String text, int at) {
  const probe = 'zzprobezz';
  // `@` 부터 커서까지를 표식으로 갈아 끼운다. 뒤에 이어지는 글자가 있으면 그것까지
  // 이름에 붙으므로, 표식 뒤에 handle 이 아닌 글자를 하나 넣어 끊는다.
  var end = at + 1;
  while (end < text.length && _isHandleChar(text[end])) {
    end += 1;
  }
  final probed = '${text.substring(0, at)}@$probe ${text.substring(end)}';
  return mentionedHandles(probed).contains(probe);
}

/// 고른 이름을 본문에 끼워 넣는다. 돌려주는 것은 **새 본문과 새 커서 위치**다.
///
/// 뒤에 공백을 붙인다 — 이름 바로 뒤에 글을 이어 치면 `@forge그리고` 가 되어 아무도
/// 안 불린다. 이미 공백이 있으면 더 넣지 않는다(두 칸이 남는다).
({String text, int cursor}) applyMention(String text, MentionQuery query, String handle) {
  var end = query.start + 1;
  while (end < text.length && _isHandleChar(text[end])) {
    end += 1;
  }
  final needsSpace = end >= text.length || text[end] != ' ';
  final inserted = '@$handle${needsSpace ? ' ' : ''}';
  return (
    text: text.substring(0, query.start) + inserted + text.substring(end),
    cursor: query.start + inserted.length,
  );
}

/// 후보를 고른다. **접두 일치**이고, 이미 다 친 이름도 남긴다(고치는 중일 수 있다).
///
/// 정렬은 (1) handle 이 접두로 시작하는 것 먼저 (2) 그 다음 표시 이름 일치 —
/// 사람이 친 것은 handle 이므로 그쪽을 앞에 둔다. 각 무리 **안에서는** [usageOf] 가
/// 주는 기록으로 자주 부른 상대가 먼저다(횟수 → 최근 → 이름순). 기록이 없으면 이름순이다.
///
/// 무리를 넘어 섞지 않는 이유: `@fo` 를 친 사람에게 이름에 fo 가 없는 단골이 앞에 서면
/// 친 글자와 화면이 어긋난다. 순서는 친 글자가 먼저 가르고, 쓰임은 그 안에서만 가른다.
List<T> rankMentionCandidates<T>(
  Iterable<T> all,
  String prefix, {
  required String Function(T) handleOf,
  required String Function(T) displayNameOf,
  MentionUse? Function(T)? usageOf,
  int limit = 8,
}) {
  final needle = prefix.toLowerCase();
  final byHandle = <T>[];
  final byName = <T>[];
  for (final item in all) {
    final handle = handleOf(item).toLowerCase();
    if (handle.startsWith(needle)) {
      byHandle.add(item);
    } else if (needle.isNotEmpty && displayNameOf(item).toLowerCase().contains(needle)) {
      byName.add(item);
    }
  }
  int compare(T a, T b) {
    final ua = usageOf?.call(a);
    final ub = usageOf?.call(b);
    final byCount = (ub?.count ?? 0).compareTo(ua?.count ?? 0);
    if (byCount != 0) return byCount;
    if (ua != null && ub != null) {
      final byLast = ub.last.compareTo(ua.last);
      if (byLast != 0) return byLast;
    }
    return handleOf(a).compareTo(handleOf(b));
  }

  byHandle.sort(compare);
  byName.sort(compare);
  return [...byHandle, ...byName].take(limit).toList(growable: false);
}
