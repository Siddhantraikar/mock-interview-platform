/**
 * interviewController.js
 * -----------------------------------------------------------------------
 * Interview conduction — HTTP layer
 * Owner: Siddhant Raikar
 *
 * ARCHITECTURE NOTE: see interviewEvaluatorService.js / Interview.js — this
 * controller exists so the team has a real, working interview flow to demo
 * end-to-end. On the module dependency slide, conducting the interview is
 * Modules 1/3's job, not Module 4's.
 *
 * Follows the exact ownership pattern established in resumeController.js:
 * every read/write is scoped to `req.user.id`, and IDs are validated with
 * `mongoose.isObjectIdOrHexString` before ever reaching a Mongoose query,
 * so a malformed or foreign ID 404s instead of being cast/queried.
 * -----------------------------------------------------------------------
 */

const mongoose = require('mongoose');
const Interview = require('../models/Interview');
const Resume = require('../models/Resume');
const questionGeneratorService = require('../services/questionGeneratorService');
const interviewEvaluatorService = require('../services/interviewEvaluatorService');
const ttsService = require('../services/ttsService');

function publicQuestion(entry, index, total) {
  return {
    index,
    total,
    question: entry.question,
    type: entry.type,
    basedOn: entry.basedOn,
    answered: Boolean(entry.answeredAt),
  };
}

function publicState(interview) {
  const total = interview.questions.length;
  const atEnd = interview.currentIndex >= total;
  return {
    interviewId: interview._id.toString(),
    status: interview.status,
    totalQuestions: total,
    currentIndex: interview.currentIndex,
    questionsSource: interview.questionsSource,
    currentQuestion: atEnd ? null : publicQuestion(interview.questions[interview.currentIndex], interview.currentIndex, total),
    completed: interview.status === 'completed',
  };
}

async function findOwnedInterview(req) {
  if (!mongoose.isObjectIdOrHexString(req.params.id) || !mongoose.isObjectIdOrHexString(req.user.id)) {
    return null;
  }
  return Interview.findOne({ _id: req.params.id, userId: req.user.id });
}

/**
 * POST /api/interview/start  { resumeId }
 * Generates a fresh question set from the resume's stored context (same
 * path as GET /api/resume/:id/questions) and starts a new interview session.
 */
async function startInterview(req, res) {
  try {
    const { resumeId } = req.body || {};
    if (!mongoose.isObjectIdOrHexString(resumeId) || !mongoose.isObjectIdOrHexString(req.user.id)) {
      return res.status(400).json({ error: 'A valid resumeId is required.' });
    }
    const resume = await Resume.findOne({ _id: resumeId, userId: req.user.id }).lean();
    if (!resume) return res.status(404).json({ error: 'Resume not found.' });

    const { questions, source } = await questionGeneratorService.generateQuestions(resume.resumeContext);
    const cleanQuestions = questions
      .filter((q) => q && typeof q.question === 'string' && q.question.trim())
      .map((q) => ({
        question: q.question.trim(),
        type: typeof q.type === 'string' ? q.type : 'technical',
        basedOn: typeof q.basedOn === 'string' ? q.basedOn : '',
      }));
    if (!cleanQuestions.length) {
      return res.status(500).json({ error: 'No interview questions could be generated for this resume.' });
    }

    const interview = await Interview.create({
      userId: req.user.id,
      resumeId,
      interviewType: resume.resumeContext?.interviewType || 'Technical',
      targetRole: resume.resumeContext?.targetRole || '',
      questions: cleanQuestions,
      currentIndex: 0,
      status: 'in_progress',
      questionsSource: source,
    });

    return res.status(201).json(publicState(interview));
  } catch (err) {
    console.error('[interviewController.startInterview] Failed to start interview.');
    return res.status(500).json({ error: 'Failed to start interview.' });
  }
}

/** GET /api/interview/:id — current state, for resuming after a refresh. */
async function getState(req, res) {
  try {
    const interview = await findOwnedInterview(req);
    if (!interview) return res.status(404).json({ error: 'Interview not found.' });
    return res.json(publicState(interview));
  } catch {
    console.error('[interviewController.getState] Database read failed.');
    return res.status(500).json({ error: 'Failed to retrieve interview.' });
  }
}

