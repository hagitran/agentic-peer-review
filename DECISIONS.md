# Decisions Log

This file tracks non-trivial architecture and product choices for this repo.

## Entry format

- `Date`:
- `Context`:
- `Decision`:
- `Why`:
- `Tradeoffs`:
- `Revisit when`:

---

## 2026-02-06 - Token control strategy for feasibility check

- `Context`:
We need a low-cost first-pass feasibility agent over extracted paper text. Full-text prompts are expensive and noisy.

- `Decision`:
Start with lightweight section slicing heuristics and pass only method/setup-focused text to the LLM. Do not add embeddings yet.

- `Why`:
This gives immediate token reduction with minimal implementation complexity and no extra storage/index infra.

- `Tradeoffs`:
Heuristics can miss odd section naming and are less robust than semantic retrieval for long/atypical papers.

- `Revisit when`:
When we process a larger paper volume, need cross-paper retrieval, or see repeated failures from heuristic slicing. At that point, add embeddings and retrieval as a second stage.

---

## 2026-02-06 - Decision capture habit

- `Context`:
Important design insights were being discussed but not consistently documented.

- `Decision`:
Record all non-trivial choices in this file and ask whether a new decision should be logged when substantial tradeoff discussions happen.

- `Why`:
Keeps project direction explicit and reduces repeated debates.

- `Tradeoffs`:
Small overhead in writing entries.

- `Revisit when`:
If entries become too verbose, enforce shorter entries with links to deeper docs.
