import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/thread_plan.dart';

/// 계획판 판정 규칙(개선 시안 P6) — 데스크톱 `test/threadPlanRules.test.ts` 와 **같은 자료**를 읽어 두 앱의 결과가 같은지 잰다.
void main() {
  final rules = jsonDecode(File('test/fixtures/plan_rules.json').readAsStringSync()) as Map<String, dynamic>;
  for (final c in (rules['cases'] as List).cast<Map<String, dynamic>>()) {
    final me = c['me'] as String;
    final e = c['expect'] as Map<String, dynamic>;
    final plan = ThreadPlanView.fromJson({'rev': 1, ...(c['plan'] as Map<String, dynamic>)})!;
    PlanStep step(String id) => plan.steps.firstWhere((s) => s.id == id);

    group(c['name'] as String, () {
      test('줄 순서·칩 목록', () {
        expect(planStepOrder(plan).map((s) => s.id).toList(), e['order']);
        final lists = planLists(plan, me);
        expect({for (final k in planChipKinds) k.name: lists[k]}, e['lists']);
      });

      test('칩 합 + 볼 수 없는 연결 = 전체 수, 막힘 칩 수 = 막힘 수', () {
        final lists = planLists(plan, me);
        final sum = lists.values.fold<int>(0, (n, l) => n + l.length);
        expect(sum + plan.linked.where((l) => l.hidden).length, plan.progress.total);
        expect(lists[PlanRowKind.blocked]!.length, plan.progress.blocked);
      });

      test('단계 줄', () {
        (e['rows'] as Map<String, dynamic>).forEach((id, row) {
          final links = stepFirstLinks(step(id));
          expect({
            'kind': stepKind(plan, step(id), me).name,
            'waiters': stepWaiters(plan, id),
            'pr': links.pr == null ? null : {'repo': links.pr!.repo, 'number': links.pr!.number},
            'messageId': links.messageId,
          }, row, reason: id);
        });
      });

      test('그룹 머리·알약', () {
        (e['groups'] as Map<String, dynamic>).forEach((id, g) {
          final f = groupFacts(plan, plan.groups.firstWhere((x) => x.id == id), me);
          expect({'kind': f.kind.name, 'done': f.done, 'total': f.total, 'active': f.active, 'mine': f.mine}, g, reason: id);
        });
        expect([
          for (final p in planPills(plan, me)) {'id': p.id, 'key': p.key.name, 'done': p.done, 'total': p.total, 'n': p.n},
        ], e['pills']);
      });

      test('흐름·버튼 표지', () {
        final layers = planFlow(plan);
        expect(layers, e['flow']);
        final v = e['flowVisible'] as Map<String, dynamic>;
        final flow = planFlowVisible(layers, v['max'] as int);
        expect(flow.ids, v['ids']);
        expect(flow.more, v['more']);
        expect(planButtonKind(plan.progress).name, e['buttonKind']);
      });

      test('줄을 누르면 갈 곳·시작 버튼', () {
        final humans = (c['humans'] as List).cast<String>().toSet();
        (e['go'] as Map<String, dynamic>).forEach((id, go) {
          expect([
            for (final t in stepGoTargets(step(id)))
              if (t.kind == 'pr') {'kind': 'pr', 'repo': t.repo, 'number': t.number} else {'kind': t.kind, 'id': t.id},
          ], go, reason: id);
        });
        const names = {PlanStartState.none: 'none', PlanStartState.enabled: 'enabled', PlanStartState.otherHuman: 'other_human'};
        (e['start'] as Map<String, dynamic>).forEach((id, st) {
          expect(names[stepStartState(plan, step(id), me, humans.contains)], st, reason: id);
        });
        expect(planReadyStepIds(plan), e['readyIds']);
      });

      test('막힌 까닭', () {
        (e['why'] as Map<String, dynamic>).forEach((id, why) {
          final w = stepWhy(plan, step(id), me);
          expect({
            'reason': w.reason,
            'deps': [for (final d in w.deps) {'id': d.id, 'group': d.group, 'title': d.title, 'mine': d.mine}],
            'links': [
              for (final l in w.links)
                if (l.kind == 'pr') {'kind': 'pr', 'repo': l.repo, 'number': l.number} else {'kind': l.kind, 'id': l.id},
            ],
          }, why, reason: id);
        });
      });
    });
  }

  test('칩 차례: 처음이면 첫 단계, 끝에서 다시 처음, 비면 없다', () {
    expect(nextCycleIndex(3, null), 0);
    expect(nextCycleIndex(3, 0), 1);
    expect(nextCycleIndex(3, 2), 0);
    expect(nextCycleIndex(0, null), -1);
  });

  test('자료가 데스크톱과 같은 파일이다', () {
    final desktop = File('../../packages/desktop/test/fixtures/planRules.json');
    if (!desktop.existsSync()) return;
    expect(File('test/fixtures/plan_rules.json').readAsStringSync(), desktop.readAsStringSync());
  });
}
