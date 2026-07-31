// Public catalog of provider adapters that can complete discovery, read-only
// import, and managed credential issuance today. Undecided providers do not get
// placeholders or capability claims; DQ-18 owns any future expansion.

export const providerKinds = [
  "gcpCloudSql",
  "neon",
  "planetScale",
] as const;

export type ProviderKind = (typeof providerKinds)[number];

export interface ProviderDescriptor {
  id: ProviderKind;
  name: string;
  supportedEngines: readonly string[];
  leaseSeconds: number | null;
  setupKind: "oauth" | "apiKey";
  resourceLevels: readonly [
    { key: string; kind: string; label: string },
    { key: string; kind: string; label: string },
    { key: string; kind: string; label: string },
  ];
  note: string;
}

export const providerCatalog: readonly ProviderDescriptor[] = [
  {
    id: "planetScale",
    name: "PlanetScale",
    supportedEngines: ["postgres", "mysql"],
    leaseSeconds: 15 * 60,
    setupKind: "oauth",
    resourceLevels: [
      { key: "organization", kind: "organizations", label: "조직" },
      { key: "database", kind: "databases", label: "DB" },
      { key: "branch", kind: "branches", label: "브랜치" },
    ],
    note: "OAuth로 연결하고 구성원별 TTL 역할 또는 비밀번호를 발급합니다.",
  },
  {
    id: "gcpCloudSql",
    name: "GCP Cloud SQL",
    supportedEngines: ["postgres", "mysql"],
    leaseSeconds: 15 * 60,
    setupKind: "oauth",
    resourceLevels: [
      { key: "project", kind: "projects", label: "프로젝트" },
      { key: "instance", kind: "instances", label: "인스턴스" },
      { key: "database", kind: "databases", label: "DB" },
    ],
    note: "Google 로그인 후 프로젝트와 인스턴스만 선택하면 15분 IAM 접근을 자동 구성합니다.",
  },
  {
    id: "neon",
    name: "Neon",
    supportedEngines: ["postgres"],
    leaseSeconds: 15 * 60,
    setupKind: "apiKey",
    resourceLevels: [
      { key: "project", kind: "projects", label: "프로젝트" },
      { key: "branch", kind: "branches", label: "브랜치" },
      { key: "database", kind: "databases", label: "DB" },
    ],
    note: "프로젝트 범위 API 키로 15분 제한 역할을 만들고 만료·회수합니다.",
  },
] as const;

export function isProviderKind(value: string): value is ProviderKind {
  return providerKinds.includes(value as ProviderKind);
}

export function providerDescriptor(provider: string) {
  return providerCatalog.find((item) => item.id === provider) ?? null;
}
