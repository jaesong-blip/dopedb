// Idempotent Google Cloud bootstrap for one workspace/Cloud SQL instance.
// The caller's short-lived OAuth token performs setup; the returned durable
// configuration contains only WIF coordinates and service-account identities.
import "server-only";

import { createHash } from "node:crypto";
import {
  gcpCloudSqlEngine,
  gcpDatabaseUsername,
  parseGcpCloudSqlCredential,
  type GcpCloudSqlCredential,
} from "./gcp-cloud-sql-core";
import {
  gcpCloudSqlProduction,
  listGcpOAuthInstances,
  type GcpSetupCredential,
} from "./gcp-cloud-oauth";
import { validateGcpCloudSqlCredential } from "./gcp-cloud-sql";
import { ProviderRequestError } from "./provider-types";
import { verifyVercelOidcToken } from "./vercel-oidc";

const IAM_ORIGIN = "https://iam.googleapis.com";
const IAM_CREDENTIALS_ORIGIN = "https://iamcredentials.googleapis.com";
const RESOURCE_MANAGER_ORIGIN = "https://cloudresourcemanager.googleapis.com";
const SERVICE_USAGE_ORIGIN = "https://serviceusage.googleapis.com";
const SQL_ADMIN_ORIGIN = "https://sqladmin.googleapis.com/sql/v1beta4";
const REQUEST_TIMEOUT_MS = 30_000;
const OPERATION_TIMEOUT_MS = 210_000;
const TOKEN_CREATOR_PROPAGATION_TIMEOUT_MS = 180_000;
const POOL_ID = "dopedb-vercel";
const PROVIDER_ID = "dopedb-vercel";
const REQUIRED_SERVICES = [
  "cloudresourcemanager.googleapis.com",
  "iam.googleapis.com",
  "iamcredentials.googleapis.com",
  "sqladmin.googleapis.com",
  "sts.googleapis.com",
] as const;
type JsonObject = Record<string, unknown>;

export type GcpSetupPermissionRequirement = {
  role: string;
  label: string;
  purpose: string;
  missingPermissions: string[];
};

export type GcpSetupPermissionCheck = {
  account: string;
  projectId: string;
  canAutoGrant: boolean;
  missing: GcpSetupPermissionRequirement[];
};

const GCP_SETUP_ROLE_REQUIREMENTS = [
  {
    role: "roles/serviceusage.serviceUsageAdmin",
    label: "Service Usage Admin",
    purpose: "필수 Google Cloud API 활성화",
    permissions: [
      "serviceusage.services.enable",
      "serviceusage.services.use",
    ],
  },
  {
    role: "roles/iam.workloadIdentityPoolAdmin",
    label: "Workload Identity Pool Admin",
    purpose: "키 없이 연결할 Workload Identity Pool과 Provider 구성",
    permissions: [
      "iam.workloadIdentityPools.create",
      "iam.workloadIdentityPoolProviders.create",
    ],
  },
  {
    role: "roles/iam.serviceAccountAdmin",
    label: "Service Account Admin",
    purpose: "연결 전용 서비스 계정 생성과 IAM 정책 구성",
    permissions: [
      "iam.serviceAccounts.create",
      "iam.serviceAccounts.delete",
      "iam.serviceAccounts.getIamPolicy",
      "iam.serviceAccounts.setIamPolicy",
    ],
  },
  {
    role: "roles/resourcemanager.projectIamAdmin",
    label: "Project IAM Admin",
    purpose: "Cloud SQL 인스턴스 범위의 최소 권한 부여",
    permissions: [
      "resourcemanager.projects.getIamPolicy",
      "resourcemanager.projects.setIamPolicy",
    ],
  },
  {
    role: "roles/cloudsql.admin",
    label: "Cloud SQL Admin",
    purpose: "IAM DB 인증과 전용 데이터베이스 사용자 구성",
    permissions: [
      "cloudsql.instances.update",
      "cloudsql.users.create",
      "cloudsql.users.delete",
      "cloudsql.users.list",
      "cloudsql.users.update",
    ],
  },
] as const;

export type GcpCloudBootstrapInput = {
  workspaceId: string;
  projectId: string;
  projectNumber: string;
  instanceId: string;
  environmentClassification: "production" | "development" | null;
  writeAccess: boolean;
  approveProduction: boolean;
  approveInstanceRestart: boolean;
};

export type GcpCloudBootstrapResult = {
  configuration: GcpCloudSqlCredential;
  engine: "postgres" | "mysql";
  production: boolean;
  iamAuthenticationChanged: boolean;
  databaseUsers: {
    read: string;
    write: string | null;
  };
};

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Google Cloud returned an invalid response",
      502,
    );
  }
  return value as JsonObject;
}

function safeSegment(value: string, pattern: RegExp, message: string) {
  if (!pattern.test(value)) {
    throw new ProviderRequestError("gcpCloudSql", message, 400);
  }
  return encodeURIComponent(value);
}

function quotaProjectCredential(
  credential: GcpSetupCredential,
  projectId: string,
): GcpSetupCredential {
  safeSegment(
    projectId,
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
    "Invalid Google Cloud project",
  );
  return { ...credential, quotaProjectId: projectId };
}

type GoogleErrorInfo = {
  reason: string;
  service: string;
  consumer: string;
};

class GcpUpstreamRequestError extends ProviderRequestError {
  constructor(
    message: string,
    status: number,
    public readonly iamServiceAccountPropagationPending: boolean,
  ) {
    super("gcpCloudSql", message, status);
    this.name = "GcpUpstreamRequestError";
  }
}

function googleErrorInfo(body: unknown): GoogleErrorInfo {
  const empty = { reason: "", service: "", consumer: "" };
  if (!body || typeof body !== "object" || Array.isArray(body)) return empty;
  const error = (body as JsonObject).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return empty;
  const details = Array.isArray((error as JsonObject).details)
    ? (error as JsonObject).details as unknown[]
    : [];
  for (const detail of details) {
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) continue;
    const row = detail as JsonObject;
    const reason = row.reason;
    if (typeof reason === "string" && /^[A-Z0-9_]{1,100}$/.test(reason)) {
      const metadata = row.metadata;
      const values = metadata && typeof metadata === "object" && !Array.isArray(metadata)
        ? metadata as JsonObject
        : {};
      const service = typeof values.service === "string"
        && /^[a-z0-9.-]{1,128}\.googleapis\.com$/.test(values.service)
        ? values.service
        : "";
      const consumer = typeof values.consumer === "string"
        && /^projects\/[A-Za-z0-9.-]{1,64}$/.test(values.consumer)
        ? values.consumer
        : "";
      return { reason, service, consumer };
    }
  }
  return empty;
}

function googleErrorMessage(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const error = (body as JsonObject).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) return "";
  const message = (error as JsonObject).message;
  return typeof message === "string" && message.length <= 500 ? message : "";
}

function iamServiceAccountPropagationPending(
  status: number,
  url: string,
  body: unknown,
) {
  if (
    status !== 400
    || !url.startsWith(RESOURCE_MANAGER_ORIGIN)
    || !url.endsWith(":setIamPolicy")
  ) {
    return false;
  }
  return /^Service account [a-z][a-z0-9-]{4,29}@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com does not exist\.$/
    .test(googleErrorMessage(body));
}

