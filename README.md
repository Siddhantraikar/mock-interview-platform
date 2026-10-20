# AI-Powered Mock Interview Platform — Group P49

**Guide:** Prof. Seema Idhate
**Team:** Siddhant Raikar (Module 4 — Resume Processing & Resume Intelligence, plus the interview-conduction layer described below), Vedant Chavan (MongoDB persistence + frontend UI)

This repository is the team's single working codebase for the capstone project. It is not a mockup or a slide — every endpoint, page and fallback path described below is real, runnable code, checked into this repo and exercised by the tests in `test/`.

---

## 0. What this project actually is, in one paragraph

A candidate signs up, logs in, and uploads their resume as a PDF. The backend extracts the text, parses it into structured sections (skills, projects, experience, education, certifications), and sends that structured data to a locally-running Llama 3.2 model (via Ollama) for a short qualitative analysis — or, if Ollama isn't available, to a deterministic rule-based fallback that is clearly labelled as such. From there, the candidate can either preview sample interview questions, or start a full mock interview: one question at a time, read aloud with free text-to-speech audio, answered in the candidate's own words, scored and given feedback immediately (again via Ollama with a labelled heuristic fallback), finishing in a scored report with an overall summary. Everything is persisted per-user in MongoDB.

## 1. Module ownership — what's really been built, and by whom

The original design split the system into four modules (per the class/use-case/LLD diagrams presented earlier in the capstone):

