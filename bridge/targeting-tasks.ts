// Labelled targeting tasks: a page outline, a plain-language target, and the
// element(s) a person would mean. Used by Settings → Test (the first three, via
// the hub) and by `bun run bench:targeting` (all of them, plus pages built from
// test/fixtures.ts). Nothing here is a real person's page.
import { THRESHOLDS, findTarget, type FindResult } from "./jev";
import type { Provider } from "./targeting";

export interface TargetTask {
  id: string;
  page: string;
  url: string;
  title?: string;
  tree: string;
  target: string;
  /** Refs that count as right; null = the target is not on the page (right = "nothing matches"). */
  expect: number[] | null;
}

export const CART = `main
  [1] link "Home"
  [2] link "Deals"
  [3] searchbox "Search products"
  [4] button "Search"
  heading "Your cart (1 item)"
  "Wireless mouse, graphite — €24.99"
  [5] button "Remove Wireless mouse"
  [6] spinbutton "Quantity" ="1"
  [7] textbox "Promo code"
  [8] button "Apply"
  "Subtotal €24.99"
  [9] button "Continue shopping"
  [10] button "Proceed to checkout"
  [11] link "Help"
  [12] link "Returns policy"`;

export const LOGIN = `main
  heading "Sign in to Northwind"
  [1] textbox "Email address"
  [2] textbox "Password" =password
  [3] checkbox "Keep me signed in"
  [4] button "Sign in"
  [5] link "Forgot password?"
  [6] link "Create an account"
  [7] button "Sign in with Google"
  [8] link "Privacy"
  [9] link "Terms"`;

export const TEST_TASKS: TargetTask[] = [
  { id: "cart-pay", page: "cart", url: "https://shop.example/cart", title: "Cart", tree: CART, target: "the button that takes me to payment", expect: [10] },
  { id: "login-password", page: "login", url: "https://northwind.example/login", title: "Sign in", tree: LOGIN, target: "where I type my password", expect: [2] },
  { id: "cart-discount", page: "cart", url: "https://shop.example/cart", title: "Cart", tree: CART, target: "the field for a discount code", expect: [7] },
];

export interface TaskRun {
  task: TargetTask;
  ok: boolean;
  correct: boolean;
  /** The probability the provider gave the outcome it reported (top choice, or "present" for absent tasks). */
  p: number;
  /** Squared gap between that probability and what was right (0 = perfect, 1 = confidently wrong). */
  brier: number;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  calibrated: boolean;
  picked: string;
  error?: string;
}

/** Was the answer right, and how sure was the provider? */
export function scoreFind(task: TargetTask, r: FindResult): { correct: boolean; p: number; brier: number; picked: string } {
  const top = r.ranked[0];
  const picked = r.exists < THRESHOLDS.exists || !top ? `nothing (present ${Math.round(r.exists * 100)}%)` : `[${top.ref}] ${top.role} ${JSON.stringify(top.name)}`;
  if (task.expect == null) return { correct: r.exists < THRESHOLDS.exists, p: r.exists, brier: r.exists ** 2, picked };
  const hit = !!top && task.expect.includes(top.ref);
  const p = top?.p ?? 0;
  return { correct: hit && r.exists >= THRESHOLDS.exists, p, brier: (p - (hit ? 1 : 0)) ** 2, picked };
}

/** Run tasks one after another against one provider. */
export async function runTasks(provider: Provider, tasks: TargetTask[]): Promise<TaskRun[]> {
  const out: TaskRun[] = [];
  for (const task of tasks) {
    const t0 = performance.now();
    try {
      const r = await findTarget({ target: task.target, url: task.url, title: task.title, tree: task.tree, provider });
      const ms = Math.round(performance.now() - t0);
      out.push({ task, ok: true, ...scoreFind(task, r), ms, inputTokens: r.inputTokens, outputTokens: r.outputTokens, calibrated: r.calibrated });
    } catch (e: any) {
      out.push({ task, ok: false, correct: false, p: 0, brier: 1, ms: Math.round(performance.now() - t0), inputTokens: 0, outputTokens: 0, calibrated: false, picked: "-", error: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return out;
}