function upstreamMessage(status: number, url: string, body: unknown) {
  if (status === 401) return "Google Cloud 승인이 만료되었습니다. 계정을 다시 연결하세요.";
  if (status === 403) {
    const { reason, service, consumer } = googleErrorInfo(body);
    if (reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") {
      return "Google 승인에 cloud-platform 권한이 포함되지 않았습니다. 계정을 다시 연결하고 Google Cloud 접근을 승인하세요.";
    }
    if (reason === "SERVICE_DISABLED") {
      if (service && consumer) {
        return `Google Cloud API ${service}가 quota project ${consumer}에서 비활성화되어 있습니다.`;
      }
      if (service) {
        return `Google Cloud API ${service}가 quota project에서 비활성화되어 있습니다.`;
      }
      return "quota project에 필요한 Google Cloud API가 비활성화되어 있습니다.";
    }
    if (reason.includes("ORG_POLICY")) {
      return "Google Cloud 조직 정책이 이 설정 작업을 차단했습니다.";
    }
    if (url.startsWith(SERVICE_USAGE_ORIGIN)) {
      return "필수 API를 활성화할 수 없습니다. Service Usage Admin 권한이 필요합니다.";
    }
    if (url.startsWith(IAM_CREDENTIALS_ORIGIN)) {
      return "임시 서비스 계정 자격 증명을 발급할 수 없습니다.";
    }
    if (url.startsWith(IAM_ORIGIN) && url.includes("workloadIdentityPool")) {
      return "Workload Identity를 구성할 수 없습니다. Workload Identity Pool Admin 권한이 필요합니다.";
    }
    if (url.startsWith(IAM_ORIGIN) && url.includes("serviceAccounts")) {
      return "서비스 계정을 구성할 수 없습니다. Service Account Admin 권한이 필요합니다.";
    }
    if (url.startsWith(RESOURCE_MANAGER_ORIGIN)) {
      return "프로젝트 IAM 정책을 변경할 수 없습니다. Project IAM Admin 권한이 필요합니다.";
    }
    if (url.startsWith(SQL_ADMIN_ORIGIN)) {
      return "Cloud SQL 설정을 변경할 수 없습니다. Cloud SQL Admin 권한이 필요합니다.";
    }
    return "Google Cloud에서 이 설정 작업을 거부했습니다.";
  }
  if (status === 404) return "선택한 Google Cloud 리소스를 찾지 못했습니다.";
  if (status === 409) return "기존 Google Cloud 리소스가 이 DopeDB 설정과 충돌합니다.";
  if (status === 429) return "Google Cloud 요청 한도에 도달했습니다. 잠시 뒤 다시 시도하세요.";
  return "Google Cloud 설정을 완료하지 못했습니다.";
}

async function googleRequest(
  credential: GcpSetupCredential,
  url: string,
  init: RequestInit = {},
  allowNotFound = false,
): Promise<JsonObject | null> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
      authorization: `Bearer ${credential.accessToken}`,
      ...(credential.quotaProjectId
        ? { "x-goog-user-project": credential.quotaProjectId }
        : {}),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch(() => {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Google Cloud is unavailable",
      502,
    );
  });
  if (allowNotFound && response.status === 404) return null;
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) {
    throw new GcpUpstreamRequestError(
      upstreamMessage(response.status, url, body),
      response.status === 401 || response.status === 403 || response.status === 404
        ? response.status
        : response.status === 409
          ? 409
          : 502,
      iamServiceAccountPropagationPending(response.status, url, body),
    );
  }
  return object(body);
}

export async function checkGcpSetupPermissions(
  credential: GcpSetupCredential,
  projectId: string,
): Promise<GcpSetupPermissionCheck> {
  const scopedCredential = quotaProjectCredential(credential, projectId);
  const requested = GCP_SETUP_ROLE_REQUIREMENTS.flatMap(
    (requirement) => [...requirement.permissions],
  );
  const body = (await googleRequest(
    scopedCredential,
    `${RESOURCE_MANAGER_ORIGIN}/v3/projects/${encodeURIComponent(projectId)
    }:testIamPermissions`,
    {
      method: "POST",
      body: JSON.stringify({ permissions: requested }),
    },
  ))!;
  const granted = new Set(
    Array.isArray(body.permissions)
      ? body.permissions.filter(
          (permission): permission is string => typeof permission === "string",
        )
      : [],
  );
  const missing = GCP_SETUP_ROLE_REQUIREMENTS.flatMap((requirement) => {
    const missingPermissions = requirement.permissions.filter(
      (permission) => !granted.has(permission),
    );
    return missingPermissions.length > 0
      ? [{
          role: requirement.role,
          label: requirement.label,
          purpose: requirement.purpose,
          missingPermissions,
        }]
      : [];
  });
  return {
    account: credential.email,
    projectId,
    canAutoGrant:
      granted.has("resourcemanager.projects.getIamPolicy")
      && granted.has("resourcemanager.projects.setIamPolicy"),
    missing,
  };
}

function operationName(value: JsonObject) {
  if (
    typeof value.name !== "string"
    || !/^[A-Za-z0-9_./-]{1,500}$/.test(value.name)
  ) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Google Cloud setup operation was not identified",
      502,
    );
  }
  return value.name;
}

function operationFailed(value: JsonObject) {
  if (!value.error) return false;
  const error = object(value.error);
  return typeof error.code === "number" && error.code !== 0;
}

async function waitOperation(
  credential: GcpSetupCredential,
  origin: string,
  version: string,
  operation: JsonObject,
) {
  const name = operationName(operation);
  const startedAt = Date.now();
  let current = operation;
  while (current.done !== true) {
    if (Date.now() - startedAt > OPERATION_TIMEOUT_MS) {
      throw new ProviderRequestError(
        "gcpCloudSql",
        "Google Cloud setup is still running. Retry to continue safely.",
        503,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    current = (await googleRequest(
      credential,
      `${origin}/${version}/${name.split("/").map(encodeURIComponent).join("/")}`,
    ))!;
  }
  if (operationFailed(current)) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Google Cloud setup operation failed",
      409,
    );
  }
}

async function waitSqlOperation(
  credential: GcpSetupCredential,
  projectId: string,
  operation: JsonObject,
) {
  const name = operationName(operation);
  const startedAt = Date.now();
  let current = operation;
  while (current.status !== "DONE") {
    if (Date.now() - startedAt > OPERATION_TIMEOUT_MS) {
      throw new ProviderRequestError(
        "gcpCloudSql",
        "Cloud SQL is still applying the change. Retry to continue safely.",
        503,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    current = (await googleRequest(
      credential,
      `${SQL_ADMIN_ORIGIN}/projects/${encodeURIComponent(projectId)}/operations/${
        encodeURIComponent(name)
      }`,
    ))!;
  }
  if (current.error) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Cloud SQL rejected the requested change",
      409,
    );
  }
}

async function enableServices(
  credential: GcpSetupCredential,
  projectNumber: string,
) {
  const operation = (await googleRequest(
    credential,
    `${SERVICE_USAGE_ORIGIN}/v1/projects/${encodeURIComponent(projectNumber)}/services:batchEnable`,
    {
      method: "POST",
      body: JSON.stringify({ serviceIds: REQUIRED_SERVICES }),
    },
  ))!;
  await waitOperation(credential, SERVICE_USAGE_ORIGIN, "v1", operation);
}

async function confirmProject(
  credential: GcpSetupCredential,
  projectId: string,
  projectNumber: string,
) {
  const project = (await googleRequest(
    credential,
    `${RESOURCE_MANAGER_ORIGIN}/v3/projects/${encodeURIComponent(projectId)}`,
  ))!;
  if (
    project.state !== "ACTIVE"
    || project.projectId !== projectId
    || project.name !== `projects/${projectNumber}`
  ) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Google Cloud project identity changed during setup",
      409,
    );
  }
}

