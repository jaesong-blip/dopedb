// 외부 서비스 없이 observable DOM만으로 landmark, heading, accessible name,
// label, focusability와 reduced-motion을 검사한다.
import type { Page } from "@playwright/test";

export interface AccessibilityMeasurement {
  landmarks: string[];
  headings: { level: number; text: string }[];
  headingOrderSkips: number;
  unnamedButtons: number;
  unlabeledFields: number;
  focusableInsideInert: number;
  reducedMotion: boolean;
}

export async function measureAccessibility(
  page: Page,
): Promise<AccessibilityMeasurement> {
  return page.evaluate(() => {
    const visible = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const name = (node: HTMLElement) => {
      const labelledBy = node.getAttribute("aria-labelledby");
      const labelledText = labelledBy
        ? labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ")
        : "";
      const candidates = [
        node.getAttribute("aria-label"),
        labelledText,
        node.getAttribute("title"),
        node.textContent,
      ];
      return (
        candidates.find(
          (candidate): candidate is string =>
            typeof candidate === "string" && candidate.trim().length > 0,
        ) ?? ""
      ).trim();
    };
    const buttons = [
      ...document.querySelectorAll<HTMLElement>("button, [role='button']"),
    ].filter(visible);
    const fields = [
      ...document.querySelectorAll<HTMLElement>("input, select, textarea"),
    ].filter(visible);
    const labelFor = (field: HTMLElement) =>
      (field.id && document.querySelector(`label[for="${CSS.escape(field.id)}"]`)) ||
      field.closest("label") ||
      field.getAttribute("aria-label") ||
      field.getAttribute("aria-labelledby") ||
      field.getAttribute("placeholder");

    const headings = [
      ...document.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"),
    ]
      .filter(visible)
      .map((node) => ({
        level: Number(node.tagName.slice(1)),
        text: (node.textContent ?? "").trim(),
      }));

    return {
      landmarks: [
        ...document.querySelectorAll<HTMLElement>(
          "nav, main, aside, header, footer, [role='dialog']",
        ),
      ]
        .filter(visible)
        .map((node) => node.getAttribute("role") ?? node.tagName.toLowerCase()),
      headings,
      headingOrderSkips: headings
        .slice(1)
        .filter((heading, index) => heading.level > headings[index].level + 1)
        .length,
      unnamedButtons: buttons.filter((button) => name(button).length === 0).length,
      unlabeledFields: fields.filter((field) => !labelFor(field)).length,
      focusableInsideInert: [
        ...document.querySelectorAll<HTMLElement>(
          "[inert] button, [inert] input, [inert] select, [inert] textarea, [inert] [tabindex='0']",
        ),
      ].filter((node) => visible(node) && node.tabIndex >= 0).length,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
  });
}
