/*********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                                                *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at http://www.apache.org/licenses/LICENSE-2.0                  *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

/**
 * CMS extension seam. An extension is a directory under `backend/extensions/<name>/` whose `index.ts`
 * exports `extension: CmsExtension`. An installed extension is enabled only when its id is in the
 * `vodExtensions` context list (`.env` `VOD_EXTENSIONS`, see `resolveExtensions` in `@vod/contract`); with
 * none enabled the stack is the base CMS. An enabled extension parses its own context keys in
 * {@link CmsExtension.activate} and returns `undefined` to stay off.
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as cdk from 'aws-cdk-lib';
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Node } from 'constructs';

/** What {@link CmsActiveExtension.extendApi} receives: the stack and the API Lambda, after its base grants. */
export interface CmsApiHookProps {
  readonly stack: cdk.Stack;
  /** The API Lambda (`AssetsFunction`). */
  readonly handler: lambda.Function;
  /** The VOD stack whose `/<name>/` SSM params the CMS reads. */
  readonly vodStackName: string;
  /** The stack's removal policy for stateful resources (RETAIN in prod). */
  readonly removalPolicy: cdk.RemovalPolicy;
}

/** What {@link CmsActiveExtension.addAssetRoutes} receives: the `/assets/{guid}` resource and its integration. */
export interface CmsRouteHookProps {
  readonly asset: apigateway.Resource;
  readonly integration: apigateway.LambdaIntegration;
  readonly authOpts: apigateway.MethodOptions;
}

/** An activated extension's contributions. Every hook is optional. */
export interface CmsActiveExtension {
  /** Extra environment variables on the API Lambda, set at construction. */
  readonly handlerEnvironment?: Readonly<Record<string, string>>;
  /** Add resources and grants for the API Lambda (called after the base API grants). */
  extendApi?(props: CmsApiHookProps): void;
  /** Add Cognito-authed routes under `/assets/{guid}` (called after the base routes). */
  addAssetRoutes?(props: CmsRouteHookProps): void;
  /** Sentences appended to the API's AwsSolutions-APIG2 (request validation) suppression reason. */
  readonly requestValidationNotes?: readonly string[];
  /** Extra sources for the CMS Content-Security-Policy (e.g. a license server for `connect`). */
  readonly contentSecurityPolicy?: { readonly connect?: readonly string[]; readonly media?: readonly string[]; readonly img?: readonly string[] };
}

export interface CmsExtension {
  /** Unique id (the directory name by convention), as listed in `VOD_EXTENSIONS`. */
  readonly id: string;
  /** Context keys only this extension reads (setting one while it is not enabled fails synth). */
  readonly contextKeys?: readonly string[];
  /** Parse this extension's context keys (throwing on invalid input); `undefined` = off for this synth. */
  activate(node: Node): CmsActiveExtension | undefined;
}

/** Where extensions are discovered. */
export const CMS_EXTENSIONS_DIR = path.join(__dirname, '..', 'extensions');

/** Load every extension under `dir` (sorted by directory name). A missing directory means none. */
export function loadCmsExtensions(dir: string = CMS_EXTENSIONS_DIR): CmsExtension[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(path.join(dir, name)) as { extension?: CmsExtension };
      if (!mod.extension) throw new Error(`CMS extension '${name}' does not export 'extension'.`);
      return mod.extension;
    });
}
