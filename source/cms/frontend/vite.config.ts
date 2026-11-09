/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The operator web app. Config (Cognito + API URL) is injected at build time from
// VITE_* env (written by scripts/deploy-all.sh from the CDK stack outputs) — nothing hardcoded.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, open: true },
});
