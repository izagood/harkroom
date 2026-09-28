import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/session/session_store.dart';

StoredCommunity _c(String id, {String url = 'https://a.example.com', String? label}) =>
    StoredCommunity(accountId: id, baseUrl: url, token: 't-$id', handle: 'h-$id', label: label);

void main() {
  group('키는 계정 id 다', () {
    test('같은 서버에 다른 주소로 들어가도 목록에 두 번 서지 않는다', () async {
      // 실제로 겪는 상황: 사내망 이름으로 한 번, 공개 도메인으로 한 번 로그인한다.
      // URL 로 키를 두면 같은 커뮤니티가 둘이 된다.
      final store = SessionStore.inMemory();
      await store.upsert(_c('acct-1', url: 'https://lan.example.com'));
      final after = await store.upsert(_c('acct-1', url: 'https://public.example.com'));

      expect(after.communities.length, 1);
      expect(after.communities.single.baseUrl, 'https://public.example.com');
    });

    test('다른 계정은 따로 쌓인다', () async {
      final store = SessionStore.inMemory();
      await store.upsert(_c('a'));
      final after = await store.upsert(_c('b'));
      expect(after.communities.map((c) => c.accountId), ['a', 'b']);
      expect(after.active, 'b');
    });

    test('다시 로그인해도 목록 순서가 바뀌지 않는다', () async {
      // 뒤로 밀면 사람은 자기가 무엇을 건드렸는지 모른다.
      final store = SessionStore.inMemory();
      await store.upsert(_c('a'));
      await store.upsert(_c('b'));
      final after = await store.upsert(_c('a'));
      expect(after.communities.map((c) => c.accountId), ['a', 'b']);
    });
  });

  group('하나를 빼도 나머지는 산다', () {
    test('지운 것이 활성이었으면 active 를 비운다', () async {
      final store = SessionStore.inMemory();
      await store.upsert(_c('a'));
      await store.upsert(_c('b'));
      await store.remove('b');

      final after = await store.load();
      expect(after!.communities.map((c) => c.accountId), ['a']);
      expect(after.active, isNull);
      // active 가 비면 첫 번째로 떨어진다 — 고아 포인터로 빈 화면을 띄우지 않는다.
      expect(after.current!.accountId, 'a');
    });

    test('마지막 하나를 빼면 전부 지운다', () async {
      final store = SessionStore.inMemory();
      await store.upsert(_c('a'));
      await store.remove('a');
      expect(await store.load(), isNull);
    });
  });

  group('저장에 실패하면', () {
    test('평문으로 내려가지 않고 던진다', () async {
      final store = SessionStore.inMemory(failWrites: true);
      expect(
        () => store.upsert(_c('a')),
        throwsA(isA<SessionSaveFailure>()),
      );
      // 삼키고 성공한 척하지 않는다 — 그러면 사람은 다음 기동에 이유 없이 로그아웃된다.
      expect(await store.load(), isNull);
    });
  });

  group('보관본 읽기', () {
    test('label 이 없는 옛 항목도 읽힌다', () async {
      final raw = jsonEncode({
        'active': 'a',
        'communities': [
          {'accountId': 'a', 'baseUrl': 'https://x', 'token': 't', 'handle': 'h'},
        ],
      });
      final store = SessionStore.inMemory(seed: raw);
      final loaded = await store.load();
      expect(loaded!.communities.single.label, isNull);
    });

    test('깨진 보관본은 없는 것으로 친다 — 던지면 앱이 못 뜬다', () async {
      final store = SessionStore.inMemory(seed: '{이건 JSON 이 아니다');
      expect(await store.load(), isNull);
    });

    test('active 가 사라진 것을 가리키면 첫 번째로 떨어진다', () async {
      final raw = jsonEncode({
        'active': '없는계정',
        'communities': [
          {'accountId': 'a', 'baseUrl': 'https://x', 'token': 't', 'handle': 'h', 'label': null},
        ],
      });
      final loaded = await SessionStore.inMemory(seed: raw).load();
      expect(loaded!.current!.accountId, 'a');
    });
  });
}
