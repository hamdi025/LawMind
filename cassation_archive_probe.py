#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import html
import re
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urljoin

LIST_URL = (
    "https://www.jc.jo/Ar/List/"
    "%D9%85%D8%A8%D8%A7%D8%AF%D8%A6_%D9%88%D8%AF%D8%B1%D8%A7%D8%B3%D8%A7%D8%AA_"
    "%D8%A7%D9%84%D9%85%D9%83%D8%AA%D8%A8"
)


class ProbeParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.detail_links: list[str] = []
        self.forms: list[tuple[str, str]] = []
        self.inputs: list[dict[str, str]] = []
        self.scripts: list[str] = []
        self.pageish_attrs: list[str] = []

    def handle_starttag(self, tag: str, attrs) -> None:  # type: ignore[override]
        d = {str(k).lower(): str(v or "") for k, v in attrs}
        tag = tag.lower()

        if tag == "a":
            href = d.get("href", "")
            if "listdetails" in href.lower():
                self.detail_links.append(urljoin(LIST_URL, href))

        if tag == "form":
            self.forms.append((d.get("method", "GET"), d.get("action", "")))

        if tag == "input":
            self.inputs.append(d)

        if tag == "script" and d.get("src"):
            self.scripts.append(urljoin(LIST_URL, d["src"]))

        for key, value in d.items():
            combined = f"{key}={value}"
            if re.search(r"page|pager|pagination|pageno|pageindex|currentpage|gotopage", combined, re.I):
                self.pageish_attrs.append(f"<{tag} {combined}>")


def fetch(url: str) -> str:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 LawMind-JO-Archive-Probe/0.1",
            "Accept-Language": "ar,en;q=0.5",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        body = response.read()
        charset = response.headers.get_content_charset() or "utf-8"
    return body.decode(charset, errors="replace")


def unique(values: list[str]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for value in values:
        value = value.strip()
        if value and value not in seen:
            seen.add(value)
            out.append(value)
    return out


def main() -> int:
    print("Fetching official archive list page...")
    raw = fetch(LIST_URL)

    with open("jc_archive_list_page1.html", "w", encoding="utf-8") as f:
        f.write(raw)

    parser = ProbeParser()
    parser.feed(raw)

    detail_links = unique(parser.detail_links)
    print(f"DETAIL_LINKS_FOUND: {len(detail_links)}")
    for link in detail_links:
        print(f"DETAIL: {link}")

    print("\nFORMS:")
    for method, action in parser.forms:
        print(f"FORM: method={method or 'GET'} action={action}")

    print("\nPAGING-RELATED INPUTS:")
    for d in parser.inputs:
        text = " ".join(f"{k}={v}" for k, v in d.items())
        if re.search(r"page|pager|pagination|pageno|pageindex|currentpage|gotopage", text, re.I):
            print(f"INPUT: {text}")

    print("\nPAGING-RELATED ATTRIBUTES:")
    for item in unique(parser.pageish_attrs):
        print(item)

    print("\nINLINE PAGING CANDIDATES:")
    compact = html.unescape(raw)
    patterns = [
        r".{0,160}(?:pagination|pager|pageindex|pageno|currentpage|gotopage).{0,260}",
        r".{0,160}(?:onclick|href)\s*=\s*[\"'][^\"']*(?:page|pager)[^\"']*[\"'].{0,160}",
    ]
    candidates: list[str] = []
    for pattern in patterns:
        for match in re.finditer(pattern, compact, re.I | re.S):
            snippet = re.sub(r"\s+", " ", match.group(0)).strip()
            if snippet:
                candidates.append(snippet)
    for snippet in unique(candidates)[:40]:
        print(f"CANDIDATE: {snippet}")

    print("\nSCRIPT SOURCES:")
    for src in unique(parser.scripts):
        print(f"SCRIPT: {src}")

    print("\nSAVED_RAW_HTML: jc_archive_list_page1.html")
    print("PROBE DONE - NO FIRESTORE WRITES")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
