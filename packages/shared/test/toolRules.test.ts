import { describe, expect, it } from 'vitest';
import { TOOL_RULE_WARNING_HEAD_KO, orderToolRuleWarnings, parseToolScope, toolRuleExpiryCapped, toolScope, validateExactCommand, validateToolRule } from '../src/toolRules.js';

describe('판정 모름(unclassified) 경고', () => {
  it('원격 변경 바로 다음 순서로 그리고, 만료 30일 상한에 든다', () => {
    expect(orderToolRuleWarnings(['uses_github_account', 'unclassified', 'mutates_remote'])).toEqual(['mutates_remote', 'unclassified', 'uses_github_account']);
    expect(toolRuleExpiryCapped(['unclassified'])).toBe(true);
    expect(TOOL_RULE_WARNING_HEAD_KO.unclassified).toBe('무엇을 하는지 판정하지 못했다');
  });
});


describe('validateToolRule — 받는 것', () => {
  it('읽기 접두는 경고 없이 받는다', () => {
    expect(validateToolRule('Bash(gh pr view -R acme-org/infra-k8s:*)')).toEqual({
      ok: true, rule: 'Bash(gh pr view -R acme-org/infra-k8s:*)', kind: 'bash_prefix', warnings: ['uses_github_account'],
    });
    expect(validateToolRule('Bash(kubectl --context ops -n sitebot get:*)')).toMatchObject({ ok: true, warnings: [] });
  });

  it('kubectl exec 는 받되 실행형 경고를 단다(D4)', () => {
    expect(validateToolRule('Bash(kubectl --context ops -n sitebot exec:*)')).toMatchObject({
      ok: true, warnings: ['executes_in_workload'],
    });
  });

  it('원격을 바꾸는 하위 명령은 경고한다', () => {
    expect(validateToolRule('Bash(kubectl --context ops delete pod x)')).toMatchObject({ ok: true, kind: 'bash_exact', warnings: ['mutates_remote'] });
    expect(validateToolRule('Bash(git push origin feature)')).toMatchObject({ ok: true, warnings: ['mutates_remote'] });
  });

  it('고정 낱말이 둘뿐인 접두는 짧다고 경고한다', () => {
    expect(validateToolRule('Bash(kubectl get:*)')).toMatchObject({ ok: true, warnings: ['short_prefix'] });
  });

  it('공백을 하나로 고친다', () => {
    expect(validateToolRule('  Bash( gh   pr  view :*)  ')).toMatchObject({ ok: true, rule: 'Bash(gh pr view:*)' });
  });

  it('gh 는 하위 명령 두 단계를 고정한 접두와 읽기 api 한 줄만 받는다(F3)', () => {
    expect(validateToolRule('Bash(gh -R acme-org/infra-k8s pr view:*)')).toMatchObject({ ok: true });
    expect(validateToolRule('Bash(gh api repos/acme-org/infra-k8s/pulls/11170)')).toMatchObject({ ok: true, kind: 'bash_exact' });
  });

  it('git push 는 기능 브랜치를 명시한 정확 규칙만 받는다(F4)', () => {
    expect(validateToolRule('Bash(git push origin feature/example-driver)')).toMatchObject({ ok: true, kind: 'bash_exact', warnings: ['mutates_remote'] });
    expect(validateToolRule('Bash(git push -u origin corp-account/x:corp-account/x)')).toMatchObject({ ok: true });
  });

  it('gh 의 원격을 바꾸는 하위 명령은 mutates_remote 경고(security 낮은 후속)', () => {
    for (const r of ['Bash(gh workflow run deploy.yml)', 'Bash(gh release create v1)', 'Bash(gh repo edit o/r --visibility public)']) {
      const v = validateToolRule(r);
      expect(v.ok && v.warnings.includes('mutates_remote'), r).toBe(true);
    }
  });

  it('gh pr·run 의 쓰기 동작에 원격 변경 경고를 단다 · 읽기 동작은 접두라도 그대로', () => {
    for (const r of ['Bash(gh pr create -R o/r:*)', 'Bash(gh pr comment 1 -R o/r --body x)', 'Bash(gh pr close 1 -R o/r)',
      'Bash(gh pr edit -R o/r:*)', 'Bash(gh pr reopen 1 -R o/r)', 'Bash(gh pr ready 1 -R o/r)', 'Bash(gh -R o/r pr review 1 --approve)',
      'Bash(gh pr --repo o/r create:*)', 'Bash(gh run rerun -R o/r:*)', 'Bash(gh run cancel 1 -R o/r)', 'Bash(gh run delete 1 -R o/r)']) {
      const v = validateToolRule(r);
      expect(v.ok && v.warnings.includes('mutates_remote'), r).toBe(true);
    }
    for (const r of ['Bash(gh pr list -R o/r --state open:*)', 'Bash(gh pr view -R o/r:*)', 'Bash(gh pr checks -R o/r:*)',
      'Bash(gh pr diff 1 -R o/r)', 'Bash(gh run list -R o/r:*)', 'Bash(gh run view 1 -R o/r)']) {
      expect(validateToolRule(r), r).toMatchObject({ ok: true, warnings: ['uses_github_account'] });
    }
  });

  it('gh 읽기(정확 규칙의 list·view·status·diff·checks, GET api)에는 mutates_remote 를 달지 않는다 · 접두·쓰기는 그대로', () => {
    for (const r of ['Bash(gh issue list -R cli/cli --limit 3)', 'Bash(gh issue view 1 -R cli/cli)', 'Bash(gh release view v1 -R o/r)',
      'Bash(gh repo view o/r)', 'Bash(gh workflow list -R o/r)', 'Bash(gh api repos/o/r/pulls)', 'Bash(gh api repos/o/r/pulls --jq .)']) {
      const v = validateToolRule(r);
      expect(v.ok && v.warnings, r).toEqual(['uses_github_account']);
    }
    for (const r of ['Bash(gh issue list:*)', 'Bash(gh issue create --title x)', 'Bash(gh issue close 1 -R o/r)',
      'Bash(gh -R o/r issue comment 1 --body x)', 'Bash(gh label create bug)', 'Bash(gh secret list -R o/r:*)']) {
      const v = validateToolRule(r);
      expect(v.ok && v.warnings.includes('mutates_remote'), r).toBe(true);
    }
  });

  it('첫 실사용 규칙(sitebot)은 통과한다', () => {
    expect(validateToolRule('Bash(kubectl --context prod-main-admin@prod-main -n app-cluster exec:*)')).toMatchObject({ ok: true, warnings: ['executes_in_workload'] });
    expect(validateToolRule('Bash(gh pr view -R acme-org/infra-k8s:*)')).toMatchObject({ ok: true, warnings: ['uses_github_account'] });
  });

  it('임의 명령을 돌릴 수 있는 도구는 runs_arbitrary 경고(n5)', () => {
    for (const r of ['Bash(find . -name x -exec rm:*)', 'Bash(awk -f prog.awk:*)', 'Bash(uv run pytest:*)', 'Bash(make -C build all:*)', 'Bash(git -c core.sshCommand=x fetch)']) {
      const v = validateToolRule(r);
      expect(v.ok && v.warnings.includes('runs_arbitrary'), r).toBe(true);
    }
  });

  it('위험 표에 있는 명령의 접두가 하위 명령을 고정하지 않으면 실행·원격 변경 경고를 둘 다 단다', () => {
    for (const r of [
      'Bash(kubectl --context ops -n app:*)', 'Bash(oc --context ops:*)', 'Bash(docker --context remote:*)',
      'Bash(docker-compose -f app.yml:*)', 'Bash(helm --kube-context ops:*)', 'Bash(terraform -chdir=infra:*)',
      'Bash(docker compose -f app.yml:*)',
    ]) {
      const v = validateToolRule(r);
      expect(v.ok && v.warnings.includes('executes_in_workload') && v.warnings.includes('mutates_remote'), r).toBe(true);
    }
  });

  it('두 단계 명령은 둘째 하위 명령으로 본다 — exec·run 은 실행 경고, 읽기는 경고 없음', () => {
    expect(validateToolRule('Bash(docker compose -f app.yml exec:*)')).toMatchObject({ ok: true, warnings: ['executes_in_workload'] });
    expect(validateToolRule('Bash(docker compose run:*)')).toMatchObject({ ok: true, warnings: ['executes_in_workload'] });
    expect(validateToolRule('Bash(docker compose -f app.yml ps:*)')).toMatchObject({ ok: true, warnings: [] });
    expect(validateToolRule('Bash(docker-compose -f app.yml exec:*)')).toMatchObject({ ok: true, warnings: ['executes_in_workload'] });
  });

  it('값 없는 옵션 뒤에 온 위험 하위 명령에도 경고를 단다', () => {
    const has = (r: string, w: string) => { const v = validateToolRule(r); return v.ok && v.warnings.includes(w as never); };
    expect(has('Bash(kubectl --insecure-skip-tls-verify exec mypod:*)', 'executes_in_workload')).toBe(true);
    expect(has('Bash(kubectl --insecure-skip-tls-verify delete pod:*)', 'mutates_remote')).toBe(true);
    expect(has('Bash(oc --insecure-skip-tls-verify rsh mypod:*)', 'executes_in_workload')).toBe(true);
    expect(has('Bash(helm --debug upgrade rel:*)', 'mutates_remote')).toBe(true);
    expect(has('Bash(terraform -no-color apply plan:*)', 'mutates_remote')).toBe(true);
    expect(has('Bash(docker -D run img:*)', 'executes_in_workload')).toBe(true);
    expect(has('Bash(podman --remote exec box:*)', 'executes_in_workload')).toBe(true);
    expect(has('Bash(nerdctl --debug run img:*)', 'executes_in_workload')).toBe(true);
    expect(has('Bash(docker compose --dry-run exec svc:*)', 'executes_in_workload')).toBe(true);
    expect(has('Bash(docker-compose --verbose exec svc:*)', 'executes_in_workload')).toBe(true);
    expect(has('Bash(docker --context compose compose exec:*)', 'executes_in_workload')).toBe(true);
  });

  it('컨테이너 도구의 상태를 바꾸는 하위 명령에 원격 변경 경고를 단다', () => {
    for (const r of ['Bash(docker --context remote rm box:*)', 'Bash(docker compose -f app.yml up:*)', 'Bash(docker compose down:*)',
      'Bash(podman stop box:*)', 'Bash(docker-compose -f app.yml rm:*)', 'Bash(podman-compose up:*)']) {
      const v = validateToolRule(r);
      expect(v.ok && v.warnings.includes('mutates_remote'), r).toBe(true);
    }
    expect(validateToolRule('Bash(podman exec box:*)')).toMatchObject({ ok: true, warnings: ['executes_in_workload'] });
  });

  it('컨테이너·VM 안으로 들어가거나 써 넣는 하위 명령에 실행 경고를 단다', () => {
    for (const r of ['Bash(docker cp box:*)', 'Bash(docker attach box:*)', 'Bash(podman cp box:*)', 'Bash(docker compose cp svc:*)',
      'Bash(docker-compose attach svc:*)', 'Bash(podman machine ssh vm:*)', 'Bash(kubectl --context ops proxy:*)']) {
      const v = validateToolRule(r);
      expect(v.ok && v.warnings.includes('executes_in_workload'), r).toBe(true);
    }
  });

  it('클러스터·인프라 상태를 바꾸는 하위 명령에 원격 변경 경고를 단다', () => {
    for (const r of ['Bash(docker stack deploy app:*)', 'Bash(docker service update app:*)', 'Bash(docker swarm leave:*)',
      'Bash(helm --kube-context ops test rel:*)', 'Bash(terraform state rm res:*)', 'Bash(terraform state mv res:*)',
      'Bash(terraform state push file:*)', 'Bash(terraform taint res:*)', 'Bash(terraform untaint res:*)', 'Bash(terraform force-unlock id:*)']) {
      const v = validateToolRule(r);
      expect(v.ok && v.warnings.includes('mutates_remote'), r).toBe(true);
    }
  });

  it('같은 관리 명령의 읽기 꼴은 그대로 경고 없음', () => {
    for (const r of ['Bash(docker stack ls:*)', 'Bash(docker service ls:*)', 'Bash(terraform state list:*)', 'Bash(podman machine list:*)']) {
      expect(validateToolRule(r), r).toMatchObject({ ok: true, warnings: [] });
    }
  });

  it('하위 명령을 고정한 읽기 접두와 정확 규칙은 그대로 경고 없음', () => {
    expect(validateToolRule('Bash(kubectl --context ops -n app logs:*)')).toMatchObject({ ok: true, warnings: [] });
    expect(validateToolRule('Bash(helm --kube-context ops status:*)')).toMatchObject({ ok: true, warnings: [] });
    expect(validateToolRule('Bash(kubectl --context ops)')).toMatchObject({ ok: true, warnings: [] });
  });

  it('MCP 도구 하나는 받는다 — harkroom MCP 는 아니다', () => {
    expect(validateToolRule('mcp__slack__read_thread')).toMatchObject({ ok: true, kind: 'mcp_tool' });
    expect(validateToolRule('mcp__harkroom__grant_delegate')).toEqual({ ok: false, code: 'unsupported_tool' });
  });
});

