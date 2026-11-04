/// 스레드 계획판 — 앱이 읽는 꼴과 화면 판정(순수 함수). 데스크톱 `lib/threadPlan.ts` 와 같은 규칙이다.
///
/// 파생 상태(`derived`)는 **서버가 준 값을 그대로** 쓴다 — 앱에서 다시 계산하지 않는다. 볼 수 없는 연결 스레드를
/// 거른 맵은 서버만 안다. 모르는 필드는 무시하고, 틀린 모양은 빈 값으로 읽는다(옛 서버·새 서버 어느 쪽에도 안 죽는다).
library;

Object? _at(Object? m, String k) => m is Map ? m[k] : null;
int _n(Object? v) => v is num ? v.toInt() : 0;
String? _s(Object? v) => v is String ? v : null;
List<String> _strs(Object? v) => v is List ? v.whereType<String>().toList(growable: false) : const [];
List<Map<dynamic, dynamic>> _maps(Object? v) => v is List ? v.whereType<Map>().toList(growable: false) : const [];

/// 진행률. 목록 행의 값은 청중 기준, 판(`ThreadPlanView.progress`)의 값은 보는 사람 기준이다.
class PlanCounts {
  const PlanCounts({required this.done, required this.total, this.active = 0, this.blocked = 0, this.waiting = 0});

  final int done;
  final int total;
  final int active;
  final int blocked;
  final int waiting;

  static PlanCounts? fromJson(Object? j) {
    if (j is! Map || j['done'] is! num || j['total'] is! num) return null;
    return PlanCounts(
      done: _n(j['done']), total: _n(j['total']), active: _n(j['active']), blocked: _n(j['blocked']), waiting: _n(j['waiting']),
    );
  }
}

/// 루트 행의 `planProgress` — 진행률 + 판 번호 + (목록 행에만) 마지막 쓰기 시각.
class PlanProgressMark extends PlanCounts {
  const PlanProgressMark({
    required super.done, required super.total, super.active, super.blocked, super.waiting, required this.rev, this.updatedAt,
  });

  final int rev;

  /// 실시간 이벤트에는 없다 — 없으면 rev 만 견준다.
  final DateTime? updatedAt;

  static PlanProgressMark? fromJson(Object? j) {
    final c = PlanCounts.fromJson(j);
    if (c == null || _at(j, 'rev') is! num) return null;
    return PlanProgressMark(
      done: c.done, total: c.total, active: c.active, blocked: c.blocked, waiting: c.waiting,
      rev: _n(_at(j, 'rev')), updatedAt: DateTime.tryParse(_s(_at(j, 'updatedAt')) ?? '')?.toUtc(),
    );
  }

  /// `thread.plan.changed` 의 값. 계획이 지워졌으면(rev null·progress null) null.
  static PlanProgressMark? fromEvent(Object? rev, Object? progress) {
    final c = PlanCounts.fromJson(progress);
    if (c == null || rev is! num) return null;
    return PlanProgressMark(done: c.done, total: c.total, active: c.active, blocked: c.blocked, waiting: c.waiting, rev: rev.toInt());
  }
}

/// 파생 상태. 서버 `PlanDerivedState` 와 같다.
enum PlanState {
  done, active, blocked, waiting, ready, hidden;

  static PlanState parse(Object? v) => switch (v) {
        'done' => done,
        'active' => active,
        'blocked' => blocked,
        'ready' => ready,
        'hidden' => hidden,
        _ => waiting,
      };
}

class PlanGroup {
  const PlanGroup({required this.id, required this.title, this.assigneeId, this.linkedRootId, this.dependsOn = const []});

  final String id;
  final String title;
  final String? assigneeId;
  final String? linkedRootId;
  final List<String> dependsOn;
}

class PlanStep {
  const PlanStep({
    required this.id, required this.title, required this.declared, this.groupId, this.assigneeId, this.blockedReason, this.dependsOn = const [],
  });

  final String id;
  final String title;
  final String declared;
  final String? groupId;
  final String? assigneeId;
  final String? blockedReason;
  final List<String> dependsOn;
}

class PlanNode {
  const PlanNode({required this.state, this.waitingOn = const []});

  final PlanState state;
  final List<String> waitingOn;
}

class PlanLinked {
  const PlanLinked({required this.groupId, required this.rootId, required this.hidden, this.channelId, this.progress});

  final String groupId;
  final String rootId;
  final bool hidden;
  final String? channelId;
  final PlanCounts? progress;
}

/// `GET /threads/:rootId/plan` 의 판.
class ThreadPlanView {
  const ThreadPlanView({
    required this.rootId, required this.rev, required this.updatedAt, required this.goal,
    required this.groups, required this.steps, required this.derived, required this.progress, required this.linked,
    this.next, this.blocked, this.flagged = false, this.updatedBy,
  });

  final String rootId;
  final int rev;
  final DateTime? updatedAt;
  final String goal;
  final List<PlanGroup> groups;
  final List<PlanStep> steps;
  final Map<String, PlanNode> derived;
  final PlanCounts progress;
  final List<PlanLinked> linked;
  final String? next;
  final String? blocked;
  final bool flagged;

