/// 선택 요청(`message.ask`) — 에이전트가 갈림길에서 내놓는 선택지.
///
/// ## 왜 이것이 P1 인가 (P2 가 아니라)
///
/// 에이전트는 갈림길에서 묻고, **답도 닫힘도 없으면 그 턴은 거기서 멈춘다**
/// (`isAskOpen`). 답할 수 없는 클라이언트에서 에이전트를 부르면 *"불렀는데 조용한"*
/// 것이 정상 동작이 된다 — 모바일의 존재 이유("다른 머신의 에이전트를 호출해서 쓴다")가
/// 반쪽이 난다. 그래서 카드 렌더링(P2)보다 먼저다.
///
/// ## 모르는 모양은 **평문으로 흘린다**
///
/// 형식을 못 알아보면 `null` 을 내고 화면은 본문만 그린다. 데스크탑의 규약과 같다 —
/// 사본인 이쪽이 그걸 어기면 모르는 `meta` 가 화면에서 **사라진다.**
library;

/// 선택지 하나.
class AskOption {
  const AskOption({required this.id, required this.label, this.hint, this.recommended = false});

  /// 답을 기록할 때 쓰는 열쇠. 한 물음 안에서 유일하다.
  final String id;
  final String label;

  /// 고르기 전에 읽는 한 줄. 없어도 된다.
  final String? hint;

  /// 물어본 쪽이 권한 선택지. 묶음 카드의 「추천대로」는 추천이 **하나뿐인** 줄만 고른다.
  final bool recommended;

  static List<AskOption> readList(Object? rawOptions) {
    if (rawOptions is! List) return const [];
    final options = <AskOption>[];
    for (final raw in rawOptions) {
      if (raw is! Map) continue;
      final id = raw['id'];
      final label = raw['label'];
      if (id is! String || label is! String || id.isEmpty || label.isEmpty) continue;
      options.add(AskOption(id: id, label: label, hint: raw['hint'] as String?, recommended: raw['recommended'] == true));
    }
    return options;
  }
}

/// 누구에게 물었나.
///
/// **합 타입이어야 하는 이유**: `accountId` 하나로 두면 "없음"이 두 뜻이 된다 —
/// *사람 아무나* 와 *아직 안 정했다*. 화면은 그 둘을 다르게 그려야 하는데(전자는 강조,
/// 후자는 그릴 수 없다) 필드 하나로는 구별이 안 된다.
sealed class AskAudience {
  const AskAudience();
}

/// 사람 아무나.
class AskAnyHuman extends AskAudience {
  const AskAnyHuman();
}

/// 특정 계정(사람일 수도 에이전트일 수도 있다).
class AskAccount extends AskAudience {
  const AskAccount(this.accountId);
  final String accountId;
}

/// 선택지 개수의 경계. 하나면 선택이 아니고, 여섯이면 읽히지 않는다.
const int askMinOptions = 2;
const int askMaxOptions = 5;

class AskMeta {
  const AskMeta({
    required this.options,
    required this.to,
    this.prompt,
    this.answeredWith,
    this.answeredBy,
    this.closedAt,
    this.closedBy,
    this.closedReason,
    this.replyMessageId,
    this.replyNote,
    this.replyNoteBy,
  });

  /// 무엇을 묻는지. 본문에 이미 적혀 있으면 없다 — **같은 말을 두 번 그리지 않는다.**
  final String? prompt;
  final List<AskOption> options;
  final AskAudience to;

  /// 고른 선택지의 `id`. 없으면 아직 아무도 답하지 않았다.
  final String? answeredWith;
  final String? answeredBy;

  /// **답하지 않기로 한** 시각. 고른 것과 안 고른 것은 다른 사실이라 필드를 나눈다 —
  /// 하나로 뭉치면 "무엇으로 정해졌나"에 답할 수 없는 값이 그 자리에 앉는다.
  final String? closedAt;
  final String? closedBy;

  /// 왜 닫혔나 — `declined`(답하지 않기)·`replied`(글로 답함, A′)·`superseded`(새 카드로 바뀜).
  /// 옛 서버는 싣지 않는다 — 그때는 `declined` 로 읽는다(전에는 닫힘이 그것 하나였다).
  final String? closedReason;