describe('validateToolRule — 거절', () => {
  it.each([
    ['', 'empty'],
    ['Bash', 'unsupported_tool'],
    ['Edit(**)', 'unsupported_tool'],
    ['Bash(*)', 'too_broad'],
    ['Bash(:*)', 'too_broad'],
    ['Bash(kubectl:*)', 'too_broad'],
    ['Bash(kubectl * exec:*)', 'wildcard'],
    ['Bash(gh pr view && rm -rf x)', 'shell_syntax'],
    ['Bash(echo $(id))', 'shell_syntax'],
    ['Bash(kubectl get pods > /tmp/x)', 'shell_syntax'],
    ['Bash(claude --dangerously-skip-permissions:*)', 'dangerous_flag'],
    ['Bash(bash -c:*)', 'interpreter'],
    ['Bash(/usr/bin/env kubectl:*)', 'interpreter'],
    ['Bash(python3 -c print:*)', 'interpreter'],
    ['Bash(sudo kubectl get:*)', 'interpreter'],
    ['Bash(/opt/harkroom/harkroom-operator merge:*)', 'operator_wrapper'],
    ['Bash(gh pr merge 12)', 'merge_bypass'],
    ['Bash(gh -R a/b pr merge:*)', 'merge_bypass'],
    ['Bash(gh api -X PUT repos/a/b/pulls/1/merge)', 'merge_bypass'],
    // security F1 — 규칙 하나에 여러 개 끼워 넣기
    ['Bash(git status), Bash, Bash(x:*)', 'bad_chars'],
    ['Bash(git status,Bash)', 'bad_chars'],
    // security F2 — 따옴표·역슬래시로 감춘 머리, 버전 붙은 인터프리터, 감싸 돌리는 것
    ['Bash("sh" -c x:*)', 'bad_chars'],
    ["Bash('sh' -c x:*)", 'bad_chars'],
    ['Bash(\\sh -c x:*)', 'bad_chars'],
    ['Bash(python3.12 -c x:*)', 'interpreter'],
    ['Bash(node22 -e x:*)', 'interpreter'],
    ['Bash(caffeinate -i sh:*)', 'interpreter'],
    ['Bash(kubectl get pods {a,b})', 'bad_chars'],
    ['Bash(cat ~/.ssh/id_ed25519)', 'bad_chars'],
    // security F3 — gh 로 머지 deny 를 옆으로 돌기
    ['Bash(gh api:*)', 'gh_api_write'],
    ['Bash(gh api repos/o/r/pulls/1/merge:*)', 'merge_bypass'],
    ['Bash(gh api -XPUT repos/o/r:*)', 'gh_api_write'],
    ['Bash(gh api -XPUT repos/o/r/pulls/1)', 'gh_api_write'],
    ['Bash(gh api --method=PUT repos/o/r/pulls/1)', 'gh_api_write'],
    ['Bash(gh api repos/o/r/issues -f title=x)', 'gh_api_write'],
    ['Bash(gh api graphql:*)', 'gh_api_write'],
    ['Bash(gh api graphql)', 'gh_api_write'],
    ['Bash(gh -R o/r pr:*)', 'too_broad'],
    ['Bash(gh -R o/r pr merge 1)', 'merge_bypass'],
    ['Bash(gh pr:*)', 'too_broad'],
    ['Bash(gh alias set pv pr:*)', 'merge_bypass'],
    // security F4 — git push 로 main 에 바로 넣기
    ['Bash(git push:*)', 'merge_bypass'],
    ['Bash(git push origin:*)', 'merge_bypass'],
    ['Bash(git push origin HEAD:refs/heads/main)', 'merge_bypass'],
    ['Bash(git push origin HEAD:main)', 'merge_bypass'],
    ['Bash(git push -f origin main)', 'merge_bypass'],
    ['Bash(git push --force-with-lease origin master)', 'merge_bypass'],
    ['Bash(git push origin HEAD)', 'merge_bypass'],
    ['Bash(git push origin feat:Main)', 'merge_bypass'],
    ['Bash(git push origin :feature)', 'merge_bypass'],
    ['Bash(git push --all origin)', 'merge_bypass'],
    ['Bash(git push origin)', 'merge_bypass'],
    ['Bash(git -C repo push origin main)', 'merge_bypass'],
    // security F4a·F5
    ['Bash(git push origin @)', 'merge_bypass'],
    ['Bash(git push origin @:feat)', 'merge_bypass'],
    ['Bash(gh repo sync:*)', 'merge_bypass'],
    ['Bash(gh repo sync izagood/harkroom --force)', 'merge_bypass'],
    ['Bash(gh -R o/r repo sync)', 'merge_bypass'],
  ])('%s → %s', (rule, code) => {
    expect(validateToolRule(rule)).toEqual({ ok: false, code });
  });

  it('너무 길면 거절한다', () => {
    expect(validateToolRule(`Bash(gh pr view ${'x'.repeat(400)})`)).toEqual({ ok: false, code: 'too_long' });
  });
});

