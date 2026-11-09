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


import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SsmKey, ssmParameterName, contextKeyToEnvVar, withEnvFallback, deployEnvPath, findRepoRoot, resolveExtensions, EXTENSIONS_CONTEXT_KEY } from '../src';

describe('ssmParameterName', () => {
  test('builds the /<stack>/<Key> path', () => {
    expect(ssmParameterName('VideoOnDemand', SsmKey.DynamoDBTable)).toBe('/VideoOnDemand/DynamoDBTable');
  });

  // The CMS Lambda and deploy scripts hard-code these names (they cannot import this package), so
  // renaming a key is a breaking cross-stack change. Pin the full set.
  test('key set is stable', () => {
    expect(Object.values(SsmKey).sort()).toEqual([
      'CloudFrontDomainName',
      'DestinationBucket',
      'DynamoDBTable',
      'IntermediateBucket',
      'OrchestratorStateMachineArn',
      'SourceBucket',
      'SsaiHlsManifestEndpointPrefix',
    ]);
  });
});

describe('contextKeyToEnvVar', () => {
  test.each([
    ['email', 'EMAIL'],
    ['packagingProfile', 'PACKAGING_PROFILE'],
    ['wafWebAclArn', 'WAF_WEB_ACL_ARN'],
    ['thumbnailsProfile', 'THUMBNAILS_PROFILE'],
  ])('%s -> %s', (key, envVar) => {
    expect(contextKeyToEnvVar(key)).toBe(envVar);
  });
});

describe('withEnvFallback', () => {
  const base = (ctx: Record<string, unknown>) => ({ tryGetContext: (k: string) => ctx[k] });

  test('falls back to the UPPER_SNAKE env var', () => {
    expect(withEnvFallback(base({}), { PACKAGING_PROFILE: 'ON' }).tryGetContext('packagingProfile')).toBe('ON');
  });

  test('explicit context wins over env', () => {
    expect(withEnvFallback(base({ email: 'cli@example.com' }), { EMAIL: 'env@example.com' }).tryGetContext('email')).toBe(
      'cli@example.com',
    );
  });
});

describe('deployEnvPath', () => {
  test('finds the workspaces root and its .env from a nested package dir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vod-contract-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['source/*'] }));
    const nested = path.join(root, 'source', 'modules', 'waf', 'bin');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(root, 'source', 'modules', 'waf', 'package.json'), '{}');
    expect(findRepoRoot(nested)).toBe(root);
    expect(deployEnvPath(nested, {})).toBeUndefined();
    fs.writeFileSync(path.join(root, '.env'), 'EMAIL=ops@example.com\n');
    expect(deployEnvPath(nested, {})).toBe(path.join(root, '.env'));

    // VOD_ENV_FILE overrides: another file, or `none` for no file.
    fs.writeFileSync(path.join(root, '.env.prod'), 'EMAIL=prod@example.com\n');
    expect(deployEnvPath(nested, { VOD_ENV_FILE: path.join(root, '.env.prod') })).toBe(path.join(root, '.env.prod'));
    expect(deployEnvPath(nested, { VOD_ENV_FILE: 'none' })).toBeUndefined();
    expect(() => deployEnvPath(nested, { VOD_ENV_FILE: path.join(root, 'missing.env') })).toThrow(/file not found/);
  });

  test('a nested workspaces root resolves to the outermost (repo) root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vod-contract-'));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['source/core'] }));
    fs.mkdirSync(path.join(root, 'source', 'modules', 'example', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'source', 'modules', 'package.json'), JSON.stringify({ workspaces: ['example'] }));
    expect(findRepoRoot(path.join(root, 'source', 'modules', 'example', 'bin'))).toBe(root);
  });
});

describe('resolveExtensions', () => {
  const reader = (ctx: Record<string, unknown>) => ({ tryGetContext: (k: string) => ctx[k] });
  const installed = [{ name: 'alpha', contextKeys: ['alphaMode'] }, { name: 'beta' }];

  test('unset or empty enables nothing', () => {
    expect(resolveExtensions(reader({}), installed)).toEqual([]);
    expect(resolveExtensions(reader({ vodExtensions: ' ' }), installed)).toEqual([]);
  });

  test('enables the listed subset, in installed order (comma string or array)', () => {
    expect(resolveExtensions(reader({ vodExtensions: 'beta, alpha' }), installed).map((e) => e.name)).toEqual(['alpha', 'beta']);
    expect(resolveExtensions(reader({ vodExtensions: ['beta'] }), installed).map((e) => e.name)).toEqual(['beta']);
  });

  test('a listed name that is not installed throws', () => {
    expect(() => resolveExtensions(reader({ vodExtensions: 'alpha,gamma' }), installed)).toThrow(/'gamma', which is not installed/);
    expect(() => resolveExtensions(reader({ vodExtensions: 'Bad_Name' }), installed)).toThrow(/extension names/);
  });

  test("an unlisted extension's own key throws instead of being ignored", () => {
    expect(() => resolveExtensions(reader({ alphaMode: 'ON' }), installed)).toThrow(/'alphaMode' is set but extension 'alpha' is not enabled/);
    expect(resolveExtensions(reader({ alphaMode: 'ON', vodExtensions: 'alpha' }), installed).map((e) => e.name)).toEqual(['alpha']);
  });

  test('reads VOD_EXTENSIONS through withEnvFallback', () => {
    expect(contextKeyToEnvVar(EXTENSIONS_CONTEXT_KEY)).toBe('VOD_EXTENSIONS');
    const r = withEnvFallback(reader({}), { VOD_EXTENSIONS: 'beta' });
    expect(resolveExtensions(r, installed).map((e) => e.name)).toEqual(['beta']);
  });
});
