# AGENTS.md (companion modules)

Guidance for coding agents (and humans) working on the companion module stacks. Read the repo-root
`AGENTS.md` first; this file covers only what differs here.

## Module stacks

Each module is its own CDK app (own `bin/`, `cdk.json`, tests and README), deployed after the core stack.

- **Streaming-media WAF** (`waf`): a separate us-east-1 stack owns a CLOUDFRONT-scope WebACL. Two-step
  deploy (`waf/deploy.sh`) feeds its `WebAclArn` into the core stack's `wafWebAclArn`; deliberately not a
  CDK cross-region reference (that would add a Lambda).

## Workspace

`source/modules` is its **own npm workspaces root** (own `package.json` + `package-lock.json`), separate
from the repo-root workspaces, so the core distribution builds without it. Each module links
`@vod/contract` with `file:../../contract`; install the repo root first (its `npm ci` builds
`source/contract/dist`), then this root. `findRepoRoot` resolves the **outermost** workspaces root, so
module apps still read the repo-root `.env`.

```bash
npm ci && npm ci --prefix source/modules                      # repo root, then modules (from repo root)
npm run build --prefix source/modules && npm test --prefix source/modules
scripts/synth-matrix.sh source/modules/waf /tmp/golden        # per-module template matrix
```
