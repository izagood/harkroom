import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harkroom/session/session_store.dart';

StoredCommunity _c(String id, {String url = 'https://a.example.com', String? label}) =>
    StoredCommunity(accountId: id, baseUrl: url, token: 't-$id', handle: 'h-$id', label: label);

void main() {
  group('키는 계정 id 다', () {
    test('계정 id 가 같아도 서버(origin)가 다르면 다른 행이다 — 기존 행을 덮지 않는다', () async {
      // 계정 id 는 서버가 대는 값이다. id 만 열쇠면 낯선 서버가 남의 id 를 대서 그 행의
      // 토큰·이름을 차지한다(security #1046 F1).
      final store = SessionStore.inMemory();
      await store.upsert(_c('acct-1', url: 'https://lan.example.com', label: '회사'));
      final after = await store.upsert(_c('acct-1', url: 'https://public.example.com'));

      expect(after.communities.length, 2);
      expect(after.communities.first.baseUrl, 'https://lan.example.com');
      expect(after.communities.first.label, '회사');
      expect(after.communities.last.label, isNull);
    });

    test('같은 origin 이면 경로·끝 슬래시가 달라도 같은 행이다', () async {
      final store = SessionStore.inMemory();
      await store.upsert(_c('acct-1', url: 'https://a.example.com'));
      final after = await store.upsert(_c('acct-1', url: 'https://a.example.com/'));
      expect(after.communities.length, 1);
    });

    test('옛 저장본의 active(계정 id 만)도 알아본다', () async {
      final raw = jsonEncode({
        'active': 'b',
        'communities': [_c('a').toJson(), _c('b').toJson()],
      });
      final loaded = await SessionStore.inMemory(seed: raw).load();
      expect(loaded!.current!.accountId, 'b');
    });

    test('다른 계정은 따로 쌓인다', () async {
      final store = SessionStore.inMemory();
      await store.upsert(_c('a'));
      final after = await store.upsert(_c('b'));
      expect(after.communities.map((c) => c.accountId), ['a', 'b']);
      expect(after.active, _c('b').key);
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
      await store.remove(_c('b').key);

      final after = await store.load();
      expect(after!.communities.map((c) => c.accountId), ['a']);
      expect(after.active, isNull);
      // active 가 비면 첫 번째로 떨어진다 — 고아 포인터로 빈 화면을 띄우지 않는다.
      expect(after.current!.accountId, 'a');
    });

    test('마지막 하나를 빼면 전부 지운다', () async {
      final store = SessionStore.inMemory();
      await store.upsert(_c('a'));
      await store.remove(_c('a').key);
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

  group('여러 커뮤니티', () {
    test('update 는 active 를 건드리지 않는다', () async {
      final store = SessionStore.inMemory();
      await store.upsert(_c('a'));
      await store.upsert(_c('b'));
      final after = await store.update(_c('a').key, (c) => c.copyWith(token: ''));
      expect(after!.active, _c('b').key);
      expect(after.communities.first.isExpired, isTrue);
      expect(after.communities.last.isExpired, isFalse);
    });

    test('setActive 는 없는 id 를 무시한다', () async {
      final store = SessionStore.inMemory();
      await store.upsert(_c('a'));
      await store.upsert(_c('b'));
      expect((await store.setActive(_c('a').key))!.active, _c('a').key);
      expect((await store.setActive('없음'))!.active, _c('a').key);
    });

    test('다시 로그인해도 이 기기에서 붙인 이름은 남는다', () async {
      final store = SessionStore.inMemory();
      await store.upsert(_c('a', label: '회사'));
      final after = await store.upsert(_c('a'));
      expect(after.communities.single.label, '회사');
    });

    test('이름이 없으면 호스트명을 보인다', () {
      expect(_c('a', url: 'https://acme.example.com').displayLabel, 'acme.example.com');
      expect(_c('a', label: '  ').displayLabel, 'a.example.com');
      expect(_c('a', label: '회사').displayLabel, '회사');
    });
  });
}
