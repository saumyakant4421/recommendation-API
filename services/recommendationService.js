require("dotenv").config();
const axios = require("axios");
const admin = require("firebase-admin");
const logger = require("../utils/logger");
const { getUserMovies } = require("./userService");

if (!admin.apps.length) {
  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT));
    } catch (e) {
      logger.error('Invalid FIREBASE_SERVICE_ACCOUNT JSON in environment:', e);
      throw e;
    }
  } else {
    credential = admin.credential.applicationDefault();
  }
  admin.initializeApp({
    credential,
    projectId: process.env.FIREBASE_PROJECT_ID,
  });
}

const RECOMMENDER_API_URL = process.env.RECOMMENDER_API_URL;
const CHAT_API_URL = process.env.CHAT_API_URL;
const TMDB_API_URL = process.env.TMDB_API_URL;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const FALLBACK_POSTER_URL = process.env.FALLBACK_POSTER_URL || "https://dummyimage.com/500x750/ccc/fff.png&text=No+Poster";
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const CHAT_TIMEOUT = 60000; // Increased timeout for chat, as it involves LLM calls and potentially multiple TMDB calls

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const makeApiCall = async (url, params, headers = {}, retryCount = 0) => {
  try {
    const response = await axios.get(url, { params, headers });
    return response.data;
  } catch (error) {
    logger.error(
      `API call failed (attempt ${retryCount + 1}/${MAX_RETRIES}):`,
      {
        url,
        params,
        status: error.response?.status,
        message: error.message,
      }
    );

    if (retryCount < MAX_RETRIES - 1) {
      await delay(RETRY_DELAY * (retryCount + 1));
      return makeApiCall(url, params, headers, retryCount + 1);
    }

    throw error;
  }
};

const fetchTmdbMovie = async (title, tmdbId) => {
  try {
    if (!TMDB_API_KEY) {
      logger.error("TMDB_API_KEY is not defined in .env");
      return null;
    }
    // Prioritize TMDB ID if available for exact match
    let response;
    if (tmdbId) {
      try {
        response = await makeApiCall(
          `${TMDB_API_URL}/movie/${tmdbId}`,
          { api_key: TMDB_API_KEY },
          { Accept: "application/json" }
        );
        logger.info(
          `TMDb response for ID ${tmdbId}: ${JSON.stringify({
            id: response.id,
            release_date: response.release_date,
          })}`
        );
        return response;
      } catch (idError) {
        logger.warn(
          `TMDb fetch by ID ${tmdbId} failed, trying by title: ${idError.message}`
        );
        // Fallback to title search if ID fails
      }
    }

    // If no TMDB ID or ID fetch failed, search by title
    const searchResponse = await makeApiCall(
      `${TMDB_API_URL}/search/movie`,
      { api_key: TMDB_API_KEY, query: title },
      { Accept: "application/json" }
    );

    if (searchResponse.results && searchResponse.results.length > 0) {
      const bestMatch = searchResponse.results[0];
      logger.info(
        `TMDb search response for ${title}: ${JSON.stringify({
          id: bestMatch.id,
          release_date: bestMatch.release_date,
        })}`
      );
      return bestMatch;
    }

    logger.error(`No TMDb data found for ${title} (ID: ${tmdbId || "N/A"})`);
    return null;
  } catch (error) {
    logger.error(
      `Error fetching TMDb data for ${title} (ID: ${tmdbId || "N/A"}): ${
        error.message
      }`
    );
    return null;
  }
};

const fetchPoster = async (title, year = "") => {
  try {
    const params = {
      apikey: process.env.OMDB_API_KEY,
      t: title,
      y: year || undefined,
    };
  const data = await makeApiCall(process.env.OMDB_API_URL, params);
    logger.info(
      `OMDb response for ${title} (${year}): ${JSON.stringify(data)}`
    );

    if (data.Response === "False") {
      logger.warn(
        `OMDb API returned no poster for ${title} (${year}): ${data.Error}`
      );
      return FALLBACK_POSTER_URL;
    }

    return data.Poster && data.Poster !== "N/A"
      ? data.Poster
      : FALLBACK_POSTER_URL;
  } catch (error) {
    logger.error(
      `Error in fetchPoster for ${title} (${year}): ${error.message}`
    );
    return FALLBACK_POSTER_URL;
  }
};

const retryMlRequest = async (
  { url, data, headers, timeout },
  retryCount = 0
) => {
  try {
    return await axios.post(url, data, { headers, timeout });
  } catch (error) {
    logger.error(
      `ML request failed (attempt ${retryCount + 1}/${MAX_RETRIES}): ${
        error.message
      }`
    );
    if (retryCount < MAX_RETRIES - 1 && error.response?.status === 503) {
      // Retry on Service Unavailable
      await delay(RETRY_DELAY * (retryCount + 1));
      return retryMlRequest({ url, data, headers, timeout }, retryCount + 1);
    }
    throw error;
  }
};

