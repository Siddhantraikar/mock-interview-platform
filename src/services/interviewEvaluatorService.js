/**
 * interviewEvaluatorService.js
 * -----------------------------------------------------------------------
 * Interview conduction — answer evaluation + final report
 * Owner: Siddhant Raikar
 *
 * ARCHITECTURE NOTE: on the team's module dependency slide, actually
 * conducting the interview (asking questions, scoring answers, producing
 * a report) is Modules 1/3's job, not Module 4's. This file exists
 * because nobody had built that piece yet and the team needed a real,
 * working end-to-end system to demo — not because Module 4 "owns"
 * interview conduction. Say so plainly if asked.
 *
 * Same reliability pattern as ollamaService.js / questionGeneratorService.js:
 * try Ollama first, fall back to a deterministic heuristic if it's
 * unavailable or times out — never throws, always labels which one ran.
 * -----------------------------------------------------------------------
 */

const axios = require('axios');

const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS || 4000);
const MAX_RETRIES = 2;

async function generate(prompt) {
  const response = await axios.post(
    `${OLLAMA_BASE_URL}/api/generate`,
    // Temperature 0 + fixed seed so the same answer gets the same score each time.
    { model: OLLAMA_MODEL, prompt, stream: false, format: 'json', options: { temperature: 0, seed: 42 } },
    { timeout: REQUEST_TIMEOUT_MS }
  );
  return response.data.response;
}

function parseJson(reply) {
  try {
    return JSON.parse(reply);
  } catch (err) {
    const stripped = reply.replace(/```json|```/g, '').trim();
    return JSON.parse(stripped);
  }
}

async function generateJsonWithRetry(prompt, retries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const reply = await generate(prompt);
      return parseJson(reply);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Rubric criteria. Asking a small model for a single 1-10 number makes it
 * cluster on a "safe" 7-8 for almost any reasonable-sounding answer, so
 * instead it scores each criterion against concrete level descriptions and
 * the total is computed here. Max points sum to 10.
 */
const RUBRIC = {
  relevance: { max: 3, levels: [
    '0 = does not address the question, off-topic, or deflects',
    '1 = touches the topic, or says WHAT they would do without saying HOW',
    '2 = explains how they would answer the main point but skips part of what was asked',
    '3 = directly and completely answers every part of the question',
  ] },
  accuracy: { max: 3, levels: [
    '0 = contains wrong or misleading claims (for behavioral: no actual example)',
    '1 = nothing clearly wrong but too generic to verify (buzzwords, "best practices"), or a mix of right and wrong',
    '2 = real, correct technical content with only minor gaps or imprecision',
    '3 = correct and precise, uses the right concepts/terms (for behavioral: a believable, well-supported example)',
  ] },
  depth: { max: 2, levels: [
    '0 = generic statements anyone could say, no concrete detail',
    '1 = some concrete detail (a tool, step, or example) but little reasoning',
    '2 = concrete specifics AND reasoning: trade-offs, numbers, why one approach over another, or outcomes',
  ] },
  clarity: { max: 2, levels: [
    '0 = hard to follow, fragmented, or a single throwaway line',
    '1 = understandable but loosely organised',
    '2 = clear, logically structured, easy to follow',
  ] },
};

/**
 * The actual "interviewer" prompt. Kept strict about JSON shape (same
 * pattern as the rest of the codebase) so a wobbly model reply can still
 * be parsed. "analysis" comes first so the model judges the answer before
 * committing to numbers.
 */
function buildEvaluationPrompt(question, answer, resumeContext) {
  const rubricText = Object.entries(RUBRIC)
    .map(([name, { max, levels }]) => `${name} (0-${max}):\n  ${levels.join('\n  ')}`)
    .join('\n');

  return `You are a strict but fair technical interviewer evaluating a candidate's spoken answer in a mock interview.
Respond ONLY with JSON in exactly this shape:
{"specifics": ["..."], "analysis": "...", "relevance": <int>, "accuracy": <int>, "depth": <int>, "clarity": <int>, "feedback": "...", "strengths": ["..."], "improvements": ["..."]}

Candidate background — skills: ${(resumeContext.skills || []).join(', ') || 'none listed'}
Target role: ${resumeContext.targetRole || 'Software Engineer'}

Interview question (${question.type || 'technical'}, based on "${question.basedOn || 'general'}"):
"${question.question}"

Candidate's answer:
"${answer}"

Step 1: in "specifics", list every concrete, correct detail the answer actually states (named tools,
commands, numbers, design decisions, trade-offs, reasons, outcomes). Use [] if there are none. Do not
list generic claims like "make it fast" or "use best practices".
Step 2: in "analysis", write 1-2 sentences on what the answer covers and what it misses.
Step 3: score each criterion using ONLY these levels:
${rubricText}

Base "depth" on Step 1: no specifics = 0, a few specifics without reasons = 1, several specifics with
reasons or trade-offs = 2. Judge each criterion independently and pick the level whose description
matches best — give low levels to weak answers and top levels to answers that meet the description;
do not default to the middle. Write "feedback" as if speaking directly to the candidate, 2-3 sentences.
List 1-2 strengths and 1-2 concrete improvements.`;
}

function clampInt(value, max) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : 0;
}

