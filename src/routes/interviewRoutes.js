/**
 * interviewRoutes.js
 * -----------------------------------------------------------------------
 * Interview conduction — route table
 * Owner: Siddhant Raikar
 *
 *   POST /api/interview/start              { resumeId }
 *   GET  /api/interview/:id                current state (resume on refresh)
 *   GET  /api/interview/:id/audio/:index   Edge TTS audio for one question
 *   POST /api/interview/:id/answer         { index, answer }
 *   GET  /api/interview/:id/report         full transcript + summary
 *
 * Mounted behind requireAuth in server.js, same as resumeRoutes.js.
 * -----------------------------------------------------------------------
 */

const express = require('express');
const interviewController = require('../controllers/interviewController');

const router = express.Router();

router.post('/start', interviewController.startInterview);
router.get('/:id', interviewController.getState);
router.get('/:id/audio/:index', interviewController.getQuestionAudio);
router.post('/:id/answer', interviewController.submitAnswer);
router.get('/:id/report', interviewController.getReport);

module.exports = router;
