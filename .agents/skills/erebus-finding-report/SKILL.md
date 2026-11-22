---
name: erebus-finding-report
description: Write or revise a concise vulnerability report for an external triager from validated evidence and the program's supplied template.
---

# Finding report

Read `references/report-template.md` before writing. If the program supplies its own template or field rules, use those first.

Write for a triager with no local context. Explain the flaw, realistic attacker path, target-owned root cause, exact stable version, reproduction, and proved impact in direct prose. Keep prerequisites and limits precise without burying the result in caveats.

Do not mention local paths, agent roles, internal tools, memory systems, or the research process. Do not turn the report into a legal document, audit worksheet, or capability claim. Use the smallest amount of code and output needed to make the proof trustworthy.
