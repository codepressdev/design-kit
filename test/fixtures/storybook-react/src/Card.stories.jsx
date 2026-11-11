import React from "react";

import { Card } from "./Card";

export default { title: "Pages/Card", component: Card };

export const Default = {
  args: { title: "Billing", children: <p>Your plan renews on 1 January.</p> },
};
