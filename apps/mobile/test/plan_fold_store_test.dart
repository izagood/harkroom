import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/session/plan_fold_store.dart';
import 'package:harkroom/session/session_store.dart';
import 'package:harkroom/state/app_state.dart';

void main() {
  AppState boot(PlanFoldStore store) =>
      AppState(sessions: SessionStore.inMemory(), planFoldStore: store)..activeKey = 'k1';

  test('앱을 다시 켜도(새 AppState) 스레드 id + 그룹 id 로 기억이 돌아온다', () async {
    final store = MemoryPlanFoldStore();
    final a = boot(store);
    await a.savePlanFold('r1', 'g5', false);
    await a.savePlanFold('r1', 'g1', true);
    final b = boot(store);
    expect(await b.loadPlanFolds('r1'), {'g5': false, 'g1': true});
    expect(await b.loadPlanFolds('r2'), isEmpty);
  });

  test('스레드가 넘치면 가장 오래 안 고친 것부터 버린다', () async {
    final store = MemoryPlanFoldStore();
    final a = boot(store);
    for (var i = 0; i <= AppState.planFoldThreadsMax; i++) {
      await a.savePlanFold('r$i', 'g1', true);
    }
    final saved = store.values['k1']!;
    expect(saved.length, AppState.planFoldThreadsMax);
    expect(saved.containsKey('r0'), isFalse);
    expect(saved.containsKey('r${AppState.planFoldThreadsMax}'), isTrue);
  });

  test('저장된 꼴이 틀리면 고른 것만 남긴다', () {
    expect(parsePlanFolds({'r1': {'g1': true, 'g2': 'x'}, 'r2': 3, 'r3': {}}), {'r1': {'g1': true}});
    expect(parsePlanFolds('x'), isEmpty);
  });
}
