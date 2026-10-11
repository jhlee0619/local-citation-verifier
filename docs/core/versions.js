/*
 * Version-selection rules (R1…R24) for bibliography candidates. Every
 * deterministic candidate pick and every LLM answer is validated against the
 * same table (validatePick); a pick that fails stays pending. The rules only
 * choose which representative to recommend or apply; the result status is
 * decided by core/verify.js. DOM-free.
 */
import { isCorrectionTitle, parseYear } from "./text.js?v=20261011-s14";
import {
  clusterKey, clusterRecords, isPublishedFamily, limitRepresentatives, matchingCluster,
  metadataRegressionFields, originalIdentity, publishedClusters, sameWork, versionIdentity,
  yearDriftOk,
} from "./records.js?v=20261011-s14";

  const LLM_MIN_CONFIDENCE = 0.75;

  const RULES = Object.freeze([
    Object.freeze({
      id: "R1_same_work",
      prompt: "Choose only a record that is the same work as the BibTeX entry (title and authors). A different paper is forbidden.",
    }),
    Object.freeze({
      id: "R2_no_correction_swap",
      prompt: "Do not replace a regular paper with a correction, erratum, retraction, or withdrawal, or the reverse.",
    }),
    Object.freeze({
      id: "R3_no_version_downgrade",
      prompt: "If the BibTeX entry is already a clean conference or journal record, do not replace it with a preprint.",
    }),
    Object.freeze({
      id: "R4_original_version_lock",
      prompt: "If the BibTeX entry cleanly names a venue (for example ICLR or a journal) and that version exists, you must choose that version. Do not switch ICLR to NeurIPS or a journal to a different journal.",
    }),
    Object.freeze({
      id: "R5_preprint_upgrade",
      prompt: "If the BibTeX entry is a preprint, mixed, or has no venue, and preferPublished is on, and exactly one clean published version of the same work exists, choose that published version. A one-year preprint-to-venue gap is expected. A different-author unique venue is not an upgrade.",
    }),
    Object.freeze({
      id: "R6_unique_published_venue",
      prompt: "If two or more clean published venues exist (ICLR and a journal, or ICLR and NeurIPS), do not auto-apply. Return needs_review unless the BibTeX venue uniquely matches one of them.",
    }),
    Object.freeze({
      id: "R7_year_drift_ok",
      prompt: "A one-year difference between a preprint and its published version is not a year mismatch. A gap larger than one year requires needs_review.",
    }),
    Object.freeze({
      id: "R8_mixed_is_not_published",
      prompt: "A record that mixes a venue name with an arXiv DOI or URL is not a clean published version. Prefer a clean OpenReview or DBLP conference/journal snapshot of the same work.",
    }),
    Object.freeze({
      id: "R23_dblp_proceedings_over_openreview",
      prompt: "ICLR and COLM keep OpenReview as the venue of record. For NeurIPS, ICML, CVPR, ACL, and other non-OpenReview-native conferences, prefer the DBLP proceedings snapshot over an OpenReview forum copy of the same version.",
    }),
    Object.freeze({
      id: "R9_llm_must_pick_representative",
      prompt: "best must be the 1-based index of a listed version representative. Do not invent a record or pick an intra-cluster duplicate that was not listed.",
    }),
    Object.freeze({
      id: "R10_llm_cannot_violate_lock",
      prompt: "The model may not override R3 or R4. A forbidden downgrade or venue switch is rejected.",
    }),
    Object.freeze({
      id: "R11_low_confidence_pending",
      prompt: "If confidence is below 0.75 or a material risk_flag remains, do not auto-apply. Keep the deterministic version.",
    }),
    Object.freeze({
      id: "R12_not_same_paper",
      prompt: "If no listed representative is the same paper, return not_found / no_same_paper and leave the original version untouched.",
    }),
    Object.freeze({
      id: "R13_prefer_published_off",
      prompt: "If preferPublished is off, keep the original version cluster. Do not upgrade a preprint to a conference or journal.",
    }),
    Object.freeze({
      id: "R14_single_cluster",
      prompt: "If a same-work cluster matches the original version, choose that representative even when extra intra-cluster cores exist. No model choice is required for that lock.",
    }),
    Object.freeze({
      id: "R17_generic_title",
      prompt: "A one- or two-word generic title is not enough to treat a different-author record as the same work. Leave those matches out or return no_same_paper.",
    }),
    Object.freeze({
      id: "R18_author_overlap",
      prompt: "Last-name overlap below 0.3 means a different paper unless the DOI or arXiv ID is identical. Do not auto-apply a different-author fuzzy title.",
    }),
    Object.freeze({
      id: "R19_llm_cannot_override_table",
      prompt: "Model status strings do not override this table. The client rejects a pick that breaks R1-R8 or R10-R12 even when the model says updated.",
    }),
    Object.freeze({
      id: "R20_identifier_same_work",
      prompt: "A shared non-empty DOI or arXiv ID counts as the same work even when the BibTeX authors are corrupted or incomplete.",
    }),
    Object.freeze({
      id: "R21_distinct_venues",
      prompt: "ICLR, COLM, NeurIPS, ICML, ACL, and journals are distinct version clusters. Switching venues requires a unique original-venue lock or an explicit user choice.",
    }),
    Object.freeze({
      id: "R22_corr_is_preprint",
      prompt: "CoRR, arXiv, and 10.48550/arXiv.* records are the same preprint version. Do not treat them as a published upgrade.",
    }),
    Object.freeze({
      id: "R15_keep_original_when_version_missing",
      prompt: "If the BibTeX entry is a clean conference or journal version and providers only returned the preprint, keep the original. Do not auto-apply arXiv.",
    }),
    Object.freeze({
      id: "R24_metadata_regression",
      prompt: "Do not automatically replace an original record with a same-version source snapshot that has fewer authors or materially less page information. Keep the original pending explicit review.",
    }),
  ]);

  const RULE_IDS = Object.freeze(Object.fromEntries(RULES.map(rule => [rule.id, rule.id])));

  function result(action, options = {}) {
    return Object.freeze({
      action,
      ruleId: options.ruleId || "",
      clusterKey: options.clusterKey || "",
      representative: options.representative || null,
      index: Number.isInteger(options.index) ? options.index : -1,
      reviewRequired: options.reviewRequired === true,
      originalStands: options.originalStands === true,
      violations: Object.freeze(options.violations || []),
      reason: options.reason || options.ruleId || "",
      needsLlm: options.needsLlm === true,
    });
  }

  const yearOf = entry => parseYear(entry?.year);

  function isCorrection(entry) {
    return isCorrectionTitle(entry?.title);
  }

  function representativesOf(input) {
    if (Array.isArray(input.representatives) && input.representatives.length)
      return input.representatives;
    return limitRepresentatives(input.clusters || [], {
      original: input.original,
      preferPublished: input.preferPublished === true,
      limit: 3,
    });
  }

  function indexOfRepresentative(reps, candidate) {
    if (!candidate) return -1;
    return reps.findIndex(item =>
      item?._recordSource === candidate._recordSource && item?._recordId === candidate._recordId);
  }

  function materialRiskFlags(flags, original, pick) {
    return (flags || [])
      .map(flag => String(flag || "").toLowerCase().replace(/[-\s]+/g, "_"))
      .filter(flag => {
        if (flag === "year_mismatch" && yearDriftOk(original, pick)) return false;
        return !!flag;
      });
  }

  function analyze(input) {
    const original = input.original || {};
    const grouped = Array.isArray(input.clusters) ? input.clusters : clusterRecords(original, input.candidates || []);
    const identity = originalIdentity(original);
    const reps = representativesOf({ ...input, clusters: grouped });
    const competingPublished = publishedClusters(grouped);
    const published = competingPublished.filter(cluster =>
      sameWork(original, cluster.representative));
    const matched = matchingCluster(grouped, original);
    const cleanPublishedOriginal = isPublishedFamily(identity.family) && identity.clean === true && identity.mixed !== true;
    return {
      original,
      identity,
      clusters: grouped,
      representatives: reps,
      published,
      competingPublished,
      matched,
      cleanPublishedOriginal,
      preferPublished: input.preferPublished === true,
    };
  }

  // A deterministic candidate pick must pass the same table as an LLM pick;
  // a failing pick stays pending with its violations.
  function deterministicPick(ctx) {
    const pick = tablePick(ctx);
    if (pick.action !== "candidate") return pick;
    const violations = validatePick(ctx, pick.representative);
    if (!violations.length) return pick;
    return result("pending", {
      ruleId: violations[0],
      clusterKey: pick.clusterKey,
      representative: pick.representative,
      index: pick.index,
      reviewRequired: true,
      violations,
      reason: `${pick.ruleId} pick failed ${violations.join(", ")}`,
      needsLlm: ctx.representatives.length > 1,
    });
  }

  function tablePick(ctx) {
    const {
      original, identity, representatives, published, competingPublished,
      matched, cleanPublishedOriginal, preferPublished,
    } = ctx;

    if (!representatives.length) {
      return result("original", {
        ruleId: RULE_IDS.R15_keep_original_when_version_missing,
        originalStands: true,
        reason: "no_same_work_representative",
      });
    }

    if (cleanPublishedOriginal && matched && matched.identity.clean !== false && !matched.representative?._versionMixed) {
      if (metadataRegressionFields(original, matched.representative).length) {
        return result("original", {
          ruleId: RULE_IDS.R24_metadata_regression,
          originalStands: true,
          reviewRequired: true,
          representative: matched.representative,
          clusterKey: matched.key,
          index: indexOfRepresentative(representatives, matched.representative),
        });
      }
      return result("candidate", {
        ruleId: RULE_IDS.R4_original_version_lock,
        clusterKey: matched.key,
        representative: matched.representative,
        index: indexOfRepresentative(representatives, matched.representative),
      });
    }

    if (cleanPublishedOriginal && !matched) {
      return result("original", {
        ruleId: RULE_IDS.R15_keep_original_when_version_missing,
        originalStands: true,
        reviewRequired: published.length > 0,
      });
    }

    if (preferPublished && !cleanPublishedOriginal) {
      if (published.length > 1) {
        return result("pending", {
          ruleId: RULE_IDS.R6_unique_published_venue,
          reviewRequired: true,
          needsLlm: true,
        });
      }
      if (published.length === 1) {
        const pick = published[0].representative;
        if (!yearDriftOk(original, pick)) {
          return result("pending", {
            ruleId: RULE_IDS.R7_year_drift_ok,
            reviewRequired: true,
            representative: pick,
            clusterKey: published[0].key,
            index: indexOfRepresentative(representatives, pick),
          });
        }
        return result("candidate", {
          ruleId: RULE_IDS.R5_preprint_upgrade,
          clusterKey: published[0].key,
          representative: pick,
          index: indexOfRepresentative(representatives, pick),
        });
      }
      if ((competingPublished || []).length === 1) {
        const other = competingPublished[0];
        const pick = other.representative;
        if (!sameWork(original, pick)) {
          return result("pending", {
            ruleId: RULE_IDS.R1_same_work,
            reviewRequired: true,
            needsLlm: representatives.length > 1,
            representative: pick,
            clusterKey: other.key,
            index: indexOfRepresentative(representatives, pick),
          });
        }
      }
    }

    if (!preferPublished && matched) {
      return result("candidate", {
        ruleId: RULE_IDS.R13_prefer_published_off,
        clusterKey: matched.key,
        representative: matched.representative,
        index: indexOfRepresentative(representatives, matched.representative),
      });
    }

    if (!preferPublished && identity.family === "preprint") {
      return result("original", {
        ruleId: RULE_IDS.R13_prefer_published_off,
        originalStands: true,
      });
    }

    if (matched) {
      return result("candidate", {
        ruleId: RULE_IDS.R14_single_cluster,
        clusterKey: matched.key,
        representative: matched.representative,
        index: indexOfRepresentative(representatives, matched.representative),
      });
    }

    if (identity.family === "unknown" || identity.mixed) {
      return result("pending", {
        ruleId: identity.mixed ? RULE_IDS.R8_mixed_is_not_published : RULE_IDS.R6_unique_published_venue,
        reviewRequired: true,
        needsLlm: representatives.length > 1,
      });
    }

    return result("original", {
      ruleId: RULE_IDS.R15_keep_original_when_version_missing,
      originalStands: true,
    });
  }

  function forbiddenDowngrade(ctx, pick) {
    if (!pick || !ctx.cleanPublishedOriginal) return false;
    return versionIdentity(pick).family === "preprint";
  }

  function forbiddenVenueSwitch(ctx, pick) {
    if (!pick || !ctx.cleanPublishedOriginal) return false;
    const pickId = versionIdentity(pick);
    return isPublishedFamily(pickId.family) && !matchingCluster([
      { key: clusterKey(pickId, pick), identity: pickId, representative: pick, members: [pick] },
    ], ctx.original);
  }

  function validatePick(ctx, pick, extraViolations) {
    const violations = extraViolations ? extraViolations.slice() : [];
    if (!pick) violations.push(RULE_IDS.R9_llm_must_pick_representative);
    else {
      if (!sameWork(ctx.original, pick)) violations.push(RULE_IDS.R1_same_work);
      if (isCorrection(ctx.original) !== isCorrection(pick)) violations.push(RULE_IDS.R2_no_correction_swap);
      if (forbiddenDowngrade(ctx, pick)) violations.push(RULE_IDS.R3_no_version_downgrade);
      if (forbiddenVenueSwitch(ctx, pick)) violations.push(RULE_IDS.R4_original_version_lock);
      if (metadataRegressionFields(ctx.original, pick).length)
        violations.push(RULE_IDS.R24_metadata_regression);
      if (!yearDriftOk(ctx.original, pick) && yearOf(ctx.original) && yearOf(pick))
        violations.push(RULE_IDS.R7_year_drift_ok);
    }
    return violations;
  }

  function applyLlm(ctx, deterministic, llm) {
    const status = String(llm?.status || "").toLowerCase().replace(/[-\s]+/g, "_");
    const flags = llm?.riskFlags || llm?.risk_flags || [];
    if (status === "not_found" || flags.includes("no_same_paper")) {
      return result("original", {
        ruleId: RULE_IDS.R12_not_same_paper,
        originalStands: true,
        reviewRequired: true,
        violations: [RULE_IDS.R12_not_same_paper],
      });
    }

    let pick = llm?.candidate || null;
    let index = indexOfRepresentative(ctx.representatives, pick);
    if (index < 0 && Number.isInteger(llm?.index) && llm.index >= 0 && llm.index < ctx.representatives.length) {
      index = llm.index;
      pick = ctx.representatives[index];
    }
    const best = Number(llm?.best);
    if (index < 0 && Number.isInteger(best) && best >= 1 && best <= ctx.representatives.length) {
      index = best - 1;
      pick = ctx.representatives[index];
    }

    const violations = validatePick(ctx, pick);
    if (violations.includes(RULE_IDS.R3_no_version_downgrade) || violations.includes(RULE_IDS.R4_original_version_lock)) {
      return result(deterministic.action, {
        ...deterministic,
        ruleId: RULE_IDS.R10_llm_cannot_violate_lock,
        violations,
        reviewRequired: true,
      });
    }
    if (violations.length) {
      return result(deterministic.action, {
        ...deterministic,
        ruleId: violations[0],
        violations,
        reviewRequired: true,
      });
    }

    const remainingFlags = materialRiskFlags(flags, ctx.original, pick);
    const confidence = Number(llm?.confidence);
    if (!Number.isFinite(confidence) || confidence < LLM_MIN_CONFIDENCE || remainingFlags.length) {
      return result(deterministic.action, {
        ...deterministic,
        ruleId: RULE_IDS.R11_low_confidence_pending,
        violations: remainingFlags.length ? [RULE_IDS.R11_low_confidence_pending] : [],
        reviewRequired: true,
      });
    }

    return result("candidate", {
      ruleId: RULE_IDS.R9_llm_must_pick_representative,
      clusterKey: pick._versionClusterKey || clusterKey(versionIdentity(pick), pick),
      representative: pick,
      index,
    });
  }

  // Violations of the rule table for one pick, for callers outside the
  // version decision (core/verify.js checks LLM picks and auto-updates).
  function pickViolations(input, pick) {
    return validatePick(analyze(input), pick);
  }

  function decide(input = {}) {
    const ctx = analyze(input);
    const deterministic = deterministicPick(ctx);
    if (!input.llm) return deterministic;
    return applyLlm(ctx, deterministic, input.llm);
  }

  function needsLlm(input = {}) {
    const ctx = analyze(input);
    const speedMode = String(input.speedMode || "balanced").toLowerCase();
    const deterministic = deterministicPick(ctx);
    if (ctx.representatives.length < 2) return false;
    if (deterministic.needsLlm === true) return true;
    if (deterministic.ruleId === RULE_IDS.R6_unique_published_venue) return true;
    if (deterministic.action === "pending") return true;
    if (speedMode === "thorough" &&
        deterministic.ruleId !== RULE_IDS.R3_no_version_downgrade &&
        deterministic.ruleId !== RULE_IDS.R4_original_version_lock &&
        deterministic.ruleId !== RULE_IDS.R15_keep_original_when_version_missing)
      return true;
    return false;
  }

  function promptInstructions(options = {}) {
    const prefer = options.preferPublished === true
      ? "preferPublished is ON: a unique clean published version beats the preprint."
      : "preferPublished is OFF: keep the original version cluster; do not upgrade a preprint.";
    return [
      "You are choosing among version representatives (arxiv vs conference vs journal), not near-duplicate metadata dumps of the same version.",
      prefer,
      "Version-selection rules (the client rejects violations):",
      ...RULES.map(rule => `${rule.id}: ${rule.prompt}`),
    ].join("\n");
  }

export {
  RULES,
  RULE_IDS,
  LLM_MIN_CONFIDENCE,
  decide,
  pickViolations,
  needsLlm,
  promptInstructions,
  materialRiskFlags,
};
