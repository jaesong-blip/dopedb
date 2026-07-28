import type {
  ConnectionProfile,
  DriverDescriptor,
} from "./domain";

export type ConnectionDiagnosticCode =
  | "nameRequired"
  | "duplicateName"
  | "hostRequired"
  | "hostInvalid"
  | "portInvalid"
  | "sqliteFileRequired"
  | "mongoDatabaseRequired"
  | "driverCatalogUnavailable"
  | "driverUnavailable"
  | "driverInstallRequired";

export type ConnectionDiagnostic = {
  id: string;
  code: ConnectionDiagnosticCode;
  tone: "warning" | "danger";
  tab: "general";
  fieldId: string | null;
};

function issue(
  code: ConnectionDiagnosticCode,
  tone: ConnectionDiagnostic["tone"],
  fieldId: string | null,
): ConnectionDiagnostic {
  return {
    id: `connection-${code}`,
    code,
    tone,
    tab: "general",
    fieldId,
  };
}

export function diagnoseConnection(
  profile: ConnectionProfile,
  savedConnections: readonly ConnectionProfile[],
  drivers: readonly DriverDescriptor[],
  driverCatalogFailed: boolean,
  driverCatalogPending: boolean,
): ConnectionDiagnostic[] {
  const diagnostics: ConnectionDiagnostic[] = [];
  const name = profile.name.trim();

  if (!name) {
    diagnostics.push(issue("nameRequired", "danger", "connection-name"));
  } else if (
    savedConnections.some(
      (candidate) =>
        candidate.id !== profile.id &&
        candidate.name.trim().localeCompare(name, undefined, {
          sensitivity: "accent",
        }) === 0,
    )
  ) {
    diagnostics.push(
      issue("duplicateName", "warning", "connection-name"),
    );
  }

  if (profile.engine === "sqlite") {
    if (!profile.database.trim()) {
      diagnostics.push(
        issue(
          "sqliteFileRequired",
          "danger",
          "connection-database",
        ),
      );
    }
  } else {
    const host = profile.host.trim();
    if (!host) {
      diagnostics.push(
        issue("hostRequired", "danger", "connection-host"),
      );
    } else if (
      host.includes("://") ||
      host.split(",").some((part) => /\s/u.test(part))
    ) {
      diagnostics.push(
        issue("hostInvalid", "danger", "connection-host"),
      );
    }

    const mongoSrv =
      profile.engine === "mongodb" &&
      profile.extraParams.srv === "true";
    if (
      !mongoSrv &&
      (!Number.isInteger(profile.port) ||
        profile.port < 1 ||
        profile.port > 65_535)
    ) {
      diagnostics.push(
        issue("portInvalid", "danger", "connection-port"),
      );
    }
    if (
      profile.engine === "mongodb" &&
      !profile.database.trim()
    ) {
      diagnostics.push(
        issue(
          "mongoDatabaseRequired",
          "danger",
          "connection-database",
        ),
      );
    }
  }

  if (driverCatalogFailed) {
    diagnostics.push(
      issue(
        "driverCatalogUnavailable",
        "danger",
        "connection-driver",
      ),
    );
    return diagnostics;
  }
  if (driverCatalogPending) return diagnostics;

  const compatibleDrivers = drivers.filter(
    (driver) =>
      driver.engine === profile.engine &&
      (profile.provider === "auto" ||
        driver.supportedProviders.includes(profile.provider)),
  );
  const selectedDriver = profile.driverId
    ? compatibleDrivers.find(
        (driver) => driver.id === profile.driverId,
      )
    : compatibleDrivers.find((driver) => driver.recommended) ??
      compatibleDrivers[0];

  if (!selectedDriver) {
    diagnostics.push(
      issue("driverUnavailable", "danger", "connection-driver"),
    );
  } else if (selectedDriver.installState !== "installed") {
    diagnostics.push(
      issue(
        "driverInstallRequired",
        "danger",
        "connection-driver",
      ),
    );
  }

  return diagnostics;
}
