/// 권한 카드(W4 위임장) — 서버가 카드 meta `permissionRequest`(원본) 또는 `permissionMirror`(거울)에 적는 칸을 읽는다.
/// 계약은 shared `permissionCard.ts`. 값은 언제나 서버가 쓴다 — 화면은 읽어 그리기만 한다.
library;

/// 선택지 id(shared `PERMISSION_CARD_OPTION`).
const String permOptApproveMandate = 'approve_mandate';
const String permOptApproveNewMandate = 'approve_new_mandate';
const String permOptApproveOnce = 'approve_once';
/// t1: tool 카드의 [이번 턴만](위임장이 있을 때만 서버가 싣는다).
const String permOptApproveTurn = 'approve_turn';
const String permOptDeny = 'deny';

class PermissionCardMandate {
  const PermissionCardMandate({required this.id, required this.name, this.ownerId, this.startedAt, this.ended = false});
  final String id;

  /// 빈 문자열이면 이름 없는 칩(「🔑 위임장 · 소유자 · 시작일」).
  final String name;
  final String? ownerId;
  final String? startedAt;
  final bool ended;

  static PermissionCardMandate? read(Object? raw) {
    if (raw is! Map || raw['id'] is! String) return null;
    return PermissionCardMandate(
      id: raw['id'] as String,
      name: raw['name'] is String ? raw['name'] as String : '',
      ownerId: raw['ownerId'] as String?,
      startedAt: raw['startedAt'] as String?,
      ended: raw['endedAt'] is String || raw['ended'] == true,
    );
  }
}

class PermissionCardLimits {
  const PermissionCardLimits({this.untilMs, this.uses, this.pr, this.head, this.ciOverride = false, this.turn = false});
  final int? untilMs;
  /// t1: 이 카드 답이 깨우는 턴 하나에서만(「이 턴 끝까지」).
  final bool turn;
  final int? uses;
  final int? pr;
  final String? head;
  final bool ciOverride;

  static PermissionCardLimits read(Object? raw) {
    if (raw is! Map) return const PermissionCardLimits();
    int? n(Object? v) => v is num ? v.toInt() : null;
    return PermissionCardLimits(
      untilMs: n(raw['untilMs']),
      uses: n(raw['uses']),
      pr: n(raw['pr']),
      head: raw['head'] as String?,
      ciOverride: raw['ciOverride'] == true,
      turn: raw['turn'] == true,
    );
  }
}

class PermissionCardLine {
  const PermissionCardLine({required this.cap, required this.scope, required this.limits});
  final String cap;
  final String scope;
  final Map<String, PermissionCardLimits> limits;

  static PermissionCardLine? read(Object? raw) {
    if (raw is! Map || raw['cap'] is! String || raw['scope'] is! String) return null;
    final l = raw['limits'];
    return PermissionCardLine(
      cap: raw['cap'] as String,
      scope: raw['scope'] as String,
      limits: {
        if (l is Map)
          for (final e in l.entries)
            if (e.key is String) e.key as String: PermissionCardLimits.read(e.value),
      },
    );
  }
}

class PermissionCardOnce {
  const PermissionCardOnce({required this.number, required this.headSha, this.reason});
  final int number;
  final String headSha;
  final String? reason;
  bool get ci => reason == 'ci_not_green';

  static PermissionCardOnce? read(Object? raw) {
    if (raw is! Map || raw['number'] is! int || raw['headSha'] is! String) return null;
    return PermissionCardOnce(number: raw['number'] as int, headSha: raw['headSha'] as String, reason: raw['reason'] as String?);
  }
}

/// 카드 하나의 권한 칸. 원본(`permissionRequest`)과 진짜 거울(`permissionMirror`, neutral=false)은 같은 카드를 그린다.
/// 중립 거울은 [neutral] 이고 [rootId] 링크만 있다.
class PermissionCardInfo {
  const PermissionCardInfo({
    required this.kind,
    this.mandate,
    this.line,
    this.once,
    this.status,
    this.ownerId,
    this.agentId,
    this.requestChannelId,
    this.decidedViaChat = false,
    this.ghUserUsed,
    this.mirrorRootId,
    this.neutral = false,
    this.supersededByMessageId,
    this.bodyTargetLine,
    this.warnings = const [],
    this.bodyWarningLine,
    this.grantedWithoutLine = false,
    this.grantExpiresAt,
  });

