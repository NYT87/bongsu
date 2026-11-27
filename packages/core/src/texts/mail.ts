// The alert emails' wording beyond the notice itself (notify.ts, providers/refresh.ts send them). Change wording here,
// and only here.

/** The end of every alert email: why it came, and where to turn these emails off (Devices & passkeys). `who` is the
 *  role that brought it ("an admin of Demo Travel", "an instance admin"). */
export const alertMailFooter = (o: { who: string; instance: string; publicUrl: string }): string =>
  [
    "",
    "--",
    `You get this because you're ${o.who} on ${o.instance}.`,
    `Turn these emails off in the dashboard (Devices & passkeys → Alert emails): ${o.publicUrl.replace(/\/$/, "")}/dashboard/devices`,
    "You'll still see the notice in the dashboard and in the app's notifications.",
  ].join("\n");
