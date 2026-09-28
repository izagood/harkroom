/// 에이전트가 남기는 **결과 발화가 아닌 말**들 — 진행·대기·보고·실패.
///
/// ## 왜 이것들을 그려야 하나
///
/// 안 그리면 **오래 도는 스레드가 조용해 보인다.** 에이전트는 `progress` 로 자기가 무엇을
/// 하는 중인지 남기고 `wake` 로 언제 다시 볼지 예약하는데, 그것을 화면이 버리면 사람은
/// "부른 게 먹혔나" 를 알 방법이 없다 — 모바일에서 특히 그렇다(터미널이 없다).
///
/// ## 모르는 모양은 평문으로 흘린다
///
/// 모든 파서가 형식을 못 갖추면 `null` 을 낸다. 데스크탑의 규약이고, 사본인 이쪽이
/// 어기면 모르는 `meta` 가 화면에서 사라진다.
library;

/// 완료 보고. `checks` 만 필수다 — 바꾼 파일이 없는 작업도 있지만
/// **무엇을 확인했는지 없는 보고는 보고가 아니다.** 비면 카드를 그리지 않고 본문만 낸다
/// (빈 상자는 "여기 뭔가 있다"는 거짓 신호다).
class ReportMeta {
  const ReportMeta({
    required this.checks,
    this.files = const [],
    this.remaining = const [],
    this.duration,
    this.next = const [],
  });

  final List<String> checks;
  final List<String> files;

  /// 이 보고가 **닫지 못한 것**. 있으면 그대로 보여 준다 — 숨기면 끝난 것처럼 보인다.
  final List<String> remaining;
  final Duration? duration;

  /// "다음으로 이걸 할까?" — 누르면 새 부탁이 된다.
  final List<ReportNext> next;

  static ReportMeta? read(Map<String, Object?> meta) {
    if (meta['kind'] != 'report') return null;
    final report = meta['report'];
    if (report is! Map) return null;
    final checks = _strings(report['checks']);
    if (checks.isEmpty) return null;
    final ms = report['durationMs'];
    return ReportMeta(
      checks: checks,
      files: _strings(report['files']),
      remaining: _strings(report['remaining']),
      duration: ms is num ? Duration(milliseconds: ms.toInt()) : null,
      next: _next(report['next']),
    );
  }
}

class ReportNext {
  const ReportNext({required this.id, required this.label});
  final String id;
  final String label;
}

/// 실패. **`retryable` 이 사람이 할 일을 가른다** — 다시 해 보면 되는 것과 손이 필요한 것.
class FailureMeta {
  const FailureMeta({this.what, this.reason, required this.retryable});

  final String? what;
  final String? reason;
  final bool retryable;

  static FailureMeta? read(Map<String, Object?> meta) {
    if (meta['kind'] != 'failure') return null;
    final failure = meta['failure'];
    if (failure is! Map) return null;
    return FailureMeta(
      what: failure['what'] as String?,
      reason: failure['reason'] as String?,
      // 모르면 **다시 해 볼 수 있다고 말하지 않는다** — 헛된 재시도를 권하는 쪽이
      // 손이 필요하다고 말하는 쪽보다 나쁘다.
      retryable: failure['retryable'] == true,
    );
  }
}

/// 대기 줄 — 에이전트가 걸어 둔 예약의 **시각**.
class WakeMeta {
  const WakeMeta({required this.wakeAt, this.reason});

  final DateTime wakeAt;
  final String? reason;

  static WakeMeta? read(Map<String, Object?> meta) {
    if (meta['kind'] != 'wake') return null;
    final wake = meta['wake'];
    if (wake is! Map) return null;
    final at = DateTime.tryParse(wake['wakeAt'] as String? ?? '');
    if (at == null) return null;
    return WakeMeta(wakeAt: at.toUtc(), reason: wake['reason'] as String?);
  }
}

List<String> _strings(Object? v) =>
    v is List ? v.whereType<String>().where((e) => e.trim().isNotEmpty).toList(growable: false) : const [];

List<ReportNext> _next(Object? v) {
  if (v is! List) return const [];
  final out = <ReportNext>[];
  for (final raw in v) {
    if (raw is! Map) continue;
    final id = raw['id'];
    final label = raw['label'];
    if (id is String && label is String && id.isNotEmpty && label.isNotEmpty) {
      out.add(ReportNext(id: id, label: label));
    }
  }
  return out;
}
