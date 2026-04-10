import json
import re
from pathlib import Path

from docx import Document


INPUT_DOCX = "قانون العقوبات الأردني.docx"
OUTPUT_JSON = "penal_law_articles.json"

LAW_DOMAIN = "penal"
LAW_NAME = "قانون العقوبات الأردني"
LAW_NUMBER = "16 لسنة 1960"
SOURCE_FILE = INPUT_DOCX


def normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalize_arabic_for_keywords(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[أإآا]", "ا", text)
    text = text.replace("ة", "ه")
    text = text.replace("ى", "ي")
    text = text.replace("ؤ", "و")
    text = text.replace("ئ", "ي")
    text = re.sub(r"[^\u0600-\u06FF0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def extract_keywords(article_text: str, article_title: str = "", max_keywords: int = 12):
    stop_words = {
        "في", "من", "على", "الى", "إلى", "عن", "ما", "ماذا", "هذا", "هذه", "ذلك", "تلك",
        "هو", "هي", "هم", "كما", "اذا", "إذا", "او", "أو", "و", "ثم", "قد", "لقد",
        "كان", "كانت", "يكون", "تكون", "كل", "أي", "اي", "لا", "لم", "لن", "انه", "أن",
        "ان", "بأن", "فان", "فإن", "ضمن", "عند", "لدى", "مع", "بعد", "قبل", "بين",
        "حيث", "انه", "وذلك", "عليها", "عليه", "لها", "له", "فيها", "فيه", "دون",
        "جميع", "احد", "إحدى", "احدا", "اكثر", "أكثر", "اقل", "أقل", "سنة", "سنوات",
        "شهر", "اشهر", "يوم", "ايام", "الذي", "التي", "الذين", "اللاتي"
    }

    seed = f"{article_title} {article_text}"
    norm = normalize_arabic_for_keywords(seed)
    words = norm.split()

    seen = set()
    keywords = []

    for word in words:
        if len(word) < 2:
            continue
        if word in stop_words:
            continue
        if word.isdigit():
            continue
        if word not in seen:
            seen.add(word)
            keywords.append(word)

    return keywords[:max_keywords]


def detect_category(article_number: int) -> str:
    if 1 <= article_number <= 13:
        return "أحكام عامة"
    if 14 <= article_number <= 54:
        return "الأحكام الجزائية"
    if 55 <= article_number <= 109:
        return "الجريمة والمسؤولية"
    if 110 <= article_number <= 168:
        return "الجرائم الواقعة على أمن الدولة"
    if 169 <= article_number <= 222:
        return "الجرائم المخلة بالوظيفة العامة والثقة العامة"
    if 223 <= article_number <= 328:
        return "الجرائم الواقعة على الأشخاص"
    if 329 <= article_number <= 477:
        return "الجرائم الواقعة على الأموال وسائر الجرائم"
    return "غير مصنف"


def parse_articles(full_text: str):
    text = full_text.replace("\xa0", " ")
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"\n{2,}", "\n", text).strip()

    # يلتقط:
    # المادة 1
    # المادة (25 مكررة)
    # المادة 54: مكررة
    pattern = re.compile(
        r"(المادة\s*(?:\(?\s*[\d]+(?:\s*مكررة(?:\s*ثانياً)?)?\s*\)?|[\d]+\s*:\s*مكررة))",
        re.UNICODE
    )

    matches = list(pattern.finditer(text))
    articles = []

    for i, match in enumerate(matches):
        start = match.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        chunk = text[start:end].strip()

        first_line_break = chunk.find("\n")
        if first_line_break == -1:
            header_line = chunk
            rest = ""
        else:
            header_line = chunk[:first_line_break].strip()
            rest = chunk[first_line_break + 1:].strip()

        header_line = normalize_spaces(header_line)
        rest = normalize_spaces(rest)

        # أمثلة:
        # المادة 3 لا جريمة إلا بنص ...
        # المادة 14 العقوبات بصورة عامة ...
        # المادة 2
        # يكون للعبارات...
        inline_match = re.match(
            r"^المادة\s*(\(?\s*[\d]+(?:\s*مكررة(?:\s*ثانياً)?)?\s*\)?|[\d]+\s*:\s*مكررة)\s*(.*)$",
            header_line
        )

        if not inline_match:
            continue

        article_number_raw = normalize_spaces(inline_match.group(1))
        after_number = normalize_spaces(inline_match.group(2))

        article_title = ""
        article_text = ""

        if after_number:
            # إذا كان بعد الرقم عنوان قصير، نعتبره عنوانًا
            # وإذا كان جملة طويلة نعتبرها بداية النص
            if len(after_number.split()) <= 6:
                article_title = after_number
                article_text = rest
            else:
                article_text = f"{after_number} {rest}".strip()
        else:
            # نحاول استخراج عنوان من أول جزء من النص إذا كان قصيرًا
            if rest:
                parts = rest.split(" ", 6)
                short_head = " ".join(parts[:4]).strip()
                if len(short_head.split()) <= 4 and len(rest.split()) > 6:
                    article_title = short_head
                    article_text = rest
                else:
                    article_text = rest

        article_text = normalize_spaces(article_text)

        # نحاول استخراج رقم رقمي للتصنيف فقط
        number_match = re.search(r"\d+", article_number_raw)
        article_number_int = int(number_match.group()) if number_match else 0

        doc = {
            "law_name": LAW_NAME,
            "law_number": LAW_NUMBER,
            "article_number": article_number_raw,
            "article_title": article_title,
            "article_text": article_text,
            "category": detect_category(article_number_int),
            "keywords": extract_keywords(article_text, article_title),
        }

        # تجاهل المواد الفارغة
        if doc["article_text"]:
            articles.append(doc)

    return articles


def main():
    input_path = Path(INPUT_DOCX)

    if not input_path.exists():
      raise FileNotFoundError(f"لم يتم العثور على الملف: {INPUT_DOCX}")

    doc = Document(str(input_path))
    paragraphs = [p.text.strip() for p in doc.paragraphs if p.text.strip()]
    full_text = "\n".join(paragraphs)

    articles = parse_articles(full_text)

    output_path = Path(OUTPUT_JSON)
    output_path.write_text(
        json.dumps(articles, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    print(f"✅ تم استخراج {len(articles)} مادة")
    print(f"✅ تم إنشاء الملف: {OUTPUT_JSON}")


if __name__ == "__main__":
    main()