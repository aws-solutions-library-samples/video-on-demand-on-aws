/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

const fs = require('fs');
const path = require('path');

module.exports = {
  testEnvironment: 'node',
  // Installed extensions (lib/extensions.ts) carry their own tests under extensions/<name>/test.
  roots: ['<rootDir>/test', ...(fs.existsSync(path.join(__dirname, 'extensions')) ? ['<rootDir>/extensions'] : [])],
  testMatch: ['**/*.test.ts'],
  // Resolve TypeScript sources before any compiled .js left beside them by `tsc`.
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  }
};
