import json
import sys
import firebase_admin
from firebase_admin import credentials, firestore

cred = credentials.Certificate("serviceAccountKey.json")
firebase_admin.initialize_app(cred)
db = firestore.client()

COLLECTION_NAME = "jordan_legal_articles"

if len(sys.argv) > 1:
    JSON_FILE = sys.argv[1]
else:
    JSON_FILE = input("أدخل اسم ملف JSON: ").strip()

print("PROJECT_ID =", cred.project_id)
print("APP_NAME =", firebase_admin.get_app().name)
print("JSON_FILE =", JSON_FILE)

with open(JSON_FILE, "r", encoding="utf-8") as f:
    data = json.load(f)

print("TOTAL_RECORDS =", len(data))
print("FIRST_LAW_NAME =", data[0].get("law_name"))
print("FIRST_LAW_DOMAIN =", data[0].get("law_domain"))
print("FIRST_DOC_ID =", data[0].get("doc_id"))

batch = db.batch()
count = 0
total = 0

for item in data:
    doc_id = item["doc_id"]
    doc_ref = db.collection(COLLECTION_NAME).document(doc_id)
    batch.set(doc_ref, item)
    count += 1
    total += 1

    if count == 500:
        batch.commit()
        print("✅ تم رفع دفعة من 500")
        batch = db.batch()
        count = 0

if count > 0:
    batch.commit()
    print(f"✅ تم رفع آخر دفعة وعددها {count}")

print(f"🔥 تم رفع {total} مادة إلى {COLLECTION_NAME}")