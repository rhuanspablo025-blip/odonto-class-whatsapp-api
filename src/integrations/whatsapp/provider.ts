import type {
  ProviderHealth,
  SendMediaInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
  TemplateStatus,
} from "./types.js";

/**
 * Interface do provedor WhatsApp.
 * Implementações: MetaCloudProvider (produção) e TestProvider (dev/testes).
 *
 * Desacoplado do restante do sistema para permitir testes sem credenciais reais
 * e futura troca de provedor.
 */
export interface WhatsAppProvider {
  sendText(input: SendTextInput): Promise<SendResult>;
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;
  sendMedia(input: SendMediaInput): Promise<SendResult>;
  getTemplateStatus(templateName: string, language: string): Promise<TemplateStatus>;
  getProviderHealth(): Promise<ProviderHealth>;
  syncTemplates(): Promise<number>;
}

export { WhatsAppProviderError, RateLimitError, MessageNotAllowedError } from "./errors.js";
