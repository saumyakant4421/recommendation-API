const { getPersonalizedRecommendations, getChatRecommendations } = require('../services/recommendationService');
const logger = require('../utils/logger');

// Function: Controller for personalized ML-based recommendations
const getPersonalizedRecommendationsController = async (req, res) => {
  try {
    logger.info(`getPersonalizedRecommendations request: ${JSON.stringify({
      userId: req.body?.userId,
      authHeader: req.headers.authorization
    })}`);
    await getPersonalizedRecommendations(req, res);
  } catch (error) {
    logger.error(`Controller Error in getPersonalizedRecommendations: ${error.message}`);
    res.status(500).json({ error: `Failed to fetch recommendations: ${error.message}` });
  }
};

// Function: Controller for chat-based recommendations
const getChatRecommendationsController = async (req, res) => {
  try {
    logger.info(`getChatRecommendations request: ${JSON.stringify({
      userId: req.body?.userId,
      query: req.body?.query,
      authHeader: req.headers.authorization
    })}`);
    await getChatRecommendations(req, res);
  } catch (error) {
    logger.error(`Controller Error in getChatRecommendations: ${error.message}`);
    res.status(500).json({ error: `Failed to fetch chat recommendations: ${error.message}` });
  }
};

module.exports = { getPersonalizedRecommendationsController, getChatRecommendationsController };