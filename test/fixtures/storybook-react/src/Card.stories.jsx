import React from "react";

import { Card } from "./Card";

export default { title: "Pages/Card", component: Card };

export const Default = {
  args: { title: "Billing", children: <p>Your plan renews on 1 January.</p> },
};

// Phone-only: its play looks for what only the phone layout shows, so it
// lists its own widths and the capture never renders it at 1280.
export const PhoneOnly = {
  args: { title: "Phone", children: <p>Only at phone width.</p> },
  parameters: { designKit: { widths: [390] } },
  play: async () => {
    if (window.innerWidth > 600)
      throw new Error("phone element never appeared");
  },
};

// Phone-only and broken: a failure at a width it lists is still a gap.
export const PhoneOnlyBroken = {
  args: { title: "Broken", children: <p>Never captured.</p> },
  parameters: { designKit: { widths: [390] } },
  play: async () => {
    throw new Error("broken at every width");
  },
};
