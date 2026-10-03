import 'package:flutter/material.dart';

import '../i18n/i18n.dart';
import '../session/session_store.dart';
import '../state/app_scope.dart';
import '../ui/parts.dart';
import '../ui/tokens.dart';
import 'community_screens.dart';
import '../push/push_coordinator.dart';
import '../push/push_platform.dart';

/// 나 · 이 기기의 커뮤니티(designer ⑧).
///
/// **데스크탑 설정의 대부분이 여기 없다**(계획서 §6): 에이전트 등록, Claude 계정,
/// 오퍼레이터, MCP, 스킬. 폰에서 **할 수 없는 일**이지 잠긴 일이 아니므로 회색으로도
/// 그리지 않는다 — 회색 항목은 "언젠가 열린다"는 거짓 약속이다.
///
/// 로그아웃은 **커뮤니티 하나 단위**다(D7). 전부 빼는 것은 맨 아래 따로 두고 확인을 거친다 —
/// 한 번 잘못 누르면 모든 서버에 다시 로그인해야 한다.
/// 「나」 를 바닥 시트로 연다(사양 3.8 — designer 10-02 확정). 처음 0.6, 끌어 올리면 0.92.
///
/// 바닥 시트인 이유: 「나」 는 잠깐 보고 닫는 곳이라, 보던 탭이 뒤에 비쳐야 어디로 돌아가는지 안다.
/// [opener] 는 시트를 연 쪽의 context 다 — 시트를 닫은 뒤 [모두 로그아웃] 확인을 그 위에 연다.
Future<void> openMeSheet(BuildContext opener) => showModalBottomSheet<void>(
      context: opener,
      isScrollControlled: true,
      showDragHandle: true,
      useSafeArea: true,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(12))),
      builder: (_) => DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.6,
        minChildSize: 0.3,
        maxChildSize: 0.92,
        builder: (context, controller) => MeSheetBody(controller: controller, opener: opener),
      ),
    );

/// 나 시트의 내용. 머리 → 커뮤니티 → 알림 → [모두 로그아웃].
///
/// **데스크탑 설정의 대부분이 여기 없다**(계획서 §6): 에이전트 등록, Claude 계정,
/// 오퍼레이터, MCP, 스킬. 폰에서 **할 수 없는 일**이지 잠긴 일이 아니므로 회색으로도
/// 그리지 않는다 — 회색 항목은 "언젠가 열린다"는 거짓 약속이다. 상태·프로필 편집·테마·언어도 같은
/// 이유로 없다(서버 표면이 없거나 기기 설정을 따른다).
///
/// 로그아웃은 **커뮤니티 하나 단위**다(D7). 전부 빼는 것은 맨 아래 따로 두고 확인을 거친다 —
/// 한 번 잘못 누르면 모든 서버에 다시 로그인해야 한다.
class MeSheetBody extends StatelessWidget {
  const MeSheetBody({super.key, this.controller, this.opener});

  final ScrollController? controller;

  /// 시트를 연 쪽. 없으면(시험에서 몸만 그릴 때) 이 위젯의 context 를 쓴다.
  final BuildContext? opener;

