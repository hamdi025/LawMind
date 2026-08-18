#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import hashlib
import json
import re
import time
from pathlib import Path

import cassation_import_test as importer

REPORT = Path("cassation_archive_validation_report.json")
OUT = Path("cassation_archive_issue_diagnostics.txt")
DELAY_SECONDS = 0.20

PAIR_RE = re.compile(r"[0-9٠-٩]{1,6}\s*[/\-]\s*[0-9٠-٩]{2,4}")
KEYWORD_RE = re.compile(r"تمييز|هيئة\s+عامة|قرار\s+هيئة|رقم\s+الطعن|قرار\s+رقم", re.I)


def visible_lines(html_text: str) -> list[str]:
    parser = importer.VisibleTextParser()
    parser.feed(html_text)
    return parser.text().splitlines()


def candidate_lines(lines: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for line in lines:
        text = re.sub(r"\s+", " ", line).strip()
        if not text:
            continue
        if PAIR_RE.search(text) or KEYWORD_RE.search(text):
            if text not in seen:
                seen.add(text)
                out.append(text)
    return out


def norm_text(value: str) -> str:
    value = importer.normalize_digits(value)
    value = re.sub(r"\s+", " ", value).strip()
    return value


def short_hash(value: str) -> str:
    return hashlib.sha256(norm_text(value).encode("utf-8")).hexdigest()[:12]


def main() -> int:
    if not REPORT.exists():
        raise RuntimeError(f"Missing {REPORT}")

    report = json.loads(REPORT.read_text(encoding="utf-8-sig"))
    results = report.get("results") or []
    result_by_page = {str(x.get("sourcePage")): x for x in results if x.get("sourcePage")}

    problem_pages = set()
    for item in report.get("failures") or []:
        problem_pages.add(str(item.get("sourcePage")))
    for item in report.get("warnings") or []:
        problem_pages.add(str(item.get("sourcePage")))

    repeated = report.get("repeatedDecisionKeysAcrossPages") or {}
    repeated_pages = set()
    for pages in repeated.values():
        repeated_pages.update(str(p) for p in pages)

    needed_pages = sorted(problem_pages | repeated_pages, key=lambda x: int(x), reverse=True)

    html_cache: dict[str, str] = {}
    parsed_cache: dict[str, object] = {}
    fetch_errors: dict[str, str] = {}

    def fetch_page(page: str) -> str:
        if page in html_cache:
            return html_cache[page]
        rec = result_by_page.get(page)
        if not rec:
            raise RuntimeError(f"No URL in report for page {page}")
        url = str(rec["url"])
        try:
            html_text = importer.fetch_official_html(url)
            html_cache[page] = html_text
            time.sleep(DELAY_SECONDS)
            return html_text
        except Exception as exc:
            fetch_errors[page] = f"{type(exc).__name__}: {exc}"
            raise

    lines_out: list[str] = []
    lines_out.append("CASSATION ARCHIVE ISSUE DIAGNOSTICS")
    lines_out.append("READ ONLY - NO FIRESTORE WRITES")
    lines_out.append("")
    lines_out.append(f"PROBLEM_PAGES={len(problem_pages)}")
    lines_out.append(f"REPEATED_DECISION_GROUPS={len(repeated)}")
    lines_out.append("")

    lines_out.append("=== PART A: FAILED/WARNING PAGE IDENTITY CANDIDATES ===")
    for idx, page in enumerate(sorted(problem_pages, key=lambda x: int(x), reverse=True), start=1):
        rec = result_by_page.get(page, {})
        lines_out.append("")
        lines_out.append(f"--- PAGE {page} ({idx}/{len(problem_pages)}) ---")
        lines_out.append(f"REPORT_STATUS={rec.get('status')}")
        if rec.get("decisionKey"):
            lines_out.append(f"REPORT_DECISION_KEY={rec.get('decisionKey')}")
            lines_out.append(f"REPORT_DECISION_KEYS={rec.get('decisionKeys')}")
            lines_out.append(f"REPORT_CASE_TYPE={rec.get('caseType')!r}")
            lines_out.append(f"REPORT_PANEL_TYPE={rec.get('panelType')!r}")
            lines_out.append(f"REPORT_WARNINGS={rec.get('warnings')}")
        if rec.get("error"):
            lines_out.append(f"REPORT_ERROR={rec.get('error')}")

        try:
            html_text = fetch_page(page)
            cands = candidate_lines(visible_lines(html_text))
            lines_out.append(f"CANDIDATE_LINES={len(cands)}")
            for line in cands[-12:]:
                lines_out.append(f"CANDIDATE: {line}")
            try:
                decision = importer.parse_decision_page(str(rec["url"]), html_text)
                parsed_cache[page] = decision
                lines_out.append(
                    "CURRENT_PARSE="
                    f"{decision.decision_key} keys={getattr(decision, 'decision_keys', [decision.decision_key])} "
                    f"caseType={decision.case_type!r} panelType={decision.panel_type!r} "
                    f"principles={len(decision.principles)}"
                )
            except Exception as exc:
                lines_out.append(f"CURRENT_PARSE_ERROR={type(exc).__name__}: {exc}")
        except Exception as exc:
            lines_out.append(f"FETCH_ERROR={type(exc).__name__}: {exc}")

    lines_out.append("")
    lines_out.append("=== PART B: REPEATED DECISION PAGE COMPARISON ===")
    for decision_key, pages in repeated.items():
        pages = [str(p) for p in pages]
        lines_out.append("")
        lines_out.append(f"--- DECISION {decision_key} PAGES={','.join(pages)} ---")
        page_data = []
        for page in pages:
            rec = result_by_page.get(page, {})
            try:
                html_text = fetch_page(page)
                try:
                    decision = parsed_cache.get(page)
                    if decision is None:
                        decision = importer.parse_decision_page(str(rec["url"]), html_text)
                        parsed_cache[page] = decision
                    hashes = [short_hash(p) for p in decision.principles]
                    page_data.append((page, decision, hashes))
                    lines_out.append(
                        f"PAGE {page}: parsed={decision.decision_key} principles={len(decision.principles)} "
                        f"hashes={','.join(hashes)}"
                    )
                except Exception as exc:
                    lines_out.append(f"PAGE {page}: PARSE_ERROR={type(exc).__name__}: {exc}")
            except Exception as exc:
                lines_out.append(f"PAGE {page}: FETCH_ERROR={type(exc).__name__}: {exc}")

        if len(page_data) >= 2:
            for i in range(len(page_data)):
                for j in range(i + 1, len(page_data)):
                    p1, d1, h1 = page_data[i]
                    p2, d2, h2 = page_data[j]
                    s1, s2 = set(h1), set(h2)
                    exact_overlap = len(s1 & s2)
                    union = len(s1 | s2)
                    jaccard = (exact_overlap / union) if union else 1.0
                    lines_out.append(
                        f"COMPARE {p1} vs {p2}: exact_overlap={exact_overlap} "
                        f"jaccard={jaccard:.3f} identical_lists={h1 == h2}"
                    )

    if fetch_errors:
        lines_out.append("")
        lines_out.append("=== FETCH ERRORS ===")
        for page, err in sorted(fetch_errors.items(), key=lambda kv: int(kv[0]), reverse=True):
            lines_out.append(f"PAGE {page}: {err}")

    lines_out.append("")
    lines_out.append("DONE - NO FIRESTORE WRITES")
    OUT.write_text("\n".join(lines_out), encoding="utf-8")
    print(f"SAVED_DIAGNOSTICS: {OUT}")
    print(f"PROBLEM_PAGES: {len(problem_pages)}")
    print(f"REPEATED_DECISION_GROUPS: {len(repeated)}")
    print("NO FIRESTORE WRITES")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
