import json
import re
from pathlib import Path
from typing import List, Dict, Any

from docx import Document


# ========= عدّل هذه القيم لكل قانون =========
INPUT_DOCX = "قانون المخدرات والمؤثرات العقلية.docx"
OUTPUT_JSON = "drugs_and_psychotropic_substances_law_articles.json"

LAW_DOMAIN = "drugs"
LAW_NAME = "قانون المخدرات والمؤثرات العقلية الأردني"
LAW_NUMBER = "ضع الرقم الحقيقي هنا"
SOURCE_FILE = "قانون المخدرات والمؤثرات العقلية.docx"
# ===========================================


def normalize_spaces(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalize_arabic(text: str) -> str:
    text = text.lower()
    text = re.sub(r"[أإآا]", "ا", text)
    text = text.replace("ة", "ه")
    text = text.replace("ى", "ي")
    text = text.replace("ؤ", "و")
    text = text.replace("ئ", "ي")
    text = re.sub(r"[^\u0600-\u06FF0-9\s]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def slugify_arabic(text: str) -> str:
    text = normalize_arabic(text)
    text = text.replace(" ", "_")
    return text


def build_doc_id(law_domain: str, law_number: str, article_number: str) -> str:
    law_number_slug = slugify_arabic(law_number)
    article_slug = slugify_arabic(article_number)
    return f"{law_domain}_{law_number_slug}_{article_slug}"


def infer_article_title(article_number: str, article_text: str, article_title: str = "") -> str:
    # إذا كان العنوان موجودًا أصلًا، لا نغيّره
    if article_title and article_title.strip():
        return article_title.strip()

    seed = normalize_arabic(article_text)

    # قواعد عامة قدر الإمكان، ليست مخصصة للسرقة فقط
    title_rules = [
        # جزائي
        ("السرقة", ["سرقه", "سارق", "اختلس", "اختلاس"]),
        ("السرقة المشددة", ["سرقه", "ليلا", "حمل سلاح", "التعدد", "الكسر", "التسور"]),
        ("الاحتيال", ["احتيال", "احتال", "طرق احتياليه", "اسم كاذب", "صفه كاذبه"]),
        ("إساءة الائتمان", ["اساءه الائتمان", "امانه", "وديعه", "وكاله", "رهن", "عارية استعمال"]),
        ("التزوير", ["تزوير", "زور", "مزور", "محرر مزور"]),
        ("استعمال مزور", ["استعمل", "محرر مزور", "ورقه مزوره"]),
        ("الرشوة", ["رشوه", "مرتشي", "راشي"]),
        ("القتل", ["قتل", "قاتل", "وفاه", "ازهاق الروح"]),
        ("الإيذاء", ["ايذاء", "ضرب", "جرح", "عطل", "مرض"]),
        ("التهديد", ["تهديد", "هدد"]),
        ("القدح والذم", ["قدح", "ذم", "تحقير"]),
        ("إضرام الحريق", ["اضرام", "حريق", "اشعل النار"]),
        ("هتك العرض", ["هتك العرض"]),
        ("الاغتصاب", ["اغتصاب"]),
        ("الخطف", ["خطف", "حجز الحريه", "حرم حريته"]),
        ("الابتزاز", ["ابتزاز", "هدد بنشر", "مقابل منفعة"]),

        # مدني
        ("العقد", ["عقد", "التعاقد", "ايجاب", "قبول"]),
        ("بطلان العقد", ["بطلان", "ابطال", "قابل للابطال"]),
        ("فسخ العقد", ["فسخ", "انفساخ", "فسخ العقد"]),
        ("المسؤولية المدنية", ["مسؤوليه مدنيه", "تعويض", "ضرر", "فعل ضار"]),
        ("الإيجار", ["ايجار", "مستاجر", "موجر", "اجره"]),
        ("البيع", ["بيع", "مبيع", "ثمن"]),
        ("الملكية", ["ملكيه", "مالك", "حق الملكيه"]),
        ("الحيازة", ["حيازه", "وضع اليد"]),

        # تجاري
        ("الكمبيالة", ["كمبياله", "ساحب", "مسحوب عليه", "مستفيد"]),
        ("تظهير الكمبيالة", ["تظهير", "مظهر", "مظهر اليه"]),
        ("الشيك", ["شيك", "ساحب الشيك"]),
        ("السند لأمر", ["سند لامر"]),

        # إجراءات
        ("الدعوى", ["دعوى", "مدعي", "مدعى عليه"]),
        ("الاختصاص", ["اختصاص", "محكمه مختصه"]),
        ("التبليغ", ["تبليغ", "المبلغ اليه"]),
        ("الاستئناف", ["استئناف", "المستانف", "المستأنف"]),
        ("التمييز", ["تمييز", "محكمه التمييز"]),
        ("التنفيذ", ["تنفيذ", "دائره التنفيذ", "السند التنفيذي"]),

        # عمل
        ("عقد العمل", ["عقد عمل", "عامل", "صاحب العمل"]),
        ("الفصل التعسفي", ["فصل تعسفي", "انهاء الخدمه"]),
        ("مكافأة نهاية الخدمة", ["مكافاه نهايه الخدمه"]),

        # أحوال شخصية
        ("الزواج", ["زواج", "عقد الزواج"]),
        ("الطلاق", ["طلاق", "طلق", "الزوجه"]),
        ("الخلع", ["خلع", "افتداء"]),
        ("الحضانة", ["حضانه", "المحضون"]),
        ("النفقة", ["نفقه", "نفقة"]),
        ("المهر", ["مهر", "صداق"]),
    ]

    for title, hints in title_rules:
        if any(h in seed for h in hints):
            return title

    return ""


def extract_keywords(article_text: str, article_title: str = "", max_keywords: int = 20) -> List[str]:
    stop_words = {
        "في", "من", "على", "الى", "إلى", "عن", "ما", "ماذا", "هذا", "هذه", "ذلك", "تلك",
        "هو", "هي", "هم", "كما", "اذا", "إذا", "او", "أو", "و", "ثم", "قد", "لقد",
        "كان", "كانت", "يكون", "تكون", "كل", "أي", "اي", "لا", "لم", "لن", "انه", "أن",
        "ان", "بأن", "فان", "فإن", "ضمن", "عند", "لدى", "مع", "بعد", "قبل", "بين",
        "حيث", "وذلك", "عليها", "عليه", "لها", "له", "فيها", "فيه", "دون",
        "جميع", "احد", "إحدى", "اكثر", "أكثر", "اقل", "أقل", "الذي", "التي", "الذين",
        "اللاتي", "هناك", "هنا", "أيضا", "ايضا", "فقط",
        "وفق", "بموجب", "يجوز", "يجب", "تعتبر", "يعتبر", "تسري", "يعاقب", "الماده", "ماده",
        "اخذ", "مال", "الغير", "المنقول", "شيء", "اشياء", "شخص", "اشخاص", "احد", "احدى"
    }

    # Keywords قانونية أقوى بحسب العنوان المستنتج أو الأصلي
    legal_title_keywords = {
        "السرقة": ["سرقة", "السرقة", "سارق", "اختلاس", "مال منقول", "جرائم الأموال"],
        "السرقة المشددة": ["سرقة", "سرقة مشددة", "ليل", "حمل سلاح", "التعدد", "جرائم الأموال"],
        "الاحتيال": ["احتيال", "الاحتيال", "محتال", "طرق احتيالية", "جرائم الأموال"],
        "إساءة الائتمان": ["إساءة الائتمان", "ائتمان", "أمانة", "اختلاس", "جرائم الأموال"],
        "التزوير": ["تزوير", "التزوير", "محرر مزور", "تزوير أوراق", "جرائم الثقة العامة"],
        "استعمال مزور": ["استعمال مزور", "ورقة مزورة", "محرر مزور", "جرائم الثقة العامة"],
        "الرشوة": ["رشوة", "الرشوة", "راشي", "مرتشي", "الوظيفة العامة"],
        "القتل": ["قتل", "القتل", "جناية القتل", "جرائم الأشخاص"],
        "الإيذاء": ["إيذاء", "الإيذاء", "ضرب", "جرائم الأشخاص"],
        "التهديد": ["تهديد", "التهديد", "جرائم الأشخاص"],
        "القدح والذم": ["قدح", "ذم", "تحقير", "جرائم الشرف والاعتبار"],
        "إضرام الحريق": ["حريق", "إضرام الحريق", "إشعال النار", "جرائم الخطر العام"],
        "هتك العرض": ["هتك العرض", "جرائم العرض"],
        "الاغتصاب": ["اغتصاب", "جرائم العرض"],
        "الخطف": ["خطف", "حجز الحرية", "جرائم الأشخاص"],
        "الابتزاز": ["ابتزاز", "تهديد", "منفعة غير مشروعة"],

        "العقد": ["عقد", "التعاقد", "إيجاب", "قبول", "التزامات"],
        "بطلان العقد": ["بطلان العقد", "إبطال", "قابل للإبطال", "التزامات"],
        "فسخ العقد": ["فسخ العقد", "فسخ", "انفساخ", "التزامات"],
        "المسؤولية المدنية": ["مسؤولية مدنية", "تعويض", "ضرر", "فعل ضار"],
        "الإيجار": ["إيجار", "مستأجر", "مؤجر", "أجرة"],
        "البيع": ["بيع", "مبيع", "ثمن"],
        "الملكية": ["ملكية", "حق الملكية", "مالك"],
        "الحيازة": ["حيازة", "وضع اليد"],

        "الكمبيالة": ["كمبيالة", "ساحب", "مسحوب عليه", "مستفيد", "أوراق تجارية"],
        "تظهير الكمبيالة": ["تظهير", "مظهر", "مظهر إليه", "كمبيالة", "أوراق تجارية"],
        "الشيك": ["شيك", "ساحب الشيك", "أوراق تجارية"],
        "السند لأمر": ["سند لأمر", "أوراق تجارية"],

        "الدعوى": ["دعوى", "مدعي", "مدعى عليه", "إجراءات"],
        "الاختصاص": ["اختصاص", "محكمة مختصة", "إجراءات"],
        "التبليغ": ["تبليغ", "المبلغ إليه", "إجراءات"],
        "الاستئناف": ["استئناف", "مستأنف", "إجراءات"],
        "التمييز": ["تمييز", "محكمة التمييز", "إجراءات"],
        "التنفيذ": ["تنفيذ", "السند التنفيذي", "دائرة التنفيذ"],

        "عقد العمل": ["عقد عمل", "عامل", "صاحب العمل", "قانون العمل"],
        "الفصل التعسفي": ["فصل تعسفي", "إنهاء الخدمة", "قانون العمل"],
        "مكافأة نهاية الخدمة": ["مكافأة نهاية الخدمة", "قانون العمل"],

        "الزواج": ["زواج", "عقد الزواج", "أحوال شخصية"],
        "الطلاق": ["طلاق", "أحوال شخصية"],
        "الخلع": ["خلع", "أحوال شخصية"],
        "الحضانة": ["حضانة", "أحوال شخصية"],
        "النفقة": ["نفقة", "أحوال شخصية"],
        "المهر": ["مهر", "صداق", "أحوال شخصية"],
    }

    smart_keywords = []
    if article_title in legal_title_keywords:
        smart_keywords.extend(legal_title_keywords[article_title])

    seed = f"{article_title} {article_text}"
    norm = normalize_arabic(seed)
    words = norm.split()

    seen = set()
    keywords = []

    # أضف الكلمات القانونية الذكية أولًا
    for word in smart_keywords:
        norm_word = normalize_spaces(word)
        if norm_word and norm_word not in seen:
            seen.add(norm_word)
            keywords.append(norm_word)

    # ثم أضف كلمات النص المفيدة
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


def infer_category(article_text: str, article_title: str = "") -> str:
    seed = normalize_arabic(f"{article_title} {article_text}")

    mapping = [
        # جزائي
        ("جرائم الأموال", ["سرقه", "احتيال", "اساءه الائتمان", "اختلاس", "مال منقول"]),
        ("جرائم الثقة العامة", ["تزوير", "مزور", "محرر مزور", "استعمال مزور"]),
        ("جرائم الأشخاص", ["قتل", "ايذاء", "تهديد", "خطف"]),
        ("جرائم العرض", ["هتك العرض", "اغتصاب", "فعل مناف للحياه"]),
        ("الوظيفة العامة", ["رشوه", "مرتشي", "راشي"]),
        ("الخطر العام", ["حريق", "متفجرات", "اشعال النار"]),

        # مدني
        ("العقود", ["عقد", "التعاقد", "ايجاب", "قبول", "فسخ", "بطلان"]),
        ("المسؤولية المدنية", ["تعويض", "مسؤوليه مدنيه", "فعل ضار", "ضرر"]),
        ("الحقوق العينية", ["ملكيه", "حيازه", "عقار", "حق عيني"]),
        ("الإيجار", ["ايجار", "مستاجر", "موجر", "اجره"]),
        ("البيع", ["بيع", "مبيع", "ثمن"]),

        # تجاري
        ("الأوراق التجارية", ["كمبياله", "شيك", "سند لامر", "تظهير"]),
        ("الشركات", ["شركه", "شركات", "شريك", "هيئه عامه"]),
        ("الإفلاس والتسوية", ["افلاس", "تاجر متوقف", "صلح واق"]),

        # إجراءات
        ("الإجراءات", ["دعوى", "محكمه", "تبليغ", "تنفيذ", "بينه", "استئناف", "تمييز", "اختصاص"]),

        # عمل
        ("قانون العمل", ["عامل", "صاحب العمل", "اجور", "فصل تعسفي", "مكافاه نهايه الخدمه"]),

        # أحوال شخصية
        ("الأحوال الشخصية", ["زواج", "طلاق", "خلع", "حضانه", "نفقه", "مهر"]),
    ]

    for category, hints in mapping:
        if any(h in seed for h in hints):
            return category

    return "غير مصنف"


def parse_articles(full_text: str) -> List[Dict[str, Any]]:
    text = full_text.replace("\xa0", " ")
    text = re.sub(r"\r\n?", "\n", text)
    text = re.sub(r"\n{2,}", "\n", text).strip()

    pattern = re.compile(
        r"(المادة\s*(?:\(?\s*[\d]+(?:\s*مكررة(?:\s*ثانياً)?)?\s*\)?|[\d]+\s*:\s*مكررة))",
        re.UNICODE
    )

    matches = list(pattern.finditer(text))
    articles: List[Dict[str, Any]] = []

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
            if len(after_number.split()) <= 6:
                article_title = after_number
                article_text = rest
            else:
                article_text = f"{after_number} {rest}".strip()
        else:
            article_text = rest

        article_text = normalize_spaces(article_text)

        if not article_text:
            continue

        article_title = infer_article_title(article_number_raw, article_text, article_title)
        category = infer_category(article_text, article_title)
        doc_id = build_doc_id(LAW_DOMAIN, LAW_NUMBER, article_number_raw)

        doc = {
            "doc_id": doc_id,
            "law_domain": LAW_DOMAIN,
            "law_name": LAW_NAME,
            "law_number": LAW_NUMBER,
            "article_number": article_number_raw,
            "article_title": article_title,
            "article_text": article_text,
            "category": category,
            "keywords": extract_keywords(article_text, article_title),
            "source_file": SOURCE_FILE,
        }

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