async function ensurePool(
  credential: GcpSetupCredential,
  projectNumber: string,
) {
  const parent = `projects/${projectNumber}/locations/global`;
  const name = `${parent}/workloadIdentityPools/${POOL_ID}`;
  let pool = await googleRequest(
    credential,
    `${IAM_ORIGIN}/v1/${name.split("/").map(encodeURIComponent).join("/")}`,
    {},
    true,
  );
  if (!pool) {
    const operation = (await googleRequest(
      credential,
      `${IAM_ORIGIN}/v1/${parent.split("/").map(encodeURIComponent).join("/")
      }/workloadIdentityPools?workloadIdentityPoolId=${POOL_ID}`,
      {
        method: "POST",
        body: JSON.stringify({
          displayName: "DopeDB Vercel",
          description: "Keyless DopeDB production deployment identities",
          disabled: false,
        }),
      },
    ))!;
    await waitOperation(credential, IAM_ORIGIN, "v1", operation);
    pool = await googleRequest(
      credential,
      `${IAM_ORIGIN}/v1/${name.split("/").map(encodeURIComponent).join("/")}`,
    );
  }
  if (pool?.name !== name || pool.state !== "ACTIVE" || pool.disabled === true) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "The DopeDB workload identity pool is not active",
      409,
    );
  }
}

async function ensureProvider(
  credential: GcpSetupCredential,
  projectNumber: string,
  identity: Awaited<ReturnType<typeof verifyVercelOidcToken>>,
) {
  const pool = `projects/${projectNumber}/locations/global/workloadIdentityPools/${POOL_ID}`;
  const name = `${pool}/providers/${PROVIDER_ID}`;
  let provider = await googleRequest(
    credential,
    `${IAM_ORIGIN}/v1/${name.split("/").map(encodeURIComponent).join("/")}`,
    {},
    true,
  );
  if (!provider) {
    const operation = (await googleRequest(
      credential,
      `${IAM_ORIGIN}/v1/${pool.split("/").map(encodeURIComponent).join("/")
      }/providers?workloadIdentityPoolProviderId=${PROVIDER_ID}`,
      {
        method: "POST",
        body: JSON.stringify({
          displayName: "DopeDB Vercel",
          description: "DopeDB production Vercel Functions only",
          attributeMapping: { "google.subject": "assertion.sub" },
          attributeCondition: `assertion.project_id == '${identity.projectId}' && assertion.environment == 'production'`,
          oidc: {
            issuerUri: identity.issuer,
            allowedAudiences: [identity.audience],
          },
          disabled: false,
        }),
      },
    ))!;
    await waitOperation(credential, IAM_ORIGIN, "v1", operation);
    provider = await googleRequest(
      credential,
      `${IAM_ORIGIN}/v1/${name.split("/").map(encodeURIComponent).join("/")}`,
    );
  }
  const oidc = provider?.oidc && typeof provider.oidc === "object"
    ? provider.oidc as JsonObject
    : null;
  const mapping = provider?.attributeMapping
    && typeof provider.attributeMapping === "object"
    ? provider.attributeMapping as JsonObject
    : null;
  const audiences = oidc && Array.isArray(oidc.allowedAudiences)
    ? oidc.allowedAudiences
    : [];
  const requiredCondition =
    `assertion.project_id == '${identity.projectId}' && assertion.environment == 'production'`;
  if (
    provider?.name !== name
    || provider.state !== "ACTIVE"
    || provider.disabled === true
    || oidc?.issuerUri !== identity.issuer
    || audiences.length !== 1
    || audiences[0] !== identity.audience
    || mapping?.["google.subject"] !== "assertion.sub"
    || provider.attributeCondition !== requiredCondition
  ) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "The existing DopeDB workload provider has a different trust policy",
      409,
    );
  }
}

function setupFingerprint(input: GcpCloudBootstrapInput) {
  return createHash("sha256")
    .update(`${input.workspaceId}:${input.projectId}:${input.instanceId}`)
    .digest("hex")
    .slice(0, 14);
}

function serviceAccountId(
  kind: "read" | "write" | "bootstrap",
  fingerprint: string,
) {
  const short = kind === "read" ? "r" : kind === "write" ? "w" : "b";
  return `dopedb-${short}-${fingerprint}`;
}

async function ensureServiceAccount(
  credential: GcpSetupCredential,
  projectId: string,
  accountId: string,
  description: string,
  displayName: string,
) {
  const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;
  const resource = `projects/${projectId}/serviceAccounts/${email}`;
  let account = await googleRequest(
    credential,
    `${IAM_ORIGIN}/v1/${resource.split("/").map(encodeURIComponent).join("/")}`,
    {},
    true,
  );
  if (!account) {
    account = await googleRequest(
      credential,
      `${IAM_ORIGIN}/v1/projects/${encodeURIComponent(projectId)}/serviceAccounts`,
      {
        method: "POST",
        body: JSON.stringify({
          accountId,
          serviceAccount: { displayName, description },
        }),
      },
    );
  }
  if (
    account?.email !== email
    || account.description !== description
    || account.disabled === true
  ) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "A service account name is already in use by another configuration",
      409,
    );
  }
  return email;
}

type IamBinding = {
  role: string;
  members: string[];
  condition?: { title?: string; description?: string; expression?: string };
};

export type GcpTemporaryPermissionGrant = {
  projectId: string;
  bindings: IamBinding[];
};

function policyBindings(policy: JsonObject): IamBinding[] {
  if (!Array.isArray(policy.bindings)) return [];
  return policy.bindings.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as JsonObject;
    if (typeof row.role !== "string" || !Array.isArray(row.members)) return [];
    const members = row.members.filter((member): member is string => (
      typeof member === "string"
    ));
    const condition = row.condition && typeof row.condition === "object"
      && !Array.isArray(row.condition)
      ? row.condition as IamBinding["condition"]
      : undefined;
    return [{ role: row.role, members, ...(condition ? { condition } : {}) }];
  });
}

function addBinding(
  bindings: IamBinding[],
  expected: IamBinding,
) {
  const matching = bindings.find((binding) => (
    binding.role === expected.role
    && (binding.condition?.expression ?? "") === (expected.condition?.expression ?? "")
  ));
  if (matching) {
    if (!matching.members.includes(expected.members[0])) {
      matching.members.push(expected.members[0]);
      matching.members.sort();
      return true;
    }
    return false;
  }
  const expectedCondition = expected.condition;
  if (
    expectedCondition?.title
    && bindings.some((binding) => (
      binding.condition?.title === expectedCondition.title
      && binding.condition?.expression !== expectedCondition.expression
    ))
  ) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "An IAM condition name is already used by a different policy",
      409,
    );
  }
  bindings.push(expected);
  return true;
}

async function updateIamPolicy(
  credential: GcpSetupCredential,
  resourceUrl: string,
  additions: IamBinding[],
) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const policy = (await googleRequest(
      credential,
      `${resourceUrl}:getIamPolicy`,
      {
        method: "POST",
        body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
      },
    ))!;
    const bindings = policyBindings(policy);
    let changed = false;
    for (const addition of additions) {
      changed = addBinding(bindings, addition) || changed;
    }
    if (!changed) return;
    try {
      await googleRequest(
        credential,
        `${resourceUrl}:setIamPolicy`,
        {
          method: "POST",
          body: JSON.stringify({
            policy: {
              version: 3,
              bindings,
              ...(typeof policy.etag === "string" ? { etag: policy.etag } : {}),
            },
          }),
        },
      );
      return;
    } catch (error) {
      if (
        error instanceof GcpUpstreamRequestError
        && error.iamServiceAccountPropagationPending
      ) {
        if (attempt === 11) {
          throw new ProviderRequestError(
            "gcpCloudSql",
            "새 Google Cloud 서비스 계정이 아직 IAM에 반영되지 않았습니다. 잠시 뒤 다시 시도하세요.",
            503,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        continue;
      }
      if (error instanceof ProviderRequestError && error.status === 409 && attempt < 2) {
        continue;
      }
      throw error;
    }
  }
}

