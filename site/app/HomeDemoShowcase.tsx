"use client";

import { useEffect, useRef, useState } from "react";
import type { HomeCopy } from "./homeContent";

type ProductCopy = HomeCopy["product"];

export function HomeDemoShowcase({ product }: { product: ProductCopy }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const activeDemo = product.demos[activeIndex];

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    );
    const syncPlayback = () => {
      if (reducedMotion.matches) {
        video.pause();
        return;
      }
      void video.play().catch(() => {
        // Browser autoplay policy can still require an explicit press on controls.
      });
    };

    syncPlayback();
    reducedMotion.addEventListener("change", syncPlayback);
    return () => reducedMotion.removeEventListener("change", syncPlayback);
  }, [activeDemo.src]);

  return (
    <div className="tw:relative tw:mt-[clamp(52px,7vw,94px)] tw:mx-auto tw:max-w-[1320px]">
      <div className="tw:border tw:border-hairline-strong tw:bg-night-raised tw:p-2 tw:shadow-stage">
        <div className="tw:relative tw:overflow-hidden tw:border tw:border-hairline tw:bg-night">
          <video
            aria-label={`${activeDemo.title}. ${activeDemo.body}`}
            autoPlay
            className="tw:block tw:aspect-[2400/1480] tw:h-auto tw:w-full tw:bg-night tw:object-cover"
            controls
            key={activeDemo.src}
            loop
            muted
            playsInline
            poster={activeDemo.poster}
            preload="metadata"
            ref={videoRef}
          >
            <source src={activeDemo.src} type="video/mp4" />
          </video>
          <span className="tw:pointer-events-none tw:absolute tw:top-3 tw:left-3 tw:border tw:border-signal/35 tw:bg-night/88 tw:px-2.5 tw:py-1.5 tw:font-mono tw:text-[9px] tw:font-semibold tw:tracking-[0.1em] tw:text-signal tw:uppercase tw:backdrop-blur-md">
            {product.captureLabel}
          </span>
        </div>

        <div className="tw:flex tw:min-h-9 tw:items-center tw:justify-between tw:gap-4 tw:px-2 tw:pt-2 tw:font-mono tw:text-[9px] tw:font-medium tw:tracking-[0.1em] tw:text-cream-muted tw:uppercase tw:max-[560px]:items-start tw:max-[560px]:gap-1 tw:max-[560px]:flex-col">
          <span>{activeDemo.duration}</span>
          <span className="tw:text-cream/45">{product.captureDetail}</span>
        </div>
      </div>

      <div
        aria-label={product.demoPickerLabel}
        className="tw:mt-3 tw:grid tw:grid-cols-3 tw:border-y tw:border-hairline tw:max-[760px]:grid-cols-1"
      >
        {product.demos.map((demo, index) => {
          const active = index === activeIndex;
          return (
            <button
              aria-pressed={active}
              className="tw:grid tw:min-w-0 tw:grid-cols-[36px_minmax(0,1fr)] tw:gap-3 tw:border-r tw:border-hairline tw:bg-transparent tw:px-4 tw:py-5 tw:text-left tw:text-cream tw:transition-colors tw:last:border-r-0 tw:hover:bg-cream/5 tw:data-[active=true]:bg-cream/7 tw:max-[760px]:border-r-0 tw:max-[760px]:border-b tw:max-[760px]:last:border-b-0"
              data-active={active}
              key={demo.src}
              onClick={() => setActiveIndex(index)}
              type="button"
            >
              <span
                className="tw:font-display tw:text-3xl tw:leading-none tw:text-cream/25 tw:transition-colors tw:data-[active=true]:text-signal"
                data-active={active}
              >
                {demo.index}
              </span>
              <span>
                <span className="tw:block tw:text-[15px] tw:font-semibold tw:tracking-[-0.015em] tw:text-cream">
                  {demo.title}
                </span>
                <span className="tw:mt-2 tw:block tw:text-xs tw:leading-relaxed tw:text-cream-muted">
                  {demo.body}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="tw:mt-3 tw:flex tw:flex-wrap tw:gap-2">
        {product.labels.map((label) => (
          <span
            className="tw:border tw:border-hairline tw:bg-night-raised tw:px-3 tw:py-2 tw:font-mono tw:text-[9px] tw:font-semibold tw:tracking-[0.08em] tw:text-cream-muted tw:uppercase"
            key={label.title}
          >
            <span className="tw:text-electric">{label.title}</span>
            <span className="tw:mx-2 tw:text-cream/20">/</span>
            {label.body}
          </span>
        ))}
      </div>
    </div>
  );
}
