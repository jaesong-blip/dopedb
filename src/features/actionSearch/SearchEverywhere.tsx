import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "../../components/Icon";
import { useI18n } from "../../lib/i18n";
import {
  indexSearchEverywhereItems,
  searchEverywhereItems,
  type SearchEverywhereItem,
  type SearchEverywhereKind,
} from "./domain";

const kindIcon: Record<SearchEverywhereKind, IconName> = {
  action: "target",
  connection: "database",
  document: "list",
  databaseObject: "table",
  setting: "gear",
};

const kindLabelKey: Record<
  SearchEverywhereKind,
  | "ide.search.category.action"
  | "ide.search.category.connection"
  | "ide.search.category.document"
  | "ide.search.category.databaseObject"
  | "ide.search.category.setting"
> = {
  action: "ide.search.category.action",
  connection: "ide.search.category.connection",
  document: "ide.search.category.document",
  databaseObject: "ide.search.category.databaseObject",
  setting: "ide.search.category.setting",
};

export default function SearchEverywhere({
  items,
  onClose,
}: {
  items: readonly SearchEverywhereItem[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  const index = useMemo(
    () => indexSearchEverywhereItems(items),
    [items],
  );
  const visibleItems = useMemo(
    () => searchEverywhereItems(index, query),
    [index, query],
  );

  useEffect(() => {
    inputRef.current?.focus();
    return () => returnFocusRef.current?.focus();
  }, []);

  useEffect(() => {
    setActiveIndex((current) =>
      Math.min(current, Math.max(0, visibleItems.length - 1)),
    );
  }, [visibleItems.length]);

  async function choose(item: SearchEverywhereItem) {
    if (item.disabled) return;
    onClose();
    await item.run();
  }

  return createPortal(
    <div
      className="tw:fixed tw:inset-0 tw:z-[var(--ds-z-modal)] tw:flex tw:items-start tw:justify-center tw:bg-overlay tw:px-4 tw:pt-[72px]"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="tw:flex tw:max-h-[min(620px,calc(100dvh_-_96px))] tw:w-[min(760px,100%)] tw:flex-col tw:overflow-hidden tw:rounded-lg tw:border tw:border-border-strong tw:bg-popover tw:text-popover-foreground tw:shadow-popover"
        role="dialog"
        aria-modal="true"
        aria-label={t("ide.action.searchEverywhere")}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="tw:flex tw:min-h-12 tw:shrink-0 tw:items-center tw:gap-3 tw:border-b tw:border-border-subtle tw:px-4">
          <Icon name="search" className="tw:shrink-0 tw:text-muted-foreground" />
          <input
            ref={inputRef}
            type="search"
            value={query}
            className="tw:h-11 tw:min-w-0 tw:flex-1 tw:border-0 tw:bg-transparent tw:font-sans tw:text-base tw:text-foreground tw:outline-none tw:placeholder:text-muted-foreground"
            placeholder={t("ide.search.placeholder")}
            aria-controls="search-everywhere-results"
            aria-activedescendant={
              visibleItems[activeIndex]
                ? `search-everywhere-${visibleItems[activeIndex].id}`
                : undefined
            }
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setActiveIndex((current) =>
                  Math.min(
                    visibleItems.length - 1,
                    current + 1,
                  ),
                );
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) =>
                  Math.max(0, current - 1),
                );
              } else if (event.key === "Enter") {
                const active = visibleItems[activeIndex];
                if (active) {
                  event.preventDefault();
                  void choose(active);
                }
              }
            }}
          />
          <kbd className="tw:rounded-xs tw:border tw:border-border-subtle tw:bg-muted tw:px-1.5 tw:py-1 tw:font-mono tw:text-2xs tw:text-muted-foreground">
            esc
          </kbd>
        </div>

        <div
          id="search-everywhere-results"
          className="tw:min-h-0 tw:flex-1 tw:overflow-y-auto tw:p-1.5"
          role="listbox"
          aria-label={t("ide.search.results")}
        >
          {visibleItems.map((item, index) => (
            <button
              id={`search-everywhere-${item.id}`}
              key={item.id}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              disabled={item.disabled}
              className="tw:grid tw:min-h-control-xl tw:w-full tw:cursor-pointer tw:grid-cols-[var(--ds-control-lg)_minmax(0,1fr)_auto] tw:items-center tw:gap-2 tw:rounded-sm tw:border-0 tw:bg-transparent tw:px-2 tw:py-1.5 tw:font-sans tw:text-left tw:text-foreground tw:aria-selected:bg-selection tw:aria-selected:text-selection-foreground tw:disabled:cursor-default tw:disabled:opacity-45 tw:not-disabled:hover:bg-muted"
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => void choose(item)}
            >
              <span className="tw:grid tw:size-control-lg tw:place-items-center tw:text-muted-foreground">
                <Icon name={kindIcon[item.kind]} />
              </span>
              <span className="tw:grid tw:min-w-0 tw:gap-0.5">
                <strong className="tw:overflow-hidden tw:text-sm tw:font-medium tw:text-ellipsis tw:whitespace-nowrap">
                  {item.label}
                </strong>
                <small className="tw:overflow-hidden tw:text-2xs tw:text-muted-foreground tw:text-ellipsis tw:whitespace-nowrap">
                  {t(kindLabelKey[item.kind])}
                  {item.detail ? ` · ${item.detail}` : ""}
                </small>
              </span>
              {item.shortcut ? (
                <kbd className="tw:rounded-xs tw:border tw:border-border-subtle tw:bg-background tw:px-1.5 tw:py-1 tw:font-mono tw:text-2xs tw:text-muted-foreground">
                  {item.shortcut}
                </kbd>
              ) : (
                <Icon
                  name="arrowRight"
                  className="tw:mx-1 tw:text-xs tw:text-muted-foreground"
                />
              )}
            </button>
          ))}
          {visibleItems.length === 0 ? (
            <div className="tw:grid tw:min-h-32 tw:place-items-center tw:p-6 tw:text-sm tw:text-muted-foreground">
              {t("ide.search.empty")}
            </div>
          ) : null}
        </div>

        <footer className="tw:flex tw:min-h-8 tw:shrink-0 tw:items-center tw:justify-between tw:gap-3 tw:border-t tw:border-border-subtle tw:px-3 tw:text-2xs tw:text-muted-foreground">
          <span>{t("ide.search.hint")}</span>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
