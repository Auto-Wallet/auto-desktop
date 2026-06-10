import type { UpdateProgress } from "./updater";

export type UpdateBarState =
  | { indeterminate: true; percent: null }
  | { indeterminate: false; percent: number };

export function updateBarState(progress: UpdateProgress): UpdateBarState {
  if (progress.phase === "installing") {
    return { indeterminate: false, percent: 100 };
  }
  if (progress.total && progress.total > 0) {
    return {
      indeterminate: false,
      percent: Math.min(
        100,
        Math.round((progress.downloaded / progress.total) * 100),
      ),
    };
  }
  return { indeterminate: true, percent: null };
}
