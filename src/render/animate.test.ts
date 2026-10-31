import type { Browser, Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { animationName, animationPlan, beats } from "../animate.js";
import { build } from "../pipeline.js";
import { EDGE } from "../style.js";
import { readSpec, specFiles, withoutAnimation } from "../test-support.js";
import type { AnimationOrder, AnimationPlan, Renderer, RouteMask } from "../types.js";
import { createBrowserRenderer, launchBrowser } from "./browser.js";

interface Rendered {
  plain: string;
  animated: string;
  plan: AnimationPlan;
  keys: string[];
}

async function render(renderer: Renderer, file: string, order: AnimationOrder, dark: boolean): Promise<Rendered> {
  const { spec, layout, drawing } = await build(readSpec(file), renderer.measurer);
  const plan = animationPlan(drawing, beats(spec, layout, drawing.keys, order), animationName(spec, order));
  return {
    plain: await renderer.svg(drawing.elements, { dark, files: drawing.files }),
    animated: await renderer.animatedSvg(drawing.elements, { dark, files: drawing.files, plan }),
    plan,
    keys: drawing.keys,
  };
}

/** A screenshot of an animated SVG with its animation off, as a reader who asks for reduced motion sees it. */
async function atRest(page: Page, svg: string): Promise<Buffer> {
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    await show(page, svg);
    return await page.locator("svg").screenshot();
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
}

/**
 * Sets every animation to `ms`, the dashes of an async line to where they start, and holds what they show there in
 * inline styles, with the animations dropped: a running animation is drawn on a compositor layer of its own, which
 * shades text and curves a little differently.
 */
async function freezeAt(page: Page, ms: number): Promise<string[]> {
  return page.evaluate((ms) => {
    const frozen = document.getAnimations().map((animation) => {
      animation.pause();
      animation.currentTime = (animation as CSSAnimation).animationName.endsWith("-flow") ? 0 : ms;
      const target = (animation.effect as KeyframeEffect).target as SVGElement;
      const { opacity, strokeDasharray, strokeDashoffset } = getComputedStyle(target);
      return { animation, target, style: { opacity, strokeDasharray, strokeDashoffset } };
    });
    for (const { animation, target, style } of frozen) {
      animation.cancel();
      Object.assign(target.style, style);
    }
    return frozen.map(({ style }) => `${style.opacity} ${style.strokeDasharray} ${style.strokeDashoffset}`);
  }, ms);
}

/** The class of every top-level <g> of an SVG, in document order, null where there is none. */
function groupClasses(svg: string): (string | null)[] {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  return [...root.children].filter((child) => child.tagName === "g").map((group) => group.getAttribute("class"));
}

/** Points along a rough path, which roughjs writes as moves and cubic curves alone. */
function along(d: string): [number, number][] {
  const points: [number, number][] = [];
  let from: [number, number] = [0, 0];
  for (const [, command, args] of d.matchAll(/([MC])([^MC]*)/g)) {
    const n = args!.trim().split(/[ ,]+/).map(Number);
    if (command === "M") {
      from = [n[0]!, n[1]!];
      continue;
    }
    for (let at = 0; at + 6 <= n.length; at += 6) {
      const [x1, y1, x2, y2, x, y] = n.slice(at, at + 6) as [number, number, number, number, number, number];
      for (let step = 0; step <= 64; step++) {
        const t = step / 64;
        const [a, b, c, e] = [(1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t ** 2, t ** 3];
        points.push([a * from[0] + b * x1 + c * x2 + e * x, a * from[1] + b * y1 + c * y2 + e * y]);
      }
      from = [x, y];
    }
  }
  return points;
}

/** How far a point is from a polyline. */
function offRoute([px, py]: [number, number], route: [number, number][]): number {
  let nearest = Infinity;
  for (let at = 1; at < route.length; at++) {
    const [ax, ay] = route[at - 1]!;
    const [dx, dy] = [route[at]![0] - ax, route[at]![1] - ay];
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    nearest = Math.min(nearest, Math.hypot(px - ax - t * dx, py - ay - t * dy));
  }
  return nearest;
}

function routeOf(mask: RouteMask): [number, number][] {
  return mask.d.split(/ ?[ML]/).filter(Boolean).map((point) => point.split(" ").map(Number) as [number, number]);
}

async function show(page: Page, svg: string): Promise<void> {
  await page.setContent(`<body style="margin:0;background:#fff">${svg}</body>`);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

describe("[browser] animated SVG", () => {
  let renderer: Renderer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    renderer = await createBrowserRenderer();
    browser = await launchBrowser();
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await renderer?.close();
  });

  for (const file of specFiles) {
    it.each<[string, AnimationOrder]>([
      ["light", "story"],
      ["dark", "layers"],
    ])(`moves every element of ${file} and is the static SVG underneath, %s in %s order`, async (theme, order) => {
      const { plain, animated, plan } = await render(renderer, file, order, theme === "dark");
      const { animated: again } = await render(renderer, file, order, theme === "dark");

      expect(again).toBe(animated);
      expect(withoutAnimation(animated)).toBe(plain);
      expect(await page.evaluate(groupClasses, animated)).toEqual(plan.elements.map((motion) => motion.className ?? null));
      expect(animated.match(/ pathLength="1"/g) ?? []).toHaveLength(plan.elements.filter((motion) => motion.draw).length);
      expect(animated).toContain(`<style class="excalix-animation">${plan.css}</style></defs>`);
      // At rest a mask is its whole stroke, so it hides nothing of the line while the line stays well inside it.
      for (const { draw } of plan.elements) {
        if (!draw) continue;
        const { id, strokeWidth, x, y, width, height } = draw.mask;
        const line = new RegExp(`<path d="([^"]+)"[^>]* mask="url\\(#${id}\\)"`).exec(animated)?.[1];
        expect(line, id).toBeDefined();
        const route = routeOf(draw.mask);
        const points = along(line!);
        // Half the line's width and a pixel each of antialiasing for the line and for the mask's edge.
        const room = strokeWidth / 2 - EDGE.strokeWidth / 2 - 2;
        expect(Math.max(...points.map((point) => offRoute(point, route))), id).toBeLessThanOrEqual(room);
        const inside = ([px, py]: [number, number]) => Math.min(px - x, x + width - px, py - y, y + height - py);
        expect(Math.min(...points.map(inside)), id).toBeGreaterThan(room);
      }
    });
  }

  it.each<[string, AnimationOrder, boolean]>([
    ["examples/order-pipeline.json", "story", false],
    ["examples/order-pipeline.json", "layers", true],
    ["examples/icons.json", "story", false],
    ["examples/icons.json", "layers", true],
  ])("shows only the opening beat of %s at the start and the picture at rest once built, %s order, dark %s", async (file, order, dark) => {
    const { animated, plan } = await render(renderer, file, order, dark);
    const rest = await atRest(page, animated);
    await show(page, animated);

    const opacities = await page.evaluate(() => {
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = 0;
      }
      const groups = [...document.querySelector("svg")!.children].filter((child) => child.tagName === "g");
      return groups.map((group) => getComputedStyle(group).opacity);
    });
    expect(opacities).toEqual(plan.elements.map((motion) => (motion.className === undefined ? "1" : "0")));
    expect(opacities.filter((opacity) => opacity === "1").length).toBeGreaterThan(0);

    // An infinite animation never finishes, so each one is set into the hold, the dashes back to where they start.
    const held = await freezeAt(page, plan.cycle - 1);
    // Whole, solid lines and their masks undashed, and an async line on its own dashes at their starting phase.
    expect(new Set(held)).toEqual(new Set(["1 none 0px", "1 8px, 10px 0px"]));
    expect((await page.locator("svg").screenshot()).equals(rest)).toBe(true);
  });

  it.each<[AnimationOrder, boolean]>([
    ["story", false],
    ["layers", true],
  ])("brings each icon of examples/icons in on its node's beat and draws it as the static SVG does, %s order, dark %s", async (order, dark) => {
    const { plain, animated, plan, keys } = await render(renderer, "examples/icons.json", order, dark);
    const icons = keys.flatMap((key, index) => (key.endsWith(":icon") ? [index] : []));
    expect(icons).toHaveLength(11);

    const drawn = await page.evaluate((svg) => {
      const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
      const groups = [...root.children].filter((child) => child.tagName === "g");
      return {
        icons: groups.flatMap((group, index) => {
          const use = group.querySelector('use[href^="#image-"]');
          return use ? [{ index, filter: use.parentElement!.getAttribute("filter") }] : [];
        }),
        filters: root.querySelectorAll("filter#excalix-dark-image").length,
      };
    }, animated);
    // Each icon is a top-level <g> of its own, which takes its node's class; dark keeps the filter on it that draws it light.
    expect(drawn.icons.map(({ index }) => index)).toEqual(icons);
    expect(drawn.icons.map(({ filter }) => filter)).toEqual(icons.map(() => (dark ? "url(#excalix-dark-image)" : null)));
    expect(drawn.filters).toBe(dark ? 1 : 0);
    for (const index of icons) expect(plan.elements[index]).toEqual(plan.elements[keys.indexOf(keys[index]!.replace(/:icon$/, ""))]);

    const crops = async (ms?: number) => {
      await show(page, ms === undefined ? plain : animated);
      if (ms !== undefined) await freezeAt(page, ms);
      const uses = page.locator('svg use[href^="#image-"]');
      return Promise.all(icons.map((_, at) => uses.nth(at).screenshot()));
    };
    const still = await crops();
    const held = await crops(plan.cycle - 1);
    const opening = await crops(0);
    held.forEach((crop, at) => expect(crop.equals(still[at]!), keys[icons[at]!]).toBe(true));
    opening.forEach((crop, at) => expect(crop.equals(still[at]!), keys[icons[at]!]).toBe(false));
  });

  it("marches the dashes of an async arrow a period every 900 ms, and draws a sync arrow on along its length", async () => {
    const { animated, plan } = await render(renderer, "examples/order-pipeline.json", "story", false);
    await show(page, animated);

    const marching = plan.elements.find((motion) => motion.march)!.march!;
    const line = plan.elements.find((motion) => motion.className?.endsWith("-b3") && motion.draw)!.draw!.mask.className;
    const styles = await page.evaluate(({ marching, line }) => {
      const at = (selector: string, ms: number) => {
        for (const animation of document.getAnimations()) {
          animation.pause();
          animation.currentTime = ms;
        }
        const style = getComputedStyle(document.querySelector(selector)!);
        return `${style.strokeDasharray} ${style.strokeDashoffset}`;
      };
      return { marching: at(`.${marching}`, 450), drawing: at(`.${line}`, 3 * 571 + 571 / 2), drawn: at(`.${line}`, 3 * 571 + 571 + 2) };
    }, { marching, line });

    // Beat 3 of 14 starts at 3 x 571 ms, and its line is half drawn half a beat later.
    expect(plan.cycle).toBe(11194);
    expect(styles.marching).toBe("8px, 10px -9px");
    expect(styles.drawing).toMatch(/^1px 0\.500\d*px$/);
    expect(styles.drawn).toBe("none 0px");
  });

  it("draws a bent arrow on from its source, so a quarter of the way in its last segment is not there yet", async () => {
    const { animated, plan, keys } = await render(renderer, "examples/order-pipeline.json", "story", false);
    // api to pg, three segments, on beat 5 of 14: 571 ms beats, its line drawn on over the whole beat.
    const { mask } = plan.elements[keys.indexOf("edge:1")]!.draw!;
    const points = routeOf(mask);
    const lengths = points.slice(1).map(([x, y], at) => Math.hypot(x - points[at]![0], y - points[at]![1]));
    const route = lengths.reduce((sum, length) => sum + length);
    expect(points).toHaveLength(4);
    // The front of the stroke, half its width ahead of the dash, is still short of the last segment.
    expect(route / 4 + mask.strokeWidth / 2).toBeLessThan(route - lengths.at(-1)!);
    const start = 5 * 571;

    const crop = async (ms: number) => {
      await show(page, animated);
      await freezeAt(page, ms);
      // The last segment in page pixels, clear of its corner and of the arrowhead at its end.
      const clip = await page.evaluate(
        ({ id, from, to, margin }) => {
          const line = document.querySelector(`[mask="url(#${id})"]`) as SVGGraphicsElement;
          const toPage = (x: number, y: number) => new DOMPoint(x, y).matrixTransform(line.getScreenCTM()!);
          const a = toPage(...from);
          const b = toPage(...to);
          const along = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
          const [x0, x1] = [a.x + along.x * margin.corner, b.x - along.x * margin.end].sort((p, q) => p - q);
          const [y0, y1] = [a.y + along.y * margin.corner, b.y - along.y * margin.end].sort((p, q) => p - q);
          return { x: x0! - margin.side, y: y0! - margin.side, width: x1! - x0! + 2 * margin.side, height: y1! - y0! + 2 * margin.side };
        },
        { id: mask.id, from: points.at(-2)!, to: points.at(-1)!, margin: { corner: mask.strokeWidth, end: 30, side: 6 } },
      );
      return page.screenshot({ clip });
    };

    const before = await crop(start - 1);
    expect((await crop(start + 571 / 4)).equals(before)).toBe(true);
    expect((await crop(start + 571 + 200)).equals(before)).toBe(false);
  });

  it("keeps two diagrams inlined in one page each on its own timing", async () => {
    const shown = await Promise.all(
      ["examples/order-pipeline.json", "examples/auth-flow.json"].map((file) => render(renderer, file, "story", false)),
    );
    await page.setContent(`<body style="margin:0;background:#fff">${shown.map(({ animated }) => animated).join("")}</body>`);

    const timings = await page.evaluate(() =>
      [...document.querySelectorAll("body > svg")].map((svg) =>
        document
          .getAnimations()
          .filter((animation) => svg.contains((animation.effect as KeyframeEffect).target))
          .map((animation) => ({ name: (animation as CSSAnimation).animationName, duration: animation.effect!.getTiming().duration })),
      ),
    );

    expect(shown[0]!.plan.cycle).not.toBe(shown[1]!.plan.cycle);
    timings.forEach((own, index) => {
      const { plan } = shown[index]!;
      const name = plan.elements.find((motion) => motion.className)!.className!.replace(/-b\d+$/, "");
      expect(own.length).toBeGreaterThan(0);
      for (const { name: running, duration } of own) {
        expect(running.startsWith(`${name}-`)).toBe(true);
        expect(duration).toBe(running.endsWith("-flow") ? 900 : plan.cycle);
      }
    });
  });

  it("holds still where the reader asks for reduced motion, every element shown", async () => {
    const { animated } = await render(renderer, "examples/order-pipeline.json", "story", false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    try {
      await show(page, animated);

      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      const hidden = await page.evaluate(() =>
        [...document.querySelectorAll('[class^="xa-"]')].filter((element) => {
          const { opacity, strokeDasharray } = getComputedStyle(element);
          return opacity !== "1" || (element.closest("mask") !== null && strokeDasharray !== "none");
        }).length,
      );
      expect(hidden).toBe(0);
    } finally {
      await page.emulateMedia({ reducedMotion: "no-preference" });
    }
  });
});
