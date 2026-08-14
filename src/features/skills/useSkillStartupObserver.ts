import { useQuery } from "@tanstack/react-query";

import { skillStatusQuery } from "../../lib/queries";
import { usePostPaintReady } from "../../lib/usePostPaintReady";

/** Keeps one bounded Skill inventory observer alive after the first visible frame. */
export function useSkillStartupObserver() {
  const postPaintReady = usePostPaintReady();
  useQuery(skillStatusQuery(postPaintReady));
}
