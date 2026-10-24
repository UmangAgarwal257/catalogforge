import sanitize from "sanitize-html";
import { candidateSchema, type Packet, type Policy, type Validated } from "./contracts";

// Whole descriptions are indivisible facts: no sentence extraction that drops a
// qualification. AI chooses exact source-backed values; paraphrases stay review-only.
export function validateCandidate(input: unknown, packet: Packet, policy: Policy): Validated {
  const candidate = candidateSchema.parse(input);
  const accepted: Validated["accepted"] = [], withheld: Validated["withheld"] = [];
  const issues: Validated["issues"] = candidate.issues.map(() => ({ code: "PROVIDER_REVIEW", field: "product" }));
  const counts = new Map<string, number>();
  candidate.fields.forEach(f => counts.set(f.path, (counts.get(f.path) ?? 0) + 1));
  for (const field of candidate.fields) {
    const facts = field.factIds.map(id => packet.facts.find(f => f.id === id));
    const expectedPath = field.path.startsWith("tags.") ? null : field.path;
    const eligible = facts.filter(f => f && f.variantId === null &&
      (expectedPath ? f.path === expectedPath : f.path.startsWith("attributes.")));
    let code: string | null = null;
    if (!/^(title|descriptionHtml|categoryKey|tags\.[0-9]+|attributes\.[A-Za-z][A-Za-z0-9_]{0,39})$/.test(field.path)) code = "FIELD_NOT_ALLOWED";
    else if (counts.get(field.path)! > 1) code = "DUPLICATE_FIELD";
    else if (packet.blockedFields.includes(field.path)) code = "UNRESOLVED_SOURCE";
    else if (field.origin === "AI_WORDING" || field.origin === "INFERRED_SUGGESTION") code = "UNVERIFIED_SUGGESTION";
    else if (!facts.length || facts.some(f => !f) || eligible.length !== facts.length) code = "EVIDENCE_SCOPE";
    else if (!eligible.every(f => f!.value === field.value && f!.origin === field.origin)) code = "UNSUPPORTED_CLAIM";
    else if (field.path === "categoryKey" && !policy.categories.includes(field.value)) code = "INVALID_CATEGORY";
    else if (field.confidence < policy.confidenceThreshold) code = "LOW_CONFIDENCE";
    // Sanitize again at the output boundary; changed content must be reviewed.
    else if (field.path === "descriptionHtml" && safeHtml(field.value) !== field.value) code = "UNSAFE_DESCRIPTION";
    if (code) { withheld.push(field); issues.push({ code, field: field.path }); }
    else accepted.push(field);
  }
  for (const path of ["title", "descriptionHtml", "categoryKey", "tags", "attributes"]) {
    if (!accepted.some(f => f.path === path || f.path.startsWith(`${path}.`))) issues.push({ code: "FIELD_ABSTAINED", field: path });
  }
  return { accepted, withheld, issues };
}
export const safeHtml = (html: string) => sanitize(html, { allowedTags: ["p", "br", "strong", "em", "ul", "ol", "li"], allowedAttributes: {} });

export function measureValidation(result: Validated, labels: { supported: string[]; requiredQualifications: string[] }) {
  const fields = result.applied ?? result.accepted;
  const factual = fields.filter(f => f.origin === "SUPPLIER_FACT");
  const text = fields.filter(f => f.path === "descriptionHtml").map(f => f.value).join("\n");
  return { acceptedClaims: factual.length, supportedClaimPrecision: factual.length ? factual.filter(f => labels.supported.includes(f.value)).length / factual.length : null,
    qualificationRetention: labels.requiredQualifications.length ? labels.requiredQualifications.filter(q => text.includes(q)).length / labels.requiredQualifications.length : null,
    fieldCoverage: ["title", "descriptionHtml", "categoryKey", "tags", "attributes"].filter(p => fields.some(f => f.path === p || f.path.startsWith(`${p}.`))).length / 5,
    withheldFields: result.withheld.length, abstainedFields: result.issues.filter(i => i.code === "FIELD_ABSTAINED").map(i => i.field) };
}
