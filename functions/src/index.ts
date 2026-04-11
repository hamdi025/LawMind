/**
 * functions/src/index.ts
 */

import {defineSecret} from "firebase-functions/params";
import {onRequest} from "firebase-functions/v2/https";
import {setGlobalOptions} from "firebase-functions/v2";
import * as logger from "firebase-functions/logger";
import OpenAI from "openai";
import cors from "cors";
import * as admin from "firebase-admin";

setGlobalOptions({maxInstances: 10});

const openaiKey = defineSecret("OPENAI_API_KEY");
const visionApiKey = defineSecret("VISION_API_KEY");

if (!admin.apps.length) {
  admin.initializeApp();
}

const corsHandler = cors({origin: true});

/* ===================== Common helpers ===================== */

function runCors(req: any, res: any): Promise<void> {
  return new Promise((resolve, reject) => {
    corsHandler(req, res, (err: unknown) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function safeJsonParse(body: unknown): any | null {
  if (body == null) return null;
  if (typeof body === "object") return body;
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return null;
    }
  }
  return null;
}

function isNonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.trim().length > 0;
}

function clampText(s: string, max = 8000): string {
  return String(s ?? "").trim().slice(0, max);
}

function containsAny(text: string, keywords: string[]): boolean {
  const t = String(text ?? "").toLowerCase();
  return keywords.some((k) => t.includes(k.toLowerCase()));
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function isPlaceholderPrompt(p: string): boolean {
  const x = p.trim();
  return (
    x === "[prompt]" ||
    x === "{{prompt}}" ||
    x === "{prompt}" ||
    x.toLowerCase() === "prompt"
  );
}

function looksLikeBadOrGeneric(result: string): boolean {
  const r = result.toLowerCase();
  return (
    !result.trim() ||
    r.includes("it seems") ||
    r.includes("incomplete") ||
    r.includes("please provide") ||
    r.includes("your prompt") ||
    r.includes("لم يصلني") ||
    r.includes("لم تقدم") ||
    r.includes("يبدو أنك لم") ||
    r.includes("provide more details")
  );
}

function normalizeArabic(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[أإآا]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ـ/g, "")
    .replace(/[^\u0600-\u06FF0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countOccurrences(text: string, term: string): number {
  if (!text || !term) return 0;
  const normalizedText = normalizeArabic(text);
  const normalizedTerm = normalizeArabic(term);
  if (!normalizedTerm) return 0;
  return normalizedText.split(normalizedTerm).length - 1;
}

/* ===================== Request parsers ===================== */

function pickPrompt(req: any, body: any): string | null {
  const candidates = [
    body?.prompt,
    body?.data?.prompt,
    body?.json?.prompt,
    body?.params?.prompt,
    req?.query?.prompt,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }

  return null;
}

function pickRequestMode(body: any): "qa" | "case_analysis" {
  const mode = (body?.mode ?? body?.data?.mode ?? "")
    .toString()
    .trim()
    .toLowerCase();

  return mode === "case_analysis" ? "case_analysis" : "qa";
}

function pickCaseFacts(body: any): string {
  const c =
    body?.caseFacts ??
    body?.data?.caseFacts ??
    body?.case_facts ??
    body?.facts ??
    body?.data?.facts ??
    "";

  return typeof c === "string" ? c : String(c ?? "");
}

function pickQuestions(body: any): string {
  const q =
    body?.questions ??
    body?.data?.questions ??
    body?.lawyerQuestions ??
    body?.data?.lawyerQuestions ??
    "";

  return typeof q === "string" ? q : String(q ?? "");
}

function extractDocumentTextFromPrompt(prompt: string): string | null {
  const markers = [
    "النص:",
    "النص القانوني:",
    "المستند:",
    "المحتوى:",
    "ocr:",
    "OCR:",
    "وقائع القضية:",
  ];

  for (const marker of markers) {
    const idx = prompt.lastIndexOf(marker);
    if (idx >= 0) {
      const extracted = prompt.slice(idx + marker.length).trim();
      if (extracted.length >= 80) return extracted;
    }
  }

  return null;
}

function isNumbersRequest(prompt: string): boolean {
  return containsAny(prompt, [
    "كم مدة",
    "كم المدة",
    "مدة العقوبة",
    "ما مدة",
    "ما هي مدة",
    "كم غرامة",
    "قيمة الغرامة",
    "كم تبلغ الغرامة",
    "كم الرسوم",
    "قيمة الرسوم",
    "رقم المادة",
    "نص المادة",
    "ما هي المادة",
    "المادة رقم",
    "كم سنة",
    "كم شهر",
    "كم يوم",
    "كم يومًا",
    "ما المدة",
    "ما هي مدة الطعن",
    "مدة الطعن",
  ]);
}

/* ===================== Domain / legal routing ===================== */

type LawDomain =
  | "traffic"
  | "sharia"
  | "procedure"
  | "penal"
  | "labor"
  | "execution"
  | "evidence"
  | "criminal_procedure"
  | "companies"
  | "commercial"
  | "civil"
  | "media"
  | "aml_ctf"
  | "anti_terrorism"
  | "cybercrime"
  | "social_security"
  | "rent"
  | "e_transactions"
  | "drugs";

type LegalStage =
  | "attempt"
  | "use_of_forged"
  | "participation"
  | "incitement"
  | "intervention"
  | "appeal"
  | "execution_request"
  | "evidence_denial"
  | "forgery_incident"
  | "none";

type OffenseSlug =
  | "killing"
  | "theft"
  | "embezzlement"
  | "breach_of_trust"
  | "fraud"
  | "forgery"
  | "use_of_forged_document"
  | "drugs_possession"
  | "drugs_use"
  | "drugs_promotion"
  | "drugs_trafficking"
  | "traffic_violation"
  | "injury"
  | "threat"
  | "kidnapping"
  | "bribery"
  | "cybercrime"
  | "money_laundering"
  | "terrorism"
  | "perjury";

type LegalIntent = {
  asksForPunishment: boolean;
  asksForDefinition: boolean;
  asksForConditions: boolean;
  asksForArticleText: boolean;
  asksForDurationOrAmount: boolean;
  asksForDistribution: boolean;
};

type JordanLawDoc = {
  id: string;
  law_domain?: string;
  law_name: string;
  law_number: string;
  article_number: string;
  article_title: string;
  article_text: string;
  category: string;
  keywords: string[];
};

type ArticleRole =
  | "general_definition"
  | "general_punishment"
  | "aggravated_punishment"
  | "mitigating_excuse"
  | "attempt_or_participation"
  | "procedural_or_other";

type RankedLaw = {
  law: JordanLawDoc;
  score: number;
  role: ArticleRole;
  reasons: string[];
};

type ScenarioAnalysis = {
  domain: LawDomain;
  stages: LegalStage[];
  offenses: OffenseSlug[];
  domainKeywords: string[];
  specificKeywords: string[];
  victimsCountHint: number;
  mentionsWeapon: boolean;
  mentionsNight: boolean;
  mentionsMultipleOffenders: boolean;
  mentionsRecidivism: boolean;
  mentionsCompositeLink: boolean;
  hasMitigatingExcuseContext: boolean;
  explanationHints: string[];
};

function detectLegalIntent(prompt: string): LegalIntent {
  const p = normalizeArabic(prompt);

  return {
    asksForPunishment:
      p.includes("عقوبه") ||
      p.includes("العقوبه") ||
      p.includes("جزاء") ||
      p.includes("عقوبة"),
    asksForDefinition:
      p.includes("تعريف") ||
      p.includes("ما هو") ||
      p.includes("ماهي") ||
      p.includes("ما هي"),
    asksForConditions:
      p.includes("شروط") ||
      p.includes("اركان") ||
      p.includes("أركان") ||
      p.includes("متطلبات"),
    asksForArticleText:
      p.includes("نص الماده") ||
      p.includes("نص المادة") ||
      p.includes("رقم الماده") ||
      p.includes("رقم المادة"),
    asksForDurationOrAmount:
      p.includes("كم") ||
      p.includes("مده") ||
      p.includes("مدة") ||
      p.includes("غرامه") ||
      p.includes("غرامة") ||
      p.includes("مدة الطعن"),
    asksForDistribution:
      p.includes("توزيع") ||
      p.includes("تركة") ||
      p.includes("ميراث") ||
      p.includes("ورث") ||
      p.includes("كيف توزع"),
  };
}

function detectLegalDomain(question: string): LawDomain {
  const q = normalizeArabic(question);

  if (
    q.includes("سير") ||
    q.includes("مرور") ||
    q.includes("مخالفه مروريه") ||
    q.includes("مخالفة مرورية") ||
    q.includes("رخصه قياده") ||
    q.includes("رخصة قيادة") ||
    q.includes("اشاره ضوئيه") ||
    q.includes("اشاره حمراء") ||
    q.includes("اشارة حمراء") ||
    q.includes("اشاره") ||
    q.includes("إشارة") ||
    q.includes("قطع الاشاره") ||
    q.includes("قطع الاشارة") ||
    q.includes("سرعه") ||
    q.includes("سرعة") ||
    q.includes("تجاوز السرعه") ||
    q.includes("تجاوز السرعة") ||
    q.includes("قياده") ||
    q.includes("قيادة") ||
    q.includes("حادث سير") ||
    q.includes("دهس") ||
    q.includes("مركبه") ||
    q.includes("مركبة") ||
    q.includes("لوحه") ||
    q.includes("لوحة") ||
    q.includes("نقاط مروريه") ||
    q.includes("نقاط مرورية")
  ) {
    return "traffic";
  }

  if (
    q.includes("مخدر") ||
    q.includes("ماده مخدره") ||
    q.includes("مادة مخدرة") ||
    q.includes("مواد مخدره") ||
    q.includes("مواد مخدرة") ||
    q.includes("تعاطي") ||
    q.includes("ترويج") ||
    q.includes("اتجار") ||
    q.includes("ال اتجار") ||
    q.includes("حيازه") ||
    q.includes("حيازة") ||
    q.includes("احراز") ||
    q.includes("إحراز") ||
    q.includes("بقصد التعاطي") ||
    q.includes("بقصد الترويج") ||
    q.includes("مؤثرات عقليه") ||
    q.includes("مؤثرات عقلية")
  ) {
    return "drugs";
  }

  if (
    q.includes("تركة") ||
    q.includes("ميراث") ||
    q.includes("ورث") ||
    q.includes("يرث") ||
    q.includes("عدة") ||
    q.includes("طلاق") ||
    q.includes("خلع") ||
    q.includes("نفقه") ||
    q.includes("نفقة") ||
    q.includes("حضانه") ||
    q.includes("حضانة") ||
    q.includes("مهر") ||
    q.includes("احوال شخصيه") ||
    q.includes("أحوال شخصية") ||
    q.includes("محكمة شرعية")
  ) {
    return "sharia";
  }

  if (
    q.includes("عامل") ||
    q.includes("صاحب العمل") ||
    q.includes("فصل تعسفي") ||
    q.includes("فصلا تعسفيا") ||
    q.includes("فصلا تعسفياً") ||
    q.includes("مكافاه") ||
    q.includes("مكافأة") ||
    q.includes("عقد عمل") ||
    q.includes("اجور") ||
    q.includes("أجور") ||
    q.includes("اجازه سنويه") ||
    q.includes("إجازة سنوية")
  ) {
    return "labor";
  }

  if (
    q.includes("حبس المدين") ||
    q.includes("حبس تنفيذي") ||
    q.includes("تنفيذ حكم") ||
    q.includes("تنفيذيا") ||
    q.includes("تنفيذياً") ||
    q.includes("دائرة التنفيذ") ||
    q.includes("تنفيذي")
  ) {
    return "execution";
  }

  if (
    q.includes("السند العادي") ||
    q.includes("حجية السند") ||
    q.includes("حجيه السند") ||
    q.includes("انكر التوقيع") ||
    q.includes("أنكر التوقيع") ||
    q.includes("الانكار") ||
    q.includes("إنكار") ||
    q.includes("خبرة خطية") ||
    q.includes("خبره خطيه") ||
    q.includes("التزوير الفرعي") ||
    q.includes("تزوير فرعي") ||
    q.includes("الاثبات") ||
    q.includes("الإثبات")
  ) {
    return "evidence";
  }

  if (
    q.includes("استئناف الحكم الجزائي") ||
    q.includes("الحكم الجزائي") ||
    q.includes("دعوى الحق العام") ||
    q.includes("الحق الشخصي") ||
    q.includes("اسقاط الحق الشخصي") ||
    q.includes("إسقاط الحق الشخصي") ||
    q.includes("مده الطعن") ||
    q.includes("مدة الطعن") ||
    q.includes("محكمه الجزاء") ||
    q.includes("محكمة الجزاء") ||
    q.includes("النيابه العامه") ||
    q.includes("النيابة العامة") ||
    q.includes("اصول المحاكمات الجزائيه") ||
    q.includes("أصول المحاكمات الجزائية")
  ) {
    return "criminal_procedure";
  }

  if (
    q.includes("اختصاص") ||
    q.includes("تبليغ") ||
    q.includes("وقف تنفيذ الحكم") ||
    q.includes("وقف التنفيذ") ||
    q.includes("الطعن بالاستئناف") ||
    q.includes("اصول المحاكمات") ||
    q.includes("أصول المحاكمات") ||
    q.includes("إجراءات الدعوى")
  ) {
    return "procedure";
  }

  if (
    q.includes("ضمان اجتماعي") ||
    q.includes("الضمان الاجتماعي") ||
    q.includes("اصابة عمل") ||
    q.includes("إصابة عمل") ||
    q.includes("راتب اعتلال")
  ) {
    return "social_security";
  }

  if (
    q.includes("ايجار") ||
    q.includes("إيجار") ||
    q.includes("ماجور") ||
    q.includes("مأجور") ||
    q.includes("بدل المثل") ||
    q.includes("اخلاء ماجور") ||
    q.includes("إخلاء مأجور")
  ) {
    return "rent";
  }

  if (
    q.includes("شركه") ||
    q.includes("شركة") ||
    q.includes("مساهمه") ||
    q.includes("مساهمة") ||
    q.includes("اسهم") ||
    q.includes("أسهم") ||
    q.includes("مجلس اداره") ||
    q.includes("مجلس إدارة")
  ) {
    return "companies";
  }

  if (
    q.includes("شيك") ||
    q.includes("كمبياله") ||
    q.includes("كمبيالة") ||
    q.includes("سند لامر") ||
    q.includes("سند لأمر") ||
    q.includes("اعمال تجاريه") ||
    q.includes("أعمال تجارية") ||
    q.includes("تاجر")
  ) {
    return "commercial";
  }

  if (
    q.includes("عقد") ||
    q.includes("تعويض") ||
    q.includes("مسؤوليه مدنيه") ||
    q.includes("مسؤولية مدنية") ||
    q.includes("بطلان") ||
    q.includes("فسخ") ||
    q.includes("التزام")
  ) {
    return "civil";
  }

  if (
    q.includes("جرائم الكترونيه") ||
    q.includes("جرائم إلكترونية") ||
    q.includes("اختراق") ||
    q.includes("هكر") ||
    q.includes("الكتروني") ||
    q.includes("إلكتروني")
  ) {
    return "cybercrime";
  }

  if (
    q.includes("معاملات الكترونيه") ||
    q.includes("معاملات إلكترونية") ||
    q.includes("توقيع الكتروني") ||
    q.includes("توقيع إلكتروني")
  ) {
    return "e_transactions";
  }

  if (
    q.includes("غسل اموال") ||
    q.includes("غسل أموال") ||
    q.includes("تمويل الارهاب") ||
    q.includes("تمويل الإرهاب")
  ) {
    return "aml_ctf";
  }

  if (
    q.includes("ارهاب") ||
    q.includes("إرهاب")
  ) {
    return "anti_terrorism";
  }

  if (
    q.includes("اعلام") ||
    q.includes("إعلام") ||
    q.includes("نشر") ||
    q.includes("صحفي")
  ) {
    return "media";
  }

  return "penal";
}

function detectLegalStages(question: string): LegalStage[] {
  const q = normalizeArabic(question);
  const stages: LegalStage[] = [];

  if (q.includes("شروع") || q.includes("محاوله") || q.includes("محاولة")) {
    stages.push("attempt");
  }

  if (
    q.includes("استعمال مزور") ||
    q.includes("استعمال سند مزور") ||
    q.includes("استعمال محرر مزور") ||
    (q.includes("استعمال") && q.includes("مزور"))
  ) {
    stages.push("use_of_forged");
  }

  if (q.includes("اشتراك") || q.includes("بالاشتراك")) {
    stages.push("participation");
  }

  if (q.includes("تحريض")) {
    stages.push("incitement");
  }

  if (q.includes("تدخل")) {
    stages.push("intervention");
  }

  if (q.includes("استئناف") || q.includes("الطعن")) {
    stages.push("appeal");
  }

  if (q.includes("حبس المدين") || q.includes("تنفيذيا") || q.includes("تنفيذي")) {
    stages.push("execution_request");
  }

  if (
    q.includes("انكر التوقيع") ||
    q.includes("أنكر التوقيع") ||
    q.includes("انكار التوقيع") ||
    q.includes("إنكار التوقيع")
  ) {
    stages.push("evidence_denial");
  }

  if (q.includes("تزوير فرعي") || q.includes("التزوير الفرعي")) {
    stages.push("forgery_incident");
  }

  return stages.length ? stages : ["none"];
}

function detectOffenses(question: string): OffenseSlug[] {
  const q = normalizeArabic(question);
  const offenses: OffenseSlug[] = [];

  if (q.includes("قتل")) offenses.push("killing");
  if (q.includes("سرقه")) offenses.push("theft");
  if (q.includes("اختلاس")) offenses.push("embezzlement");
  if (q.includes("خيانه الامانه") || q.includes("خيانة الأمانة")) offenses.push("breach_of_trust");
  if (q.includes("احتيال")) offenses.push("fraud");
  if (q.includes("تزوير")) offenses.push("forgery");
  if ((q.includes("استعمال") || q.includes("استعمل")) && q.includes("مزور")) {
    offenses.push("use_of_forged_document");
  }
  if (q.includes("حيازه") && q.includes("مخدر")) offenses.push("drugs_possession");
  if (q.includes("تعاطي") && q.includes("مخدر")) offenses.push("drugs_use");
  if (q.includes("ترويج")) offenses.push("drugs_promotion");
  if (q.includes("اتجار") && q.includes("مخدر")) offenses.push("drugs_trafficking");
  if (q.includes("اشاره حمراء") || q.includes("اشارة حمراء") || q.includes("مخالفه مروريه") || q.includes("مخالفة مرورية")) {
    offenses.push("traffic_violation");
  }
  if (q.includes("ايذاء") || q.includes("إيذاء")) offenses.push("injury");
  if (q.includes("تهديد")) offenses.push("threat");
  if (q.includes("خطف")) offenses.push("kidnapping");
  if (q.includes("رشوه")) offenses.push("bribery");
  if (q.includes("غسل اموال") || q.includes("غسل أموال")) offenses.push("money_laundering");
  if (q.includes("ارهاب") || q.includes("إرهاب")) offenses.push("terrorism");
  if (q.includes("شهاده الزور") || q.includes("شهادة الزور")) offenses.push("perjury");
  if (q.includes("جرائم الكترونيه") || q.includes("جرائم إلكترونية") || q.includes("اختراق")) {
    offenses.push("cybercrime");
  }

  return unique(offenses);
}

function inferVictimsCountHint(question: string): number {
  const q = normalizeArabic(question);

  if (
    q.includes("اكثر من شخص") ||
    q.includes("أكثر من شخص") ||
    q.includes("شخصين") ||
    q.includes("اثنين") ||
    q.includes("عدة اشخاص") ||
    q.includes("عده اشخاص")
  ) {
    return 2;
  }

  return 1;
}

function getOffenseLexicon(offense: OffenseSlug): string[] {
  switch (offense) {
  case "killing":
    return ["قتل", "القتل", "قتل قصدا", "القتل قصدا", "قتل انسانا"];
  case "theft":
    return ["سرقه", "السرقه", "سارق", "اخذ مال الغير"];
  case "embezzlement":
    return ["اختلاس", "مختلس", "اختلس", "المال المسلم اليه", "الموظف العام"];
  case "breach_of_trust":
    return ["خيانه الامانه", "خيانة الأمانة", "اساءه الائتمان", "إساءة الائتمان"];
  case "fraud":
    return ["احتيال", "الاحتيال", "خداع"];
  case "forgery":
    return ["تزوير", "التزوير", "مزور", "تحريف"];
  case "use_of_forged_document":
    return ["استعمال مزور", "استعمال سند مزور", "استعمال محرر مزور", "استعمل المزور"];
  case "drugs_possession":
    return ["حيازه", "حيازة", "احراز", "إحراز", "ماده مخدره", "مادة مخدرة", "مواد مخدره", "مواد مخدرة"];
  case "drugs_use":
    return ["تعاطي", "تعاطى", "استعمال مواد مخدره", "استعمال مواد مخدرة"];
  case "drugs_promotion":
    return ["ترويج", "روج", "بقصد الترويج"];
  case "drugs_trafficking":
    return ["اتجار", "الاتجار", "بيع مواد مخدره", "بيع مواد مخدرة", "استيراد", "تصدير"];
  case "traffic_violation":
    return ["اشاره حمراء", "اشارة حمراء", "مخالفه مروريه", "مخالفة مرورية", "رخصة قيادة", "رخصه قياده"];
  case "injury":
    return ["ايذاء", "إيذاء", "ضرب", "جرح"];
  case "threat":
    return ["تهديد"];
  case "kidnapping":
    return ["خطف", "اختطاف"];
  case "bribery":
    return ["رشوه", "الرشوة"];
  case "money_laundering":
    return ["غسل اموال", "غسل أموال"];
  case "terrorism":
    return ["ارهاب", "إرهاب"];
  case "perjury":
    return ["شهاده الزور", "شهادة الزور"];
  case "cybercrime":
    return ["جرائم الكترونيه", "جرائم إلكترونية", "اختراق", "دخول غير مشروع"];
  default:
    return [];
  }
}

function getDomainKeywords(domain: LawDomain): string[] {
  switch (domain) {
  case "traffic":
    return ["قانون السير", "مرور", "مخالفه مروريه", "مخالفة مرورية", "اشاره حمراء", "اشارة حمراء"];
  case "drugs":
    return ["مخدر", "مواد مخدره", "مواد مخدرة", "تعاطي", "ترويج", "اتجار", "قانون المخدرات"];
  case "sharia":
    return ["احوال شخصيه", "أحوال شخصية", "ميراث", "تركة", "طلاق", "عدة", "نفقة", "حضانة"];
  case "labor":
    return ["قانون العمل", "فصل تعسفي", "عامل", "اشعار", "إشعار", "اجازة", "إجازة"];
  case "execution":
    return ["تنفيذ", "حبس المدين", "حبس تنفيذي", "دائره التنفيذ", "دائرة التنفيذ"];
  case "evidence":
    return ["اثبات", "إثبات", "السند العادي", "انكار التوقيع", "إنكار التوقيع", "تزوير فرعي"];
  case "criminal_procedure":
    return ["اصول المحاكمات الجزائيه", "أصول المحاكمات الجزائية", "استئناف", "الحق الشخصي", "دعوى الحق العام"];
  case "procedure":
    return ["اصول المحاكمات", "أصول المحاكمات", "وقف التنفيذ", "وقف تنفيذ الحكم"];
  case "companies":
    return ["شركه", "شركة", "مساهمه", "مساهمة", "اسهم", "أسهم"];
  case "commercial":
    return ["تجاري", "شيك", "كمبياله", "كمبيالة", "سند لأمر"];
  case "civil":
    return ["مدني", "تعويض", "مسؤوليه مدنيه", "مسؤولية مدنية", "عقد"];
  case "social_security":
    return ["ضمان اجتماعي", "إصابة عمل"];
  case "rent":
    return ["إيجار", "مأجور", "بدل المثل", "إخلاء مأجور"];
  case "cybercrime":
    return ["جرائم إلكترونية", "اختراق", "الكتروني", "إلكتروني"];
  case "e_transactions":
    return ["توقيع إلكتروني", "معاملات إلكترونية"];
  case "aml_ctf":
    return ["غسل أموال", "تمويل الإرهاب"];
  case "anti_terrorism":
    return ["إرهاب"];
  case "media":
    return ["إعلام", "نشر", "صحفي"];
  case "penal":
    return [];
  default:
    return [];
  }
}

function analyzeScenario(question: string): ScenarioAnalysis {
  const q = normalizeArabic(question);
  const domain = detectLegalDomain(question);
  const stages = detectLegalStages(question);
  const offenses = detectOffenses(question);

  const mentionsWeapon =
    q.includes("سلاح") ||
    q.includes("مسدس") ||
    q.includes("بندقيه") ||
    q.includes("سكين");

  const mentionsNight = q.includes("ليلا") || q.includes("ليل");
  const mentionsMultipleOffenders =
    q.includes("شخصين") ||
    q.includes("شخصان") ||
    q.includes("اكثر من شخص") ||
    q.includes("بالمشاركه") ||
    q.includes("اشتراك");

  const mentionsRecidivism =
    q.includes("تكرار") ||
    q.includes("اعتياد") ||
    q.includes("سابقه") ||
    q.includes("سابقة") ||
    q.includes("عود");

  const mentionsCompositeLink =
    q.includes("مع") ||
    q.includes("بالاضافه الى") ||
    q.includes("بالإضافة إلى") ||
    q.includes("مقترن") ||
    q.includes("بقصد") ||
    q.includes("اثناء") ||
    q.includes("أثناء");

  const hasMitigatingExcuseContext =
    q.includes("فوجئ") ||
    q.includes("متلبسه بالزنا") ||
    q.includes("حال تلبسها") ||
    q.includes("العذر المخفف");

  const explanationHints: string[] = [];
  const specificKeywords: string[] = [];

  if (stages.includes("attempt")) {
    explanationHints.push("السؤال يتعلق بالشروع، فلا يكفي استرجاع الجريمة التامة وحدها.");
    specificKeywords.push("شروع", "محاولة");
  }

  if (stages.includes("use_of_forged")) {
    explanationHints.push("السؤال يتعلق باستعمال المزور، ويجب تقديم النص الخاص بالاستعمال قبل النصوص العامة للتزوير.");
    specificKeywords.push("استعمال مزور", "استعمل المزور");
  }

  if (stages.includes("participation")) {
    explanationHints.push("السؤال يتعلق بالاشتراك، ويجب مراعاة نصوص الاشتراك أو التحريض أو التدخل إن وجدت.");
    specificKeywords.push("اشتراك");
  }

  if (domain === "traffic") {
    explanationHints.push("السؤال مروري ويجب استبعاد نصوص قانون العقوبات العامة غير المتعلقة بالسير.");
  }

  if (domain === "drugs") {
    explanationHints.push("السؤال متعلق بالمخدرات ويجب استبعاد نصوص تعاطي المسكرات وقانون العقوبات العام ما لم يكن هناك نص خاص.");
  }

  if (domain === "sharia") {
    explanationHints.push("السؤال من الأحوال الشخصية/الشريعة ويجب استبعاد قانون العقوبات تمامًا.");
  }

  if (domain === "execution") {
    explanationHints.push("السؤال تنفيذي ويجب تقديم نصوص التنفيذ على أصول المحاكمات العامة.");
  }

  if (domain === "evidence") {
    explanationHints.push("السؤال من قانون الإثبات ويجب عدم الخلط بين التزوير كجريمة وبين الطعن بالتزوير أو إنكار التوقيع كمسألة إثبات.");
  }

  if (domain === "criminal_procedure") {
    explanationHints.push("السؤال إجرائي جزائي ويجب تقديم نصوص أصول المحاكمات الجزائية قبل مواد التجريم.");
  }

  if (offenses.includes("killing") && offenses.includes("theft")) {
    specificKeywords.push("تمهيدا", "تسهيلا", "تنفيذا");
  }

  if (offenses.includes("traffic_violation")) {
    specificKeywords.push("إشارة حمراء", "قطع الإشارة", "قانون السير");
  }

  if (offenses.includes("drugs_possession") || offenses.includes("drugs_use")) {
    specificKeywords.push("مواد مخدرة", "قصد التعاطي", "قانون المخدرات");
  }

  return {
    domain,
    stages,
    offenses,
    domainKeywords: getDomainKeywords(domain),
    specificKeywords: unique(specificKeywords),
    victimsCountHint: inferVictimsCountHint(question),
    mentionsWeapon,
    mentionsNight,
    mentionsMultipleOffenders,
    mentionsRecidivism,
    mentionsCompositeLink,
    hasMitigatingExcuseContext,
    explanationHints,
  };
}

/* ===================== Retrieval / ranking ===================== */

function classifyArticleRole(law: JordanLawDoc): ArticleRole {
  const title = normalizeArabic(law.article_title || "");
  const text = normalizeArabic(law.article_text || "");
  const lawName = normalizeArabic(law.law_name || "");

  if (
    text.includes("فوجئ بزوجته") ||
    text.includes("حال تلبسها") ||
    title.includes("العذر في القتل") ||
    text.includes("العذر المخفف")
  ) {
    return "mitigating_excuse";
  }

  if (
    text.includes("تعني") ||
    text.includes("يقصد") ||
    text.includes("تعريف") ||
    title.includes("تعريف")
  ) {
    return "general_definition";
  }

  if (
    text.includes("شروع") ||
    text.includes("محاوله") ||
    text.includes("محاولة") ||
    text.includes("تحريض") ||
    text.includes("متدخل") ||
    text.includes("اشتراك") ||
    lawName.includes("اصول المحاكمات") ||
    lawName.includes("الإثبات") ||
    lawName.includes("التنفيذ")
  ) {
    return "attempt_or_participation";
  }

  if (
    text.includes("ظروف مشدده") ||
    text.includes("ليلا") ||
    text.includes("ليل") ||
    text.includes("بواسطه شخصين او اكثر") ||
    text.includes("شخصين او اكثر") ||
    text.includes("اكثر من شخص") ||
    text.includes("سبق الاصرار") ||
    text.includes("الإعدام") ||
    text.includes("مؤبده")
  ) {
    return "aggravated_punishment";
  }

  if (
    text.includes("يعاقب") ||
    text.includes("الحبس") ||
    text.includes("السجن") ||
    text.includes("الغرامه") ||
    text.includes("الغرامة") ||
    text.includes("الاشغال")
  ) {
    return "general_punishment";
  }

  return "procedural_or_other";
}

function buildSearchKeywords(
  question: string,
  intent: LegalIntent,
  scenario: ScenarioAnalysis,
): string[] {
  const base = unique(
    normalizeArabic(question)
      .split(" ")
      .filter((x) => x.length >= 2),
  ).slice(0, 20);

  const extras: string[] = [
    ...scenario.domainKeywords,
    ...scenario.specificKeywords,
  ];

  if (intent.asksForPunishment) {
    extras.push("يعاقب", "عقوبه", "عقوبة");
  }

  if (intent.asksForArticleText) {
    extras.push("نص المادة", "رقم المادة");
  }

  for (const offense of scenario.offenses) {
    extras.push(...getOffenseLexicon(offense));
  }

  if (scenario.mentionsNight) extras.push("ليل", "ليلا");
  if (scenario.mentionsMultipleOffenders) extras.push("اشتراك", "شخصين او اكثر");
  if (scenario.mentionsWeapon) extras.push("سلاح");
  if (scenario.victimsCountHint >= 2) extras.push("اكثر من شخص", "شخصين");

  return unique([...base, ...extras]).slice(0, 40);
}

function articleMatchesOffense(law: JordanLawDoc, offense: OffenseSlug): boolean {
  const title = normalizeArabic(law.article_title || "");
  const text = normalizeArabic(law.article_text || "");
  const category = normalizeArabic(law.category || "");
  const lawName = normalizeArabic(law.law_name || "");
  const keywords = (law.keywords || []).map(normalizeArabic);

  const lexicon = getOffenseLexicon(offense).map(normalizeArabic);

  const titleHit = lexicon.some((term) => title.includes(term));
  const keywordHit = lexicon.some((term) => keywords.some((k) => k.includes(term)));
  const categoryHit = lexicon.some((term) => category.includes(term));
  const lawNameHit = lexicon.some((term) => lawName.includes(term));
  const textHits = lexicon.reduce((acc, term) => acc + countOccurrences(text, term), 0);

  return titleHit || keywordHit || categoryHit || lawNameHit || textHits >= 2;
}

function articleMatchesStage(law: JordanLawDoc, stage: LegalStage): boolean {
  const blob = normalizeArabic(
    `${law.article_title} ${law.article_text} ${(law.keywords || []).join(" ")} ${law.category} ${law.law_name}`,
  );

  switch (stage) {
  case "attempt":
    return blob.includes("شروع") || blob.includes("محاوله") || blob.includes("محاولة");
  case "use_of_forged":
    return blob.includes("استعمل المزور") || blob.includes("استعمال مزور") || blob.includes("استعمال سند مزور");
  case "participation":
    return blob.includes("اشتراك") || blob.includes("شريك");
  case "incitement":
    return blob.includes("تحريض");
  case "intervention":
    return blob.includes("تدخل") || blob.includes("متدخل");
  case "appeal":
    return blob.includes("استئناف") || blob.includes("الطعن");
  case "execution_request":
    return blob.includes("حبس المدين") || blob.includes("تنفيذ") || blob.includes("الدائن");
  case "evidence_denial":
    return blob.includes("انكر التوقيع") || blob.includes("إنكار التوقيع") || blob.includes("التوقيع");
  case "forgery_incident":
    return blob.includes("التزوير الفرعي") || blob.includes("تزوير فرعي");
  default:
    return false;
  }
}

function lawNameDomainBoost(law: JordanLawDoc, domain: LawDomain): number {
  const name = normalizeArabic(law.law_name || "");
  const field = normalizeArabic(law.law_domain || "");

  if (field === normalizeArabic(domain)) return 90;

  switch (domain) {
  case "traffic":
    return name.includes("السير") ? 80 : -150;
  case "drugs":
    return name.includes("المخدرات") || name.includes("المؤثرات العقليه") || name.includes("المؤثرات العقلية") ?
      80 :
      name.includes("العقوبات") ? -160 : -100;
  case "sharia":
    return name.includes("الاحوال الشخصيه") || name.includes("الأحوال الشخصية") ? 80 : -180;
  case "labor":
    return name.includes("العمل") ? 80 : -120;
  case "execution":
    return name.includes("التنفيذ") ? 85 : -140;
  case "evidence":
    return name.includes("الاثبات") || name.includes("الإثبات") ? 85 : -140;
  case "criminal_procedure":
    return name.includes("اصول المحاكمات الجزائيه") || name.includes("أصول المحاكمات الجزائية") ?
      85 :
      name.includes("العقوبات") ? -120 : -100;
  case "procedure":
    return name.includes("اصول المحاكمات") || name.includes("أصول المحاكمات") ? 70 : -80;
  case "companies":
    return name.includes("الشركات") ? 80 : -100;
  case "commercial":
    return name.includes("التجاره") || name.includes("التجاري") ? 80 : -100;
  case "civil":
    return name.includes("المدني") ? 80 : -100;
  case "social_security":
    return name.includes("الضمان الاجتماعي") ? 80 : -100;
  case "rent":
    return name.includes("المالكين") || name.includes("المستاجرين") || name.includes("المستأجرين") ? 80 : -100;
  case "cybercrime":
    return name.includes("الجرائم الالكترونيه") || name.includes("الجرائم الإلكترونية") ? 80 : -100;
  case "e_transactions":
    return name.includes("المعاملات الالكترونيه") || name.includes("المعاملات الإلكترونية") ? 80 : -100;
  case "aml_ctf":
    return name.includes("غسل الاموال") || name.includes("غسل الأموال") ? 80 : -100;
  case "anti_terrorism":
    return name.includes("منع الارهاب") || name.includes("مكافحه الارهاب") || name.includes("مكافحة الإرهاب") ?
      80 :
      -100;
  case "media":
    return name.includes("المطبوعات") || name.includes("الاعلام") || name.includes("الإعلام") ? 80 : -100;
  case "penal":
    return name.includes("العقوبات") ? 50 : 0;
  default:
    return 0;
  }
}

function hasStrongDomainMatch(law: JordanLawDoc, scenario: ScenarioAnalysis): boolean {
  const boost = lawNameDomainBoost(law, scenario.domain);

  if (scenario.domain === "penal") {
    return boost >= 0;
  }

  return boost >= 50;
}

function hasStrongTopicMatch(law: JordanLawDoc, scenario: ScenarioAnalysis): boolean {
  if (scenario.offenses.length) {
    return scenario.offenses.some((offense) => articleMatchesOffense(law, offense));
  }

  if (scenario.stages.some((stage) => stage !== "none")) {
    return scenario.stages.some((stage) => articleMatchesStage(law, stage));
  }

  const blob = normalizeArabic(
    `${law.article_title} ${law.article_text} ${(law.keywords || []).join(" ")} ${law.category} ${law.law_name}`,
  );

  return scenario.domainKeywords.some((kw) => blob.includes(normalizeArabic(kw)));
}

function rankLaw(
  law: JordanLawDoc,
  intent: LegalIntent,
  scenario: ScenarioAnalysis,
  searchKeywords: string[],
): RankedLaw {
  const title = normalizeArabic(law.article_title || "");
  const text = normalizeArabic(law.article_text || "");
  const lawName = normalizeArabic(law.law_name || "");
  const category = normalizeArabic(law.category || "");
  const kwBlob = normalizeArabic((law.keywords || []).join(" "));
  const whole = `${title} ${text} ${lawName} ${category} ${kwBlob}`;
  const role = classifyArticleRole(law);

  let score = 0;
  const reasons: string[] = [];

  const domainBoost = lawNameDomainBoost(law, scenario.domain);
  score += domainBoost;
  reasons.push(`domain_boost:${domainBoost}`);

  const keywordHits = searchKeywords.reduce((acc, kw) => {
    const n = normalizeArabic(kw);
    return n && whole.includes(n) ? acc + 1 : acc;
  }, 0);

  score += keywordHits * 2;
  if (keywordHits > 0) reasons.push(`keyword_hits:${keywordHits}`);

  for (const offense of scenario.offenses) {
    if (articleMatchesOffense(law, offense)) {
      score += 35;
      reasons.push(`offense:${offense}`);
    }
  }

  for (const stage of scenario.stages) {
    if (stage !== "none" && articleMatchesStage(law, stage)) {
      score += 50;
      reasons.push(`stage:${stage}`);
    }
  }

  if (intent.asksForPunishment) {
    if (role === "general_punishment") score += 18;
    if (role === "aggravated_punishment") score += 16;
    if (role === "general_definition") score += 6;
  }

  if (intent.asksForDefinition) {
    if (role === "general_definition") score += 22;
  }

  if (scenario.domain === "traffic" && lawName.includes("العقوبات")) {
    score -= 180;
    reasons.push("penal_not_allowed_for_traffic");
  }

  if (scenario.domain === "drugs") {
    if (lawName.includes("العقوبات")) {
      score -= 160;
      reasons.push("penal_not_allowed_for_drugs");
    }
    if (text.includes("المسكرات") || title.includes("المسكرات")) {
      score -= 220;
      reasons.push("intoxicants_not_drugs");
    }
  }

  if (scenario.domain === "sharia" && !lawName.includes("الاحوال الشخصيه") && !lawName.includes("الأحوال الشخصية")) {
    score -= 220;
    reasons.push("non_sharia_not_allowed");
  }

  if (scenario.domain === "evidence" && lawName.includes("العقوبات")) {
    score -= 140;
    reasons.push("penal_not_primary_for_evidence");
  }

  if (scenario.domain === "execution" && !lawName.includes("التنفيذ")) {
    score -= 150;
    reasons.push("non_execution_penalty");
  }

  if (scenario.domain === "criminal_procedure" && lawName.includes("العقوبات")) {
    score -= 130;
    reasons.push("penal_not_primary_for_criminal_procedure");
  }

  if (scenario.stages.includes("attempt") && role === "attempt_or_participation") {
    score += 30;
    reasons.push("attempt_stage_priority");
  }

  if (scenario.stages.includes("use_of_forged") && text.includes("استعمل المزور")) {
    score += 40;
    reasons.push("use_of_forged_priority");
  }

  if (scenario.stages.includes("evidence_denial") && (text.includes("التوقيع") || title.includes("السند"))) {
    score += 35;
    reasons.push("evidence_denial_priority");
  }

  if (scenario.offenses.includes("traffic_violation") && lawName.includes("السير")) {
    score += 35;
    reasons.push("traffic_priority");
  }

  if (
    scenario.offenses.includes("drugs_possession") ||
    scenario.offenses.includes("drugs_use") ||
    scenario.offenses.includes("drugs_promotion") ||
    scenario.offenses.includes("drugs_trafficking")
  ) {
    if (lawName.includes("المخدرات")) {
      score += 45;
      reasons.push("drugs_priority");
    }
  }

  if (scenario.mentionsNight && text.includes("ليل")) {
    score += 8;
    reasons.push("night_relevance");
  }

  if (scenario.mentionsMultipleOffenders && (text.includes("شخصين") || text.includes("اشتراك"))) {
    score += 8;
    reasons.push("multiple_offenders_relevance");
  }

  if (scenario.mentionsWeapon && text.includes("سلاح")) {
    score += 8;
    reasons.push("weapon_relevance");
  }

  if (scenario.victimsCountHint >= 2 && text.includes("اكثر من شخص")) {
    score += 12;
    reasons.push("multiple_victims_relevance");
  }

  if (!hasStrongDomainMatch(law, scenario) && scenario.domain !== "penal") {
    score -= 80;
    reasons.push("weak_domain_match_penalty");
  }

  if (!hasStrongTopicMatch(law, scenario) && (scenario.offenses.length || scenario.stages[0] !== "none")) {
    score -= 45;
    reasons.push("weak_topic_match_penalty");
  }

  return {law, score, role, reasons};
}

function pickTopLaws(
  ranked: RankedLaw[],
  scenario: ScenarioAnalysis,
  intent: LegalIntent,
  max = 6,
): RankedLaw[] {
  const filtered = ranked
    .filter((item) => item.score >= 20)
    .sort((a, b) => b.score - a.score);

  const result: RankedLaw[] = [];
  const seen = new Set<string>();

  const pushRole = (role: ArticleRole, limit: number): void => {
    let count = 0;
    for (const item of filtered) {
      if (count >= limit || result.length >= max) break;
      if (item.role !== role) continue;
      if (seen.has(item.law.id)) continue;
      result.push(item);
      seen.add(item.law.id);
      count += 1;
    }
  };

  if (scenario.stages.includes("attempt") || scenario.stages.includes("use_of_forged") || scenario.stages.includes("participation")) {
    pushRole("attempt_or_participation", 2);
  }

  if (intent.asksForPunishment || intent.asksForDurationOrAmount) {
    pushRole("general_punishment", 3);
    pushRole("aggravated_punishment", 2);
    pushRole("general_definition", 1);
  } else if (intent.asksForDefinition) {
    pushRole("general_definition", 2);
    pushRole("general_punishment", 2);
  } else {
    pushRole("general_punishment", 2);
    pushRole("general_definition", 1);
    pushRole("aggravated_punishment", 2);
  }

  for (const item of filtered) {
    if (result.length >= max) break;
    if (seen.has(item.law.id)) continue;
    result.push(item);
    seen.add(item.law.id);
  }

  return result.slice(0, max);
}

async function searchJordanLaws(question: string): Promise<RankedLaw[]> {
  const intent = detectLegalIntent(question);
  const scenario = analyzeScenario(question);
  const searchKeywords = buildSearchKeywords(question, intent, scenario);

  const lawsRef = admin.firestore().collection("jordan_legal_articles");

  const snapshot: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData> =
    await lawsRef.where("law_domain", "==", scenario.domain).limit(2000).get();

  let allLaws: JordanLawDoc[] = snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      law_domain: typeof data.law_domain === "string" ? data.law_domain : "",
      law_name: typeof data.law_name === "string" ? data.law_name : "",
      law_number: typeof data.law_number === "string" ? data.law_number : "",
      article_number: typeof data.article_number === "string" ? data.article_number : "",
      article_title: typeof data.article_title === "string" ? data.article_title : "",
      article_text: typeof data.article_text === "string" ? data.article_text : "",
      category: typeof data.category === "string" ? data.category : "",
      keywords: Array.isArray(data.keywords) ?
        data.keywords.filter((x: unknown) => typeof x === "string") :
        [],
    };
  });

  if (!allLaws.length && scenario.domain !== "penal") {
    const fallback = await lawsRef.where("law_domain", "==", "penal").limit(800).get();
    allLaws = fallback.docs.map((doc) => {
      const data = doc.data();
      return {
        id: doc.id,
        law_domain: typeof data.law_domain === "string" ? data.law_domain : "",
        law_name: typeof data.law_name === "string" ? data.law_name : "",
        law_number: typeof data.law_number === "string" ? data.law_number : "",
        article_number: typeof data.article_number === "string" ? data.article_number : "",
        article_title: typeof data.article_title === "string" ? data.article_title : "",
        article_text: typeof data.article_text === "string" ? data.article_text : "",
        category: typeof data.category === "string" ? data.category : "",
        keywords: Array.isArray(data.keywords) ?
          data.keywords.filter((x: unknown) => typeof x === "string") :
          [],
      };
    });
  }

  const ranked = allLaws
    .map((law) => rankLaw(law, intent, scenario, searchKeywords))
    .sort((a, b) => b.score - a.score);

  return pickTopLaws(ranked, scenario, intent, 6);
}

function buildJordanLawsContext(ranked: RankedLaw[]): string {
  if (!ranked.length) {
    return "لم يتم العثور على مواد قانونية مرتبطة مباشرة في قاعدة البيانات ضمن القانون المختص.";
  }

  let context = "المواد القانونية المسترجعة:\n\n";

  ranked.forEach((item, index) => {
    const law = item.law;
    context += `مرجع ${index + 1}\n`;
    context += `اسم القانون: ${law.law_name}\n`;
    context += `النطاق القانوني: ${law.law_domain || ""}\n`;
    context += `رقم المادة: ${law.article_number}\n`;
    if (law.article_title) context += `عنوان المادة: ${law.article_title}\n`;
    if (law.category) context += `التصنيف: ${law.category}\n`;
    context += `نوع المادة المستنتج: ${item.role}\n`;
    context += `نص المادة: ${law.article_text}\n\n`;
  });

  context += "تعليمات ملزمة: لا يجوز اختلاق أي مادة أو رقم أو مدة أو غرامة غير موجودة في المواد المسترجعة.\n";
  return context;
}

function buildScenarioMemo(question: string, ranked: RankedLaw[]): string {
  const intent = detectLegalIntent(question);
  const scenario = analyzeScenario(question);

  let memo = "مذكرة تكييف أولية:\n";
  memo += `- القانون المختص المرجح: ${scenario.domain}\n`;
  memo += `- نوع السؤال: ${intent.asksForPunishment ? "عقوبة/جزاء" : intent.asksForDistribution ? "توزيع/أنصبة" : intent.asksForDefinition ? "تعريف" : "عام"}\n`;
  memo += `- المراحل القانونية الملتقطة: ${scenario.stages.join(" + ")}\n`;
  memo += `- الأوصاف/الجرائم الملتقطة: ${scenario.offenses.join(" + ") || "غير محدد"}\n`;
  memo += `- عدد المواد المسترجعة: ${ranked.length}\n`;
  if (scenario.explanationHints.length) {
    memo += `- ملاحظات التكييف: ${scenario.explanationHints.join(" ")}\n`;
  }
  memo += "- لا تجب من قانون مختلف عن القانون المختص، ولا تخلط بين الجريمة الأصلية والمرحلة الجرمية أو بين الحق الإجرائي والحق الموضوعي.\n";
  return memo;
}

function looksLikeOvergeneralizedPenaltyAnswer(
  result: string,
  rankedLaws: RankedLaw[],
): boolean {
  const text = normalizeArabic(result);
  const hasGeneral = rankedLaws.some((x) => x.role === "general_punishment");
  const hasAggravated = rankedLaws.some((x) => x.role === "aggravated_punishment");

  if (!hasGeneral || !hasAggravated) return false;

  return (
    text.includes("تتراوح") &&
    text.includes("من") &&
    text.includes("الى") &&
    (text.includes("عقوبه") || text.includes("العقوبه"))
  );
}

function looksLikeDomainMismatchAnswer(
  result: string,
  rankedLaws: RankedLaw[],
  scenario: ScenarioAnalysis,
): boolean {
  if (!rankedLaws.length) return false;

  const bad = rankedLaws.every((x) => (x.law.law_domain || "") !== scenario.domain);
  if (!bad) return false;

  const text = normalizeArabic(result);
  return text.includes("غير محدده") || text.includes("غير محددة") || text.includes("لا توجد");
}

/* ===================== Multi-analysis routing ===================== */

type AnalysisKind =
  | "judgment"
  | "appeal"
  | "contract"
  | "claim_or_memo"
  | "general_document";

function detectAnalysisKind(text: string): AnalysisKind {
  const t = text.toLowerCase();

  if (
    containsAny(t, [
      "قررت المحكمة",
      "حكمت المحكمة",
      "قبول الطعن",
      "رفض الطعن",
      "رد الطعن",
      "المحكمة العليا",
      "منطوق الحكم",
      "لهذه الأسباب",
      "صدر القرار",
    ])
  ) {
    return "judgment";
  }

  if (
    containsAny(t, [
      "استئناف",
      "لائحة استئناف",
      "أسباب الاستئناف",
      "طعن",
      "تمييز",
      "أسباب الطعن",
    ])
  ) {
    return "appeal";
  }

  if (
    containsAny(t, [
      "عقد",
      "اتفاقية",
      "الطرف الأول",
      "الطرف الثاني",
      "فسخ العقد",
      "مدة العقد",
    ])
  ) {
    return "contract";
  }

  if (
    containsAny(t, [
      "المدعي",
      "المدعى عليه",
      "الطلبات",
      "لائحة دعوى",
      "مذكرة",
      "دفوع",
      "لائحة جوابية",
    ])
  ) {
    return "claim_or_memo";
  }

  return "general_document";
}

/* ===================== Prompts ===================== */

const GENERAL_SYSTEM_PROMPT = `
أنت LawMind، مساعد قانوني احترافي للمحامين في الأردن.

قواعد صارمة:
1) استخدم فقط النصوص القانونية المسترجعة.
2) لا تختلق أي رقم مادة أو عقوبة أو مدة أو غرامة.
3) لا تجب من قانون مختلف عن القانون المختص بالسؤال.
4) فرّق دائمًا بين:
- النص التعريفي
- النص العقابي العام
- النص الخاص أو المشدد
- النص الإجرائي
- النص المتعلق بالشروع أو الاستعمال أو الاشتراك
5) إذا كان السؤال عن مرحلة جرمية مثل الشروع أو استعمال المزور أو الاشتراك، فلا تكتفِ بنص الجريمة التامة.
6) إذا كان السؤال من قانون خاص مثل السير أو المخدرات أو الأحوال الشخصية أو التنفيذ أو الإثبات، فلا تُجب من قانون العقوبات العام إلا إذا كانت المواد المسترجعة نفسها تنص على ذلك صراحة.
7) إذا كانت المواد المسترجعة لا تكفي لحسم الجواب، قل ذلك بوضوح دون اختلاق.
8) إذا كان السؤال عن أصل الجريمة وصورها المشددة، فلا تصغ العقوبة على شكل مدى موحد مضلل.
9) في مسائل الأحوال الشخصية والميراث، لا تقدّم أنصبة أو أحكامًا نهائية إذا كانت المواد المسترجعة غير كافية أو ليست من القانون المختص.
10) في الأسئلة الإجرائية، فرّق بين الحق الموضوعي والحق الإجرائي.

أسلوب الصياغة:
- عربي قانوني قوي وواضح
- منظم ومقنع
- دقيق وغير إنشائي

التنسيق الإلزامي:
سؤالك:
أولاً: الجواب المختصر
ثانياً: الأساس القانوني
ثالثاً: الشرح القانوني
رابعاً: الإجراءات العملية
خامساً: الأخطاء الشائعة
سادساً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const SHARIA_SYSTEM_PROMPT = `
أنت LawMind، مساعد قانوني احترافي في الأحوال الشخصية الأردنية.

قواعد صارمة:
- لا تستخدم قانون العقوبات أو القوانين الجزائية في مسائل الميراث والعدة والطلاق والنفقة والحضانة.
- لا تختلق أنصبة أو أحكامًا شرعية.
- إذا كان السؤال عن الميراث ولا توجد مواد أو نصوص شرعية كافية، فقل إن النصوص المسترجعة لا تكفي للحساب النهائي.
- إذا كان السؤال عن العدة والميراث، فرّق بين عدة الوفاة والطلاق الرجعي والطلاق البائن.
- إذا كان السؤال عن الأنصبة، راعِ وجود الفرع الوارث أو عدمه قبل ذكر نصيب الزوج أو الزوجة أو الأم.

التنسيق:
سؤالك:
أولاً: الجواب المختصر
ثانياً: الأساس القانوني
ثالثاً: الشرح القانوني
رابعاً: الإجراءات العملية
خامساً: الأخطاء الشائعة
سادساً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const LABOR_SYSTEM_PROMPT = `
أنت LawMind، مساعد قانوني احترافي في قانون العمل الأردني.

قواعد صارمة:
- لا تختلق مواد أو مدد أو حقوق.
- عند الفصل التعسفي، قدّم النص المباشر المتعلق بالفصل التعسفي أولًا، ثم بدل الإشعار، ثم الحقوق الأخرى.
- فرّق بين بدل الإشعار وتعويض الفصل التعسفي ومكافأة نهاية الخدمة وبدل الإجازات.
- إذا لم تتضمن المواد المسترجعة النص المباشر، فقل ذلك بوضوح.

التنسيق:
سؤالك:
أولاً: الجواب المختصر
ثانياً: الأساس القانوني
ثالثاً: الشرح القانوني
رابعاً: الإجراءات العملية
خامساً: الأخطاء الشائعة
سادساً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const TRAFFIC_SYSTEM_PROMPT = `
أنت LawMind، مساعد قانوني احترافي في قانون السير الأردني.

قواعد صارمة:
- لا تجب على مخالفات السير من قانون العقوبات العام إذا لم تكن المواد المسترجعة من قانون السير.
- إذا كانت المواد المسترجعة لا تتعلق بقانون السير، فاذكر أن النصوص غير كافية ولا تخترع الغرامة أو العقوبة.
- فرّق بين المخالفة المرورية المجردة والواقعة التي نتج عنها إصابة أو وفاة.

التنسيق:
سؤالك:
أولاً: الجواب المختصر
ثانياً: الأساس القانوني
ثالثاً: الشرح القانوني
رابعاً: الإجراءات العملية
خامساً: الأخطاء الشائعة
سادساً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const DRUGS_SYSTEM_PROMPT = `
أنت LawMind، مساعد قانوني احترافي في قانون المخدرات والمؤثرات العقلية الأردني.

قواعد صارمة:
- لا تستخدم نصوص تعاطي المسكرات للإجابة على جرائم المخدرات.
- فرّق بين الحيازة والتعاطي والحيازة بقصد التعاطي والحيازة بقصد الترويج والترويج والاتجار.
- لا تدمج صور المخدرات المختلفة في مدى عقابي واحد مضلل.
- إذا لم تكن المواد المسترجعة من قانون المخدرات أو لا تتعلق بالمخدرات مباشرة، فاذكر أن النصوص غير كافية.

التنسيق:
سؤالك:
أولاً: الجواب المختصر
ثانياً: الأساس القانوني
ثالثاً: الشرح القانوني
رابعاً: الإجراءات العملية
خامساً: الأخطاء الشائعة
سادساً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const EVIDENCE_SYSTEM_PROMPT = `
أنت LawMind، مساعد قانوني احترافي في قانون الإثبات الأردني.

قواعد صارمة:
- لا تخلط بين التزوير كجريمة وبين الطعن بالتزوير أو إنكار التوقيع كوسيلة إثبات.
- إذا كان السؤال عن السند العادي أو إنكار التوقيع أو الحجية، فابدأ بقانون الإثبات لا بقانون العقوبات.
- لا تختلق نصوصًا أو حججًا غير مستندة إلى المواد المسترجعة.

التنسيق:
سؤالك:
أولاً: الجواب المختصر
ثانياً: الأساس القانوني
ثالثاً: الشرح القانوني
رابعاً: الإجراءات العملية
خامساً: الأخطاء الشائعة
سادساً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const EXECUTION_SYSTEM_PROMPT = `
أنت LawMind، مساعد قانوني احترافي في قانون التنفيذ الأردني.

قواعد صارمة:
- ابدأ بقانون التنفيذ في مسائل حبس المدين والتنفيذ الجبري.
- لا تخلط بين التنفيذ وأصول المحاكمات المدنية إلا إذا كانت المواد المسترجعة تفرض ذلك.
- لا تعطِ جوابًا جازمًا إذا لم توجد المادة المباشرة في النصوص المسترجعة.

التنسيق:
سؤالك:
أولاً: الجواب المختصر
ثانياً: الأساس القانوني
ثالثاً: الشرح القانوني
رابعاً: الإجراءات العملية
خامساً: الأخطاء الشائعة
سادساً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const CRIMINAL_PROCEDURE_SYSTEM_PROMPT = `
أنت LawMind، مساعد قانوني احترافي في أصول المحاكمات الجزائية الأردنية.

قواعد صارمة:
- ابدأ بالنصوص الإجرائية الجزائية في مسائل الاستئناف والحق الشخصي والحق العام والمدد والطعن.
- لا تخلط بين نصوص التجريم في قانون العقوبات وبين القواعد الإجرائية للطعن والسقوط والإسقاط.
- إذا كان النص المسترجع يتعلق بجنحة فلا تعممه على الجناية.

التنسيق:
سؤالك:
أولاً: الجواب المختصر
ثانياً: الأساس القانوني
ثالثاً: الشرح القانوني
رابعاً: الإجراءات العملية
خامساً: الأخطاء الشائعة
سادساً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const PROCEDURE_SYSTEM_PROMPT = `
أنت LawMind، مساعد قانوني احترافي في الإجراءات القضائية الأردنية.

قواعد صارمة:
- ميّز بين الإجراءات المدنية والإجراءات الجزائية.
- إذا كان السؤال عامًا عن وقف التنفيذ أو الطعن، فاذكر أن نوع الحكم يؤثر على النص الواجب التطبيق ما لم تكن المواد المسترجعة حاسمة.
- لا تختلق المدد أو الشروط.

التنسيق:
سؤالك:
أولاً: الجواب المختصر
ثانياً: الأساس القانوني
ثالثاً: الشرح القانوني
رابعاً: الإجراءات العملية
خامساً: الأخطاء الشائعة
سادساً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const DOC_BASE_RULES = `
أنت LawMind، مساعد قانوني احترافي للمحامين في الأردن.

قواعد صارمة:
- صحح أخطاء OCR أثناء الفهم
- لا تختلق مواد أو أرقام أو مدد أو غرامات
- إذا لم تكن متأكدًا من كلمة أو رقم فقل ذلك بوضوح
- استخرج القيمة العملية للمحامي
- اختم دائمًا بعبارة: هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const JUDGMENT_PROMPT = `
${DOC_BASE_RULES}

تعامل مع النص على أنه حكم أو قرار قضائي.

التزم بهذا الهيكل:
سؤالك:
أولاً: الجواب المختصر
ثانياً: طبيعة المستند
ثالثاً: التحليل القانوني
رابعاً: القيمة العملية للمحامي
خامساً: المخاطر أو نقاط الضعف
سادساً: المعلومات التي يلزم التحقق منها
سابعاً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const APPEAL_PROMPT = `
${DOC_BASE_RULES}

تعامل مع النص على أنه استئناف أو طعن أو مذكرة.

التزم بهذا الهيكل:
سؤالك:
أولاً: الجواب المختصر
ثانياً: طبيعة المستند
ثالثاً: التحليل القانوني
رابعاً: القيمة العملية للمحامي
خامساً: المخاطر أو نقاط الضعف
سادساً: المعلومات التي يلزم التحقق منها
سابعاً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const CONTRACT_PROMPT = `
${DOC_BASE_RULES}

تعامل مع النص على أنه عقد أو اتفاقية.

التزم بهذا الهيكل:
سؤالك:
أولاً: الجواب المختصر
ثانياً: طبيعة المستند
ثالثاً: التحليل القانوني
رابعاً: القيمة العملية للمحامي
خامساً: المخاطر أو نقاط الضعف
سادساً: المعلومات التي يلزم التحقق منها
سابعاً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const CLAIM_OR_MEMO_PROMPT = `
${DOC_BASE_RULES}

تعامل مع النص على أنه لائحة دعوى أو مذكرة.

التزم بهذا الهيكل:
سؤالك:
أولاً: الجواب المختصر
ثانياً: طبيعة المستند
ثالثاً: التحليل القانوني
رابعاً: القيمة العملية للمحامي
خامساً: المخاطر أو نقاط الضعف
سادساً: المعلومات التي يلزم التحقق منها
سابعاً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

const GENERAL_DOCUMENT_PROMPT = `
${DOC_BASE_RULES}

تعامل مع النص على أنه مستند قانوني عام.

التزم بهذا الهيكل:
سؤالك:
أولاً: الجواب المختصر
ثانياً: طبيعة المستند
ثالثاً: التحليل القانوني
رابعاً: القيمة العملية للمحامي
خامساً: المخاطر أو نقاط الضعف
سادساً: المعلومات التي يلزم التحقق منها
سابعاً: أسئلة توضيحية إضافية

وفي النهاية:
هذه معلومات عامة وليست استشارة قانونية.
`.trim();

function getDomainSystemPrompt(domain: LawDomain): string {
  switch (domain) {
  case "sharia":
    return SHARIA_SYSTEM_PROMPT;
  case "labor":
    return LABOR_SYSTEM_PROMPT;
  case "traffic":
    return TRAFFIC_SYSTEM_PROMPT;
  case "drugs":
    return DRUGS_SYSTEM_PROMPT;
  case "evidence":
    return EVIDENCE_SYSTEM_PROMPT;
  case "execution":
    return EXECUTION_SYSTEM_PROMPT;
  case "criminal_procedure":
    return CRIMINAL_PROCEDURE_SYSTEM_PROMPT;
  case "procedure":
    return PROCEDURE_SYSTEM_PROMPT;
  default:
    return GENERAL_SYSTEM_PROMPT;
  }
}

function getCaseAnalysisPrompt(kind: AnalysisKind): string {
  switch (kind) {
  case "judgment":
    return JUDGMENT_PROMPT;
  case "appeal":
    return APPEAL_PROMPT;
  case "contract":
    return CONTRACT_PROMPT;
  case "claim_or_memo":
    return CLAIM_OR_MEMO_PROMPT;
  default:
    return GENERAL_DOCUMENT_PROMPT;
  }
}

/* ===================== OpenAI ===================== */

async function callOpenAI(
  openai: OpenAI,
  userText: string,
  system: string,
): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.15,
    max_tokens: 1800,
    messages: [
      {role: "system", content: system},
      {role: "user", content: userText},
    ],
  });

  return completion?.choices?.[0]?.message?.content?.trim() ?? "";
}

