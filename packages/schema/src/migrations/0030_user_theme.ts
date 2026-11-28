// A person's theme for the dashboard and the app: their own, kept with them so it follows them to every device.
import type { Step } from "../migrate";

export const steps: Step[] = [
  {
    addColumn: {
      table: "users",
      name: "theme",
      column: { type: "text", description: "light or dark; null follows the device's setting" },
    },
  },
];
