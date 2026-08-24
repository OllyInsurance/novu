import { EnvironmentCommand } from '@novu/application-generic';
import { IsDefined } from 'class-validator';

import { WebhookTypes } from '../../interfaces/webhook.interface';

export class WebhookCommand extends EnvironmentCommand {
  @IsDefined()
  providerOrIntegrationId: string;

  @IsDefined()
  body: any;

  @IsDefined()
  type: WebhookTypes;

  // Signature verification inputs. Optional so the SMS path and any caller that
  // cannot supply them keeps working; verification is skipped when absent.
  headers?: Record<string, string>;

  rawBody?: Buffer | string;
}