  final String? kind;
  final PermissionCardMandate? mandate;
  final PermissionCardLine? line;
  final PermissionCardOnce? once;

  /// 원본의 `status`(pending·granted·approved_once·denied·expired·superseded·obsolete). 거울은 없다 — 답·닫힘은 ask 칸에서 읽는다.
  final String? status;

  /// 정할 수 있는 사람(원본의 `ownerAccountId`, 거울은 위임장 소유자). 모르면 null — 서버가 판정한다.
  final String? ownerId;

  /// 요청한 에이전트(원본만). 누가 정하나(`decide-check`)를 묻는 데 쓴다 — 거울은 null(소유자만 꼴 그대로).
  final String? agentId;

  /// 요청이 선 채널(원본만). 결정권은 이 채널로 묻는다 — 거울·묶음 채널이 아니다.
  final String? requestChannelId;
  final bool decidedViaChat;

  /// 이번 한 번 머지에 실제로 쓴 gh 계정(서버가 알려 줄 때만).
  final String? ghUserUsed;
  final String? mirrorRootId;
  final bool neutral;
  final String? supersededByMessageId;

  /// r5: 본문 속 서버가 쓴 대상 줄(줄 카드만). 줄 상자를 그리는 화면은 본문에서 이 줄 하나만 뺀다.
  final String? bodyTargetLine;

  /// H4: 경고 코드 — 알려진 것만, 위험한 것부터(`permissionWarningOrder`).
  final List<String> warnings;

  /// H4: 본문 속 서버가 쓴 경고 줄(`⚠ …`). 경고를 줄 상자에 그리는 화면은 본문에서 이 줄 하나만 뺀다.
  final String? bodyWarningLine;

  /// S2: 승인됐지만 위임장 줄 없이 7일 허락만 남은 카드(위임장을 못 세워 7일로 다시 한 경우 등). 서버는 카드 선택지로만 답을 적어
  /// `answeredWith` 가 「위임장 만들고 더하기」여도, 이 값이 참이면 결과 머리를 「7일 허락함」으로 그린다. 원본만 안다(거울은 거짓).
  final bool grantedWithoutLine;

  /// 서버가 적은 7일 기한(원본만) — 「{date}까지 허락함」에 쓴다(#1713 designer nit 1).
  final String? grantExpiresAt;

  bool get isMirror => mirrorRootId != null;

  /// 거울에서 읽은 원본으로 다시 그린다 — 답·닫힘은 거울의 ask 칸에서 읽으므로 상태는 싣지 않는다.
  /// 이 사람 화면에만 그려지므로 원본을 못 보는 사람에게 새지 않는다. 버튼은 그대로 거울 글로 답한다(`via: mirror`).
  PermissionCardInfo revealedFromRoot(String rootId) => PermissionCardInfo(
        kind: kind, mandate: mandate, line: line, once: once, ownerId: ownerId, agentId: agentId, requestChannelId: requestChannelId,
        mirrorRootId: rootId, bodyTargetLine: bodyTargetLine, warnings: warnings, bodyWarningLine: bodyWarningLine,
      );

