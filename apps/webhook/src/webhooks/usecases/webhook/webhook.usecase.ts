import { BadRequestException, Injectable, Logger, NotFoundException, Scope, UnauthorizedException } from '@nestjs/common';
import { AnalyticsService, IMailHandler, ISmsHandler, MailFactory, SmsFactory } from '@novu/application-generic';
import { IntegrationEntity, IntegrationQuery, IntegrationRepository, MessageRepository } from '@novu/dal';
import { ChannelTypeEnum, providers } from '@novu/shared';
import { IEmailProvider, ISmsProvider } from '@novu/stateless';
import { IWebhookResult } from '../../dtos/webhooks-response.dto';
import { WebhookTypes } from '../../interfaces/webhook.interface';
import { CreateExecutionDetails } from '../execution-details/create-execution-details.usecase';
import { WebhookCommand } from './webhook.command';

@Injectable({ scope: Scope.REQUEST })
export class Webhook {
  public readonly mailFactory = new MailFactory();
  public readonly smsFactory = new SmsFactory();
  private provider: IEmailProvider | ISmsProvider;

  // Olly patch (ENG-1144): true once a signing key verified this request. Only
  // then are its bounces handed to Olly (olly-email-events.ts).
  private signatureChecked = false;

  constructor(
    private createExecutionDetails: CreateExecutionDetails,
    private integrationRepository: IntegrationRepository,
    private messageRepository: MessageRepository,
    private analyticsService: AnalyticsService
  ) {}

  async execute(command: WebhookCommand): Promise<IWebhookResult[]> {
    const { providerOrIntegrationId } = command;
    const isProviderId = !!providers.find((el) => el.id === providerOrIntegrationId);
    const channel: ChannelTypeEnum = command.type === 'email' ? ChannelTypeEnum.EMAIL : ChannelTypeEnum.SMS;

    const query: IntegrationQuery = {
      ...(isProviderId
        ? { providerId: providerOrIntegrationId, credentials: { $exists: true }, channel }
        : { _id: providerOrIntegrationId }),
      _environmentId: command.environmentId,
      _organizationId: command.organizationId,
    };

    const integration: IntegrationEntity = await this.integrationRepository.findOne(query);
    if (!integration) {
      throw new NotFoundException(`Integration for ${providerOrIntegrationId} was not found`);
    }

    const hasNoCredentials = !integration.credentials || Object.keys(integration.credentials).length === 0;
    if (hasNoCredentials) {
      throw new BadRequestException(`Integration ${integration._id} doesn't have credentials set up`);
    }

    this.analyticsService.track('[Webhook] - Provider Webhook called', '', {
      _organization: command.organizationId,
      _environmentId: command.environmentId,
      providerId: integration.providerId,
      channel,
    });

    this.createProvider(integration, command.type);

    if (!this.provider.getMessageId || !this.provider.parseEventBody) {
      throw new NotFoundException(`Provider with ${integration.providerId} can not handle webhooks`);
    }

    /*
     * Verify the provider's webhook signature before trusting the payload.
     * Upstream community does not do this (it is part of the enterprise inbound
     * webhook module), which leaves the endpoint open to forged delivery events
     * from anyone who knows the URL. The providers already implement
     * verifySignature; this just calls it.
     *
     * Providers return { success: true } when no signing key is configured, so
     * this preserves upstream behaviour until a key is set on the integration.
     */
    if (typeof (this.provider as { verifySignature?: unknown }).verifySignature === 'function') {
      const verification = await (
        this.provider as unknown as {
          verifySignature: (input: {
            rawBody: Buffer | string;
            headers: Record<string, string>;
            body: Record<string, unknown>;
          }) => Promise<{ success: boolean; message?: string }>;
        }
      ).verifySignature({
        rawBody: command.rawBody ?? JSON.stringify(command.body),
        headers: command.headers ?? {},
        body: command.body,
      });

      if (!verification.success) {
        Logger.error(
          `Webhook signature verification failed for integration ${integration._id}: ${verification.message}`
        );

        throw new UnauthorizedException('Webhook signature verification failed');
      }
    }

    const merged = {
      ...(integration.configurations ?? {}),
      ...integration.credentials,
    } as Record<string, unknown>;
    this.signatureChecked = Boolean(merged.inboundWebhookSigningKey);

    const events = await this.parseEvents(command, integration.providerId, channel);

    this.analyticsService.track('[Webhook] - Provider Webhook events parsed', '', {
      _organization: command.organizationId,
      _environmentId: command.environmentId,
      providerId: integration.providerId,
      channel,
      events,
    });

    return events;
  }

  private async parseEvents(
    command: WebhookCommand,
    providerId: string,
    channel: ChannelTypeEnum
  ): Promise<IWebhookResult[]> {
    const { body } = command;
    const messageIdentifiers: string[] = this.provider.getMessageId(body);

    const events: IWebhookResult[] = [];

    for (const messageIdentifier of messageIdentifiers) {
      const event = await this.parseEvent(messageIdentifier, command, providerId, channel);

      if (event === undefined) {
        continue;
      }

      events.push(event);
    }

    return events;
  }

  private async parseEvent(
    messageIdentifier: string,
    command: WebhookCommand,
    providerId: string,
    channel: ChannelTypeEnum
  ): Promise<IWebhookResult | undefined> {
    const message = await this.messageRepository.findOne({
      identifier: messageIdentifier,
      _environmentId: command.environmentId,
      _organizationId: command.organizationId,
    });

    if (!message) {
      Logger.error(`Message with ${messageIdentifier} as identifier was not found`);

      return;
    }

    const event = this.provider.parseEventBody(command.body, messageIdentifier);

    if (event === undefined) {
      return undefined;
    }

    const parsedEvent = {
      id: messageIdentifier,
      event,
    };

    /**
     * TODO: Individually performing the creation of the execution details because here we can pass message that contains
     * most of the __foreign keys__ we need. But we can't take advantage of a bulk write of all events. Besides the writing
     * being hiding inside auxiliary methods of the use case.
     */
    await this.createExecutionDetails.execute({
      message,
      webhook: {
        ...command,
        providerId,
        signatureChecked: this.signatureChecked,
      },
      webhookEvent: parsedEvent,
      channel,
    });

    return parsedEvent;
  }

  private getHandler(integration: IntegrationEntity, type: WebhookTypes): ISmsHandler | IMailHandler | null {
    switch (type) {
      case 'sms':
        return this.smsFactory.getHandler(integration);
      default:
        return this.mailFactory.getHandler(integration);
    }
  }

  private createProvider(integration: IntegrationEntity, type: 'sms' | 'email') {
    const handler = this.getHandler(integration, type);
    if (!handler) {
      throw new NotFoundException(`Handler for integration of ${integration.providerId} was not found`);
    }
    /*
     * Olly patch (ENG-1144): the API stores the signing key under
     * configurations (ConfigurationsDto); the dashboard has put it under
     * credentials. Read both, credentials winning, so a key set either way is
     * enforced.
     */
    handler.buildProvider({
      ...(integration.configurations ?? {}),
      ...integration.credentials,
    } as IntegrationEntity['credentials']);

    this.provider = handler.getProvider();
  }
}
