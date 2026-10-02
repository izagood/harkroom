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
class MeScreen extends StatelessWidget {
  const MeScreen({super.key});

  Future<void> _confirmSignOutAll(BuildContext context) async {
    final t = context.t;
    final k = context.tokens;
    final app = AppScope.read(context);
    final ok = await showModalBottomSheet<bool>(
      context: context,
      builder: (ctx) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 12),
          child: Column(
            key: const Key('me-sign-out-all-sheet'),
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(t.communitySignOutAll,
                  style: const TextStyle(fontSize: HarkroomType.screenTitle, fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              Text(t.communitySignOutAllConfirm.replaceAll('{count}', '${app.communities.length}'),
                  style: TextStyle(color: k.mute)),
              const SizedBox(height: 16),
              FilledButton(
                key: const Key('me-sign-out-all-confirm'),
                style: FilledButton.styleFrom(backgroundColor: k.err, foregroundColor: Colors.white),
                onPressed: () => Navigator.of(ctx).pop(true),
                child: Text(t.communitySignOutAll),
              ),
              TextButton(
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

    return Scaffold(
      appBar: AppBar(title: Text(t.tabMe)),
      body: SafeArea(
        child: ListView(
          children: [
            // 맨 위의 "@핸들 계정으로 로그인했다" 줄은 뺐다(designer 3) — 커뮤니티가 여럿이면 어느
            // 커뮤니티 얘기인지 모호하고, 목록이 ✓ 와 `@핸들` 로 이미 말한다.
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
                    ? ExpiredChip(
                        key: Key('me-community-expired-${c.key}'), label: t.communityExpired)
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
              leading: Icon(Icons.logout, color: k.err),
              title: Text(t.communitySignOutAll, style: TextStyle(color: k.err)),
              onTap: () => _confirmSignOutAll(context),
            ),
          ],
        ),
      ),
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