  /// `replied` 일 때 카드를 닫은 사람 글의 id. 인용 한 줄을 그릴 때 쓴다.
  final String? replyMessageId;

  /// 글로 답한 그 글이 **다른 스레드**(묶음 카드의 스레드)에 있을 때 관리 에이전트가 옮긴 요지.
  final String? replyNote;

  /// [replyNote] 를 쓴 계정(관리 에이전트, security n1). 화면은 「○○ 요약:」으로 밝힌다 — 사람의 말로 읽히면 안 된다.
  final String? replyNoteBy;

  /// 글로 답해 닫혔다 — 차례는 넘어갔지만 늦게 고를 수는 있다(서버가 받는다).
  bool get isReplied => answeredWith == null && closedAt != null && closedReason == 'replied';

  /// 새 카드로 대신됐다 — 고를 것은 새 카드에 있다. 서버도 늦은 답을 받지 않는다.
  bool get isSuperseded => answeredWith == null && closedAt != null && closedReason == 'superseded';

  /// 아직 누군가를 **막고 있는가.** 답도 없고 닫히지도 않았을 때만 참이다.
  bool get isOpen => answeredWith == null && closedAt == null;

  /// `meta` 가 선택 요청인지 판정한다. 아니면 `null` — 화면은 본문만 그린다.
  ///
  /// **선택지가 형식을 못 갖추면 `null` 이다.** 두 개 미만이면 선택이 아니고, 그때
  /// 버튼을 그리면 누를 것이 없는 빈 상자가 남는다.
  static AskMeta? read(Map<String, Object?> meta) {
    if (meta['kind'] != 'ask') return null;
    final ask = meta['ask'];
    if (ask is! Map) return null;

    final rawOptions = ask['options'];
    if (rawOptions is! List) return null;
    final options = AskOption.readList(rawOptions);
    if (options.length < askMinOptions) return null;

    final to = ask['to'];
    final AskAudience audience;
    if (to is Map && to['kind'] == 'account' && to['accountId'] is String) {
      audience = AskAccount(to['accountId']! as String);
    } else {
      // 모르는 모양은 **사람 아무나**로 떨어진다. 물음을 통째로 버리는 것보다,
      // 누구든 답할 수 있게 두는 편이 덜 나쁘다 — 안 그러면 그 턴은 영영 멈춘다.
      audience = const AskAnyHuman();
    }

    return AskMeta(
      prompt: ask['prompt'] as String?,
      options: options,
      to: audience,
      answeredWith: ask['answeredWith'] as String?,
      answeredBy: ask['answeredBy'] as String?,
      closedAt: ask['closedAt'] as String?,
      closedBy: ask['closedBy'] as String?,
      closedReason: ask['closedReason'] as String?,
      replyMessageId: ask['replyMessageId'] as String?,
      replyNote: ask['replyNote'] as String?,
      replyNoteBy: ask['replyNoteBy'] as String?,
    );
  }
}

/// **묶음 카드**의 줄 하나(선택 카드 P1, shared `AskBundleItem`). 원본 카드(`rootId`)를 가리킬 뿐 상태는 싣지
/// 않는다 — 답·닫힘은 원본에서 읽는다. `prompt`·`options` 는 모을 때의 사본이다. `link` 는 권한 요청·머지 거절
/// 카드라 묶음에서는 고르지 못하고 원 스레드로 가는 링크로만 선다.
class AskBundleItem {
  const AskBundleItem({
    required this.rootId,
    required this.askerId,
    required this.prompt,
    required this.options,
    this.link = false,
  });

  final String rootId;
  final String? askerId;
  final String prompt;
  final List<AskOption> options;
  final bool link;
}

class AskBundleMeta {
  const AskBundleMeta(this.items);
  final List<AskBundleItem> items;

