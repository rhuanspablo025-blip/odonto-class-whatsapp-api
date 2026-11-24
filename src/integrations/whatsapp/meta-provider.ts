import { and, eq } from "drizzle-orm";

import { getEnv } from "../../config/env.js";
import { getDb } from "../../database/client.js";
import { templates, whatsappAccounts } from "../../database/schema/index.js";
import { nowMs } from "../../lib/ids.js";
import { errors } from "../../lib/errors.js";
import { MetaClient } from "./meta-client.js";
import { WhatsAppProviderError } from "./errors.js";
import type { WhatsAppProvider } from "./provider.js";
import type {
  ProviderHealth,
  SendMediaInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
  TemplateStatus,
} from "./types.js";

/**
 * Provedor oficial da Meta Cloud API.
 * Requer credenciais válidas (META_ACCESS_TOKEN, META_PHONE_NUMBER_ID).
 */
export class MetaCloudProvider implements WhatsAppProvider {
  private readonly client: MetaClient;
  private readonly phoneNumberId: string;
  private readonly whatsappAccountId?: string;
  private readonly tenantId?: string;
  private readonly wabaId?: string;

  constructor(
    accessToken?: string,
    phoneNumberId?: string,
    version?: string,
    whatsappAccountId?: string,
    tenantId?: string,
    wabaId?: string,
  ) {
    const env = getEnv();
    this.client = new MetaClient(accessToken, phoneNumberId, version ?? env.META_GRAPH_API_VERSION);
    this.phoneNumberId = phoneNumberId ?? env.META_PHONE_NUMBER_ID ?? "";
    this.whatsappAccountId = whatsappAccountId;
    this.tenantId = tenantId;
    this.wabaId = wabaId;
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    return this.client.sendText(input);
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const template = await this.findTemplate(input.templateName, input.language);
    if (!template || template.status !== "APPROVED") {
      throw errors.templateNotApproved();
    }

    return this.client.sendTemplate(input);
  }

  async sendMedia(input: SendMediaInput): Promise<SendResult> {
    return this.client.sendMedia(input.to, input.mediaType, input.mediaIdOrLink, input.caption);
  }

  async getTemplateStatus(
    templateName: string,
    language: string,
  ): Promise<TemplateStatus> {
    const template = await this.findTemplate(templateName, language);
    return (template?.status as TemplateStatus) ?? "PENDING";
  }

  private async findTemplate(templateName: string, language: string) {
    const db = getDb();
    const account = await this.findConnectedAccount();
    if (!account) return undefined;
    const [template] = await db
      .select({ status: templates.status })
      .from(templates)
      .where(
        and(
          eq(templates.tenantId, account.tenantId),
          eq(templates.whatsappAccountId, account.id),
          eq(templates.name, templateName),
          eq(templates.language, language),
        ),
      )
      .limit(1);
    return template;
  }

  private async findConnectedAccount() {
    if (!this.phoneNumberId) return undefined;
    const db = getDb();
    const [account] = await db
      .select({
        id: whatsappAccounts.id,
        tenantId: whatsappAccounts.tenantId,
        wabaId: whatsappAccounts.wabaId,
      })
      .from(whatsappAccounts)
      .where(
        and(
          this.whatsappAccountId
            ? eq(whatsappAccounts.id, this.whatsappAccountId)
            : eq(whatsappAccounts.phoneNumberId, this.phoneNumberId),
          this.tenantId ? eq(whatsappAccounts.tenantId, this.tenantId) : undefined,
          eq(whatsappAccounts.status, "CONNECTED"),
        ),
      )
      .limit(1);
    return account;
  }

  async getProviderHealth(): Promise<ProviderHealth> {
    if (!this.phoneNumberId) {
      return { status: "down", phoneNumberId: this.phoneNumberId };
    }
    // Verificação leve: assume ok se credenciais existem.
    // Em produção, faria uma chamada à API de verificação da conta.
    return { status: "ok", phoneNumberId: this.phoneNumberId };
  }

  async syncTemplates(): Promise<number> {
    const db = getDb();
    const account = await this.findConnectedAccount();
    if (!account) {
      throw new WhatsAppProviderError(
        "O phone number da Meta não está associado a uma conta WhatsApp conectada.",
        { code: "WHATSAPP_ACCOUNT_NOT_CONNECTED" },
      );
    }

    const remoteTemplates = await this.client.listMessageTemplates(
      this.wabaId ?? account.wabaId,
    );
    const syncedAt = nowMs();
    for (const template of remoteTemplates) {
      const category = ["MARKETING", "UTILITY", "AUTHENTICATION"].includes(
        template.category.toUpperCase(),
      )
        ? (template.category.toUpperCase() as "MARKETING" | "UTILITY" | "AUTHENTICATION")
        : "MARKETING";
      const status = [
        "APPROVED",
        "PENDING",
        "REJECTED",
        "PAUSED",
        "DISABLED",
      ].includes(template.status.toUpperCase())
        ? (template.status.toUpperCase() as TemplateStatus)
        : "PENDING";

      await db
        .insert(templates)
        .values({
          tenantId: account.tenantId,
          whatsappAccountId: account.id,
          name: template.name,
          language: template.language,
          category,
          status,
          components: template.components,
          syncedAt,
          updatedAt: syncedAt,
        })
        .onConflictDoUpdate({
          target: [templates.tenantId, templates.name, templates.language],
          set: {
            whatsappAccountId: account.id,
            category,
            status,
            components: template.components,
            syncedAt,
            updatedAt: syncedAt,
          },
        });
    }
    return remoteTemplates.length;
  }
}