  /// 마지막으로 쓴 계정 id. 자동 갱신·지워진 계정이면 null.
  final String? updatedBy;

  /// 서버 파생 상태. 맵에 없으면 단계는 선언 상태로, 그룹은 대기로 본다(데스크톱과 같다).
  PlanState stateOf(String id) {
    final node = derived[id];
    if (node != null) return node.state;
    for (final s in steps) {
      if (s.id == id) return s.declared == 'pending' ? PlanState.waiting : PlanState.parse(s.declared);
    }
    return PlanState.waiting;
  }

  List<PlanStep> stepsOf(String? groupId) =>
      steps.where((s) => groupId == null ? s.groupId == null : s.groupId == groupId).toList(growable: false);

  PlanLinked? linkedOf(String groupId) {
    for (final l in linked) {
      if (l.groupId == groupId) return l;
    }
    return null;
  }

  static ThreadPlanView? fromJson(Object? j) {
    if (j is! Map || j['rev'] is! num) return null;
    final doc = j['doc'];
    final derived = <String, PlanNode>{};
    final d = j['derived'];
    if (d is Map) {
      d.forEach((k, v) {
        if (k is String) derived[k] = PlanNode(state: PlanState.parse(_at(v, 'derived')), waitingOn: _strs(_at(v, 'waitingOn')));
      });
    }
    return ThreadPlanView(
      rootId: _s(j['rootId']) ?? '',
      rev: _n(j['rev']),
      updatedAt: DateTime.tryParse(_s(j['updatedAt']) ?? '')?.toUtc(),
      goal: _s(_at(doc, 'goal')) ?? '',
      next: _s(_at(doc, 'next')),
      blocked: _s(_at(doc, 'blocked')),
      flagged: j['flagged'] != null,
      updatedBy: _s(j['updatedBy']),
      groups: _maps(_at(doc, 'groups'))
          .map((g) => PlanGroup(
                id: _s(g['id']) ?? '', title: _s(g['title']) ?? '', assigneeId: _s(g['assigneeId']),
                linkedRootId: _s(g['linkedRootId']), dependsOn: _strs(g['dependsOn']),
              ))
          .toList(growable: false),
      steps: _maps(_at(doc, 'steps'))
          .map((s) => PlanStep(
                id: _s(s['id']) ?? '', title: _s(s['title']) ?? '', declared: _s(s['state']) ?? 'pending', groupId: _s(s['groupId']),
                assigneeId: _s(s['assigneeId']), blockedReason: _s(s['blockedReason']), dependsOn: _strs(s['dependsOn']),
              ))
          .toList(growable: false),
      derived: derived,
      progress: PlanCounts.fromJson(j['progress']) ?? const PlanCounts(done: 0, total: 0),
      linked: _maps(j['linked'])
          .map((l) => PlanLinked(
                groupId: _s(l['groupId']) ?? '', rootId: _s(l['rootId']) ?? '', hidden: l['hidden'] == true,
                channelId: _s(l['channelId']), progress: PlanCounts.fromJson(l['progress']),
              ))
          .toList(growable: false),
    );
  }
}

/// 24시간 넘게 안 고친 판은 「낡았을 수 있음」(D3). 시각을 모르면 낡지 않은 것으로 본다.
const Duration planStaleAfter = Duration(hours: 24);
bool isPlanStale(DateTime? updatedAt, DateTime now) => updatedAt != null && now.difference(updatedAt) > planStaleAfter;

/// 그룹 하나의 진행 수. 연결 그룹은 서버가 준 자식 진행률, 볼 수 없으면 null.
({int done, int total})? groupCount(ThreadPlanView plan, PlanGroup g) {
  if (g.linkedRootId != null) {
    final l = plan.linkedOf(g.id);
    final p = l?.progress;
    return l != null && !l.hidden && p != null ? (done: p.done, total: p.total) : null;
  }
  final steps = plan.stepsOf(g.id);
  return (done: steps.where((s) => plan.stateOf(s.id) == PlanState.done).length, total: steps.length);
}

class PlanPill {
  const PlanPill({required this.id, required this.title, required this.state, required this.count});

  final String id;
  final String title;
  final PlanState state;
  final ({int done, int total})? count;
}

const Map<PlanState, int> _pillRank = {
  PlanState.blocked: 0, PlanState.active: 1, PlanState.ready: 2, PlanState.waiting: 3, PlanState.hidden: 4, PlanState.done: 5,
};

/// 그룹 알약(D7) — 막힘 먼저, 그다음 진행·시작 가능·대기·끝남. 같은 순위는 문서 순서.
List<PlanPill> planPills(ThreadPlanView plan) {
  final all = [
    for (var i = 0; i < plan.groups.length; i++)
      (i: i, pill: PlanPill(id: plan.groups[i].id, title: plan.groups[i].title, state: plan.stateOf(plan.groups[i].id), count: groupCount(plan, plan.groups[i]))),
  ];
  all.sort((a, b) {
    final r = _pillRank[a.pill.state]!.compareTo(_pillRank[b.pill.state]!);
    return r != 0 ? r : a.i.compareTo(b.i);
  });
  return all.map((e) => e.pill).toList(growable: false);
}

