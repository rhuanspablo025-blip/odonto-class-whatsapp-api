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
 * Provedor de teste — comportamento determinístico, sem chamadas externas.
 *
 * NUNCA use em produção. Identificado explicitamente para evitar uso acidental.
 * Útil para desenvolvimento sem credenciais da Meta e para testes automatizados.
 */
export class TestWhatsAppProvider implements WhatsAppProvider {
  public readonly isTestProvider = true;
  private sentMessages: SendResult[] = [];

  async sendText(_input: SendTextInput): Promise<SendResult> {
    const result: SendResult = {
      providerMessageId: `wamid.test.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`,
      phoneNumberId: "test-phone-id",
    };
    this.sentMessages.push(result);
    return result;
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    return this.sendText({
      to: input.to,
      text: `[TEMPLATE:${input.templateName}]`,
    });
  }

  async sendMedia(input: SendMediaInput): Promise<SendResult> {
    return this.sendText({ to: input.to, text: `[MEDIA:${input.mediaType}]` });
  }

  async getTemplateStatus(
    _templateName: string,
    _language: string,
  ): Promise<TemplateStatus> {
    return "APPROVED";
  }

  async getProviderHealth(): Promise<ProviderHealth> {
    return {
      status: "ok",
      phoneNumberId: "test-phone-id",
      displayPhoneNumber: "+5500000000000",
    };
  }

  async syncTemplates(): Promise<number> {
    return 0;
  }

  /** Método auxiliar para testes: retorna mensagens enviadas. */
  getSentMessages(): SendResult[] {
    return [...this.sentMessages];
  }
}
