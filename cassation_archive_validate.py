#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import json
import time
import traceback
from collections import Counter, defaultdict
from pathlib import Path

import cassation_import_test as importer

URLS_JSON = Path("cassation_archive_urls.json")
REPORT_JSON = Path("cassation_archive_validation_report.json")
FAILURES_TXT = Path("cassation_archive_validation_failures.txt")
DELAY_SECONDS = 0.30


def main() -> int:
    if not URLS_JSON.exists():
        raise RuntimeError(f"Missing {URLS_JSON}. Run cassation_archive_discover.py first.")

    data = json.loads(URLS_JSON.read_text(encoding="utf-8-sig"))
    urls = data.get("detailLinks") or []
    if not isinstance(urls, list) or not urls:
        raise RuntimeError("No detailLinks found in cassation_archive_urls.json")

    print(f"Validating {len(urls)} official detail pages using local cassation_import_test.py...")
    print("READ-ONLY VALIDATION - NO FIRESTORE WRITES")

    results = []
    failures = []
    warnings = []
    all_principle_keys = []
    decision_to_pages = defaultdict(list)
    source_page_seen = set()

    for index, url in enumerate(urls, start=1):
        source_page = str(url).rstrip("/").split("/")[-1]
        try:
            html_text = importer.fetch_official_html(url)
            decision = importer.parse_decision_page(url, html_text)
            principles = list(decision.principles)
            decision_key = decision.decision_key
            decision_keys = list(getattr(decision, "decision_keys", [decision_key]))

            page_warnings = []
            if decision.source_page != source_page:
                page_warnings.append(
                    f"sourcePage mismatch url={source_page} parsed={decision.source_page}"
                )
            if len(principles) < 1:
                page_warnings.append("zero principles")
            if len(principles) > 25:
                page_warnings.append(f"unusually high principle count={len(principles)}")
            if any(len(p.strip()) < 25 for p in principles):
                page_warnings.append("principle shorter than 25 chars")
            if decision.case_type not in {"حقوق", "جزاء"}:
                page_warnings.append(f"unexpected caseType={decision.case_type!r}")
            if not (1950 <= int(decision.decision_year) <= 2030):
                page_warnings.append(f"unexpected decisionYear={decision.decision_year}")

            keys = [importer.principle_key(decision, i) for i in range(1, len(principles) + 1)]
            all_principle_keys.extend(keys)
            decision_to_pages[decision_key].append(source_page)
            source_page_seen.add(source_page)

            record = {
                "status": "ok",
                "sourcePage": source_page,
                "url": url,
                "decisionKey": decision_key,
                "decisionKeys": decision_keys,
                "decisionNumber": decision.decision_number,
                "decisionYear": decision.decision_year,
                "caseType": decision.case_type,
                "panelType": decision.panel_type,
                "principlesCount": len(principles),
                "principleKeys": keys,
                "warnings": page_warnings,
            }
            results.append(record)

            for warning in page_warnings:
                warnings.append({"sourcePage": source_page, "warning": warning})

            flag = " WARN" if page_warnings else ""
            multi = f" decisions={len(decision_keys)}" if len(decision_keys) > 1 else ""
            print(
                f"[{index:03d}/{len(urls)}] OK page={source_page} "
                f"decision={decision_key} principles={len(principles)}{multi}{flag}"
            )

        except Exception as exc:
            message = f"{type(exc).__name__}: {exc}"
            failures.append(
                {
                    "sourcePage": source_page,
                    "url": url,
                    "error": message,
                    "traceback": traceback.format_exc(),
                }
            )
            results.append(
                {
                    "status": "failed",
                    "sourcePage": source_page,
                    "url": url,
                    "error": message,
                }
            )
            print(f"[{index:03d}/{len(urls)}] FAIL page={source_page} {message}")

        time.sleep(DELAY_SECONDS)

    key_counts = Counter(all_principle_keys)
    duplicate_principle_keys = sorted(k for k, count in key_counts.items() if count > 1)
    repeated_decision_keys = {
        key: pages for key, pages in sorted(decision_to_pages.items()) if len(pages) > 1
    }

    count_histogram = Counter(
        r["principlesCount"] for r in results if r.get("status") == "ok"
    )

    report = {
        "sourceFile": str(URLS_JSON),
        "pagesRequested": len(urls),
        "pagesSucceeded": sum(1 for r in results if r.get("status") == "ok"),
        "pagesFailed": len(failures),
        "pagesWithWarnings": len({w["sourcePage"] for w in warnings}),
        "totalPrinciplesParsed": len(all_principle_keys),
        "uniquePrincipleKeys": len(key_counts),
        "duplicatePrincipleKeys": duplicate_principle_keys,
        "repeatedDecisionKeysAcrossPages": repeated_decision_keys,
        "principleCountHistogram": dict(sorted(count_histogram.items())),
        "warnings": warnings,
        "failures": failures,
        "results": results,
    }

    REPORT_JSON.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    with FAILURES_TXT.open("w", encoding="utf-8") as f:
        for item in failures:
            f.write(
                f"PAGE {item['sourcePage']}\n{item['url']}\n{item['error']}\n\n"
            )

    print("\n=== ARCHIVE PARSER VALIDATION SUMMARY ===")
    print(f"PAGES_REQUESTED: {len(urls)}")
    print(f"PAGES_SUCCEEDED: {report['pagesSucceeded']}")
    print(f"PAGES_FAILED: {report['pagesFailed']}")
    print(f"PAGES_WITH_WARNINGS: {report['pagesWithWarnings']}")
    print(f"TOTAL_PRINCIPLES_PARSED: {report['totalPrinciplesParsed']}")
    print(f"UNIQUE_PRINCIPLE_KEYS: {report['uniquePrincipleKeys']}")
    print(f"DUPLICATE_PRINCIPLE_KEYS: {len(duplicate_principle_keys)}")
    print(f"REPEATED_DECISION_KEYS_ACROSS_PAGES: {len(repeated_decision_keys)}")
    print(f"SAVED_REPORT: {REPORT_JSON}")
    print(f"SAVED_FAILURES: {FAILURES_TXT}")
    print("NO FIRESTORE WRITES")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
