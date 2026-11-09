/*********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.                                           *
 *                                                                                                                    *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance    *
 *  with the License. A copy of the License is located at                                                             *
 *                                                                                                                    *
 *      http://www.apache.org/licenses/LICENSE-2.0                                                                    *
 *                                                                                                                    *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES *
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions    *
 *  and limitations under the License.                                                                                *
 *********************************************************************************************************************/

/**
 * Core extension seam. An extension is an optional capability maintained outside this distribution that
 * plugs into the core stack at synth time. Each one lives in `source/core/extensions/<name>/` (exporting
 * `extension: CoreExtension` from its `index`). An installed extension is enabled only when its name is in
 * the `vodExtensions` context list (`.env` `VOD_EXTENSIONS`, see `resolveExtensions` in `@vod/contract`);
 * with none enabled the stack is exactly the core distribution.
 *
 * An extension parses and validates its own context keys ({@link CoreExtension.activate}) and, when enabled,
 * contributes through the optional hooks of {@link ActiveExtension}: MediaConvert job settings, the
 * Process/Orchestrator ASL, and CDK resources/grants/substitutions in the core constructs. Each hook runs
 * at the point in the compose pipeline or construct where the core overlays run, so the synthesized
 * template is the same whether a capability is built in or plugged in. Hooks must be stateless across
 * stacks (one parsed context may synthesize several stacks in tests): look resources up by construct id
 * (`node.tryFindChild`) rather than caching them.
 */

import * as fs from 'fs';
import * as path from 'path';
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import type { Construct } from 'constructs';
import type { ContextReader } from '@vod/contract';

import type { CoreContext, VodContext } from './context';
import type { IStorageConstruct } from './constructs/interfaces';
import type { JobProfile, JobSettingsOptions, JsonObject } from './overlays/types';

/** Default extensions directory: `source/core/extensions/` (absent in the core distribution). */
export const EXTENSIONS_DIR = path.join(__dirname, '..', 'extensions');

/** A discoverable extension (the `extension` export of `extensions/<name>/index`). */
export interface CoreExtension {
  /** Unique name (the extension directory name), as listed in `VOD_EXTENSIONS`. */
  readonly name: string;
  /** Context keys only this extension reads (setting one while it is not enabled fails synth). */
  readonly contextKeys?: readonly string[];
  /**
   * Parse + validate this extension's own context keys (throw a `VodContextError` on invalid input, so synth
   * fails fast). Returns the active hooks, or `undefined` when the extension is disabled for this context.
   */
  activate(reader: ContextReader, context: CoreContext): ActiveExtension | undefined;
}

/** What the Workflow construct hands to {@link ActiveExtension.workflow}. */
export interface WorkflowExtensionHost {
  /** The Workflow construct: the scope for any state machines/roles the extension adds. */
  readonly scope: Construct;
  readonly context: VodContext;
  readonly storage: IStorageConstruct;
  /** The Orchestrator execution role (the extension grants it whatever its injected states call). */
  readonly orchestratorRole: iam.Role;
  /** The core level-ALL logging configuration (a `<name>LogGroup` in the Workflow scope). */
  buildLogging(name: string, includeExecutionData?: boolean): sfn.LogOptions;
}

/** What {@link ActiveExtension.workflow} contributes back to the Workflow construct and the stack. */
export interface WorkflowExtensionResult {
  /** Extra Orchestrator `definitionSubstitutions` (for tokens its {@link ActiveExtension.orchestratorAsl} injected). */
  readonly orchestratorSubstitutions?: Readonly<Record<string, string>>;
  /** Extra state machines to include in the failed-executions alarms + dashboard. */
  readonly stateMachines?: readonly sfn.StateMachine[];
  /** Extra stack outputs (output id -> description + value). */
  readonly outputs?: Readonly<Record<string, { readonly description: string; readonly value: string }>>;
  /** Extra `/${stackName}/<key>` SSM discovery parameters (key -> value). */
  readonly ssmParams?: Readonly<Record<string, string>>;
}

/** The hooks of an enabled extension. Every hook is optional. */
export interface ActiveExtension {
  readonly name: string;
  /** The extension's parsed inputs (introspection and tests). */
  readonly config?: unknown;

  // --- Synth-time transforms (pure; no CDK) ------------------------------------------------------------

  /** Per output group of every {@link buildJobSettings} call, after the core per-group rewrites. */
  outputGroup?(profile: JobProfile, groupKey: string, groupSettings: JsonObject, opts: JobSettingsOptions): void;
  /** The whole job `Settings`, after the core output groups are complete (append groups here). */
  jobSettings?(profile: JobProfile, settings: JsonObject, opts: JobSettingsOptions): void;
  /** JSONata sentinel replacements for a variant lookup on the tier encode or the packaging job2 Task. */
  variantReplacements?(site: 'encode' | 'package'): Readonly<Record<string, string>>;
  /** The Process ASL `States`, after the packaging injection and before the sidecar variant lookups. */
  processAsl?(states: JsonObject): void;
  /** The Orchestrator ASL `States`, before the core sidecar overlays. */
  orchestratorAsl?(states: JsonObject): void;

  // --- CDK (constructs, grants, substitutions) -----------------------------------------------------------

  /** At the end of the Storage construct (add buckets in its scope). */
  storage?(scope: Construct, logsBucket: IStorageConstruct['logsBucket']): void;
  /** The MediaConvert service role, after the core grants. */
  mediaConvertRole?(role: iam.Role, storage: IStorageConstruct): void;
  /** Extra Process `definitionSubstitutions` (for tokens its settings/ASL hooks emitted). */
  processSubstitutions?(scope: Construct, storage: IStorageConstruct): Readonly<Record<string, string>>;
  /** `false` keeps execution data out of the Process logs (e.g. a deploy-resolved secret in the definition). */
  processExecutionDataLogging?(): boolean;
  /** In the Workflow construct, after the Orchestrator role's core grants and before the Orchestrator itself. */
  workflow?(host: WorkflowExtensionHost): WorkflowExtensionResult;
}

/**
 * Discover the extensions installed under `dir` (default {@link EXTENSIONS_DIR}), in name order. A
 * directory without an `index` module is skipped; one whose `index` does not export a valid
 * `extension` throws.
 */
export function loadCoreExtensions(dir: string = EXTENSIONS_DIR): CoreExtension[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && ['index.ts', 'index.js'].some((f) => fs.existsSync(path.join(dir, entry.name, f))))
    .map((entry) => entry.name)
    .sort()
    .map((name) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(path.join(dir, name)) as { extension?: CoreExtension };
      if (!mod.extension || typeof mod.extension.activate !== 'function') {
        throw new Error(`Extension '${name}' (${dir}/${name}) must export 'extension: CoreExtension'.`);
      }
      return mod.extension;
    });
}

/** The active extensions that implement hook `hook`, in name order. */
export function extensionsWith<K extends keyof ActiveExtension>(
  extensions: readonly ActiveExtension[] | undefined,
  hook: K,
): Array<ActiveExtension & Required<Pick<ActiveExtension, K>>> {
  return (extensions ?? []).filter((e): e is ActiveExtension & Required<Pick<ActiveExtension, K>> => typeof e[hook] === 'function');
}
