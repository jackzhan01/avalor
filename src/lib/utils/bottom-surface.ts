"use client";

import { useEffect, type RefObject } from "react";

/**
 * Publishes a bottom-anchored surface's height as a CSS variable, so anything
 * floating above the bottom of the screen can sit clear of it instead of on
 * top of it.
 *
 * Height, not position: these surfaces slide in with a transform, and a
 * `getBoundingClientRect()` read on the first frame would report the position
 * the surface holds for 300ms rather than the one it settles at.
 * `offsetHeight` is layout, so it is already final before the animation starts.
 *
 * Registrations are pooled per variable and reduced with `max`, because one
 * variable can have several publishers — a sheet layered over a sheet — and
 * the one that unmounts first must not drag the survivor's value down with it.
 */
const pools = new Map<string, Map<Element, number>>();

function publish(name: string) {
  const pool = pools.get(name);
  const root = document.documentElement;
  if (!pool || pool.size === 0) {
    // Falls back to the variable's default rather than keeping a stale height.
    root.style.removeProperty(name);
    return;
  }
  root.style.setProperty(name, `${Math.max(...pool.values())}px`);
}

export function useBottomSurface(
  ref: RefObject<HTMLElement | null>,
  name: string,
  /** False while the surface is unmounted, so re-opening re-measures. */
  active = true,
) {
  useEffect(() => {
    const el = active ? ref.current : null;
    if (!el) return;

    let pool = pools.get(name);
    if (!pool) {
      pool = new Map();
      pools.set(name, pool);
    }
    const registry = pool;

    const measure = () => {
      registry.set(el, el.offsetHeight);
      publish(name);
    };
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      observer.disconnect();
      registry.delete(el);
      publish(name);
    };
  }, [ref, name, active]);
}
