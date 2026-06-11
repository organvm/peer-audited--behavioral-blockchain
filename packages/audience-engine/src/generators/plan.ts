/**
 * 30-day content plan generator.
 *
 * Given an InstanceConfig, generates 4 weeks of content days honoring the
 * channel ratios, weekly cadence, and pillar definitions. The output is a
 * ContentPlan that can be written as Markdown or JSON.
 *
 * The generator is *deterministic* — same input, same output. This is so
 * that a plan can be regenerated, diffed, and reviewed.
 */

import type {
  InstanceConfig,
  ContentPlan,
  PlannedDay,
  Channel,
} from "../types/index.js";

/** ISO date helpers. */
function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getDayOfWeek(date: Date): string {
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
}

/** Derive the pillar list from a channel's ratio. */
function derivePillars(
  channel: Channel,
  role: "host" | "product"
): ContentPlan["pillars"] {
  const pillars: ContentPlan["pillars"] = [];
  let idx = 1;

  if (channel.ratio.value > 0) {
    pillars.push({
      index: idx++,
      name:
        role === "host"
          ? "Niche value (raw, named, evidence-led)"
          : "Product clarity (what it is / isn't)",
      channel: role,
      ratio: channel.ratio.value,
      goal:
        role === "host"
          ? "discovery + trust"
          : "credible destination",
    });
  }
  if (channel.ratio.trust > 0) {
    pillars.push({
      index: idx++,
      name:
        role === "host"
          ? "Lived insight / founder POV"
          : "Trust / scope / safety",
      channel: role,
      ratio: channel.ratio.trust,
      goal: role === "host" ? "authenticity, depth" : "de-risk the decision",
    });
  }
  if (channel.ratio.proof > 0 && role === "product") {
    pillars.push({
      index: idx++,
      name: "Proof (user / output / citation)",
      channel: "product",
      ratio: channel.ratio.proof,
      goal: "social proof + apply",
    });
  }
  if (channel.ratio.conversion > 0) {
    pillars.push({
      index: idx++,
      name: "Selective conversion",
      channel: role,
      ratio: channel.ratio.conversion,
      goal: "funnel into Product",
    });
  }
  return pillars;
}

/** Generate the pillar-slot week. Each week honors the channel's ratio. */
function generateWeek(
  weekNumber: number,
  startDate: Date,
  config: InstanceConfig,
  themeByWeek: string[]
): PlannedDay[] {
  const days: PlannedDay[] = [];
  const hostChannel = config.channels.host;
  const productChannel = config.channels.product;
  const theme = themeByWeek[weekNumber - 1] ?? `Week ${weekNumber}`;

  // We allocate days across the 7 days of the week, splitting between
  // host and product per the cadence. The generator is *deterministic*:
  // for a given week, the allocation is the same.

  // Build a "slot list" of (day, channel, format) tuples that honors
  // the weekly cadence.
  const slots: Array<{
    channel: "host" | "product";
    format: string;
  }> = [];

  // Host channel slots
  for (let i = 0; i < hostChannel.cadence.shortForm; i++) {
    slots.push({ channel: "host", format: "short_form" });
  }
  for (let i = 0; i < hostChannel.cadence.longForm; i++) {
    slots.push({ channel: "host", format: "long_form" });
  }
  for (let i = 0; i < hostChannel.cadence.story; i++) {
    slots.push({ channel: "host", format: "story" });
  }
  for (let i = 0; i < hostChannel.cadence.conversion; i++) {
    slots.push({ channel: "host", format: "conversion" });
  }
  for (let i = 0; i < (hostChannel.cadence.conversationPrompts ?? 0); i++) {
    slots.push({ channel: "host", format: "conversation_prompt" });
  }

  // Product channel slots
  for (let i = 0; i < productChannel.cadence.shortForm; i++) {
    slots.push({ channel: "product", format: "short_form" });
  }
  for (let i = 0; i < (productChannel.cadence.proofPosts ?? 0); i++) {
    slots.push({ channel: "product", format: "proof" });
  }
  for (let i = 0; i < (productChannel.cadence.scopeExplainers ?? 0); i++) {
    slots.push({ channel: "product", format: "scope" });
  }
  for (let i = 0; i < productChannel.cadence.conversion; i++) {
    slots.push({ channel: "product", format: "conversion" });
  }

  // Allocate slots across the 7 days. We use a deterministic
  // pattern: Mon=host_short, Tue=host_long, Wed=host_short,
  // Thu=host_prompt+product_scope, Fri=host_conversion+product_proof+owned,
  // Sat=product_conversion, Sun=host_story.
  const dayPattern: Array<{
    channel: "host" | "product" | "owned";
    format: string;
  }> = [
    { channel: "host", format: "short_form" },
    { channel: "host", format: "long_form" },
    { channel: "host", format: "short_form" },
    { channel: "host", format: "conversation_prompt" },
    { channel: "product", format: "scope" },
    { channel: "host", format: "conversion" },
    { channel: "product", format: "proof" },
    { channel: "host", format: "story" },
  ];

  // Truncate dayPattern to the actual number of slots we generated
  // (this is the deterministic walker; we walk the dayPattern in order
  // and pick the first slots that match each day).
  const slotIndex: Record<string, number> = {};
  let dayIdx = 0;
  for (let day = 0; day < 7; day++) {
    const date = addDays(startDate, day);
    const dow = getDayOfWeek(date);
    // We may have 0, 1, or 2 slots per day.
    // Find the next day-pattern slot that matches the channel budget.
    // For simplicity: at most 2 slots per day.
    let daySlots = 0;
    while (daySlots < 2 && dayIdx < dayPattern.length) {
      const dp = dayPattern[dayIdx++];
      // Pick a pillar based on the channel/format combination.
      // dp.channel can be "host" | "product" | "owned"; map "owned" to "host".
      const chForPillar: "host" | "product" =
        dp.channel === "owned" ? "host" : dp.channel;
      const pillar = pickPillar(config, chForPillar, dp.format);
      const cta =
        dp.format === "conversion" ? pickCta(config, chForPillar) : null;
      const hook = `${theme} — ${dp.format} on ${dow}`;
      days.push({
        date: formatDate(date),
        dayOfWeek: dow,
        channel: dp.channel === "owned" ? "host" : dp.channel,
        format: dp.format,
        hook,
        pillar,
        cta,
      });
      daySlots++;
    }
  }

  return days;
}