/* ===================== AI Function ===================== */

export const lawmindAI = onRequest(
  {secrets: [openaiKey]},
  async (req, res) => {
    try {
      await runCors(req, res);

      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({error: "Method Not Allowed. Use POST."});
        return;
      }

      const body = safeJsonParse(req.body) ?? {};
      const requestMode = pickRequestMode(body);

      if (req.query?.debug === "1") {
        res.status(200).json({
          version: "LM_ROUTER_FINAL_2026_04_10_A",
          request_mode: requestMode,
          contentType: req.get("content-type"),
          query: req.query,
          bodyKeys: typeof body === "object" ? Object.keys(body) : null,
          body,
        });
        return;
      }

      const openai = new OpenAI({apiKey: openaiKey.value()});

      if (requestMode === "case_analysis") {
        const facts = clampText(pickCaseFacts(body), 12000);
        const questions = clampText(pickQuestions(body), 4000);

        if (!isNonEmptyString(facts) || isPlaceholderPrompt(facts)) {
          res.status(400).json({
            version: "LM_ROUTER_FINAL_2026_04_10_A",
            request_mode: requestMode,
            error: "Missing caseFacts. Send JSON { mode:'case_analysis', caseFacts:'...' }",
          });
          return;
        }

        const analysisKind = detectAnalysisKind(facts);
        const system = getCaseAnalysisPrompt(analysisKind);
        const userText =
          `النص أو الوقائع المطلوب تحليلها:\n"""${facts}"""\n\n` +
          `أسئلة المحامي (اختياري):\n"""${questions || "لا يوجد"}"""`;

        let result = await callOpenAI(openai, userText, system);

        if (looksLikeBadOrGeneric(result)) {
          result = await callOpenAI(openai, userText, system);
        }

        res.status(200).json({
          version: "LM_ROUTER_FINAL_2026_04_10_A",
          request_mode: requestMode,
          analysis_kind: analysisKind,
          result,
          answer: result,
        });
        return;
      }

      const prompt = pickPrompt(req, body);

      if (!isNonEmptyString(prompt) || isPlaceholderPrompt(prompt)) {
        res.status(400).json({error: "Missing prompt"});
        return;
      }

      const embeddedDocumentText = extractDocumentTextFromPrompt(prompt);

      if (embeddedDocumentText) {
        const facts = clampText(embeddedDocumentText, 12000);
        const analysisKind = detectAnalysisKind(facts);
        const system = getCaseAnalysisPrompt(analysisKind);

        const userText =
          `النص القانوني المراد تحليله:\n"""${facts}"""\n\n` +
          `تعليمات المستخدم الأصلية:\n"""${clampText(prompt, 3000)}"""`;

        let result = await callOpenAI(openai, userText, system);

        if (looksLikeBadOrGeneric(result)) {
          result = await callOpenAI(openai, userText, system);
        }

        res.status(200).json({
          version: "LM_ROUTER_FINAL_2026_04_10_A",
          request_mode: "qa",
          topic_mode: "document_analysis",
          analysis_kind: analysisKind,
          prompt_echo: prompt,
          result,
          answer: result,
        });
        return;
      }

      const scenario = analyzeScenario(prompt);
      const topicMode = scenario.domain === "sharia" ? "family" : "general";
      const baseSystem = getDomainSystemPrompt(scenario.domain);
      const numbersRequest = isNumbersRequest(prompt);

      const rankedLaws = await searchJordanLaws(prompt);
      const laws = rankedLaws.map((x) => x.law);

      const jordanContext = buildJordanLawsContext(rankedLaws);
      const scenarioMemo = buildScenarioMemo(prompt, rankedLaws);

      const strictLegalInstructions = `
تعليمات إضافية ملزمة:
- إذا كانت المواد المسترجعة من قانون غير مختص بالسؤال، فلا تبنِ عليها جوابًا جازمًا.
- إذا كان السؤال عن:
  * الشروع: ابدأ بنصوص الشروع ثم اربطها بالجريمة الأصلية.
  * استعمال المزور: ابدأ بالنص الخاص بالاستعمال ثم اربطه بعقوبة التزوير المقابل.
  * حق شخصي / استئناف / مدة طعن: قدّم النصوص الإجرائية قبل قانون العقوبات.
  * حبس المدين: قدّم قانون التنفيذ قبل أصول المحاكمات العامة.
  * السند العادي / إنكار التوقيع / التزوير الفرعي: قدّم قانون الإثبات قبل قانون العقوبات.
  * المخدرات: لا تستخدم نصوص المسكرات.
  * مخالفات السير: لا تستخدم نصوص قانون العقوبات العامة.
- إذا كانت النصوص تتضمن أصلًا وصورًا مشددة، فلا تصغ الجواب على شكل مدى رقمي موحد مضلل.
- لا تعمم نصًا خاصًا بجنحة على جناية.
- في مسائل الميراث لا تعطِ أنصبة نهائية إذا لم تكن النصوص المسترجعة من الأحوال الشخصية أو لم تكفِ للحساب.
- استخدم ألفاظ النصوص القانونية المسترجعة قدر الإمكان.
- إذا لم تكفِ المواد لحسم الجواب، فقل: "النصوص المسترجعة لا تكفي لحسم الجواب النهائي"، ثم اذكر أقصى ما تسمح به النصوص.

- استخدم العناوين التالية حرفيًا:
  أولاً: الجواب المختصر
  ثانياً: الأساس القانوني
  ثالثاً: الشرح القانوني
  رابعاً: الإجراءات العملية
  خامساً: الأخطاء الشائعة
  سادساً: أسئلة توضيحية إضافية
`.trim();

      const numbersGuard = numbersRequest ?
        `
تعليمات إضافية للأرقام والمدد:
- إذا طلب المستخدم مدة أو غرامة أو رقم مادة ولم تكن موجودة بوضوح في النصوص المسترجعة، فلا تختلقها.
- عند نقص النص، اذكر صراحة أن المدة أو الرقم غير متاح في المواد المسترجعة.
`.trim() :
        "";

      const userText =
        `${scenarioMemo}\n\n` +
        `${jordanContext}\n\n` +
        `سؤال المستخدم:\n"""${clampText(prompt, 6000)}"""`;

      const system = `${baseSystem}\n\n${strictLegalInstructions}\n\n${numbersGuard}`.trim();

      let result = await callOpenAI(openai, userText, system);

      if (looksLikeBadOrGeneric(result)) {
        result = await callOpenAI(openai, userText, system);
      }

      if (looksLikeOvergeneralizedPenaltyAnswer(result, rankedLaws)) {
        const retrySystem = `${system}

تعليمات تصحيحية:
- الجواب السابق عمّم العقوبات على شكل مدى واحد. أعد الصياغة مع التفريق الصريح بين:
  1) النص العام
  2) النصوص الخاصة أو المشددة
- ممنوع استعمال صياغة توحي بمدى موحد لجميع الصور.
`.trim();

        result = await callOpenAI(openai, userText, retrySystem);
      }

      if (looksLikeDomainMismatchAnswer(result, rankedLaws, scenario)) {
        const retrySystem = `${system}

تعليمات تصحيحية:
- المواد المسترجعة ليست من القانون المختص على نحو كاف.
- لا تعطِ جوابًا جازمًا.
- اشرح أن النصوص المسترجعة الحالية لا تكفي للحسم لأن القانون المختص أو المادة المباشرة غير موجودة ضمن النصوص.
`.trim();

        result = await callOpenAI(openai, userText, retrySystem);
      }

      res.status(200).json({
        version: "LM_ROUTER_FINAL_2026_04_10_A",
        request_mode: "qa",
        topic_mode: topicMode,
        law_domain: scenario.domain,
        numbersRequest,
        retrieved_laws_count: laws.length,
        retrieved_refs: rankedLaws.map((x) => ({
          article_number: x.law.article_number,
          article_title: x.law.article_title,
          law_name: x.law.law_name,
          law_domain: x.law.law_domain,
          role: x.role,
          score: x.score,
        })),
        prompt_echo: prompt,
        result,
        answer: result,
      });
    } catch (error: any) {
      logger.error("AI processing failed", error);
      res.status(500).json({
        error: "AI processing failed",
        details: typeof error?.message === "string" ? error.message : undefined,
      });
    }
  },
);

