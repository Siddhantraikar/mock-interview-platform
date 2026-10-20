/**
 * questionGeneratorService.js
 * -----------------------------------------------------------------------
 * Module 4 — Resume Processing & Resume Intelligence
 * Owner: Siddhant Raikar
 *
 * IMPORTANT — architecture note: on the team's module dependency slide,
 * "personalised question generation" belongs to the Interview module
 * (Modules 1/3), not Module 4. Module 4's real job ends at producing the
 * ResumeContext object (see contextBuilder.js) and handing it off.
 *
 * This service exists so the DEMO can show the whole flow end-to-end —
 * "here's what a real interview question generated from this exact resume
 * looks like" — without overclaiming Module 4's actual scope. It consumes
 * a ResumeContext exactly the way the Interview module would, and nothing
 * about it requires touching resumeParserService/pdfService/ollamaService
 * again. Mention this boundary explicitly if a mentor asks who "owns"
 * question generation.
 *
 * Same reliability pattern as ollamaService.js: try a local Llama 3.2 call
 * first, fall back to deterministic heuristic questions built straight
 * from the ResumeContext if Ollama is unavailable — never throws, always
 * labels which one ran via `source`.
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
    { model: OLLAMA_MODEL, prompt, stream: false, format: 'json' },
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

function buildQuestionPrompt(resumeContext) {
  const { skills, projects, experienceSummary, education, interviewType, targetRole } = resumeContext;

  return `You are an interviewer preparing personalised questions for a candidate, based on their resume.
Respond ONLY with JSON in exactly this shape:
{"questions": [{"question": "...", "type": "technical|project|behavioral|experience", "basedOn": "..."}]}

Generate exactly 6 questions: 2 technical (about specific skills), 2 project-based (about specific projects
listed), 1 about their experience (if any is listed, otherwise another project question), and 1 behavioral.
Each question's "basedOn" field should name the specific skill/project/role it references.

Interview type: ${interviewType || 'Technical'}
Target role: ${targetRole || 'Software Engineer'}
Skills: ${skills.join(', ') || 'none listed'}
Projects: ${projects.map((p) => `${p.title} (${(p.technologies || []).join(', ')})`).join('; ') || 'none listed'}
Experience: ${experienceSummary || 'none listed'}
Education: ${education.map((e) => e.degree).join('; ') || 'none listed'}

Keep each question to one or two sentences, specific to this candidate — not generic.`;
}

/**
 * Deterministic fallback — builds real, specific questions directly from
 * the ResumeContext fields rather than generic boilerplate, so it still
 * reads as personalised even without an LLM. This is the module's defined
 * degraded-mode behaviour, same as ollamaService's heuristic fallback.
 */
function heuristicFallbackQuestions(resumeContext) {
  const { skills, projects, experienceSummary, targetRole } = resumeContext;
  const questions = [];

  const topSkills = skills.slice(0, 2);
  topSkills.forEach((skill) => {
    questions.push({
      question: `Can you walk me through a time you used ${skill} to solve a real problem? What made it the right tool for the job?`,
      type: 'technical',
      basedOn: skill,
    });
  });
  if (topSkills.length === 0) {
    questions.push({
      question: `What technologies are you most comfortable with, and how would you apply them to a ${targetRole || 'this'} role?`,
      type: 'technical',
      basedOn: 'general',
    });
  }

  projects.slice(0, 2).forEach((project) => {
    questions.push({
      question: `Tell me about "${project.title}" — what was your specific role, and what was the hardest technical decision you had to make while building it?`,
      type: 'project',
      basedOn: project.title,
    });
  });

  if (experienceSummary) {
    const firstRole = experienceSummary.split(';')[0].trim();
    questions.push({
      question: `During your time as ${firstRole}, what's one thing you'd do differently if you started over?`,
      type: 'experience',
      basedOn: firstRole,
    });
  } else if (projects.length > 2) {
    questions.push({
      question: `Across your projects, which one are you proudest of and why?`,
      type: 'project',
      basedOn: projects[2].title,
    });
  }

  questions.push({
    question: `Describe a time you disagreed with a technical decision on a project or team. How did you handle it?`,
    type: 'behavioral',
    basedOn: 'general',
  });

  return { questions, source: 'heuristic-fallback' };
}

/**
 * Public entry point. Never throws — always resolves with either a real
 * LLM-generated question set or the heuristic fallback above, each
 * labelled via `source` so the demo never presents one as the other.
 */
async function generateQuestions(resumeContext) {
  try {
    const prompt = buildQuestionPrompt(resumeContext);
    const result = await generateJsonWithRetry(prompt);
    if (!Array.isArray(result.questions) || result.questions.length === 0) {
      throw new Error('Model returned no questions.');
    }
    return { questions: result.questions, source: 'ollama-llama3.2' };
  } catch (err) {
    return heuristicFallbackQuestions(resumeContext);
  }
}

module.exports = { generateQuestions, heuristicFallbackQuestions };
