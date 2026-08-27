import { z } from "zod";
import { defineTaskEval } from "../src/eval.js";
import { defineEvalTask } from "../src/task.js";

const OkSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string().min(1) }),
]);

const BudgetResultSchema = z.object({ ok: z.boolean() });

const BalancesSchema = z.object({
  perPerson: z.array(z.object({ personId: z.string(), netCents: z.number().int() })),
});

const SettlementSchema = z.object({
  transfers: z.array(z.object({
    fromId: z.string(),
    toId: z.string(),
    amountCents: z.number().int().positive(),
  })),
});

const MonthlySchema = z.object({
  totalCents: z.number().int(),
  byPayer: z.array(z.object({
    personId: z.string(),
    paidCents: z.number().int(),
  })),
});

const BudgetStatusSchema = z.object({
  byCategory: z.array(z.object({
    category: z.string(),
    limitCents: z.number().int().nullable(),
    spentCents: z.number().int(),
    remainingCents: z.number().int().nullable(),
  })),
});

type Expense = {
  id: string;
  description: string;
  payerId: string;
  amountCents: number;
  splitBetween: string[];
  dateIso: string;
  category?: string;
};

interface LedgerApi {
  addExpense(input: Expense): Promise<z.infer<typeof OkSchema>>;
  balances(): Promise<z.infer<typeof BalancesSchema>>;
  settlement(): Promise<z.infer<typeof SettlementSchema>>;
  monthlyTotals(input: { month: string }): Promise<z.infer<typeof MonthlySchema>>;
}

interface BudgetedLedgerApi extends LedgerApi {
  setBudget(input: { category: string; month: string; limitCents: number }): Promise<{ ok: boolean }>;
  budgetStatus(input: { month: string }): Promise<z.infer<typeof BudgetStatusSchema>>;
}

/** Net balance for one person, or null when the ledger does not know them. */
function net(balances: z.infer<typeof BalancesSchema>, personId: string): number | null {
  return balances.perPerson.find(entry => entry.personId === personId)?.netCents ?? null;
}

function canonicalBalances(balances: z.infer<typeof BalancesSchema>) {
  return balances.perPerson
      .map(entry => ({ personId: entry.personId, netCents: entry.netCents }))
      .toSorted((left, right) => left.personId.localeCompare(right.personId));
}

const TURN_ONE_MONTH = "2026-03";
const TURN_ONE_IDS = ["survive-1", "survive-2"];

/**
 * A shared-expense ledger, which is the archetypal thing people build on a platform like this.
 *
 * Most checks assert an invariant rather than a hand-computed constant: balances sum to zero,
 * transfers clear them, and split shares total the expense exactly. An invariant survives an
 * arithmetic slip in the task and still catches the bug it describes, such as per-share rounding that
 * loses a cent.
 */
