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

/// 단계의 연결. 꼴은 서버가 검사하지만 앱 밖으로 나가는 주소는 [stepFirstLinks]·[stepWhy] 가 다시 본다.
class PlanLink {
  const PlanLink({required this.kind, this.repo, this.number, this.id});

  /// `pr`·`message`·`card`·`workitem`.
  final String kind;
  final String? repo;
  final int? number;
  final String? id;

  static PlanLink fromJson(Map<dynamic, dynamic> j) => PlanLink(
        kind: _s(j['kind']) ?? '',
        repo: _s(j['repo']),
        number: j['number'] is num ? (j['number']! as num).toInt() : null,
        id: _s(j['id']) ?? _s(j['messageId']),
      );
}

class PlanStep {
  const PlanStep({
    required this.id, required this.title, required this.declared, this.groupId, this.assigneeId, this.blockedReason,
    this.dependsOn = const [], this.links = const [],
  });

  final String id;
  final String title;
  final String declared;
  final String? groupId;
  final String? assigneeId;
  final String? blockedReason;
  final List<String> dependsOn;
  final List<PlanLink> links;
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
    this.next, this.blocked, this.flagged = false, this.updatedBy, this.managerId,
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

  /// 관리 에이전트(계정 id). 있으면 「시작」은 담당 대신 이 에이전트를 부른다. 없으면 담당을 직접 부른다.
  final String? managerId;

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
      managerId: _s(_at(doc, 'managerId')),
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
                links: _maps(s['links']).map(PlanLink.fromJson).toList(growable: false),
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

/// 단계 한 줄의 갈래(개선 시안 R1). 서버 파생 상태에 「보는 사람」을 얹은 것이다 — 내 차례는 사람마다 달라 서버가 줄 수 없다.
/// 진행·시작 가능인 단계의 담당이 나면 내 차례다. **막힘은 내 것이어도 막힘으로 둔다** — 「막힌 까닭」과 막힘 칩이 찾아야 한다.
enum PlanRowKind { done, active, blocked, mine, ready, waiting, hidden }

/// 맨 위 상태 칩의 차례.
const List<PlanRowKind> planChipKinds = [
  PlanRowKind.done, PlanRowKind.active, PlanRowKind.blocked, PlanRowKind.mine, PlanRowKind.ready, PlanRowKind.waiting,
];

PlanRowKind _kindOf(PlanState s) => switch (s) {
      PlanState.done => PlanRowKind.done,
      PlanState.active => PlanRowKind.active,
      PlanState.blocked => PlanRowKind.blocked,
      PlanState.ready => PlanRowKind.ready,
      PlanState.waiting => PlanRowKind.waiting,
      PlanState.hidden => PlanRowKind.hidden,
    };

/// 담당 — 단계에 없으면 그룹 담당을 물려받는다.
String? stepAssignee(ThreadPlanView plan, PlanStep step) {
  if (step.assigneeId != null) return step.assigneeId;
  for (final g in plan.groups) {
    if (g.id == step.groupId) return g.assigneeId;
  }
  return null;
}

PlanRowKind stepKind(ThreadPlanView plan, PlanStep step, String? me) {
  final state = plan.stateOf(step.id);
  if ((state == PlanState.active || state == PlanState.ready) && me != null && stepAssignee(plan, step) == me) {
    return PlanRowKind.mine;
  }
  return _kindOf(state);
}

/// 화면의 줄 순서 — 그룹을 문서 순서로, 그 안의 단계를 문서 순서로, 그룹 밖 단계는 맨 뒤. 상태가 바뀌어도 줄이 자리를 옮기지 않는다(W2).
List<PlanStep> planStepOrder(ThreadPlanView plan) {
  final known = {for (final g in plan.groups) g.id};
  return [
    for (final g in plan.groups) ...plan.stepsOf(g.id),
    ...plan.steps.where((s) => s.groupId == null || !known.contains(s.groupId)),
  ];
}

/// 칩의 목록 — 칩이 보여 주는 수이자 누를 때 차례로 갈 단계들이다. 한 칸은 한 목록에만 든다.
/// 서버 `planProgress` 와 같은 단위로 센다: 단계 하나씩 + **연결 그룹 하나당 한 칸**(파생 상태 그대로, 누르면 그 그룹으로 간다).
/// 안 그러면 연결 그룹이 막혔을 때 「막힘 1」은 보이는데 막힘 칩이 꺼진다. 볼 수 없는 연결 그룹은 갈 곳이 없어 빠진다 — `progress.total` 에는 든다.
Map<PlanRowKind, List<String>> planLists(ThreadPlanView plan, String? me) {
  final out = {for (final k in planChipKinds) k: <String>[]};
  final known = {for (final g in plan.groups) g.id};
  for (final g in plan.groups) {
    if (g.linkedRootId != null) out[_kindOf(plan.stateOf(g.id))]?.add(g.id);
    for (final s in plan.stepsOf(g.id)) {
      out[stepKind(plan, s, me)]?.add(s.id);
    }
  }
  for (final s in plan.steps) {
    if (s.groupId == null || !known.contains(s.groupId)) out[stepKind(plan, s, me)]?.add(s.id);
  }
  return out;
}

/// 이 단계를 앞 단계로 둔 막힌 단계(문서 순서) — 내 차례 줄의 「막힌 n건이 기다린다」.
List<String> stepWaiters(ThreadPlanView plan, String stepId) => [
      for (final s in planStepOrder(plan))
        if (s.dependsOn.contains(stepId) && plan.stateOf(s.id) == PlanState.blocked) s.id,
    ];

final RegExp _prRepo = RegExp(r'^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$');
bool _validPr(PlanLink l) => l.kind == 'pr' && l.repo != null && _prRepo.hasMatch(l.repo!) && (l.number ?? 0) > 0;

/// 단계 줄 끝에 둘 첫 PR(꼴이 맞는 것만)과 첫 글(메시지·카드).
({({String repo, int number})? pr, String? messageId}) stepFirstLinks(PlanStep step) {
  ({String repo, int number})? pr;
  String? messageId;
  for (final l in step.links) {
    if (pr == null && _validPr(l)) pr = (repo: l.repo!, number: l.number!);
    if (messageId == null && (l.kind == 'message' || l.kind == 'card')) messageId = l.id;
  }
  return (pr: pr, messageId: messageId);
}

String prUrl(({String repo, int number}) pr) => 'https://github.com/${pr.repo}/pull/${pr.number}';

/// 줄을 누르면 갈 곳(시안 v4 R14) — 카드 → 메시지 → PR 순서. 앱 안에서 가는 것이 먼저고 PR 은 밖이라 마지막이다.
/// 작업 항목은 id 만으로 갈 화면이 없어 넣지 않는다. 비면 누를 수 없는 줄이다.
typedef PlanGoTarget = ({String kind, String? id, String? repo, int? number});

List<PlanGoTarget> stepGoTargets(PlanStep step) => [
      for (final l in step.links)
        if (l.kind == 'card' && l.id != null) (kind: 'card', id: l.id, repo: null, number: null),
      for (final l in step.links)
        if (l.kind == 'message' && l.id != null) (kind: 'message', id: l.id, repo: null, number: null),
      for (final l in step.links)
        if (_validPr(l)) (kind: 'pr', id: null, repo: l.repo, number: l.number),
    ];

/// 「▷ 시작」(R13·A안) — 시작 가능한 단계에만 있다. 관리 에이전트가 있으면 담당과 상관없이 그쪽으로 간다.
/// 없을 때 담당이 나 아닌 사람이면 꺼 둔다(그 사람이 시작한다). 담당이 없거나 에이전트면 켠다(담당 없음은 확인 시트에서 고른다).
enum PlanStartState { none, enabled, otherHuman }

PlanStartState stepStartState(ThreadPlanView plan, PlanStep step, String? me, bool Function(String id) isHuman) {
  if (plan.stateOf(step.id) != PlanState.ready) return PlanStartState.none;
  if (plan.managerId != null) return PlanStartState.enabled;
  final a = stepAssignee(plan, step);
  return a != null && a != me && isHuman(a) ? PlanStartState.otherHuman : PlanStartState.enabled;
}

/// 「모두 시작」의 후보 — 「시작 가능」 칩과 같은 단계(문서 순서). 내 차례는 뺀다. 고를 수 없는 줄은 서버 미리보기가 사유를 준다.
List<String> planReadyStepIds(ThreadPlanView plan, String? me) => [
      for (final s in planStepOrder(plan))
        if (stepKind(plan, s, me) == PlanRowKind.ready) s.id,
    ];

class PlanStartPost {
  const PlanStartPost({required this.to, required this.via, required this.stepIds, required this.body});