  static PermissionCardInfo? read(Map<String, Object?> meta) {
    final pr = meta['permissionRequest'];
    if (pr is Map) {
      final via = pr['decidedVia'];
      final approvedOnce = pr['approvedOnce'];
      final gh = pr['ghUserUsed'] is String
          ? pr['ghUserUsed'] as String
          : (approvedOnce is Map && approvedOnce['ghUser'] is String ? approvedOnce['ghUser'] as String : null);
      return PermissionCardInfo(
        kind: pr['kind'] as String?,
        mandate: PermissionCardMandate.read(pr['mandate']),
        line: PermissionCardLine.read(pr['line']),
        once: PermissionCardOnce.read(pr['once']),
        status: pr['status'] as String?,
        ownerId: pr['ownerAccountId'] as String?,
        agentId: pr['agentId'] is String ? pr['agentId'] as String : null,
        requestChannelId: pr['channelId'] is String ? pr['channelId'] as String : null,
        decidedViaChat: via is Map && via['kind'] == 'chat',
        ghUserUsed: gh,
        supersededByMessageId: pr['supersededByMessageId'] is String ? pr['supersededByMessageId'] as String : null,
        bodyTargetLine: pr['bodyTargetLine'] is String ? pr['bodyTargetLine'] as String : null,
        warnings: orderedPermissionWarnings(pr['warnings']),
        bodyWarningLine: pr['bodyWarningLine'] is String ? pr['bodyWarningLine'] as String : null,
        grantedWithoutLine: pr['status'] == 'granted' && pr['kind'] != 'command' && pr['lineId'] == null && pr['grantExpiresAt'] is String,
        grantExpiresAt: pr['grantExpiresAt'] is String ? pr['grantExpiresAt'] as String : null,
      );
    }
    final mi = meta['permissionMirror'];
    if (mi is Map && mi['rootId'] is String) {
      if (mi['neutral'] == true) {
        return PermissionCardInfo(kind: null, mirrorRootId: mi['rootId'] as String, neutral: true);
      }
      final mandate = PermissionCardMandate.read(mi['mandate']);
      return PermissionCardInfo(
        kind: mi['kind'] as String?,
        mandate: mandate,
        line: PermissionCardLine.read(mi['line']),
        once: PermissionCardOnce.read(mi['once']),
        // 정할 사람 — 서버가 원본 요청 행에서 채운 칸이 먼저, 없으면(옛 서버) 위임장 칩.
        ownerId: mi['ownerAccountId'] is String ? mi['ownerAccountId'] as String : mandate?.ownerId,
        ghUserUsed: mi['ghUserUsed'] is String ? mi['ghUserUsed'] as String : null,
        mirrorRootId: mi['rootId'] as String,
        bodyTargetLine: mi['bodyTargetLine'] is String ? mi['bodyTargetLine'] as String : null,
        warnings: orderedPermissionWarnings(mi['warnings']),
        bodyWarningLine: mi['bodyWarningLine'] is String ? mi['bodyWarningLine'] as String : null,
      );
    }
    return null;
  }
}

/// H4(designer 시안 v1): 카드가 경고를 그리는 순서 — 위험한 것부터. shared `TOOL_RULE_WARNING_ORDER` 와 같다.
const permissionWarningOrder = [
  'runs_arbitrary', 'executes_in_workload', 'mutates_remote', 'unclassified', 'reads_file', 'short_prefix', 'uses_github_account',
];

/// 알려진 경고만, 그리는 순서대로.
List<String> orderedPermissionWarnings(Object? raw) {
  if (raw is! List) return const [];
  final seen = raw.whereType<String>().toSet();
  return [for (final w in permissionWarningOrder) if (seen.contains(w)) w];
}

/// `GET /agents/:id/decide-check` 응답(P1) — (에이전트, 채널)마다 같다. 보는 사람마다 다르므로 카드 meta 가 아니라 따로 받는다.
class DecideCheck {
  const DecideCheck({required this.viewerCanDecide, required this.asOwner, this.decideScope, this.ownerAccountId});

  final bool viewerCanDecide;
  final bool asOwner;

  /// `owner`·`list`·`channel`·`community`·`switchOff`. 모르면 null(화면은 소유자만 꼴로 그린다).
  final String? decideScope;
  final String? ownerAccountId;

  static DecideCheck fromJson(Map<String, Object?> j) => DecideCheck(
        viewerCanDecide: j['viewerCanDecide'] == true,
        asOwner: j['asOwner'] == true,
        decideScope: j['decideScope'] is String ? j['decideScope'] as String : null,
        ownerAccountId: j['ownerAccountId'] is String ? j['ownerAccountId'] as String : null,
      );
}
