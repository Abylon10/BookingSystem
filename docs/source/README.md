# Design document source

`design.html` is the source of `../System-Design-and-Initial-Considerations.pdf`;
`flowcharts.html` is the source of `../Framework-and-Flowcharts.pdf` (framework and flowcharts only).
Text is plain HTML; every diagram is Mermaid source inside the `D[...]` strings at the bottom.

To rebuild the PDF after editing (needs internet for the Mermaid CDN):

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=40000 --user-data-dir="$env:TEMP\edge-pdf" --print-to-pdf="$PWD\..\System-Design-and-Initial-Considerations.pdf" "file:///$($PWD -replace '\','/')/design.html"
```

Or open `design.html` in Chrome/Edge and Print → Save as PDF (A4, no headers/footers, background graphics on).