describe('toolScope', () => {
  const ch = '0b6a1f0e-1111-4222-8333-944445555666';
  it('채널 id 와 규칙을 오간다(규칙 안의 콜론도 그대로)', () => {
    const s = toolScope(ch, 'Bash(gh pr view:*)');
    expect(s).toBe(`tool:${ch}:Bash(gh pr view:*)`);
    expect(parseToolScope(s)).toEqual({ channelId: ch, rule: 'Bash(gh pr view:*)' });
  });
  it('모양이 틀리면 null', () => {
    expect(parseToolScope('tool::Bash(x)')).toBeNull();
    expect(parseToolScope('repo:a/b')).toBeNull();
  });
});

// 「정확한 명령」(H②·H③a, 스레드 8769dbf7): 서버 승인·오퍼레이터 해시·hook 이 같은 판정·정규형·파일 목록을 쓴다.
describe('validateExactCommand', () => {
  const KC = '--kubeconfig /tmp/rc.kubeconfig --context rc';
  const HK = '--kubeconfig /k --kube-context c';
  it('공백만 정규화하고 셸 문법·따옴표·접두·env 앞붙임은 받지 않는다', () => {
    expect(validateExactCommand(`  kubectl   ${KC}   get pods `)).toEqual({
      ok: true, command: `kubectl ${KC} get pods`, warnings: ['reads_file'],
      files: [{ path: '/tmp/rc.kubeconfig', flag: '--kubeconfig', secret: true }],
    });
    expect(validateExactCommand(`kubectl ${KC} get pods; rm -rf /`)).toEqual({ ok: false, code: 'shell_syntax' });
    expect(validateExactCommand(`kubectl ${KC} get pods && x`)).toEqual({ ok: false, code: 'shell_syntax' });
    expect(validateExactCommand("kubectl patch x -p '{}'")).toMatchObject({ ok: false });
    expect(validateExactCommand(`kubectl ${KC} get pods:*`)).toEqual({ ok: false, code: 'wildcard' });
    expect(validateExactCommand('sh -c ls')).toEqual({ ok: false, code: 'interpreter' });
    expect(validateExactCommand('')).toEqual({ ok: false, code: 'empty' });
    expect(validateExactCommand('LD_PRELOAD=/tmp/x.so kubectl get pods')).toEqual({ ok: false, code: 'env_prefix' });
  });

  it('C3·F2: 머리는 kubectl·helm 만 — 경로 머리·cwd 파일을 실행하는 도구는 거절', () => {
    for (const c of ['./deploy.sh', '/tmp/run prod', 'bin/x']) expect(validateExactCommand(c), c).toEqual({ ok: false, code: 'path_head' });
    for (const c of ['make deploy', 'npm run deploy', 'go run .', 'terraform apply', 'docker compose up', 'ls -la /tmp', 'tail -f /var/log/x', 'curl -d @/tmp/b.json https://x', 'rkscli cluster scale']) {
      expect(validateExactCommand(c), c).toEqual({ ok: false, code: 'unsupported_head' });
    }
  });

  it('F2: kubectl 은 내장 하위 명령만 — 플러그인·cp·edit·proxy·config 거절, 자격 파일은 비밀 자리로 해시', () => {
    for (const c of [`kubectl ${KC} cp /local pod:/x`, `kubectl ${KC} myplugin do`, `kubectl ${KC} edit cm x`, `kubectl ${KC} proxy`, `kubectl ${KC} config view`, `kubectl ${KC} kustomize /d`]) {
      expect(validateExactCommand(c), c).toEqual({ ok: false, code: 'unsupported_subcommand' });
    }
    const cred = validateExactCommand(`kubectl ${KC} --client-key /k.pem --client-certificate=/c.pem --certificate-authority /ca.pem get pods`);
    expect(cred.ok && cred.files.map((f) => [f.path, f.secret])).toEqual([['/tmp/rc.kubeconfig', true], ['/k.pem', true], ['/c.pem', true], ['/ca.pem', true]]);
    expect(validateExactCommand(`kubectl ${KC} --client-key k.pem get pods`)).toEqual({ ok: false, code: 'relative_path' });
  });

  it('F2: helm 차트는 `<릴리스> oci://…` + --version 만 — 로컬·repo 차트·post-renderer·플러그인 거절', () => {
    expect(validateExactCommand(`helm ${HK} upgrade r oci://harbor.x/c/chart --version 0.6.0 -f /v.yaml`)).toMatchObject({ ok: true });
    expect(validateExactCommand(`helm ${HK} status r`)).toMatchObject({ ok: true });
    for (const c of [`helm ${HK} upgrade r /abs/chart --version 1`, `helm ${HK} upgrade r charts/foo --version 1`, `helm ${HK} upgrade r chart --version 1`,
      `helm ${HK} upgrade r repo/chart --version 1`, `helm ${HK} upgrade r oci://h/c`, `helm ${HK} upgrade --atomic r oci://h/c --version 1`,
      `helm ${HK} upgrade r oci://h/c --version 1 oci://h/d`, `helm ${HK} install r oci://h/../c --version 1`]) {
      expect(validateExactCommand(c), c).toEqual({ ok: false, code: 'chart_not_pinned' });
    }
    expect(validateExactCommand(`helm ${HK} upgrade r oci://h/c --version 1 --post-renderer /tmp/pr`)).toEqual({ ok: false, code: 'unsupported_flag' });
    expect(validateExactCommand(`helm ${HK} upgrade r oci://h/c --version 1 --repo https://x`)).toEqual({ ok: false, code: 'unsupported_flag' });
    for (const c of [`helm ${HK} myplugin x`, `helm ${HK} repo add a https://x`, `helm ${HK} push x oci://h`]) expect(validateExactCommand(c), c).toEqual({ ok: false, code: 'unsupported_subcommand' });
  });

  it('C4: kubectl·helm 은 --kubeconfig 절대 경로와 context 가 둘 다 있어야 한다', () => {
    expect(validateExactCommand('kubectl get pods')).toEqual({ ok: false, code: 'needs_kubeconfig' });
    expect(validateExactCommand('kubectl --context rc get pods')).toEqual({ ok: false, code: 'needs_kubeconfig' });
    expect(validateExactCommand('kubectl --kubeconfig /tmp/k get pods')).toEqual({ ok: false, code: 'needs_kubeconfig' });
    expect(validateExactCommand('kubectl --kubeconfig rc.kubeconfig --context rc get pods')).toEqual({ ok: false, code: 'relative_path' });
    expect(validateExactCommand('kubectl --kubeconfig=/tmp/k --context=rc get pods')).toMatchObject({ ok: true });
    expect(validateExactCommand(`helm ${HK} list`)).toMatchObject({ ok: true });
    expect(validateExactCommand('helm --kubeconfig /k --context c list')).toEqual({ ok: false, code: 'needs_kubeconfig' });
  });

  it('C1: 파일 자리를 뽑는다 — 절대·깨끗한 경로만, 붙여 쓴 짧은 플래그는 거절, 같은 경로는 하나로', () => {
    const r = validateExactCommand(`kubectl ${KC} patch deviceclass dranet --type merge --patch-file /tmp/p.json`);
    expect(r).toMatchObject({ ok: true, warnings: expect.arrayContaining(['mutates_remote', 'reads_file']) });
    expect(r.ok && r.files).toEqual([
      { path: '/tmp/rc.kubeconfig', flag: '--kubeconfig', secret: true },
      { path: '/tmp/p.json', flag: '--patch-file', secret: false },
    ]);
    const h = validateExactCommand(`helm ${HK} upgrade a oci://h/c --version 1 -f /v.yaml --values=/w.yaml --set-file cfg=/c.txt`);
    expect(h.ok && h.files.map((x) => x.path)).toEqual(['/k', '/v.yaml', '/w.yaml', '/c.txt']);
    for (const c of [`kubectl ${KC} apply -f x.yaml`, `kubectl ${KC} apply -f /tmp/../etc/x`, `kubectl ${KC} apply -f /tmp//x`, `kubectl ${KC} apply -f`, `kubectl ${KC} apply -f -`, `kubectl ${KC} apply -f https://x/y.yaml`]) {
      expect(validateExactCommand(c), c).toEqual({ ok: false, code: 'relative_path' });
    }
    for (const c of [`kubectl ${KC} apply -f/tmp/x.yaml`, `kubectl ${KC} apply -f=/tmp/x.yaml`]) expect(validateExactCommand(c), c).toEqual({ ok: false, code: 'glued_flag' });
    expect(validateExactCommand(`kubectl ${KC} logs -f pod-0`)).toMatchObject({ ok: true });
    expect(validateExactCommand('kubectl --kubeconfig /x --context rc apply -f /x')).toMatchObject({ ok: true, files: [{ path: '/x', flag: '--kubeconfig', secret: true }] });
  });
});

describe('경고 — GitHub 계정·순서·본문 머리(H4)', () => {
  it('머리가 gh 면 uses_github_account(정확·접두 모두), gh 가 아니면 없다', async () => {
    const { validateToolRule, orderToolRuleWarnings, TOOL_RULE_WARNING_HEAD_KO } = await import('../src/toolRules.js');
    expect(validateToolRule('Bash(gh pr list -R cli/cli --limit 3)')).toMatchObject({ ok: true, warnings: ['uses_github_account'] });
    expect(validateToolRule('Bash(kubectl get:*)')).toMatchObject({ ok: true, warnings: ['short_prefix'] });
    expect(orderToolRuleWarnings(['uses_github_account', 'short_prefix', 'bogus', 'runs_arbitrary', 'short_prefix'])).toEqual(['runs_arbitrary', 'short_prefix', 'uses_github_account']);
    expect(Object.keys(TOOL_RULE_WARNING_HEAD_KO)).toHaveLength(7);
  });
});
