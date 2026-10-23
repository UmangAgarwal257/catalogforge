import type { GroupingPlan } from "./contracts";

export type Label = { sourceRowId: string; family: string; variant: string | null };
/** Pairwise scores concern automatically applied rows; abstentions stay visible. */
export function measureAccuracy(plan: GroupingPlan, labels: Label[]) {
  const assigned = new Map<string, { family: string; sku: string; automatic: boolean }>();
  for (const group of plan.groups) if (!group.blocked.length) for (const variant of group.variants) for (const row of variant.rowIds)
    assigned.set(row, { family: group.key, sku: variant.sku, automatic: !group.issues.length });
  let falseMerges = 0, falseSplits = 0, truePairs = 0, expectedPairs = 0;
  let variantCorrect = 0, variantAssigned = 0;
  for (const label of labels) {
    const actual = assigned.get(label.sourceRowId);
    if (actual) { variantAssigned++; if (actual.sku === label.variant) variantCorrect++; }
  }
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i]!, b = labels[j]!;
    const x = assigned.get(a.sourceRowId), y = assigned.get(b.sourceRowId);
    if (a.family === b.family) expectedPairs++;
    if (!x?.automatic || !y?.automatic) continue;
    if (x.family === y.family && a.family !== b.family) falseMerges++;
    if (x.family !== y.family && a.family === b.family) falseSplits++;
    if (x.family === y.family && a.family === b.family) truePairs++;
  }
  const automatic = [...assigned.values()].filter(a => a.automatic).length;
  return { rows: labels.length, falseMerges, falseSplits, truePairs, expectedPairs,
    pairPrecision: truePairs + falseMerges ? truePairs / (truePairs + falseMerges) : null,
    pairRecall: expectedPairs ? truePairs / expectedPairs : null,
    variantAssigned, variantAssignmentAccuracy: variantAssigned ? variantCorrect / variantAssigned : null,
    identityCoverage: labels.length ? variantAssigned / labels.length : 0,
    automaticCoverage: labels.length ? automatic / labels.length : 0,
    reviewRate: labels.length ? (labels.length - automatic) / labels.length : 0 };
}
