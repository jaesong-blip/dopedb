// Stable acquisition and trust sections render from typed bilingual content.
import Image from "next/image";
import { ArrowDown, ArrowUpRight, LockKeyhole, Network, SquareTerminal } from "lucide-react";
import { MarketingButton } from "./MarketingButton";
import { AccessTopology, SectionLabel } from "./HomePrimitives";
import { RecommendedMarketingDownload } from "./PlatformDownloads";
import {
  workspaceUrls,
  type HomeCopy,
  type Lang,
} from "./homeContent";

export function HomeAccessSections({ c, lang }: { c: HomeCopy; lang: Lang }) {
  return (
    <>
    <section
      className="tw:relative tw:isolate tw:border-b tw:border-hairline tw:bg-ambient"
      id="top"
    >
      <div className="tw:pointer-events-none tw:absolute tw:inset-0 tw:-z-10 tw:bg-control-grid tw:[background-size:48px_48px] tw:[mask-image:linear-gradient(to_bottom,black,transparent_92%)]" />
      <div className="tw:pointer-events-none tw:absolute tw:top-[16%] tw:left-[44%] tw:-z-10 tw:h-[460px] tw:w-[460px] tw:rounded-full tw:bg-signal/8 tw:blur-[110px]" />

      <div className="tw:mx-auto tw:grid tw:min-h-[calc(100dvh-64px)] tw:max-w-[1520px] tw:grid-cols-[minmax(0,0.95fr)_minmax(480px,0.85fr)] tw:items-center tw:gap-[clamp(44px,7vw,112px)] tw:px-[clamp(16px,4vw,64px)] tw:py-[clamp(72px,10vw,150px)] tw:max-[1080px]:grid-cols-1 tw:max-[1080px]:pt-20">
        <div className="tw:max-w-[830px]">
          <div className="tw:animate-[landing-rise_.7s_ease-out_both] tw:motion-reduce:animate-none">
            <SectionLabel>{c.hero.eyebrow}</SectionLabel>
          </div>
          <h1 className="tw:mt-7 tw:font-display tw:text-[clamp(54px,7.6vw,124px)] tw:leading-[0.9] tw:font-normal tw:tracking-[-0.055em] tw:text-balance tw:animate-[landing-rise_.8s_.08s_ease-out_both] tw:[animation-fill-mode:both] tw:motion-reduce:animate-none">
            <span className="tw:block">{c.hero.headline}</span>
            <span className="tw:mt-[0.08em] tw:block tw:text-signal">{c.hero.accent}</span>
          </h1>
          <p className="tw:mt-8 tw:max-w-[680px] tw:text-[clamp(16px,1.45vw,21px)] tw:leading-[1.7] tw:text-cream-muted tw:animate-[landing-rise_.8s_.16s_ease-out_both] tw:[animation-fill-mode:both] tw:motion-reduce:animate-none">
            {c.hero.text}
          </p>
          <div
            className="tw:mt-9 tw:flex tw:flex-wrap tw:gap-3 tw:animate-[landing-rise_.8s_.24s_ease-out_both] tw:[animation-fill-mode:both] tw:motion-reduce:animate-none tw:max-[620px]:grid tw:max-[620px]:grid-cols-1"
            data-primary-flow
          >
            <RecommendedMarketingDownload
              copy={c.download}
              fallbackLabel={c.hero.primary}
              source="hero"
            />
            <MarketingButton
              variant="secondary"
              href={workspaceUrls[lang]}
              event="Workspace Opened"
              properties={{ source: "hero" }}
            >
              {c.hero.secondary}
              <ArrowUpRight size={16} />
            </MarketingButton>
          </div>
          <p className="tw:mt-6 tw:flex tw:items-center tw:gap-2 tw:font-mono tw:text-[10px] tw:leading-relaxed tw:font-medium tw:tracking-[0.08em] tw:text-cream-muted tw:uppercase">
            <LockKeyhole className="tw:shrink-0 tw:text-signal" size={13} />
            {c.hero.proof}
          </p>
          <a
            className="tw:mt-12 tw:inline-flex tw:items-center tw:gap-2 tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.1em] tw:text-cream-muted tw:uppercase tw:transition-colors tw:hover:text-signal"
            href="#why"
          >
            {c.nav.access}
            <ArrowDown size={14} />
          </a>
        </div>

        <div className="tw:animate-[landing-rise_.9s_.18s_ease-out_both] tw:[animation-fill-mode:both] tw:motion-reduce:animate-none tw:max-[1080px]:mx-auto tw:max-[1080px]:w-full tw:max-[1080px]:max-w-[760px]">
          <AccessTopology c={c.topology} />
        </div>
      </div>
    </section>

    <dl className="tw:mx-auto tw:grid tw:max-w-[1520px] tw:grid-cols-4 tw:border-x tw:border-hairline tw:bg-night tw:max-[900px]:grid-cols-2 tw:max-[520px]:grid-cols-1">
      {c.proofs.map((proof) => (
        <div
          className="tw:min-w-0 tw:border-b tw:border-r tw:border-hairline tw:px-[clamp(18px,3vw,38px)] tw:py-6 tw:last:border-r-0 tw:max-[900px]:even:border-r-0 tw:max-[520px]:border-r-0"
          key={proof.label}
        >
          <dt className="tw:font-mono tw:text-[9px] tw:font-semibold tw:tracking-[0.12em] tw:text-cream-muted tw:uppercase">
            {proof.label}
          </dt>
          <dd className="tw:mt-2 tw:text-[14px] tw:font-medium tw:text-cream">
            {proof.value}
          </dd>
        </div>
      ))}
    </dl>

    <section
      className="tw:relative tw:bg-cream tw:text-night"
      id="why"
    >
      <div className="tw:pointer-events-none tw:absolute tw:inset-0 tw:bg-diagonal tw:opacity-55" />
      <div className="tw:relative tw:mx-auto tw:grid tw:max-w-[1520px] tw:grid-cols-[minmax(300px,0.75fr)_minmax(0,1.25fr)] tw:gap-[clamp(50px,8vw,140px)] tw:px-[clamp(16px,4vw,64px)] tw:py-[clamp(90px,12vw,180px)] tw:max-[960px]:grid-cols-1">
        <div className="tw:self-start tw:min-[961px]:sticky tw:min-[961px]:top-32">
          <SectionLabel tone="light">{c.boundary.eyebrow}</SectionLabel>
          <h2 className="tw:mt-6 tw:max-w-[650px] tw:font-display tw:text-[clamp(48px,6.8vw,108px)] tw:leading-[0.92] tw:font-normal tw:tracking-[-0.05em] tw:text-balance">
            {c.boundary.title}
          </h2>
          <p className="tw:mt-7 tw:max-w-[520px] tw:text-[clamp(16px,1.35vw,20px)] tw:leading-[1.7] tw:text-night/65">
            {c.boundary.body}
          </p>
        </div>

        <div className="tw:border-t tw:border-night/20">
          {c.boundary.items.map((item) => (
            <article
              className="tw:group tw:grid tw:grid-cols-[90px_minmax(0,1fr)] tw:gap-5 tw:border-b tw:border-night/20 tw:py-[clamp(28px,5vw,58px)] tw:max-[540px]:grid-cols-[56px_minmax(0,1fr)]"
              key={item.index}
            >
              <span className="tw:font-display tw:text-[clamp(34px,4vw,68px)] tw:leading-none tw:font-normal tw:text-night/14 tw:transition-colors tw:duration-300 tw:group-hover:text-night/30">
                {item.index}
              </span>
              <div>
                <p className="tw:font-mono tw:text-[10px] tw:font-semibold tw:tracking-[0.12em] tw:text-night/50 tw:uppercase">
                  {item.overline}
                </p>
                <h3 className="tw:mt-3 tw:max-w-[700px] tw:text-[clamp(23px,2.65vw,42px)] tw:leading-[1.08] tw:font-medium tw:tracking-[-0.03em] tw:text-balance">
                  {item.title}
                </h3>
                <p className="tw:mt-5 tw:max-w-[650px] tw:text-[15px] tw:leading-[1.75] tw:text-night/62">
                  {item.body}
                </p>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>

    <section className="tw:relative tw:border-y tw:border-hairline tw:bg-night tw:py-[clamp(90px,11vw,170px)]">
      <div className="tw:pointer-events-none tw:absolute tw:inset-0 tw:bg-control-grid tw:opacity-50 tw:[background-size:56px_56px] tw:[mask-image:linear-gradient(to_bottom,transparent,black_20%,black_80%,transparent)]" />
      <div className="tw:relative tw:mx-auto tw:max-w-[1520px] tw:px-[clamp(16px,4vw,64px)]">
        <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_minmax(300px,0.55fr)] tw:items-end tw:gap-12 tw:max-[900px]:grid-cols-1">
          <div>
            <SectionLabel>{c.product.eyebrow}</SectionLabel>
            <h2 className="tw:mt-6 tw:max-w-[980px] tw:font-display tw:text-[clamp(48px,6.8vw,108px)] tw:leading-[0.92] tw:font-normal tw:tracking-[-0.05em] tw:text-balance">
              {c.product.title}
            </h2>
          </div>
          <p className="tw:max-w-[540px] tw:text-[clamp(15px,1.25vw,19px)] tw:leading-[1.75] tw:text-cream-muted">
            {c.product.body}
          </p>
        </div>

        <div className="tw:relative tw:mt-[clamp(52px,7vw,94px)] tw:mx-auto tw:max-w-[1320px]">
          <div className="tw:relative tw:border tw:border-hairline-strong tw:bg-night-raised tw:p-2 tw:shadow-stage">
            <div className="tw:overflow-hidden tw:border tw:border-hairline tw:bg-night">
              <Image
                className="tw:block tw:h-auto tw:w-full"
                src="/dopedb-desktop.png"
                alt={c.product.imageAlt}
                width={2400}
                height={1536}
                priority={false}
              />
            </div>
            <div className="tw:flex tw:min-h-9 tw:items-center tw:justify-between tw:gap-4 tw:px-2 tw:pt-2 tw:font-mono tw:text-[9px] tw:font-medium tw:tracking-[0.1em] tw:text-cream-muted tw:uppercase tw:max-[560px]:items-start tw:max-[560px]:gap-1 tw:max-[560px]:flex-col">
              <span>{c.product.captureLabel}</span>
              <span className="tw:text-cream/45">{c.product.captureDetail}</span>
            </div>
          </div>

          <div className="tw:absolute tw:-top-16 tw:-left-5 tw:grid tw:max-w-[260px] tw:grid-cols-[34px_1fr] tw:gap-3 tw:border tw:border-hairline-strong tw:bg-night/92 tw:p-3 tw:shadow-stage tw:backdrop-blur-lg tw:max-[760px]:static tw:max-[760px]:mt-3 tw:max-[760px]:max-w-none">
            <span className="tw:grid tw:size-[34px] tw:place-items-center tw:bg-electric tw:text-night">
              <Network size={16} />
            </span>
            <div>
              <p className="tw:font-mono tw:text-[9px] tw:font-semibold tw:tracking-[0.1em] tw:text-electric tw:uppercase">
                {c.product.labels[0].title}
              </p>
              <p className="tw:mt-1 tw:text-xs tw:text-cream-muted">
                {c.product.labels[0].body}
              </p>
            </div>
          </div>

          <div className="tw:absolute tw:-right-5 tw:-bottom-16 tw:grid tw:max-w-[280px] tw:grid-cols-[34px_1fr] tw:gap-3 tw:border tw:border-signal/40 tw:bg-night/92 tw:p-3 tw:shadow-stage tw:backdrop-blur-lg tw:max-[760px]:static tw:max-[760px]:mt-3 tw:max-[760px]:max-w-none">
            <span className="tw:grid tw:size-[34px] tw:place-items-center tw:bg-signal tw:text-night">
              <SquareTerminal size={16} />
            </span>
            <div>
              <p className="tw:font-mono tw:text-[9px] tw:font-semibold tw:tracking-[0.1em] tw:text-signal tw:uppercase">
                {c.product.labels[1].title}
              </p>
              <p className="tw:mt-1 tw:text-xs tw:text-cream-muted">
                {c.product.labels[1].body}
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>

    <section
      className="tw:relative tw:bg-signal tw:bg-signal-grid tw:text-night tw:[background-size:40px_40px]"
      id="safety"
    >
      <div className="tw:mx-auto tw:max-w-[1520px] tw:px-[clamp(16px,4vw,64px)] tw:py-[clamp(90px,11vw,160px)]">
        <div className="tw:grid tw:grid-cols-[minmax(0,1fr)_minmax(280px,0.5fr)] tw:items-end tw:gap-12 tw:max-[900px]:grid-cols-1">
          <div>
            <SectionLabel tone="signal">{c.principles.eyebrow}</SectionLabel>
            <h2 className="tw:mt-6 tw:max-w-[940px] tw:font-display tw:text-[clamp(52px,7.4vw,118px)] tw:leading-[0.9] tw:font-normal tw:tracking-[-0.055em] tw:text-balance">
              {c.principles.title}
            </h2>
          </div>
          <p className="tw:max-w-[520px] tw:text-[clamp(16px,1.35vw,20px)] tw:leading-[1.7] tw:text-night/68">
            {c.principles.body}
          </p>
        </div>

        <div className="tw:mt-[clamp(50px,7vw,90px)] tw:grid tw:grid-cols-3 tw:border-y tw:border-night/25 tw:max-[840px]:grid-cols-1">
          {c.principles.items.map((item) => (
            <article
              className="tw:border-r tw:border-night/25 tw:px-[clamp(0px,3vw,42px)] tw:py-9 tw:first:pl-0 tw:last:border-r-0 tw:last:pr-0 tw:max-[840px]:border-r-0 tw:max-[840px]:border-b tw:max-[840px]:px-0 tw:max-[840px]:last:border-b-0"
              key={item.title}
            >
              <span className="tw:grid tw:size-11 tw:place-items-center tw:bg-night tw:text-signal">
                <item.icon size={20} strokeWidth={1.8} />
              </span>
              <h3 className="tw:mt-7 tw:text-[clamp(23px,2vw,32px)] tw:font-medium tw:tracking-[-0.025em]">
                {item.title}
              </h3>
              <p className="tw:mt-4 tw:max-w-[420px] tw:text-[15px] tw:leading-[1.7] tw:text-night/65">
                {item.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>

    </>
  );
}
