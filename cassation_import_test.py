#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Safe first-stage importer for Jordan Judicial Council Court of Cassation principles.

Default behavior is DRY RUN: it fetches one official page, parses it, and prints
what would be written. Nothing is written to Firestore unless --write is passed.

The default page is decision 6324/2025 (source page 5501), which is expected to
contain exactly four principles. That makes it a good regression test before we
expand the importer to the full Judicial Council archive.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import re
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Iterable
from urllib.parse import urlparse


DEFAULT_URL = (
    "https://www.jc.jo/AR/ListDetails/"
    "%D9%85%D8%A8%D8%A7%D8%AF%D8%A6_%D9%88%D8%AF%D8%B1%D8%A7%D8%B3%D8%A7%D8%AA_"
    "%D8%A7%D9%84%D9%85%D9%83%D8%AA%D8%A8/1187/5501"
)
DEFAULT_COLLECTION = "cassation_principles"
OFFICIAL_HOSTS = {"jc.jo", "www.jc.jo"}
ARABIC_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩", "0123456789")


@dataclass(frozen=True)
class ParsedDecision:
    decision_number: str
    decision_year: int
    case_type: str
    panel_type: str
    source_page: str
    source_url: str
    principles: list[str]

    @property
    def decision_key(self) -> str:
        return f"{self.decision_number}_{self.decision_year}"


class VisibleTextParser(HTMLParser):
    """Turn the relevant HTML into readable text while preserving list boundaries."""

    BLOCK_TAGS = {
        "p", "div", "section", "article", "main", "br", "h1", "h2", "h3",
        "h4", "h5", "h6", "ul", "ol", "table", "tr", "td", "th",
    }
    SKIP_TAGS = {"script", "style", "noscript", "svg"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0
        self.li_depth = 0

    def handle_starttag(self, tag: str, attrs) -> None:  # type: ignore[override]
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            self.skip_depth += 1
            return
        if self.skip_depth:
            return
        if tag == "li":
            self.li_depth += 1
            self.parts.append("\n__LI__ ")
        elif tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in self.SKIP_TAGS:
            if self.skip_depth:
                self.skip_depth -= 1
            return
        if self.skip_depth:
            return
        if tag == "li":
            self.parts.append("\n")
            self.li_depth = max(0, self.li_depth - 1)
        elif tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip_depth and data:
            self.parts.append(data)

    def text(self) -> str:
        raw = html.unescape("".join(self.parts)).replace("\xa0", " ")
        lines = []
        for line in raw.splitlines():
            cleaned = re.sub(r"[ \t\r\f\v]+", " ", line).strip()
            if cleaned:
                lines.append(cleaned)
        return "\n".join(lines)


def normalize_digits(value: str) -> str:
    return value.translate(ARABIC_DIGITS)


def normalize_for_match(value: str) -> str:
    return (
        normalize_digits(value)
        .replace("أ", "ا")
        .replace("إ", "ا")
        .replace("آ", "ا")
        .replace("ى", "ي")
        .replace("ة", "ه")
        .replace("ـ", "")
        .strip()
    )


def clean_principle(text: str) -> str:
    text = re.sub(r"^__LI__\s*", "", text).strip()
    text = re.sub(r"^[0-9٠-٩]+\s*[.)\-_:–—]+\s*", "", text).strip()
    text = re.sub(r"\s+", " ", text).strip()
    return text


def fetch_official_html(url: str, timeout: int = 30) -> str:
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in OFFICIAL_HOSTS:
        raise ValueError("Refusing to fetch a non-official source. URL must be on jc.jo.")

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "LawMind-JO-Cassation-Importer/0.1 "
                "(+official-source synchronization; low-volume test)"
            ),
            "Accept-Language": "ar,en;q=0.5",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            content_type = response.headers.get_content_charset() or "utf-8"
            body = response.read()
            return body.decode(content_type, errors="replace")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"Judicial Council returned HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"Could not reach Judicial Council: {exc.reason}") from exc


def extract_source_page(url: str) -> str:
    path = urlparse(url).path.rstrip("/")
    page = path.split("/")[-1]
    if not page.isdigit():
        raise ValueError("Could not determine numeric sourcePage from URL.")
    return page


