import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/api/thread_plan.dart';

/// shared `planGraph.ts` 와 같은 자료로 같은 규칙을 잰다.
void main() {
  final rules = jsonDecode(File('test/fixtures/plan_ref.json').readAsStringSync()) as Map<String, dynamic>;
  Map<String, dynamic>? asMap(PlanRef? r) => r == null ? null : {'rootId': r.rootId, 'stepId': r.stepId, 'title': r.title};

  test('자료가 shared 와 같은 파일이다', () {
    final shared = File('../../packages/shared/test/fixtures/planRef.json');
    if (!shared.existsSync()) return;
    expect(File('test/fixtures/plan_ref.json').readAsStringSync(), shared.readAsStringSync());
  });

  for (final c in (rules['parse'] as List).cast<Map<String, dynamic>>()) {
    test('읽기: ${c['in']}', () => expect(asMap(parsePlanRef(c['in'] as String)), c['out']));
  }
  for (final c in (rules['find'] as List).cast<Map<String, dynamic>>()) {
    test('찾기: ${c['in']}', () {
      expect([for (final r in findPlanRefs(c['in'] as String)) {...asMap(r)!, 'index': r.index}], c['out']);
    });
  }
  for (final c in (rules['text'] as List).cast<Map<String, dynamic>>()) {
    test('짓기: ${c['title']}', () => expect(planRefText(c['root'] as String, c['step'] as String, c['title'] as String), c['out']));
  }
  final kinds = (rules['kinds'] as Map<String, dynamic>).cast<String, String>();
  for (final c in (rules['recipient'] as List).cast<Map<String, dynamic>>()) {
    test('받는 이: ${c['doc']}', () {
      final doc = c['doc'] as Map<String, dynamic>;
      final steps = (doc['steps'] as List).cast<Map<String, dynamic>>();
      final groups = (doc['groups'] as List).cast<Map<String, dynamic>>();
      final step = steps.where((s) => s['id'] == c['step']).firstOrNull;
      final group = groups.where((g) => g['id'] == step?['groupId']).firstOrNull;
      final who = planAskRecipient(
        managerId: doc['managerId'] as String?,
        assigneeId: (step?['assigneeId'] ?? group?['assigneeId']) as String?,
        isAgent: (id) => kinds[id] == 'agent',
      );
      final out = c['out'] as Map<String, dynamic>;
      expect(who.to, out['to']);
      expect(who.reason, out['reason']);
    });
  }
}
