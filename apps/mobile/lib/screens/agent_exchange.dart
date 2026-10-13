import '../api/models.dart';
import '../mention/mention.dart';

/// 에이전트끼리 주고받은 글을 접는 **판정** — 데스크톱 `packages/desktop/src/lib/agentExchange.ts`
/// (`groupAgentExchanges`·`addressesHuman`·`firstLine` …)와 진행 묶음 `progressGroup.ts` 의 포팅이다.
///
/// **무엇이 접히는지는 데스크톱과 1:1 이어야 한다** — 같은 스레드가 두 화면에서 다르게 접히면
/// 한쪽에서 본 「내 차례」가 다른 쪽에서 사라진다. 그래서 판정을 새로 짜지 않고 그대로 옮기고,
/// 데스크톱이 뽑은 표(`packages/desktop/test/fixtures/exchangeFoldCases.json`)를 양쪽 시험이
/// 같이 읽는다(`test/agent_exchange_contract_test.dart`). 멘션 계약(`mentionCases.json`)과 같은 판례다.
///
/// 판정의 **이유**는 원본 주석에 있다 — 여기에 다시 적지 않는다(두 벌이 되면 한쪽이 낡는다).
/// 데스크톱 판정을 고치면 표를 다시 뽑고 이 파일을 함께 고친다.
///
/// 원본과 일부러 다르게 읽는 것은 없다. 특히 ask·실패·위임 meta 는 모바일 카드용 관대한 판독기
/// (`AskMeta.read` 등)를 쓰지 **않는다** — 그것들은 모르는 모양을 「사람 아무나」로 떨어뜨리는데,
/// 원본(`readAskMeta`)은 그때 선택이 아닌 것으로 친다. 판독이 다르면 접히는 글이 갈라진다.
sealed class FoldSlot {
  const FoldSlot();
}

/// 메시지 하나.
class FoldMessage extends FoldSlot {
  const FoldMessage(this.message);
  final MessageRow message;
}

/// 같은 저자의 이어진 진행 묶음. [endedAt] 은 같은 저자의 다음 비진행 말이 온 시각 — 아직 돌면 `null`.
class FoldProgress extends FoldSlot {
  FoldProgress(this.messages);
  final List<MessageRow> messages;
  DateTime? endedAt;
}

/// 접힌 주고받기. [items] 는 말과 진행 묶음이 원래 순서로, [messages] 는 그중 말(예약 줄 포함)만.
class FoldExchange extends FoldSlot {
  const FoldExchange({required this.messages, required this.items});
  final List<MessageRow> messages;
  final List<FoldSlot> items;

  /// 구간이 담은 행 전부(진행 포함) — 원본 `exchangeRows`.
  List<MessageRow> get rows => [
        for (final it in items)
          ...switch (it) {
            FoldMessage(:final message) => [message],
            FoldProgress(:final messages) => messages,
            FoldExchange() => const <MessageRow>[],
          },
      ];
}

/// 원본 `groupProgress` — 연속된 진행을 저자별로 묶고, 같은 저자의 다음 비진행 말로 닫는다.
List<FoldSlot> groupProgress(List<MessageRow> messages) {
  final slots = <FoldSlot>[];
  final open = <String, FoldProgress>{};
  for (final m in messages) {
    if (m.kind != MessageKind.progress) {
      final prev = open.remove(m.authorId);
      if (prev != null) prev.endedAt = m.createdAt;
      slots.add(FoldMessage(m));
      continue;
    }
    final last = slots.isEmpty ? null : slots.last;
    if (last is FoldProgress && last.messages.first.authorId == m.authorId) {
      last.messages.add(m);
    } else {
      final prev = open[m.authorId];
      if (prev != null) prev.endedAt = m.createdAt;
      final slot = FoldProgress([m]);
      open[m.authorId] = slot;
      slots.add(slot);
    }
  }
  return slots;
}

/// 원본 `isSpeech` — 진행과 예약 줄은 세는 말이 아니다.
bool isExchangeSpeech(MessageRow m) => m.kind != MessageKind.progress && m.kind != MessageKind.wake;