const task = defineEvalTask({
  id: "expense-ledger",
  turns: [{
    prompt: `Build a Gadget named exactly "Ledger" for tracking shared household expenses between
flatmates and working out who owes whom. I want to add an expense, see everyone's running balance,
and get a short list of payments that settles us up.

Store all money as integer cents. Never use floating point. Keep everything in the Gadget's own
storage so nothing is lost when the server restarts.

It also needs a stable server RPC taking and returning plain data, so I can verify it:

- addExpense({ id: string, description: string, payerId: string, amountCents: integer > 0,
  splitBetween: string[], dateIso: "YYYY-MM-DD" }) -> { ok: true } | { ok: false, error: string }
  The payer paid amountCents on behalf of everyone in splitBetween, split as evenly as integer
  cents allow. When it does not divide evenly, give the leftover cents to the earliest people in
  splitBetween order, so the shares always sum to exactly amountCents.
  Reject these, changing nothing, with exactly these error codes:
    "DUPLICATE_ID"   - an expense with that id already exists
    "INVALID_AMOUNT" - amountCents is not a positive integer
    "EMPTY_SPLIT"    - splitBetween is empty
    "BAD_DATE"       - dateIso is not a YYYY-MM-DD calendar date

- balances() -> { perPerson: Array<{ personId: string, netCents: integer }> }
  netCents is positive when that person is owed money, negative when they owe it. Include everyone
  who appears in any expense as a payer or in a split.

- settlement() -> { transfers: Array<{ fromId: string, toId: string, amountCents: integer > 0 }> }
  Payments that bring every balance to zero. Keep it short: never more transfers than one fewer
  than the number of people with a non-zero balance.

- monthlyTotals({ month: "YYYY-MM" }) -> { totalCents: integer,
  byPayer: Array<{ personId: string, paidCents: integer }> }
  Counting only expenses whose dateIso falls inside that month.`,
    verify: async verifier => {
      await verifier.check("splits-leftover-cents-without-losing-any", async () => {
        using api = await verifier.connect<LedgerApi>("Ledger");
        // 100 split three ways cannot divide evenly; flooring each share would lose a cent.
        const added = await api.addExpense({
          id: "cents-1",
          description: "Milk",
          payerId: "cents-ana",
          amountCents: 100,
          splitBetween: ["cents-ana", "cents-ben", "cents-cy"],
          dateIso: "2026-05-04",
        });
        const balances = BalancesSchema.parse(await api.balances());
        const trio = ["cents-ana", "cents-ben", "cents-cy"].map(id => net(balances, id));
        const [ana, ben, cy] = trio;
        return {
          pass: OkSchema.parse(added).ok &&
            // Ana paid 100 and owes the first, largest share of 34, leaving her owed 66. Flooring
            // every share to 33 would lose a cent and show up as a 65/-33/-33 that does not balance.
            ana === 66 && ben === -33 && cy === -33 &&
            trio.reduce((sum, value) => (sum ?? 0) + (value ?? 0), 0) === 0,
          evidence: { ana, ben, cy },
        };
      });

      await verifier.check("balances-always-sum-to-zero", async () => {
        using api = await verifier.connect<LedgerApi>("Ledger");
        const added = [
          await api.addExpense({
            id: "sum-1",
            description: "Rent",
            payerId: "sum-ana",
            amountCents: 133_337,
            splitBetween: ["sum-ana", "sum-ben", "sum-cy", "sum-dee"],
            dateIso: "2026-05-01",
          }),
          await api.addExpense({
            id: "sum-2",
            description: "Wifi",
            payerId: "sum-ben",
            amountCents: 4_999,
            splitBetween: ["sum-ben", "sum-cy"],
            dateIso: "2026-05-02",
          }),
          await api.addExpense({
            id: "sum-3",
            description: "Cleaner",
            payerId: "sum-cy",
            amountCents: 7,
            splitBetween: ["sum-ana", "sum-ben", "sum-cy", "sum-dee"],
            dateIso: "2026-05-03",
          }),
        ];
        const balances = BalancesSchema.parse(await api.balances());
        const expectedPeople = ["sum-ana", "sum-ben", "sum-cy", "sum-dee"];
        const missingPeople = expectedPeople.filter(personId => net(balances, personId) === null);
        const total = balances.perPerson.reduce((sum, entry) => sum + entry.netCents, 0);
        return {
          pass: added.every(result => OkSchema.parse(result).ok) &&
            missingPeople.length === 0 && total === 0 &&
            balances.perPerson.every(entry => Number.isInteger(entry.netCents)),
          evidence: { total, missingPeople, perPerson: balances.perPerson },
        };
      });

      await verifier.check("settlement-clears-every-balance-and-stays-short", async () => {
        using api = await verifier.connect<LedgerApi>("Ledger");
        const balances = BalancesSchema.parse(await api.balances());
        const settlement = SettlementSchema.parse(await api.settlement());
        const remaining = new Map(balances.perPerson.map(entry => [entry.personId, entry.netCents]));
        const knownEndpoints = settlement.transfers.every(
            transfer => remaining.has(transfer.fromId) && remaining.has(transfer.toId));
        for (const transfer of settlement.transfers) {
          remaining.set(transfer.fromId, (remaining.get(transfer.fromId) ?? 0) + transfer.amountCents);
          remaining.set(transfer.toId, (remaining.get(transfer.toId) ?? 0) - transfer.amountCents);
        }
        const owing = balances.perPerson.filter(entry => entry.netCents !== 0).length;
        const unsettled = [...remaining].filter(([, value]) => value !== 0);
        return {
          pass: owing >= 2 && settlement.transfers.length >= 1 && knownEndpoints &&
            unsettled.length === 0 &&
            settlement.transfers.length <= owing - 1 &&
            settlement.transfers.every(transfer => transfer.fromId !== transfer.toId),
          evidence: {
            transfers: settlement.transfers.length,
            owing,
            knownEndpoints,
            unsettled: Object.fromEntries(unsettled),
          },
        };
      });

      await verifier.check("rejects-bad-input-with-named-codes", async () => {
        using api = await verifier.connect<LedgerApi>("Ledger");
        const valid: Expense = {
          id: "reject-1",
          description: "Beer",
          payerId: "reject-ana",
          amountCents: 500,
          splitBetween: ["reject-ana", "reject-ben"],
          dateIso: "2026-05-05",
        };
        const accepted = OkSchema.parse(await api.addExpense(valid));
        const before = BalancesSchema.parse(await api.balances());
        const rejections = {
          DUPLICATE_ID: OkSchema.parse(await api.addExpense({ ...valid, amountCents: 999 })),
          INVALID_AMOUNT: OkSchema.parse(
              await api.addExpense({ ...valid, id: "reject-2", amountCents: 0 })),
          EMPTY_SPLIT: OkSchema.parse(
              await api.addExpense({ ...valid, id: "reject-3", splitBetween: [] })),
          BAD_DATE: OkSchema.parse(
              await api.addExpense({ ...valid, id: "reject-4", dateIso: "2026-02-31" })),
        };
        const after = BalancesSchema.parse(await api.balances());
        const wrong = Object.entries(rejections)
            .filter(([code, result]) => result.ok || result.error !== code)
            .map(([code, result]) => ({ expected: code, got: result }));
        const beforeState = canonicalBalances(before);
        const afterState = canonicalBalances(after);
        return {
          pass: accepted.ok && wrong.length === 0 &&
            JSON.stringify(beforeState) === JSON.stringify(afterState),
          evidence: { wrong, changedState: JSON.stringify(beforeState) !== JSON.stringify(afterState) },
        };
      });

      await verifier.check("monthly-totals-count-only-that-month", async () => {
        using api = await verifier.connect<LedgerApi>("Ledger");
        const added = [
          await api.addExpense({
            id: TURN_ONE_IDS[0] ?? "survive-1",
            description: "March groceries",
            payerId: "month-ana",
            amountCents: 2_500,
            splitBetween: ["month-ana", "month-ben"],
            dateIso: `${TURN_ONE_MONTH}-05`,
          }),
          await api.addExpense({
            id: TURN_ONE_IDS[1] ?? "survive-2",
            description: "March taxi",
            payerId: "month-ben",
            amountCents: 1_200,
            splitBetween: ["month-ana", "month-ben"],
            dateIso: `${TURN_ONE_MONTH}-31`,
          }),
          await api.addExpense({
            id: "month-outside",
            description: "April rent",
            payerId: "month-ana",
            amountCents: 90_000,
            splitBetween: ["month-ana", "month-ben"],
            dateIso: "2026-04-01",
          }),
        ];
        const march = MonthlySchema.parse(await api.monthlyTotals({ month: TURN_ONE_MONTH }));
        const paid = (personId: string) =>
          march.byPayer.find(entry => entry.personId === personId)?.paidCents ?? null;
        return {
          pass: added.every(result => OkSchema.parse(result).ok) &&
            march.totalCents === 3_700 && paid("month-ana") === 2_500 && paid("month-ben") === 1_200,
          evidence: march,
        };
      });
    },
    verifyAfterAccept: async verifier => {
      await verifier.check("turn-one-state-survives-code-reload", async () => {
        using api = await verifier.connect<LedgerApi>("Ledger");
        const march = MonthlySchema.parse(await api.monthlyTotals({ month: TURN_ONE_MONTH }));
        const duplicate = OkSchema.parse(await api.addExpense({
          id: TURN_ONE_IDS[0] ?? "survive-1",
          description: "Replay after reload",
          payerId: "month-ana",
          amountCents: 1,
          splitBetween: ["month-ana"],
          dateIso: `${TURN_ONE_MONTH}-05`,
        }));
        return {
          pass: march.totalCents === 3_700 && !duplicate.ok &&
            duplicate.error === "DUPLICATE_ID",
          evidence: { march, duplicate },
        };
      });
    },
  }, {
    prompt: `Now I want to see where the money actually goes. Add to the same Gadget:

- addExpense takes an optional category: string. Expenses recorded before this change, and any
  added without one, count as "uncategorized".
- setBudget({ category: string, month: "YYYY-MM", limitCents: integer >= 0 }) -> { ok: boolean }.
  Setting the same category and month again replaces the previous limit.
- budgetStatus({ month: "YYYY-MM" }) -> { byCategory: Array<{ category: string,
  limitCents: integer | null, spentCents: integer, remainingCents: integer | null }> }
  One row per category that either has a budget for that month or had spending in it. Spending
  counts the full expense amount against the month its dateIso falls in. limitCents and
  remainingCents are null when no budget is set. remainingCents is limitCents - spentCents and is
  allowed to go negative.

Everything that already worked must keep working, including the expenses I have already recorded.`,
    verify: async verifier => {
      // Accepting turn one bumps the loader version before this prompt. Missing March rows were not
      // stored durably.
      await verifier.check("expenses-recorded-before-the-change-survive", async () => {
        using api = await verifier.connect<BudgetedLedgerApi>("Ledger");
        const march = MonthlySchema.parse(await api.monthlyTotals({ month: TURN_ONE_MONTH }));
        return {
          pass: march.totalCents === 3_700,
          evidence: march,
        };
      });

      await verifier.check("pre-existing-spending-counts-as-uncategorized", async () => {
        using api = await verifier.connect<BudgetedLedgerApi>("Ledger");
        const status = BudgetStatusSchema.parse(await api.budgetStatus({ month: TURN_ONE_MONTH }));
        const uncategorized = status.byCategory.find(row => row.category === "uncategorized");
        return {
          pass: uncategorized?.spentCents === 3_700 && uncategorized.limitCents === null &&
            uncategorized.remainingCents === null,
          evidence: status,
        };
      });

      await verifier.check("budget-remaining-tracks-spending-and-can-go-negative", async () => {
        using api = await verifier.connect<BudgetedLedgerApi>("Ledger");
        const budgets = [
          BudgetResultSchema.parse(
              await api.setBudget({ category: "food", month: "2026-06", limitCents: 10_000 })),
          BudgetResultSchema.parse(
              await api.setBudget({ category: "food", month: "2026-06", limitCents: 5_000 })),
          BudgetResultSchema.parse(
              await api.setBudget({ category: "travel", month: "2026-06", limitCents: 20_000 })),
        ];
        const added = [
          await api.addExpense({
            id: "budget-1",
            description: "Market",
            payerId: "budget-ana",
            amountCents: 6_500,
            splitBetween: ["budget-ana", "budget-ben"],
            dateIso: "2026-06-02",
            category: "food",
          }),
          await api.addExpense({
            id: "budget-2",
            description: "Train",
            payerId: "budget-ben",
            amountCents: 4_000,
            splitBetween: ["budget-ana", "budget-ben"],
            dateIso: "2026-06-03",
            category: "travel",
          }),
        ];
        const status = BudgetStatusSchema.parse(await api.budgetStatus({ month: "2026-06" }));
        const row = (category: string) => status.byCategory.find(entry => entry.category === category);
        return {
          pass: budgets.every(result => result.ok) &&
            added.every(result => OkSchema.parse(result).ok) &&
            row("food")?.limitCents === 5_000 && row("food")?.spentCents === 6_500 &&
            row("food")?.remainingCents === -1_500 &&
            row("travel")?.limitCents === 20_000 && row("travel")?.spentCents === 4_000 &&
            row("travel")?.remainingCents === 16_000,
          evidence: { budgets, status },
        };
      });

      await verifier.check("turn-one-contract-still-holds", async () => {
        using api = await verifier.connect<BudgetedLedgerApi>("Ledger");
        const duplicate = OkSchema.parse(await api.addExpense({
          id: TURN_ONE_IDS[0] ?? "survive-1",
          description: "Replay",
          payerId: "after-ana",
          amountCents: 111,
          splitBetween: ["after-ana", "after-ben"],
          dateIso: "2026-06-09",
        }));
        const balances = BalancesSchema.parse(await api.balances());
        const settlement = SettlementSchema.parse(await api.settlement());
        const remaining = new Map(balances.perPerson.map(entry => [entry.personId, entry.netCents]));
        for (const transfer of settlement.transfers) {
          remaining.set(transfer.fromId, (remaining.get(transfer.fromId) ?? 0) + transfer.amountCents);
          remaining.set(transfer.toId, (remaining.get(transfer.toId) ?? 0) - transfer.amountCents);
        }
        return {
          pass: !duplicate.ok && duplicate.error === "DUPLICATE_ID" &&
            balances.perPerson.reduce((sum, entry) => sum + entry.netCents, 0) === 0 &&
            [...remaining.values()].every(value => value === 0),
          evidence: {
            duplicate,
            total: balances.perPerson.reduce((sum, entry) => sum + entry.netCents, 0),
          },
        };
      });
    },
  }],
});

defineTaskEval(task);
