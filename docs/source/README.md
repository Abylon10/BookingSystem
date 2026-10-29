# Document sources

| Source | PDF |
|---|---|
| `design.html` | `../System-Design-and-Initial-Considerations.pdf` — full design document |
| `flowcharts.html` | `../Framework-and-Flowcharts.pdf` — conceptual framework and flowcharts only |
| `slides.html` | `../Framework-Review-Slides.pdf` — short review slides for the framework defense (16:9) |
| `framework.html` + slides | `../Task-2.3-Initial-System-Framework.pdf` — **task 2.3 upload**: framework document + review slides in one file (merged with `merge.py`) |
| `tracker.html` | `../Project-Development-Tracker.pdf` — filled-in development tracker (A4 landscape) |

Text is plain HTML. Diagrams are Mermaid source in the `D[...]` strings near the bottom of each file;
the tracker's tasks are the `tasks` list in its script. Screenshots live in `../evidence/`.

To rebuild a PDF after editing (needs internet for the Mermaid CDN), run from this folder:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --no-pdf-header-footer --allow-file-access-from-files --virtual-time-budget=40000 --user-data-dir="$env:TEMP\edge-pdf" --print-to-pdf="$PWD\..\Framework-Review-Slides.pdf" "file:///$($PWD -replace '\','/')/slides.html"
```

Change `slides.html` / the output name for the other documents. Or open the HTML in Chrome/Edge and
Print → Save as PDF (no headers/footers, background graphics on).