async function removeIamPolicyBindings(
  credential: GcpSetupCredential,
  resourceUrl: string,
  removals: IamBinding[],
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const policy = (await googleRequest(
      credential,
      `${resourceUrl}:getIamPolicy`,
      {
        method: "POST",
        body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
      },
    ))!;
    let bindings = policyBindings(policy);
    let changed = false;
    for (const removal of removals) {
      for (const binding of bindings) {
        if (
          binding.role !== removal.role
          || (binding.condition?.expression ?? "")
            !== (removal.condition?.expression ?? "")
        ) {
          continue;
        }
        const nextMembers = binding.members.filter(
          (member) => !removal.members.includes(member),
        );
        if (nextMembers.length !== binding.members.length) {
          binding.members = nextMembers;
          changed = true;
        }
      }
    }
    if (!changed) return;
    bindings = bindings.filter((binding) => binding.members.length > 0);
    try {
      await googleRequest(
        credential,
        `${resourceUrl}:setIamPolicy`,
        {
          method: "POST",
          body: JSON.stringify({
            policy: {
              version: 3,
              bindings,
              ...(typeof policy.etag === "string" ? { etag: policy.etag } : {}),
            },
          }),
        },
      );
      return;
    } catch (error) {
      if (!(error instanceof ProviderRequestError) || error.status !== 409 || attempt === 2) {
        throw error;
      }
    }
  }
}

export async function grantTemporaryGcpSetupPermissions(input: {
  credential: GcpSetupCredential;
  projectId: string;
  setupId: string;
  check: GcpSetupPermissionCheck;
}): Promise<GcpTemporaryPermissionGrant | null> {
  if (input.check.missing.length === 0) return null;
  if (
    input.check.account !== input.credential.email
    || input.check.projectId !== input.projectId
    || !input.check.canAutoGrant
    || !/^[0-9a-f-]{36}$/i.test(input.setupId)
  ) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Google Cloud 프로젝트 IAM 관리자가 누락된 설정 역할을 승인해야 합니다.",
      403,
    );
  }
  const expiresAt = new Date(Date.now() + 15 * 60 * 1_000).toISOString();
  const condition = {
    title: `dopedb-setup-${input.setupId.slice(0, 8)}`,
    description: "Temporary DopeDB managed connection bootstrap",
    expression: `request.time < timestamp("${expiresAt}")`,
  };
  const member = `user:${input.credential.email}`;
  const bindings = input.check.missing.map((requirement) => ({
    role: requirement.role,
    members: [member],
    condition,
  }));
  const resourceUrl =
    `${RESOURCE_MANAGER_ORIGIN}/v1/projects/${encodeURIComponent(input.projectId)}`;
  const credential = quotaProjectCredential(input.credential, input.projectId);
  let applied = false;
  try {
    await updateIamPolicy(credential, resourceUrl, bindings);
    applied = true;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const confirmed = await checkGcpSetupPermissions(
        credential,
        input.projectId,
      );
      if (confirmed.missing.length === 0) {
        return { projectId: input.projectId, bindings };
      }
      if (attempt < 11) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
    throw new ProviderRequestError(
      "gcpCloudSql",
      "임시 Google Cloud 설정 권한이 제한 시간 안에 활성화되지 않았습니다.",
      409,
    );
  } catch (error) {
    if (applied) {
      try {
        await removeIamPolicyBindings(
          credential,
          resourceUrl,
          bindings,
        );
      } catch {
        throw new ProviderRequestError(
          "gcpCloudSql",
          "임시 Google Cloud 설정 권한을 바로 제거하지 못했습니다. 해당 권한은 15분 뒤 자동 만료됩니다.",
          409,
        );
      }
    }
    throw error;
  }
}

export async function revokeTemporaryGcpSetupPermissions(
  credential: GcpSetupCredential,
  grant: GcpTemporaryPermissionGrant,
) {
  const scopedCredential = quotaProjectCredential(credential, grant.projectId);
  await removeIamPolicyBindings(
    scopedCredential,
    `${RESOURCE_MANAGER_ORIGIN}/v1/projects/${encodeURIComponent(grant.projectId)}`,
    grant.bindings,
  );
}

async function grantWorkloadIdentity(
  credential: GcpSetupCredential,
  projectId: string,
  serviceAccountEmail: string,
  principal: string,
) {
  const resource = `${IAM_ORIGIN}/v1/projects/${encodeURIComponent(projectId)
  }/serviceAccounts/${encodeURIComponent(serviceAccountEmail)}`;
  await updateIamPolicy(credential, resource, [{
    role: "roles/iam.workloadIdentityUser",
    members: [principal],
  }]);
}

async function grantTokenCreator(
  credential: GcpSetupCredential,
  projectId: string,
  serviceAccountEmail: string,
) {
  const resource = `${IAM_ORIGIN}/v1/projects/${encodeURIComponent(projectId)
  }/serviceAccounts/${encodeURIComponent(serviceAccountEmail)}`;
  const binding = {
    role: "roles/iam.serviceAccountTokenCreator",
    members: [`user:${credential.email}`],
  };
  await updateIamPolicy(credential, resource, [binding]);
  return binding;
}

async function grantCloudSqlRoles(
  credential: GcpSetupCredential,
  input: GcpCloudBootstrapInput,
  readEmail: string,
  writeEmail: string | null,
  fingerprint: string,
) {
  const target = `projects/${input.projectId}/instances/${input.instanceId}`;
  const expression = `resource.service == 'sqladmin.googleapis.com' && (resource.name == '${target}' || resource.name.startsWith('${target}/'))`;
  const condition = {
    title: `dopedb-${fingerprint}`,
    description: "DopeDB managed access restricted to one Cloud SQL instance",
    expression,
  };
  const additions: IamBinding[] = [
    {
      role: "roles/cloudsql.client",
      members: [`serviceAccount:${readEmail}`],
      condition,
    },
    {
      role: "roles/cloudsql.instanceUser",
      members: [`serviceAccount:${readEmail}`],
      condition,
    },
    {
      role: "roles/cloudsql.viewer",
      members: [`serviceAccount:${readEmail}`],
      condition,
    },
    ...(writeEmail ? [
      {
        role: "roles/cloudsql.client",
        members: [`serviceAccount:${writeEmail}`],
        condition,
      },
      {
        role: "roles/cloudsql.instanceUser",
        members: [`serviceAccount:${writeEmail}`],
        condition,
      },
    ] : []),
  ];
  await updateIamPolicy(
    credential,
    `${RESOURCE_MANAGER_ORIGIN}/v1/projects/${encodeURIComponent(input.projectId)}`,
    additions,
  );
}

function bootstrapProjectBindings(
  input: GcpCloudBootstrapInput,
  serviceAccountEmail: string,
  fingerprint: string,
): IamBinding[] {
  const target = `projects/${input.projectId}/instances/${input.instanceId}`;
  const condition = {
    title: `dopedb-bootstrap-${fingerprint}`,
    description: "Temporary DopeDB database privilege bootstrap",
    expression:
      `resource.service == 'sqladmin.googleapis.com' && (resource.name == '${target}' || resource.name.startsWith('${target}/'))`,
  };
  return [
    {
      role: "roles/cloudsql.instanceUser",
      members: [`serviceAccount:${serviceAccountEmail}`],
      condition,
    },
    {
      role: "roles/cloudsql.client",
      members: [`serviceAccount:${serviceAccountEmail}`],
      condition,
    },
  ];
}