/* ===================== OCR helpers ===================== */

type VisionAnnotateResponse = {
  responses?: Array<{
    fullTextAnnotation?: { text?: string };
    textAnnotations?: Array<{ description?: string }>;
    error?: { code?: number; message?: string; status?: string };
  }>;
};

function pickFileUrl(body: any): string | null {
  const candidates = [
    body?.fileUrl,
    body?.data?.fileUrl,
    body?.url,
    body?.data?.url,
    body?.imageUrl,
    body?.data?.imageUrl,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim().length > 0) return c.trim();
  }

  return null;
}

function parseStorageUrl(url: string): { bucket: string; objectPath: string } {
  if (url.startsWith("gs://")) {
    const withoutPrefix = url.replace("gs://", "");
    const firstSlash = withoutPrefix.indexOf("/");
    if (firstSlash <= 0) {
      throw new Error("Invalid gs:// Firebase Storage URL");
    }

    return {
      bucket: withoutPrefix.slice(0, firstSlash),
      objectPath: withoutPrefix.slice(firstSlash + 1),
    };
  }

  const m = url.match(/\/v0\/b\/([^/]+)\/o\/([^?]+)/);
  if (!m) throw new Error("Unsupported Firebase Storage download URL");

  return {
    bucket: m[1],
    objectPath: decodeURIComponent(m[2]),
  };
}

