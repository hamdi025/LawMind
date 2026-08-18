#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations

import html
import http.cookiejar
import re
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from urllib.parse import urljoin

LIST_URL = (
    "https://www.jc.jo/Ar/List/"
    "%D9%85%D8%A8%D8%A7%D8%AF%D8%A6_%D9%88%D8%AF%D8%B1%D8%A7%D8%B3%D8%A7%D8%AA_"
    "%D8%A7%D9%84%D9%85%D9%83%D8%AA%D8%A8"
)


class ArchiveParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hidden_inputs: dict[str, str] = {}
        self.detail_links: list[str] = []
        self.current_page = ""
        self._capture_current_page = False
        self._anchor_href = ""
        self._anchor_text: list[str] = []
        self.page_targets: dict[str, str] = {}

    def handle_starttag(self, tag: str, attrs) -> None:  # type: ignore[override]
        d = {str(k).lower(): str(v or "") for k, v in attrs}
        tag = tag.lower()

        if tag == "input" and d.get("type", "").lower() == "hidden" and d.get("name"):
            self.hidden_inputs[d["name"]] = d.get("value", "")

        if tag == "a":
            self._anchor_href = html.unescape(d.get("href", ""))
            self._anchor_text = []
            href = d.get("href", "")
            if "listdetails" in href.lower():
                self.detail_links.append(urljoin(LIST_URL, href))

        if tag == "span" and "currentpageclass" in d.get("class", "").lower():
            self._capture_current_page = True

    def handle_data(self, data: str) -> None:
        if self._capture_current_page:
            self.current_page += data.strip()
        if self._anchor_href:
            self._anchor_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag == "span" and self._capture_current_page:
            self._capture_current_page = False
        if tag == "a" and self._anchor_href:
            label = "".join(self._anchor_text).strip()
            match = re.search(r"__doPostBack\('([^']+)'\s*,\s*'([^']*)'\)", self._anchor_href)
            if label and match:
                self.page_targets[label] = match.group(1)
            self._anchor_href = ""
            self._anchor_text = []


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


def main() -> int:
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    headers = {
        "User-Agent": "Mozilla/5.0 LawMind-JO-Archive-Page2-Test/0.1",
        "Accept-Language": "ar,en;q=0.5",
    }

    print("GET page 1...")
    req1 = urllib.request.Request(LIST_URL, headers=headers)
    with opener.open(req1, timeout=30) as response:
        page1 = decode_response(response)

    p1 = ArchiveParser()
    p1.feed(page1)

    page1_links = unique(p1.detail_links)
    print(f"PAGE1_CURRENT: {p1.current_page or '(unknown)'}")
    print(f"PAGE1_LINKS: {len(page1_links)}")

    target = p1.page_targets.get("2")
    if not target:
        raise RuntimeError("Could not find the ASP.NET postback target for page 2.")

    if "__VIEWSTATE" not in p1.hidden_inputs or "__EVENTVALIDATION" not in p1.hidden_inputs:
        raise RuntimeError("Required ASP.NET hidden state fields were not found.")

    payload = dict(p1.hidden_inputs)
    payload["__EVENTTARGET"] = target
    payload["__EVENTARGUMENT"] = ""

    data = urllib.parse.urlencode(payload).encode("utf-8")
    post_headers = dict(headers)
    post_headers.update({
        "Content-Type": "application/x-www-form-urlencoded",
        "Referer": LIST_URL,
    })

    print(f"POST page 2 target: {target}")
    req2 = urllib.request.Request(LIST_URL, data=data, headers=post_headers, method="POST")
    with opener.open(req2, timeout=30) as response:
        page2 = decode_response(response)

    with open("jc_archive_list_page2.html", "w", encoding="utf-8") as f:
        f.write(page2)

    p2 = ArchiveParser()
    p2.feed(page2)
    page2_links = unique(p2.detail_links)

    print(f"PAGE2_CURRENT: {p2.current_page or '(unknown)'}")
    print(f"PAGE2_LINKS: {len(page2_links)}")
    for link in page2_links:
        print(f"PAGE2_DETAIL: {link}")

    page1_ids = {url.rstrip('/').split('/')[-1] for url in page1_links}
    page2_ids = {url.rstrip('/').split('/')[-1] for url in page2_links}
    overlap = sorted(page1_ids & page2_ids)
    print(f"PAGE1_PAGE2_OVERLAP: {len(overlap)}")
    if overlap:
        print("OVERLAP_IDS: " + ", ".join(overlap))

    if p2.current_page != "2":
        raise RuntimeError(
            f"Postback returned current page {p2.current_page!r}, expected '2'."
        )

    if not page2_links:
        raise RuntimeError("Page 2 returned no detail links.")

    print("PAGE 2 PAGINATION TEST PASSED")
    print("SAVED_RAW_HTML: jc_archive_list_page2.html")
    print("NO FIRESTORE WRITES")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
