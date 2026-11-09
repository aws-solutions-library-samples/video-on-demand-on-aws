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
 * Locates the solution's single deploy-config file: the repo-root `.env` (copy `.env.example`).
 * Every CDK app (core and each module) loads it from its `bin/` entry point, so one file configures
 * the whole solution; explicit `-c key=value` still wins (see `withEnvFallback`).
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Walk up from `fromDir` to the repo root: the outermost directory whose `package.json` declares
 * `workspaces`, so a nested workspaces root (e.g. `source/modules`) still resolves to the repo root.
 * Returns `undefined` when not inside the repo.
 */
export function findRepoRoot(fromDir: string): string | undefined {
  let dir = path.resolve(fromDir);
  let root: string | undefined;
  for (;;) {
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        if (JSON.parse(fs.readFileSync(pkg, 'utf8')).workspaces) {
          root = dir;
        }
      } catch {
        // Unparseable package.json: keep walking up.
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return root;
    }
    dir = parent;
  }
}

/**
 * Environment variable that overrides the deploy-config file: a path (absolute, or relative to the
 * current directory) such as `.env.prod`, or `none` to load no file at all.
 */
export const DEPLOY_ENV_FILE_VAR = 'VOD_ENV_FILE';

/**
 * Absolute path of the deploy-config file to load, or `undefined` for none: `$VOD_ENV_FILE` when set,
 * else the repo-root `.env` if it exists.
 */
export function deployEnvPath(fromDir: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const override = env[DEPLOY_ENV_FILE_VAR];
  if (override !== undefined && override !== '') {
    if (override === 'none') {
      return undefined;
    }
    const file = path.resolve(override);
    if (!fs.existsSync(file)) {
      throw new Error(`${DEPLOY_ENV_FILE_VAR}=${override}: file not found (${file}).`);
    }
    return file;
  }
  const root = findRepoRoot(fromDir);
  const file = root ? path.join(root, '.env') : undefined;
  return file && fs.existsSync(file) ? file : undefined;
}