async function grantBootstrapProjectAccess(
  credential: GcpSetupCredential,
  input: GcpCloudBootstrapInput,
  serviceAccountEmail: string,
  fingerprint: string,
) {
  const bindings = bootstrapProjectBindings(
    input,
    serviceAccountEmail,
    fingerprint,
  );
  await updateIamPolicy(
    credential,
    `${RESOURCE_MANAGER_ORIGIN}/v1/projects/${encodeURIComponent(input.projectId)}`,
    bindings,
  );
  return bindings;
}

function databaseFlag(
  details: JsonObject,
  engine: "postgres" | "mysql",
) {
  const settings = details.settings && typeof details.settings === "object"
    && !Array.isArray(details.settings)
    ? details.settings as JsonObject
    : null;
  const flags = settings && Array.isArray(settings.databaseFlags)
    ? settings.databaseFlags.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const row = value as JsonObject;
      return typeof row.name === "string" && typeof row.value === "string"
        ? [{ name: row.name, value: row.value }]
        : [];
    })
    : [];
  const name = engine === "postgres"
    ? "cloudsql.iam_authentication"
    : "cloudsql_iam_authentication";
  return {
    settings,
    flags,
    name,
    enabled: flags.some((flag) => (
      flag.name === name
      && ["on", "true", "1"].includes(flag.value.toLowerCase())
    )),
  };
}

async function instanceDetails(
  credential: GcpSetupCredential,
  projectId: string,
  instanceId: string,
) {
  return (await googleRequest(
    credential,
    `${SQL_ADMIN_ORIGIN}/projects/${encodeURIComponent(projectId)}/instances/${
      encodeURIComponent(instanceId)
    }`,
  ))!;
}

async function ensureEnvironmentClassification(
  credential: GcpSetupCredential,
  input: GcpCloudBootstrapInput,
  classification: "production" | "development",
) {
  const desiredProduction = classification === "production";
  const details = await instanceDetails(
    credential,
    input.projectId,
    input.instanceId,
  );
  const currentProduction = gcpCloudSqlProduction(details);
  if (currentProduction !== "unknown") {
    if (currentProduction !== desiredProduction) {
      throw new ProviderRequestError(
        "gcpCloudSql",
        "Cloud SQL environment classification changed during setup",
        409,
      );
    }
    return currentProduction;
  }
  const settings = details.settings && typeof details.settings === "object"
    && !Array.isArray(details.settings)
    ? details.settings as JsonObject
    : null;
  if (!settings || typeof settings.settingsVersion !== "string") {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Cloud SQL settings version is unavailable",
      409,
    );
  }
  const currentLabels = settings.userLabels
    && typeof settings.userLabels === "object"
    && !Array.isArray(settings.userLabels)
    ? settings.userLabels as JsonObject
    : {};
  let operation: JsonObject;
  try {
    operation = (await googleRequest(
      credential,
      `${SQL_ADMIN_ORIGIN}/projects/${encodeURIComponent(input.projectId)}/instances/${
        encodeURIComponent(input.instanceId)
      }`,
      {
        method: "PATCH",
        body: JSON.stringify({
          settings: {
            settingsVersion: settings.settingsVersion,
            userLabels: {
              ...currentLabels,
              environment: classification,
            },
          },
        }),
      },
    ))!;
  } catch (error) {
    if (error instanceof ProviderRequestError && error.status === 403) {
      throw new ProviderRequestError(
        "gcpCloudSql",
        "The Google account needs Cloud SQL Admin permission to classify this instance",
        403,
      );
    }
    throw error;
  }
  await waitSqlOperation(credential, input.projectId, operation);
  const confirmed = await instanceDetails(
    credential,
    input.projectId,
    input.instanceId,
  );
  if (gcpCloudSqlProduction(confirmed) !== desiredProduction) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Cloud SQL environment classification was not applied",
      409,
    );
  }
  return desiredProduction;
}

async function enableIamAuthentication(
  credential: GcpSetupCredential,
  input: GcpCloudBootstrapInput,
  engine: "postgres" | "mysql",
  details: JsonObject,
) {
  const current = databaseFlag(details, engine);
  if (current.enabled) return false;
  if (!input.approveInstanceRestart) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Approve the possible Cloud SQL restart before enabling IAM authentication",
      409,
    );
  }
  if (!current.settings || typeof current.settings.settingsVersion !== "string") {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Cloud SQL settings version is unavailable",
      409,
    );
  }
  const flags = [
    ...current.flags.filter((flag) => flag.name !== current.name),
    { name: current.name, value: "on" },
  ];
  const operation = (await googleRequest(
    credential,
    `${SQL_ADMIN_ORIGIN}/projects/${encodeURIComponent(input.projectId)}/instances/${
      encodeURIComponent(input.instanceId)
    }`,
    {
      method: "PATCH",
      body: JSON.stringify({
        settings: {
          settingsVersion: current.settings.settingsVersion,
          databaseFlags: flags,
        },
      }),
    },
  ))!;
  await waitSqlOperation(credential, input.projectId, operation);
  return true;
}

async function ensureDatabaseUser(
  credential: GcpSetupCredential,
  projectId: string,
  instanceId: string,
  email: string,
  engine: "postgres" | "mysql",
  databaseRoles: string[] = [],
) {
  const base = `${SQL_ADMIN_ORIGIN}/projects/${encodeURIComponent(projectId)
  }/instances/${encodeURIComponent(instanceId)}`;
  const users = (await googleRequest(credential, `${base}/users`))!;
  const rows = Array.isArray(users.items) ? users.items : [];
  const databaseUsername = gcpDatabaseUsername(email, engine);
  const existing = rows.find((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as JsonObject;
    return typeof row.name === "string"
      && (
        row.name.toLowerCase() === email.toLowerCase()
        || row.name.toLowerCase() === databaseUsername.toLowerCase()
        || `${row.name}.gserviceaccount.com`.toLowerCase() === email.toLowerCase()
      );
  });
  if (existing) {
    if ((existing as JsonObject).type !== "CLOUD_IAM_SERVICE_ACCOUNT") {
      throw new ProviderRequestError(
        "gcpCloudSql",
        "A database user name is already used by a non-IAM account",
        409,
      );
    }
    return existing as JsonObject;
  }
  const operation = (await googleRequest(
    credential,
    `${base}/users`,
    {
      method: "POST",
      body: JSON.stringify({
        name: engine === "postgres" ? databaseUsername : email,
        type: "CLOUD_IAM_SERVICE_ACCOUNT",
        ...(databaseRoles.length > 0 ? { databaseRoles } : {}),
      }),
    },
  ))!;
  await waitSqlOperation(credential, projectId, operation);
  const refreshed = (await googleRequest(credential, `${base}/users`))!;
  const created = (Array.isArray(refreshed.items) ? refreshed.items : []).find((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row = value as JsonObject;
    return row.type === "CLOUD_IAM_SERVICE_ACCOUNT"
      && typeof row.name === "string"
      && (
        row.name.toLowerCase() === email.toLowerCase()
        || row.name.toLowerCase() === databaseUsername.toLowerCase()
        || `${row.name}.gserviceaccount.com`.toLowerCase() === email.toLowerCase()
      );
  });
  if (!created) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Cloud SQL did not create the IAM database user",
      502,
    );
  }
  return created as JsonObject;
}

