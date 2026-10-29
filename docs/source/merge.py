# Merges the framework document and the review slides into one upload for task 2.3,
# with bookmarks so the reviewer can jump to each required item.
import sys
from pypdf import PdfReader, PdfWriter

framework, slides, out = sys.argv[1:4]
w = PdfWriter()
f = PdfReader(framework)
s = PdfReader(slides)
for p in f.pages:
    w.add_page(p)
first_slide = len(w.pages)
for p in s.pages:
    w.add_page(p)

# Bookmarks: find each chapter's first page by its heading text.
marks = [("Cover and submission contents", None), ("1. Objectives", "1. Objectives"),
         ("2. Scope and limitations", "2. Scope and limitations"), ("3. Conceptual framework (IPO)", "3. Conceptual framework"),
         ("4. System architecture", "4. System architecture"), ("4.1 Modules", "4.1 Modules"),
         ("4.2 Interfaces / 4.3 Data flow", "4.2 Interfaces"), ("5. Workflow (flowcharts)", "5. Workflow"),
         ("6. Technology stack", "6. Technology and environment")]
texts = [p.extract_text() or "" for p in f.pages]
for title, needle in marks:
    page = 0 if needle is None else next((i for i, t in enumerate(texts) if i > 0 and needle in t), None)
    if page is not None:
        w.add_outline_item(title, page)
w.add_outline_item("7. Short review slides", first_slide)
w.add_metadata({"/Title": "Initial System Framework — Biliran Resort & Tour Booking System (Task 2.3)",
                "/Subject": "Parallel and Distributed System — framework submission"})
with open(out, "wb") as fh:
    w.write(fh)
print("pages:", len(w.pages), "slides start at page", first_slide + 1)
