const axios = require('axios');
const NodeCache = require('node-cache');

const userCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

const userService = axios.create({
  baseURL: process.env.USER_SERVICE_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  timeout: 10000
});

const getUserMovies = async (userId, token, retries = 1) => {
  const cacheKey = `userMovies_${userId}`;
  const cachedData = userCache.get(cacheKey);
  if (cachedData) {
  const logger = require('../utils/logger');
  logger.info(`Returning cached user movies for UID: ${userId}`);
    return cachedData;
  }

  try {
  const logger = require('../utils/logger');
  logger.info(`Fetching user movies for UID: ${userId} from ${process.env.USER_SERVICE_URL}`);
    userService.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    const [watchlistResponse, watchedResponse] = await Promise.all([
      userService.get('/watchlist', { params: { uid: userId } }),
      userService.get('/watched', { params: { uid: userId } })
    ]);

  logger.info('Watchlist response:', JSON.stringify(watchlistResponse.data, null, 2));
  logger.info('Watched response:', JSON.stringify(watchedResponse.data, null, 2));

    const watchlist = Array.isArray(watchlistResponse.data) ? watchlistResponse.data.map(item => ({
      title: item.title || 'Unknown',
      id: item.id || null,
      release_date: item.release_date || null,
      year: item.year || null
    })) : [];
    const watchedMovies = Array.isArray(watchedResponse.data) ? watchedResponse.data.map(item => ({
      title: item.title || 'Unknown',
      id: item.id || null,
      release_date: item.release_date || null,
      year: item.year || null,
      rating: item.rating || null
    })) : [];

  logger.info(`Processed watchlist: ${JSON.stringify(watchlist)}`);
  logger.info(`Processed watchedMovies: ${JSON.stringify(watchedMovies)}`);

    const result = { watchlist, watchedMovies };
    userCache.set(cacheKey, result);
    return result;
  } catch (error) {
  logger.error('Error fetching user movies:', {
      message: error.message,
      code: error.code,
      status: error.response?.status,
      data: error.response?.data,
      url: error.config?.url
    });

    if (retries > 0) {
  logger.info(`Retrying user movies fetch for UID: ${userId}, retries left: ${retries}`);
      return getUserMovies(userId, token, retries - 1);
    }

    return { watchlist: [], watchedMovies: [] };
  }
};

module.exports = { getUserMovies };