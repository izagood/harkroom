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
  const AskOption({required this.id, required this.label, this.hint});

  /// 답을 기록할 때 쓰는 열쇠. 한 물음 안에서 유일하다.
  final String id;
  final String label;

  /// 고르기 전에 읽는 한 줄. 없어도 된다.
  final String? hint;
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
    final options = <AskOption>[];
    for (final raw in rawOptions) {
      if (raw is! Map) continue;
      final id = raw['id'];
      final label = raw['label'];
      if (id is! String || label is! String || id.isEmpty || label.isEmpty) continue;
      options.add(AskOption(id: id, label: label, hint: raw['hint'] as String?));
    }
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
    );
  }
}
