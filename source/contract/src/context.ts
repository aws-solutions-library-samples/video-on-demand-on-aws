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
 * Deploy-time context helpers shared by every CDK app in the repo, so all of them apply the same
 * precedence: explicit `-c key=value` / cdk.json context first, then the matching UPPER_SNAKE
 * environment variable (typically loaded from a `.env` file by the app's `bin/` entry point).
 */

/** The subset of the CDK `Node` API the context readers need (keeps parsers unit-testable). */
export interface ContextReader {
  tryGetContext(key: string): unknown;
}

/**
 * Convert a camelCase context key to its UPPER_SNAKE_CASE environment-variable name
 * (e.g. `packagingProfile` -> `PACKAGING_PROFILE`, `email` -> `EMAIL`, `wafWebAclArn` -> `WAF_WEB_ACL_ARN`).
 */
export function contextKeyToEnvVar(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase();
}

/**
 * Wrap a base {@link ContextReader} (typically the CDK `app.node`) so any key NOT supplied via CDK
 * context falls back to `env[<UPPER_SNAKE key>]`. Explicit `-c` / cdk.json context wins over `.env`.
 */
export function withEnvFallback(
  base: ContextReader,
  env: Record<string, string | undefined> = process.env,
): ContextReader {
  return {
    tryGetContext(key: string): unknown {
      const fromContext = base.tryGetContext(key);
      if (fromContext !== undefined && fromContext !== null) {
        return fromContext;
      }
      return env[contextKeyToEnvVar(key)];
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Validation primitives shared by every app's context parser. Each throws {@link VodContextError}
// so `cdk synth` fails fast with an actionable message.
// ---------------------------------------------------------------------------------------------

/** Thrown when a context value fails validation. Message is prefixed for easy grepping. */
export class VodContextError extends Error {
  constructor(message: string) {
    super(`Invalid VOD context: ${message}`);
    this.name = 'VodContextError';
  }
}

const COUNTRY_CODE_REGEX = /^[A-Za-z]{2}$/;

// IPv4 CIDR: four 0-255 octets + a /0-32 prefix.
const IPV4_CIDR_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** Read a context key, normalizing `null` and empty / whitespace-only strings to `undefined`. */
export function readContextValue(reader: ContextReader, key: string): unknown {
  const value = reader.tryGetContext(key);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === 'string' && value.trim() === '') {
    return undefined;
  }
  return value;
}

/** Validate a value is one of the allowed literals, applying a default when absent. */
export function coerceEnum<T extends string>(
  value: unknown,
  key: string,
  allowed: readonly T[],
  defaultValue: T,
): T {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new VodContextError(
    `'${key}' must be one of ${allowed.join(' | ')}; received ${JSON.stringify(value)}.`,
  );
}

/**
 * Split a context value into a trimmed, non-empty list. Accepts a JSON array (cdk.json) or a
 * comma-separated string (`-c key=a,b`). Returns `undefined` when the result is empty.
 */
export function coerceStringList(value: unknown): unknown[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const list: unknown[] = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [value];
  const items = list
    .map((entry) => (typeof entry === 'string' ? entry.trim() : entry))
    .filter((entry) => entry !== '');
  return items.length === 0 ? undefined : items;
}

/**
 * Normalize an optional list of ISO 3166-1 alpha-2 country codes into an uppercased list. `key` names the
 * offending input in the error message.
 */
export function coerceCountryCodes(value: unknown, key: string): string[] | undefined {
  const codes = coerceStringList(value);
  if (codes === undefined) {
    return undefined;
  }
  for (const code of codes) {
    if (typeof code !== 'string' || !COUNTRY_CODE_REGEX.test(code)) {
      throw new VodContextError(
        `'${key}' must be a list of ISO 3166-1 alpha-2 country codes; received ${JSON.stringify(code)}.`,
      );
    }
  }
  return (codes as string[]).map((code) => code.toUpperCase());
}

/** Validate an optional list of IPv4 CIDR ranges. IPv6 is not supported. */
export function coerceCidrList(value: unknown, key: string): string[] | undefined {
  const items = coerceStringList(value);
  if (items === undefined) {
    return undefined;
  }
  for (const cidr of items) {
    const match = typeof cidr === 'string' ? IPV4_CIDR_REGEX.exec(cidr) : null;
    const valid =
      match !== null &&
      match.slice(1, 5).every((octet) => Number(octet) <= 255) &&
      Number(match[5]) <= 32;
    if (!valid) {
      throw new VodContextError(
        `'${key}' must be a list of IPv4 CIDR ranges (e.g. 203.0.113.0/24); received ${JSON.stringify(cidr)}.`,
      );
    }
  }
  return items as string[];
}

/** Validate an optional `https://` URL. */
export function coerceHttpsUrl(value: unknown, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || !/^https:\/\//.test(value)) {
    throw new VodContextError(`'${key}' must be an https:// URL; received ${JSON.stringify(value)}.`);
  }
  return value;
}

/** Validate an optional plain string context value. */
export function coerceOptionalString(value: unknown, key: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new VodContextError(`'${key}' must be a string; received ${JSON.stringify(value)}.`);
  }
  return value;
}

/** The context key listing the extensions to enable (`.env` `VOD_EXTENSIONS`), shared by every app. */
export const EXTENSIONS_CONTEXT_KEY = 'vodExtensions';

/** An installed extension, as {@link resolveExtensions} sees it. */
export interface InstalledExtension {
  /** The extension's name (its directory name). */
  readonly name: string;
  /** Context keys only this extension reads: setting one while the extension is not listed is an error. */
  readonly contextKeys?: readonly string[];
}

/**
 * The installed extensions to enable, in `installed` order: those named in the {@link EXTENSIONS_CONTEXT_KEY}
 * list (a JSON array or comma-separated string; unset = none). Throws a {@link VodContextError} for a listed
 * name that is not installed, and for an unlisted extension whose own context key is set (it would be
 * silently ignored otherwise).
 */
export function resolveExtensions<T extends InstalledExtension>(reader: ContextReader, installed: readonly T[]): T[] {
  const raw = coerceStringList(readContextValue(reader, EXTENSIONS_CONTEXT_KEY)) ?? [];
  const listed = raw.map((name) => {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
      throw new VodContextError(`'${EXTENSIONS_CONTEXT_KEY}' entries must be extension names (a-z, 0-9, -); received ${JSON.stringify(name)}.`);
    }
    return name;
  });
  const names = installed.map((e) => e.name);
  const missing = listed.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new VodContextError(
      `'${EXTENSIONS_CONTEXT_KEY}' lists ${missing.map((n) => `'${n}'`).join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not installed` +
        ` (installed: ${names.length > 0 ? names.join(', ') : 'none'}).`,
    );
  }
  for (const extension of installed) {
    if (listed.includes(extension.name)) continue;
    const setKey = (extension.contextKeys ?? []).find((key) => readContextValue(reader, key) !== undefined);
    if (setKey) {
      throw new VodContextError(
        `'${setKey}' is set but extension '${extension.name}' is not enabled: add it to '${EXTENSIONS_CONTEXT_KEY}' (VOD_EXTENSIONS).`,
      );
    }
  }
  return installed.filter((e) => listed.includes(e.name));
}