  final String to;

  /// `manager`·`assignee`.
  final String via;
  final List<String> stepIds;
  final String body;
}

/// `POST /threads/:root/plan/start` 의 `dryRun` 응답. 서버가 지은 글을 그대로 보인다.
class PlanStartPreview {
  const PlanStartPreview({required this.rev, required this.posts, required this.selfStepIds, required this.skipped, this.managerSkipped});

  final int rev;
  final List<PlanStartPost> posts;
  final List<String> selfStepIds;
  final List<({String id, String code})> skipped;
  final String? managerSkipped;

  int get startable => posts.fold<int>(0, (n, p) => n + p.stepIds.length) + selfStepIds.length;

  static PlanStartPreview fromJson(Object? j) => PlanStartPreview(
        rev: _n(_at(j, 'rev')),
        posts: _maps(_at(j, 'posts'))
            .map((p) => PlanStartPost(to: _s(p['to']) ?? '', via: _s(p['via']) ?? 'assignee', stepIds: _strs(p['stepIds']), body: _s(p['body']) ?? ''))
            .toList(growable: false),
        selfStepIds: _strs(_at(j, 'selfStepIds')),
        skipped: _maps(_at(j, 'skipped')).map((s) => (id: _s(s['id']) ?? '', code: _s(s['code']) ?? '')).toList(growable: false),
        managerSkipped: _s(_at(j, 'managerSkipped')),
      );
}

/// 실제 시작 응답.
class PlanStartDone {
  const PlanStartDone({required this.started, required this.plan, this.skipped = const [], this.failed = const [], this.notNotified = const []});

