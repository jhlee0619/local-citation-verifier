/*
 * Entry cards: header and status tag, hints, the candidate panel, field rows
 * and pills, and the parse-error list above the cards. A card's markup is a
 * pure function of its result and view (decision, field edits, settings);
 * clicks and typing on a card report through the actions main.js passes to
 * bindCardEvents and only restyle the row they touch.
 */
import { html, setHTML, safeUrl } from "./dom.js?v=20261012-s17";
import { entryVenue, stripLatex } from "../core/text.js?v=20261012-s17";
import { DBLP_API, ON_GITHUB_PAGES, OPENREVIEW_API } from "../core/providers.js?v=20261012-s17";
import * as Rec from "../core/records.js?v=20261012-s17";
import * as D from "../core/verify.js?v=20261012-s17";
import * as Out from "../core/output.js?v=20261012-s17";

  // ─── Hint text ─────────────────────────────────────────────────────
  const PROVIDER_NAMES = ["CrossRef", "PubMed", "Semantic Scholar", ...(DBLP_API ? ["DBLP"] : []), ...(OPENREVIEW_API ? ["OpenReview"] : [])];

  function providerList(conjunction, serialComma = true) {
    if (PROVIDER_NAMES.length < 2) return PROVIDER_NAMES[0] || "metadata providers";
    const leading = PROVIDER_NAMES.slice(0, -1);
    if (leading.length === 1) return `${leading[0]} ${conjunction} ${PROVIDER_NAMES.at(-1)}`;
    return `${leading.join(", ")}${serialComma ? "," : ""} ${conjunction} ${PROVIDER_NAMES.at(-1)}`;
  }

  const EVIDENCE_TEXT = {
    en: {
      reviewPrefix: "The closest database record may not be the paper you meant",
      reviewMiddle: "title similarity to",
      reviewAction: "Review the suggestions below and use the checkmark on each row to adopt a value, or keep your original text.",
      localLlmReason: " Local LLM reason: ",
      notFoundWithTitle: `No matching publication was found in ${providerList("and")} for this title. Try fixing typos or adding missing words, then re-run verification, or check the reference manually.`,
      notFoundNoTitle: "This entry has no title, so it cannot be looked up automatically. Add a title in your .bib file or verify the entry by hand.",
      lookupFailed: "Publication lookup failed before the databases could answer. This is usually rate limiting or an upstream outage, not evidence that the paper is missing. Use Retry failed lookups, or re-run verification later.",
      proxyMissing: "No database was asked: this page's server does not answer as the local metadata proxy (/api/health). Start the app with run-local.cmd or server/vllm_proxy_server.py and reload, or use the GitHub Pages build. This is not evidence that the paper is missing.",
      providerUnavailable: names => `${names} did not answer (rate limited or unavailable), so this entry could not be checked against every database. This is not evidence that the paper is missing or wrong. Use Retry failed lookups, or re-run verification later.`,
      wrongAuthors: "A record with this exact title exists, but its authors differ — check this citation. The record is shown below as a choice; nothing was applied.",
      wrongYear: "A record with this exact title exists, but its year differs — check this citation. The record is shown below as a choice; nothing was applied.",
      discoveryOnly: "Semantic Scholar only — not confirmed by Crossref, PubMed, arXiv, DBLP or OpenReview",
      pagesUnconfirmed: "On GitHub Pages only Crossref and PubMed can confirm a record (no arXiv, DBLP or OpenReview access), so this happens more often than with the local proxy.",
      lint: {
        key_year_mismatch: note => `The citation key names ${note.keyYear}, but the year field is ${note.year}.`,
        inproceedings_arxiv_venue: () => "@inproceedings with an arXiv/preprint venue: cite the preprint as @misc or @article, or give the conference.",
        author_placeholder: () => "The author list uses “others” / “et al.”; list the authors if your style needs them all.",
        missing_identifier: () => "No DOI, PMID, PMCID or arXiv ID.",
        missing_venue: note => `No ${note.field} for this @${note.field === "journal" ? "article" : "inproceedings"}.`,
      },
      reasons: {
        unconfirmed_source: "Only Semantic Scholar lists this work; no Crossref, PubMed, arXiv, DBLP or OpenReview record confirms it. Keep your original if you know it is right, or choose the record below.",
        id_title_mismatch: "Your entry's DOI or arXiv ID points to a record with a different title: either the identifier or the title is wrong.",
        id_conflict: "Your entry's DOI and arXiv ID point to different works. Keep the identifier that belongs to the cited paper.",
        doi_conflict: "The matching record has a different DOI than your entry.",
        pmid_conflict: "Your entry's PMID or PMCID belongs to no record, while the matching record has another one.",
        doi_unconfirmed: "The work matches the record below, but the DOI in your entry could not be found (Crossref, DataCite): fix or remove it.",
        arxiv_unconfirmed: "The work matches the record below, but the arXiv ID in your entry could not be found (arXiv, DataCite): fix or remove it.",
        pmid_unconfirmed: "The work matches the record below, but the PMID or PMCID in your entry could not be found in PubMed: fix or remove it.",
        core_conflict: "The databases disagree about this work's title, authors or year. Choose one complete record, or keep yours.",
        version_change_without_id: "Another version of this work was found (preprint vs. published). Your entry has no DOI or arXiv ID that settles which one you cite, so choose a version or keep yours.",
        core_change_without_id: "A record of this work differs from your entry in authors, year, venue or type, and your entry has no DOI or arXiv ID to confirm it. Compare the fields below and choose.",
        identifier_record_not_auto_applicable: "The record your DOI or arXiv ID identifies cannot be applied automatically (it is incomplete). Compare it below and choose.",
        identifier_record_changes_type_or_venue: "The record your DOI identifies would change your entry type, replace the venue with a series name or shorten it, so it was not applied. Compare it below and choose.",
        doi_round_trip_failed: "A matching record was found, but its DOI could not be confirmed, so nothing was added automatically.",
        metadata_conflict: "Volume, issue, pages, venue or author metadata conflicts with the matching record.",
        judge_risk: "The AI judge flagged a risk for this match.",
        integrity: "Your entry's own fields conflict (see the input-integrity note). Choose a complete record, or keep yours after fixing it.",
      },
    },
    ko: {
      reviewPrefix: "가장 가까운 데이터베이스 기록이 의도한 논문과 다를 수 있습니다",
      reviewMiddle: "제목 유사도:",
      reviewAction: "아래 제안을 검토한 뒤 각 행의 값을 채택하거나 원래 값을 유지하세요.",
      localLlmReason: " 로컬 LLM 근거: ",
      notFoundWithTitle: `${providerList("및", false)}에서 이 제목과 일치하는 출판물을 찾지 못했습니다. 오타나 누락된 단어를 고친 뒤 다시 검증하거나 직접 확인하세요.`,
      notFoundNoTitle: "이 항목에는 title이 없어 자동 조회할 수 없습니다. .bib 파일에 title을 추가하거나 직접 확인하세요.",
      lookupFailed: "데이터베이스가 응답하기 전에 조회가 실패했습니다. 보통 rate limit 또는 upstream 장애이며, 논문이 없다는 뜻은 아닙니다. ‘실패한 조회 다시 시도’를 쓰거나 잠시 뒤 다시 실행하세요.",
      proxyMissing: "어떤 데이터베이스에도 묻지 않았습니다. 이 페이지의 서버가 로컬 메타데이터 프록시(/api/health)로 응답하지 않습니다. run-local.cmd 또는 server/vllm_proxy_server.py로 앱을 실행한 뒤 새로고침하거나 GitHub Pages 빌드를 쓰세요. 논문이 없다는 뜻은 아닙니다.",
      providerUnavailable: names => `${names}이(가) 응답하지 않아(rate limit 또는 장애) 모든 데이터베이스로 확인하지 못했습니다. 논문이 없거나 틀렸다는 뜻은 아닙니다. ‘실패한 조회 다시 시도’를 쓰거나 잠시 뒤 다시 실행하세요.`,
      wrongAuthors: "이 제목과 정확히 같은 기록이 있지만 저자가 다릅니다. 인용을 확인하세요. 아래에 선택지로만 표시했고 적용하지 않았습니다.",
      wrongYear: "이 제목과 정확히 같은 기록이 있지만 연도가 다릅니다. 인용을 확인하세요. 아래에 선택지로만 표시했고 적용하지 않았습니다.",
      discoveryOnly: "Semantic Scholar에만 있음 — Crossref, PubMed, arXiv, DBLP, OpenReview로 확인되지 않음",
      pagesUnconfirmed: "GitHub Pages에서는 Crossref와 PubMed만 기록을 확인할 수 있어(arXiv, DBLP, OpenReview 접근 불가) 로컬 프록시보다 이런 경우가 많습니다.",
      lint: {
        key_year_mismatch: note => `인용 키의 연도(${note.keyYear})가 year 필드(${note.year})와 다릅니다.`,
        inproceedings_arxiv_venue: () => "@inproceedings인데 venue가 arXiv/프리프린트입니다. 프리프린트는 @misc 또는 @article로 쓰거나 학회명을 넣으세요.",
        author_placeholder: () => "author에 “others” / “et al.”이 있습니다. 스타일이 전체 저자를 요구하면 모두 적으세요.",
        missing_identifier: () => "DOI, PMID, PMCID, arXiv ID가 없습니다.",
        missing_venue: note => `이 @${note.field === "journal" ? "article" : "inproceedings"}에 ${note.field}가 없습니다.`,
      },
      reasons: {
        unconfirmed_source: "이 논문은 Semantic Scholar에만 있고, 이를 확인하는 Crossref, PubMed, arXiv, DBLP, OpenReview 기록이 없습니다. 원래 값이 맞다면 유지하고, 아니면 아래 기록을 고르세요.",
        id_title_mismatch: "항목의 DOI 또는 arXiv ID가 제목이 다른 기록을 가리킵니다. 식별자나 제목 중 하나가 틀렸습니다.",
        id_conflict: "항목의 DOI와 arXiv ID가 서로 다른 논문을 가리킵니다. 인용한 논문의 식별자만 남기세요.",
        doi_conflict: "일치하는 기록의 DOI가 항목의 DOI와 다릅니다.",
        pmid_conflict: "항목의 PMID 또는 PMCID에 해당하는 기록이 없고, 일치하는 기록에는 다른 값이 있습니다.",
        doi_unconfirmed: "논문은 아래 기록과 일치하지만 항목의 DOI를 찾을 수 없습니다(Crossref, DataCite). DOI를 고치거나 지우세요.",
        arxiv_unconfirmed: "논문은 아래 기록과 일치하지만 항목의 arXiv ID를 찾을 수 없습니다(arXiv, DataCite). 고치거나 지우세요.",
        pmid_unconfirmed: "논문은 아래 기록과 일치하지만 항목의 PMID 또는 PMCID를 PubMed에서 찾을 수 없습니다. 고치거나 지우세요.",
        core_conflict: "데이터베이스마다 이 논문의 제목·저자·연도가 다릅니다. 완전한 기록 하나를 고르거나 원래 값을 유지하세요.",
        version_change_without_id: "이 논문의 다른 버전(프리프린트/출판본)이 있습니다. 항목에 어느 쪽인지 정할 DOI나 arXiv ID가 없으니 버전을 고르거나 원래 값을 유지하세요.",
        core_change_without_id: "이 논문의 기록이 항목과 저자·연도·venue·유형에서 다르고, 항목에 이를 확인할 DOI나 arXiv ID가 없습니다. 아래 필드를 비교해 선택하세요.",
        identifier_record_not_auto_applicable: "DOI 또는 arXiv ID가 가리키는 기록을 자동 적용할 수 없습니다(불완전한 기록). 아래에서 비교해 선택하세요.",
        identifier_record_changes_type_or_venue: "DOI가 가리키는 기록을 적용하면 항목 유형이 바뀌거나 venue가 시리즈명·더 짧은 이름으로 바뀌므로 적용하지 않았습니다. 아래에서 비교해 선택하세요.",
        doi_round_trip_failed: "일치하는 기록을 찾았지만 그 DOI를 확인하지 못해 자동으로 추가하지 않았습니다.",
        metadata_conflict: "권·호·쪽·venue 또는 저자 메타데이터가 일치하는 기록과 충돌합니다.",
        judge_risk: "AI 판정기가 이 매칭에 위험 신호를 표시했습니다.",
        integrity: "항목 자체의 필드가 서로 충돌합니다(입력 무결성 안내 참고). 완전한 기록을 고르거나, 고친 뒤 원래 값을 유지하세요.",
      },
    },
  };

  const MIXED_TEXT = "Mixed-source core metadata · explicit user choices are preserved with provenance.";
  const RESOLVED = { isReviewResolved: D.isReviewResolved };

  const X_ICON = html`<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  const JUMP_ICON = html`<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>`;

  // ─── Notices ───────────────────────────────────────────────────────
  const NOTICE_NAMES = {
    retraction: "Retracted",
    partial_retraction: "Partially retracted",
    withdrawal: "Withdrawn",
    removal: "Removed",
    expression_of_concern: "Expression of concern",
    correction: "Correction",
    erratum: "Erratum",
    corrigendum: "Corrigendum",
    addendum: "Addendum",
    clarification: "Clarification",
    new_version: "New version",
    new_edition: "New edition",
  };

  function noticeDetail(notice) {
    const where = notice.doi ? `notice ${notice.doi}`
      : notice.pmid ? `notice PMID ${notice.pmid}`
        : notice.source === "pubmed" ? "PubMed publication type" : "stamped in the record's title";
    return `${notice.label || NOTICE_NAMES[notice.type]} (${where}${notice.date ? `, ${notice.date}` : ""}${notice.source && notice.source !== "title" ? `, via ${notice.source}` : ""})`;
  }

  // One tag per notice type: serious ones as a status-style tag, the others
  // as informational badges.
  function noticeTags(notices) {
    const types = [...new Set((notices || []).map(notice => notice.type))];
    return types.map(type => {
      const details = notices.filter(notice => notice.type === type).map(noticeDetail).join("; ");
      return Rec.isSeriousNotice({ type })
        ? html`<span class="status-tag tag-notice-serious" data-notice-tag="${type}" title="${details}">${NOTICE_NAMES[type] || type}</span>`
        : html`<span class="notice-badge" data-notice-badge="${type}" title="${details}">${NOTICE_NAMES[type] || type}</span>`;
    });
  }

  // The prominent flag for a serious notice on the work the entry exports.
  function noticeFlag(notices) {
    const serious = Out.seriousNotices(notices);
    if (!serious.length) return "";
    const names = [...new Set(serious.map(notice => NOTICE_NAMES[notice.type] || notice.type))].join(", ");
    const listers = Out.noticeListers(serious);
    return html`<div class="review-hint notice-flag" data-notice-flag role="alert"><strong>${names}:</strong> ${listers} ${listers.includes(" and ") ? "list" : "lists"} ${serious.map(noticeDetail).join("; ")} for this work. The status above is unchanged; export asks you to confirm citing it.</div>`;
  }

  // Non-blocking notes on the entry's own fields (Rec.lintNotes); they never
  // change the status.
  function lintMarkup(entry, t) {
    const notes = Rec.lintNotes(entry);
    if (!notes.length) return "";
    return html`<div class="lint-notes" data-lint-notes>${notes.map(note =>
      html`<span class="lint-note" data-lint-note="${note.code}">${t.lint[note.code]?.(note) || note.code}</span>`)}</div>`;
  }

  // ─── Markup ────────────────────────────────────────────────────────
  // "pending", "original", "exclude" or "candidate:<index>".
  function selectedChoice(r, decision) {
    const choices = r.candidate_choices || [];
    if (!D.isReviewResolved({ review_required: r.review_required, decision, candidates: choices })) return "pending";
    if (decision.action === "exclude" || decision.action === "original") return decision.action;
    const index = choices.indexOf(D.resolveCandidate(choices, decision));
    return index >= 0 ? `candidate:${index}` : "pending";
  }

  function provenanceMarkup(entry, candidate) {
    const provenance = Rec.candidateProvenance(entry || {}, candidate || {});
    const notes = (provenance.warnings.length ? provenance.warnings : provenance.diagnostics).slice();
    return html`<div class="candidate-provenance">
      <span class="provenance-confidence provenance-${provenance.confidence.toLowerCase()}">${provenance.confidence}</span>
      ${provenance.badges.map(badge => html`<span class="provenance-badge provenance-${badge.tone || "source"}">${badge.label}</span>`)}
      ${notes.length ? html`<div class="candidate-provenance-notes">${notes.map(note => html`<span>${note}</span>`)}</div>` : ""}
    </div>`;
  }

  function candidateMeta(candidate) {
    const venue = entryVenue(candidate);
    return [
      candidate.year ? `Year ${candidate.year}` : "",
      venue ? `Venue ${venue}` : "",
      candidate._coreSource ? `Source ${candidate._coreSource}` : "",
      candidate._recordId ? `Record ID ${candidate._recordId}` : "",
      candidate.doi ? `DOI ${candidate.doi}` : "",
      candidate.pmid ? `PMID ${candidate.pmid}` : "",
      candidate.pmcid ? `PMCID ${candidate.pmcid}` : "",
      Number.isFinite(candidate._crossrefScore) ? `Crossref score ${candidate._crossrefScore.toFixed(1)}` : "",
    ].filter(Boolean).join(" · ");
  }

  function candidatePanel(r, entry, decision, selected, t) {
    const choices = r.candidate_choices || [];
    if (choices.length < 1 && !r.review_required) return "";
    const recommendedIndex = selected === "pending" && Number.isInteger(r.recommended_candidate_index)
      ? r.recommended_candidate_index
      : -1;
    const rows = choices.map((candidate, index) => {
      const openUrl = safeUrl(candidate._paperUrl || Rec.paperUrlForEntry(candidate));
      const score = Math.round(Rec.candidateScore(candidate, entry || {}, {
        preferPublished: r.run_snapshot?.preferPublished === true,
      }));
      const scored = Number.isFinite(score);
      const isRecommended = index === recommendedIndex;
      return html`<div class="candidate-option ${selected === `candidate:${index}` ? "active" : ""}${isRecommended ? " is-recommended" : ""}" data-candidate-row="${index}">
        <button class="candidate-option-btn" type="button" data-entry="${r.index}" data-choice-action="candidate" data-candidate-index="${index}" data-record-source="${candidate._recordSource || ""}" data-record-id="${candidate._recordId || ""}">
          <span class="candidate-rank">${index + 1}</span>
          <span class="candidate-main">
            ${isRecommended ? html`<span class="candidate-recommended-label">Recommended</span>` : ""}
            <span class="candidate-title" data-candidate-title>${candidate.title || "(untitled candidate)"}</span>
            ${candidate._notices?.length ? html`<span class="candidate-notices">${noticeTags(candidate._notices)}</span>` : ""}
            ${Rec.sourceAuthority(candidate) === "discovery" ? html`<span class="candidate-source-badge" data-source-authority="discovery">${t.discoveryOnly}</span>` : ""}
            <span class="candidate-meta" data-candidate-meta>${candidateMeta(candidate)}</span>
            ${provenanceMarkup(entry, candidate)}
          </span>
          <span class="candidate-score" data-candidate-score title="Composite metadata ranking score; not a percentage." aria-label="${scored ? `Metadata score ${score}; composite ranking score, not a percentage` : "Metadata score unavailable; composite ranking score, not a percentage"}">${scored ? `Metadata score ${score}` : ""}</span>
        </button>
        ${openUrl ? html`<a class="candidate-open-link" href="${openUrl}" target="_blank" rel="noopener" title="Open paper page">Open paper</a>` : ""}
      </div>`;
    });

    const aiReason = String(r.ai_reason || "").trim();
    let decisionCopy = "";
    if (selected === "pending") {
      decisionCopy = html`<div class="candidate-decision-state" role="status"><strong>Decision required.</strong> ${aiReason || "Confirm a candidate, keep the original, or exclude this entry."}</div>`;
    } else if (selected.startsWith("candidate:") && r.auto_select_source === "identifier") {
      decisionCopy = html`<div class="candidate-decision-state is-auto-selected" role="status">Updated from the record your DOI/arXiv ID identifies · switch candidate, keep original, or exclude if wrong.</div>`;
    } else if (selected === "original" && r.auto_select_source === "additive" && decision.touched !== true) {
      decisionCopy = html`<div class="candidate-decision-state is-auto-selected" role="status">Missing fields added from one matching record (${(r.additive_fields || []).join(", ")}); existing values unchanged · keep original to undo.</div>`;
    }
    return html`<div class="candidate-panel">
      <div class="candidate-panel-head">
        <span>Candidate choices</span>
        <span>${choices.length} shown · ordered by metadata score</span>
      </div>
      ${decisionCopy}
      <div class="candidate-options">${rows}</div>
      <div class="candidate-control-row">
        <button class="candidate-control-btn ${selected === "original" ? "active" : ""}" type="button" data-entry="${r.index}" data-choice-action="original">Keep original</button>
        <button class="candidate-control-btn danger ${selected === "exclude" ? "active" : ""}" type="button" data-entry="${r.index}" data-choice-action="exclude">Exclude from export</button>
      </div>
    </div>`;
  }

  function reviewHint(r, t) {
    if (r.status === "lookup_failed" && r.lookup_error) {
      if (r.reason === "proxy_missing") return t.proxyMissing;
      if (r.reason === "provider_unavailable" && r.unavailable_providers?.length) return t.providerUnavailable(r.unavailable_providers.join(", "));
      return t.lookupFailed;
    }
    if (r.status !== "needs_review" || !r.found_title) return null;
    // The records and fields behind a review the field rows do not show.
    const detail = r.review_detail ? html` <span class="review-hint-detail" data-review-detail>${r.review_detail}.</span>` : "";
    return reviewHintText(r, t, detail);
  }

  function reviewHintText(r, t, detail) {
    const titleOnly = (r.review_reasons || []).find(reason => reason === "wrong_authors" || reason === "wrong_year");
    if (titleOnly) return titleOnly === "wrong_year" ? t.wrongYear : t.wrongAuthors;
    // Name the actual review reason; the "may not be the paper you meant"
    // wording is only for genuinely uncertain title matches.
    const reason = (r.review_reasons || []).find(code => t.reasons[code]);
    const llm = r.ai_reason ? html`${t.localLlmReason}${r.ai_reason}` : "";
    if (reason === "unconfirmed_source")
      return html`${t.reasons[reason]}${ON_GITHUB_PAGES ? ` ${t.pagesUnconfirmed}` : ""}${detail}${llm}`;
    if (reason) return html`${t.reasons[reason]}${detail} ${t.reviewAction}${llm}`;
    return html`${t.reviewPrefix} (<strong>${r.title_score}%</strong> ${t.reviewMiddle} <strong class="review-hint-match">${r.found_title}</strong>).${detail} ${t.reviewAction}${r.ai_reason ? html`${t.localLlmReason}${r.ai_reason}` : ""}`;
  }

  // The field rows: field diffs, the "Max authors" projection (display only,
  // never an edit) and the collapsed other fields.
  function fieldTables(r, view, selectedCandidate, diffs, others, edits, hasSuggestion) {
    const { entry, maxAuthors } = view;
    const idx = r.index;
    const provenanceLabel = field => {
      const provenance = selectedCandidate?._fieldProvenance?.[field];
      return provenance ? html`<span class="field-provenance">${provenance.source} · ${provenance.candidateId}</span>` : "";
    };
    const authorValue = D.resolveCandidate(r.candidate_choices || [], view.decision)?.author || entry.author || "";
    const truncated = maxAuthors > 0 && r.status !== "not_found" && !diffs.some(diff => diff.field === "author") &&
      authorValue.split(/\s+and\s+/i).length > maxAuthors ? Out.truncateAuthors(authorValue, maxAuthors) : "";
    const rows = diffs.map(diff => {
      const isEnrichment = !(diff.original || "").trim();
      const fe = edits[diff.field];
      const action = fe.action;
      const suggestion = action === "custom" ? fe.value || "" : diff.found || "";
      const shown = diff.field === "author" && maxAuthors > 0 && action !== "custom" ? Out.truncateAuthors(suggestion, maxAuthors) : suggestion;
      const hidden = diff.field === "author" && maxAuthors > 0 && shown.trim() === (diff.original || "").trim();
      return html`<tr class="diff-row${hidden ? " author-match-hidden" : ""}" data-entry="${idx}" data-field="${diff.field}" data-action="${action}"
          data-enrichment="${isEnrichment ? "1" : ""}"
          data-found-val="${encodeURIComponent(diff.found || "")}"
          data-original-val="${encodeURIComponent(diff.original || "")}">
          <td class="field-name"><span class="field-name-pill">${diff.field}</span>${provenanceLabel(diff.field)}</td>
          <td class="val-col val-col-original">
            ${!isEnrichment ? html`<button class="choice-pill pill-original ${action === "original" ? "active" : ""}"
                    data-entry="${idx}" data-field="${diff.field}" data-action="original" data-val="${diff.original || ""}"
                    title="Keep your value">${diff.original}</button>` : html`<span class="empty-val">—</span>`}
          </td>
          <td class="val-col val-col-suggested">
            ${hasSuggestion ? html`<span class="choice-pill pill-suggested ${action === "found" || action === "custom" ? "active" : ""} ${action === "remove" ? "removed" : ""}"
                    contenteditable="${action === "remove" ? "false" : "true"}"
                    spellcheck="false"
                    data-entry="${idx}" data-field="${diff.field}" data-action="found" data-val="${diff.found || ""}"
                    title="Use suggested value (click to select, edit to customize)">${shown}</span>` : ""}
          </td>
          <td class="field-actions-mini">
            <button class="fa-btn-x ${action === "remove" ? "active" : ""}" title="${isEnrichment ? "Don’t add" : "Remove field"}"
                    data-entry="${idx}" data-field="${diff.field}" data-action="remove" data-val="">
              ${X_ICON}
            </button>
          </td>
        </tr>`;
    });
    if (truncated) rows.unshift(html`<tr class="diff-row" data-entry="${idx}" data-field="author" data-action="found" data-injected="1" title="Max authors setting (applied on export)">
          <td class="field-name"><span class="field-name-pill">author</span></td>
          <td class="val-col val-col-original"><span class="choice-pill pill-original">${authorValue}</span></td>
          <td class="val-col val-col-suggested"><span class="choice-pill pill-suggested active">${truncated}</span></td>
          <td class="field-actions-mini"></td>
        </tr>`);
    const main = rows.length ? html`<table class="diff-table">
        <tr><th>Field</th><th>Your Value</th><th>Suggested</th><th></th></tr>
        ${rows}
      </table>` : "";
    if (!others.length) return main;
    const otherRows = others.map(field => {
      const fe = edits[field];
      const action = fe.action;
      return html`<tr class="diff-row field-row-plain${field === "author" && truncated ? " author-match-hidden" : ""}" data-entry="${idx}" data-field="${field}" data-action="${action}">
          <td class="field-name"><span class="field-name-pill">${field}</span>${provenanceLabel(field)}</td>
          <td class="val-col" colspan="2">
            <span class="choice-pill pill-value ${action === "remove" ? "removed" : "active"}"
                  contenteditable="${action === "remove" ? "false" : "true"}" spellcheck="false"
                  data-entry="${idx}" data-field="${field}">${action === "remove" ? "" : fe.value}</span>
          </td>
          <td class="field-actions-mini">
            <button class="fa-btn-x ${action === "remove" ? "active" : ""}" title="Remove field"
                    data-entry="${idx}" data-field="${field}" data-action="remove" data-val="">
              ${X_ICON}
            </button>
          </td>
        </tr>`;
    });
    return html`${main}<div class="fields-toggle-wrap collapsed">
        <button class="fields-toggle-btn" type="button">
          <svg class="fields-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
          ${diffs.length ? "Other fields" : "Fields"} (${others.length})
        </button>
        <table class="diff-table fields-table">
          <tr><th>Field</th><th colspan="2">Value</th><th></th></tr>
          ${otherRows}
        </table>
      </div>`;
  }

  function searchLinks(title) {
    if (!title.trim()) return "";
    const q = encodeURIComponent(stripLatex(title));
    return html`<div class="search-links">
      <a class="search-link" href="https://scholar.google.com/scholar?q=${q}" target="_blank" rel="noopener" title="Google Scholar" aria-label="Search this title on Google Scholar">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="search-link-svg"><rect width="14" height="14" rx="3" fill="#4285f4"/><text x="7" y="10" text-anchor="middle" font-size="8" fill="#fff">S</text></svg>
      </a>
      <a class="search-link" href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener" title="Google" aria-label="Search this title on Google">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="search-link-svg"><rect width="14" height="14" rx="3" fill="#34a853"/><text x="7" y="10" text-anchor="middle" font-size="8" fill="#fff">G</text></svg>
      </a>
      <a class="search-link" href="https://www.semanticscholar.org/search?q=${q}" target="_blank" rel="noopener" title="Semantic Scholar" aria-label="Search this title on Semantic Scholar">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="search-link-svg"><rect width="14" height="14" rx="3" fill="#1857b6"/><text x="7" y="10" text-anchor="middle" font-size="7" fill="#fff">S2</text></svg>
      </a>
      <a class="search-link search-link-crossref" href="https://search.crossref.org/?q=${q}&from_ui=yes" target="_blank" rel="noopener" title="CrossRef" aria-label="Search this title on CrossRef">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="search-link-svg">
          <rect width="24" height="24" rx="4" fill="#f89838"/>
          <path fill="#fff" fill-rule="evenodd" d="M7 8h10v2H7V8zm0 4h10v2H7v-2zm0 4h7v2H7v-2z"/>
        </svg>
      </a>
      <a class="search-link" href="https://dblp.org/search?q=${q}" target="_blank" rel="noopener" title="DBLP" aria-label="Search this title on DBLP">
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" class="search-link-svg"><rect width="14" height="14" rx="3" fill="#f6c344"/><text x="7" y="10" text-anchor="middle" font-size="7" fill="#111">D</text></svg>
      </a>
    </div>`;
  }

  // The inner markup of one entry card. view: { entry, decision, edits,
  // maxAuthors, lang, mixed }. Reads its inputs only; field edits a result
  // implies were stored by core/verify.js when the result was built.
  function cardMarkup(r, view) {
    const { entry, decision } = view;
    const idx = r.index;
    const t = EVIDENCE_TEXT[view.lang] || EVIDENCE_TEXT.en;
    const tagStatus = Out.tagStatus(r, decision, RESOLVED);
    const excluded = r.selected_choice === "exclude";
    const wholeRecordOnly = Out.requiresWholeRecordChoice(r);
    const atomicInputConflict = (r.integrity_issues || []).some(issue => issue.blocking !== false && issue.severity !== "warning");
    const { candidate, diffs, others } = D.cardFields(r, entry, decision);
    const edits = { ...D.defaultFieldEdits(r, entry, decision), ...view.edits };
    const hasSuggestion = r.status === "updated" || r.status === "needs_review" || (r.status === "verified" && diffs.length > 0);
    const hint = reviewHint(r, t);
    const notices = Out.noticesFor(r, decision);
    const allAre = action => (r.field_diffs || []).every(diff => edits[diff.field]?.action === action);
    const actions = !wholeRecordOnly && hasSuggestion && diffs.length ? html`<div class="entry-actions">
        <button class="seg-btn btn-accept-all ${allAre("found") ? "active-accept" : ""}" data-entry="${idx}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
          Accept all
        </button>
        <button class="seg-btn btn-revert-all ${allAre("original") ? "active-revert" : ""}" data-entry="${idx}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 105.64-11.36L1 10"/></svg>
          Keep original
        </button>
      </div>` : "";
    const paperUrl = safeUrl(r.paper_url);

    return html`<div class="entry-header">
      <div class="entry-header-text">
        <div class="entry-title" data-entry-title>${r.title || "(no title)"}</div>
        <div class="entry-meta" data-entry-meta>${r.entry_id || ""} · ${r.entry_type || ""}</div>
      </div>
      <div class="entry-header-aside">
        <button class="btn-jump-preview" type="button" data-entry-index="${idx}" title="Scroll to this entry in the live preview">
      ${JUMP_ICON}
      ${JUMP_ICON}
    </button>
        <div class="entry-tags">
          ${r.duplicate_of ? html`<span class="status-tag tag-duplicate">Duplicate</span>` : ""}
          ${excluded ? html`<span class="status-tag tag-excluded">Excluded</span>` : ""}
          ${excluded ? "" : html`<span class="status-tag tag-${tagStatus}">${Out.statusLabel(tagStatus, decision)}</span>`}
          ${noticeTags(notices)}
        </div>
      </div>
    </div>${r.duplicate_of ? html`<div class="duplicate-row">Duplicate of <strong>${r.duplicate_of}</strong></div>` : ""}${
      noticeFlag(notices)}${
      r.integrity_issues?.length ? html`<div class="review-hint input-integrity-warning" data-integrity-warning><strong>Input integrity:</strong> ${r.integrity_issues.map(issue => issue.message).join(" ")}${atomicInputConflict ? " Select one candidate record as a whole; field-level mixing is disabled for this conflict." : ""}</div>` : ""}${
      lintMarkup(entry, t)}${
      hint !== null ? html`<div class="review-hint" data-review-hint>${hint}</div>` : ""}${
      r.source_warnings?.length ? html`<div class="review-hint source-warning" data-source-warning>Source status: ${r.source_warnings.join(" ")}</div>` : ""}${
      r.status === "not_found" ? html`<div class="not-found-hint" data-not-found-hint>${(r.title || "").trim() ? t.notFoundWithTitle : t.notFoundNoTitle}</div>` : ""}${
      candidatePanel(r, entry, decision, selectedChoice(r, decision), t)}${
      view.mixed ? html`<div class="review-hint mixed-source-warning">${MIXED_TEXT}</div>` : ""}${
      excluded || wholeRecordOnly ? "" : fieldTables(r, view, candidate, diffs, others, edits, hasSuggestion)}${
      excluded ? "" : actions}${
      paperUrl ? html`<a class="paper-open-link" href="${paperUrl}" target="_blank" rel="noopener" title="Open selected paper page">Open paper</a>` : ""}${
      searchLinks(r.title || "")}`;
  }

  function renderCard(r, view) {
    const card = document.createElement("div");
    card.className = `entry-card status-${Out.badgeStatus(r, view.decision, RESOLVED)}`;
    card.classList.toggle("is-excluded", r.selected_choice === "exclude");
    card.dataset.status = Out.tagStatus(r, view.decision, RESOLVED);
    card.dataset.index = r.index;
    if (r.duplicate_of) card.dataset.duplicate = "true";
    const notices = Out.noticesFor(r, view.decision);
    if (notices.length) card.dataset.notices = [...new Set(notices.map(notice => notice.type))].join(" ");
    card.dataset.searchHay = `${(r.entry_id || "").toLowerCase()} ${stripLatex(r.title || "").toLowerCase()}`;
    setHTML(card, cardMarkup(r, view));
    return card;
  }

  // The preview found (or no longer finds) mixed core sources for this entry.
  function syncMixedWarning(card, mixed) {
    const warning = card.querySelector(".mixed-source-warning");
    if (!mixed || warning) {
      if (!mixed) warning?.remove();
      return;
    }
    const div = document.createElement("div");
    div.className = "review-hint mixed-source-warning";
    div.textContent = MIXED_TEXT;
    const panel = card.querySelector(".candidate-panel");
    const next = card.querySelector(":scope > .diff-table, :scope > .fields-toggle-wrap, :scope > .entry-actions, :scope > .paper-open-link, :scope > .search-links");
    if (panel) panel.after(div);
    else if (next) next.before(div);
    else card.append(div);
  }

  // ─── Parse errors ──────────────────────────────────────────────────
  // Every parse error as "Line L, column C (key): reason" (at most 50 lines).
  function parseErrorLines(errors) {
    const lines = errors.slice(0, 50).map(error =>
      `Line ${error.line}, column ${error.column}${error.key ? ` (${error.key})` : ""}: ${error.message}`);
    if (errors.length > 50) lines.push(`… and ${errors.length - 50} more.`);
    return lines;
  }

  // The list above the cards: unparsable text is not verified and is
  // exported unchanged.
  function showParseErrors(panel, errors) {
    panel.hidden = !errors.length;
    setHTML(panel, errors.length
      ? html`<strong>${errors.length} BibTeX parse ${errors.length === 1 ? "error" : "errors"}:</strong> the affected text is not verified and is exported unchanged. Fix it in your file and verify again.<ul>${parseErrorLines(errors).map(line => html`<li>${line}</li>`)}</ul>`
      : "");
  }

  // ─── Card events ───────────────────────────────────────────────────
  // Restyles one field row for an action (original | found | custom | remove).
  function setRowAction(row, action) {
    const kept = action !== "remove";
    const suggested = action === "found" || action === "custom";
    row.querySelectorAll(".pill-original").forEach(pill => pill.classList.toggle("active", action === "original"));
    row.querySelectorAll(".pill-suggested").forEach(pill => {
      pill.classList.toggle("active", suggested);
      pill.classList.toggle("removed", !kept);
      pill.contentEditable = String(suggested);
    });
    row.querySelectorAll(".pill-value").forEach(pill => {
      pill.classList.toggle("active", kept);
      pill.classList.toggle("removed", !kept);
      pill.contentEditable = String(kept);
    });
    row.querySelectorAll(".fa-btn-x").forEach(button => button.classList.toggle("active", !kept));
    row.dataset.action = action;
    row.classList.remove("flash");
    void row.offsetWidth;
    row.classList.add("flash");
  }

  const EDITABLE_ROWS = ".diff-row:not(.field-row-plain):not([data-injected])";

  function syncBulkButtons(card) {
    const rows = [...card.querySelectorAll(EDITABLE_ROWS)];
    if (!rows.length) return;
    card.querySelector(".btn-accept-all")?.classList.toggle("active-accept", rows.every(row => row.dataset.action === "found"));
    card.querySelector(".btn-revert-all")?.classList.toggle("active-revert", rows.every(row => row.dataset.action === "original"));
  }

  const decoded = (row, name) => decodeURIComponent(row.getAttribute(name) || "");

  // actions: choose(index, { action, candidateIndex }), edit(index, field,
  // action, value, extra), entryState(index) → { status, edits }.
  function bindCardEvents(root, actions) {
    root.addEventListener("click", event => {
      const target = event.target;
      const choice = target.closest(".candidate-option-btn, .candidate-control-btn");
      if (choice) {
        actions.choose(Number(choice.dataset.entry), {
          action: choice.dataset.choiceAction,
          candidateIndex: Number(choice.dataset.candidateIndex),
        });
        return;
      }
      const toggle = target.closest(".fields-toggle-btn");
      if (toggle) {
        toggle.closest(".fields-toggle-wrap").classList.toggle("collapsed");
        return;
      }
      const bulk = target.closest(".btn-accept-all, .btn-revert-all");
      if (bulk) {
        const accept = bulk.classList.contains("btn-accept-all");
        const index = Number(bulk.dataset.entry);
        const card = bulk.closest(".entry-card");
        card.querySelectorAll(EDITABLE_ROWS).forEach(row => {
          const original = row.querySelector(".pill-original");
          const suggested = row.querySelector(".pill-suggested");
          if (!original && !suggested) return;
          const found = decoded(row, "data-found-val");
          if (accept && suggested) {
            actions.edit(index, row.dataset.field, "found", suggested.dataset.val);
            suggested.textContent = found;
          } else if (!accept && original) {
            actions.edit(index, row.dataset.field, "original", original.dataset.val);
          } else if (!accept && suggested && row.dataset.enrichment === "1") {
            actions.edit(index, row.dataset.field, "original", found);
            suggested.textContent = found;
          }
          setRowAction(row, accept ? "found" : "original");
        });
        syncBulkButtons(card);
        return;
      }
      const control = target.closest(".pill-original, .pill-suggested:not(.active), .fa-btn-x");
      const row = control?.closest(".diff-row:not([data-injected])");
      if (!row) return;
      const index = Number(row.dataset.entry);
      const field = row.dataset.field;
      if (control.classList.contains("pill-original")) {
        actions.edit(index, field, "original", control.dataset.val);
        setRowAction(row, "original");
      } else if (control.classList.contains("pill-suggested")) {
        actions.edit(index, field, "found", control.dataset.val);
        setRowAction(row, "found");
      } else if (row.dataset.action !== "remove") {
        actions.edit(index, field, "remove", "", { _savedValue: actions.entryState(index).edits[field]?.value || "" });
        setRowAction(row, "remove");
      } else {
        // Undo a removal: a plain row gets its saved value back; a diff row
        // returns to the suggestion (updated results and enrichments) or
        // to the original.
        const { status, edits } = actions.entryState(index);
        const valuePill = row.querySelector(".pill-value");
        const found = decoded(row, "data-found-val");
        const original = decoded(row, "data-original-val");
        if (valuePill) {
          const restore = original || edits[field]?._savedValue || "";
          actions.edit(index, field, "original", restore);
          valuePill.textContent = restore;
          setRowAction(row, "original");
        } else if (status === "updated" || row.dataset.enrichment === "1") {
          actions.edit(index, field, "found", found);
          const suggested = row.querySelector(".pill-suggested");
          if (suggested) suggested.textContent = found;
          setRowAction(row, "found");
        } else {
          actions.edit(index, field, "original", original);
          setRowAction(row, "original");
        }
      }
      syncBulkButtons(row.closest(".entry-card"));
    });

    root.addEventListener("input", event => {
      const pill = event.target.closest(".pill-suggested[contenteditable], .pill-value[contenteditable]");
      const row = pill?.closest(".diff-row:not([data-injected])");
      if (!row) return;
      actions.edit(Number(pill.dataset.entry), pill.dataset.field, "custom", pill.textContent.trim());
      setRowAction(row, "custom");
      syncBulkButtons(row.closest(".entry-card"));
    });
  }

export {
  cardMarkup,
  renderCard,
  syncMixedWarning,
  parseErrorLines,
  showParseErrors,
  bindCardEvents,
};
