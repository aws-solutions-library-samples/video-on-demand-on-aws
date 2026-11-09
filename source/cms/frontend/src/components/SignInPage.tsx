/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 *
 * Pre-auth screen: AWS brand (2026, Lagoon mood). On wide screens a split layout: the left side tells a
 * demo audience what the solution does (the upload -> ingest -> process -> publish pipeline), the right
 * side holds the Amplify <Authenticator> in a white card (fields never sit on the gradient). Every
 * Authenticator route (sign in, first-sign-in password change, TOTP setup / code, password reset) gets
 * the same eyebrow + title + explanation header. AuthGate renders this until Cognito reports
 * `authenticated`, then renders the app. Must be mounted under <Authenticator.Provider>. Styles live
 * in auth-styles.css.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react';
import { APP_NAME } from '../theme/tokens';

// Mirrors the Cognito password policy in source/cms/backend/lib/cms-stack.ts (minLength 12 + all classes).
const PASSWORD_RULES = 'At least 12 characters, with upper and lower case letters, a number and a symbol.';

const PIPELINE = [
  { stage: 'Upload', service: 'Amazon S3', detail: 'Source video lands in the source bucket' },
  { stage: 'Ingest', service: 'AWS Step Functions', detail: 'Validates and probes each asset' },
  { stage: 'Process', service: 'AWS Elemental MediaConvert', detail: 'Transcodes an adaptive CMAF ladder' },
  { stage: 'Publish', service: 'Amazon CloudFront', detail: 'Streams HLS and DASH worldwide' },
];

function AuthHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <header className="signin__header">
      <p className="signin__eyebrow">{eyebrow}</p>
      <h1 className="signin__title">{title}</h1>
      {children && <div className="signin__lede">{children}</div>}
    </header>
  );
}

const header = (eyebrow: string, title: string, body?: ReactNode) =>
  function Header() {
    return <AuthHeader eyebrow={eyebrow} title={title}>{body}</AuthHeader>;
  };

const components = {
  SignIn: { Header: header('Operator console', 'Sign in', 'Manage uploads, workflows and playback for this deployment.') },
  ForceNewPassword: {
    Header: header('First sign-in', 'Choose a new password', (
      <>
        <p>Replace the temporary password from your invitation with one only you know.</p>
        <p className="signin__rules">{PASSWORD_RULES}</p>
      </>
    )),
  },
  SetupTotp: {
    Header: header('First sign-in', 'Set up multi-factor authentication',
      'Scan the QR code with an authenticator app, then enter the 6-digit code it shows.'),
  },
  ConfirmSignIn: {
    Header: header('Operator console', 'Enter your authentication code',
      `Open your authenticator app and enter the 6-digit code for ${APP_NAME}.`),
  },
  ForgotPassword: {
    Header: header('Account recovery', 'Reset your password',
      'Enter your username or email. If it matches an account, a verification code is emailed to you.'),
  },
  ConfirmResetPassword: {
    Header: header('Account recovery', 'Choose a new password', (
      <>
        <p>Enter the code from the email, then your new password.</p>
        <p className="signin__rules">{PASSWORD_RULES}</p>
      </>
    )),
  },
};

const newPassword = {
  password: { label: 'New password', placeholder: 'Enter a new password', autocomplete: 'new-password', isRequired: true },
  confirm_password: { label: 'Confirm new password', placeholder: 'Enter it again', autocomplete: 'new-password', isRequired: true },
};
const otp = (label: string) => ({ label, placeholder: '6-digit code', autocomplete: 'one-time-code', isRequired: true });
const usernameField = { label: 'Username or email', placeholder: 'Enter your username or email', autocomplete: 'username', isRequired: true };
const formFields = {
  signIn: {
    username: usernameField,
    password: { label: 'Password', placeholder: 'Enter your password', autocomplete: 'current-password', isRequired: true },
  },
  forceNewPassword: newPassword,
  setupTotp: { QR: { totpIssuer: APP_NAME }, confirmation_code: otp('Code from your authenticator app') },
  confirmSignIn: { confirmation_code: otp('Authentication code') },
  forgotPassword: { username: usernameField },
  confirmResetPassword: { confirmation_code: otp('Code from the email'), ...newPassword },
};

function DemoStory() {
  return (
    <section className="signin__story" aria-label={`About ${APP_NAME}`}>
      <p className="signin__story-eyebrow">Serverless video on demand</p>
      <h2 className="signin__story-title">Upload a video. Stream it everywhere.</h2>
      <p className="signin__story-lede">
        Each upload is probed, transcoded to adaptive HLS and DASH and delivered through a global CDN, orchestrated
        end to end by AWS Step Functions with no servers to manage.
      </p>
      <ol className="signin__pipeline">
        {PIPELINE.map((s, i) => (
          <li key={s.stage} className="signin__step" style={{ animationDelay: `${120 + i * 90}ms` }}>
            <span className="signin__step-dot" aria-hidden="true">{i + 1}</span>
            <span className="signin__step-text">
              <span className="signin__step-stage">{s.stage}</span>
              <span className="signin__step-service">{s.service}</span>
              <span className="signin__step-detail">{s.detail}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function SignInPage() {
  const { route } = useAuthenticator((c) => [c.route]);
  const card = useRef<HTMLElement>(null);
  // Put the cursor in the first field of each step (username, new password, code, ...).
  useEffect(() => {
    card.current?.querySelector<HTMLInputElement>('input:not([type=hidden]):not([disabled])')?.focus();
  }, [route]);
  return (
    <div className="signin">
      <div className="signin__brand">{APP_NAME}</div>
      <div className="signin__body">
        <DemoStory />
        <main className="signin__card" ref={card}>
          <Authenticator loginMechanisms={['username', 'email']} hideSignUp components={components} formFields={formFields} />
          {route === 'signIn' && (
            <p className="signin__footer">Access is by invitation. Contact your administrator for an account.</p>
          )}
        </main>
      </div>
    </div>
  );
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const { authStatus } = useAuthenticator((c) => [c.authStatus]);
  if (authStatus === 'authenticated') return <>{children}</>;
  if (authStatus === 'configuring') return null;
  return <SignInPage />;
}
