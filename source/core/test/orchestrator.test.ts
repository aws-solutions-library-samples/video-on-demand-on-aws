/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * Guards the Part 0 orchestration contract (raw ASL, not the synthesized template):
 *   - a single Orchestrator state machine runs the three stages as startExecution.sync:2 children,
 *     creates the DynamoDB item up front, and owns the single centralized Error record;
 *   - the three stage machines no longer chain to each other and no longer publish their own
 *     failure notification (each ends in a Fail state that propagates the error to the orchestrator).
 */
const SM_DIR = path.join(__dirname, '..', 'lib', 'state-machines');

function loadStates(name: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(SM_DIR, `${name}.asl.json`), 'utf-8')).States;
}

const STAGES = ['ingest', 'process', 'publish'];

describe('Orchestrator ASL', () => {
  const states = loadStates('orchestrator');

  test('runs Ingest, Process, and Publish as startExecution.sync:2 child executions', () => {
    const childTasks = Object.values(states).filter(
      (s: any) => s.Resource === 'arn:aws:states:::states:startExecution.sync:2',
    ) as any[];
    expect(childTasks).toHaveLength(3);
    const armTokens = childTasks
      .map((t) => t.Parameters.StateMachineArn)
      .sort();
    expect(armTokens).toEqual(
      [
        '${INGEST_STATE_MACHINE_ARN}',
        '${PROCESS_STATE_MACHINE_ARN}',
        '${PUBLISH_STATE_MACHINE_ARN}',
      ].sort(),
    );
  });

  // Named after the Orchestrator execution (unique per run, so a re-drive of the same guid works) but
  // hashed: EventBridge names that execution `<event-id>_<uuid>` (73 chars), and `<name>-process` would
  // exceed the 80-character execution-name limit. MD5 hex (32) + `-<stage>` is at most 40.
  test('names child executions after a hash of the Orchestrator execution (re-drive safe, <= 80 chars)', () => {
    for (const [state, stage] of [['Ingest', 'ingest'], ['Process', 'process'], ['Publish', 'publish']]) {
      expect(states[state].Parameters['Name.$']).toBe(
        `States.Format('{}-${stage}', States.Hash($$.Execution.Name, 'MD5'))`,
      );
    }
  });

  test('creates the item up front (Record Started putItem with orchestratorExecutionArn)', () => {
    const started = states['Record Started'];
    expect(started.Resource).toBe('arn:aws:states:::dynamodb:putItem');
    expect(started.Parameters.Item.orchestratorExecutionArn).toBeDefined();
    expect(started.Parameters.Item.workflowStatus.S).toBe('Ingest');
  });

  // Idempotent ingestion — deterministic guid + conditional PutItem dedup duplicate S3 events.
  test('idempotency: derives a deterministic guid from key + versionId via States.Hash (no States.UUID)', () => {
    const guidExpr = states['Generate GUID'].Parameters['guid.$'] as string;
    expect(guidExpr).not.toContain('States.UUID');
    expect(guidExpr).toContain('States.Hash(');
    expect(guidExpr).toContain("'SHA-256'");
    expect(guidExpr).toContain('$.detail.object.key');
    expect(guidExpr).toContain("$.detail.object['version-id']");
  });

  test('idempotency: Record Started put is conditional on attribute_not_exists(guid)', () => {
    expect(states['Record Started'].Parameters.ConditionExpression).toBe('attribute_not_exists(guid)');
  });

  test('idempotency: a conditional-check failure is caught to Duplicate Skipped before the generic catcher', () => {
    const started = states['Record Started'];
    const errorEquals = started.Catch.map((c: any) => c.ErrorEquals);
    // The specific dedup catcher must precede the States.ALL catcher (evaluated top-to-bottom).
    expect(errorEquals[0]).toEqual(['DynamoDB.ConditionalCheckFailedException']);
    expect(started.Catch[0].Next).toBe('Duplicate Skipped');
    expect(errorEquals[errorEquals.length - 1]).toEqual(['States.ALL']);
    expect(started.Catch[started.Catch.length - 1].Next).toBe('Set Ingest Error');
    // The normal (first-delivery) path still flows to Ingest.
    expect(started.Next).toBe('Ingest');
  });

  test('idempotency: Duplicate Skipped is a benign Succeed that never records an error or notifies', () => {
    const dup = states['Duplicate Skipped'];
    expect(dup.Type).toBe('Succeed');
    // A duplicate short-circuits; it must not thread into the failure path.
    expect(dup.Next).toBeUndefined();
    expect(dup.Resource).toBeUndefined();
  });

  test('assembles the job config into a clear $.config JSON block (Generate GUID -> Load Job Config -> Record Started)', () => {
    // Generate GUID no longer carries the toggles inline; it hands off to Load Job Config.
    const genGuid = states['Generate GUID'];
    expect(genGuid.Type).toBe('Pass');
    expect(genGuid.Next).toBe('Load Job Config');
    expect(genGuid.Parameters).not.toHaveProperty('archiveSource');
    expect(genGuid.Parameters).not.toHaveProperty('enableSns');
    expect(genGuid.Parameters).not.toHaveProperty('enableSqs');

    // Load Job Config emits the config object at $.config (interim; a future S3 sidecar read replaces it).
    const cfg = states['Load Job Config'];
    expect(cfg.Type).toBe('Pass');
    expect(cfg.ResultPath).toBe('$.config');
    expect(cfg.Next).toBe('Record Started');
    expect(cfg.Parameters).toEqual({
      archiveSource: '${ARCHIVE_SOURCE}',
      enableSns: '${ENABLE_SNS}',
      enableSqs: '${ENABLE_SQS}',
    });
  });

  test('Record Started and the Ingest child read/forward the config block', () => {
    expect(states['Record Started'].Parameters.Item.archiveSource['S.$']).toBe('$.config.archiveSource');
    const ingest = states['Ingest'];
    expect(ingest.Parameters.Input['config.$']).toBe('$.config');
    // The loose top-level toggle fields are no longer threaded to the child.
    expect(ingest.Parameters.Input).not.toHaveProperty('archiveSource.$');
    expect(ingest.Parameters.Input).not.toHaveProperty('enableSns.$');
    expect(ingest.Parameters.Input).not.toHaveProperty('enableSqs.$');
  });

  test('has a single centralized Record Failure that writes workflowStatus=Error + stage + message', () => {
    const failure = states['Record Failure'];
    expect(failure.Resource).toBe('arn:aws:states:::dynamodb:updateItem');
    const expr = failure.Parameters.UpdateExpression as string;
    expect(expr).toContain('workflowStatus = :s');
    expect(expr).toContain('errorStage = :st');
    expect(expr).toContain('errorMessage = :m');
    expect(failure.Parameters.ExpressionAttributeValues[':s'].S).toBe('Error');
  });

  test('the failure notification always fires (single SNS publish on the failure path)', () => {
    const notify = states['Notify Failure'];
    expect(notify.Resource).toBe('arn:aws:states:::sns:publish');
  });
});

describe.each(STAGES)('Stage ASL: %s is a pure child of the orchestrator', (name) => {
  const states = loadStates(name);

  test('does not chain to another stage (no states:startExecution task)', () => {
    const chaining = Object.values(states).filter((s: any) =>
      typeof s.Resource === 'string' && s.Resource.includes('states:startExecution'),
    );
    expect(chaining).toEqual([]);
  });

  test('does not own a failure notification (no "Notify Failure" state)', () => {
    expect(states['Notify Failure']).toBeUndefined();
  });

  test('ends failures in a Fail state that propagates the error via ErrorPath/CausePath', () => {
    const failStates = Object.values(states).filter((s: any) => s.Type === 'Fail') as any[];
    expect(failStates.length).toBeGreaterThanOrEqual(1);
    for (const f of failStates) {
      expect(f.ErrorPath).toBe('$.error.Error');
      expect(f.CausePath).toBe('$.error.Cause');
    }
  });
});
