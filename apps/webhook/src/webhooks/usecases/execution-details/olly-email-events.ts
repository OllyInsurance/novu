/*
 * Olly patch (ENG-1144): hand email bounces and complaints to Olly's
 * notifications service, so Novu's receiver is the only place a provider's
 * delivery events land (Resend posts once, here). Called from
 * CreateExecutionDetails after the execution detail is written. Documented in
 * apps/webhook/Dockerfile.olly; carry it on every Novu upgrade.
 *
 * Off unless OLLY_EMAIL_EVENTS_URL is set. Authenticated with Olly's shared
 * service secret (X-Internal-Service: OLLY_INTERNAL_SVC_SECRET). The provider
 * event was already signature-verified by Webhook.execute.
 *
 * A 5xx, a 404 or a network failure throws, so the receiver answers 500 and
 * the provider retries the delivery; notifications deduplicates on the
 * provider's event id. Any other 4xx is logged and dropped: a retry would get
 * the same answer.
 */
import { Logger } from '@nestjs/common';
import { MessageEntity } from '@novu/dal';
import { ChannelTypeEnum } from '@novu/shared';
import { EmailEventStatusEnum } from '@novu/stateless';

const LOG_CONTEXT = 'OllyEmailEvents';

const FORWARDED: Record<string, 'bounced' | 'complained'> = {
  [EmailEventStatusEnum.BOUNCED]: 'bounced',
  [EmailEventStatusEnum.COMPLAINT]: 'complained',
};

export interface OllyEmailEvent {
  event: 'bounced' | 'complained';
  provider: string;
  providerEventId: string;
  providerMessageId: string;
  messageId: string;
  transactionId: string;
  recipient: string;
  subject: string;
  bounceType: string;
  bounceSubType: string;
  tags: unknown;
  occurredAt: string;
}

function header(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return '';
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const v = key ? headers[key] : undefined;

  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
}

/** The Olly email event for a provider event, or undefined when it is not one Olly takes. */
export function toOllyEmailEvent(input: {
  channel: ChannelTypeEnum;
  status: string | undefined;
  providerId: string;
  headers?: Record<string, string>;
  message: MessageEntity;
  externalId?: string;
  row?: string;
}): OllyEmailEvent | undefined {
  const event = input.status ? FORWARDED[input.status] : undefined;
  if (input.channel !== ChannelTypeEnum.EMAIL || !event) return undefined;

  let raw: any = {};
  try {
    raw = typeof input.row === 'string' ? JSON.parse(input.row) : (input.row ?? {});
  } catch {
    raw = {};
  }
  const data = raw?.data ?? {};

  return {
    event,
    provider: input.providerId,
    providerEventId: header(input.headers, 'svix-id'),
    providerMessageId: input.externalId || data.email_id || input.message.identifier || '',
    messageId: String(input.message._id),
    transactionId: input.message.transactionId,
    recipient: input.message.email || (Array.isArray(data.to) ? data.to[0] : '') || '',
    subject: input.message.subject || data.subject || '',
    bounceType: data.bounce?.type ?? '',
    bounceSubType: data.bounce?.subType ?? '',
    tags: data.tags ?? null,
    occurredAt: raw?.created_at ?? new Date().toISOString(),
  };
}

export async function forwardOllyEmailEvent(ev: OllyEmailEvent): Promise<void> {
  const url = process.env.OLLY_EMAIL_EVENTS_URL;
  if (!url) return;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service': process.env.OLLY_INTERNAL_SVC_SECRET ?? '',
      },
      body: JSON.stringify(ev),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (e) {
    Logger.error(`Olly email event not delivered for message ${ev.messageId}: ${(e as Error).message}`, LOG_CONTEXT);
    throw e;
  }

  if (res.ok) {
    Logger.log(`Olly email event ${ev.event} delivered for message ${ev.messageId}`, LOG_CONTEXT);

    return;
  }
  const detail = `Olly email event ${ev.event} for message ${ev.messageId} answered ${res.status}`;
  if (res.status >= 500 || res.status === 404) {
    Logger.error(detail, LOG_CONTEXT);
    throw new Error(detail);
  }
  Logger.warn(`${detail}; dropped`, LOG_CONTEXT);
}