async function setDatabaseRoles(
  credential: GcpSetupCredential,
  projectId: string,
  instanceId: string,
  user: JsonObject,
  roles: string[],
) {
  if (
    typeof user.name !== "string"
    || user.type !== "CLOUD_IAM_SERVICE_ACCOUNT"
    || roles.length === 0
    || roles.some((role) => !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(role))
  ) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Invalid Cloud SQL database role assignment",
      409,
    );
  }
  const query = new URLSearchParams({
    name: user.name,
    host: typeof user.host === "string" ? user.host : "",
    revokeExistingRoles: "false",
  });
  for (const role of roles) query.append("databaseRoles", role);
  const operation = (await googleRequest(
    credential,
    `https://sqladmin.googleapis.com/v1/projects/${encodeURIComponent(projectId)
    }/instances/${encodeURIComponent(instanceId)}/users?${query}`,
    {
      method: "PUT",
      body: JSON.stringify({
        name: user.name,
        type: "CLOUD_IAM_SERVICE_ACCOUNT",
      }),
    },
  ))!;
  await waitSqlOperation(credential, projectId, operation);
}

async function databaseNames(
  credential: GcpSetupCredential,
  projectId: string,
  instanceId: string,
) {
  const body = (await googleRequest(
    credential,
    `${SQL_ADMIN_ORIGIN}/projects/${encodeURIComponent(projectId)}/instances/${
      encodeURIComponent(instanceId)
    }/databases`,
  ))!;
  if (typeof body.nextPageToken === "string") {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Cloud SQL database scope is too large to configure safely",
      409,
    );
  }
  const names = (Array.isArray(body.items) ? body.items : []).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const name = (value as JsonObject).name;
    return typeof name === "string" && name.length > 0 && name.length <= 128
      ? [name]
      : [];
  });
  if (names.length > 100) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Cloud SQL database scope is too large to configure safely",
      409,
    );
  }
  return names;
}

function dataApiState(details: JsonObject) {
  const settings = details.settings && typeof details.settings === "object"
    && !Array.isArray(details.settings)
    ? details.settings as JsonObject
    : null;
  if (!settings || typeof settings.settingsVersion !== "string") {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Cloud SQL settings version is unavailable",
      409,
    );
  }
  return {
    enabled: settings.dataApiAccess === "ALLOW_DATA_API",
    settingsVersion: settings.settingsVersion,
  };
}

async function setDataApiAccess(
  credential: GcpSetupCredential,
  projectId: string,
  instanceId: string,
  allow: boolean,
) {
  const details = await instanceDetails(credential, projectId, instanceId);
  const state = dataApiState(details);
  if (state.enabled === allow) return;
  const operation = (await googleRequest(
    credential,
    `${SQL_ADMIN_ORIGIN}/projects/${encodeURIComponent(projectId)}/instances/${
      encodeURIComponent(instanceId)
    }`,
    {
      method: "PATCH",
      body: JSON.stringify({
        settings: {
          settingsVersion: state.settingsVersion,
          dataApiAccess: allow ? "ALLOW_DATA_API" : "DISALLOW_DATA_API",
        },
      }),
    },
  ))!;
  await waitSqlOperation(credential, projectId, operation);
}