const getPersonalizedRecommendations = async (req, res) => {
  let userId = null;
  try {
    logger.info(
      `Received ML personalized recommendation request: ${JSON.stringify({
        body: req.body,
        headers: req.headers,
      })}`
    );
    const body = req.body || {};
    userId = body.userId;
    const token = req.headers.authorization?.split("Bearer ")[1];

    if (!userId || !token) {
      logger.error(
        `Missing userId or token for ML recommendations: userId=${
          userId || "missing"
        }, token=${token ? "present" : "missing"}`
      );
      return res.status(400).json({ error: "User ID and token are required" });
    }

    const { watchlist, watchedMovies } = await getUserMovies(userId, token);

    // Helper to get year from TMDB or fallback
    const getMovieYear = async (item) => {
      if (item.release_date) {
        return new Date(item.release_date).getFullYear();
      }
      if (item.year) {
        return item.year;
      }
      const tmdbData = await fetchTmdbMovie(item.title, item.id);
      const year = tmdbData?.release_date
        ? new Date(tmdbData.release_date).getFullYear()
        : "N/A";
      if (year === "N/A") {
        logger.warn(
          `No year found for movie: ${item.title} (tmdbId: ${
            item.id || "unknown"
          })`
        );
      }
      return year;
    };

    const watchlistMovies = await Promise.all(
      watchlist.map(async (item) => {
        const year = await getMovieYear(item);
        return {
          title: item.title,
          year: year || "N/A",
          tmdbId: item.id,
        };
      })
    );

    const watchedMoviesFormatted = await Promise.all(
      watchedMovies.map(async (item) => {
        const year = await getMovieYear(item);
        return {
          title: item.title,
          rating: item.rating || 4.0,
          year: year || "N/A",
        };
      })
    );

    logger.info(
      `Sending watchlist and watched movies to FastAPI for user ${userId}: watchlist=${JSON.stringify(
        watchlistMovies
      )}, watched=${JSON.stringify(watchedMoviesFormatted)}`
    );

    const response = await retryMlRequest({
      url: RECOMMENDER_API_URL,
      data: {
        user_id: userId,
        watchlist_movies: watchlistMovies.map(({ title, year }) => ({
          title,
          year: year || "N/A",
        })),
        watched_movies: watchedMoviesFormatted.map((m) => ({
          title: m.title,
          year: m.year || "N/A",
          rating: m.rating,
        })),
        top_n: 15, // Fixed 15 recommendations for ML
        sample_ratings: true,
      },
      headers: { "Content-Type": "application/json" },
      timeout: 60000, // 60 seconds timeout
    });

    let recommendations = response.data.recommendations || [];
    const genres = recommendations.flatMap((rec) => rec.genres || []);
    logger.info(
      `FastAPI recommendations for user ${userId}: ${JSON.stringify(
        recommendations.slice(0, 2)
      )}... Genre distribution: ${JSON.stringify(
        Object.fromEntries(
          Object.entries(
            genres.reduce((acc, g) => {
              acc[g] = (acc[g] || 0) + 1;
              return acc;
            }, {})
          ).sort((a, b) => b[1] - a[1])
        )
      )}`
    );

    if (recommendations.length === 0) {
      logger.warn(
        `No recommendations returned for user ${userId}, falling back to generic`
      );
      recommendations = await getGenericRecommendations();
    }

    const enrichedRecommendations = await Promise.all(
      recommendations.map(async (rec) => {
        // If the ML model already returned a poster_path, use it, else fetch
        const poster_path =
          rec.poster_path ||
          (await fetchPoster(
            rec.title,
            rec.release_date
              ? String(rec.release_date).split("-")[0]
              : String(rec.year || "")
          ));
        return { ...rec, poster_path, tmdb_id: rec.tmdb_id || rec.id };
      })
    );

    res.json(enrichedRecommendations);
  } catch (error) {
    logger.error(
      `Error generating ML recommendations for user ${userId || "unknown"}: ${
        error.message
      }, ${JSON.stringify(error.response?.data || {})}`
    );
    res
      .status(500)
      .json({
        error: `Failed to generate ML recommendations: ${error.message}`,
      });
  }
};

const getGenericRecommendations = async () => {
  try {
    const response = await retryMlRequest({
      url: RECOMMENDER_API_URL,
      data: {
        user_id: null,
        watchlist_movies: [],
        watched_movies: [],
        top_n: 15, // Fixed 15 for generic ML as well
        sample_ratings: true,
      },
      headers: { "Content-Type": "application/json" },
      timeout: 60000,
    });
    return response.data.recommendations || [];
  } catch (error) {
    logger.error(`Error fetching generic ML recommendations: ${error.message}`);
    return [];
  }
};

