/// 권한 카드(W4 위임장) — 서버가 카드 meta `permissionRequest`(원본) 또는 `permissionMirror`(거울)에 적는 칸을 읽는다.
/// 계약은 shared `permissionCard.ts`. 값은 언제나 서버가 쓴다 — 화면은 읽어 그리기만 한다.
library;

/// 선택지 id(shared `PERMISSION_CARD_OPTION`).
const String permOptApproveMandate = 'approve_mandate';
const String permOptApproveNewMandate = 'approve_new_mandate';
const String permOptApproveOnce = 'approve_once';
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
  const PermissionCardLimits({this.untilMs, this.uses, this.pr, this.head, this.ciOverride = false});
  final int? untilMs;
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
    this.decidedViaChat = false,
    this.ghUserUsed,
    this.mirrorRootId,
    this.neutral = false,
    this.supersededByMessageId,
    this.bodyTargetLine,
  });

  final String? kind;
  final PermissionCardMandate? mandate;
  final PermissionCardLine? line;
  final PermissionCardOnce? once;

  /// 원본의 `status`(pending·granted·approved_once·denied·expired·superseded·obsolete). 거울은 없다 — 답·닫힘은 ask 칸에서 읽는다.
  final String? status;

  /// 정할 수 있는 사람(원본의 `ownerAccountId`, 거울은 위임장 소유자). 모르면 null — 서버가 판정한다.
  final String? ownerId;
  final bool decidedViaChat;

  /// 이번 한 번 머지에 실제로 쓴 gh 계정(서버가 알려 줄 때만).
  final String? ghUserUsed;
  final String? mirrorRootId;
  final bool neutral;
  final String? supersededByMessageId;

  /// r5: 본문 속 서버가 쓴 대상 줄(줄 카드만). 줄 상자를 그리는 화면은 본문에서 이 줄 하나만 뺀다.
  final String? bodyTargetLine;

  bool get isMirror => mirrorRootId != null;

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
        decidedViaChat: via is Map && via['kind'] == 'chat',
        ghUserUsed: gh,
        supersededByMessageId: pr['supersededByMessageId'] is String ? pr['supersededByMessageId'] as String : null,
        bodyTargetLine: pr['bodyTargetLine'] is String ? pr['bodyTargetLine'] as String : null,
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
        ownerId: mandate?.ownerId,
        ghUserUsed: mi['ghUserUsed'] is String ? mi['ghUserUsed'] as String : null,
        mirrorRootId: mi['rootId'] as String,
        bodyTargetLine: mi['bodyTargetLine'] is String ? mi['bodyTargetLine'] as String : null,
      );
    }
    return null;
  }
}