/**
 * GET /api/interview/:id/audio/:index — Edge TTS audio for one question.
 * Resolves to an mp3 stream, or 204 (no body) if speech synthesis is
 * unavailable — the frontend treats 204 as "fall back to on-screen text
 * (or the browser's own speechSynthesis), this is not a hard failure."
 */
async function getQuestionAudio(req, res) {
  try {
    const interview = await findOwnedInterview(req);
    if (!interview) return res.status(404).json({ error: 'Interview not found.' });
    const index = Number(req.params.index);
    const entry = Number.isInteger(index) ? interview.questions[index] : null;
    if (!entry) return res.status(404).json({ error: 'Question not found.' });

    const audio = await ttsService.generateSpeech(entry.question);
    if (!audio) return res.status(204).end();

    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'private, max-age=3600');
    return res.send(audio);
  } catch {
    console.error('[interviewController.getQuestionAudio] Speech synthesis failed.');
    return res.status(204).end();
  }
}

/**
 * POST /api/interview/:id/answer  { index, answer }
 * Evaluates the given answer (Ollama, falling back to the heuristic
 * evaluator — see interviewEvaluatorService.js), stores it, advances the
 * interview, and — once the final question is answered — generates and
 * stores the overall summary in the same request.
 */
async function submitAnswer(req, res) {
  try {
    const interview = await findOwnedInterview(req);
    if (!interview) return res.status(404).json({ error: 'Interview not found.' });
    if (interview.status === 'completed') {
      return res.status(409).json({ error: 'This interview has already finished.' });
    }

    const { index, answer } = req.body || {};
    if (!Number.isInteger(index) || index !== interview.currentIndex || !interview.questions[index]) {
      return res.status(400).json({ error: 'This question is not the current question in this interview.' });
    }
    if (typeof answer !== 'string' || !answer.trim()) {
      return res.status(400).json({ error: 'An answer is required.' });
    }

    const resume = await Resume.findOne({ _id: interview.resumeId, userId: req.user.id }).lean();
    const resumeContext = { targetRole: interview.targetRole, skills: resume?.resumeContext?.skills || [] };
    const entry = interview.questions[index];
    const evaluation = await interviewEvaluatorService.evaluateAnswer(
      { question: entry.question, type: entry.type, basedOn: entry.basedOn },
      answer.trim(),
      resumeContext
    );

    entry.answer = answer.trim();
    entry.score = evaluation.score;
    entry.feedback = evaluation.feedback;
    entry.strengths = Array.isArray(evaluation.strengths) ? evaluation.strengths : [];
    entry.improvements = Array.isArray(evaluation.improvements) ? evaluation.improvements : [];
    entry.evaluationSource = evaluation.source;
    entry.answeredAt = new Date();
    interview.currentIndex = index + 1;

    let overallSummary = null;
    if (interview.currentIndex >= interview.questions.length) {
      interview.status = 'completed';
      overallSummary = await interviewEvaluatorService.generateOverallSummary(
        interview.questions.map((q) => ({
          question: q.question, type: q.type, basedOn: q.basedOn, answer: q.answer, score: q.score,
        }))
      );
      interview.overallSummary = overallSummary;
    }

    await interview.save();

    return res.json({
      evaluation: {
        score: entry.score,
        feedback: entry.feedback,
        strengths: entry.strengths,
        improvements: entry.improvements,
        source: entry.evaluationSource,
      },
      ...publicState(interview),
      overallSummary: overallSummary || undefined,
    });
  } catch {
    console.error('[interviewController.submitAnswer] Failed to evaluate or save answer.');
    return res.status(500).json({ error: 'Failed to submit answer.' });
  }
}

/** GET /api/interview/:id/report — full transcript + overall summary. */
async function getReport(req, res) {
  try {
    const interview = await findOwnedInterview(req);
    if (!interview) return res.status(404).json({ error: 'Interview not found.' });
    return res.json({
      interviewId: interview._id.toString(),
      status: interview.status,
      interviewType: interview.interviewType,
      targetRole: interview.targetRole,
      questionsSource: interview.questionsSource,
      questions: interview.questions,
      overallSummary: interview.overallSummary,
    });
  } catch {
    console.error('[interviewController.getReport] Database read failed.');
    return res.status(500).json({ error: 'Failed to retrieve interview report.' });
  }
}

module.exports = { startInterview, getState, getQuestionAudio, submitAnswer, getReport };
