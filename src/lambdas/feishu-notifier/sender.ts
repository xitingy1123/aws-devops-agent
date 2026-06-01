import { FeishuMessage } from '../../shared/types';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import * as crypto from 'crypto';

// -----------------------------------------------------------------------------
// Interfaces
// -----------------------------------------------------------------------------

export interface SenderOptions {
  maxRetries?: number;      // default 3
  retryIntervalMs?: number; // default 5000
}

export interface SendResult {
  success: boolean;
  webhookUrl: string;
  retryCount: number;
  error?: string;
}

export interface BatchSendResult {
  sentTo: string[];
  failedTo: string[];
  totalRetryCount: number;
}

export interface FailedNotification {
  webhookUrl: string;
  message: FeishuMessage;
  error: string;
}

// -----------------------------------------------------------------------------
// Defaults
// -----------------------------------------------------------------------------

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_INTERVAL_MS = 5000;

// -----------------------------------------------------------------------------
// DynamoDB Client (lazy initialization)
// -----------------------------------------------------------------------------

let ddbDocClient: DynamoDBDocumentClient | undefined;

function getDynamoDBClient(): DynamoDBDocumentClient {
  if (!ddbDocClient) {
    const client = new DynamoDBClient({});
    ddbDocClient = DynamoDBDocumentClient.from(client);
  }
  return ddbDocClient;
}

/**
 * Allow tests to inject a mock DynamoDB client.
 */
export function setDynamoDBClient(client: DynamoDBDocumentClient): void {
  ddbDocClient = client;
}

// -----------------------------------------------------------------------------
// Sleep utility
// -----------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// -----------------------------------------------------------------------------
// HTTP POST to Feishu Webhook
// -----------------------------------------------------------------------------

/**
 * Makes an HTTP POST request to the given webhook URL with the message as JSON body.
 * Uses native http/https modules following the same pattern as agent-client.ts.
 */
function postToWebhook(webhookUrl: string, message: FeishuMessage): Promise<void> {
  const url = new URL(webhookUrl);
  const body = JSON.stringify(message);

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise<void>((resolve, reject) => {
    const httpModule = url.protocol === 'https:' ? require('https') : require('http');

    const req = httpModule.request(options, (res: any) => {
      let data = '';
      res.on('data', (chunk: string) => {
        data += chunk;
      });
      res.on('end', () => {
        // 始终记录飞书响应（便于排查"返回 success 但消息没到群里"这种情况）
        const truncated = data.length > 500 ? data.substring(0, 500) + '...' : data;
        console.log(JSON.stringify({
          level: 'INFO',
          message: 'Feishu webhook response',
          statusCode: res.statusCode,
          host: url.hostname,
          path: url.pathname,
          msgType: (message as any).msg_type,
          bodyLen: body.length,
          response: truncated,
        }));

        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          // Check Feishu response body for error code
          try {
            const parsed = JSON.parse(data);
            if (parsed.code !== undefined && parsed.code !== 0) {
              reject(new Error(`Feishu API error: code=${parsed.code}, msg=${parsed.msg || 'unknown'}`));
              return;
            }
          } catch {
            // If response is not JSON, treat 2xx as success
          }
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data || 'No response body'}`));
        }
      });
    });

    req.on('error', (err: Error) => {
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// -----------------------------------------------------------------------------
// Main send function with retry
// -----------------------------------------------------------------------------

/**
 * Send a Feishu card message to a single webhook URL with fixed-interval retry.
 *
 * Retries on failure with fixed 5-second intervals, up to 3 times (configurable).
 *
 * @param webhookUrl - The Feishu webhook URL to send to
 * @param message - The Feishu card message to send
 * @param options - Optional retry configuration
 * @returns SendResult indicating success/failure and retry count
 */
export async function sendFeishuMessage(
  webhookUrl: string,
  message: FeishuMessage,
  options?: SenderOptions
): Promise<SendResult> {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryIntervalMs = options?.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await postToWebhook(webhookUrl, message);
      return {
        success: true,
        webhookUrl,
        retryCount: attempt - 1,
      };
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      console.log(
        `Feishu webhook send failed (attempt ${attempt}/${maxRetries}): ${lastError}`
      );

      // Wait before retrying (unless this was the last attempt)
      if (attempt < maxRetries) {
        await sleep(retryIntervalMs);
      }
    }
  }

  return {
    success: false,
    webhookUrl,
    retryCount: maxRetries - 1,
    error: `All ${maxRetries} attempts failed. Last error: ${lastError}`,
  };
}

// -----------------------------------------------------------------------------
// Batch send function
// -----------------------------------------------------------------------------

/**
 * Send a Feishu card message to multiple webhook URLs.
 *
 * Sends to all provided webhook URLs, tracking which succeeded and which failed.
 *
 * @param webhookUrls - Array of Feishu webhook URLs
 * @param message - The Feishu card message to send
 * @param options - Optional retry configuration
 * @returns BatchSendResult with sentTo, failedTo, and totalRetryCount
 */
export async function sendToMultipleWebhooks(
  webhookUrls: string[],
  message: FeishuMessage,
  options?: SenderOptions
): Promise<BatchSendResult> {
  const sentTo: string[] = [];
  const failedTo: string[] = [];
  let totalRetryCount = 0;

  for (const url of webhookUrls) {
    const result = await sendFeishuMessage(url, message, options);
    totalRetryCount += result.retryCount;

    if (result.success) {
      sentTo.push(url);
    } else {
      failedTo.push(url);
    }
  }

  return { sentTo, failedTo, totalRetryCount };
}

// -----------------------------------------------------------------------------
// Dead letter function
// -----------------------------------------------------------------------------

/**
 * Write a failed notification to the DynamoDB dead letter table.
 *
 * Table name is read from the DEAD_LETTER_TABLE_NAME environment variable.
 * Each record includes a unique notificationId, the webhook URL, message,
 * failure timestamp, and error description.
 *
 * @param failedNotification - The notification that failed to send
 */
export async function writeToDeadLetter(failedNotification: FailedNotification): Promise<void> {
  const tableName = process.env.DEAD_LETTER_TABLE_NAME;
  if (!tableName) {
    console.error('DEAD_LETTER_TABLE_NAME environment variable is not configured');
    throw new Error('DEAD_LETTER_TABLE_NAME environment variable is not configured');
  }

  const client = getDynamoDBClient();

  const item = {
    notificationId: crypto.randomUUID(),
    webhookUrl: failedNotification.webhookUrl,
    message: failedNotification.message,
    failedAt: new Date().toISOString(),
    error: failedNotification.error,
  };

  await client.send(
    new PutCommand({
      TableName: tableName,
      Item: item,
    })
  );

  console.log(`Written failed notification to dead letter table: ${item.notificationId}`);
}
