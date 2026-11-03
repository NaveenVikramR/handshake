// Risk inspector (SPEC §6 step 8, §8): rules plus an LLM, both escalate-only. The result is the most
// severe of the two. Anything that isn't exactly {action, reason} with a known action is step_up
// (rules/llm.md); the inspector can never turn a failed check into a pass.
import { readFileSync } from "node:fs";
import OpenAI from "openai";
import { z } from "zod";

export type RiskAction = "none" | "step_up" | "block";
export interface RiskVerdict {
  action: RiskAction;
  reason: string;
}

export interface RiskInput {
  path: "passkey" | "mandate";
  userId: string;
  totalMinor: number;
  items: { sku: string; name: string; qty: number; unitMinor: number }[];
  /** Orders this user placed in the last 10 minutes. */
  recentOrders: number;
}

export interface RiskInspector {
  inspect(input: RiskInput): Promise<RiskVerdict>;
}

export const RISK_VELOCITY_LIMIT = 5;
/** An unattended (mandate) order above this asks the human anyway. */
export const RISK_UNATTENDED_MAX_MINOR = 20_000;

const SEVERITY: Record<RiskAction, number> = { none: 0, step_up: 1, block: 2 };
export const worst = (a: RiskVerdict, b: RiskVerdict) => (SEVERITY[b.action] > SEVERITY[a.action] ? b : a);

export function ruleVerdict(input: RiskInput): RiskVerdict {
  if (input.recentOrders >= RISK_VELOCITY_LIMIT) return { action: "step_up", reason: "many orders in 10 minutes" };
  if (input.path === "mandate" && input.totalMinor > RISK_UNATTENDED_MAX_MINOR) {
    return { action: "step_up", reason: "large unattended order" };
  }
  return { action: "none", reason: "rules passed" };
}

const Verdict = z.strictObject({ action: z.enum(["none", "step_up", "block"]), reason: z.string().max(300) });

/** Parses the model's reply; anything unexpected is step_up. */
export function parseVerdict(text: string | null | undefined): RiskVerdict {
  try {
    const json = JSON.parse((text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as unknown;
    const v = Verdict.safeParse(json);
    if (v.success) return v.data;
  } catch {
    // fall through
  }
  return { action: "step_up", reason: "risk model reply unreadable" };
}

export type RiskModel = (system: string, user: string) => Promise<string | null>;

const SYSTEM = readFileSync(new URL("./prompts/risk.md", import.meta.url), "utf8");

export function openAIRiskModel(opts: {
  baseURL: string;
  apiKey: string;
  model: string;
  fetch?: typeof fetch;
}): RiskModel {
  const client = new OpenAI({
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    timeout: 15_000,
    maxRetries: 1,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  return async (system, user) => {
    const res = await client.chat.completions.create({
      model: opts.model,
      temperature: 0,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    return res.choices[0]?.message?.content ?? null;
  };
}

/** Rules + model. A model error or timeout is step_up, never none. */
export function riskInspector(model: RiskModel): RiskInspector {
  return {
    async inspect(input) {
      const rules = ruleVerdict(input);
      if (rules.action === "block") return rules;
      // Names come from our own catalog, but treat them as data all the same.
      const order = JSON.stringify({
        path: input.path,
        totalMinor: input.totalMinor,
        items: input.items.map((i) => ({ name: i.name.replace(/[<>]/g, ""), qty: i.qty, unitMinor: i.unitMinor })),
      });
      let llm: RiskVerdict;
      try {
        llm = parseVerdict(await model(SYSTEM, `<order>${order}</order>`));
      } catch {
        llm = { action: "step_up", reason: "risk model unavailable" };
      }
      return worst(rules, llm);
    },
  };
}
