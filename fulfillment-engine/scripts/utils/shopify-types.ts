/**
 * TypeScript types for Shopify GraphQL Admin API responses
 */

export interface ShopifyUserError {
  field: string[];
  message: string;
}

export interface ShopifyGraphQLError {
  message: string;
  extensions?: Record<string, unknown>;
  locations?: Array<{ line: number; column: number }>;
}

export interface AccessScopeNode {
  handle: string;
}

export interface AppInstallationScopes {
  data?: {
    app?: {
      installation?: {
        accessScopes?: AccessScopeNode[];
      };
    };
  };
  errors?: ShopifyGraphQLError[];
}

export interface WebhookHttpEndpoint {
  __typename: 'WebhookHttpEndpoint';
  callbackUrl: string;
}

export interface WebhookSubscriptionNode {
  id: string;
  topic: string;
  format: string;
  endpoint: WebhookHttpEndpoint;
  createdAt?: string;
  updatedAt?: string;
}

export interface WebhookSubscriptionEdge {
  node: WebhookSubscriptionNode;
}

export interface WebhookSubscriptionsList {
  data: {
    webhookSubscriptions: {
      edges: WebhookSubscriptionEdge[];
    };
  };
  errors?: ShopifyGraphQLError[];
}

export interface WebhookSubscriptionCreateResult {
  webhookSubscription: WebhookSubscriptionNode | null;
  userErrors: ShopifyUserError[];
}

export interface WebhookSubscriptionCreateResponse {
  data: {
    webhookSubscriptionCreate: WebhookSubscriptionCreateResult;
  };
  errors?: ShopifyGraphQLError[];
}

export interface WebhookSubscriptionDeleteResult {
  deletedWebhookSubscriptionId: string | null;
  userErrors: ShopifyUserError[];
}

export interface WebhookSubscriptionDeleteResponse {
  data: {
    webhookSubscriptionDelete: WebhookSubscriptionDeleteResult;
  };
  errors?: ShopifyGraphQLError[];
}

export interface WebhookSubscriptionUpdateResult {
  webhookSubscription: WebhookSubscriptionNode | null;
  userErrors: ShopifyUserError[];
}

export interface WebhookSubscriptionUpdateResponse {
  data: {
    webhookSubscriptionUpdate: WebhookSubscriptionUpdateResult;
  };
  errors?: ShopifyGraphQLError[];
}

export interface ShopifyGraphQLResponse<T> {
  data: T;
  errors?: ShopifyGraphQLError[];
}

export interface EventBridgeWebhookSubscriptionCreateResult {
  webhookSubscription: WebhookSubscriptionNode | null;
  userErrors: ShopifyUserError[];
}

export interface EventBridgeWebhookSubscriptionCreateResponse {
  data: {
    eventBridgeWebhookSubscriptionCreate: EventBridgeWebhookSubscriptionCreateResult;
  };
  errors?: ShopifyGraphQLError[];
}

export interface WebhookSubscriptionTestResponse {
  data: {
    webhookSubscriptionCreate: WebhookSubscriptionCreateResult;
  };
  errors?: ShopifyGraphQLError[];
}

export interface PrivateMetafield {
  value: string;
}

export interface WebhookSubscriptionWithSecret extends WebhookSubscriptionNode {
  privateMetafield?: PrivateMetafield | null;
}

export interface WebhookSubscriptionSecretEdge {
  node: WebhookSubscriptionWithSecret;
}

export interface WebhookSubscriptionsSecretList {
  data: {
    webhookSubscriptions: {
      edges: WebhookSubscriptionSecretEdge[];
    };
  };
  errors?: ShopifyGraphQLError[];
}
