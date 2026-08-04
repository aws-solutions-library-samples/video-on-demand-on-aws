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

const expect = require('chai').expect;
const path = require('path');
const { mockClient } = require('aws-sdk-client-mock');
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const lambda = require('../index.js');

describe('#STEP FUNCTIONS::', () => {
    process.env.IngestWorkflow = 'INGEST';
    process.env.ProcessWorkflow = 'PROCESS';
    process.env.PublishWorkflow = 'PUBLISH';
    process.env.ErrorHandler = 'error_handler';

    const _ingest = {
        Records: [{
            s3: {
                object: {
                    key: '11111111-2222-3333-4444-555555555555/training.mp4',
                }
            }
        }]
    };

    const _ingestWithoutUuid = {
        Records: [{
            s3: {
                object: {
                    key: 'big_bunny.mp4',
                }
            }
        }]
    };

    const _process = {
        guid: '1234'
    };

    const _publish = {
        detail: {
            userMetadata: {
                guid: '1234'
            }
        }
    };

    const _error = {};

    const data = {
        executionArn: 'arn'
    };

    const lambdaClientMock = mockClient(LambdaClient);
    const sFNClientMock = mockClient(SFNClient);

    afterEach(() => sFNClientMock.reset());

    it('should return "success" on Ingest Execute success', async () => {
        sFNClientMock.on(StartExecutionCommand).resolves(data);

        const response = await lambda.handler(_ingest);
        expect(response).to.equal('success');
        const executionInput = sFNClientMock.commandCalls(StartExecutionCommand)[0].args[0].input;
        expect(JSON.parse(executionInput.input).guid).to.equal('11111111-2222-3333-4444-555555555555');
        expect(executionInput.name).to.equal('11111111-2222-3333-4444-555555555555');
    });

    it('should generate a guid when the ingest key does not embed a session uuid', async () => {
        sFNClientMock.on(StartExecutionCommand).resolves(data);

        const response = await lambda.handler(_ingestWithoutUuid);
        expect(response).to.equal('success');
        const executionInput = sFNClientMock.commandCalls(StartExecutionCommand)[0].args[0].input;
        expect(JSON.parse(executionInput.input).guid).to.match(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
        );
    });

    it('should return "success" on process Execute success', async () => {
        sFNClientMock.on(StartExecutionCommand).resolves(data);

        const response = await lambda.handler(_process);
        expect(response).to.equal('success');
    });

    it('should return "success" on publish Execute success', async () => {
        sFNClientMock.on(StartExecutionCommand).resolves(data);

        const response = await lambda.handler(_publish);
        expect(response).to.equal('success');
    });

    it('should return "ERROR" with an invalid event object', async () => {
        sFNClientMock.on(StartExecutionCommand).resolves(data);
        lambdaClientMock.on(InvokeCommand).resolves();

        await lambda.handler(_error).catch(err => {
            expect(err.toString()).to.equal('Error: invalid event object');
        });
    });

    it('should return "STEP ERROR" when step execution fails', async () => {
        sFNClientMock.on(StartExecutionCommand).rejects('STEP ERROR');
        lambdaClientMock.on(InvokeCommand).resolves();

        await lambda.handler(_ingest).catch(err => {
            expect(err.toString()).to.equal('Error: STEP ERROR');
        });
    });
});
