// Motion orchestration for the transitions.dev snippets in src/transitions.css.
// The CSS owns every duration and easing; everything here reads those values
// back out of :root so the two can never drift apart.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

// SidebarFooter is rendered through renderToStaticMarkup in its unit test, and
// useLayoutEffect warns (and does nothing) on the server.
const useIsomorphicLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Read a duration custom property (`150ms` / `0.15s`) as milliseconds. */
export function motionMs(name: string, fallback: number): number {
  if (typeof document === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (!raw) return fallback;
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return raw.endsWith("ms") ? n : raw.endsWith("s") ? n * 1000 : n;
}

type Phase = "enter" | "open" | "closing";

/**
 * Keep a surface mounted through its close animation.
 *
 * `enter` is the pre-open rest state, `open` runs the open clock, `closing`
 * runs the close clock. The closing class is dropped once the animation ends
 * so the next open starts from rest instead of jumping from the closing scale.
 */
export function useEnterExit(
  open: boolean,
  closeMs: number,
): { mounted: boolean; cls: string } {
  const [mounted, setMounted] = useState(open);
  const [phase, setPhase] = useState<Phase>("enter");
  const everOpened = useRef(open);

  useEffect(() => {
    if (open) {
      everOpened.current = true;
      setMounted(true);
      // Two frames: the element must paint its pre-open state before
      // `.is-open` lands, or the browser has nothing to tween from.
      let inner = 0;
      const outer = requestAnimationFrame(() => {
        inner = requestAnimationFrame(() => setPhase("open"));
      });
      return () => {
        cancelAnimationFrame(outer);
        cancelAnimationFrame(inner);
      };
    }
    if (!everOpened.current) return;
    setPhase("closing");
    const id = window.setTimeout(() => {
      setPhase("enter");
      setMounted(false);
    }, closeMs);
    return () => window.clearTimeout(id);
  }, [open, closeMs]);

  return {
    mounted,
    cls: phase === "open" ? "is-open" : phase === "closing" ? "is-closing" : "",
  };
}

/** `useEnterExit` wired to the dropdown clock — for `.t-dropdown` surfaces. */
export function useDropdown(open: boolean) {
  return useEnterExit(open, motionMs("--dropdown-close-dur", 150));
}

/**
 * Give a modal an exit animation without moving its mount point.
 *
 * A modal in this app is rendered by its parent as `{open && <TheModal/>}`, so
 * on its own it would vanish the instant the parent flips that flag. Call this
 * at the top of the modal, put `cls` on both the scrim and the card, and use
 * the returned `close` everywhere `onClose` was called: the card dips back down
 * first, and the parent's `onClose` runs once that has finished.
 */
export function useModalExit(onClose: () => void): {
  cls: string;
  close: () => void;
} {
  const closeMs = motionMs("--modal-close-dur", 150);
  const [open, setOpen] = useState(true);
  const { cls } = useEnterExit(open, closeMs);
  const closing = useRef(false);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setOpen(false);
    window.setTimeout(onClose, closeMs);
  }, [onClose, closeMs]);

  return { cls, close };
}

/**
 * Slide the active pill of a segmented control.
 *
 * Attach the returned ref to the bar and render a `<span className="t-tabs-pill" />`
 * as its first child; the pill is measured off whichever button currently
 * carries `selector`. The first placement (and any resize) is written without a
 * transition so the pill never animates in from `translateX(0)` / `width: 0`.
 */
export function useSegPill<T extends HTMLElement = HTMLDivElement>(
  activeKey: unknown,
  selector = "button.on",
) {
  const ref = useRef<T | null>(null);
  const placed = useRef(false);

  useIsomorphicLayoutEffect(() => {
    const bar = ref.current;
    if (!bar) return;
    const pill = bar.querySelector<HTMLElement>(":scope > .t-tabs-pill");
    if (!pill) return;
    bar.classList.add("has-pill");

    const move = (animate: boolean) => {
      const active = bar.querySelector<HTMLElement>(selector);
      if (!active) {
        pill.style.opacity = "0";
        return;
      }
      pill.style.opacity = "1";
      // Both axes: the sidebar's theme switch stacks vertically when the
      // sidebar collapses, so the pill has to travel in Y as well as X.
      const write = () => {
        pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
        pill.style.width = `${active.offsetWidth}px`;
        pill.style.height = `${active.offsetHeight}px`;
      };
      if (animate) {
        write();
        return;
      }
      const prev = pill.style.transition;
      pill.style.transition = "none";
      write();
      void pill.offsetWidth; // force reflow
      pill.style.transition = prev;
    };

    move(placed.current);
    placed.current = true;

    // ResizeObserver fires once on observe; that first callback would snap the
    // pill and swallow the tween that just started, so skip it.
    let primed = false;
    const relayout = () => move(false);
    const ro = new ResizeObserver(() => {
      if (!primed) {
        primed = true;
        return;
      }
      relayout();
    });
    ro.observe(bar);
    window.addEventListener("resize", relayout);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", relayout);
    };
  }, [activeKey, selector]);

  return ref;
}

