/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Amplify config sourced from build-time env (VITE_*). Produced by the backend CDK stacks and
 * written into .env by scripts/deploy-all.sh (or copy from the AuthStack outputs for local dev).
 * Never hardcode pool ids here — keep this generic so one build works against any environment.
 */
const region = import.meta.env.VITE_COGNITO_REGION ?? 'us-east-1';
const uploadBucket = import.meta.env.VITE_UPLOAD_BUCKET ?? '';

const awsConfig = {
  Auth: {
    Cognito: {
      userPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID ?? '',
      userPoolClientId: import.meta.env.VITE_COGNITO_CLIENT_ID ?? '',
      // Identity Pool gives signed-in users short-lived AWS creds for Amplify Storage uploads.
      identityPoolId: import.meta.env.VITE_COGNITO_IDENTITY_POOL_ID ?? '',
      signUpVerificationMethod: 'code' as const,
    },
  },
  // Storage points at the VOD source bucket so uploadData() lands files where the pipeline triggers.
  // Present only when VITE_UPLOAD_BUCKET is set (self-service upload configured).
  ...(uploadBucket
    ? {
        Storage: {
          S3: {
            bucket: uploadBucket,
            region: import.meta.env.VITE_UPLOAD_REGION ?? region,
          },
        },
      }
    : {}),
};

export default awsConfig;