const getChatRecommendations = async (req, res) => {
  let userId = null;
  try {
    logger.info(
      `Received chat recommendation request: ${JSON.stringify({
        body: req.body,
        headers: req.headers,
      })}`
    );
    const body = req.body || {};
    userId = body.userId;
    const query = body.query;
    const token = req.headers.authorization?.split("Bearer ")[1];

    if (!userId || !query || !token) {
      logger.error(
        `Missing userId, query, or token for chat recommendations: userId=${
          userId || "missing"
        }, query=${query || "missing"}, token=${token ? "present" : "missing"}`
      );
      return res
        .status(400)
        .json({ error: "User ID, query, and token are required" });
    }

    const { watchlist, watchedMovies } = await getUserMovies(userId, token);

    // Helper to get year from TMDB or fallback
    const getMovieYear = async (item) => {
      if (item.release_date) {
        return new Date(item.release_date).getFullYear();
      }
      if (item.year) {
        return item.year;
      }
      const tmdbData = await fetchTmdbMovie(item.title, item.id);
      const year = tmdbData?.release_date
        ? new Date(tmdbData.release_date).getFullYear()
        : "N/A";
      if (year === "N/A") {
        logger.warn(
          `No year found for movie: ${item.title} (tmdbId: ${
            item.id || "unknown"
          })`
        );
      }
      return year;
    };

    const watchlistMovies = await Promise.all(
      watchlist.map(async (item) => {
        const year = await getMovieYear(item);
        return {
          title: item.title,
          year: year || "N/A",
          tmdbId: item.id,
        };
      })
    );
    const watchedMoviesFormatted = await Promise.all(
      watchedMovies.map(async (item) => {
        const year = await getMovieYear(item);
        return {
          title: item.title,
          rating: item.rating || 4.0,
          year: year || "N/A",
        };
      })
    );

    logger.info(
      `Sending chat recommendation request to Flask API for user ${userId}: query=${query}, watchlist=${JSON.stringify(
        watchlistMovies
      )}, watched=${JSON.stringify(watchedMoviesFormatted)}`
    );

    const response = await retryChatRequest({
      url: CHAT_API_URL,
      data: {
        user_id: userId,
        query: query,
        watchlist_movies: watchlistMovies.map(({ title, year, tmdbId }) => ({
          title,
          year: year || "N/A",
          tmdb_id: tmdbId,
        })),
        watched_movies: watchedMoviesFormatted.map((m) => ({
          title: m.title,
          year: m.year || "N/A",
          rating: m.rating,
        })),
        top_n: 5, // Explicitly ask for 5 from chatbot, though Flask handles it
      },
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      timeout: CHAT_TIMEOUT,
    });

    let { recommendations, text_response } = response.data; // Flask now returns text_response
    recommendations = recommendations || [];

    logger.info(
      `Chat recommendations for user ${userId}: ${JSON.stringify(
        recommendations.slice(0, 5)
      )}...`
    ); // Log up to 5

    if (recommendations.length === 0 && !text_response) {
      logger.warn(
        `No chat recommendations or text response returned for user ${userId}, falling back to generic`
      );
      // Do not fall back to generic ML recommendations, as per requirement, but indicate no chat results
      text_response = `Sorry, I couldn't find any recommendations for your query: "${query}". Please try again or rephrase!`;
    }

    const enrichedRecommendations = await Promise.all(
      recommendations.map(async (rec) => {
        // If the Flask app already provided poster_path and tmdb_id, use them
        const poster_path =
          rec.poster_path ||
          (await fetchPoster(
            rec.title,
            rec.year || rec.release_date?.split("-")[0] || ""
          ));
        return { ...rec, poster_path, tmdb_id: rec.tmdb_id || rec.id }; // Ensure tmdb_id is propagated
      })
    );

    res.json({ recommendations: enrichedRecommendations, text_response });
  } catch (error) {
    logger.error(
      `Error generating chat recommendations for user ${userId || "unknown"}: ${
        error.message
      }, ${JSON.stringify(error.response?.data || {})}`
    );
    res
      .status(500)
      .json({
        error: `Failed to generate chat recommendations: ${error.message}`,
      });
  }
};

const retryChatRequest = async (
  { url, data, headers, timeout },
  retryCount = 0
) => {
  try {
    return await axios.post(url, data, { headers, timeout });
  } catch (error) {
    logger.error(
      `Chat request failed (attempt ${retryCount + 1}/${MAX_RETRIES}): ${
        error.message
      }`
    );
    if (
      (retryCount < MAX_RETRIES - 1 && error.code === "ECONNABORTED") ||
      error.response?.status === 504
    ) {
      // Also retry on gateway timeout
      await delay(RETRY_DELAY * (retryCount + 1));
      return retryChatRequest({ url, data, headers, timeout }, retryCount + 1);
    }
    throw error;
  }
};

module.exports = { getPersonalizedRecommendations, getChatRecommendations };