  final List<({String id, String? messageId})> started;
  final ThreadPlanView? plan;
  final List<({String id, String code})> skipped;
  final List<String> failed;
  final List<String> notNotified;

  /// 알릴 것이 없는가 — 있으면 확인 시트를 닫지 않고 보인다(글 실패·그 사이 남이 시작·못 알림).
  bool get clean => skipped.isEmpty && failed.isEmpty && notNotified.isEmpty;

  static PlanStartDone fromJson(Object? j) => PlanStartDone(
        started: _maps(_at(j, 'started')).map((s) => (id: _s(s['id']) ?? '', messageId: _s(s['messageId']))).toList(growable: false),
        plan: ThreadPlanView.fromJson(_at(j, 'plan')),
        skipped: _maps(_at(j, 'skipped')).map((s) => (id: _s(s['id']) ?? '', code: _s(s['code']) ?? '')).toList(growable: false),
        failed: _maps(_at(j, 'failed')).map((f) => _s(f['id']) ?? '').toList(growable: false),
        notNotified: _strs(_at(j, 'notNotified')),
      );
}

/// 그룹 머리의 표지·수. 막힘이 먼저고, 내 단계가 있으면 내 차례, 그 밖은 서버 파생 상태다.
({PlanRowKind kind, int done, int total, int active, int mine}) groupFacts(ThreadPlanView plan, PlanGroup g, String? me) {
  final kinds = plan.stepsOf(g.id).map((s) => stepKind(plan, s, me)).toList(growable: false);
  final c = groupCount(plan, g);
  final mine = kinds.where((k) => k == PlanRowKind.mine).length;
  final state = plan.stateOf(g.id);
  return (
    kind: state == PlanState.blocked ? PlanRowKind.blocked : (mine > 0 ? PlanRowKind.mine : _kindOf(state)),
    done: c?.done ?? 0,
    total: c?.total ?? 0,
    active: kinds.where((k) => k == PlanRowKind.active).length,
    mine: mine,
  );
}

enum PlanPillKey { done, blocked, mine, active, waiting, waitingCount, count, plain }

class PlanPill {
  const PlanPill({required this.id, required this.title, required this.state, required this.key, required this.done, required this.total, required this.n});