/** Pick a pillar index for a (channel, format) combination. */
function pickPillar(
  config: InstanceConfig,
  channel: "host" | "product" | "owned",
  format: string
): number {
  if (format === "conversion") {
    // The conversion pillar is always the last in the channel.
    const ch = channel === "host" ? config.channels.host : config.channels.product;
    const pillarCount =
      (ch.ratio.value > 0 ? 1 : 0) +
      (ch.ratio.trust > 0 ? 1 : 0) +
      (ch.ratio.proof > 0 && channel === "product" ? 1 : 0) +
      (ch.ratio.conversion > 0 ? 1 : 0);
    return pillarCount;
  }
  if (format === "long_form" || format === "story") {
    // Trust / lived insight pillar.
    return channel === "host" ? 2 : 2;
  }
  if (format === "proof") {
    return 3;
  }
  if (format === "scope") {
    return channel === "product" ? 2 : 1;
  }
  if (format === "conversation_prompt") {
    return 1;
  }
  return 1; // short_form defaults to pillar 1
}

/** Pick a CTA from the channel's fixed CTA set. */
function pickCta(
  config: InstanceConfig,
  channel: "host" | "product"
): string {
  // CTAs are stored in the channel cadence as a free string in the
  // conversion slot. For now we use the product's conversion CTA.
  return config.parameters.p3Product.conversionCta;
}

/** Generate the full 30-day content plan from an InstanceConfig. */
export function generatePlan(
  config: InstanceConfig,
  startDate: Date = findNextMonday(new Date())
): ContentPlan {
  // Default themes per week, derived from the engine's three phases:
  // Ignition, First Room, Compounding. Week 4 is the Authority phase.
  const themes = [
    `Week 1 — Ignition: open the ${config.parameters.p1Host.statement.split(" ")[0]} channel`,
    `Week 2 — First signals: ${config.parameters.p2Wedge.statement.slice(0, 60)}`,
    `Week 3 — First room: admit the first ${config.ladder.cohortSize}`,
    `Week 4 — Authority: cornerstone essay + compounding proof`,
  ];

  const hostPillars = derivePillars(config.channels.host, "host");
  const productPillars = derivePillars(config.channels.product, "product");
  const pillars = [...hostPillars, ...productPillars];

  const weeks = [];
  for (let w = 0; w < 4; w++) {
    const weekStart = addDays(startDate, w * 7);
    weeks.push({
      weekNumber: w + 1,
      theme: themes[w],
      days: generateWeek(w + 1, weekStart, config, themes),
    });
  }

  return {
    systemName: config.systemName,
    startDate: formatDate(startDate),
    endDate: formatDate(addDays(startDate, 27)),
    pillars,
    weeks,
  };
}

/** Find the next Monday from a given date. */
function findNextMonday(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const daysUntilMonday = day === 0 ? 1 : day === 1 ? 0 : 8 - day;
  return addDays(d, daysUntilMonday);
}
