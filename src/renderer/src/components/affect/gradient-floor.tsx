// affectUI Pro - licensed under https://www.affectui.com/license, not under this project's open-source license. Don't copy it out of this project.
"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";

/*
 * Gradient Floor – a blurred colour gradient that glows up from the bottom edge, in a single self-contained file.
 * Two layers: a colour layer and a white layer on top that lightens it with plus-lighter.
 * Their peaks and valleys rise and fall against each other while both layers drift sideways.
 * The floor scales with the width of its container; content goes on top as children.
 * Animations only run while the floor is on screen; prefers-reduced-motion keeps it still.
 */

export type GradientFloorProps = {
  /** Content rendered above the floor */
  children?: ReactNode;
  /** Gradient from the crest down: [top, middle, bottom] */
  colors?: [string, string, string];
  /** Seconds per morph loop; 0 keeps the shape still (the sideways drift keeps going) */
  speed?: number;
  className?: string;
};

/** Base points of both shapes (design frame 2200 wide): peaks (l, m, r) and valleys (vL, vR) move independently */
type Shape = {
  k: number;
  v1: [number, number]; c: [number, number]; l: [number, number]; bottom: number; r: [number, number];
  v4: [number, number]; v3: [number, number]; m2: [number, number]; m1: [number, number]; v2: [number, number];
};
const COLOR: Shape = {
  k: 1, v1: [926.8, 565.8], c: [302.1, 297.3], l: [291.3, 291.3], bottom: 1222.8, r: [3155.8, 361.3],
  v4: [2493.8, 565.8], v3: [2189.3, 565.8], m2: [1898.8, 428.8], m1: [1510.8, 428.8], v2: [1230.8, 565.8],
};
const LIGHT: Shape = {
  k: 0.8427, v1: [781.039, 476.815], c: [254.588, 250.543], l: [245.486, 245.486], bottom: 1030.49, r: [2659.48, 304.477],
  v4: [2101.59, 476.815], v3: [1844.98, 476.815], m2: [1600.17, 361.361], m1: [1273.19, 361.361], v2: [1037.23, 476.815],
};
const PEAK = 110;
const VALLEY = 80;

function shapePath(p: Shape, t: number) {
  const d = {
    l: PEAK * Math.sin(t),
    m: -PEAK * Math.sin(t + 0.5),
    r: PEAK * Math.sin(t + 1),
    vL: VALLEY * Math.sin(t + Math.PI / 2 + 0.25),
    vR: VALLEY * Math.sin(t - Math.PI / 2 + 0.75),
  };
  const y = (pt: [number, number], dy: number) => (pt[1] + dy * p.k).toFixed(1);
  return (
    `M${p.v1[0]} ${y(p.v1, d.vL)}` +
    `C${p.v1[0]} ${y(p.v1, d.vL)} ${p.c[0]} ${y(p.c, d.l)} ${p.l[0]} ${y(p.l, d.l)}` +
    `V${p.bottom}H${p.r[0]}V${y(p.r, d.r)}` +
    `L${p.v4[0]} ${y(p.v4, d.vR)}H${p.v3[0]}V${y(p.v3, d.vR)}` +
    `L${p.m2[0]} ${y(p.m2, d.m)}H${p.m1[0]}V${y(p.m1, d.m)}` +
    `L${p.v2[0]} ${y(p.v2, d.vL)}H${p.v1[0]}V${y(p.v1, d.vL)}Z`
  );
}

