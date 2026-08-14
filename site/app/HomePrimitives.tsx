// Stable landing primitives own repeated labels and the access-topology visual.
import type { ReactNode } from "react";
import { ArrowRight, Bot, CircleDot, Database, KeyRound, Network, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { HomeCopy } from "./homeContent";

type SectionLabelProps = {
  children: ReactNode;
  tone?: "dark" | "light" | "signal";
};

export function SectionLabel({ children, tone = "dark" }: SectionLabelProps) {
  return (
    <p
      className="tw:inline-flex tw:items-center tw:gap-2.5 tw:font-mono tw:text-[11px] tw:leading-none tw:font-semibold tw:tracking-[0.12em] tw:uppercase tw:data-[tone=dark]:text-signal tw:data-[tone=light]:text-night/60 tw:data-[tone=signal]:text-night/65"
      data-tone={tone}
    >
      <span
        className="tw:size-1.5 tw:rounded-full tw:bg-current tw:shadow-[0_0_0_4px_color-mix(in_srgb,currentColor_14%,transparent)]"
        aria-hidden="true"
      />
      {children}
    </p>
  );
}

type TopologyNodeProps = {
  icon: LucideIcon;
  label: string;
  meta: string;
  value: string;
};

function TopologyNode({ icon: Icon, label, meta, value }: TopologyNodeProps) {
  return (
    <div className="tw:group tw:relative tw:min-w-0 tw:border tw:border-hairline tw:bg-night-raised/90 tw:p-4 tw:transition-[border-color,background-color,transform] tw:duration-300 tw:hover:-translate-y-0.5 tw:hover:border-signal/45 tw:hover:bg-night-soft">
      <div className="tw:flex tw:items-start tw:justify-between tw:gap-4">
        <div className="tw:min-w-0">
          <p className="tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.12em] tw:text-cream-muted tw:uppercase">
            {label}
          </p>
          <p className="tw:mt-2 tw:truncate tw:text-[15px] tw:font-bold tw:text-cream">
            {value}
          </p>
        </div>
        <span className="tw:grid tw:size-9 tw:shrink-0 tw:place-items-center tw:border tw:border-signal/30 tw:bg-signal/10 tw:text-signal">
          <Icon size={17} strokeWidth={1.8} />
        </span>
      </div>
      <p className="tw:mt-4 tw:max-w-[34ch] tw:font-mono tw:text-[10px] tw:leading-relaxed tw:text-cream-muted">
        {meta}
      </p>
    </div>
  );
}

type TopologyCopy = HomeCopy["topology"];

export function AccessTopology({ c }: { c: TopologyCopy }) {
  return (
    <div className="tw:relative tw:border tw:border-hairline-strong tw:bg-night/75 tw:p-2 tw:shadow-stage tw:backdrop-blur-xl">
      <div className="tw:absolute tw:-inset-10 tw:-z-10 tw:bg-signal/10 tw:blur-[80px] tw:animate-[landing-breathe_6s_ease-in-out_infinite] tw:motion-reduce:animate-none" />
      <div className="tw:flex tw:items-center tw:justify-between tw:gap-4 tw:border-b tw:border-hairline tw:px-3 tw:py-2.5">
        <div className="tw:flex tw:items-center tw:gap-2 tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.1em] tw:text-cream-muted tw:uppercase">
          <Network className="tw:text-signal" size={14} />
          {c.eyebrow}
        </div>
        <div className="tw:flex tw:items-center tw:gap-2 tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.1em] tw:text-signal tw:uppercase">
          <span className="tw:size-1.5 tw:animate-pulse tw:rounded-full tw:bg-signal tw:motion-reduce:animate-none" />
          {c.status}
        </div>
      </div>

      <div className="tw:relative tw:overflow-hidden tw:bg-control-grid tw:[background-size:36px_36px] tw:p-[clamp(18px,4vw,34px)]">
        <svg
          className="tw:pointer-events-none tw:absolute tw:inset-0 tw:h-full tw:w-full tw:text-signal/35"
          aria-hidden="true"
          viewBox="0 0 640 500"
          preserveAspectRatio="none"
        >
          <path
            className="tw:animate-[landing-dash_4s_linear_infinite] tw:[stroke-dasharray:8_8] tw:motion-reduce:animate-none"
            d="M320 84 V226 M144 252 H496 M320 278 V418"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>

        <div className="tw:relative tw:grid tw:grid-cols-[minmax(0,1fr)_44px_minmax(0,1fr)] tw:items-center tw:gap-y-8 tw:max-[620px]:grid-cols-1 tw:max-[620px]:gap-3">
          <div className="tw:col-span-3 tw:mx-auto tw:w-full tw:max-w-[430px] tw:max-[620px]:col-span-1">
            <TopologyNode
              icon={Users}
              label={c.workspaceLabel}
              value={c.workspaceValue}
              meta={c.workspaceMeta}
            />
          </div>

          <TopologyNode
            icon={KeyRound}
            label={c.memberLabel}
            value={c.memberValue}
            meta={c.memberMeta}
          />
          <div className="tw:flex tw:items-center tw:justify-center tw:text-signal tw:max-[620px]:rotate-90" aria-hidden="true">
            <ArrowRight size={18} />
          </div>
          <TopologyNode
            icon={Bot}
            label={c.agentLabel}
            value={c.agentValue}
            meta={c.agentMeta}
          />

          <div className="tw:col-span-3 tw:mx-auto tw:w-full tw:max-w-[430px] tw:max-[620px]:col-span-1">
            <TopologyNode
              icon={Database}
              label={c.databaseLabel}
              value={c.databaseValue}
              meta={c.databaseMeta}
            />
          </div>
        </div>
      </div>

      <div className="tw:grid tw:grid-cols-2 tw:gap-px tw:bg-hairline tw:max-[480px]:grid-cols-1">
        {[c.seal, c.receipt].map((label) => (
          <div
            className="tw:flex tw:items-center tw:gap-2 tw:bg-night-raised tw:px-3 tw:py-2.5 tw:font-mono tw:text-[10px] tw:font-medium tw:tracking-[0.08em] tw:text-cream-muted tw:uppercase"
            key={label}
          >
            <CircleDot className="tw:text-signal" size={13} />
            {label}
          </div>
        ))}
      </div>
    </div>
  );
}
