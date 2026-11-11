import React from "react";

import { Button } from "./Button";

export default { title: "Controls/Button", component: Button };

export const Primary = { args: { label: "Save changes" } };
export const LongLabel = {
  args: {
    label: "Save every change made in this session and close the editor",
  },
};