/// 그룹이 넷 이상이면 알약 대신 쓰는 개수 요약.
({int groups, int active, int blocked, String? firstBlocked})? planSummary(List<PlanPill> pills) {
  if (pills.length < 4) return null;
  String? first;
  for (final p in pills) {
    if (p.state == PlanState.blocked) {
      first = p.title;
      break;
    }
  }
  return (
    groups: pills.length,
    active: pills.where((p) => p.state == PlanState.active).length,
    blocked: pills.where((p) => p.state == PlanState.blocked).length,
    firstBlocked: first,
  );
}

/// 이 노드가 속한 그룹 id(그룹이면 자기 자신). 그룹 밖 단계는 null.
String? _groupOf(ThreadPlanView plan, String id) {
  for (final g in plan.groups) {
    if (g.id == id) return id;
  }
  for (final s in plan.steps) {
    if (s.id == id) return s.groupId;
  }
  return null;
}

/// 흐름(D5) — 그룹을 의존 층으로 묶는다. 같은 층은 서로 기다리지 않는 그룹(동시에 진행), 층 사이는 ⟶.
/// 그룹의 앞 노드는 그 그룹의 dependsOn 과 그 안 단계가 다른 그룹을 기다리는 것 모두다. 그룹이 없으면 빈 목록.
List<List<String>> planFlow(ThreadPlanView plan) {
  if (plan.groups.isEmpty) return const [];
  final before = {for (final g in plan.groups) g.id: <String>{}};
  void add(String? from, String dep) {
    final to = _groupOf(plan, dep);
    if (from != null && to != null && to != from) before[from]?.add(to);
  }

  for (final g in plan.groups) {
    for (final d in g.dependsOn) {
      add(g.id, d);
    }
  }
  for (final s in plan.steps) {
    for (final d in s.dependsOn) {
      add(s.groupId, d);
    }
  }
  // 가장 긴 앞 사슬의 길이가 층이다. 순환은 서버가 막지만, 돌지 않게 깊이를 그룹 수로 묶는다.
  final depth = <String, int>{};
  int level(String id, int guard) {
    final known = depth[id];
    if (known != null) return known;
    if (guard > plan.groups.length) return 0;
    var d = 0;
    for (final b in before[id] ?? const <String>{}) {
      final l = level(b, guard + 1) + 1;
      if (l > d) d = l;
    }
    depth[id] = d;
    return d;
  }

  final layers = <int, List<String>>{};
  for (final g in plan.groups) {
    layers.putIfAbsent(level(g.id, 0), () => []).add(g.id);
  }
  final keys = layers.keys.toList()..sort();
  return [for (final k in keys) layers[k]!];
}

/// 노드 id → 제목. 없는 id 는 id 그대로.
String planTitleOf(ThreadPlanView plan, String id) {
  for (final g in plan.groups) {
    if (g.id == id) return g.title;
  }
  for (final s in plan.steps) {
    if (s.id == id) return s.title;
  }
  return id;
}

/// 「앞: 그룹 · 단계」 의 그룹 이름(D6). 같은 그룹이거나, 앞이 그룹 자체이거나, 그룹 밖이면 null.
String? crossGroupTitle(ThreadPlanView plan, String depId, String? fromGroupId) {
  final g = _groupOf(plan, depId);
  if (g == null || g == depId || g == fromGroupId) return null;
  return planTitleOf(plan, g);
}

/// 처음 펼쳐 둘 그룹인가 — 막힘·진행 그룹만 펼친다(시안 v3).
bool planGroupStartsOpen(PlanState s) => s == PlanState.blocked || s == PlanState.active;

/// 칩의 색. 막힘만 빨강(D2).
enum PlanTone { blocked, done, active, empty }

PlanTone planTone(PlanCounts? p) {
  if (p == null || p.total == 0) return PlanTone.empty;
  if (p.blocked > 0) return PlanTone.blocked;
  if (p.done >= p.total) return PlanTone.done;
  return PlanTone.active;
}

/// 들고 있는 판을 다시 받아야 하는가(데스크톱 R3). rev 는 「크다」가 아니라 **다르다**로 견준다 — 계획을 지웠다 다시 세우면
/// 1로 돌아간다. 행의 updatedAt 은 앱이 꺼진 사이 다시 세워 rev 가 우연히 같을 때를 잡는다(실시간 이벤트에는 없어 그때는 rev 만 본다).
bool planNeedsFetch(ThreadPlanView? held, PlanProgressMark mark) {
  if (held == null || held.rev != mark.rev) return true;
  final rowAt = mark.updatedAt;
  final heldAt = held.updatedAt;
  return rowAt != null && heldAt != null && heldAt.isBefore(rowAt);
}
