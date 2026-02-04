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

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { CloudFrontToS3 } from '@aws-solutions-constructs/aws-cloudfront-s3';
import { NagSuppressions } from 'cdk-nag';

export class VideoOnDemand extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * CloudFormation Template Descrption
     */
    const solutionId = 'SO0021'
    const solutionName = 'Video on Demand on AWS'
    this.templateOptions.description = `(${solutionId}) - ${solutionName} workflow with AWS Step Functions, MediaConvert, MediaPackage, S3, CloudFront and DynamoDB. Version %%VERSION%%`;
    /**
     * Cfn Parameters
     */
    const adminEmail = new cdk.CfnParameter(this, 'AdminEmail', {
      type: 'String',
      description: 'Email address for SNS notifications (subscribed users will receive ingest, publishing, and error notifications)',
      allowedPattern: '^[_A-Za-z0-9-\\+]+(\\.[_A-Za-z0-9-]+)*@[A-Za-z0-9-]+(\\.[A-Za-z0-9]+)*(\\.[A-Za-z]{2,})$'
    });
    const workflowTrigger = new cdk.CfnParameter(this, 'WorkflowTrigger', {
      type: 'String',
      description: 'How the workflow will be triggered (source video upload to S3 or source metadata file upload)',
      default: 'VideoFile',
      allowedValues: ['VideoFile', 'MetadataFile']
    });
    const glacier = new cdk.CfnParameter(this, 'Glacier', {
      type: 'String',
      description: 'If enabled, source assets will be tagged for archiving to Glacier or Glacier Deep Archive once the workflow is complete',
      default: 'DISABLED',
      allowedValues: ['DISABLED', 'GLACIER', 'DEEP_ARCHIVE']

    });
    const frameCapture = new cdk.CfnParameter(this, 'FrameCapture', {
      type: 'String',
      description: 'If enabled, frame capture is added to the job submitted to MediaConvert',
      default: 'No',
      allowedValues: ['Yes', 'No']
    });
    const enableMediaPackage = new cdk.CfnParameter(this, 'EnableMediaPackage', {
      type: 'String',
      description: 'If enabled, MediaPackage VOD will be included in the workflow',
      default: 'No',
      allowedValues: ['Yes', 'No']
    });
    const enableSns = new cdk.CfnParameter(this, 'EnableSns', {
      type: 'String',
      description: 'Enable Ingest and Publish email notifications, error messages are not affected by this parameter.',
      default: 'Yes',
      allowedValues: ['Yes', 'No']
    });
    const enableSqs = new cdk.CfnParameter(this, 'EnableSqs', {
      type: 'String',
      description: 'Publish the workflow results to an SQS queue to injest upstream',
      default: 'Yes',
      allowedValues: ['Yes', 'No']
    });
    const acceleratedTranscoding = new cdk.CfnParameter(this, 'AcceleratedTranscoding', {
      type: 'String',
      description: 'Enable accelerated transcoding in AWS Elemental MediaConvert. PREFERRED will only use acceleration if the input files is supported. ENABLED accleration is applied to all files (this will fail for unsupported file types) see MediaConvert Documentation for more detail https://docs.aws.amazon.com/mediaconvert/latest/ug/accelerated-transcoding.html',
      default: 'PREFERRED',
      allowedValues: ['ENABLED', 'DISABLED', 'PREFERRED']
    });
    /**
     * Template metadata
     */
    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          {
            Label: { default: 'Workflow' },
            Parameters: [
              adminEmail.logicalId,
              workflowTrigger.logicalId,
              glacier.logicalId,
              enableSns.logicalId,
              enableSqs.logicalId
            ]
          },
          {
            Label: { default: 'AWS Elemental MediaConvert' },
            Parameters: [
              frameCapture.logicalId,
              acceleratedTranscoding.logicalId
            ]
          },
          {
            Label: { default: 'AWS Elemental MediaPackage' },
            Parameters: [enableMediaPackage.logicalId]
          }
        ],
        ParameterLabels: {
          AdminEmail: {
            default: 'Notification email address'
          },
          Glacier: {
            default: 'Archive source content'
          },
          WorkflowTrigger: {
            default: 'Workflow trigger'
          },
          FrameCapture: {
            default: 'Enable Frame Capture'
          },
          EnableMediaPackage: {
            default: 'Enable MediaPackage'
          },
          AcceleratedTranscoding: {
            default: 'Accelerated Transcoding'
          },
          EnableSns: {
            default: 'Enable SNS Notifications'
          },
          EnableSqs: {
            default: 'Enable SQS Messaging'
          }
        }
      }
    };
    /**
     * Mapping for sending Anonymized metrics to AWS Solution Builders API
     */
    new cdk.CfnMapping(this, 'AnonymizedData', { // NOSONAR
      mapping: {
        SendAnonymizedData: {
          Data: 'Yes'
        }
      },
    });
    /**
     * Conditions
     */
    const conditionEnableMediaPackage = new cdk.CfnCondition(this, 'EnableMediaPackageCondition', {
      expression: cdk.Fn.conditionEquals(enableMediaPackage.valueAsString, 'Yes')
    });
    const conditionFrameCapture = new cdk.CfnCondition(this, 'FrameCaptureCondition', {
      expression: cdk.Fn.conditionEquals(frameCapture.valueAsString, 'Yes')
    });
    const conditionEnableSns = new cdk.CfnCondition(this, 'EnableSnsCondition', {
      expression: cdk.Fn.conditionEquals(enableSns.valueAsString, 'Yes')
    });
    const conditionEnableSqs = new cdk.CfnCondition(this, 'EnableSqsCondition', {
      expression: cdk.Fn.conditionEquals(enableSqs.valueAsString, 'Yes')
    });


    /**
     * Resources
     */

    /**
     * Logging bucket for S3 and CloudFront
     */
    const logsBucket = new s3.Bucket(this, 'Logs', {
      objectOwnership: s3.ObjectOwnership.OBJECT_WRITER,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true
      }),
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
    });
    const cfnLogsBucket = logsBucket.node.findChild('Resource') as s3.CfnBucket;
    cfnLogsBucket.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
    cfnLogsBucket.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

    //cfn_nag
    cfnLogsBucket.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W35',
            reason: 'Used to store access logs for other buckets'
          }, {
            id: 'W51',
            reason: 'Bucket does not need a bucket policy'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      logsBucket,
      [
        {
          id: 'AwsSolutions-S1', //same as cfn_nag rule W35
          reason: 'Used to store access logs for other buckets'
        }, {
          id: 'AwsSolutions-S10',
          reason: 'Bucket is private and is not using HTTP'
        }
      ]
    );

    /**
     * Source bucket for source video and jobsettings JSON files
     */
    const source = new s3.Bucket(this, 'Source', {
      serverAccessLogsBucket: logsBucket,
      serverAccessLogsPrefix: 'source-bucket-logs/',
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true
      }),
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          id: `${cdk.Aws.STACK_NAME}-source-archive`,
          tagFilters: {
            [cdk.Aws.STACK_NAME]: 'GLACIER'
          },
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER,
              transitionAfter: cdk.Duration.days(1)
            }
          ]
        }, {
          id: `${cdk.Aws.STACK_NAME}-source-deep-archive`,
          tagFilters: {
            [cdk.Aws.STACK_NAME]: 'DEEP_ARCHIVE'
          },
          transitions: [
            {
              storageClass: s3.StorageClass.DEEP_ARCHIVE,
              transitionAfter: cdk.Duration.days(1)
            }
          ]
        }
      ],
      versioned: true,
      enforceSSL: true,
    });
    const cfnSource = source.node.findChild('Resource') as s3.CfnBucket;
    cfnSource.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
    cfnSource.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

    //cfn_nag
    cfnSource.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W51',
            reason: 'Bucket does not need a bucket policy'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      source,
      [
        {
          id: 'AwsSolutions-S10',
          reason: 'Bucket is private and is not using HTTP'
        }
      ]
    );

    /**
     * Destination bucket for workflow outputs
     */
    const destination = new s3.Bucket(this, 'Destination', {
      serverAccessLogsBucket: logsBucket,
      serverAccessLogsPrefix: 'destination-bucket-logs/',
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true
      }),
      encryption: s3.BucketEncryption.S3_MANAGED,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET],
          allowedOrigins: ['*'],
          allowedHeaders: ['*'],
          maxAge: 3000
        }
      ],
      versioned: true,
      enforceSSL: true,
    });
    const cfnDestination = destination.node.findChild('Resource') as s3.CfnBucket;
    cfnDestination.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
    cfnDestination.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      destination,
      [
        {
          id: 'AwsSolutions-S10',
          reason: 'Bucket is private and is not using HTTP'
        }
      ]
    );

    /**
     * CloudFront distribution.
     * AWS Solutions Construct.
     * Construct includes a logs bucket for the CloudFront distribution and a CloudFront
     * OriginAccessIdentity which is used to restrict access to S3 from CloudFront.
     */
    const cachePolicyName = `cp-${cdk.Aws.REGION}-${cdk.Aws.STACK_NAME}`;

    const cachePolicy = new cloudfront.CachePolicy(this, 'CachePolicy', {
      cachePolicyName: cachePolicyName,
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.allowList(
        'Origin',
        'Access-Control-Request-Method',
        'Access-Control-Request-Headers'
      ),
      maxTtl: cdk.Duration.seconds(0)
    });
    const distribution = new CloudFrontToS3(this, 'CloudFrontToS3', {
      existingBucketObj: destination,
      cloudFrontDistributionProps: {
        defaultBehavior: {
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cachePolicy,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS
        },
        priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
        logBucket: logsBucket,
        logFilePrefix: 'cloudfront-logs/'
      },
      insertHttpSecurityHeaders: false,
      logS3AccessLogs: false
    });

    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      destination.policy!,
      [
        {
          id: 'AwsSolutions-S10',
          reason: 'Bucket is private and is not using HTTP'
        }
      ]
    );
    NagSuppressions.addResourceSuppressions(
      distribution.cloudFrontWebDistribution,
      [
        {
          id: 'AwsSolutions-CFR1',
          reason: 'Use case does not warrant CloudFront Geo restriction'
        }, {
          id: 'AwsSolutions-CFR2',
          reason: 'Use case does not warrant CloudFront integration with AWS WAF'
        }, {
          id: 'AwsSolutions-CFR4', //same as cfn_nag rule W70
          reason: 'CloudFront automatically sets the security policy to TLSv1 when the distribution uses the CloudFront domain name'
        }, {
          id: 'AwsSolutions-CFR7',
          reason: 'False alarm. The AWS-cloudfront-s3 solutions construct provides Origin-Access-Control by default.',
        },
      ]
    );

    /**
     * Custom Resource lambda, role, and policy.
     * Creates custom resources
     */
    const customResourceRole = new iam.Role(this, 'CustomResourceRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    const customResourcePolicy = new iam.Policy(this, 'CustomResourcePolicy', {
      statements: [
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        }),
        new iam.PolicyStatement({
          resources: [source.bucketArn],
          actions: [
            's3:PutBucketNotification',
            's3:PutObject',
            's3:PutObjectAcl'
          ]
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:mediaconvert:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
          actions: [
            'mediaconvert:CreatePreset',
            'mediaconvert:CreateJobTemplate',
            'mediaconvert:DeletePreset',
            'mediaconvert:DeleteJobTemplate',
            'mediaconvert:DescribeEndpoints',
            'mediaconvert:ListJobTemplates',
            'mediaconvert:TagResource',
            'mediaconvert:UntagResource'
          ]
        }),
        new iam.PolicyStatement({
          resources: [
            `arn:${cdk.Aws.PARTITION}:mediapackage-vod:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:assets/*`,
            `arn:${cdk.Aws.PARTITION}:mediapackage-vod:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:packaging-configurations/packaging-config-*`
          ],
          actions: [
            'mediapackage-vod:DeleteAsset',
            'mediapackage-vod:DeletePackagingConfiguration'
          ]
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:mediapackage-vod:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:packaging-groups/${cdk.Aws.STACK_NAME}-packaging-group`],
          actions: [
            'mediapackage-vod:DescribePackagingGroup',
            'mediapackage-vod:DeletePackagingGroup'
          ]
        }),
        new iam.PolicyStatement({
          resources: ['*'],
          actions: [
            'mediapackage-vod:CreatePackagingConfiguration',
            'mediapackage-vod:CreatePackagingGroup',
            'mediapackage-vod:ListAssets',
            'mediapackage-vod:ListPackagingConfigurations',
            'mediapackage-vod:ListPackagingGroups',
            'mediapackage-vod:TagResource',
            'mediapackage-vod:UntagResource'
          ]
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${distribution.cloudFrontWebDistribution.distributionId}`],
          actions: [
            'cloudfront:GetDistributionConfig',
            'cloudfront:UpdateDistribution'
          ]
        })
      ]
    });
    customResourcePolicy.attachToRole(customResourceRole);

    //cfn_nag
    const cfnCustomResourceRole = customResourceRole.node.findChild('Resource') as iam.CfnRole;
    cfnCustomResourceRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is required to create CloudWatch logs and interact with MediaConvert / MediaPackage actions that do not support resource level permissions'
          }, {
            id: 'W76',
            reason: 'All policies are required by the custom resource.'
          }
        ]
      }
    };
    const cfnCustomResourcePolicy = customResourcePolicy.node.findChild('Resource') as iam.CfnPolicy;
    cfnCustomResourcePolicy.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W12',
            reason: '* is required to create CloudWatch logs and interact with MediaConvert / MediaPackage actions that do not support resource level permissions'
          }, {
            id: 'W76',
            reason: 'High complexity due to number of policy statements needed for creating all custom resources'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      customResourcePolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Resource ARNs are not generated at the time of policy creation'
        }
      ]
    );

    const customResourceLambda = new lambda.Function(this, 'CustomResource', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      description: 'Used to deploy resources not supported by CloudFormation',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`
      },
      functionName: `${cdk.Aws.STACK_NAME}-custom-resource`,
      role: customResourceRole,
      code: lambda.Code.fromAsset('../custom-resource'),
      timeout: cdk.Duration.seconds(30)
    });
    customResourceLambda.node.addDependency(customResourceRole);
    customResourceLambda.node.addDependency(customResourcePolicy);

    //cfn_nag
    const cfnCustomResourceLambda = customResourceLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnCustomResourceLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }, {
            id: 'W89',
            reason: 'This CustomResource does not need to be deployed inside a VPC'
          }, {
            id: 'W92',
            reason: 'This CustomResource does not need to define ReservedConcurrentExecutions to reserve simultaneous executions'
          }
        ]
      }
    };

    /**
     * Custom Resource: MediaConvert Endpoint
     */
    const mediaConvertEndpoint = new cdk.CustomResource(this, 'MediaConvertEndPoint', {
      serviceToken: customResourceLambda.functionArn,
      properties: {
        Resource: 'EndPoint'
      }
    });

    /**
     * Custom Resource: MediaConvert Templates
     */
    const mediaConvertTemplates = new cdk.CustomResource(this, 'MediaConvertTemplates', { // NOSONAR
      serviceToken: customResourceLambda.functionArn,
      properties: {
        Resource: 'MediaConvertTemplates',
        StackName: cdk.Aws.STACK_NAME,
        EndPoint: mediaConvertEndpoint.getAtt('EndpointUrl'),
        EnableMediaPackage: cdk.Fn.conditionIf(conditionEnableMediaPackage.logicalId, 'true', 'false'),
        EnableNewTemplates: true
      }
    });

    /**
     * Custom Resource: MediaPackage VOD
     */
    const mediaPackageVod = new cdk.CustomResource(this, 'MediaPackageVod', {
      serviceToken: customResourceLambda.functionArn,
      properties: {
        Resource: 'MediaPackageVod',
        StackName: cdk.Aws.STACK_NAME,
        GroupId: `${cdk.Aws.STACK_NAME}-packaging-group`,
        PackagingConfigurations: 'HLS,DASH,MSS,CMAF',
        DistributionId: distribution.cloudFrontWebDistribution.distributionId,
        EnableMediaPackage: cdk.Fn.conditionIf(conditionEnableMediaPackage.logicalId, 'true', 'false')
      }
    });

    /**
     * MediaConvert role
     */
    const mediaConvertRole = new iam.Role(this, 'MediaConvertRole', {
      assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com')
    });

    const mediaConvertPolicy = new iam.Policy(this, 'MediaConvertPolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-mediatranscode-policy`,
      statements: [
        new iam.PolicyStatement({
          resources: [
            `${source.bucketArn}/*`,
            `${destination.bucketArn}/*`
          ],
          actions: [
            's3:GetObject',
            's3:PutObject'
          ]
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:execute-api:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
          actions: ['execute-api:Invoke']
        })
      ]
    });
    mediaConvertPolicy.attachToRole(mediaConvertRole);

    //cfn_nag
    const cfnMediaConvertRole = mediaConvertRole.node.findChild('Resource') as iam.CfnRole;
    cfnMediaConvertRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '/* required to get/put objects to S3'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      mediaConvertPolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '/* required to get/put objects to S3'
        }
      ]
    );

    /**
     * MediaPackageVod role
     */
    const mediaPackageVodRole = new iam.Role(this, 'MediaPackageVodRole', {
      assumedBy: new iam.ServicePrincipal('mediapackage.amazonaws.com')
    });

    const mediaPackageVodPolicy = new iam.Policy(this, 'MediaPackageVodPolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-mediapackagevod-policy`,
      statements: [
        new iam.PolicyStatement({
          resources: [
            destination.bucketArn,
            `${destination.bucketArn}/*`
          ],
          actions: [
            's3:GetObject',
            's3:GetBucketLocation',
            's3:GetBucketRequestPayment'
          ]
        })
      ]
    });
    mediaPackageVodPolicy.attachToRole(mediaPackageVodRole);

    //cfn_nag
    const cfnMediaPackageVodRole = mediaPackageVodRole.node.findChild('Resource') as iam.CfnRole;
    cfnMediaPackageVodRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is required to get objects from S3'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      mediaPackageVodPolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '/* required to get/put objects to S3'
        }
      ]
    );


    /**
     * SNS Topic
     */
    const snsTopic = new sns.Topic(this, 'SnsTopic', {
      displayName: `${cdk.Aws.STACK_NAME}-Notifications`,
      masterKey: kms.Alias.fromAliasName(this, 'AwsManagedAwsKmsForAmazonSns', 'alias/aws/sns')
    });
    snsTopic.addSubscription(new subscriptions.EmailSubscription(adminEmail.valueAsString));
    const cfnSnsTopic = snsTopic.node.findChild('Resource') as sns.CfnTopic;
    cfnSnsTopic.kmsMasterKeyId = 'alias/aws/sns';

    /**
     * SQS Queue
     */
    const sqsDlq = new sqs.Queue(this, 'SqsQueueDlq', {
      queueName: `${cdk.Aws.STACK_NAME}-dlq`,
      visibilityTimeout: cdk.Duration.seconds(120),
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      dataKeyReuse: cdk.Duration.seconds(300),
      enforceSSL: true
    });

    const sqsQueue = new sqs.Queue(this, 'SqsQueue', {
      queueName: `${cdk.Aws.STACK_NAME}`,
      visibilityTimeout: cdk.Duration.seconds(120),
      deadLetterQueue: {
        queue: sqsDlq,
        maxReceiveCount: 1
      },
      encryption: sqs.QueueEncryption.KMS_MANAGED,
      dataKeyReuse: cdk.Duration.seconds(300),
      enforceSSL: true
    });

    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      sqsDlq,
      [
        {
          id: 'AwsSolutions-SQS3',
          reason: 'This resource is a DLQ'
        }
      ]
    );


    /**
     * DynamoDB Table
     */
    const dynamoDBTable = new dynamodb.Table(this, 'DynamoDBTable', {
      partitionKey: {
        name: 'guid',
        type: dynamodb.AttributeType.STRING
      },
      tableName: cdk.Aws.STACK_NAME,
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true
      }
    });
    dynamoDBTable.addGlobalSecondaryIndex({
      indexName: 'srcBucket-startTime-index',
      partitionKey: {
        name: 'srcBucket',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'startTime',
        type: dynamodb.AttributeType.STRING
      }
    });

    const cfnDynamoDB = dynamoDBTable.node.findChild('Resource') as dynamodb.CfnTable;
    cfnDynamoDB.cfnOptions.deletionPolicy = cdk.CfnDeletionPolicy.RETAIN;
    cfnDynamoDB.cfnOptions.updateReplacePolicy = cdk.CfnDeletionPolicy.RETAIN;

    //cfn_nag
    cfnDynamoDB.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W28',
            reason: 'Table name is set to the stack name'
          }, {
            id: 'W74',
            reason: 'The DynamoDB table is configured to use the default encryption'
          }
        ]
      }
    };

    /**
     * Error Handler role and lambda
     */
    const errorHandlerRole = new iam.Role(this, 'ErrorHandlerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });

    const errorHandlerPolicy = new iam.Policy(this, 'ErrorHandlerPolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-error-handler-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [snsTopic.topicArn],
          actions: ['sns:Publish'],
          conditions: {
            'Bool': {
              'aws:SecureTransport': 'true'
            }
          }
        }),
        new iam.PolicyStatement({
          resources: [dynamoDBTable.tableArn],
          actions: ['dynamodb:UpdateItem']
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        })
      ]
    });
    errorHandlerPolicy.attachToRole(errorHandlerRole);

    //cfn_nag
    const cfnErrorHandlerRole = errorHandlerRole.node.findChild('Resource') as iam.CfnRole;
    cfnErrorHandlerRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      errorHandlerPolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );

    const errorHandlerLambda = new lambda.Function(this, 'ErrorHandlerLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      functionName: `${cdk.Aws.STACK_NAME}-error-handler`,
      description: 'Captures and processes workflow errors',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        DynamoDBTable: dynamoDBTable.tableName,
        SnsTopic: snsTopic.topicArn
      },
      role: errorHandlerRole,
      code: lambda.Code.fromAsset('../error-handler'),
      timeout: cdk.Duration.seconds(120)
    });
    errorHandlerLambda.node.addDependency(errorHandlerRole);
    errorHandlerLambda.node.addDependency(errorHandlerPolicy);

    //cfn_nag
    const cfnErrorHandlerLambda = errorHandlerLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnErrorHandlerLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }, {
            id: 'W89',
            reason: 'This resource does not need to be deployed inside a VPC'
          }, {
            id: 'W92',
            reason: 'This resource does not need to define ReservedConcurrentExecutions to reserve simultaneous executions'
          }
        ]
      }
    };

    const encodeErrorRule = new events.Rule(this, 'EncodeErrorRule', {
      ruleName: `${cdk.Aws.STACK_NAME}-EncodeError`,
      description: 'MediaConvert Error event rule',
      eventPattern: {
        source: ['aws.mediaconvert'],
        detail: {
          status: ['ERROR'],
          userMetadata: {
            workflow: [cdk.Aws.STACK_NAME]
          }
        }
      },
      targets: [new targets.LambdaFunction(errorHandlerLambda)]
    });
    errorHandlerLambda.addPermission('CloudWatchLambdaInvokeErrors', {
      principal: new iam.ServicePrincipal('events.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: encodeErrorRule.ruleArn
    });


    /**
     * Input Validate role and lambda
     */
    const inputValidateRole = new iam.Role(this, 'InputValidateRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    const inputValidatePolicy = new iam.Policy(this, 'InputValidatePolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-input-validate-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [`${source.bucketArn}/*`],
          actions: ['s3:GetObject']
        }),
        new iam.PolicyStatement({
          resources: [errorHandlerLambda.functionArn],
          actions: ['lambda:InvokeFunction']
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        })
      ]
    });
    inputValidatePolicy.attachToRole(inputValidateRole);

    //cfn_nag
    const cfnInputValidateRole = inputValidateRole.node.findChild('Resource') as iam.CfnRole;
    cfnInputValidateRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      inputValidatePolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );

    const inputValidateLambda = new lambda.Function(this, 'InputValidateLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      functionName: `${cdk.Aws.STACK_NAME}-input-validate`,
      description: 'Validates the input given to the workflow',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        ErrorHandler: errorHandlerLambda.functionArn,
        WorkflowName: cdk.Aws.STACK_NAME,
        Source: source.bucketName,
        Destination: destination.bucketName,
        FrameCapture: `${cdk.Fn.conditionIf(conditionFrameCapture.logicalId, 'true', 'false')}`,
        ArchiveSource: glacier.valueAsString,
        MediaConvert_Template_2160p: `${cdk.Fn.conditionIf(
          conditionEnableMediaPackage.logicalId,
          `${cdk.Aws.STACK_NAME}_Ott_2160p_Avc_Aac_16x9_mvod_no_preset`,
          `${cdk.Aws.STACK_NAME}_Ott_2160p_Avc_Aac_16x9_qvbr_no_preset`
        )}`,
        MediaConvert_Template_1080p: `${cdk.Fn.conditionIf(
          conditionEnableMediaPackage.logicalId,
          `${cdk.Aws.STACK_NAME}_Ott_1080p_Avc_Aac_16x9_mvod_no_preset`,
          `${cdk.Aws.STACK_NAME}_Ott_1080p_Avc_Aac_16x9_qvbr_no_preset`
        )}`,
        MediaConvert_Template_720p: `${cdk.Fn.conditionIf(
          conditionEnableMediaPackage.logicalId,
          `${cdk.Aws.STACK_NAME}_Ott_720p_Avc_Aac_16x9_mvod_no_preset`,
          `${cdk.Aws.STACK_NAME}_Ott_720p_Avc_Aac_16x9_qvbr_no_preset`
        )}`,
        CloudFront: distribution.cloudFrontWebDistribution.domainName,
        EnableMediaPackage: `${cdk.Fn.conditionIf(conditionEnableMediaPackage.logicalId, 'true', 'false')}`,
        InputRotate: 'DEGREE_0',
        EnableSns: `${cdk.Fn.conditionIf(conditionEnableSns.logicalId, 'true', 'false')}`,
        EnableSqs: `${cdk.Fn.conditionIf(conditionEnableSqs.logicalId, 'true', 'false')}`,
        AcceleratedTranscoding: acceleratedTranscoding.valueAsString
      },
      role: inputValidateRole,
      code: lambda.Code.fromAsset('../input-validate'),
      timeout: cdk.Duration.seconds(120)
    });
    inputValidateLambda.node.addDependency(inputValidateRole);
    inputValidateLambda.node.addDependency(inputValidatePolicy);

    //cfn_nag
    const cfnInputValidateLambda = inputValidateLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnInputValidateLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W89',
            reason: 'Lambda functions do not need a VPC'
          }, {
            id: 'W92',
            reason: 'Lambda do not need ReservedConcurrentExecutions in this case'
          }, {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }
        ]
      }
    };

    /**
     * MediaInfo role and lambda
     */
    const mediaInfoRole = new iam.Role(this, 'MediaInfoRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    const mediaInfoPolicy = new iam.Policy(this, 'MediaInfoPolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-mediainfo-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [`${source.bucketArn}/*`],
          actions: ['s3:GetObject']
        }),
        new iam.PolicyStatement({
          resources: [errorHandlerLambda.functionArn],
          actions: ['lambda:InvokeFunction']
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        })
      ]
    });
    mediaInfoPolicy.attachToRole(mediaInfoRole);

    //cfn_nag
    const cfnMediaInfoRole = mediaInfoRole.node.findChild('Resource') as iam.CfnRole;
    cfnMediaInfoRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      mediaInfoPolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );

    const mediaInfoLambda = new lambda.Function(this, 'MediaInfoLambda', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'lambda_function.lambda_handler',
      functionName: `${cdk.Aws.STACK_NAME}-mediainfo`,
      description: 'Runs mediainfo on a pre-signed S3 URL',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`,
        ErrorHandler: errorHandlerLambda.functionArn
      },
      role: mediaInfoRole,
      code: lambda.Code.fromAsset('../mediainfo'),
      timeout: cdk.Duration.seconds(120)
    });
    mediaInfoLambda.node.addDependency(mediaInfoRole);
    mediaInfoLambda.node.addDependency(mediaInfoPolicy);

    //cfn_nag
    const cfnMediaInfoLambda = mediaInfoLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnMediaInfoLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W89',
            reason: 'Lambda functions do not need a VPC'
          }, {
            id: 'W92',
            reason: 'Lambda do not need ReservedConcurrentExecutions in this case'
          }, {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }
        ]
      }
    };

    /**
     * DynamoUpdate role and lambda
     */
    const dynamoUpdateRole = new iam.Role(this, 'DynamoUpdateRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    const dynamoUpdatePolicy = new iam.Policy(this, 'DynamoUpdatePolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-dynamo-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [dynamoDBTable.tableArn],
          actions: ['dynamodb:UpdateItem']
        }),
        new iam.PolicyStatement({
          resources: [errorHandlerLambda.functionArn],
          actions: ['lambda:InvokeFunction']
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        })
      ]
    });
    dynamoUpdatePolicy.attachToRole(dynamoUpdateRole);

    //cfn_nag
    const cfnDynamoUpdateRole = dynamoUpdateRole.node.findChild('Resource') as iam.CfnRole;
    cfnDynamoUpdateRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      dynamoUpdatePolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );

    const dynamoUpdateLambda = new lambda.Function(this, 'DynamoUpdateLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      functionName: `${cdk.Aws.STACK_NAME}-dynamo`,
      description: 'Updates DynamoDB with event data',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        ErrorHandler: errorHandlerLambda.functionArn,
        DynamoDBTable: dynamoDBTable.tableName
      },
      role: dynamoUpdateRole,
      code: lambda.Code.fromAsset('../dynamo'),
      timeout: cdk.Duration.seconds(120)
    });
    dynamoUpdateLambda.node.addDependency(dynamoUpdateRole);
    dynamoUpdateLambda.node.addDependency(dynamoUpdatePolicy);

    //cfn_nag
    const cfnDynamoUpdateLambda = dynamoUpdateLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnDynamoUpdateLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W89',
            reason: 'Lambda functions do not need a VPC'
          }, {
            id: 'W92',
            reason: 'Lambda do not need ReservedConcurrentExecutions in this case'
          }, {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }
        ]
      }
    };

    /**
     * Profiler role and lambda
     */
    const profilerRole = new iam.Role(this, 'ProfilerRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    const profilerPolicy = new iam.Policy(this, 'ProfilerPolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-profiler-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [dynamoDBTable.tableArn],
          actions: ['dynamodb:GetItem']
        }),
        new iam.PolicyStatement({
          resources: [errorHandlerLambda.functionArn],
          actions: ['lambda:InvokeFunction']
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        })
      ]
    });
    profilerPolicy.attachToRole(profilerRole);

    //cfn_nag
    const cfnProfilerRole = profilerRole.node.findChild('Resource') as iam.CfnRole;
    cfnProfilerRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      profilerPolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );

    const profilerLambda = new lambda.Function(this, 'ProfilerLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      functionName: `${cdk.Aws.STACK_NAME}-profiler`,
      description: 'Sets an EncodeProfile based on mediainfo output',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        ErrorHandler: errorHandlerLambda.functionArn,
        DynamoDBTable: dynamoDBTable.tableName
      },
      role: profilerRole,
      code: lambda.Code.fromAsset('../profiler'),
      timeout: cdk.Duration.seconds(120)
    });
    profilerLambda.node.addDependency(profilerRole);
    profilerLambda.node.addDependency(profilerPolicy);

    //cfn_nag
    const cfnProfilerLambda = profilerLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnProfilerLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W89',
            reason: 'Lambda functions do not need a VPC'
          }, {
            id: 'W92',
            reason: 'Lambda do not need ReservedConcurrentExecutions in this case'
          }, {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }
        ]
      }
    };

    /**
     * Encode role and lambda
     */
    const encodeRole = new iam.Role(this, 'EncodeRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    const encodePolicy = new iam.Policy(this, 'EncodePolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-encode-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:mediaconvert:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:*`],
          actions: [
            'mediaconvert:CreateJob',
            'mediaconvert:GetJobTemplate',
            'mediaconvert:TagResource',
            'mediaconvert:UntagResource'
          ]
        }),
        new iam.PolicyStatement({
          resources: [mediaConvertRole.roleArn],
          actions: ['iam:PassRole']
        }),
        new iam.PolicyStatement({
          resources: [errorHandlerLambda.functionArn],
          actions: ['lambda:InvokeFunction']
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        })
      ]
    });
    encodePolicy.attachToRole(encodeRole);

    //cfn_nag
    const cfnEncodeRole = encodeRole.node.findChild('Resource') as iam.CfnRole;
    cfnEncodeRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      encodePolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );

    const encodeLambda = new lambda.Function(this, 'EncodeLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      functionName: `${cdk.Aws.STACK_NAME}-encode`,
      description: 'Creates a MediaConvert encode job',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        ErrorHandler: errorHandlerLambda.functionArn,
        MediaConvertRole: mediaConvertRole.roleArn,
        EndPoint: mediaConvertEndpoint.getAttString('EndpointUrl')
      },
      role: encodeRole,
      code: lambda.Code.fromAsset('../encode'),
      timeout: cdk.Duration.seconds(120)
    });
    encodeLambda.node.addDependency(encodeRole);
    encodeLambda.node.addDependency(encodePolicy);

    //cfn_nag
    const cfnEncodeLambda = encodeLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnEncodeLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W89',
            reason: 'Lambda functions do not need a VPC'
          }, {
            id: 'W92',
            reason: 'Lambda do not need ReservedConcurrentExecutions in this case'
          }, {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }
        ]
      }
    };

    /**
     * OutputValidate role and lambda
     */
    const outputValidateRole = new iam.Role(this, 'OutputValidateRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    const outputValidatePolicy = new iam.Policy(this, 'OutputValidatePolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-output-validate-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [dynamoDBTable.tableArn],
          actions: ['dynamodb:GetItem']
        }),
        new iam.PolicyStatement({
          resources: [destination.bucketArn],
          actions: ['s3:ListBucket']
        }),
        new iam.PolicyStatement({
          resources: [errorHandlerLambda.functionArn],
          actions: ['lambda:InvokeFunction']
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        })
      ]
    });
    outputValidatePolicy.attachToRole(outputValidateRole);

    //cfn_nag
    const cfnOutputValidateRole = outputValidateRole.node.findChild('Resource') as iam.CfnRole;
    cfnOutputValidateRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      outputValidatePolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );

    const outputValidateLambda = new lambda.Function(this, 'OutputValidateLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      functionName: `${cdk.Aws.STACK_NAME}-output-validate`,
      description: 'Parses MediaConvert job output',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        ErrorHandler: errorHandlerLambda.functionArn,
        DynamoDBTable: dynamoDBTable.tableName,
        EndPoint: mediaConvertEndpoint.getAttString('EndpointUrl')
      },
      role: outputValidateRole,
      code: lambda.Code.fromAsset('../output-validate'),
      timeout: cdk.Duration.seconds(120)
    });
    outputValidateLambda.node.addDependency(outputValidateRole);
    outputValidateLambda.node.addDependency(outputValidatePolicy);

    //cfn_nag
    const cfnOutputValidateLambda = outputValidateLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnOutputValidateLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W89',
            reason: 'Lambda functions do not need a VPC'
          }, {
            id: 'W92',
            reason: 'Lambda do not need ReservedConcurrentExecutions in this case'
          }, {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }
        ]
      }
    };

    /**
     * ArchiveSource role and lambda
     */
    const archiveSourceRole = new iam.Role(this, 'ArchiveSourceRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    const archiveSourcePolicy = new iam.Policy(this, 'ArchiveSourcePolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-archive-source-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [`${source.bucketArn}/*`],
          actions: ['s3:PutObjectTagging']
        }),
        new iam.PolicyStatement({
          resources: [errorHandlerLambda.functionArn],
          actions: ['lambda:InvokeFunction']
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        })
      ]
    });
    archiveSourcePolicy.attachToRole(archiveSourceRole);

    //cfn_nag
    const cfnArchiveSourceRole = archiveSourceRole.node.findChild('Resource') as iam.CfnRole;
    cfnArchiveSourceRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      archiveSourcePolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );

    const archiveSourceLambda = new lambda.Function(this, 'ArchiveSourceLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      functionName: `${cdk.Aws.STACK_NAME}-archive-source`,
      description: 'Updates tags on source files to enable Glacier',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        ErrorHandler: errorHandlerLambda.functionArn
      },
      role: archiveSourceRole,
      code: lambda.Code.fromAsset('../archive-source'),
      timeout: cdk.Duration.seconds(120)
    });
    archiveSourceLambda.node.addDependency(archiveSourceRole);
    archiveSourceLambda.node.addDependency(archiveSourcePolicy);

    //cfn_nag
    const cfnArchiveSourceLambda = archiveSourceLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnArchiveSourceLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W89',
            reason: 'Lambda functions do not need a VPC'
          }, {
            id: 'W92',
            reason: 'Lambda do not need ReservedConcurrentExecutions in this case'
          }, {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }
        ]
      }
    };

    /**
     * SqsSendMessage role and lambda
     */
    const sqsSendMessageRole = new iam.Role(this, 'SqsSendMessageRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    const sqsSendMessagePolicy = new iam.Policy(this, 'SqsSendMessagePolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-sqs-publish-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [sqsQueue.queueArn],
          actions: ['sqs:SendMessage'],
          conditions: {
            'Bool': {
              'aws:SecureTransport': 'true'
            }
          }
        }),
        new iam.PolicyStatement({
          resources: [errorHandlerLambda.functionArn],
          actions: ['lambda:InvokeFunction']
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        })
      ]
    });
    sqsSendMessagePolicy.attachToRole(sqsSendMessageRole);

    //cfn_nag
    const cfnSqsSendMessageRole = sqsSendMessageRole.node.findChild('Resource') as iam.CfnRole;
    cfnSqsSendMessageRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      sqsSendMessagePolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );

    const sqsSendMessageLambda = new lambda.Function(this, 'SqsSendMessageLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      functionName: `${cdk.Aws.STACK_NAME}-sqs-publish`,
      description: 'Publish the workflow results to an SQS queue',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        ErrorHandler: errorHandlerLambda.functionArn,
        SqsQueue: sqsQueue.queueUrl
      },
      role: sqsSendMessageRole,
      code: lambda.Code.fromAsset('../sqs-publish'),
      timeout: cdk.Duration.seconds(120)
    });
    sqsSendMessageLambda.node.addDependency(sqsSendMessageRole);
    sqsSendMessageLambda.node.addDependency(sqsSendMessagePolicy);

    //cfn_nag
    const cfnSqsSendMessageLambda = sqsSendMessageLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnSqsSendMessageLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W89',
            reason: 'Lambda functions do not need a VPC'
          }, {
            id: 'W92',
            reason: 'Lambda do not need ReservedConcurrentExecutions in this case'
          }, {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }
        ]
      }
    };

    /**
     * SnsNotification role and lambda
     */
    const snsNotificationRole = new iam.Role(this, 'SnsNotificationRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    const snsNotificationPolicy = new iam.Policy(this, 'SnsNotificationPolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-sns-notification-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [snsTopic.topicArn],
          actions: ['sns:Publish'],
          conditions: {
            'Bool': {
              'aws:SecureTransport': 'true'
            }
          }
        }),
        new iam.PolicyStatement({
          resources: [errorHandlerLambda.functionArn],
          actions: ['lambda:InvokeFunction']
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        })
      ]
    });
    snsNotificationPolicy.attachToRole(snsNotificationRole);

    //cfn_nag
    const cfnSnsNotificationRole = snsNotificationRole.node.findChild('Resource') as iam.CfnRole;
    cfnSnsNotificationRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      snsNotificationPolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );

    const snsNotificationLambda = new lambda.Function(this, 'SnsNotificationLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      functionName: `${cdk.Aws.STACK_NAME}-sns-notification`,
      description: 'Sends a notification when the encode job is completed',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        ErrorHandler: errorHandlerLambda.functionArn,
        SnsTopic: snsTopic.topicArn
      },
      role: snsNotificationRole,
      code: lambda.Code.fromAsset('../sns-notification'),
      timeout: cdk.Duration.seconds(120)
    });
    snsNotificationLambda.node.addDependency(snsNotificationRole);
    snsNotificationLambda.node.addDependency(snsNotificationPolicy);

    //cfn_nag
    const cfnSnsNotificationLambda = snsNotificationLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnSnsNotificationLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W89',
            reason: 'Lambda functions do not need a VPC'
          }, {
            id: 'W92',
            reason: 'Lambda do not need ReservedConcurrentExecutions in this case'
          }, {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }
        ]
      }
    };

    /**
     * MediaPackageAssets role and lambda
     */
    const mediaPackageAssetsRole = new iam.Role(this, 'MediaPackageAssetsRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });
    const mediaPackageAssetsPolicy = new iam.Policy(this, 'MediaPackageAssetsPolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-media-package-assets-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [mediaPackageVodRole.roleArn],
          actions: ['iam:PassRole']
        }),
        new iam.PolicyStatement({
          resources: ['*'],
          actions: [
            'mediapackage-vod:CreateAsset',
            'mediapackage-vod:TagResource',
            'mediapackage-vod:UntagResource'
          ]
        }),
        new iam.PolicyStatement({
          resources: [errorHandlerLambda.functionArn],
          actions: ['lambda:InvokeFunction']
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        })
      ]
    });
    mediaPackageAssetsPolicy.attachToRole(mediaPackageAssetsRole);

    //cfn_nag
    const cfnMediaPackageAssetsRole = mediaPackageAssetsRole.node.findChild('Resource') as iam.CfnRole;
    cfnMediaPackageAssetsRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    const cfnMediaPackageAssetsPolicy = mediaPackageAssetsPolicy.node.findChild('Resource') as iam.CfnPolicy;
    cfnMediaPackageAssetsPolicy.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W12',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      mediaPackageAssetsPolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );

    const mediaPackageAssetsLambda = new lambda.Function(this, 'MediaPackageAssetsLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      functionName: `${cdk.Aws.STACK_NAME}-media-package-assets`,
      description: 'Ingests an asset into MediaPackage-VOD',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        ErrorHandler: errorHandlerLambda.functionArn,
        GroupId: mediaPackageVod.getAttString('GroupId'),
        GroupDomainName: mediaPackageVod.getAttString('GroupDomainName'),
        MediaPackageVodRole: mediaPackageVodRole.roleArn
      },
      role: mediaPackageAssetsRole,
      code: lambda.Code.fromAsset('../media-package-assets'),
      timeout: cdk.Duration.seconds(120)
    });
    mediaPackageAssetsLambda.node.addDependency(mediaPackageAssetsRole);
    mediaPackageAssetsLambda.node.addDependency(mediaPackageAssetsPolicy);

    //cfn_nag
    const cfnMediaPackageAssetsLambda = mediaPackageAssetsLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnMediaPackageAssetsLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W89',
            reason: 'Lambda functions do not need a VPC'
          }, {
            id: 'W92',
            reason: 'Lambda do not need ReservedConcurrentExecutions in this case'
          }, {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }
        ]
      }
    };

    /**
     * Step Functions role and lambda
     */
    const stepFunctionsRole = new iam.Role(this, 'StepFunctionsRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com')
    });

    const stepFunctionsPolicy = new iam.Policy(this, 'StepFunctionsPolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-step-functions-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [
            `arn:${cdk.Aws.PARTITION}:states:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stateMachine:${cdk.Aws.STACK_NAME}-ingest`,
            `arn:${cdk.Aws.PARTITION}:states:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stateMachine:${cdk.Aws.STACK_NAME}-process`,
            `arn:${cdk.Aws.PARTITION}:states:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stateMachine:${cdk.Aws.STACK_NAME}-publish`
          ],
          actions: ['states:StartExecution']
        }),
        new iam.PolicyStatement({
          resources: [errorHandlerLambda.functionArn],
          actions: ['lambda:InvokeFunction']
        }),
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:logs:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:log-group:/aws/lambda/*`],
          actions: [
            'logs:CreateLogGroup',
            'logs:CreateLogStream',
            'logs:PutLogEvents'
          ]
        })
      ]
    });
    stepFunctionsPolicy.attachToRole(stepFunctionsRole);

    //cfn_nag
    const cfnStepFunctionsRole = stepFunctionsRole.node.findChild('Resource') as iam.CfnRole;
    cfnStepFunctionsRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: '* is used so that the Lambda function can create log groups'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      stepFunctionsPolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );

    const stepFunctionsLambda = new lambda.Function(this, 'StepFunctionsLambda', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      functionName: `${cdk.Aws.STACK_NAME}-step-functions`,
      description: 'Creates a unique identifer (GUID) and executes the Ingest StateMachine',
      environment: {
        SOLUTION_IDENTIFIER: `AwsSolution/${solutionId}/%%VERSION%%`,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
        IngestWorkflow: `arn:${cdk.Aws.PARTITION}:states:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stateMachine:${cdk.Aws.STACK_NAME}-ingest`,
        ProcessWorkflow: `arn:${cdk.Aws.PARTITION}:states:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stateMachine:${cdk.Aws.STACK_NAME}-process`,
        PublishWorkflow: `arn:${cdk.Aws.PARTITION}:states:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:stateMachine:${cdk.Aws.STACK_NAME}-publish`,
        ErrorHandler: errorHandlerLambda.functionArn
      },
      role: stepFunctionsRole,
      code: lambda.Code.fromAsset('../step-functions'),
      timeout: cdk.Duration.seconds(120)
    });
    stepFunctionsLambda.node.addDependency(stepFunctionsRole);
    stepFunctionsLambda.node.addDependency(stepFunctionsPolicy);

    //cfn_nag
    const cfnStepFunctionsLambda = stepFunctionsLambda.node.findChild('Resource') as lambda.CfnFunction;
    cfnStepFunctionsLambda.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W58',
            reason: 'Invalid warning: function has access to cloudwatch'
          }, {
            id: 'W89',
            reason: 'This resource does not need to be deployed inside a VPC'
          }, {
            id: 'W92',
            reason: 'This resource does not need to define ReservedConcurrentExecutions to reserve simultaneous executions'
          }
        ]
      }
    };

    // temporary cdk nag rule suppression
    // remove the suppressions when working on https://app.asana.com/0/1202684577925745/1204347805387549/f
    [
      cfnCustomResourceLambda,
      cfnErrorHandlerLambda,
      cfnInputValidateLambda,
      cfnMediaInfoLambda,
      cfnDynamoUpdateLambda,
      cfnProfilerLambda,
      cfnEncodeLambda,
      cfnOutputValidateLambda,
      cfnArchiveSourceLambda,
      cfnSqsSendMessageLambda,
      cfnSnsNotificationLambda,
      cfnMediaPackageAssetsLambda,
      cfnStepFunctionsLambda,
    ].forEach(lambdaFunction => {
      NagSuppressions.addResourceSuppressions(
        lambdaFunction,
        [
          {
            id: 'AwsSolutions-L1',
            reason: 'Lambda NodeJS 22 Runtime in development...',
          }
        ]
      );
    });

    const encodeCompleteRule = new events.Rule(this, 'EncodeCompleteRule', {
      ruleName: `${cdk.Aws.STACK_NAME}-EncodeComplete`,
      description: 'MediaConvert Completed event rule',
      eventPattern: {
        source: ['aws.mediaconvert'],
        detail: {
          status: ['COMPLETE'],
          userMetadata: {
            workflow: [cdk.Aws.STACK_NAME]
          }
        }
      },
      targets: [new targets.LambdaFunction(stepFunctionsLambda)]
    });
    stepFunctionsLambda.addPermission('S3LambdaInvokeVideo', {
      principal: new iam.ServicePrincipal('s3.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceAccount: cdk.Aws.ACCOUNT_ID
    });
    stepFunctionsLambda.addPermission('CloudWatchLambdaInvokeCompletes', {
      principal: new iam.ServicePrincipal('events.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: encodeCompleteRule.ruleArn
    });

    /**
     * Custom Resource: S3Config
     */
    const s3Config = new cdk.CustomResource(this, 'S3Config', {
      serviceToken: customResourceLambda.functionArn,
      properties: {
        Resource: 'S3Notification',
        Source: source.bucketName,
        IngestArn: stepFunctionsLambda.functionArn,
        WorkflowTrigger: workflowTrigger.valueAsString
      }
    });
    s3Config.node.addDependency(stepFunctionsLambda);

    /**
     * StepFunctionsService role
     */
    const stepFunctionsServiceRole = new iam.Role(this, 'StepFunctionsServiceRole', {
      assumedBy: new iam.ServicePrincipal(`states.${cdk.Aws.REGION}.amazonaws.com`)
    });
    const stepFunctionsServicePolicy = new iam.Policy(this, 'StepFunctionsServicePolicy', {
      policyName: `${cdk.Aws.STACK_NAME}-stepfunctions-service-role`,
      statements: [
        new iam.PolicyStatement({
          resources: [`arn:${cdk.Aws.PARTITION}:lambda:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:function:*`],
          actions: ['lambda:InvokeFunction']
        })
      ]
    });
    stepFunctionsServicePolicy.attachToRole(stepFunctionsServiceRole);

    //cfn_nag
    const cfnStepFunctionsServiceRole = stepFunctionsServiceRole.node.findChild('Resource') as iam.CfnRole;
    cfnStepFunctionsServiceRole.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W11',
            reason: 'The * resource is required since the functions need to be created before the state machine'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      stepFunctionsServicePolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: '* is used so that the Lambda function can create log groups'
        }
      ]
    );


    /**
     * StepFunction States
     */
    const inputValidateTask = new tasks.LambdaInvoke(this, 'Input Validate', {
      lambdaFunction: inputValidateLambda,
      payloadResponseOnly: true
    });
    const mediaInfoTask = new tasks.LambdaInvoke(this, 'MediaInfo', {
      lambdaFunction: mediaInfoLambda,
      payloadResponseOnly: true
    });
    const dynamodbUpdateTaskIngest = new tasks.LambdaInvoke(this, 'DynamoDB Update (Ingest)', {
      lambdaFunction: dynamoUpdateLambda,
      payloadResponseOnly: true
    });
    const dynamodbUpdateTaskProcess = new tasks.LambdaInvoke(this, 'DynamoDB Update (Process)', {
      lambdaFunction: dynamoUpdateLambda,
      payloadResponseOnly: true
    });
    const dynamodbUpdateTaskPublish = new tasks.LambdaInvoke(this, 'DynamoDB Update (Publish)', {
      lambdaFunction: dynamoUpdateLambda,
      payloadResponseOnly: true
    });
    const snsNotificationTaskIngest = new tasks.LambdaInvoke(this, 'SNS Notification (Ingest)', {
      lambdaFunction: snsNotificationLambda,
      payloadResponseOnly: true
    });
    const snsNotificationTaskPublish = new tasks.LambdaInvoke(this, 'SNS Notification (Publish)', {
      lambdaFunction: snsNotificationLambda,
      payloadResponseOnly: true
    });
    const processExecuteTask = new tasks.LambdaInvoke(this, 'Process Execute', {
      lambdaFunction: stepFunctionsLambda,
      payloadResponseOnly: true
    });
    const profilerTask = new tasks.LambdaInvoke(this, 'Profiler', {
      lambdaFunction: profilerLambda,
      payloadResponseOnly: true
    });
    const encodeTask = new tasks.LambdaInvoke(this, 'Encode Job Submit', {
      lambdaFunction: encodeLambda,
      payloadResponseOnly: true
    });
    const outputValidateTask = new tasks.LambdaInvoke(this, 'Validate Encoding Outputs', {
      lambdaFunction: outputValidateLambda,
      payloadResponseOnly: true
    });
    const archiveTask = new tasks.LambdaInvoke(this, 'Archive', {
      lambdaFunction: archiveSourceLambda,
      payloadResponseOnly: true
    });
    const deepArchiveTask = new tasks.LambdaInvoke(this, 'Deep Archive', {
      lambdaFunction: archiveSourceLambda,
      payloadResponseOnly: true
    });
    const mediaPackageAssetsTask = new tasks.LambdaInvoke(this, 'MediaPackage Assets', {
      lambdaFunction: mediaPackageAssetsLambda,
      payloadResponseOnly: true
    });
    const sqsSendMessageTask = new tasks.LambdaInvoke(this, 'SQS Send Message', {
      lambdaFunction: sqsSendMessageLambda,
      payloadResponseOnly: true
    });
    const completeState = new sfn.Pass(this, 'Complete');

    /**
     * IngestWorkflow state machine
     * 1: Input Validate
     * 2: MediaInfo
     * 3: DynamoDB Update
     * 4: SNS Choice
     *    5: SNS Notification
     * 6: Process Execute
     */
    snsNotificationTaskIngest.next(processExecuteTask);
    const ingestWorkflowDefinition = inputValidateTask
      .next(mediaInfoTask)
      .next(dynamodbUpdateTaskIngest)
      .next(new sfn.Choice(this, 'SNS Choice (Ingest)')
        .when(sfn.Condition.booleanEquals('$.enableSns', true), snsNotificationTaskIngest)
        .otherwise(processExecuteTask));

    const ingestWorkflow = new sfn.StateMachine(this, 'IngestWorkflow', {
      stateMachineName: `${cdk.Aws.STACK_NAME}-ingest`,
      role: stepFunctionsServiceRole,
      definitionBody: sfn.DefinitionBody.fromChainable(ingestWorkflowDefinition)
    });

    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      ingestWorkflow,
      [
        {
          id: 'AwsSolutions-SF1',
          reason: 'Logging handled by DynamoDB Update step and Error Handler lambda'
        }, {
          id: 'AwsSolutions-SF2',
          reason: 'Optional configuration for this solution'
        }
      ]
    );

    /**
     * ProcessWorkflow state machine
     * 1: Profiler
     * 2: Encoding Profile Check
     *    3: Custom jobTemplate OR
     *       jobTemplate 2160p OR
     *       jobTemplate 1080p OR
     *       jobTemplate 720p
     * 4: Accelerated Transcoding Check
     *    5: Enabled OR
     *       Preferred OR
     *       Disabled
     * 6: Frame Capture Check
     *    7: Frame Capture OR
     *       No Frame Capture
     * 8: Encode Job Submit
     * 9: DynamoDB Update
     */
    const processWorkflowDefinition = profilerTask
      .next(new sfn.Choice(this, 'Encoding Profile Check')
        .when(sfn.Condition.booleanEquals('$.isCustomTemplate', true), new sfn.Pass(this, 'Custom jobTemplate'))
        .when(sfn.Condition.numberEquals('$.encodingProfile', 2160), new sfn.Pass(this, 'jobTemplate 2160p'))
        .when(sfn.Condition.numberEquals('$.encodingProfile', 1080), new sfn.Pass(this, 'jobTemplate 1080p'))
        .when(sfn.Condition.numberEquals('$.encodingProfile', 720), new sfn.Pass(this, 'jobTemplate 720p'))
        .afterwards())
      .next(new sfn.Choice(this, 'Accelerated Transcoding Check')
        .when(sfn.Condition.stringEquals('$.acceleratedTranscoding', 'ENABLED'), new sfn.Pass(this, 'Enabled'))
        .when(sfn.Condition.stringEquals('$.acceleratedTranscoding', 'PREFERRED'), new sfn.Pass(this, 'Preferred'))
        .when(sfn.Condition.stringEquals('$.acceleratedTranscoding', 'DISABLED'), new sfn.Pass(this, 'Disabled'))
        .afterwards())
      .next(new sfn.Choice(this, 'Frame Capture Check')
        .when(sfn.Condition.booleanEquals('$.frameCapture', true), new sfn.Pass(this, 'Frame Capture'))
        .when(sfn.Condition.booleanEquals('$.frameCapture', false), new sfn.Pass(this, 'No Frame Capture'))
        .afterwards())
      .next(encodeTask)
      .next(dynamodbUpdateTaskProcess);

    const processWorkflow = new sfn.StateMachine(this, 'ProcessWorkflow', {
      stateMachineName: `${cdk.Aws.STACK_NAME}-process`,
      role: stepFunctionsServiceRole,
      definitionBody: sfn.DefinitionBody.fromChainable(processWorkflowDefinition)
    });

    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      processWorkflow,
      [
        {
          id: 'AwsSolutions-SF1',
          reason: 'Logging handled by DynamoDB Update step and Error Handler lambda'
        }, {
          id: 'AwsSolutions-SF2',
          reason: 'Optional configuration for this solution'
        }
      ]
    );

    /**
     * PublishWorkflow state machine
     * 1: Validate Encoding Outputs
     * 2: Archive Source Choice
     *    3: Archive OR
     *       Deep Archive
     * 4: MediaPackage Choice
     *    5: MediaPackage Assets
     * 6: DynamoDB Update
     * 7: SQS Choice
     *    8: SQS Send Message
     * 9: SNS Choice
     *    10: SNS Notification
     * 11: Complete
     */
    snsNotificationTaskPublish.next(completeState);
    const snsChoicePublish = new sfn.Choice(this, 'SNS Choice (Publish)');
    snsChoicePublish
      .when(sfn.Condition.booleanEquals('$.enableSns', true), snsNotificationTaskPublish)
      .otherwise(completeState);

    sqsSendMessageTask.next(snsChoicePublish);
    const sqsChoice = new sfn.Choice(this, 'SQS Choice');
    sqsChoice
      .when(sfn.Condition.booleanEquals('$.enableSqs', true), sqsSendMessageTask)
      .otherwise(snsChoicePublish);

    const dynamoChain = sfn.Chain
      .start(dynamodbUpdateTaskPublish)
      .next(sqsChoice);

    mediaPackageAssetsTask.next(dynamoChain);
    const mediaPackageChoice = new sfn.Choice(this, 'MediaPackage Choice');
    mediaPackageChoice
      .when(sfn.Condition.booleanEquals('$.enableMediaPackage', true), mediaPackageAssetsTask)
      .otherwise(dynamoChain);

    archiveTask.next(mediaPackageChoice);
    deepArchiveTask.next(mediaPackageChoice);
    const archiveSourceChoice = new sfn.Choice(this, 'Archive Source Choice')
      .when(sfn.Condition.stringEquals('$.archiveSource', 'GLACIER'), archiveTask)
      .when(sfn.Condition.stringEquals('$.archiveSource', 'DEEP_ARCHIVE'), deepArchiveTask)
      .otherwise(mediaPackageChoice);

    const publishWorkflowDefinition = outputValidateTask
      .next(archiveSourceChoice);

    const publishWorkflow = new sfn.StateMachine(this, 'PublishWorkflow', {
      stateMachineName: `${cdk.Aws.STACK_NAME}-publish`,
      role: stepFunctionsServiceRole,
      definitionBody: sfn.DefinitionBody.fromChainable(publishWorkflowDefinition)
    });

    //cfn_nag
    const stateMachineDefaultPolicy = stepFunctionsServiceRole.node.findChild('DefaultPolicy') as iam.Policy;
    const cfnDefaultPolicy = stateMachineDefaultPolicy.node.defaultChild as cdk.CfnResource;
    cfnDefaultPolicy.cfnOptions.metadata = {
      cfn_nag: {
        rules_to_suppress: [
          {
            id: 'W76',
            reason: 'testestesteslsdkfjsdlkfjlskdfklsdljf'
          }
        ]
      }
    };
    //cdk_nag
    NagSuppressions.addResourceSuppressions(
      publishWorkflow,
      [
        {
          id: 'AwsSolutions-SF1',
          reason: 'Logging handled by DynamoDB Update step and Error Handler lambda'
        }, {
          id: 'AwsSolutions-SF2',
          reason: 'Optional configuration for this solution'
        }
      ]
    );
    NagSuppressions.addResourceSuppressions(
      cfnDefaultPolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Statements added to default policy by aws-stepfunctions.StateMachine class'
        }
      ]
    );


    /**
     * Custom Resource: UUID
     */
    const uuid = new cdk.CustomResource(this, 'UUID', {
      serviceToken: customResourceLambda.functionArn,
      properties: {
        Resource: 'UUID'
      }
    });

    /**
     * Custom Resource: Anonymized Metric
     */
    new cdk.CustomResource(this, 'AnonymizedMetric', { // NOSONAR
      serviceToken: customResourceLambda.functionArn,
      properties: {
        Resource: 'AnonymizedMetric',
        SolutionId: solutionId,
        UUID: uuid.getAttString('UUID'),
        Version: '%%VERSION%%',
        Transcoder: 'MediaConvert',
        WorkflowTrigger: workflowTrigger.valueAsString,
        Glacier: glacier.valueAsString,
        FrameCapture: frameCapture.valueAsString,
        EnableMediaPackage: enableMediaPackage.valueAsString,
        SendAnonymizedMetric: cdk.Fn.findInMap('AnonymizedData', 'SendAnonymizedData', 'Data')
      }
    });


    /**
     * Outputs
     */
    new cdk.CfnOutput(this, 'DynamoDBTableName', { // NOSONAR
      value: dynamoDBTable.tableName,
      description: 'DynamoDB Table',
      exportName: `${cdk.Aws.STACK_NAME}:DynamoDBTable`
    });
    new cdk.CfnOutput(this, 'SourceBucketName', { // NOSONAR
      value: source.bucketName,
      description: 'Source Bucket',
      exportName: `${cdk.Aws.STACK_NAME}:Source`
    });
    new cdk.CfnOutput(this, 'DestinationBucketName', { // NOSONAR
      value: destination.bucketName,
      description: 'Destination Bucket',
      exportName: `${cdk.Aws.STACK_NAME}:Destination`
    });
    new cdk.CfnOutput(this, 'CloudFrontDomainName', { // NOSONAR
      value: distribution.cloudFrontWebDistribution.domainName,
      description: 'CloudFront Domain Name',
      exportName: `${cdk.Aws.STACK_NAME}:CloudFront`
    });
    new cdk.CfnOutput(this, 'AnonymizedMetricUUID', { // NOSONAR
      value: uuid.getAttString('UUID'),
      description: 'AnonymizedMetric UUID',
      exportName: `${cdk.Aws.STACK_NAME}:UUID`
    });
    new cdk.CfnOutput(this, 'SnsTopicName', { // NOSONAR
      value: snsTopic.topicName,
      description: 'SNS Topic',
      exportName: `${cdk.Aws.STACK_NAME}:SnsTopic`
    });
    new cdk.CfnOutput(this, 'SqsUrl', { // NOSONAR
      value: sqsQueue.queueUrl,
      description: 'SQS Queue URL',
      exportName: `${cdk.Aws.STACK_NAME}:SqsQueue`
    });
    new cdk.CfnOutput(this, 'SqsArn', { // NOSONAR
      value: sqsQueue.queueArn,
      description: 'SQS Queue ARN',
      exportName: `${cdk.Aws.STACK_NAME}:SqsQueueArn`
    });

    /**
     * Tag all resources with Solution Id
     */
    cdk.Tags.of(this).add('SolutionId', solutionId);

  }
}
