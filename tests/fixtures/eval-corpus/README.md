# Stage 4 eval corpus

Synthetic files for the Stage 4 retrieval evaluation. Everything here is invented: people, companies, numbers, addresses and bank details.

Contents: the files of a freelance consultant with several clients (proposals and contracts in several versions, call notes, invoices), a small software team (policies, retros, meeting notes and a booking and payments code repository), and a household (manuals, receipts, recipes, travel plans). Also exact duplicate copies, look-alike files built from the same template, and images and scanned PDFs with text only readable by OCR.

Regenerate with: node scripts/make-eval-corpus.mjs

File dates matter for the time-based queries. Git does not keep them, so they are stored in ../eval-corpus.manifest.json and must be applied after copying the folder. The queries are in tests/eval/queries-s4.jsonl. This README is not part of any query.
