/*********************************************************************************************************************
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *********************************************************************************************************************/

const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');

const FORWARDED_STATUSES = new Set(['Ingest', 'Complete', 'Error']);

function signPayload(rawBody, secret) {
    return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function postWebhook(urlString, rawBody, secret) {
    const target = new URL(urlString);

    return new Promise((resolve, reject) => {
        const request = https.request(
            {
                hostname: target.hostname,
                port: target.port || 443,
                path: `${target.pathname}${target.search}`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(rawBody),
                    'x-webhook-signature': signPayload(rawBody, secret)
                }
            },
            (response) => {
                const chunks = [];
                response.on('data', (chunk) => chunks.push(chunk));
                response.on('end', () => {
                    const body = Buffer.concat(chunks).toString('utf8');
                    if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
                        resolve({ statusCode: response.statusCode, body });
                        return;
                    }
                    reject(
                        new Error(
                            `Strapi webhook failed with status ${response.statusCode}: ${body}`
                        )
                    );
                });
            }
        );

        request.on('error', reject);
        request.write(rawBody);
        request.end();
    });
}

function parseWorkflowMessage(message) {
    const payload = JSON.parse(message);
    if (!payload || typeof payload !== 'object') {
        return null;
    }

    const workflowStatus = payload.workflowStatus || payload.status;
    if (!FORWARDED_STATUSES.has(workflowStatus)) {
        return null;
    }

    if (typeof payload.guid !== 'string' || payload.guid.trim() === '') {
        return null;
    }

    return {
        workflowStatus,
        guid: payload.guid.trim(),
        hlsUrl: payload.hlsUrl,
        srcVideo: payload.srcVideo,
        errorMessage: payload.errorMessage
    };
}

async function forwardMessage(message) {
    const webhookUrl = process.env.StrapiWebhookUrl;
    const webhookSecret = process.env.StrapiWebhookSecret;

    if (!webhookUrl || !webhookSecret) {
        console.log('Strapi webhook not configured, skipping forward');
        return;
    }

    const payload = parseWorkflowMessage(message);
    if (!payload) {
        console.log('Skipping unsupported workflow message');
        return;
    }

    const rawBody = JSON.stringify(payload);
    console.log(`Forwarding ${payload.workflowStatus} for ${payload.guid} to Strapi`);
    await postWebhook(webhookUrl, rawBody, webhookSecret);
}

exports.handler = async (event) => {
    console.log(`REQUEST:: ${JSON.stringify(event, null, 2)}`);

    if (event.Records) {
        for (const record of event.Records) {
            if (record.Sns && record.Sns.Message) {
                await forwardMessage(record.Sns.Message);
            } else if (record.body) {
                await forwardMessage(record.body);
            }
        }
    }

    return event;
};

exports._private = {
    parseWorkflowMessage,
    signPayload
};
