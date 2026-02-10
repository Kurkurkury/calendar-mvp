# PROJECT_TRUTH_FILE_V2.md

## Project
calendar-assistant v2  
(Document → Event / Task Intelligence)

## Status
V2 ACTIVE — new project, clean scope separation from calendar-mvp v1.

calendar-mvp v1 is **frozen** and considered **done**.

---

## Core Vision
Enable users to upload documents (screenshots, PDFs, text) and receive **AI-generated calendar suggestions**, while keeping **explicit human confirmation** as a hard rule.

No automatic writes. No hidden actions.

---

## Non-Negotiable Rules
- This document is the **Single Source of Truth** for V2.
- One Codex message **per phase**.
- No phase reset.
- No feature creep.
- Confirmation before any calendar write.
- Google Calendar remains the **only source of truth** for persisted events.

---

## What V2 Is
- Assistive intelligence
- Suggestion-based
- User-controlled
- Transparent and debuggable

## What V2 Is NOT
- Fully autonomous assistant
- Email inbox reader
- Background surveillance tool
- Silent calendar modifier

---

## High-Level Architecture
Input (Document)  
→ OCR / Text Extraction  
→ Semantic Parsing (date, time, duration, title, location)  
→ AI Suggestion Engine  
→ Human Review  
→ Existing Quick-Add / Calendar Flow

---

## Phase Overview

### Phase 1 — Document Ingestion (FOUNDATION)
**Goal:** Get text reliably from user-provided material.

Includes:
- Image upload (screenshots, photos)
- PDF upload
- Text paste fallback
- OCR for images / PDFs
- Unified extracted text output

Out of Scope:
- Long-term document storage
- Versioning
- Auto-classification

Status: DONE

---

### Phase 2 — Semantic Extraction
**Goal:** Convert raw text into structured candidate data.

Includes:
- Date detection
- Time & duration detection
- Title / intent inference
- Location extraction (if present)
- Confidence scoring per field

Out of Scope:
- Auto-correction without user input
- Learning from past behavior

Status: NOT STARTED

---

### Phase 3 — Suggestion UX
**Goal:** Present extracted data as clear, reviewable suggestions.

Includes:
- List of proposed events/tasks
- Clear source reference (what text triggered what)
- Accept / reject per suggestion
- Manual editing before accept

Out of Scope:
- Auto-accept
- Bulk silent actions

Status: NOT STARTED

---

### Phase 4 — Calendar Integration (CONTROLLED)
**Goal:** Safely integrate with existing calendar logic.

Includes:
- Reuse existing Quick-Add flow
- Explicit confirmation before write
- Full compatibility with Google Calendar

Out of Scope:
- Direct calendar writes from OCR
- Background sync

Status: NOT STARTED

---

## Definition of Done (Global)
V2 is considered complete when:
- A user can upload a document
- The system extracts text reliably
- Suggestions are generated and shown
- The user can confirm or reject each
- Accepted suggestions appear correctly in Google Calendar
- No action happens without explicit confirmation

---

## Explicit Future Ideas (NOT PART OF V2)
- Email inbox parsing
- Background notification scanning
- Auto-suggestions without upload
- Learning models based on user history

These require **V3** and a new Truth file.

---

## End Statement
calendar-assistant v2 exists to **assist, not decide**.

Control stays with the user.
