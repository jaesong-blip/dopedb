"use client";

// Public-site tracking accepts only the reviewed CTA names and property pairs;
// links without an analytics event remain ordinary anchors.
import { track } from "@vercel/analytics";
import type { AnchorHTMLAttributes, ReactNode } from "react";

type DownloadTrackingProperties =
  | {
      source: "header" | "hero" | "download_section";
      target: "latest_release";
    }
  | {
      source: "platform_grid";
      target: "windows_x64_installer" | "macos_arm64_dmg" | "macos_x64_dmg";
    };

export type TrackedLinkTrackingProps =
  | { event?: never; properties?: never }
  | {
      event: "Download Clicked";
      properties: DownloadTrackingProperties;
    }
  | {
      event: "Workspace Opened";
      properties: { source: "header" | "hero" | "footer" };
    };

export type TrackedLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  children: ReactNode;
} & TrackedLinkTrackingProps;

export function TrackedLink({
  children,
  event,
  properties,
  onClick,
  ...props
}: TrackedLinkProps) {
  return (
    <a
      {...props}
      onClick={(clickEvent) => {
        if (event) {
          track(event, properties);
        }
        onClick?.(clickEvent);
      }}
    >
      {children}
    </a>
  );
}