async function bootstrapAccessToken(
  credential: GcpSetupCredential,
  serviceAccountEmail: string,
) {
  const startedAt = Date.now();
  for (;;) {
    try {
      const body = (await googleRequest(
        credential,
        `${IAM_CREDENTIALS_ORIGIN}/v1/projects/-/serviceAccounts/${
          encodeURIComponent(serviceAccountEmail)
        }:generateAccessToken`,
        {
          method: "POST",
          body: JSON.stringify({
            scope: ["https://www.googleapis.com/auth/cloud-platform"],
            lifetime: "600s",
          }),
        },
      ))!;
      if (
        typeof body.accessToken !== "string"
        || body.accessToken.length < 32
        || body.accessToken.length > 8_192
        || typeof body.expireTime !== "string"
        || Date.parse(body.expireTime) <= Date.now() + 60_000
      ) {
        throw new ProviderRequestError(
          "gcpCloudSql",
          "Google Cloud returned an unsafe bootstrap token",
          502,
        );
      }
      return {
        accessToken: body.accessToken,
        email: serviceAccountEmail,
        expiresAt: body.expireTime,
      } satisfies GcpSetupCredential;
    } catch (error) {
      if (
        !(error instanceof ProviderRequestError)
        || ![403, 404, 502, 503].includes(error.status)
      ) {
        throw error;
      }
      if (Date.now() - startedAt >= TOKEN_CREATOR_PROPAGATION_TIMEOUT_MS) {
        throw new ProviderRequestError(
          "gcpCloudSql",
          "Google Cloud IAM Credentials 권한 반영이 지연되고 있습니다. 잠시 뒤 다시 시도하세요.",
          503,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  }
}

function responseStatusFailed(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const status = value as JsonObject;
  return typeof status.code === "number" && status.code !== 0;
}

async function executeSql(
  credential: GcpSetupCredential,
  projectId: string,
  instanceId: string,
  database: string,
  statement: string,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const body = (await googleRequest(
        credential,
        `${SQL_ADMIN_ORIGIN}/projects/${encodeURIComponent(projectId)}/instances/${
          encodeURIComponent(instanceId)
        }/executeSql`,
        {
          method: "POST",
          body: JSON.stringify({
            database,
            sqlStatement: statement,
            partialResultMode: "FAIL_PARTIAL_RESULT",
            autoIamAuthn: true,
          }),
        },
      ))!;
      const results = Array.isArray(body.results) ? body.results : [];
      if (
        responseStatusFailed(body.status)
        || results.some((value) => (
          value
          && typeof value === "object"
          && !Array.isArray(value)
          && (
            (value as JsonObject).partialResult === true
            || responseStatusFailed((value as JsonObject).status)
          )
        ))
      ) {
        throw new ProviderRequestError(
          "gcpCloudSql",
          "Cloud SQL rejected the least-privilege database grant",
          409,
        );
      }
      return;
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof ProviderRequestError)
        || ![403, 409, 503].includes(error.status)
        || attempt === 9
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw lastError;
}

function pgIdentifier(value: string) {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function pgLiteral(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

function mysqlIdentifier(value: string) {
  return `\`${value.replaceAll("`", "``")}\``;
}

function mysqlLiteral(value: string) {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

async function configurePostgresPrivileges(input: {
  control: GcpSetupCredential;
  executor: GcpSetupCredential;
  projectId: string;
  instanceId: string;
  databaseVersion: string;
  databases: string[];
  readUser: JsonObject;
  writeUser: JsonObject | null;
  fingerprint: string;
}) {
  const version = Number(/^POSTGRES_(\d+)/.exec(input.databaseVersion)?.[1] ?? "0");
  if (version >= 14) {
    await setDatabaseRoles(
      input.control,
      input.projectId,
      input.instanceId,
      input.readUser,
      ["pg_read_all_data"],
    );
    if (input.writeUser) {
      await setDatabaseRoles(
        input.control,
        input.projectId,
        input.instanceId,
        input.writeUser,
        ["pg_read_all_data", "pg_write_all_data"],
      );
    }
    if (typeof input.readUser.name !== "string") {
      throw new ProviderRequestError(
        "gcpCloudSql",
        "Cloud SQL IAM username is unavailable",
        409,
      );
    }
    const writeName = typeof input.writeUser?.name === "string"
      ? input.writeUser.name
      : null;
    for (const database of input.databases.filter(
      (name) => !["template0", "template1"].includes(name),
    )) {
      await executeSql(
        input.executor,
        input.projectId,
        input.instanceId,
        database,
        `GRANT CONNECT ON DATABASE ${pgIdentifier(database)} TO ${
          pgIdentifier(input.readUser.name)
        };`
          + (writeName
            ? ` GRANT CONNECT ON DATABASE ${pgIdentifier(database)} TO ${
                pgIdentifier(writeName)
              };`
            : ""),
      );
    }
    return;
  }
  const readRole = `dopedb_r_${input.fingerprint}`;
  const writeRole = `dopedb_w_${input.fingerprint}`;
  const bootstrapDatabase = input.databases.includes("postgres")
    ? "postgres"
    : input.databases[0];
  if (!bootstrapDatabase) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Cloud SQL has no database to configure",
      409,
    );
  }
  await executeSql(
    input.executor,
    input.projectId,
    input.instanceId,
    bootstrapDatabase,
    `DO $dopedb$ BEGIN `
      + `IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${pgLiteral(readRole)}) THEN `
      + `EXECUTE 'CREATE ROLE ${pgIdentifier(readRole)} NOLOGIN'; END IF; `
      + (input.writeUser
        ? `IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${pgLiteral(writeRole)}) THEN `
          + `EXECUTE 'CREATE ROLE ${pgIdentifier(writeRole)} NOLOGIN'; END IF; `
          + `GRANT ${pgIdentifier(readRole)} TO ${pgIdentifier(writeRole)}; `
        : "")
      + "END $dopedb$;",
  );
  for (const database of input.databases.filter(
    (name) => !["template0", "template1"].includes(name),
  )) {
    const schemaGrants = [
      `EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, ${pgLiteral(readRole)});`,
      `EXECUTE format('GRANT SELECT ON ALL TABLES IN SCHEMA %I TO %I', schema_name, ${pgLiteral(readRole)});`,
      `EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', schema_name, ${pgLiteral(readRole)});`,
      ...(input.writeUser ? [
        `EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', schema_name, ${pgLiteral(writeRole)});`,
        `EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', schema_name, ${pgLiteral(writeRole)});`,
        `EXECUTE format('GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA %I TO %I', schema_name, ${pgLiteral(writeRole)});`,
      ] : []),
    ].join(" ");
    await executeSql(
      input.executor,
      input.projectId,
      input.instanceId,
      database,
      `GRANT CONNECT ON DATABASE ${pgIdentifier(database)} TO ${pgIdentifier(readRole)}; `
        + (input.writeUser
          ? `GRANT CONNECT ON DATABASE ${pgIdentifier(database)} TO ${pgIdentifier(writeRole)}; `
          : "")
        + "DO $dopedb$ DECLARE schema_name text; BEGIN "
        + "FOR schema_name IN SELECT schema_name FROM information_schema.schemata "
        + "WHERE schema_name <> 'information_schema' AND schema_name NOT LIKE 'pg_%' LOOP "
        + schemaGrants
        + " END LOOP; END $dopedb$;",
    );
  }
  await setDatabaseRoles(
    input.control,
    input.projectId,
    input.instanceId,
    input.readUser,
    [readRole],
  );
  if (input.writeUser) {
    await setDatabaseRoles(
      input.control,
      input.projectId,
      input.instanceId,
      input.writeUser,
      [writeRole],
    );
  }
}

async function configureMysqlPrivileges(input: {
  executor: GcpSetupCredential;
  projectId: string;
  instanceId: string;
  databases: string[];
  readUser: JsonObject;
  writeUser: JsonObject | null;
}) {
  const account = (user: JsonObject) => {
    if (typeof user.name !== "string") {
      throw new ProviderRequestError(
        "gcpCloudSql",
        "Cloud SQL IAM username is unavailable",
        409,
      );
    }
    return `${mysqlLiteral(user.name)}@${mysqlLiteral(
      typeof user.host === "string" && user.host ? user.host : "%",
    )}`;
  };
  for (const database of input.databases.filter(
    (name) => !["information_schema", "mysql", "performance_schema", "sys"].includes(name),
  )) {
    await executeSql(
      input.executor,
      input.projectId,
      input.instanceId,
      database,
      `GRANT SELECT ON ${mysqlIdentifier(database)}.* TO ${account(input.readUser)};`
        + (input.writeUser
          ? ` GRANT SELECT, INSERT, UPDATE, DELETE ON ${mysqlIdentifier(database)}.* TO ${
              account(input.writeUser)
            };`
          : ""),
    );
  }
}

async function deleteDatabaseUser(
  credential: GcpSetupCredential,
  projectId: string,
  instanceId: string,
  user: JsonObject,
) {
  if (typeof user.name !== "string") return;
  const query = new URLSearchParams({
    name: user.name,
    host: typeof user.host === "string" ? user.host : "",
  });
  const operation = (await googleRequest(
    credential,
    `${SQL_ADMIN_ORIGIN}/projects/${encodeURIComponent(projectId)}/instances/${
      encodeURIComponent(instanceId)
    }/users?${query}`,
    { method: "DELETE" },
  ))!;
  await waitSqlOperation(credential, projectId, operation);
}

async function deleteServiceAccount(
  credential: GcpSetupCredential,
  projectId: string,
  email: string,
) {
  await googleRequest(
    credential,
    `${IAM_ORIGIN}/v1/projects/${encodeURIComponent(projectId)
    }/serviceAccounts/${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );
}

async function configureDatabasePrivileges(input: {
  credential: GcpSetupCredential;
  configuration: GcpCloudBootstrapInput;
  engine: "postgres" | "mysql";
  databaseVersion: string;
  readUser: JsonObject;
  writeUser: JsonObject | null;
  fingerprint: string;
}) {
  const databases = await databaseNames(
    input.credential,
    input.configuration.projectId,
    input.configuration.instanceId,
  );
  const details = await instanceDetails(
    input.credential,
    input.configuration.projectId,
    input.configuration.instanceId,
  );
  const dataApiInitiallyEnabled = dataApiState(details).enabled;
  const bootstrapDescription =
    `dopedb-bootstrap:v1:${input.fingerprint}:${input.configuration.instanceId}`;
  const bootstrapEmail = await ensureServiceAccount(
    input.credential,
    input.configuration.projectId,
    serviceAccountId("bootstrap", input.fingerprint),
    bootstrapDescription,
    `DopeDB bootstrap · ${input.configuration.instanceId}`.slice(0, 100),
  );
  const serviceAccountUrl = `${IAM_ORIGIN}/v1/projects/${
    encodeURIComponent(input.configuration.projectId)
  }/serviceAccounts/${encodeURIComponent(bootstrapEmail)}`;
  let projectBindings: IamBinding[] = [];
  let tokenBinding: IamBinding | null = null;
  let bootstrapUser: JsonObject | null = null;
  let failure: unknown = null;
  try {
    tokenBinding = await grantTokenCreator(
      input.credential,
      input.configuration.projectId,
      bootstrapEmail,
    );
    projectBindings = await grantBootstrapProjectAccess(
      input.credential,
      input.configuration,
      bootstrapEmail,
      input.fingerprint,
    );
    await setDataApiAccess(
      input.credential,
      input.configuration.projectId,
      input.configuration.instanceId,
      true,
    );
    bootstrapUser = await ensureDatabaseUser(
      input.credential,
      input.configuration.projectId,
      input.configuration.instanceId,
      bootstrapEmail,
      input.engine,
      ["cloudsqlsuperuser"],
    );
    await setDatabaseRoles(
      input.credential,
      input.configuration.projectId,
      input.configuration.instanceId,
      bootstrapUser,
      ["cloudsqlsuperuser"],
    );
    const executor = await bootstrapAccessToken(
      input.credential,
      bootstrapEmail,
    );
    if (input.engine === "postgres") {
      await configurePostgresPrivileges({
        control: input.credential,
        executor,
        projectId: input.configuration.projectId,
        instanceId: input.configuration.instanceId,
        databaseVersion: input.databaseVersion,
        databases,
        readUser: input.readUser,
        writeUser: input.writeUser,
        fingerprint: input.fingerprint,
      });
    } else {
      await configureMysqlPrivileges({
        executor,
        projectId: input.configuration.projectId,
        instanceId: input.configuration.instanceId,
        databases,
        readUser: input.readUser,
        writeUser: input.writeUser,
      });
    }
  } catch (error) {
    failure = error;
  }

  const cleanupFailures: unknown[] = [];
  if (bootstrapUser) {
    await deleteDatabaseUser(
      input.credential,
      input.configuration.projectId,
      input.configuration.instanceId,
      bootstrapUser,
    ).catch((error) => cleanupFailures.push(error));
  }
  if (!dataApiInitiallyEnabled) {
    await setDataApiAccess(
      input.credential,
      input.configuration.projectId,
      input.configuration.instanceId,
      false,
    ).catch((error) => cleanupFailures.push(error));
  }
  if (projectBindings.length > 0) {
    await removeIamPolicyBindings(
      input.credential,
      `${RESOURCE_MANAGER_ORIGIN}/v1/projects/${
        encodeURIComponent(input.configuration.projectId)
      }`,
      projectBindings,
    ).catch((error) => cleanupFailures.push(error));
  }
  if (tokenBinding) {
    await removeIamPolicyBindings(
      input.credential,
      serviceAccountUrl,
      [tokenBinding],
    ).catch((error) => cleanupFailures.push(error));
  }
  await deleteServiceAccount(
    input.credential,
    input.configuration.projectId,
    bootstrapEmail,
  ).catch((error) => cleanupFailures.push(error));
  if (cleanupFailures.length > 0) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Temporary Cloud SQL privilege bootstrap cleanup failed. Retry before using the connection.",
      409,
    );
  }
  if (failure) throw failure;
  return databases;
}

async function waitForFederation(
  credential: GcpCloudSqlCredential,
  oidcToken: string,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await validateGcpCloudSqlCredential(credential, oidcToken);
      return;
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof ProviderRequestError)
        || ![403, 409, 502, 503].includes(error.status)
      ) {
        throw error;
      }
      if (attempt < 19) {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
      }
    }
  }
  throw lastError;
}

export async function bootstrapGcpCloudSql(input: {
  credential: GcpSetupCredential;
  oidcToken: string;
  configuration: GcpCloudBootstrapInput;
}): Promise<GcpCloudBootstrapResult> {
  const configuration = input.configuration;
  safeSegment(
    configuration.workspaceId,
    /^[0-9a-f]{8}-[0-9a-f-]{27,35}$/i,
    "Invalid workspace",
  );
  safeSegment(
    configuration.projectId,
    /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/,
    "Invalid Google Cloud project",
  );
  safeSegment(
    configuration.projectNumber,
    /^[1-9][0-9]{5,19}$/,
    "Invalid Google Cloud project number",
  );
  safeSegment(
    configuration.instanceId,
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,97}$/,
    "Invalid Cloud SQL instance",
  );
  const credential = quotaProjectCredential(
    input.credential,
    configuration.projectId,
  );
  const identity = await verifyVercelOidcToken(input.oidcToken);
  await confirmProject(
    credential,
    configuration.projectId,
    configuration.projectNumber,
  );
  const instances = await listGcpOAuthInstances(
    credential,
    configuration.projectId,
  );
  const selected = instances.find((item) => item.id === configuration.instanceId);
  if (!selected || !selected.ready) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "The selected Cloud SQL instance is not runnable",
      409,
    );
  }
  let selectedProduction = selected.production;
  if (selectedProduction === "unknown" && !configuration.environmentClassification) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Choose a production or development classification before connecting this instance",
      409,
    );
  }
  const requestedProduction = configuration.environmentClassification === "production";
  if (
    (
      selectedProduction === true
      || (selectedProduction === "unknown" && requestedProduction)
    )
    && !configuration.approveProduction
  ) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Production Cloud SQL access requires explicit administrator approval",
      409,
    );
  }
  if (configuration.environmentClassification) {
    selectedProduction = await ensureEnvironmentClassification(
      credential,
      configuration,
      configuration.environmentClassification,
    );
  }
  if (selectedProduction === "unknown") {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Cloud SQL environment classification could not be confirmed",
      409,
    );
  }
  await enableServices(credential, configuration.projectNumber);
  await ensurePool(credential, configuration.projectNumber);
  await ensureProvider(credential, configuration.projectNumber, identity);
  const fingerprint = setupFingerprint(configuration);
  const description = `dopedb-managed:v1:${fingerprint}:${configuration.instanceId}`;
  const readEmail = await ensureServiceAccount(
    credential,
    configuration.projectId,
    serviceAccountId("read", fingerprint),
    description,
    `DopeDB read · ${configuration.instanceId}`.slice(0, 100),
  );
  const writeEmail = configuration.writeAccess
    ? await ensureServiceAccount(
        credential,
        configuration.projectId,
        serviceAccountId("write", fingerprint),
        description,
        `DopeDB write · ${configuration.instanceId}`.slice(0, 100),
      )
    : null;
  const principal = `principal://iam.googleapis.com/projects/${
    configuration.projectNumber
  }/locations/global/workloadIdentityPools/${POOL_ID}/subject/${
    identity.subject
  }`;
  await Promise.all([
    grantWorkloadIdentity(
      credential,
      configuration.projectId,
      readEmail,
      principal,
    ),
    ...(writeEmail ? [
      grantWorkloadIdentity(
        credential,
        configuration.projectId,
        writeEmail,
        principal,
      ),
    ] : []),
  ]);
  await grantCloudSqlRoles(
    credential,
    configuration,
    readEmail,
    writeEmail,
    fingerprint,
  );
  const details = await instanceDetails(
    credential,
    configuration.projectId,
    configuration.instanceId,
  );
  const engine = gcpCloudSqlEngine(details.databaseVersion);
  if (!engine || engine !== selected.engine) {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Cloud SQL engine changed during setup",
      409,
    );
  }
  const iamAuthenticationChanged = await enableIamAuthentication(
    credential,
    configuration,
    engine,
    details,
  );
  const readDatabaseUser = await ensureDatabaseUser(
    credential,
    configuration.projectId,
    configuration.instanceId,
    readEmail,
    engine,
  );
  let writeDatabaseUser: JsonObject | null = null;
  if (writeEmail) {
    writeDatabaseUser = await ensureDatabaseUser(
      credential,
      configuration.projectId,
      configuration.instanceId,
      writeEmail,
      engine,
    );
  }
  if (typeof details.databaseVersion !== "string") {
    throw new ProviderRequestError(
      "gcpCloudSql",
      "Cloud SQL database version is unavailable",
      409,
    );
  }
  const configuredDatabases = await configureDatabasePrivileges({
    credential,
    configuration,
    engine,
    databaseVersion: details.databaseVersion,
    readUser: readDatabaseUser,
    writeUser: writeDatabaseUser,
    fingerprint,
  });
  const durableConfiguration = parseGcpCloudSqlCredential({
    projectId: configuration.projectId,
    projectNumber: configuration.projectNumber,
    workloadIdentityPoolId: POOL_ID,
    workloadIdentityProviderId: PROVIDER_ID,
    instanceId: configuration.instanceId,
    readServiceAccountEmail: readEmail,
    writeServiceAccountEmail: writeEmail,
    databaseNames: configuredDatabases,
    dedicatedServiceAccountsConfirmed: true,
    instanceScopedIamConfirmed: true,
  });
  await waitForFederation(durableConfiguration, input.oidcToken);
  return {
    configuration: durableConfiguration,
    engine,
    production: selectedProduction,
    iamAuthenticationChanged,
    databaseUsers: {
      read: readEmail,
      write: writeEmail,
    },
  };
}
