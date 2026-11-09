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
 * NotificationsConstruct — SNS topic (+ email subscription) + SQS results queue + dead-letter
 * queue, plus the workflow observability baseline (one `ExecutionsFailed` CloudWatch alarm per
 * state machine wired to the SNS topic, and a single CloudWatch dashboard).
 *
 * The SNS topic and SQS queue are consumed by the workflow ASL through `definitionSubstitutions`
 * (`${SNS_TOPIC_ARN}` / `${SQS_QUEUE_URL}`); the Publish state machine publishes success and
 * error notifications to the topic and (when enabled) the results to the queue via native Step
 * Functions integrations — replacing the v6 `sns-notification` / `sqs-publish` / `error-handler`
 * Lambdas.
 *
 * The three state machines do not exist when Notifications is instantiated (Workflow is built
 * last, after it can read this construct's `topic`/`queue`), so the observability baseline is
 * wired by the orchestrator through {@link NotificationsConstruct.addWorkflowObservability} once
 * the WorkflowConstruct exists.
 */

import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';

import { INotificationsConstruct, NotificationsConstructProps } from './interfaces';

/** Shared queue tuning (mirrors the v6 results/DLQ queues). */
const QUEUE_VISIBILITY_TIMEOUT = cdk.Duration.seconds(120);
const QUEUE_DATA_KEY_REUSE = cdk.Duration.seconds(300);

export class NotificationsConstruct extends Construct implements INotificationsConstruct {
  public readonly topic: sns.Topic;
  public readonly queue: sqs.Queue;
  public readonly queueArn: string;
  public readonly queueUrl: string;

  /** Guard so the orchestrator cannot wire the observability baseline twice. */
  private observabilityWired = false;

  constructor(scope: Construct, id: string, props: NotificationsConstructProps) {
    super(scope, id);

    /**
     * Customer-managed KMS key for the SNS notification topic. A customer-managed key (rather than
     * the AWS-managed `alias/aws/sns` key) is required so the key policy can grant
     * `cloudwatch.amazonaws.com` the `kms:GenerateDataKey*`/`kms:Decrypt` it needs to publish the
     * per-state-machine `ExecutionsFailed` alarms to the encrypted topic. The AWS-managed key's
     * policy cannot be edited, which silently drops alarm-driven notifications (KMSAccessDenied).
     * Key rotation is enabled. The Step Functions publisher roles authorize this key through their
     * existing `kms:ViaService=sns` identity grants (the key policy delegates to IAM via the root
     * account statement), so no key-policy grant is needed for them.
     */
    const notificationsKey = new kms.Key(this, 'NotificationsKey', {
      description: `${cdk.Aws.STACK_NAME} SNS notifications topic key`,
      enableKeyRotation: true,
    });
    notificationsKey.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchAlarmActionsToUseKey',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['kms:Decrypt', 'kms:GenerateDataKey*'],
      resources: ['*'],
    }));

    /**
     * SNS notification topic. Encrypted with the customer-managed key above (satisfies
     * AwsSolutions-SNS2) and requires publishers to use SSL (AwsSolutions-SNS3). The email from
     * the validated context is subscribed at deploy time (replaces the v6 `AdminEmail`
     * parameter + `input-validate` wiring).
     */
    this.topic = new sns.Topic(this, 'Topic', {
      displayName: `${cdk.Aws.STACK_NAME}-Notifications`,
      masterKey: notificationsKey,
      enforceSSL: true,
    });
    this.topic.addSubscription(new subscriptions.EmailSubscription(props.context.email));

    /**
     * SQS results queue + dead-letter queue. Both use SQS-managed SSE (KMS_MANAGED, satisfies
     * AwsSolutions-SQS2) and require SSL (AwsSolutions-SQS4). The Publish state machine sends the
     * completion payload to the results queue when `enableSqs` is `true`.
     */
    const deadLetterQueue = new sqs.Queue(this, 'DeadLetterQueue', {
      queueName: `${cdk.Aws.STACK_NAME}-dlq`,
      visibilityTimeout: QUEUE_VISIBILITY_TIMEOUT,
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      dataKeyReuse: QUEUE_DATA_KEY_REUSE,
      enforceSSL: true,
    });
    NagSuppressions.addResourceSuppressions(deadLetterQueue, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This resource is the dead-letter queue for the results queue.',
      },
    ]);

    this.queue = new sqs.Queue(this, 'Queue', {
      queueName: `${cdk.Aws.STACK_NAME}`,
      visibilityTimeout: QUEUE_VISIBILITY_TIMEOUT,
      deadLetterQueue: {
        queue: deadLetterQueue,
        maxReceiveCount: 1,
      },
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      dataKeyReuse: QUEUE_DATA_KEY_REUSE,
      enforceSSL: true,
    });

    this.queueArn = this.queue.queueArn;
    this.queueUrl = this.queue.queueUrl;
  }

  /**
   * Wire the workflow observability baseline: one `ExecutionsFailed` alarm per state machine
   * (action -> this construct's SNS topic) plus one CloudWatch dashboard summarizing execution
   * counts and durations across the three state machines.
   *
   * The alarm action targets the SNS topic, which is encrypted with the construct's
   * customer-managed KMS key whose policy grants `cloudwatch.amazonaws.com`
   * `kms:GenerateDataKey*`/`kms:Decrypt`, so alarm-driven notifications are delivered to the topic
   * (the AWS-managed `alias/aws/sns` key could not grant this).
   */
  public addWorkflowObservability(stateMachines: readonly sfn.IStateMachine[]): void {
    if (this.observabilityWired) {
      throw new Error('NotificationsConstruct.addWorkflowObservability was already called; it must be wired exactly once.');
    }
    this.observabilityWired = true;

    const alarmAction = new cloudwatchActions.SnsAction(this.topic);
    const executionWidgets: cloudwatch.GraphWidget[] = [];
    const durationWidgets: cloudwatch.GraphWidget[] = [];

    for (const stateMachine of stateMachines) {
      const label = stateMachine.node.id;

      const alarm = new cloudwatch.Alarm(this, `${label}ExecutionsFailedAlarm`, {
        alarmName: `${cdk.Aws.STACK_NAME}-${label}-ExecutionsFailed`,
        alarmDescription: `One or more executions of the ${label} state machine failed.`,
        metric: stateMachine.metricFailed({
          period: cdk.Duration.minutes(5),
          statistic: cloudwatch.Stats.SUM,
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarm.addAlarmAction(alarmAction);

      executionWidgets.push(new cloudwatch.GraphWidget({
        title: `${label} executions`,
        width: 8,
        left: [
          stateMachine.metricStarted(),
          stateMachine.metricSucceeded(),
          stateMachine.metricFailed(),
          stateMachine.metricTimedOut(),
        ],
      }));

      durationWidgets.push(new cloudwatch.GraphWidget({
        title: `${label} execution time`,
        width: 8,
        left: [stateMachine.metricTime()],
      }));
    }

    const dashboard = new cloudwatch.Dashboard(this, 'WorkflowDashboard', {
      dashboardName: `${cdk.Aws.STACK_NAME}-vod-workflow`,
    });
    dashboard.addWidgets(...executionWidgets);
    dashboard.addWidgets(...durationWidgets);
  }
}
