#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import html
import http.cookiejar
import json
import re
import time
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urljoin

LIST_URL = (
    "https://www.jc.jo/Ar/List/"
    "%D9%85%D8%A8%D8%A7%D8%AF%D8%A6_%D9%88%D8%AF%D8%B1%D8%A7%D8%B3%D8%A7%D8%AA_"
    "%D8%A7%D9%84%D9%85%D9%83%D8%AA%D8%A8"
)
EXPECTED_PAGES = 66
OUTPUT_JSON = "cassation_archive_urls.json"
OUTPUT_TXT = "cassation_archive_urls.txt"
DELAY_SECONDS = 0.35


class ArchiveParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hidden_inputs: dict[str, str] = {}
        self.detail_links: list[str] = []
        self.current_page = ""
        self._capture_current_page = False
        self.next_image_name = ""

    def handle_starttag(self, tag: str, attrs) -> None:  # type: ignore[override]
        d = {str(k).lower(): str(v or "") for k, v in attrs}
        tag = tag.lower()

        if tag == "input":
            input_type = d.get("type", "").lower()
            name = d.get("name", "")
            if input_type == "hidden" and name:
                self.hidden_inputs[name] = d.get("value", "")
            if input_type == "image" and d.get("alt", "").lower() == "next" and name:
                if "disabled" not in d:
                    self.next_image_name = name

        elif tag == "a":
            href = html.unescape(d.get("href", ""))
            if "listdetails" in href.lower():
                self.detail_links.append(urljoin(LIST_URL, href))

        elif tag == "span" and "currentpageclass" in d.get("class", "").lower():
            self._capture_current_page = True

    def handle_data(self, data: str) -> None:
        if self._capture_current_page:
            self.current_page += data.strip()

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "span" and self._capture_current_page:
            self._capture_current_page = False


def unique(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        if value not in seen:
            seen.add(value)
            out.append(value)
    return out


def decode_response(response) -> str:
    body = response.read()
    charset = response.headers.get_content_charset() or "utf-8"
    return body.decode(charset, errors="replace")


def parse_page(raw: str) -> ArchiveParser:
    parser = ArchiveParser()
    parser.feed(raw)
    return parser


def fetch_first_page(opener, headers: dict[str, str]) -> str:
    req = urllib.request.Request(LIST_URL, headers=headers)
    with opener.open(req, timeout=30) as response:
        return decode_response(response)


def fetch_next_page(
    opener,
    headers: dict[str, str],
    parser: ArchiveParser,
) -> str:
    if not parser.next_image_name:
        raise RuntimeError(
            f"No enabled Next pager button found on current page {parser.current_page!r}."
        )

    if "__VIEWSTATE" not in parser.hidden_inputs:
        raise RuntimeError("Missing ASP.NET __VIEWSTATE.")
    if "__EVENTVALIDATION" not in parser.hidden_inputs:
        raise RuntimeError("Missing ASP.NET __EVENTVALIDATION.")

    payload = dict(parser.hidden_inputs)
    payload["__EVENTTARGET"] = ""
    payload["__EVENTARGUMENT"] = ""
    payload[f"{parser.next_image_name}.x"] = "1"
    payload[f"{parser.next_image_name}.y"] = "1"

    data = urllib.parse.urlencode(payload).encode("utf-8")
    post_headers = dict(headers)
    post_headers.update(
        {
            "Content-Type": "application/x-www-form-urlencoded",
            "Referer": LIST_URL,
        }
    )

    req = urllib.request.Request(
        LIST_URL,
        data=data,
        headers=post_headers,
        method="POST",
    )
    with opener.open(req, timeout=30) as response:
        return decode_response(response)


def page_number(value: str) -> int:
    cleaned = re.sub(r"\D+", "", value or "")
    if not cleaned:
        raise RuntimeError(f"Could not parse current page number from {value!r}.")
    return int(cleaned)


def main() -> int:
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    headers = {
        "User-Agent": "Mozilla/5.0 LawMind-JO-Archive-Discovery/0.1",
        "Accept-Language": "ar,en;q=0.5",
    }

    print("Fetching archive page 1...")
    raw = fetch_first_page(opener, headers)

    all_links: list[str] = []
    page_summaries: list[dict[str, object]] = []

    for expected_page in range(1, EXPECTED_PAGES + 1):
        parser = parse_page(raw)
        current = page_number(parser.current_page)
        if current != expected_page:
            raise RuntimeError(
                f"Pagination mismatch: expected page {expected_page}, got {current}."
            )

        links = unique(parser.detail_links)
        ids = [url.rstrip("/").split("/")[-1] for url in links]
        print(
            f"PAGE {current:02d}/{EXPECTED_PAGES}: "
            f"links={len(links)} "
            f"first={ids[0] if ids else '-'} "
            f"last={ids[-1] if ids else '-'}"
        )

        if not links:
            raise RuntimeError(f"Page {current} returned no detail links.")

        page_summaries.append(
            {
                "page": current,
                "count": len(links),
                "ids": ids,
                "links": links,
            }
        )
        all_links.extend(links)

        if expected_page == EXPECTED_PAGES:
            break

        raw = fetch_next_page(opener, headers, parser)
        time.sleep(DELAY_SECONDS)

    unique_links = unique(all_links)
    duplicate_count = len(all_links) - len(unique_links)

    result = {
        "source": LIST_URL,
        "pagesExpected": EXPECTED_PAGES,
        "pagesScanned": len(page_summaries),
        "linksSeen": len(all_links),
        "uniqueDetailLinks": len(unique_links),
        "duplicatesAcrossPages": duplicate_count,
        "pages": page_summaries,
        "detailLinks": unique_links,
    }

    with open(OUTPUT_JSON, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    with open(OUTPUT_TXT, "w", encoding="utf-8") as f:
        for link in unique_links:
            f.write(link + "\n")

    print("\n=== ARCHIVE DISCOVERY SUMMARY ===")
    print(f"PAGES_SCANNED: {len(page_summaries)}")
    print(f"LINKS_SEEN: {len(all_links)}")
    print(f"UNIQUE_DETAIL_LINKS: {len(unique_links)}")
    print(f"DUPLICATES_ACROSS_PAGES: {duplicate_count}")
    print(f"SAVED_JSON: {OUTPUT_JSON}")
    print(f"SAVED_TXT: {OUTPUT_TXT}")
    print("NO FIRESTORE WRITES")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