export function GradientFloor({
  children,
  colors = ["#FF7700", "#FF0055", "#0073FF"],
  speed = 3,
  className,
}: GradientFloorProps) {
  const id = "ui-gf" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const root = useRef<HTMLDivElement>(null);
  const color = useRef<SVGPathElement>(null);
  const light = useRef<SVGPathElement>(null);

  // Morphs the shapes while the floor is on screen; off screen every loop pauses
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const morph = speed > 0 && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let drawn = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      // The shapes move slowly and sit under a heavy blur – 30 redraws a second look the same as 60
      if (now - drawn < 32) return;
      drawn = now;
      const t = (now / (speed * 1000)) * Math.PI * 2;
      color.current?.setAttribute("d", shapePath(COLOR, t));
      light.current?.setAttribute("d", shapePath(LIGHT, t));
    };
    if (typeof IntersectionObserver === "undefined") {
      if (morph) frame = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(frame);
    }
    const io = new IntersectionObserver(([e]) => {
      cancelAnimationFrame(frame);
      el.toggleAttribute("data-paused", !e.isIntersecting);
      if (e.isIntersecting && morph) frame = requestAnimationFrame(tick);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [speed]);

  return (
    <div ref={root} className={["ui-gf", className].filter(Boolean).join(" ")}>
      {/* React 19 hoists this into <head> once, no matter how many instances render */}
      <style href="ui-gradient-floor" precedence="default">
        {css}
      </style>
      <div className="ui-gf-layer ui-gf-layer--color" aria-hidden="true">
        <div className="ui-gf-bleed">
          <svg viewBox="0 0 3447.1 1514.1" preserveAspectRatio="none">
            <defs>
              <linearGradient id={`${id}-fill`} x1="1723.8" y1="423.3" x2="1723.8" y2="894.3" gradientUnits="userSpaceOnUse">
                <stop stopColor={colors[0]} />
                <stop offset="0.302885" stopColor={colors[1]} />
                <stop offset="0.673077" stopColor={colors[2]} />
              </linearGradient>
            </defs>
            <path ref={color} d={shapePath(COLOR, 0)} fill={`url(#${id}-fill)`} />
          </svg>
        </div>
      </div>
      <div className="ui-gf-layer ui-gf-layer--light" aria-hidden="true">
        <div className="ui-gf-bleed">
          <svg viewBox="0 0 2904.96 1275.97" preserveAspectRatio="none">
            <path ref={light} d={shapePath(LIGHT, 0)} fill="#fff" fillOpacity="0.8" />
          </svg>
        </div>
      </div>
      {children != null && <div className="ui-gf-content">{children}</div>}
    </div>
  );
}

/* ---------- Styles ---------- */

/** A length in the 2200 wide design frame, scaled to the container width */
const u = (n: number) => `calc(${n} * 100cqw / 2200)`;

const css = /* css */ `
.ui-gf {
  position: relative;
  container-type: inline-size;
  overflow: hidden;
  /* Its own group, so plus-lighter only lightens the floor and the background below it */
  isolation: isolate;
  background: var(--ui-gf-bg, #fafafa);
}
.ui-gf-layer { position: absolute; pointer-events: none; }
/* Anchored to the bottom edge */
.ui-gf-layer--color { left: ${u(-290)}; bottom: ${u(-484.5)}; width: ${u(2864.5)}; height: ${u(931.5)}; }
.ui-gf-layer--light { left: ${u(-65)}; bottom: ${u(-507)}; width: ${u(2414)}; height: ${u(785)}; mix-blend-mode: plus-lighter; }
.ui-gf-bleed { position: absolute; inset: -31.27% -10.17%; transform-origin: 50% 70%; will-change: transform; }
/* The floor is so soft that it can be drawn at a quarter of its size and scaled up 4× on the GPU –
   it looks the same, but every redraw of the moving shapes costs about a sixteenth */
.ui-gf-bleed svg {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
  width: 25%;
  height: 25%;
  overflow: visible;
  transform: scale(4);
  transform-origin: 0 0;
  will-change: transform;
}
.ui-gf-layer--color svg { filter: blur(calc(${u(145.65)} / 4)); }
.ui-gf-layer--light svg { filter: blur(calc(${u(122.74)} / 4)); }
/* Both layers drift on the same beat; the light one moves a little less */
.ui-gf-layer--color .ui-gf-bleed { animation: ui-gf-drift-color 2.5s ease-in-out infinite; }
.ui-gf-layer--light .ui-gf-bleed { animation: ui-gf-drift-light 2.5s ease-in-out infinite; }
@keyframes ui-gf-drift-color {
  0%, 100% { transform: translate(0, 0) scale(1, 1); }
  33% { transform: translate(${u(-120)}, ${u(-20)}) scale(1.05, 1.08); }
  66% { transform: translate(${u(100)}, ${u(12)}) scale(0.98, 0.96); }
}
@keyframes ui-gf-drift-light {
  0%, 100% { transform: translate(0, 0) scale(1, 1); }
  33% { transform: translate(${u(-100)}, ${u(-10)}) scale(1.03, 1); }
  66% { transform: translate(${u(85)}, ${u(10)}) scale(0.98, 0.94); }
}
.ui-gf[data-paused] .ui-gf-bleed { animation-play-state: paused; }
.ui-gf-content { position: relative; z-index: 1; height: 100%; }

:where(.dark, [data-theme="dark"]) .ui-gf { --ui-gf-bg: #111113; }

@media (prefers-reduced-motion: reduce) {
  .ui-gf-bleed { animation: none; }
}
`;