async function downloadStorageFileAsBase64(
  bucket: string,
  objectPath: string,
): Promise<string> {
  const [buf] = await admin.storage().bucket(bucket).file(objectPath).download();
  return Buffer.from(buf).toString("base64");
}

async function callVisionOCR(
  apiKey: string,
  base64: string,
): Promise<{ text: string; raw: VisionAnnotateResponse }> {
  const visionRes = await fetch(
    `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
    {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        requests: [
          {
            image: {content: base64},
            features: [{type: "DOCUMENT_TEXT_DETECTION"}],
            imageContext: {languageHints: ["ar"]},
          },
        ],
      }),
    },
  );

  const data = (await visionRes.json()) as VisionAnnotateResponse;
  const err = data?.responses?.[0]?.error;

  if (!visionRes.ok || err) {
    throw new Error(`VisionError: ${JSON.stringify(err ?? data).slice(0, 2000)}`);
  }

  const text =
    data?.responses?.[0]?.fullTextAnnotation?.text ??
    data?.responses?.[0]?.textAnnotations?.[0]?.description ??
    "";

  return {text, raw: data};
}

/* ===================== OCR Function ===================== */

export const lawmindOCR = onRequest(
  {secrets: [visionApiKey]},
  async (req, res) => {
    try {
      await runCors(req, res);

      if (req.method === "OPTIONS") {
        res.status(204).send("");
        return;
      }

      if (req.method !== "POST") {
        res.status(405).json({error: "Method not allowed"});
        return;
      }

      const body = safeJsonParse(req.body) ?? {};
      const fileUrl = pickFileUrl(body);

      if (!fileUrl) {
        res.status(400).json({error: "Missing fileUrl"});
        return;
      }

      const key = visionApiKey.value();
      if (!key) {
        res.status(500).json({error: "Missing VISION_API_KEY secret"});
        return;
      }

      const {bucket, objectPath} = parseStorageUrl(fileUrl);
      const base64 = await downloadStorageFileAsBase64(bucket, objectPath);
      const {text} = await callVisionOCR(key, base64);

      res.status(200).json({
        status: "done",
        text: text || "لم يتم استخراج نص",
        ocrText: text || "لم يتم استخراج نص",
        bucket,
        objectPath,
      });
    } catch (error: any) {
      logger.error("OCR failed", error);
      res.status(500).json({
        status: "failed",
        error: "OCR failed",
        details: typeof error?.message === "string" ? error.message : String(error),
      });
    }
  },
);