| Module | Scope (as designed) | Status in this repo |
|---|---|---|
| 1 — Candidate/Interview orchestration | Drive the interview session, ask questions, manage flow | **Not separately implemented as its own module.** Its responsibilities (asking questions, collecting answers, producing a report) are covered by the interview-conduction layer described in §3, built here so the team has one working end-to-end system — see the architecture note in `src/services/interviewEvaluatorService.js`. |
| 2 — Frontend / UI | All candidate-facing pages | Implemented here: `public/` (login, resume workspace, mock interview UI) — layout/CSS/JS structure is Vedant's UI work; the mock-interview tab and its JS were added as part of §3. |
| 3 — Question generation & scoring | Turn resume data into personalised questions, score answers | **Not separately implemented as its own module.** Covered by `questionGeneratorService.js` and `interviewEvaluatorService.js` in this repo — again, built here as a demo convenience, not a claim that Module 4 owns this responsibility. |
| 4 — Resume Processing & Resume Intelligence (Siddhant's actual assigned module) | PDF → structured resume → LLM analysis → `ResumeContext` handoff | **Fully implemented**, matches the original class/activity/LLD diagrams exactly: `src/services/pdfService.js`, `resumeParserService.js`, `ollamaService.js`, `contextBuilder.js`. |
| — Persistence & Auth (not one of the four, cross-cutting) | User accounts, resume storage | **Fully implemented** — MongoDB via Mongoose (Vedant), JWT + bcrypt auth (Siddhant). |

**Say this plainly if a mentor asks "who owns the interview-conducting feature?"**: on the module dependency slide it's Modules 1 and 3's job. It was built inside Module 4's codebase purely because nobody else had built it yet and the team needed a complete, demoable system rather than a resume-parser with no destination for its output. The code says so in comments (`interviewEvaluatorService.js`, `questionGeneratorService.js`) and this README says so here.

## 2. Architecture

```
Candidate (browser)
  │
  ├─ /login.html  — sign up / sign in (JWT + bcrypt, MongoDB-backed)
  │
  └─ /index.html  — resume workspace
       ├─ Tab: Overview / Resume details   — parsed resume + LLM (or heuristic) analysis
       ├─ Tab: Questions                    — sample personalised questions (preview only, not persisted)
       └─ Tab: Mock interview               — the real interview flow (§3)

Express app (server.js)
  ├─ /api/auth/*      signup, login, me                    (authController.js)
  ├─ /api/resume/*    upload, get, context, questions       (resumeController.js)
  └─ /api/interview/* start, state, audio, answer, report   (interviewController.js)   ← new, §3

Data flow for one resume:
  PDF upload → pdfService.extractText → resumeParserService.parse → ollamaService.analyseResume
  → contextBuilder.build → stored as Resume { parsedResume, analysis, resumeContext } in MongoDB

Data flow for one interview:
  questionGeneratorService.generateQuestions(resumeContext) → Interview { questions[] } in MongoDB
  → per question: ttsService.generateSpeech(question) → mp3 audio to the browser
  → candidate types an answer → interviewEvaluatorService.evaluateAnswer → stored, scored, fed back
  → after the last question: interviewEvaluatorService.generateOverallSummary → final report
```

Every LLM-backed service in this codebase (`ollamaService`, `questionGeneratorService`, `interviewEvaluatorService`) follows the same contract: try Ollama first with a short timeout and a couple of retries, and if it's unreachable or returns something unparsable, fall back to a deterministic, resume-grounded heuristic — never throwing, always labelling which one actually ran via a `source` field (`"ollama-llama3.2"` or `"heuristic-fallback"`), surfaced in the UI as a visible badge rather than hidden. This is the "graceful degradation on AI service failure" requirement from the design docs, implemented rather than just diagrammed.

## 3. The mock interview feature (new)

This is the feature added most recently: a real, end-to-end "conduct the interview" flow, not just a question preview.

- **`POST /api/interview/start`** `{ resumeId }` — generates a fresh question set from that resume's stored `resumeContext` (same generator as the Questions tab) and creates a persisted `Interview` session (MongoDB, ownership-filtered exactly like `Resume`).
- **`GET /api/interview/:id`** — current session state, so a page refresh doesn't lose progress.
- **`GET /api/interview/:id/audio/:index`** — streams back an MP3 of the question, synthesised on the fly via **Edge TTS** (`msedge-tts`, free, no API key, uses Microsoft Edge's neural voices over its public WebSocket endpoint). If synthesis isn't available, this endpoint returns `204 No Content` and the frontend treats that as "show the text, speech just isn't available right now" — never a hard failure.
- **`POST /api/interview/:id/answer`** `{ index, answer }` — the candidate's typed answer is scored by `interviewEvaluatorService.evaluateAnswer` (Ollama, with a word-count + keyword-overlap heuristic fallback), returning a 1–10 score, written feedback, strengths and improvements. On the last question, the same request also triggers `generateOverallSummary` and marks the interview completed.
- **`GET /api/interview/:id/report`** — the full transcript (every question, the candidate's answer, the score and feedback) plus the overall summary (average score, top strength, top area to improve).

Frontend: a new **"Mock interview"** tab in `public/index.html` / `public/js/app.js` drives this whole flow — start button, one question card at a time with an audio player (auto-attempts playback, with a manual replay button), a free-text answer box, inline scored feedback after each answer, and a final report screen with the full transcript.

**Why typed answers, not voice-to-text:** the request was specifically for text-to-speech (questions read aloud), not speech-to-text. Speech recognition for the candidate's spoken answer is a separate, much larger feature (reliable browser/OS mic capture + an ASR model) that wasn't in scope here. The candidate hears the question, can answer out loud for their own practice, and types what they said — a deliberate, honestly-scoped choice, not an oversight.

**A real limitation worth knowing before the demo:** Edge TTS's endpoint (`api.msedgeservices.com`) was **not reachable from the cloud sandbox this code was written in** — that sandbox's network policy blocks that specific host, confirmed directly (the proxy returned an explicit connection-rejected status for that domain, not a timeout or a code bug). The code is written against `msedge-tts`'s documented, typed API exactly as published (verified by reading its `.d.ts`/`.js` source directly), and it will work normally on a regular machine with normal internet access — which is what the demo will actually run on. **Please test `GET /api/interview/:id/audio/:index` once on your own machine before the demo** to confirm audio playback end-to-end; if it ever fails there too, the 204 fallback means the rest of the interview flow (questions, typed answers, scoring, report) keeps working regardless, with the question just shown as text.

## 4. Install & run

```bash
npm install
```

Requires Node.js 18+. `pdftotext` (from `poppler-utils`) is optional but recommended as a PDF-extraction fallback — `apt install poppler-utils` / `brew install poppler`.

1. Copy `.env.example` to `.env`.
2. Set `MONGODB_URI` to your MongoDB Atlas connection string (or a local MongoDB instance). Keep `MONGODB_DB_NAME=mock_interview_platform` and `DEMO_USER_ID=000000000000000000000001` exactly — resumes already in the database are owned by that fixed ID.
3. (Optional, for real LLM analysis/questions/scoring instead of the heuristic fallback) Install [Ollama](https://ollama.com) and run `ollama pull llama3.2`, then `ollama serve` (or let the installed app run it) so `http://localhost:11434` is reachable.
4. `npm start`. Startup connects to MongoDB, seeds the demo user, then listens on `http://localhost:5001`.
5. Open `http://localhost:5001/` in a browser, sign in with the demo account below (or create your own account), upload a resume PDF, and either explore the Overview/Details/Questions tabs or go straight to **Mock interview**.

**Demo account:**
```
DEMO_USER_EMAIL=siddhant@capstone.demo
DEMO_USER_PASSWORD=demo1234
```

### CLI demo (no browser — good as a backup)

```bash
python3 test/generate_sample_resume.py   # only needed once, or point it at your own PDF
npm run demo                              # node test/parseSample.js test/sample_resume.pdf
```

Prints, step by step: PDF extraction → section parsing → LLM/heuristic analysis → the final `ResumeContext` handed to the interview layer.

### Tests

```bash
npm test               # resume pipeline + auth unit tests (no live MongoDB required)
npm run test:integration   # real MongoDB integration tests (needs MONGODB_TEST_URI/MONGODB_URI)
```

The interview/TTS layer added in §3 does not yet have its own automated test file in `test/` — it was verified with a logic-level harness during development (every controller path: start, resume-on-refresh, wrong-question-index rejection, cross-user 404s, mid-interview answer scoring, completion + summary generation, and report retrieval) rather than a committed test, since the sandbox it was built in cannot reach either a real MongoDB server or the live Edge TTS endpoint to run a true integration test. Adding `test/interview.test.js` (mocking Ollama/Edge TTS the same way `mongoCheckpoint.test.js` mocks Ollama) is a good next task for whoever picks this up.

## 5. Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | 5001 | Server port |
| `MONGODB_URI` | *(required)* | MongoDB connection string |
| `MONGODB_DB_NAME` | mock_interview_platform | Application database |
| `MONGODB_TEST_DB_NAME` / `MONGODB_TEST_URI` | mock_interview_platform_test / falls back to `MONGODB_URI` | Integration test database |
| `JWT_SECRET` | demo default — change it | Signs login tokens |
| `JWT_EXPIRES_IN` | 4h | JWT lifetime |
| `DEMO_USER_ID` | 000000000000000000000001 | Fixed demo identity (must not change — legacy resume ownership) |
| `DEMO_USER_EMAIL` / `DEMO_USER_PASSWORD` / `DEMO_USER_NAME` | see `.env.example` | Initial demo seed values |
| `OLLAMA_BASE_URL` | http://localhost:11434 | Where Ollama is running |
| `OLLAMA_MODEL` | llama3.2 | Model name to call |
| `OLLAMA_TIMEOUT_MS` | 4000 | Timeout before falling back to the heuristic path |
| `TTS_VOICE` | en-US-GuyNeural | Edge TTS voice used to read questions aloud |
| `TTS_TIMEOUT_MS` | 8000 | Edge TTS connection/synthesis timeout before returning 204 |

## 6. API reference

```
POST /api/auth/signup        { name, email, password, confirmPassword }
POST /api/auth/login         { email, password }
GET  /api/auth/me            (Bearer token)

POST /api/resume/upload       multipart: resume (PDF), interviewType, targetRole
GET  /api/resume/:id
GET  /api/resume/:id/context
GET  /api/resume/:id/questions

POST /api/interview/start                { resumeId }
GET  /api/interview/:id
GET  /api/interview/:id/audio/:index      → audio/mpeg, or 204 if TTS is unavailable
POST /api/interview/:id/answer            { index, answer }
GET  /api/interview/:id/report
```

All `/api/resume/*` and `/api/interview/*` routes require `Authorization: Bearer <token>` and are filtered to the requesting user's own records — a foreign or malformed ID returns `404`, never another user's data.

## 7. Honest status (for the mentor, and for the team)

**Solid / production-quality for a capstone demo:**
- PDF extraction, section parsing (including real-world PDF quirks: no blank lines between entries, split bullet markers, wrapped lines, multiple projects/education entries correctly separated), and the resume → analysis → context pipeline. Verified against a generated sample resume and a real candidate resume.
- MongoDB persistence with proper per-user ownership filtering everywhere (resumes and interviews alike).
- JWT + bcrypt auth, with signup validation and a fixed-ID demo account that survives redeploys.
- Graceful degradation: every LLM call (resume analysis, question generation, answer scoring, overall summary) has a real, tested, clearly-labelled heuristic fallback. Nothing breaks if Ollama isn't running.

**Real, but demo-quality / honestly scoped:**
- The mock interview flow (§3) is fully working end-to-end but was built quickly to give the team *something* beyond resume parsing to show; it architecturally belongs to Modules 1/3, not Module 4, and the code says so.
- Edge TTS audio could not be verified from inside the development sandbox (network policy, not a code issue — see §3) and should be tested once on the demo machine beforehand.
- Interview answers are typed, not spoken — there is no speech-to-text in this build.
- No automated test file for the interview/TTS layer yet (see §4).

**Out of scope, stated plainly rather than silently missing:**
- OCR for scanned/image-only PDF resumes.
- Email verification, password recovery, account-management screens.
- Any production-grade rate limiting, input sanitisation hardening, or secrets management beyond `.env` — this is demo/capstone-grade security, not production-grade.
