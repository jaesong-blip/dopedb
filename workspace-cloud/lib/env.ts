// Server-only environment access. Values are read lazily so static pages can build
// without production secrets; request handlers fail closed when configuration is absent.
import "server-only";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function appOrigin(): string {
  const raw = required("BETTER_AUTH_URL");
  const url = new URL(raw);
  const localDevelopment =
    process.env.NODE_ENV !== "production" &&
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !localDevelopment) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("BETTER_AUTH_URL must be an HTTPS origin");
  }
  return url.origin;
}

function authSecret(): string {
  const value = required("BETTER_AUTH_SECRET");
  if (value.length < 32) throw new Error("BETTER_AUTH_SECRET must be at least 32 characters");
  return value;
}

function optional(name: string): string | null {
  return process.env[name]?.trim() || null;
}

function githubKnowledgePrivateKey(): string | null {
  const value = optional("GITHUB_KNOWLEDGE_APP_PRIVATE_KEY");
  if (!value) return null;
  const key = value.includes("BEGIN RSA PRIVATE KEY") || value.includes("BEGIN PRIVATE KEY")
    ? value.replaceAll("\\n", "\n")
    : Buffer.from(value, "base64").toString("utf8");
  if (
    !key.includes("-----BEGIN")
    || !key.includes("PRIVATE KEY-----")
    || !key.includes("-----END")
  ) {
    throw new Error("GITHUB_KNOWLEDGE_APP_PRIVATE_KEY is not a PEM private key");
  }
  return key;
}

export const env = {
  appOrigin,
  authSecret,
  cronSecret: () => optional("CRON_SECRET"),
  credentialKey: () => required("WORKSPACE_CREDENTIAL_KEY"),
  databaseUrl: () => required("DATABASE_URL"),
  googleClientId: () => required("GOOGLE_CLIENT_ID"),
  googleClientSecret: () => required("GOOGLE_CLIENT_SECRET"),
  githubKnowledgeAppId: () => optional("GITHUB_KNOWLEDGE_APP_ID"),
  githubKnowledgeAppSlug: () => optional("GITHUB_KNOWLEDGE_APP_SLUG"),
  githubKnowledgePrivateKey,
  githubKnowledgeWebhookSecret: () => optional("GITHUB_KNOWLEDGE_WEBHOOK_SECRET"),
  planetScaleClientId: () => optional("PLANETSCALE_CLIENT_ID"),
  planetScaleClientSecret: () => optional("PLANETSCALE_CLIENT_SECRET"),
  resendApiKey: () => optional("RESEND_API_KEY"),
  workspaceInvitationFrom: () => optional("WORKSPACE_INVITATION_FROM"),
  workspaceSignalFrom: () => optional("WORKSPACE_SIGNAL_FROM")
    || optional("WORKSPACE_INVITATION_FROM"),
  workspaceKmsKeyName: () => required("WORKSPACE_KMS_KEY_NAME"),
  workspaceKmsWifAudience: () => required("WORKSPACE_KMS_WIF_AUDIENCE"),
  workspaceKmsServiceAccountEmail: () => required("WORKSPACE_KMS_SERVICE_ACCOUNT_EMAIL"),
};