def find_decision_identity(text: str) -> tuple[str, int, str, str]:
    normalized = normalize_digits(text)

    # Keep the match deliberately narrow around the decision citation, not article numbers.
    patterns = [
        re.compile(
            r"تمييز\s+(حقوق|جزاء)\s+(هيئة\s+عامة|هيئة\s+خماسية|هيئة\s+عادية)?"
            r"\s*(?:رقم\s*)?[\(\[]?\s*(\d{1,6})\s*[/\-]\s*(\d{4})",
            re.IGNORECASE,
        ),
        re.compile(
            r"رقم\s+الطعن\s*[:：]?\s*تمييز\s+(حقوق|جزاء)\s+"
            r"(هيئة\s+عامة|هيئة\s+خماسية|هيئة\s+عادية)?\s*"
            r"(?:رقم\s*)?[\(\[]?\s*(\d{1,6})\s*[/\-]\s*(\d{4})",
            re.IGNORECASE,
        ),
    ]

    for pattern in patterns:
        match = pattern.search(normalized)
        if match:
            case_type = match.group(1).strip()
            panel_type = (match.group(2) or "").strip()
            decision_number = match.group(3)
            decision_year = int(match.group(4))
            return decision_number, decision_year, case_type, panel_type

    raise ValueError("Could not parse decision number/year/type from the official page.")


def find_principle_section(lines: list[str]) -> tuple[int, int]:
    start = -1
    for i, line in enumerate(lines):
        n = normalize_for_match(line)
        if "المبادئ القانونيه" in n or "المبادى القانونيه" in n or "المبادئ المستخلصه" in n:
            start = i + 1
            break

    if start < 0:
        # Some official pages use a singular label.
        for i, line in enumerate(lines):
            n = normalize_for_match(line)
            if "المبدا القانوني" in n:
                start = i + 1
                break

    if start < 0:
        raise ValueError("Could not find the legal-principles section marker.")

    end = len(lines)
    for i in range(start, len(lines)):
        n = normalize_for_match(lines[i])
        if "تمييز حقوق" in n or "تمييز جزاء" in n or "رقم الطعن" in n:
            end = i
            break

    if end <= start:
        raise ValueError("Legal-principles section was found but its end could not be determined.")
    return start, end


def extract_numbered_inline(section: str) -> list[str]:
    # Fallback for older pages that type ١_ ... ٢_ ... instead of using <li>.
    normalized = normalize_digits(section)
    matches = list(re.finditer(r"(?:^|\n|\s)(\d{1,2})\s*[._\-–—)]\s*", normalized))
    if not matches:
        return []

    items: list[str] = []
    for idx, match in enumerate(matches):
        start = match.end()
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(normalized)
        candidate = clean_principle(normalized[start:end])
        if len(candidate) >= 25:
            items.append(candidate)
    return items


def parse_decision_page(url: str, html_text: str) -> ParsedDecision:
    parser = VisibleTextParser()
    parser.feed(html_text)
    visible = parser.text()
    lines = visible.splitlines()

    decision_number, decision_year, case_type, panel_type = find_decision_identity(visible)
    start, end = find_principle_section(lines)
    section_lines = lines[start:end]

    principles: list[str] = []
    for line in section_lines:
        if line.startswith("__LI__"):
            item = clean_principle(line)
            if len(item) >= 25:
                principles.append(item)

    # If the official page did not use semantic list items, fall back to typed numbering.
    if not principles:
        principles = extract_numbered_inline("\n".join(section_lines))

    # Final fallback: a singular principle page may contain one paragraph only.
    if not principles:
        singular = clean_principle(" ".join(section_lines))
        if len(singular) >= 25:
            principles = [singular]

    # Remove accidental exact duplicates while preserving source order.
    deduped: list[str] = []
    seen: set[str] = set()
    for item in principles:
        key = re.sub(r"\s+", " ", item).strip()
        if key and key not in seen:
            seen.add(key)
            deduped.append(key)

    if not deduped:
        raise ValueError("No principle text could be extracted from the official page.")

    return ParsedDecision(
        decision_number=decision_number,
        decision_year=decision_year,
        case_type=case_type,
        panel_type=panel_type,
        source_page=extract_source_page(url),
        source_url=url,
        principles=deduped,
    )