/// 원본 `groupAgentExchanges`. [rootId] 는 스레드의 루트 id — 루트는 접지 않는다.
List<FoldSlot> groupAgentExchanges(
  List<FoldSlot> slots,
  bool Function(String accountId) isAgent, {
  String? rootId,
}) {
  final out = <FoldSlot>[];
  var run = <FoldSlot>[];
  var turnOpen = false;
  final answered = <String>{};

  void flush({bool atEnd = false}) {
    if (run.isEmpty) return;
    final tail = <FoldSlot>[];
    if (atEnd) {
      while (run.isNotEmpty) {
        final last = run.last;
        if (last is! FoldProgress || last.endedAt != null) break;
        tail.insert(0, run.removeLast());
      }
    }
    final messages = [for (final it in run) if (it is FoldMessage) it.message];
    final speech = messages.where(isExchangeSpeech).toList();
    final authors = {for (final m in speech) m.authorId};
    if (authors.length >= 2 && speech.length >= 2) {
      out.add(FoldExchange(messages: messages, items: run));
    } else {
      out.addAll(run);
    }
    out.addAll(tail);
    run = <FoldSlot>[];
  }

  for (final slot in slots) {
    if (slot is! FoldMessage) {
      run.add(slot);
      continue;
    }
    final m = slot.message;

    if (m.id == rootId) {
      flush();
      out.add(slot);
      continue;
    }
    if (!isAgent(m.authorId)) {
      flush();
      turnOpen = true;
      answered.clear();
      out.add(slot);
      continue;
    }
    if (m.kind == MessageKind.wake) {
      run.add(slot);
      continue;
    }
    if (_isDelegation(m.meta)) {
      flush();
      turnOpen = false;
      answered.clear();
      out.add(slot);
      continue;
    }
    final firstAnswer = turnOpen && !answered.contains(m.authorId);
    if (_addressesHuman(m, isAgent) || firstAnswer) {
      flush();
      answered.add(m.authorId);
      out.add(slot);
      continue;
    }
    run.add(slot);
  }
  flush(atEnd: true);
  return out;
}

/// 원본 `addressesHuman` — 실패, 사람에게 온 미답 선택, 사람 계정을 멘션한 말(코드·인용 밖).
bool _addressesHuman(MessageRow m, bool Function(String) isAgent) {
  final meta = m.meta;
  // readFailureMeta: retryable 이 boolean 이어야 실패로 읽는다.
  if (meta['kind'] == 'failure' && meta['failure'] is Map && (meta['failure']! as Map)['retryable'] is bool) {
    return true;
  }
  final ask = _readAsk(meta);
  if (ask != null && ask['answeredWith'] == null && ask['closedAt'] == null && (ask['to']! as Map)['kind'] == 'human') {
    return true;
  }
  return _mentionedIds(mentionScanText(m.body)).any((id) => id != m.authorId && !isAgent(id));
}

/// 원본 `readAskMeta` 의 판정 — 선택지 2~5개, 각 id·label 이 문자열, 수신자 human/account.
Map<Object?, Object?>? _readAsk(Map<String, Object?> meta) {
  if (meta['kind'] != 'ask') return null;
  final ask = meta['ask'];
  if (ask is! Map) return null;
  final options = ask['options'];
  if (options is! List) return null;
  if (options.length < 2 || options.length > 5) return null;
  if (!options.every((o) => o is Map && o['id'] is String && o['label'] is String)) return null;
  final to = ask['to'];
  if (to is! Map || (to['kind'] != 'human' && to['kind'] != 'account')) return null;
  if (to['kind'] == 'account' && to['accountId'] is! String) return null;
  return ask;
}

/// 원본 `readDelegationMeta` 가 null 이 아닌가 — `to` 가 배열이어야 위임이다.
bool _isDelegation(Map<String, Object?> meta) {
  if (meta['kind'] != 'delegation') return false;
  final d = meta['delegation'];
  return d is Map && d['to'] is List;
}

/// 원본 `MENTION_TOKEN_PATTERN` — 정규화된 본문의 `<@uuid>` 토큰.
final RegExp _mentionToken = RegExp(r'<@([0-9a-f-]{36})>');

List<String> _mentionedIds(String body) =>
    {for (final m in _mentionToken.allMatches(body)) if (m[1] != null) m[1]!}.toList(growable: false);

/// 원본 `exchangeParticipants` — 말한 쪽만, 등장 순서대로.
List<String> exchangeParticipants(List<MessageRow> messages) {
  final seen = <String>[];
  for (final m in messages) {
    if (isExchangeSpeech(m) && !seen.contains(m.authorId)) seen.add(m.authorId);
  }
  return seen;
}

/// 원본 `EXCHANGE_CONCLUSION_MAX`.
const int exchangeConclusionMax = 40;

enum ExchangeConclusionSource { ask, report }

class ExchangeConclusion {
  const ExchangeConclusion(this.source, this.text);
  final ExchangeConclusionSource source;
  final String text;
}

