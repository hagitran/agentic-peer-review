# agentic-peer-review

MVP web app for uploading research PDFs, extracting text, and running lightweight paper understanding workflows.

## Current MVP scope

- Upload PDF(s)
- Extract text server-side
- Persist extraction output
- Preview extracted text
- Move through tabs (`Overview`, `Method`, `Evals`, `Results`) in one-page state

## Local setup

1. Install dependencies
```bash
npm install
```

2. Set environment variables in `/Users/hagi/Documents/Coding/agentic-peer-review/.env.local`
```bash
DATABASE_URL=postgresql://...
```

3. Run dev server
```bash
npm run dev
```

## Decision log

Non-trivial architecture/product decisions live in:

- `/Users/hagi/Documents/Coding/agentic-peer-review/DECISIONS.md`

When we make or revisit a non-trivial design choice, we should append a short entry there.
