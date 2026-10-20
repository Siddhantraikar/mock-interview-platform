/**
 * Interview.js
 * -----------------------------------------------------------------------
 * Interview conduction — persisted interview sessions
 * Owner: Siddhant Raikar
 *
 * ARCHITECTURE NOTE: see interviewEvaluatorService.js — this model, like
 * that service, sits outside Module 4's documented scope. It exists so the
 * team has one real, working interview flow to demo end-to-end instead of
 * only the resume-processing half of the system.
 *
 * Mirrors the ownership-filtered pattern already used by Resume.js: every
 * read goes through a userId match, and the fixed demo user ID constraint
 * (see .env.example / seedDemoUser.js) is respected the same way.
 * -----------------------------------------------------------------------
 */

const mongoose = require('mongoose');

const evaluatedQuestionSchema = new mongoose.Schema(
  {
    question: { type: String, required: true, trim: true },
    type: { type: String, default: 'technical', trim: true },
    basedOn: { type: String, default: '', trim: true },
    answer: { type: String, default: '', trim: true },
    score: { type: Number, default: null, min: 0, max: 10 },
    feedback: { type: String, default: '', trim: true },
    strengths: { type: [String], default: [] },
    improvements: { type: [String], default: [] },
    evaluationSource: { type: String, default: '' }, // 'ollama-llama3.2' | 'heuristic-fallback'
    answeredAt: { type: Date, default: null },
  },
  { _id: false }
);

const overallSummarySchema = new mongoose.Schema(
  {
    overallFeedback: { type: String, default: '' },
    averageScore: { type: Number, default: null },
    topStrength: { type: String, default: '' },
    topImprovement: { type: String, default: '' },
    source: { type: String, default: '' },
  },
  { _id: false }
);

const interviewSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true },
    resumeId: { type: mongoose.Schema.Types.ObjectId, required: true },
    interviewType: { type: String, default: 'Technical' },
    targetRole: { type: String, default: '' },
    questions: { type: [evaluatedQuestionSchema], default: [] },
    currentIndex: { type: Number, default: 0 },
    status: { type: String, enum: ['in_progress', 'completed'], default: 'in_progress' },
    questionsSource: { type: String, default: '' }, // 'ollama-llama3.2' | 'heuristic-fallback'
    overallSummary: { type: overallSummarySchema, default: null },
  },
  { timestamps: true, bufferCommands: false }
);

// Ownership-filtered lookups, most-recent-first (matches Resume.js's index shape).
interviewSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('Interview', interviewSchema);
