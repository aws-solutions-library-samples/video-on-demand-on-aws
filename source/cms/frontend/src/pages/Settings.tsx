/*
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved. Apache-2.0.
 */
import { Container, ContentLayout, Header, SpaceBetween, Toggle } from '@cloudscape-design/components';
import { useColorScheme } from '../hooks/useColorScheme';

export default function Settings() {
  const { dark, setDark } = useColorScheme();
  return (
    <ContentLayout header={<Header variant="h1">Settings</Header>}>
      <Container header={<Header variant="h2">Appearance</Header>}>
        <SpaceBetween size="m">
          <Toggle checked={dark} onChange={({ detail }) => setDark(detail.checked)}>
            Dark mode
          </Toggle>
        </SpaceBetween>
      </Container>
    </ContentLayout>
  );
}
