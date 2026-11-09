# Streaming-media WAF module

An optional module that puts an AWS WAFv2 WebACL in front of the core stack's CloudFront distribution.
The WebACL **blocks by default** and allows only a list of viewer countries and/or trusted source IPv4
ranges. A request is allowed if **either** rule matches.

| | |
|---|---|
| Stack | `StreamingMediaWaf` (or `<stackName>-waf` when `STACK_NAME` is set), in **us-east-1** |
| Adds | `AWS::WAFv2::WebACL` (CLOUDFRONT scope) + an optional `AWS::WAFv2::IPSet` |
| Lambda functions | 0 |
| Requires | The core stack deployed (any region) |

## Why a separate stack

A CLOUDFRONT-scope WebACL can only be created in us-east-1, while the core stack can run in any
MediaConvert region. CDK cross-region references would add a Lambda-backed custom resource to the core
stack, so the WebACL ARN is passed to the core stack instead (`wafWebAclArn`): a **two-step deploy**.

## Configure

In the repo-root `.env` (copy `.env.example`), set at least one allow-list:

```bash
WAF_ALLOWED_COUNTRIES=US,CA,GB          # ISO 3166-1 alpha-2 codes
WAF_ALLOWED_IPS=203.0.113.0/24          # IPv4 CIDRs (IPv6 is not supported)
```

| Context key | Default | Description |
|---|---|---|
| `wafAllowedCountries` | (none) | Viewer countries allowed by the geo-match rule. Distinct from the core stack's CloudFront-native `geoRestriction`. |
| `wafAllowedIps` | (none) | Source IPv4 CIDRs allowed by the IP-set rule, regardless of country. |
| `wafAllowManifests` | `OFF` | `ON` allows playlists/manifests (`*.m3u8`, `*.mpd`) from anyone; segments, keys and every other object stay behind the allow-lists. **Required with the SSAI module.** |
| `wafAllowPathPrefixes` | (none) | URI path prefixes allowed from anyone, e.g. `/creatives/`. **Set `/creatives/` with the SSAI module.** Keep content out of these prefixes. |
| `stackName` | (none) | The core stack name; names this stack `<stackName>-waf`. |

**With the SSAI module (MediaTailor).** MediaTailor itself fetches the origin manifests and the ad creatives
from AWS addresses, which no viewer allow-list matches. Viewers still fetch the content segments directly
from the distribution, so the WAF keeps checking them. Set both keys:

```bash
WAF_ALLOW_MANIFESTS=ON
WAF_ALLOW_PATH_PREFIXES=/creatives/
```

A manifest on its own can't be played from outside the lists: its segments and the HLS AES-128 key
(`/keys/`) are still blocked. Without these keys, MediaTailor gets 403 from the origin and SSAI playback
returns 504 ("Unable to obtain template playlist"), and creative transcodes log `TRANSCODE_ERROR` 403.

**Corporate networks** often rotate egress IPs across a range. Allow the range (for example a `/22`), not
your current `/32`, or playback fails intermittently with 403.

## Deploy

```bash
source/modules/waf/deploy.sh --region <core-stack-region>
```

1. Deploys the WebACL stack in us-east-1 and reads its `WebAclArn` output.
2. Redeploys the core stack with `-c wafWebAclArn=<arn>`.

The script prints a `WAF_WEB_ACL_ARN=...` line: add it to `.env` so later core deploys keep the
association. Re-run the script after changing the allow-lists.

Manual equivalent:

```bash
cd source/modules/waf && npm run cdk -- deploy -c wafAllowedCountries=US,CA,GB   # note the WebAclArn output
cd ../../core && npm run cdk -- deploy VideoOnDemand -c email=you@example.com \
  -c wafWebAclArn=arn:aws:wafv2:us-east-1:<account>:global/webacl/<name>/<id>
```

To bring your own WebACL instead, skip this module and set only `wafWebAclArn` on the core stack.

## Notes

- WAF is a cost-bearing add-on (per WebACL, per rule and per million requests) and adds a small amount
  of request-evaluation latency at the edge.
- Removing the WebACL: redeploy the core stack without `wafWebAclArn` first, then destroy this stack.

## Development

```bash
npm test -w @vod/waf                    # jest: WebACL shape + cdk-nag gate + context validation
cd source/modules/waf && npm run cdk -- synth -c wafAllowedCountries=US
```
