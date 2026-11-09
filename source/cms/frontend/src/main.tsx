/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Amplify } from 'aws-amplify';
import '@cloudscape-design/global-styles/index.css';
import '@aws-amplify/ui-react/styles.css';
import './auth-styles.css';
import './top-nav.css';
import awsConfig from './aws-exports';
import App from './App';

Amplify.configure(awsConfig);

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
