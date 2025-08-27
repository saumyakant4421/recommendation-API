const express = require('express');
const router = express.Router();
const { getPersonalizedRecommendationsController, getChatRecommendationsController } = require('../controllers/recommendationController');

// Route: ML-based personalized recommendations
router.post('/personalized', getPersonalizedRecommendationsController);

// Route: Chat-based recommendations
router.post('/chat', getChatRecommendationsController);

module.exports = router;