  /// `meta` 가 묶음 카드인지(shared `readAskBundleMeta`). 못 알아보면 `null` — 화면은 본문만 그린다.
  static AskBundleMeta? read(Map<String, Object?> meta) {
    if (meta['kind'] != 'askBundle') return null;
    final bundle = meta['askBundle'];
    if (bundle is! Map) return null;
    final raw = bundle['items'];
    if (raw is! List) return null;
    final items = <AskBundleItem>[];
    for (final i in raw) {
      if (i is! Map || i['rootId'] is! String || i['options'] is! List) return null;
      items.add(AskBundleItem(
        rootId: i['rootId'] as String,
        askerId: i['askerId'] as String?,
        prompt: (i['prompt'] as String?) ?? '',
        options: AskOption.readList(i['options']),
        link: i['link'] == true,
      ));
    }
    return AskBundleMeta(items);
  }
}

/// 묶음 줄의 상태 — 원본 카드를 읽어 정한다(데스크톱 `rowState` 와 같은 판정).
sealed class BundleRowState {
  const BundleRowState();
}

class BundleRowLoading extends BundleRowState {
  const BundleRowLoading();
}

/// 원본을 못 봤다(403 등). 지어내지 않는다.
class BundleRowUnavailable extends BundleRowState {
  const BundleRowUnavailable();
}

/// 원 스레드에서만 정하는 줄(권한 요청·머지 거절).
class BundleRowLink extends BundleRowState {
  const BundleRowLink();
}

class BundleRowOpen extends BundleRowState {
  const BundleRowOpen(this.ask);
  final AskMeta ask;
}

class BundleRowAnswered extends BundleRowState {
  const BundleRowAnswered({this.label, this.by});
  final String? label;
  final String? by;
}

class BundleRowReplied extends BundleRowState {
  const BundleRowReplied({this.by, this.note, this.noteBy});
  final String? by;
  final String? note;
  final String? noteBy;
}

class BundleRowSuperseded extends BundleRowState {
  const BundleRowSuperseded();
}

class BundleRowDeclined extends BundleRowState {
  const BundleRowDeclined();
}

/// [root] 는 원본 `meta`(아직 못 읽었으면 `null`, 못 보면 [unavailable]).
BundleRowState bundleRowState(AskBundleItem item, Map<String, Object?>? root, {bool unavailable = false}) {
  if (root == null) {
    if (item.link) return const BundleRowLink();
    return unavailable ? const BundleRowUnavailable() : const BundleRowLoading();
  }
  final ask = AskMeta.read(root);
  if (ask == null) return const BundleRowUnavailable();
  if (ask.answeredWith != null) {
    String? label;
    for (final o in ask.options) {
      if (o.id == ask.answeredWith) label = o.label;
    }
    return BundleRowAnswered(label: label, by: ask.answeredBy);
  }
  if (item.link && ask.isOpen) return const BundleRowLink();
  if (ask.closedReason == 'replied') return BundleRowReplied(by: ask.closedBy, note: ask.replyNote, noteBy: ask.replyNoteBy);
  if (ask.closedReason == 'superseded') return const BundleRowSuperseded();
  if (ask.closedAt != null) return const BundleRowDeclined();
  return BundleRowOpen(ask);
}

/// 「추천대로」가 고를 선택지 — 추천이 **하나뿐일** 때만(서버 `acceptRecommended` 와 같다).
String? bundleRecommended(List<AskOption> options) {
  final rec = options.where((o) => o.recommended).toList();
  return rec.length == 1 ? rec.single.id : null;
}

/// 「추천대로」의 줄 하나 결과(server `acceptRecommended`).
class BundleAcceptResult {
  const BundleAcceptResult({required this.rootId, required this.outcome});
  final String rootId;

  /// `answered`·`resolved`·`skipped_irreversible`·`skipped_link`·`skipped_no_recommendation`·`failed`.
  final String outcome;

  bool get skipped => outcome != 'answered' && outcome != 'resolved';

  static BundleAcceptResult? fromJson(Object? j) {
    if (j is! Map || j['rootId'] is! String || j['outcome'] is! String) return null;
    return BundleAcceptResult(rootId: j['rootId'] as String, outcome: j['outcome'] as String);
  }
}
