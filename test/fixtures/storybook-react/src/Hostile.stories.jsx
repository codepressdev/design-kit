import React from "react";

import { Card } from "./Card";

// Stories the capture must still account for; the browser test captures
// them on their own, with a short budget.
export default { title: "Hostile/Card", component: Card };

// A width list with no usable width is no list: the story is captured at
// the planned widths, and its failure there is a gap.
export const ZeroWidths = {
  args: { title: "Zero", children: <p>Malformed widths.</p> },
  parameters: { designKit: { widths: [0] } },
  play: async () => {
    throw new Error("zero widths play");
  },
};

// Holds the main thread: the capture times out, records a gap and finishes.
export const Busy = {
  args: { title: "Busy", children: <p>Never settles.</p> },
  play: async () => {
    // The write keeps the minifier from dropping the loop.
    for (;;) globalThis.__spins = (globalThis.__spins ?? 0) + 1;
  },
};

// Renders, then holds the main thread once settling starts: the settle loop
// reads `__kit.pending`, and once the outcome is "rendered" that read never
// returns. Before that (the request counter) it answers normally, and the
// property is not enumerable, so the outcome read never touches it.
export const BusyAfterRender = {
  args: { title: "Busy after render", children: <p>Rendered, then held.</p> },
  play: async () => {
    const kit = window.__kit;
    let pending = kit.pending;
    Object.defineProperty(kit, "pending", {
      enumerable: false,
      get() {
        if (kit.outcome !== "rendered") return pending;
        for (;;) globalThis.__spins = (globalThis.__spins ?? 0) + 1;
      },
      set(value) {
        pending = value;
      },
    });
  },
};

// Lists only 390 and holds the main thread at any wider window, right after
// storyPrepared: the capture still learns its widths (announced over the
// console), so 1280 is no gap and 390 is captured.
export const PhoneOnlyHeldDesktop = {
  args: { title: "Phone only", children: <p>Held on desktop.</p> },
  parameters: { designKit: { widths: [390] } },
  render: (args) => {
    if (window.innerWidth > 600)
      for (;;) globalThis.__heldDesktop = (globalThis.__heldDesktop ?? 0) + 1;
    return <Card {...args} />;
  },
};