  final String id;
  final String title;
  final PlanState state;
  final PlanPillKey key;
  final int done;
  final int total;
  final int n;
}

const Map<PlanState, int> _pillRank = {
  PlanState.blocked: 0, PlanState.active: 1, PlanState.ready: 2, PlanState.waiting: 3, PlanState.hidden: 4, PlanState.done: 5,
};

/// 그룹 알약 — 막힘 먼저, 그다음 진행·시작 가능·대기·끝남. 같은 순위는 문서 순서(D7).
/// 글자(R3): 막힘 「{그룹} 막힘 d/t」 · 내 차례 「{그룹} 내 차례 n」 · 진행 「{그룹} 진행 n · d/t」 · 그 밖은 앞과 같다.
List<PlanPill> planPills(ThreadPlanView plan, String? me) {
  final all = <(int, PlanPill)>[];
  for (var i = 0; i < plan.groups.length; i++) {
    final g = plan.groups[i];
    final f = groupFacts(plan, g, me);
    final c = groupCount(plan, g);
    final state = plan.stateOf(g.id);
    var key = PlanPillKey.plain;
    var n = 0;
    if (state == PlanState.done) {
      key = PlanPillKey.done;
    } else if (state == PlanState.blocked && c != null) {
      key = PlanPillKey.blocked;
    } else if (f.mine > 0) {
      key = PlanPillKey.mine;
      n = f.mine;
    } else if (f.active > 0 && c != null) {
      key = PlanPillKey.active;
      n = f.active;
    } else if (state == PlanState.waiting) {
      key = c != null && c.total > 0 && c.done > 0 ? PlanPillKey.waitingCount : PlanPillKey.waiting;
    } else if (c != null && c.total > 0 && state != PlanState.hidden) {
      key = PlanPillKey.count;
    }
    all.add((i, PlanPill(id: g.id, title: g.title, state: state, key: key, done: f.done, total: f.total, n: n)));
  }
  all.sort((a, b) {
    final r = _pillRank[a.$2.state]!.compareTo(_pillRank[b.$2.state]!);
    return r != 0 ? r : a.$1.compareTo(b.$1);
  });
  return all.map((e) => e.$2).toList(growable: false);
}

/// 머리 흐름(W4) — 앞에서 [max] 개만 두고 나머지는 「+n 그룹 ›」.
({List<String> ids, int more}) planFlowVisible(List<List<String>> layers, int max) {
  final ids = [for (final l in layers) ...l];
  return (ids: ids.take(max).toList(growable: false), more: ids.length > max ? ids.length - max : 0);
}

/// 칩을 거듭 누를 때 다음 차례. 처음이거나 다른 칩에서 왔으면 첫 단계부터. 비면 -1.
int nextCycleIndex(int length, int? current) {
  if (length == 0) return -1;
  return current == null ? 0 : (current + 1) % length;
}

/// 「막힌 까닭」 상자(R9) — 사유 전문 → 끝나지 않은 앞 단계(단계 자신과 그 그룹의 dependsOn) → 연결(꼴이 틀린 PR 은 뺀다).
({String? reason, List<({String id, String? group, String title, bool mine})> deps, List<PlanLink> links}) stepWhy(
  ThreadPlanView plan,
  PlanStep step,
  String? me,
) {
  PlanGroup? parent;
  for (final g in plan.groups) {
    if (g.id == step.groupId) parent = g;
  }
  final seen = <String>{};
  final deps = <({String id, String? group, String title, bool mine})>[];
  for (final id in [...step.dependsOn, ...?parent?.dependsOn]) {
    if (!seen.add(id) || plan.stateOf(id) == PlanState.done) continue;
    PlanStep? dep;
    for (final s in plan.steps) {
      if (s.id == id) dep = s;
    }
    deps.add((
      id: id,
      group: crossGroupTitle(plan, id, step.groupId),
      title: planTitleOf(plan, id),
      mine: dep != null && stepKind(plan, dep, me) == PlanRowKind.mine,
    ));
  }
  return (
    reason: step.blockedReason,
    deps: deps,
    links: [for (final l in step.links) if (l.kind != 'pr' || _validPr(l)) l],
  );
}

/// 떠 있는 버튼의 표지. 막힘이 먼저다 — 닫힌 채로도 막힘이 보여야 한다(W5).
PlanRowKind planButtonKind(PlanCounts p) {
  if (p.blocked > 0) return PlanRowKind.blocked;
  if (p.total > 0 && p.done >= p.total) return PlanRowKind.done;
  if (p.active > 0) return PlanRowKind.active;
  return p.done > 0 ? PlanRowKind.ready : PlanRowKind.waiting;
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