  /// 나 시트를 **먼저 닫고** 확인 시트를 연다 — 시트 둘이 겹치면 무엇을 취소하는지 흐려진다.
  /// [취소] 는 아무것도 바꾸지 않는다(나 시트를 다시 열지 않는다).
  Future<void> _confirmSignOutAll(BuildContext context) async {
    final host = opener;
    if (host != null) Navigator.of(context).pop();
    final at = host ?? context;
    final t = at.t;
    final k = at.tokens;
    final app = AppScope.read(at);
    final ok = await showModalBottomSheet<bool>(
      context: at,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
          child: Column(
            key: const Key('me-sign-out-all-sheet'),
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(t.communitySignOutAll,
                  style: const TextStyle(fontSize: HarkroomType.name, fontWeight: FontWeight.w600)),
              const SizedBox(height: 8),
              Text(t.communitySignOutAllConfirm.replaceAll('{count}', '${app.communities.length}'),
                  style: TextStyle(color: k.fgMuted)),
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('me-sign-out-all-confirm'),
                style: FilledButton.styleFrom(backgroundColor: k.danger, foregroundColor: k.fgOnStrong),
                onPressed: () => Navigator.of(ctx).pop(true),
                child: Text(t.communitySignOutAll),
              ),
              TextButton(
                key: const Key('me-sign-out-all-cancel'),
                onPressed: () => Navigator.of(ctx).pop(false),
                child: Text(t.communityCancel),
              ),
            ],
          ),
        ),
      ),
    );
    if (ok == true) await app.signOutAll();
  }

  /// 만료된 행도 **상세를 연다**(designer 1) — 「다시 로그인」과 「로그아웃」이 둘 다 거기 있다. 바로
  /// 로그인 모달로 보내면 비밀번호를 잊은 서버의 행을 뺄 길이 「모두 로그아웃」뿐이다.
  /// 상세는 **밀어 넣는 화면**이다 — 시트 안에 시트를 쌓지 않는다. 상세에서 옮기면 `enterCommunity` 가
  /// 맨 아래 화면까지 걸어 시트와 상세를 함께 닫는다.
  void _open(BuildContext context, StoredCommunity c) {
    Navigator.of(context).push(MaterialPageRoute<void>(
      builder: (_) => CommunityDetailScreen(communityKey: c.key),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final t = context.t;
    final k = context.tokens;
    final app = context.app;
    final me = app.me;
    final host = Uri.tryParse(app.baseUrl ?? '')?.host ?? '';

    return ListView(
      key: const Key('me-sheet'),
      controller: controller,
      children: [
        if (me != null)
          Padding(
            key: const Key('me-header'),
            padding: const EdgeInsets.fromLTRB(HarkroomSize.gutter, 4, HarkroomSize.gutter, 12),
            child: Row(
              children: [
                HarkroomAvatar(id: me.id, name: me.handle, size: 48),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(me.displayName.isNotEmpty ? me.displayName : me.handle,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600, color: k.fg)),
                      const SizedBox(height: 2),
                      Text([('@${me.handle}'), if (host.isNotEmpty) host].join(' · '),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(fontSize: 12, color: k.fgMuted)),
                    ],
                  ),
                ),
              ],
            ),
          ),
        SectionHeader(label: t.meCommunitiesSection),
        for (final c in app.communities)
          ListTile(
            key: Key('me-community-${c.key}'),
            leading: CommunityTile(community: c),
            title: Text(c.displayLabel, maxLines: 1, overflow: TextOverflow.ellipsis),
            subtitle: Text(
              c.isExpired
                  ? t.communityExpiredSubtitle
                  : '@${c.handle} · ${Uri.tryParse(c.baseUrl)?.host ?? c.baseUrl}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            // 만료는 **상태**다 — ✓(지금 커뮤니티)와 같은 강조색을 쓰면 둘이 같은 뜻으로 읽힌다.
            // warn 칩으로 가른다(designer 4).
            trailing: c.isExpired
                ? ExpiredChip(key: Key('me-community-expired-${c.key}'), label: t.communityExpired)
                : c.key == app.activeKey
                    ? Icon(Icons.check, color: k.accent, semanticLabel: t.communityCurrent)
                    : const Icon(Icons.chevron_right),
            onTap: () => _open(context, c),
          ),
        ListTile(
          key: const Key('me-community-add'),
          leading: const SizedBox(width: 36, child: Icon(Icons.add)),
          title: Text(t.communityAdd),
          onTap: () => openAddCommunity(context),
        ),
        const _PushSection(),
        const Divider(),
        ListTile(
          key: const Key('me-sign-out-all'),
          leading: Icon(Icons.logout, color: k.danger),
          title: Text(t.communitySignOutAll, style: TextStyle(color: k.danger)),
          onTap: () => _confirmSignOutAll(context),
        ),
        const SizedBox(height: 12),
      ],
    );
  }
}

/// 「알림」 절(푸시 M4, designer f1). 안내 시트에서 [나중에]를 골랐거나 iOS 설정에서 껐어도 여기서 다시 켤 수
/// 있다. 권한이 있으면 커뮤니티마다 스위치를 둔다 — 끄면 그 서버에 등록을 푼다.
class _PushSection extends StatelessWidget {
  const _PushSection();

  @override
  Widget build(BuildContext context) {
    final push = PushScope.of(context);
    if (push == null) return const SizedBox.shrink();
    final t = context.t;
    final app = context.app;
    final children = <Widget>[SectionHeader(label: t.pushSection)];
    switch (push.permission) {
      case null:
        return const SizedBox.shrink();
      case PushPermission.notDetermined:
        children.add(ListTile(
          key: const Key('me-push-not-asked'),
          leading: const SizedBox(width: 36, child: Icon(Icons.notifications_none)),
          title: Text(t.pushNotAsked),
          trailing: FilledButton(
            key: const Key('me-push-turn-on'),
            onPressed: push.enable,
            child: Text(t.pushTurnOn),
          ),
        ));
      case PushPermission.denied:
        children.add(ListTile(
          key: const Key('me-push-denied'),
          leading: const SizedBox(width: 36, child: Icon(Icons.notifications_off_outlined)),
          title: Text(t.pushDenied),
          trailing: OutlinedButton(
            key: const Key('me-push-open-settings'),
            onPressed: push.platform.openSettings,
            child: Text(t.pushOpenSettings),
          ),
        ));
      case PushPermission.authorized:
        for (final c in app.communities.where((c) => !c.isExpired)) {
          final on = !push.muted.contains(c.key);
          children.add(SwitchListTile(
            key: Key('me-push-community-${c.key}'),
            secondary: CommunityTile(community: c),
            title: Text(c.displayLabel, maxLines: 1, overflow: TextOverflow.ellipsis),
            subtitle: Text(on ? t.pushCommunityOn : t.pushCommunityOff),
            value: on,
            onChanged: (v) => push.setCommunityEnabled(c.key, v),
          ));
        }
        // 위는 커뮤니티마다, 아래는 모든 커뮤니티에 걸리는 설정이다 — 선으로 가른다(designer n3).
        children.add(const Divider(key: Key('me-push-preview-divider'), height: 17, indent: 16, endIndent: 16));
        children.add(SwitchListTile(
          key: const Key('me-push-preview'),
          secondary: const SizedBox(width: 36, child: Icon(Icons.short_text)),
          title: Text(t.pushPreview),
          subtitle: Text(t.pushPreviewHint),
          value: push.preview,
          onChanged: push.setPreview,
        ));
    }
    return Column(mainAxisSize: MainAxisSize.min, children: children);
  }
}