/// 원본 `exchangeConclusion` — 뒤에서부터, 답한 선택의 label 또는 보고의 첫 확인.
ExchangeConclusion? exchangeConclusion(List<MessageRow> messages) {
  for (var i = messages.length - 1; i >= 0; i -= 1) {
    final meta = messages[i].meta;
    final ask = _readAsk(meta);
    final answeredWith = ask?['answeredWith'];
    if (ask != null && answeredWith != null) {
      for (final o in ask['options']! as List) {
        if ((o as Map)['id'] == answeredWith) {
          return ExchangeConclusion(ExchangeConclusionSource.ask, _clamp(o['label']! as String));
        }
      }
    }
    // readReportMeta: checks 가 비지 않은 문자열 배열일 때만.
    final checks = _reportChecks(meta);
    if (checks != null) return ExchangeConclusion(ExchangeConclusionSource.report, _clamp(checks.first));
  }
  return null;
}

List<String>? _reportChecks(Map<String, Object?> meta) {
  if (meta['kind'] != 'report') return null;
  final report = meta['report'];
  if (report is! Map) return null;
  final checks = report['checks'];
  if (checks is! List || checks.isEmpty || !checks.every((c) => c is String && c.isNotEmpty)) return null;
  return checks.cast<String>();
}

String _clamp(String text) {
  final flat = text.replaceAll(RegExp(r'\s+'), ' ').trim();
  return flat.length > exchangeConclusionMax ? '${flat.substring(0, exchangeConclusionMax)}…' : flat;
}

/// 원본 `ExchangeLastLine` — 결론이 없는 구간의 마지막 말 한 줄. [text] 와 [attachments] 중 하나만 있다.
class ExchangeLastLine {
  const ExchangeLastLine(this.authorId, {this.text, this.attachments});
  final String authorId;
  final String? text;
  final int? attachments;
}

/// 원본 `exchangeLastLine`. [display] 는 토큰을 `@handle` 로 바꾼 본문을 준다.
ExchangeLastLine? exchangeLastLine(List<MessageRow> messages, String Function(MessageRow) display) {
  for (var i = messages.length - 1; i >= 0; i -= 1) {
    final m = messages[i];
    if (!isExchangeSpeech(m)) continue;
    final text = firstLine(display(m));
    if (text.isNotEmpty) return ExchangeLastLine(m.authorId, text: _clamp(text));
    final n = m.attachments.length;
    return n > 0 ? ExchangeLastLine(m.authorId, attachments: n) : null;
  }
  return null;
}

const int _firstLineScanMax = 500;
final RegExp _fence = RegExp(r'^\s*(```|~~~)');
final RegExp _quote = RegExp(r'^\s*>');
final RegExp _rule = RegExp(r'^\s*([-*_])(?:\s*\1){2,}\s*$');
final RegExp _headMentions = RegExp(r'^\s*(?:@[^\s@,]+[\s,]*)+');
final RegExp _spaces = RegExp(r'\s+');

/// 원본 `firstLine` — 머리 멘션·코드·인용·가로줄·표 구분 행을 건너뛴 읽을 첫 줄.
String firstLine(String body) {
  var inFence = false;
  var head = true;
  for (final whole in body.split('\n')) {
    final raw = whole.length > _firstLineScanMax ? whole.substring(0, _firstLineScanMax) : whole;
    if (_fence.hasMatch(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (_quote.hasMatch(raw)) continue;
    if (_rule.hasMatch(raw)) continue;
    if (_isTableRule(raw)) continue;
    final rest = head ? raw.replaceFirst(_headMentions, '') : raw;
    final line = _stripMarkdown(_tableCells(rest)).replaceAll(_spaces, ' ').trim();
    if (line.isNotEmpty) return line;
    if (rest.trim().isNotEmpty) head = false;
  }
  return '';
}

bool _isTableRule(String line) =>
    line.contains('|') && line.contains('-') && line.replaceAll(RegExp(r'[\s|:-]'), '').isEmpty;

String _tableCells(String line) {
  if (!line.trimLeft().startsWith('|')) return line;
  return line.split('|').map((c) => c.trim()).where((c) => c.isNotEmpty).join(' · ');
}

String _stripMarkdown(String line) => line
    .replaceAllMapped(RegExp(r'!?\[([^\]]*)\]\([^)]*\)'), (m) => m[1]!)
    .replaceFirst(RegExp(r'^\s{0,3}#{1,6}\s+'), '')
    .replaceFirst(RegExp(r'^\s*(?:[-*+]|\d+[.)])\s+'), '')
    .replaceFirst(RegExp(r'^\s*\|'), '')
    .replaceAll(RegExp(r'(\*\*|__|~~|`)'), '')
    .replaceAllMapped(RegExp(r'(^|\s)[*_](\S)'), (m) => '${m[1]}${m[2]}')
    .replaceAllMapped(RegExp(r'(\S)[*_](?=\s|$)'), (m) => m[1]!);