def principle_key(decision: ParsedDecision, order: int) -> str:
    return f"JC_{decision.decision_number}_{decision.decision_year}_P{order:02d}"


def build_payload(decision: ParsedDecision, order: int, text: str) -> dict:
    searchable = f"{decision.case_type} {decision.decision_number}/{decision.decision_year} {text}"
    return {
        "principleKey": principle_key(decision, order),
        "decisionKey": decision.decision_key,
        "decisionNumber": decision.decision_number,
        "decisionYear": decision.decision_year,
        "caseType": decision.case_type,
        "panelType": decision.panel_type,
        "principleOrder": order,
        "principleText": text,
        "sourceName": "المجلس القضائي الأردني",
        "sourceUrl": decision.source_url,
        "sourcePage": decision.source_page,
        "isOfficialSource": True,
        "sourceHash": hashlib.sha256(
            f"{decision.source_url}\n{order}\n{text}".encode("utf-8")
        ).hexdigest(),
        "searchText": searchable,
        "aiEnriched": False,
        "embeddingReady": False,
        "isActive": True,
    }


def print_dry_run(decision: ParsedDecision) -> None:
    print("\n=== DRY RUN: NO FIRESTORE WRITES ===")
    print(f"decisionKey     : {decision.decision_key}")
    print(f"decisionNumber  : {decision.decision_number}")
    print(f"decisionYear    : {decision.decision_year}")
    print(f"caseType        : {decision.case_type}")
    print(f"panelType       : {decision.panel_type or '(فارغ)'}")
    print(f"sourcePage      : {decision.source_page}")
    print(f"principlesCount : {len(decision.principles)}")
    for order, principle in enumerate(decision.principles, start=1):
        print(f"\n[{principle_key(decision, order)}]")
        print(principle)


def write_to_firestore(
    decision: ParsedDecision,
    collection_name: str,
    service_account: str,
) -> None:
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
    except ImportError as exc:
        raise RuntimeError(
            "firebase-admin is not installed. Install it before using --write."
        ) from exc

    if not firebase_admin._apps:  # type: ignore[attr-defined]
        cred = credentials.Certificate(service_account)
        firebase_admin.initialize_app(cred)

    db = firestore.client()
    collection = db.collection(collection_name)
    server_timestamp = firestore.SERVER_TIMESTAMP

    for order, principle in enumerate(decision.principles, start=1):
        payload = build_payload(decision, order, principle)
        key = payload["principleKey"]
        existing = list(collection.where("principleKey", "==", key).limit(3).stream())

        if len(existing) > 1:
            raise RuntimeError(
                f"Duplicate principleKey detected for {key}; refusing to choose a document automatically."
            )

        payload["updatedAt"] = server_timestamp
        if existing:
            existing[0].reference.set(payload, merge=True)
            print(f"UPDATED  {key} -> {existing[0].id}")
        else:
            payload["createdAt"] = server_timestamp
            # New records get a deterministic document ID. Existing manual records are updated in place.
            collection.document(key).set(payload, merge=True)
            print(f"CREATED  {key}")


def parse_args(argv: Iterable[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default=DEFAULT_URL)
    parser.add_argument("--expected-count", type=int, default=4)
    parser.add_argument("--collection", default=DEFAULT_COLLECTION)
    parser.add_argument("--service-account", default="serviceAccountKey.json")
    parser.add_argument(
        "--write",
        action="store_true",
        help="Actually upsert Firestore documents. Without this flag the script is read-only.",
    )
    return parser.parse_args(list(argv))


def main(argv: Iterable[str] = ()) -> int:
    args = parse_args(argv)
    print("Fetching official Judicial Council page...")
    html_text = fetch_official_html(args.url)
    decision = parse_decision_page(args.url, html_text)
    print_dry_run(decision)

    if len(decision.principles) != args.expected_count:
        print(
            f"\nSTOPPED: expected {args.expected_count} principles but parsed "
            f"{len(decision.principles)}. Nothing was written.",
            file=sys.stderr,
        )
        return 2

    if not args.write:
        print("\nValidation passed. Re-run with --write only after reviewing this output.")
        return 0

    print("\nWriting validated records to Firestore...")
    write_to_firestore(decision, args.collection, args.service_account)
    print("DONE")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
