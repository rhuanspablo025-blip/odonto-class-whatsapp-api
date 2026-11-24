/**
 * Tipos compartilhados da integração WhatsApp.
 */

export type MessageDirection = "INBOUND" | "OUTBOUND";

export type MessageType =
  | "TEXT"
  | "TEMPLATE"
  | "IMAGE"
  | "VIDEO"
  | "AUDIO"
  | "DOCUMENT"
  | "LOCATION";

export type MessageStatus =
  | "PENDING"
  | "QUEUED"
  | "SENT"
  | "DELIVERED"
  | "READ"
  | "FAILED"
  | "CANCELLED";

export interface SendTextInput {
  to: string;
  text: string;
  previewUrl?: boolean;
  whatsappAccountId?: string;
}

export interface SendTemplateInput {
  to: string;
  templateName: string;
  language: string;
  components?: TemplateComponent[];
  whatsappAccountId?: string;
}

export interface TemplateComponent {
  type: "header" | "body" | "button" | "carousel" | "limited_time_offer";
  sub_type?: string;
  index?: string;
  parameters?: TemplateParameter[];
}

export type TemplateParameter =
  | { type: "text"; text: string; parameter_name?: string }
  | { type: "currency"; currency: { fallback_value: string; code: string; amount_1000: number } }
  | { type: "date_time"; date_time: { fallback_value: string } }
  | { type: "image"; image: { id?: string; link?: string } }
  | { type: "video"; video: { id?: string; link?: string } }
  | { type: "document"; document: { id?: string; link?: string; filename?: string } }
  | { type: "payload"; payload: string }
  | {
      type: "location";
      location: {
        longitude: number;
        latitude: number;
        name?: string;
        address?: string;
      };
    };

export interface SendMediaInput {
  to: string;
  mediaType: "image" | "video" | "audio" | "document";
  mediaIdOrLink: string;
  caption?: string;
  whatsappAccountId?: string;
}

export interface SendResult {
  providerMessageId: string;
  phoneNumberId: string;
  wamId?: string;
}

export interface MetaMessageTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components: unknown[];
}

export type TemplateStatus = "APPROVED" | "PENDING" | "REJECTED" | "PAUSED" | "DISABLED";

export interface ProviderHealth {
  status: "ok" | "degraded" | "down";
  phoneNumberId: string;
  displayPhoneNumber?: string;
  rateLimitRemaining?: number;
}

/** Evento recebido via webhook da Meta. */
export interface MetaWebhookEvent {
  object: string;
  entry: MetaWebhookEntry[];
}

export interface MetaWebhookEntry {
  id: string;
  changes: MetaWebhookChange[];
}

export interface MetaWebhookChange {
  field: string;
  value: Record<string, unknown>;
}

export interface MetaWebhookValue {
  messaging_product: string;
  metadata?: {
    phone_number_id: string;
    display_phone_number: string;
  };
  contacts?: Array<{
    wa_id: string;
    profile?: { name: string };
  }>;
  messages?: MetaIncomingMessage[];
  statuses?: Array<{
    id: string;
    status: "sent" | "delivered" | "read" | "failed";
    timestamp: string;
    recipient_id: string;
    errors?: Array<{
      code?: number;
      title?: string;
      message?: string;
      error_data?: { details?: string };
    }>;
  }>;
}

/** Os tipos de mensagem variam; campos adicionais são mantidos no payload bruto. */
export interface MetaIncomingMessage {
  id: string;
  from: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  [key: string]: unknown;
}