/**
 * Drive a `.t-toggle` switch. `.is-init` is withheld until the value has
 * actually flipped once, so a page full of switches doesn't play its return
 * bounce on mount.
 */
export function useToggleInit(on: boolean): {
  dataOn: "true" | "false";
  initCls: string;
} {
  const [init, setInit] = useState(false);
  const prev = useRef(on);
  useEffect(() => {
    if (prev.current === on) return;
    prev.current = on;
    setInit(true);
  }, [on]);
  return { dataOn: on ? "true" : "false", initCls: init ? " is-init" : "" };
}

/**
 * Replay the error shake on demand. Attach the ref to the element that owns
 * the visible border; call `shake()` every time the action fails, including
 * when it fails with the same message twice in a row.
 */
export function useShake<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const shake = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove("is-shaking");
    void el.offsetWidth; // force reflow so the animation restarts
    el.classList.add("is-shaking");
    const ms =
      motionMs("--shake-dur-a", 80) * 2 + motionMs("--shake-dur-b", 60) * 2;
    window.setTimeout(() => el.classList.remove("is-shaking"), ms + 20);
  }, []);
  return { ref, shake };
}

/**
 * Comb-hover a horizontal row of items (`.t-avatar-group` → `.t-avatar`).
 *
 * Hovering one item lifts it and nudges its neighbours by a power falloff;
 * leaving the row springs everything back. Spread the returned `group` props
 * on the row and `item(i)` on each child.
 *
 * The timing function is written inline *before* the variables change: the
 * browser uses whatever it is at the moment a transitionable property moves,
 * which is what buys a clean curve up and a bouncy one back without a second
 * class.
 */
export function useHoverGroup<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);

  const setShifts = useCallback((activeIdx: number | null, phase: "in" | "out") => {
    const root = ref.current;
    if (!root) return;
    const cs = getComputedStyle(document.documentElement);
    const num = (name: string, fb: number) => {
      const v = parseFloat(cs.getPropertyValue(name));
      return Number.isFinite(v) ? v : fb;
    };
    const ease = (name: string, fb: string) =>
      cs.getPropertyValue(name).trim() || fb;

    const lift = num("--avatar-lift", -4);
    const falloff = num("--avatar-falloff", 0.45);
    const scale = num("--avatar-scale", 1.05);
    const tf =
      phase === "out"
        ? ease("--avatar-ease-out", "cubic-bezier(0.34, 3.85, 0.64, 1)")
        : ease("--avatar-ease-in", "cubic-bezier(0.22, 1, 0.36, 1)");

    root.querySelectorAll<HTMLElement>(".t-avatar").forEach((el, i) => {
      el.style.transitionTimingFunction = tf;
      if (activeIdx == null) {
        el.style.setProperty("--shift", "0px");
        el.style.setProperty("--scale-active", "1");
        return;
      }
      const d = Math.abs(i - activeIdx);
      el.style.setProperty("--shift", (lift * Math.pow(falloff, d)).toFixed(3) + "px");
      el.style.setProperty("--scale-active", i === activeIdx ? String(scale) : "1");
    });
  }, []);

  return {
    group: { ref, onMouseLeave: () => setShifts(null, "out") },
    item: (i: number) => ({
      className: "t-avatar",
      onMouseEnter: () => setShifts(i, "in"),
    }),
  };
}

/**
 * Flip a `.t-icon-swap` to its second icon for a beat, then back — the
 * "copied!" confirmation on a copy button. `fire()` restarts the timer, so
 * mashing the button keeps showing the check instead of flickering.
 */
export function useIconSwap(holdMs = 1200): {
  state: "a" | "b";
  fire: () => void;
} {
  const [state, setState] = useState<"a" | "b">("a");
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const fire = useCallback(() => {
    setState("b");
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("a"), holdMs);
  }, [holdMs]);
  return { state, fire };
}

/**
 * One full turn per call, for refresh buttons. Attach the ref to the icon
 * wrapper; the reflow between removing and re-adding `.is-spinning` is what
 * makes a second click restart the turn instead of being ignored.
 */
export function useSpin<T extends HTMLElement = HTMLSpanElement>() {
  const ref = useRef<T | null>(null);
  const spin = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove("is-spinning");
    void el.offsetWidth; // force reflow so the animation restarts
    el.classList.add("is-spinning");
  }, []);
  return { ref, spin };
}