/**
 * Sums the rubric into a 1-10 score. A very short answer can't be a strong
 * answer, so it's capped regardless of what the model said.
 */
function scoreFromRubric(result, answer) {
  const breakdown = {};
  for (const [name, { max }] of Object.entries(RUBRIC)) breakdown[name] = clampInt(result[name], max);
  let score = Object.values(breakdown).reduce((a, b) => a + b, 0);

  const wordCount = (answer || '').trim().split(/\s+/).filter(Boolean).length;
  if (wordCount < 8) score = Math.min(score, 3);
  else if (wordCount < 20) score = Math.min(score, 6);

  return { score: Math.max(1, Math.min(10, score)), breakdown };
}

/**
 * Deterministic fallback: scores on answer length and lexical overlap with
 * the question/basedOn topic, as a rough proxy for "did they actually
 * engage with the question" — not a substitute for real judgement, but
 * enough to keep the interview flow demoable without Ollama.
 */
function heuristicFallbackEvaluation(question, answer) {
  const trimmed = (answer || '').trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;

  const topicWords = `${question.basedOn || ''} ${question.question || ''}`
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3);
  const answerLower = trimmed.toLowerCase();
  const overlap = topicWords.filter((w) => answerLower.includes(w)).length;

  let score;
  if (wordCount < 8) score = 2;
  else if (wordCount < 25) score = overlap > 0 ? 5 : 4;
  else if (wordCount < 80) score = overlap > 0 ? 7 : 6;
  else score = overlap > 0 ? 8 : 7;

  const feedback = wordCount < 8
    ? 'That answer was quite short — try to explain your reasoning and give a concrete example next time.'
    : 'Reasonable length and detail. Try naming specific tools, numbers, or decisions to make it more concrete.';

  return {
    score,
    feedback,
    strengths: wordCount >= 25 ? ['Gave a reasonably detailed answer'] : [],
    improvements: wordCount < 25 ? ['Add more specific detail — name the actual tools, numbers, or trade-offs involved'] : [],
    source: 'heuristic-fallback',
  };
}

async function evaluateAnswer(question, answer, resumeContext) {
  try {
    const prompt = buildEvaluationPrompt(question, answer, resumeContext);
    const result = await generateJsonWithRetry(prompt);
    const { score, breakdown } = scoreFromRubric(result, answer);
    return { ...result, score, breakdown, source: 'ollama-llama3.2' };
  } catch (err) {
    return heuristicFallbackEvaluation(question, answer);
  }
}

function buildOverallSummaryPrompt(evaluatedQuestions) {
  const transcript = evaluatedQuestions
    .map((q, i) => `Q${i + 1} (${q.type}, score ${q.score}/10): ${q.question}\nAnswer: ${q.answer}`)
    .join('\n\n');

  return `You are summarising a candidate's performance across a full mock interview.
Respond ONLY with JSON in exactly this shape:
{"overallFeedback": "...", "averageScore": <number>, "topStrength": "...", "topImprovement": "..."}

${transcript}

Write 2-3 sentences of overall feedback, the honest average score across all questions,
one standout strength, and the single most important thing to improve.`;
}

function heuristicFallbackSummary(evaluatedQuestions) {
  const scores = evaluatedQuestions.map((q) => q.score || 0);
  const averageScore = scores.length
    ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
    : 0;

  const weakest = evaluatedQuestions.reduce(
    (worst, q) => (q.score < worst.score ? q : worst),
    evaluatedQuestions[0] || { score: 10, basedOn: 'general' }
  );
  const strongest = evaluatedQuestions.reduce(
    (best, q) => (q.score > best.score ? q : best),
    evaluatedQuestions[0] || { score: 0, basedOn: 'general' }
  );

  return {
    overallFeedback: `Across ${evaluatedQuestions.length} questions, answers averaged ${averageScore}/10. ` +
      `The strongest answer was on "${strongest.basedOn}"; the weakest was on "${weakest.basedOn}" — ` +
      `that's a good area to prepare further before the real interview.`,
    averageScore,
    topStrength: strongest.basedOn || 'general',
    topImprovement: weakest.basedOn || 'general',
    source: 'heuristic-fallback',
  };
}

async function generateOverallSummary(evaluatedQuestions) {
  try {
    const prompt = buildOverallSummaryPrompt(evaluatedQuestions);
    const result = await generateJsonWithRetry(prompt);
    return { ...result, source: 'ollama-llama3.2' };
  } catch (err) {
    return heuristicFallbackSummary(evaluatedQuestions);
  }
}

module.exports = { evaluateAnswer, generateOverallSummary, heuristicFallbackEvaluation, heuristicFallbackSummary };
