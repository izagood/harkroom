// TS 정본(packages/shared/src/toolRules.ts, packages/operator/src/turnCommand.ts 의 looksSecret)이 낸 판정을 골든으로 적는다.
// 실행: node --experimental-strip-types crates/harkroom-operator/golden/gen_tool_rules.mts  (저장소 루트에서)
import { readFileSync, writeFileSync } from 'node:fs';
import { validateToolRule, validateExactCommand } from '../../../packages/shared/src/toolRules.ts';

const SECRET_CONTENT_PATTERNS = [
  /kind:\s*["']?Secret\b/i,
  /\bstringData\s*:/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)["']?\s*[:=]/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(ghp|gho|ghs|github_pat|xox[abpr]|sk-[a-z]*)[-_A-Za-z0-9]{10,}/,
];
const looksSecret = (t: string) => SECRET_CONTENT_PATTERNS.some((re) => re.test(t));
// turnCommand.ts 의 표와 어긋나지 않게 — 원문에서 같은 줄을 찾는다.
const tc = readFileSync(new URL('../../../packages/operator/src/turnCommand.ts', import.meta.url), 'utf8');
for (const re of SECRET_CONTENT_PATTERNS) if (!tc.includes(re.toString())) throw new Error(`turnCommand.ts 에 없는 패턴: ${re}`);

const test = readFileSync(new URL('../../../packages/shared/test/toolRules.test.ts', import.meta.url), 'utf8');
const lits = [...test.matchAll(/'((?:[^'\\]|\\.)*)'|`((?:[^`\\$]|\\.)*)`/g)].map((m) => (m[1] ?? m[2])!.replace(/\\(.)/g, '$1'));
const ruleish = lits.filter((s) => /^(Bash\(|mcp__)/.test(s));
const cmdish = lits.filter((s) => /^(kubectl|helm|gh|git|docker|KUBECONFIG|\.\/|\/)/.test(s) || /^[a-z][a-z0-9-]* /.test(s));
const K = '--kubeconfig /k/c --context x';
const extraCmd = [
  '', '   ', 'kubectl get pods:*', `kubectl ${K} get pods`, `kubectl  ${K}   get   pods  `, `kubectl ${K} apply -f /a/b.yaml`,
  `kubectl ${K} apply -f a.yaml`, `kubectl ${K} apply -f/a.yaml`, `kubectl ${K} apply -f=/a.yaml`, `kubectl ${K} apply --filename=/a/b.yaml`,
  `kubectl ${K} logs -f pod`, `kubectl ${K} create configmap x --from-file=k=/a/b`, `kubectl ${K} create configmap x --from-file k=rel`,
  `kubectl ${K} apply -f /k/c`, `kubectl ${K} apply -f /a/./b`, `kubectl ${K} apply -f /a/../b`, `kubectl ${K} apply -f /a/`, `kubectl ${K} apply -f`,
  `kubectl ${K} cp a b`, `kubectl ${K} edit deploy x`, `kubectl ${K} exec -it p -- sh`, `kubectl ${K} plugin list`, 'kubectl get pods',
  'kubectl --kubeconfig /k/c get pods', 'kubectl --context x get pods', `kubectl --kubeconfig=/k/c --context=x get pods`, 'kubectl --kubeconfig rel --context x get pods',
  `kubectl ${K} apply -f /a --client-key /k/key`, `kubectl ${K} apply @/a/b`, `kubectl ${K} get pods -n default -o yaml`,
  `helm --kubeconfig /k/c --kube-context x install r oci://reg/c --version 1.2.3`, `helm --kubeconfig /k/c --kube-context x install r oci://reg/c`,
  `helm --kubeconfig /k/c --kube-context x install r ./chart --version 1`, `helm --kubeconfig /k/c --kube-context x install r repo/chart --version 1`,
  `helm --kubeconfig /k/c --kube-context x upgrade r oci://reg/c --version=2 -f /v.yaml --set-file a=/b/c`, `helm --kubeconfig /k/c --kube-context x upgrade r oci://reg/../c --version 2`,
  `helm --kubeconfig /k/c --kube-context x template r oci://reg/c --version 1 --post-renderer /x`, `helm --kubeconfig /k/c --kube-context x status r`,
  `helm --kubeconfig /k/c --kube-context x repo add a b`, `helm --kubeconfig /k/c --context x status r`, `helm --kubeconfig /k/c --kube-context x install -r oci://reg/c --version 1`,
  `helm --kubeconfig /k/c --kube-context x install r oci://reg/c oci://reg/d --version 1`, `helm --kubeconfig /k/c --kube-context x upgrade r oci://reg/c --version 1 --ca-file /ca --values /v`,
  'FOO=1 kubectl get pods', './deploy.sh', '/usr/bin/kubectl get pods', 'bash -c x', 'kubectl get pods; rm -rf /', 'kubectl get "pods"', 'make deploy', 'terraform apply',
  'Kubectl --kubeconfig /k/c --context x get pods', 'kubectl --kubeconfig /k/c --context x get pods --dangerously-skip', 'harkroom-operator merge a 1',
  `kubectl ${K} apply -f /a/b.yaml -f /a/b.yaml --kubeconfig /a/b.yaml`, 'kubectl --kubeconfig /k/c --context x get pods ' + 'x'.repeat(300),
];
const extraRule = [
  '', 'Bash()', 'Bash(*)', 'Bash(:*)', 'Bash(ls)', 'Bash(ls:*)', 'Bash(git status)', 'Bash(git push origin feat)', 'Bash(git push origin main)', 'Bash(git push origin @)',
  'Bash(git push origin HEAD:refs/heads/x)', 'Bash(git push:*)', 'Bash(git push origin)', 'Bash(git push --all origin x)', 'Bash(git -c x=y status)', 'Bash(git config user.name)',
  'Bash(gh pr view 1)', 'Bash(gh pr view:*)', 'Bash(gh pr:*)', 'Bash(gh pr merge 1)', 'Bash(gh -R o/r pr merge 1)', 'Bash(gh api repos/o/r/pulls)', 'Bash(gh api -X PUT x)',
  'Bash(gh api graphql)', 'Bash(gh api:*)', 'Bash(gh issue list)', 'Bash(gh issue create)', 'Bash(gh issue list:*)', 'Bash(gh pr create --title x)', 'Bash(gh run rerun 1)',
  'Bash(gh repo sync)', 'Bash(gh alias set x y)', 'Bash(docker compose up)', 'Bash(docker compose:*)', 'Bash(docker compose ps)', 'Bash(docker --context r compose exec a sh)',
  'Bash(docker stack deploy x)', 'Bash(docker:*)', 'Bash(docker ps)', 'Bash(podman machine ssh)', 'Bash(terraform state rm x)', 'Bash(terraform plan)', 'Bash(kubectl:*)',
  'Bash(kubectl get:*)', 'Bash(kubectl get pods:*)', 'Bash(kubectl exec -it p -- sh)', 'Bash(kubectl -n x delete pod y)', 'Bash(rm -rf /tmp/x)', 'Bash(ssh host)', 'Bash(find . -name x)',
  'Bash(npm run build)', 'Bash(npm ls)', 'Bash(cargo test:*)', 'Bash(python3.12 x)', 'Bash(/bin/sh x)', 'Bash(node22 x)', 'Bash(Rscript x)', 'Bash(env FOO=1 ls)', 'Bash(ls *)',
  'Bash(ls $(x))', 'Bash(ls ${x})', 'Bash(ls | x)', 'Bash(ls "x")', 'Bash(ls, x)', 'Bash(ls (x))', 'Bash(  ls   -la  )', 'Bash(ls -la :*)', 'mcp__srv__tool', 'mcp__harkroom__message_post',
  'mcp__a-b__c_d', 'mcp__x', 'Read(x)', 'bash(ls)', ' Bash(ls) ', 'Bash(ls --dangerously)', 'Bash(caffeinate ls)', 'Bash(oc rsh x)', 'Bash(ls é)', 'Bash(' + 'a'.repeat(300) + ')',
  'Bash(helm install x y)', 'Bash(helm list)', 'Bash(rsync -a x y)', 'Bash(go test ./...)', 'Bash(yarn dlx x)', 'Bash(docker-compose:*)', 'Bash(ssh:*)', 'Bash(rm:*)',
];
const secret = [
  'kind: Secret', "kind: 'Secret'", 'KIND:secret', 'stringData:', 'stringdata:', '-----BEGIN RSA PRIVATE KEY-----', '-----BEGIN PRIVATE KEY', 'password: x', 'API_KEY=1',
  'apikey = 1', 'Credentials: x', 'token"', 'AKIAABCDEFGHIJKLMNOP', 'xAKIAABCDEFGHIJKLMNOP', 'ghp_abcdefghij1234', 'sk-proj-abcdefghijk', 'xoxb-1234567890', 'apiVersion: v1\nkind: ConfigMap',
  'name: tokens', 'my secret is here', 'éAKIAABCDEFGHIJKLMNOP', 'kind: Secrets',
];
const uniq = (a: string[]) => [...new Set(a)];
const out = {
  rules: uniq([...ruleish, ...extraRule]).map((input) => ({ input, want: validateToolRule(input) })),
  exact: uniq([...cmdish, ...extraCmd]).map((input) => ({ input, want: validateExactCommand(input) })),
  secret: secret.map((input) => ({ input, want: looksSecret(input) })),
};
writeFileSync(new URL('./tool_rules.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(`rules ${out.rules.length} · exact ${out.exact.length} · secret ${out.secret.length}`);
