/*********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *********************************************************************************************************************/

const expect = require('chai').expect;
const lambda = require('../index.js');

describe('#STRAPI WEBHOOK::', () => {
    it('should parse ingest workflow messages', () => {
        const payload = lambda._private.parseWorkflowMessage(
            JSON.stringify({
                workflowStatus: 'Ingest',
                guid: '11111111-2222-3333-4444-555555555555',
                srcVideo: '11111111-2222-3333-4444-555555555555/training.mp4'
            })
        );

        expect(payload).to.deep.equal({
            workflowStatus: 'Ingest',
            guid: '11111111-2222-3333-4444-555555555555',
            hlsUrl: undefined,
            srcVideo: '11111111-2222-3333-4444-555555555555/training.mp4',
            errorMessage: undefined
        });
    });

    it('should parse complete workflow messages', () => {
        const payload = lambda._private.parseWorkflowMessage(
            JSON.stringify({
                workflowStatus: 'Complete',
                guid: '11111111-2222-3333-4444-555555555555',
                hlsUrl: 'https://cloudfront.example/playlist.m3u8'
            })
        );

        expect(payload.workflowStatus).to.equal('Complete');
        expect(payload.hlsUrl).to.equal('https://cloudfront.example/playlist.m3u8');
    });

    it('should ignore unsupported workflow messages', () => {
        const payload = lambda._private.parseWorkflowMessage(
            JSON.stringify({
                workflowStatus: 'Processing',
                guid: '11111111-2222-3333-4444-555555555555'
            })
        );

        expect(payload).to.equal(null);
    });
});
