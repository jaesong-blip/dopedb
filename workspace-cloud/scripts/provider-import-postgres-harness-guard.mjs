export const DEFAULT_DATABASE_URL_ENV_NAMES = Object.freeze([
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "DATABASE_URL_POOLED",
  "DIRECT_URL",
  "POSTGRES_URL",
  "POSTGRES_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NO_SSL",
  "NEON_DATABASE_URL",
  "NEON_DATABASE_URL_UNPOOLED",
]);

function decoded(value, field) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Invalid percent encoding in ${field}`);
  }
}

// Credentials and pooling host aliases do not make a database isolated. Compare
// the logical host/port/database tuple against every normal application URL.
export function canonicalLogicalDatabaseTarget(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Invalid PostgreSQL URL");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Harness database URL must use PostgreSQL");
  }
  let hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const labels = hostname.split(".");
  if (labels[0]?.endsWith("-pooler")) {
    labels[0] = labels[0].slice(0, -"-pooler".length);
    hostname = labels.join(".");
  }
  const username = decoded(url.username, "username");
  const database = decoded(url.pathname.replace(/^\//, ""), "database");
  if (!hostname || !username || !database) {
    throw new Error("Harness database URL must identify host, user, and database");
  }
  return JSON.stringify({ hostname, port: url.port || "5432", database });
}

export function validateHarnessEnvironment(environment) {
  const dedicatedUrl =
    environment.PROVIDER_IMPORT_TEST_DATABASE_URL?.trim() ?? "";
  const isolated =
    environment.PROVIDER_IMPORT_TEST_DATABASE_ISOLATED === "1";
  const sentinel =
    environment.PROVIDER_IMPORT_TEST_DATABASE_SENTINEL?.trim() ?? "";
  if (!dedicatedUrl || !isolated || sentinel.length < 16 || sentinel.length > 256) {
    throw new Error(
      "A dedicated URL, isolation confirmation, and sentinel are required",
    );
  }
  const dedicatedTarget = canonicalLogicalDatabaseTarget(dedicatedUrl);
  for (const name of DEFAULT_DATABASE_URL_ENV_NAMES) {
    const candidate = environment[name]?.trim();
    if (!candidate) continue;
    if (canonicalLogicalDatabaseTarget(candidate) === dedicatedTarget) {
      throw new Error(
        "The harness database resolves to a default application database",
      );
    }
  }
  return { dedicatedUrl, sentinel };
}
