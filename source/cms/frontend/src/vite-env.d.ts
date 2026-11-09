/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_COGNITO_USER_POOL_ID?: string;
  readonly VITE_COGNITO_CLIENT_ID?: string;
  readonly VITE_COGNITO_REGION?: string;
  readonly VITE_COGNITO_IDENTITY_POOL_ID?: string;
  readonly VITE_API_URL?: string;
  readonly VITE_UPLOAD_BUCKET?: string;
  readonly VITE_UPLOAD_REGION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
