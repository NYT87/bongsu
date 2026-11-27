// The running server's version, for the Settings pages (beside the app's own, built into it).
import type { Env } from "@bongsu/core/env";
import pkg from "../package.json";

/** The release (the packages are versioned together) and the commit it was built from (short, as git shows it), null when not given. */
export const serverVersion = (env: Env) => ({ version: pkg.version, commit: env.BONGSU_COMMIT?.slice(0, 7) || null });
