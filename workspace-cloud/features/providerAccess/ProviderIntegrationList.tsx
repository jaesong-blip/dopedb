"use client";

import {
  ControlButton,
  ControlField,
  ControlInput,
  ControlLink,
} from "../../app/components/Controls";
import type { ProviderAccessController } from "./useProviderAccess";
import { useWorkspaceLocale } from "../../app/components/WorkspaceLocale";
import { workspaceMessages } from "../../lib/workspace-messages";
import { localizedIntegrationDisplayName } from "../../lib/workspace-provider-copy";

export function ProviderIntegrationList({
  controller,
}: {
  controller: ProviderAccessController;
}) {
  const locale = useWorkspaceLocale();
  const copy = workspaceMessages[locale].providerList;
  const common = workspaceMessages[locale].common;
  const {
    providers,
    integrations,
    managedConnections,
    setupProvider,
    neonConfiguration,
    mutation,
    beginConnect,
    connect,
    disconnect,
    setNeonConfiguration,
  } = controller;
  return (
    <div className="tw:grid tw:content-start tw:gap-7">
      <section className="tw:grid tw:gap-2">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-xs tw:text-foreground">
            {copy.connectedTitle}
          </strong>
          <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
            {copy.connectedDescription}
          </small>
        </div>
        <div className="tw:grid tw:border-t tw:border-border">
          {integrations.map((integration) => {
            const provider = providers.find(
              (item) => item.id === integration.provider,
            );
            const databaseCount = managedConnections.filter(
              (item) => item.integrationId === integration.id,
            ).length;
            return (
              <article
                className="tw:grid tw:min-h-[72px] tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-4 tw:border-b tw:border-border tw:py-3 tw:max-[640px]:grid-cols-1"
                key={integration.id}
              >
                <div className="tw:grid tw:min-w-0 tw:gap-1">
                  <span className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                    <strong className="tw:text-sm tw:text-foreground">
                      {localizedIntegrationDisplayName(
                        integration.displayName,
                        locale,
                      )}
                    </strong>
                    <span
                      className="tw:font-mono tw:text-2xs tw:uppercase tw:data-[status=active]:text-success tw:data-[status=reconnect_required]:text-danger"
                      data-status={integration.status}
                    >
                      {integration.status === "active"
                        ? copy.active
                        : common.reconnectRequired}
                    </span>
                  </span>
                  <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                    {locale === "ko"
                      ? `${copy.databases} ${databaseCount}${common.countSuffix}`
                      : `${databaseCount} ${copy.databases}`}
                    {" · "}{copy.lastChecked}{" "}
                    {new Date(integration.updatedAt).toLocaleString(
                      locale === "ko" ? "ko-KR" : "en-US",
                    )}
                  </small>
                  {integration.provider === "neon"
                    && integration.grantedScope?.includes(":personal:broad:") ? (
                      <small className="tw:text-2xs tw:leading-body tw:text-danger">
                        {copy.broadKeyWarning}
                      </small>
                    ) : null}
                </div>
                <div className="tw:flex tw:flex-wrap tw:justify-end tw:gap-2 tw:max-[640px]:justify-start">
                  {provider ? (
                    <ControlButton
                      disabled={!provider.configured || mutation !== ""}
                      onClick={() => beginConnect(provider)}
                    >
                      {copy.reconnect}
                    </ControlButton>
                  ) : null}
                  <ControlButton
                    tone="danger"
                    disabled={mutation !== ""}
                    onClick={() => void disconnect(integration)}
                  >
                    {copy.disconnect}
                  </ControlButton>
                </div>
              </article>
            );
          })}
          {integrations.length === 0 ? (
            <p className="tw:m-0 tw:border-b tw:border-border tw:py-6 tw:text-2xs tw:text-muted-foreground">
              {copy.empty}
            </p>
          ) : null}
        </div>
      </section>

      <section className="tw:grid tw:gap-2">
        <div className="tw:grid tw:gap-1">
          <strong className="tw:text-xs tw:text-foreground">
            {copy.connectTitle}
          </strong>
          <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
            {copy.connectDescription}
          </small>
        </div>
        <div className="tw:grid tw:border-t tw:border-border">
          {providers.map((provider) => {
            const connectedCount = integrations.filter(
              (item) => item.provider === provider.id,
            ).length;
            return (
              <div
                className="tw:grid tw:min-h-[78px] tw:grid-cols-[minmax(0,1fr)_auto] tw:items-center tw:gap-4 tw:border-b tw:border-border tw:py-3 tw:max-[640px]:grid-cols-1"
                key={provider.id}
              >
                <div className="tw:grid tw:gap-1">
                  <span className="tw:flex tw:flex-wrap tw:items-center tw:gap-2">
                    <strong className="tw:text-sm tw:text-foreground">
                      {provider.name}
                    </strong>
                    {provider.supportedEngines.map((engine) => (
                      <span
                        className="tw:border tw:border-border tw:bg-surface-inset tw:px-1.5 tw:py-0.5 tw:font-mono tw:text-2xs tw:uppercase tw:text-muted-foreground"
                        key={engine}
                      >
                        {engine}
                      </span>
                    ))}
                  </span>
                  <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                    {copy.notes[provider.id as keyof typeof copy.notes] ?? provider.note}
                  </small>
                </div>
                <div className="tw:flex tw:items-center tw:justify-end tw:gap-2 tw:max-[640px]:justify-start">
                  {connectedCount > 0 ? (
                    <span className="tw:font-mono tw:text-2xs tw:uppercase tw:text-primary">
                      {locale === "ko"
                        ? `${connectedCount}${common.countSuffix} ${copy.connected}`
                        : `${connectedCount} ${copy.connected}`}
                    </span>
                  ) : null}
                  <ControlButton
                    disabled={!provider.configured || mutation !== ""}
                    onClick={() => beginConnect(provider)}
                  >
                    {provider.configured
                      ? connectedCount > 0
                        ? copy.addAccount
                        : copy.connectAccount
                      : copy.serverSetup}
                  </ControlButton>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {setupProvider?.id === "neon" ? (
        <form
          className="tw:grid tw:grid-cols-1 tw:items-end tw:gap-3 tw:border-y tw:border-border tw:py-4 tw:lg:grid-cols-3"
          onSubmit={(event) => {
            event.preventDefault();
            void connect(setupProvider, neonConfiguration);
          }}
        >
          <p className="tw:col-span-full tw:m-0 tw:text-2xs tw:leading-body tw:text-muted-foreground">
            {copy.neonDescriptionBeforeLink} {copy.neonDescriptionLink}
            {copy.neonDescriptionAfterLink}
          </p>
          <aside className="tw:col-span-full tw:grid tw:gap-3 tw:rounded-control tw:border tw:border-border tw:bg-surface-inset tw:p-3.5">
            <div className="tw:flex tw:flex-col tw:items-start tw:justify-between tw:gap-3 tw:sm:flex-row tw:sm:items-center">
              <div className="tw:grid tw:gap-1">
                <strong className="tw:text-xs tw:text-foreground">
                  {copy.neonGuide.title}
                </strong>
                <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                  {copy.neonGuide.description}
                </small>
              </div>
              <ControlLink
                href="https://neon.com/docs/manage/api-keys"
                target="_blank"
                rel="noreferrer"
              >
                {copy.neonGuide.openDocs}
              </ControlLink>
            </div>
            <ol className="tw:m-0 tw:grid tw:list-none tw:grid-cols-1 tw:gap-2 tw:p-0 tw:md:grid-cols-3">
              {[
                {
                  number: copy.neonGuide.firstNumber,
                  title: copy.neonGuide.firstTitle,
                  path: copy.neonGuide.firstPath,
                  body: copy.neonGuide.firstBody,
                },
                {
                  number: copy.neonGuide.secondNumber,
                  title: copy.neonGuide.secondTitle,
                  path: copy.neonGuide.secondPath,
                  body: copy.neonGuide.secondBody,
                },
                {
                  number: copy.neonGuide.thirdNumber,
                  title: copy.neonGuide.thirdTitle,
                  path: copy.neonGuide.thirdPath,
                  body: copy.neonGuide.thirdBody,
                },
              ].map((step) => (
                <li
                  key={step.number}
                  className="tw:grid tw:content-start tw:gap-2 tw:rounded-control tw:border tw:border-border tw:bg-surface tw:p-3"
                >
                  <span className="tw:font-mono tw:text-2xs tw:font-semibold tw:text-primary">
                    {step.number}
                  </span>
                  <strong className="tw:text-xs tw:text-foreground">
                    {step.title}
                  </strong>
                  <code className="tw:w-fit tw:max-w-full tw:overflow-x-auto tw:rounded-control tw:bg-surface-inset tw:px-2 tw:py-1 tw:text-2xs tw:text-foreground">
                    {step.path}
                  </code>
                  <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                    {step.body}
                  </small>
                </li>
              ))}
            </ol>
            <div className="tw:flex tw:flex-col tw:gap-1 tw:border-t tw:border-border tw:pt-3 tw:sm:flex-row tw:sm:items-center tw:sm:gap-3">
              <strong className="tw:text-2xs tw:text-foreground">
                {copy.neonGuide.personalTitle}
              </strong>
              <code className="tw:w-fit tw:max-w-full tw:overflow-x-auto tw:rounded-control tw:bg-surface tw:px-2 tw:py-1 tw:text-2xs tw:text-foreground">
                {copy.neonGuide.personalPath}
              </code>
              <small className="tw:text-2xs tw:leading-body tw:text-muted-foreground">
                {copy.neonGuide.personalBody}
              </small>
            </div>
            <p className="tw:m-0 tw:text-2xs tw:font-medium tw:leading-body tw:text-warning">
              {copy.neonGuide.caution}
            </p>
          </aside>
          <ControlField label={copy.neonApiKey}>
            <ControlInput
              type="password"
              autoComplete="off"
              value={neonConfiguration.apiKey}
              onChange={(event) =>
                setNeonConfiguration({
                  ...neonConfiguration,
                  apiKey: event.target.value,
                })
              }
              placeholder={copy.neonApiKeyPlaceholder}
              required
            />
          </ControlField>
          <ControlField label={copy.projectId}>
            <ControlInput
              value={neonConfiguration.projectId}
              onChange={(event) =>
                setNeonConfiguration({
                  ...neonConfiguration,
                  projectId: event.target.value,
                })
              }
              placeholder={copy.projectIdPlaceholder}
            />
          </ControlField>
          <ControlField label={copy.organizationId}>
            <ControlInput
              value={neonConfiguration.organizationId}
              onChange={(event) =>
                setNeonConfiguration({
                  ...neonConfiguration,
                  organizationId: event.target.value,
                })
              }
              placeholder="org-..."
            />
          </ControlField>
          <div className="tw:col-span-full tw:flex tw:justify-end">
            <ControlButton
              type="submit"
              tone="primary"
              size="field"
              disabled={mutation !== ""}
            >
              {copy.verifyConnect}
            </ControlButton>
          </div>
        </form>
      ) : null}
    </div>
  );
}
