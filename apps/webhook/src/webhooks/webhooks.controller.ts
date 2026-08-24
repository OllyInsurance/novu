import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Headers,
  Param,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';

import { IWebhookResult } from './dtos/webhooks-response.dto';
import { WebhookCommand } from './usecases/webhook/webhook.command';
import { Webhook } from './usecases/webhook/webhook.usecase';

@Controller('/webhooks')
@UseInterceptors(ClassSerializerInterceptor)
export class WebhooksController {
  constructor(private webhookUsecase: Webhook) {}

  @Post('/organizations/:organizationId/environments/:environmentId/email/:providerOrIntegrationId')
  public emailWebhook(
    @Param('organizationId') organizationId: string,
    @Param('environmentId') environmentId: string,
    @Param('providerOrIntegrationId') providerOrIntegrationId: string,
    @Body() body: any,
    @Headers() headers: Record<string, string>,
    @Req() req: { rawBody?: Buffer }
  ): Promise<IWebhookResult[]> {
    return this.webhookUsecase.execute(
      WebhookCommand.create({
        environmentId,
        organizationId,
        providerOrIntegrationId,
        body,
        type: 'email',
        headers,
        rawBody: req?.rawBody,
      })
    );
  }

  @Post('/organizations/:organizationId/environments/:environmentId/sms/:providerOrIntegrationId')
  public smsWebhook(
    @Param('organizationId') organizationId: string,
    @Param('environmentId') environmentId: string,
    @Param('providerOrIntegrationId') providerOrIntegrationId: string,
    @Body() body: any
  ): Promise<IWebhookResult[]> {
    return this.webhookUsecase.execute(
      WebhookCommand.create({
        environmentId,
        organizationId,
        providerOrIntegrationId,
        body,
        type: 'sms',
      })
    );
  }
}
